// ════════════════════════════════════════════════════════════════════════════
// routes/photos.js — event photos: the human curation surface
// ────────────────────────────────────────────────────────────────────────────
// THE MODEL (punch 43, public/data.js "EVENT PHOTOS" is the behavioural spec)
//   A photo IS a `files` row with kind='photo'. There is no photos table and
//   there never will be one — a photo is a document like any other, it just
//   carries a few more columns: taken_at · width · height · caption · tags[] ·
//   shot_by · recap_pick · thumb_path, on top of the usual nas_path/status/
//   provenance. Everything the files machinery already does (proposed-vs-filed,
//   provenance, cascades, the finance-free doc feed) applies unchanged.
//
//   BIG MEDIA NEVER ENTERS THE DATABASE. `nas_path` and `thumb_path` are
//   strings; the bytes live behind lib/storage.js. Filenames follow the agent's
//   naming convention YYYYMMDD_HHMM_{slug}.jpg, so a NAS folder sorts
//   chronologically on its own with no index to maintain.
//
//   45. Photos land under the mechanical {kind} folder — \photo\ — because
//   buildNasPath() joins the file's `kind` verbatim. There is no special case
//   for photos anywhere in this module; flipping to \photos\ is one line in
//   lib/storage.js and nothing here changes.
//
// THE THUMBNAIL CONTRACT (punch 46)
//   The NAS-side watcher sees a new original, writes {name}_t320.jpg beside it,
//   and PATCHes the row: PATCH /api/photos/:id/thumb. It is a daemon — it has
//   no session — so that ONE route also accepts a shared secret in the
//   `x-thumbnailer-token` header, checked against process.env.THUMBNAILER_TOKEN
//   when that variable is set. Everything else on this router is session-only.
//   The daemon may omit the body entirely; the server then derives the path
//   with thumbPathFor(nas_path), which encodes the _t320.jpg convention in one
//   place. No activity row is written: this is machine housekeeping, not news.
//
// WHAT IS DELIBERATELY ABSENT
//   · The agent surface. None of these routes belong under /api/agent/* — the
//     agent surface stays APPEND-ONLY (punch 47). An agent files photos with
//     POST /api/agent/documents (kind:'photo') and pushes bytes with
//     PUT /api/agent/documents/:id/content; it never edits a caption, never
//     sets a recap pick, and never un-proposes its own work. Curation is a
//     human act, so it lives here, behind requireAuth.
//   · confirm / reject. A proposed photo rides the SAME review machinery as a
//     proposed document: POST /api/proposals/:id/confirm and
//     POST /api/proposals/:id/reject, in the agent/proposals module. That flow
//     also MOVES the bytes out of the _agent-inbox quarantine into the show
//     folder (46). Duplicating a photo-shaped confirm here would fork the one
//     review queue in two — so it is not implemented.
//   · delete. A photo is a file; DELETE /api/files/:id already covers it.
//
// ENDPOINTS (public/api.js "EVENT PHOTOS" section is the signature spec)
//   GET    /api/shows/:id/photos        list a show's photos, oldest first
//   GET    /api/photos                  cross-show list, newest first, paged
//   GET    /api/photos/:id              one photo
//   GET    /api/shows/:id/photo-facets  days + tag counts + counts
//   PUT    /api/photos/:id              caption/tags   [pm+ OR the uploader]
//   PUT    /api/photos/:id/pick         recap_pick     [pm+ only]
//   PATCH  /api/photos/:id/thumb        thumb_path     [pm+ / uploader / NAS]
//   GET    /api/shows/:id/recap-picks   the recap strip (48)
//   POST   /api/shows/:id/photos        human upload   [tech+]
//   PUT    /api/photos/:id/content      raw bytes      [pm+ OR the uploader]
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');
const express = require('express');

const { pool, withTx, loadShow, loadProject, loadRow, projectForRow } = require('../lib/db');
const { requireAuth, requireRole, roleRank } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf, offsetOf } = require('../lib/http');
const { dbToFile, pick, has } = require('../lib/mappers');
const { num, sameUser } = require('../lib/enums');
const { logActivity } = require('../lib/activity');
const { notifyTargets } = require('../lib/mentions');
const { buildNasPath, thumbPathFor, storage } = require('../lib/storage');

const router = express.Router();

// requireAuth is applied PER ROUTE rather than with router.use(), because
// PATCH :id/thumb has to be reachable by a token-bearing NAS daemon that has no
// session at all. Making the exception explicit at the one route that needs it
// beats a router-wide middleware with a path-shaped hole in it.

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// A rejected photo is not "a photo you have" — it is a proposal someone threw
// away. It never appears in a list. COALESCE because `status` is nullable in
// the schema (defaulted, but old rows exist) and NULL <> 'rejected' is NULL.
// `p` is the optional table alias prefix ('f.').
const notRejected = (p = '') => `COALESCE(${p}status,'filed') <> 'rejected'`;

// public/data.js photosForShow(): oldest first, id as the tiebreak. taken_at is
// nullable (a human upload may not know it), and those sort last.
const orderOldest = (p = '') => `ORDER BY ${p}taken_at ASC NULLS LAST, ${p}id ASC`;
// public/api.js listAllPhotos(): the cross-show feed reads newest first.
const orderNewest = (p = '') => `ORDER BY ${p}taken_at DESC NULLS LAST, ${p}id DESC`;

// Curation rank (public/data.js PH_EDIT_ROLES = {admin, manager, pm}). This is
// a RANK gate, not project ownership: a pm curates photos on any show, which is
// why canEditProject() is deliberately not used in this module.
function isCurator(session) {
  return roleRank(session && session.role) >= roleRank('pm');
}
// 47. pm+ OR the person who put the row there.
function canEditPhoto(session, row) {
  return isCurator(session) || sameUser(row && row.uploaded_by, session && session.username);
}

// Load a photo or 404 with public/api.js's exact wording. A file row that is
// not kind='photo' is NOT a photo — the photo routes must never edit a contract.
async function loadPhoto(id, q = pool) {
  const row = await loadRow('files', id, q);
  if (!row || row.kind !== 'photo') throw notFound(`photo ${id} not found`);
  return row;
}

async function loadShowOr404(id, q = pool) {
  const show = await loadShow(id, q);
  if (!show) throw notFound(`show ${id} not found`);
  return show;
}

// '1' | 'true' | 'yes' | 'on' -> true. Returns null when it is not a boolean at
// all, so a caller can tell "false" from "you sent nonsense".
function boolFrom(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return !!v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return null;
}
const truthyQ = (v) => v !== undefined && boolFrom(v) === true;

// public/api.js updatePhoto(): lowercase, trim, drop the empties. Order is the
// caller's; duplicates are the caller's problem too (the front-end dedupes in
// the tag picker, and a duplicate tag is harmless in a facet count).
function normalizeTags(list) {
  if (!Array.isArray(list)) throw badRequest('tags must be an array');
  return list.map((t) => String(t == null ? '' : t).toLowerCase().trim()).filter(Boolean);
}

// The list filters shared by GET /shows/:id/photos and GET /photos. `bind`
// returns the $n placeholder for a value so a filter can use the same param
// twice (the projectId filter does).
function photoFilters(req, where, bind) {
  const status = req.query.status;
  if (status !== undefined && status !== '') {
    // 'rejected' is not listable here: a rejected proposal left no trace worth
    // browsing. It is visible in the proposals queue, where it belongs.
    if (status !== 'filed' && status !== 'proposed') {
      throw badRequest(`unknown photo status "${status}" — filed or proposed`);
    }
    where.push(`COALESCE(f.status,'filed') = ${bind(status)}`);
  }
  const tag = req.query.tag;
  if (tag !== undefined && tag !== '') {
    where.push(`${bind(String(tag).toLowerCase().trim())} = ANY(f.tags)`);
  }
  if (truthyQ(req.query.pick)) where.push('f.recap_pick IS TRUE');
}

// ── the notification principle (Tony, TEAM_FEEDBACK "Roles") ────────────────
// Every mutating route below takes an OPTIONAL `notify: ['username', …]`. The
// actor picks who hears about it; routine edits stay silent. It lands exactly
// where a human @mention lands — a note anchored on the photo plus the mention
// FACT rows — so the inbox has one code path, not two.
//
// HARDENING 10: the mechanism moved to lib/mentions.js notifyTargets(). Only
// the anchor (the photo's file row) and the "@who — what" wording were ever
// specific to photos, and those are what is left here.
async function applyNotify(c, { body, row, actor, line }) {
  return notifyTargets(c, {
    body,
    anchorType: 'file',
    anchorId: row.id,
    projectId: row.project_id || null,
    showId: row.show_id || null,
    actor,
    summary: line,
    format: (text, mentions) => mentions.map((u) => '@' + u).join(' ') + ' — ' + text
  });
}

// A short, human label for an activity detail line.
function photoLabel(row) {
  return String(row.caption || row.name || '').slice(0, 64);
}

// ════════════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/photos — public/api.js listPhotos(showId). Oldest first:
// the show tab reads as a timeline of the day, not a feed.
router.get('/shows/:id/photos', requireAuth, asyncH(async (req, res) => {
  const showId = idParam(req);
  await loadShowOr404(showId);

  const params = [showId];
  const bind = (v) => { params.push(v); return '$' + params.length; };
  const where = ['f.show_id=$1', `f.kind='photo'`, notRejected('f.')];
  photoFilters(req, where, bind);

  // Capped rather than unbounded — a four-day show can carry a few hundred
  // frames and a runaway camera-roll sync should not become a full table read.
  const limit = limitOf(req, 500, 1000);
  const r = await pool.query(
    `SELECT f.* FROM files f WHERE ${where.join(' AND ')} ${orderOldest('f.')} LIMIT ${limit}`,
    params
  );
  res.json(r.rows.map(dbToFile));
}));

// GET /api/photos — public/api.js listAllPhotos(filters). Cross-show, NEWEST
// first, paged. Filters: showId · projectId · tag · pick · status.
router.get('/photos', requireAuth, asyncH(async (req, res) => {
  const params = [];
  const bind = (v) => { params.push(v); return '$' + params.length; };
  const where = [`f.kind='photo'`, notRejected('f.')];

  // pick() reads ?show_id= and ?showId= alike, same as it does on a body.
  const showId = num(pick(req.query, 'show_id'), null);
  if (showId != null) where.push(`f.show_id = ${bind(showId)}`);

  const projectId = num(pick(req.query, 'project_id'), null);
  if (projectId != null) {
    // A show-scoped file carries show_id and a NULL project_id (the convention
    // POST /api/files set), so "photos of this project" has to reach through
    // the show table as well as the direct column.
    const p = bind(projectId);
    where.push(`(f.project_id = ${p} OR f.show_id IN (SELECT id FROM shows WHERE project_id = ${p}))`);
  }
  photoFilters(req, where, bind);

  const limit = limitOf(req);
  const offset = offsetOf(req);
  const r = await pool.query(
    `SELECT f.* FROM files f WHERE ${where.join(' AND ')} ${orderNewest('f.')}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json(r.rows.map(dbToFile));
}));

// GET /api/photos/:id — one photo. 404 (not 200-with-a-contract) when the row
// exists but is some other kind of file.
router.get('/photos/:id', requireAuth, asyncH(async (req, res) => {
  const row = await loadPhoto(idParam(req));
  res.json(dbToFile(row));
}));

// GET /api/shows/:id/photo-facets — the filter rail. Ports public/data.js
// photoDays() + photoTagCounts(), plus the counts the header pills read.
router.get('/shows/:id/photo-facets', requireAuth, asyncH(async (req, res) => {
  const showId = idParam(req);
  await loadShowOr404(showId);

  // taken_at is TIMESTAMPTZ; the front-end slices the ISO (UTC) string, so the
  // day bucket is computed in UTC too. Server and client must agree on which
  // day a 23:40 photo belongs to.
  const r = await pool.query(
    `SELECT to_char(taken_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
            tags, COALESCE(status,'filed') AS status, recap_pick
     FROM files
     WHERE show_id=$1 AND kind='photo' AND ${notRejected()}
     ${orderOldest()}`,
    [showId]
  );

  const days = [];
  const seen = new Set();
  const tally = new Map();
  const counts = { total: 0, filed: 0, proposed: 0, picks: 0 };
  for (const row of r.rows) {
    counts.total += 1;
    if (row.status === 'proposed') counts.proposed += 1; else counts.filed += 1;
    if (row.recap_pick) counts.picks += 1;
    if (row.day && !seen.has(row.day)) { seen.add(row.day); days.push(row.day); }
    for (const t of row.tags || []) tally.set(t, (tally.get(t) || 0) + 1);
  }
  // photoTagCounts(): busiest tag first, alphabetical inside a tie.
  const tags = [...tally.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  res.json({ days, tags, counts });
}));

// GET /api/shows/:id/recap-picks — 48. Ports public/data.js recapStripPhotos():
// FILED photos only, the picks first in the order they were shot, then the rest
// newest-first as filler, capped (?cap=, default 5).
//
// The recap generator does NOT call this route — the deliverables module reads
// recap_pick straight out of the database when it builds a draft. This exists
// so the UI strip and the generator agree on what "the picks" means, in one
// place, instead of two implementations drifting apart.
router.get('/shows/:id/recap-picks', requireAuth, asyncH(async (req, res) => {
  const showId = idParam(req);
  await loadShowOr404(showId);
  const cap = Math.min(Math.max(parseInt(req.query.cap, 10) || 5, 1), 50);

  const r = await pool.query(
    `SELECT * FROM files
     WHERE show_id=$1 AND kind='photo' AND COALESCE(status,'filed')='filed'
     ${orderOldest()}`,
    [showId]
  );
  const picks = r.rows.filter((f) => f.recap_pick);
  const rest = r.rows.filter((f) => !f.recap_pick).reverse();   // newest first
  res.json(picks.concat(rest).slice(0, cap).map(dbToFile));
}));

// ════════════════════════════════════════════════════════════════════════════
// CURATION (47 — session-only, pm+ or the uploader)
// ════════════════════════════════════════════════════════════════════════════

// PUT /api/photos/:id — public/api.js updatePhoto(id, {caption, tags}).
//
// STRICT WHITELIST. caption and tags are the only two fields a person may
// change on a photo, and an unknown key is a 400 that NAMES it rather than a
// silent drop: the client that sent {recap_pick:true} here needs to learn about
// /pick, and the one that sent {nas_path:…} needs to learn that moving bytes is
// not an edit. This is the whole reason the generic PUT /api/files/:id is not
// good enough for photos.
router.put('/photos/:id', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  const row = await loadPhoto(id);
  if (!canEditPhoto(req.session, row)) {
    throw forbidden('editing a photo requires pm, manager, admin — or its uploader');
  }

  const body = req.body || {};
  const ALLOWED = new Set(['caption', 'tags', 'notify']);
  const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (bad.length) throw badRequest(`"${bad[0]}" is not editable on a photo — caption and tags only`);
  if (!has(body, 'caption') && !has(body, 'tags')) throw badRequest('caption or tags required');

  const sets = [];
  const params = [];
  const bind = (v) => { params.push(v); return '$' + params.length; };

  let caption = row.caption;
  if (has(body, 'caption')) {
    caption = String(pick(body, 'caption') == null ? '' : pick(body, 'caption')).trim();
    if (!caption) throw badRequest('a photo needs a caption');
    sets.push(`caption = ${bind(caption)}`);
  }
  let tags = row.tags || [];
  if (has(body, 'tags')) {
    tags = normalizeTags(pick(body, 'tags'));
    sets.push(`tags = ${bind(tags)}::text[]`);
  }

  const project = await projectForRow(row);
  const out = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE files SET ${sets.join(', ')} WHERE id = ${bind(id)} RETURNING *`, params);
    const updated = r.rows[0];
    await logActivity(c, {
      projectId: project ? project.id : null, showId: row.show_id || null,
      actor: req.session.username,
      action: 'photo.update',
      detail: (has(body, 'caption') ? 'caption: ' : 'tags: ') + photoLabel(updated)
    });
    await applyNotify(c, {
      body, row: updated, actor: req.session.username,
      line: `photo updated: ${photoLabel(updated)}`
    });
    return updated;
  });
  res.json(dbToFile(out));
}));

// PUT /api/photos/:id/pick — public/api.js setRecapPick(id, on). 47/48.
//
// pm+ ONLY, and deliberately NOT the uploader: a pick is a statement about what
// the CLIENT sees in the recap, not about whose photo it is. The tech who shot
// the frame can caption it (above); choosing it is the project manager's call.
//
// Body: {on: true|false}. {pick:…} and a bare boolean are accepted too, because
// three call sites in the front-end spell it three ways.
router.put('/photos/:id/pick', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  const row = await loadPhoto(id);
  if (!isCurator(req.session)) throw forbidden('curating recap picks requires pm, manager or admin');

  const body = req.body;
  const raw = typeof body === 'boolean' ? body
    : (pick(body, 'on') !== undefined ? pick(body, 'on') : pick(body, 'pick'));
  const on = boolFrom(raw);
  if (raw === undefined || on === null) throw badRequest('on must be true or false');

  const project = await projectForRow(row);
  const out = await withTx(async (c) => {
    const r = await c.query('UPDATE files SET recap_pick=$1 WHERE id=$2 RETURNING *', [on, id]);
    const updated = r.rows[0];
    await logActivity(c, {
      projectId: project ? project.id : null, showId: row.show_id || null,
      actor: req.session.username,
      action: on ? 'photo.pick' : 'photo.unpick',
      detail: (on ? 'starred for the client recap: ' : 'removed from the recap picks: ') + photoLabel(updated),
      accent: on          // 11. picking one is news; unpicking is bookkeeping.
    });
    await applyNotify(c, {
      body: typeof body === 'object' && body ? body : {}, row: updated, actor: req.session.username,
      line: on ? `picked for the client recap: ${photoLabel(updated)}`
               : `removed from the recap picks: ${photoLabel(updated)}`
    });
    return updated;
  });
  res.json(dbToFile(out));
}));

// ════════════════════════════════════════════════════════════════════════════
// THE NAS THUMBNAILER CONTRACT (46)
// ════════════════════════════════════════════════════════════════════════════

// Constant-time secret compare — the token is a shared secret, so a length-safe
// timingSafeEqual instead of ===.
function tokenMatches(header) {
  const expected = process.env.THUMBNAILER_TOKEN;
  if (!expected) return false;                      // unset -> the gate does not exist
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Session auth, OR the NAS daemon's shared secret. The daemon has no user and
// never gets one: it may set exactly one column on exactly one route.
function sessionOrThumbnailer(req, res, next) {
  if (req.headers['x-thumbnailer-token']) {
    if (!tokenMatches(req.headers['x-thumbnailer-token'])) {
      return res.status(403).json({ error: 'Invalid thumbnailer token' });
    }
    req.thumbnailer = true;
    req.actor = 'thumbnailer';
    return next();
  }
  return requireAuth(req, res, next);
}

// PATCH /api/photos/:id/thumb
//
//   THE CONTRACT. A watcher runs on the NAS. It sees a new original land in a
//   \photo\ folder, renders a 320px JPEG next to it as {name}_t320.jpg, and
//   tells the app where it put it:
//
//     PATCH /api/photos/412/thumb
//     x-thumbnailer-token: <THUMBNAILER_TOKEN>
//     {"thumb_path": "\\\\E360-NAS\\Showrunner\\P1-…\\photo\\2026…_t320.jpg"}
//
//   The body may be omitted entirely, in which case the server derives the path
//   with thumbPathFor(nas_path) — the same function the watcher's own naming
//   follows. That is the belt-and-braces case: the daemon can just say "done".
//
//   GATE: pm+ OR the uploader OR a valid x-thumbnailer-token. The token gate
//   only exists when THUMBNAILER_TOKEN is set in the environment; with it unset
//   the route is session-only and a daemon simply cannot reach it (which is the
//   correct failure — better than a thumbnail route open to the world).
//
//   NO ACTIVITY ROW. A thumbnail appearing is not something a person did, and
//   the feed is for people. This is machine housekeeping.
router.patch('/photos/:id/thumb', sessionOrThumbnailer, asyncH(async (req, res) => {
  const id = idParam(req);
  const row = await loadPhoto(id);

  if (!req.thumbnailer && !canEditPhoto(req.session, row)) {
    throw forbidden('setting a photo thumbnail requires pm, manager, admin — or its uploader');
  }

  const body = req.body || {};
  let thumb = pick(body, 'thumb_path');
  if (thumb === undefined || thumb === null || thumb === '') {
    thumb = thumbPathFor(row.nas_path);
    if (!thumb) throw badRequest('this photo has no nas_path — send an explicit thumb_path');
  } else {
    thumb = String(thumb).trim();
    // Stored as a string and only ever resolved through lib/storage's
    // toLocalPath (which rejects traversal on use) — but a '..' has no business
    // being written down in the first place.
    if (!thumb || /(^|[\\/])\.\.([\\/]|$)/.test(thumb)) throw badRequest('invalid thumb_path');
  }

  const r = await pool.query('UPDATE files SET thumb_path=$1 WHERE id=$2 RETURNING *', [thumb, id]);
  const updated = r.rows[0];

  // notify is honoured here only when a PERSON made the call — a note needs an
  // author, and 'thumbnailer' is not one.
  if (pick(body, 'notify') !== undefined) {
    if (req.thumbnailer) throw badRequest('notify requires a signed-in actor');
    await withTx((c) => applyNotify(c, {
      body, row: updated, actor: req.session.username,
      line: `thumbnail set on ${photoLabel(updated)}`
    }));
  }
  res.json(dbToFile(updated));
}));

// ════════════════════════════════════════════════════════════════════════════
// THE HUMAN UPLOAD PATH
// ════════════════════════════════════════════════════════════════════════════

// POST /api/shows/:id/photos — a person adding photos by hand.
//
// tech+, mirroring POST /api/files: the techs are the ones with the camera, and
// gating uploads at pm+ would push them back into emailing a zip. What tech+
// canNOT do is curate — see the pm-only /pick route above.
//
// 45. nas_path comes from buildNasPath() with kind:'photo', which puts the file
// under the mechanical \photo\ folder. No special-casing here on purpose.
router.post('/shows/:id/photos', requireAuth, requireRole('tech'), asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShowOr404(showId);
  const project = await loadProject(show.project_id);
  if (!project) throw notFound('parent project not found');

  const body = req.body || {};
  const name = String(pick(body, 'name') || '').trim();
  if (!name) throw badRequest('name required');
  const ext = String(pick(body, 'ext') || 'jpg').replace(/^\./, '');

  // taken_at: no EXIF at this layer. When the caller does not know when the
  // shutter fired, the upload moment stands in so the photo still sorts into
  // the timeline; the NAS watcher can backfill a real value later.
  let takenAt = pick(body, 'taken_at');
  if (takenAt === undefined || takenAt === null || takenAt === '') {
    takenAt = new Date();
  } else {
    const d = new Date(takenAt);
    if (isNaN(d.getTime())) throw badRequest('taken_at must be an ISO datetime');
    takenAt = d;
  }

  const width = num(pick(body, 'width'), null);
  const height = num(pick(body, 'height'), null);
  const caption = String(pick(body, 'caption') || '').trim() || null;
  const tags = has(body, 'tags') ? normalizeTags(pick(body, 'tags')) : [];
  // The person uploading is the photographer unless they say otherwise.
  const shotBy = has(body, 'shot_by') ? (pick(body, 'shot_by') || null) : req.session.username;
  const size = num(pick(body, 'size'), 0) || 0;
  const dim = width && height ? `${width} x ${height}` : null;

  const nasPath = buildNasPath(project, show, { kind: 'photo', name, ext });

  const out = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO files (project_id, show_id, name, ext, kind, nas_path, size, uploaded_by,
                          status, taken_at, width, height, caption, tags, shot_by, recap_pick, dim, meta)
       VALUES (NULL,$1,$2,$3,'photo',$4,$5,$6,'filed',$7,$8,$9,$10,$11::text[],$12,FALSE,$13,$14)
       RETURNING *`,
      [show.id, name, ext, nasPath, size, req.session.username,
       takenAt, width, height, caption, tags, shotBy, dim, 'uploaded by ' + req.session.username]
    );
    const created = r.rows[0];
    await logActivity(c, {
      projectId: project.id, showId: show.id, actor: req.session.username,
      action: 'photo.add', detail: photoLabel(created) || name
    });
    await applyNotify(c, {
      body, row: created, actor: req.session.username,
      line: `photo added to ${show.name || show.venue || 'the show'}: ${photoLabel(created) || name}`
    });
    return created;
  });
  // thumb_path stays NULL: the NAS watcher fills it via PATCH :id/thumb.
  res.json(dbToFile(out));
}));

// PUT /api/photos/:id/content — the bytes, for a photo registered above.
//
// Metadata first (POST), bytes second (PUT), exactly like the agent's document
// flow — the row is the receipt, the file is the payload, and a failed byte
// push leaves a row you can retry against instead of a half-written folder.
// Bytes go through lib/storage, never through a UNC path opened here.
router.put('/photos/:id/content',
  requireAuth,
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  asyncH(async (req, res) => {
    const id = idParam(req);
    const row = await loadPhoto(id);
    if (!canEditPhoto(req.session, row)) {
      throw forbidden('uploading photo bytes requires pm, manager, admin — or its uploader');
    }
    // A proposed photo's bytes belong in the _agent-inbox quarantine and are
    // pushed on the agent surface; the proposal confirm MOVES them into the
    // show folder (46). Writing them here would put unreviewed bytes straight
    // into a client folder.
    if (row.status === 'proposed') {
      throw badRequest('this photo is a pending proposal — its bytes are pushed on the agent surface and moved on confirm');
    }
    if (!row.nas_path) throw badRequest('this photo has no nas_path');
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw badRequest('empty body — send the image as application/octet-stream');
    }

    const result = await storage.put(row.nas_path, req.body);
    await pool.query('UPDATE files SET size=$1 WHERE id=$2', [req.body.length, id]);
    res.json({ ok: true, size: result.size != null ? result.size : req.body.length });
  })
);

module.exports = router;
