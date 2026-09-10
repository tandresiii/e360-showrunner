// ════════════════════════════════════════════════════════════════════════════
// routes/dropbox.js — Dropbox folders on a show: the content bytes' real home
// ────────────────────────────────────────────────────────────────────────────
// Tom (2026-09-10): "Will need the deliverables to be able to connect file
// request folders to shows, as well as regular ones. will need to track
// multiple folders in a single show — we have incoming files from clients,
// deliverables to clients, and lastly deliverables to person running the show
// — which might be one, the other, or both. need to make it flexible in that
// way." And, the same night: "i dont necessarily want to upload all these
// files to showrunner. just keep track of them."
//
// So the shape is TRACK, NOT COPY:
//   · a show links any number of Dropbox folders, each carrying a SET of
//     roles (incoming / to_client / to_operator — DROPBOX_ROLES, at least
//     one, several allowed: that IS the flexibility requirement);
//   · the listing is LIVE, with a NEW badge diffed against a "seen" snapshot
//     a person deliberately resets — new-since-last-look, not unread-counts;
//   · pixel specs / codec come from Dropbox's own media info plus a BOUNDED
//     range-read probe of the file's container headers (lib/mediaprobe.js) —
//     measured or absent, never guessed — cached per file REVISION;
//   · the PRIMARY bridge to the content pipeline is TRACK IN PLACE: a version
//     row whose files record is a remote locator (bytes stay in Dropbox);
//     INGEST-A-COPY is the explicit, secondary archival door;
//   · DEPOSIT pushes an existing show file's real NAS bytes out to a
//     to_client / to_operator folder;
//   · UNLINK is local-only. It calls nothing in Dropbox — the fake asserts a
//     count of zero remote deletes, and the mutation suite keeps it honest.
//
// GATES: everyone signed-in reads; pm floor + folder ownership
// (canEditProject) writes — link, unlink, mark-seen, file requests, ingest,
// deposit. TRACK gates on the content family's own step-owner predicate
// (canWorkPiece): the designer who owns the piece links their own arrival,
// exactly as they file a version by hand. PROBE is signed-in: measuring a
// file is reading it, and the cache it warms is served to every reader.
//
// SCOPES ARE DYNAMIC (lib/dropbox.js): a capability the team admin has not
// granted answers a NAMED 501 from Dropbox's own missing_scope error and
// starts working the moment a re-authorize lands. Nothing here assumes.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadShow, loadProject, loadRow } = require('../lib/db');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, conflict, idParam } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { pick, dbToDropboxLink, dbToFile, dbToContentVersion } = require('../lib/mappers');
const { DROPBOX_ROLES, intOrNull } = require('../lib/enums');
const { storage, storageReady, buildNasPath, fileName } = require('../lib/storage');
const fileCache = require('../lib/filecache');
const { probeSpecs } = require('../lib/mediaprobe');
const dbx = require('../lib/dropbox');
// The content family's own writers/gates — shared, never re-expressed, so the
// Dropbox bridge cannot drift from the hand-filed path (see routes/content.js).
const { fileContentVersion, canWorkPiece } = require('./content');

const router = express.Router();
router.use(requireAuth);

// ── plumbing ────────────────────────────────────────────────────────────────
function requireDropbox() {
  if (!dbx.dropboxConfigured()) throw dbx.notConfigured();
}
async function loadShowOr404(id, q = pool) {
  const show = await loadShow(id, q);
  if (!show) throw notFound('Show not found');
  return show;
}
async function assertCanEditShow(req, show) {
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) {
    throw forbidden('This show belongs to a folder you do not own — pm (owner) or manager+ required');
  }
  return project;
}
async function loadLinkOr404(id, q = pool) {
  const link = await loadRow('show_dropbox_links', id, q);
  if (!link) throw notFound('Dropbox link not found');
  return link;
}
const lower = (s) => String(s || '').toLowerCase();
// Is entryPath inside the linked folder? Case-insensitive the way Dropbox is.
function underPath(entryPath, linkPath) {
  return lower(entryPath).startsWith(lower(linkPath) + '/');
}
function assertEntryUnderLink(entryPath, link) {
  if (!entryPath) throw badRequest('entry_path required — which file in the folder?');
  if (!underPath(entryPath, link.path)) {
    throw badRequest(`entry_path must be inside the linked folder (${link.path}) — ` +
      'a link only reaches the folder it names');
  }
}
// The role vocabulary is load-bearing (lib/enums.js): loud 400s, never a
// silent re-file. Accepts an array or CSV, dedupes, keeps DROPBOX_ROLES order.
function readRoles(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback) return fallback;
    throw badRequest(`roles required — at least one of ${DROPBOX_ROLES.join(', ')}`);
  }
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const cleaned = list.map((r) => String(r || '').trim()).filter(Boolean);
  if (!cleaned.length) throw badRequest(`roles required — at least one of ${DROPBOX_ROLES.join(', ')}`);
  for (const r of cleaned) {
    if (!DROPBOX_ROLES.includes(r)) {
      throw badRequest(`role '${r}' is not one of ${DROPBOX_ROLES.join(', ')}`);
    }
  }
  return DROPBOX_ROLES.filter((r) => cleaned.includes(r));
}
// snapshot JSONB: { seen: {pathLower -> {size, server_modified}},
//                   probes: {pathLower@rev -> spec | {unreadable, note}} }
function snapOf(link) {
  const s = link.snapshot && typeof link.snapshot === 'object' ? link.snapshot : {};
  return { seen: s.seen || {}, probes: s.probes || {} };
}
const probeKey = (entryPath, rev) => `${lower(entryPath)}@${rev || ''}`;

// The free spec layer: what Dropbox itself measured, when it has. `pending`
// is a real state — the entry simply carries nothing rather than a dash
// dressed as data.
function mediaOf(entry) {
  const mi = entry && entry.media_info;
  if (!mi || mi['.tag'] === 'pending' || !mi.metadata) return null;
  const m = mi.metadata;
  const dim = m.dimensions || {};
  const out = { source: 'dropbox' };
  if (Number(dim.width) > 0 && Number(dim.height) > 0) {
    out.w = Number(dim.width);
    out.h = Number(dim.height);
  }
  if (m['.tag'] === 'video' && Number(m.duration) > 0) {
    out.duration_s = Math.round(Number(m.duration) / 10) / 100;   // ms -> s
  }
  return out.w || out.duration_s ? out : null;
}
// probe cache beats media_info: parsed from the file's own bytes, and it
// carries the codec. Only really-measured values ever land here.
function specForEntry(entry, probes) {
  const cached = probes[probeKey(entry.path_display, entry.rev)];
  if (cached && !cached.unreadable) {
    return { source: 'probe', w: cached.w || null, h: cached.h || null,
             duration_s: cached.duration_s || null, codec: cached.codec || null,
             fps: cached.fps || null, audio: !!cached.audio };
  }
  if (cached && cached.unreadable) return { source: 'probe', unreadable: true, note: cached.note || '' };
  return mediaOf(entry);
}

// One live listing, shaped for the UI: files only, is_new diffed against the
// seen-snapshot, specs attached, and a MATCH SUGGESTION against the show's
// open pieces — ask-don't-accuse: a suggestion a human confirms in the track
// modal, never an auto-file.
async function listingFor(link, openPieces) {
  const entries = await dbx.listFolder(link.path);
  const snap = snapOf(link);
  const files = entries.filter((e) => e['.tag'] === 'file').map((e) => {
    const pl = lower(e.path_display);
    const seen = snap.seen[pl];
    const spec = specForEntry(e, snap.probes);
    const out = {
      name: e.name,
      path: e.path_display,
      rev: e.rev || null,
      size: Number(e.size) || 0,
      server_modified: e.server_modified || null,
      is_new: !seen || seen.size !== (Number(e.size) || 0) || seen.server_modified !== (e.server_modified || null),
      spec: spec && !spec.unreadable ? spec : null,
      spec_unreadable: !!(spec && spec.unreadable)
    };
    if (out.spec && out.spec.w && out.spec.h && openPieces) {
      const hit = openPieces.find((p) => p.spec_w === out.spec.w && p.spec_h === out.spec.h);
      if (hit) out.match_piece = { id: hit.id, name: hit.name, spec_w: hit.spec_w, spec_h: hit.spec_h };
    }
    return out;
  });
  files.sort((a, b) => String(b.server_modified || '').localeCompare(String(a.server_modified || '')));
  return files;
}
async function openPiecesOf(showId) {
  const r = await pool.query(
    `SELECT id, name, spec_w, spec_h FROM content_pieces
     WHERE show_id=$1 AND status NOT IN ('approved','delivered','na')
       AND spec_w IS NOT NULL AND spec_h IS NOT NULL
     ORDER BY sort_order ASC, id ASC`, [showId]);
  return r.rows.map((p) => ({ id: p.id, name: p.name, spec_w: Number(p.spec_w), spec_h: Number(p.spec_h) }));
}

// ════════════════════════════════════════════════════════════════════════════
// BROWSE + FILE REQUESTS — the pickers
// ════════════════════════════════════════════════════════════════════════════
// GET /api/dropbox/browse?path= — the folder picker's one read. Folders only:
// picking a folder is the act; the files inside come later, on the link.
router.get('/dropbox/browse', asyncH(async (req, res) => {
  requireDropbox();
  const path = String(pick(req.query, 'path') || '');
  const entries = await dbx.listFolder(path);
  const folders = entries.filter((e) => e['.tag'] === 'folder')
    .map((e) => ({ name: e.name, path: e.path_display }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  res.json({ path: dbx.normPath(path) || '/', folders,
             file_count: entries.filter((e) => e['.tag'] === 'file').length });
}));

// GET /api/dropbox/file-requests — open file requests, for the link picker.
// Needs file_requests.read; without it the answer is the NAMED 501, and the
// paste-a-URL path on a plain folder link still works.
router.get('/dropbox/file-requests', asyncH(async (req, res) => {
  requireDropbox();
  const all = await dbx.fileRequestsList();
  res.json(all.filter((r) => r.is_open !== false).map((r) => ({
    id: r.id, title: r.title || '', destination: r.destination || '',
    url: r.url || '', file_count: Number(r.file_count) || 0
  })));
}));

// ════════════════════════════════════════════════════════════════════════════
// LINKS — CRUD plus the live listing
// ════════════════════════════════════════════════════════════════════════════
// GET /api/shows/:id/dropbox-links — links + per-link LIVE listing. A link
// whose folder cannot be listed degrades to ITS OWN honest error while its
// neighbours still render; a file-request destination that Dropbox has not
// created yet (no upload landed) says so instead of erroring.
router.get('/shows/:id/dropbox-links', asyncH(async (req, res) => {
  requireDropbox();
  const show = await loadShowOr404(idParam(req));
  const r = await pool.query(
    `SELECT * FROM show_dropbox_links WHERE show_id=$1 ORDER BY id ASC`, [show.id]);
  const openPieces = await openPiecesOf(show.id);

  // the missing-file sweep needs every remote row this show tracks
  const remoteRows = (await pool.query(
    `SELECT * FROM files WHERE show_id=$1 AND external_store='dropbox'`, [show.id])).rows;

  const links = [];
  for (const row of r.rows) {
    let extra;
    let livePaths = null;
    try {
      const entries = await listingFor(row, openPieces);
      livePaths = new Set(entries.map((e) => lower(e.path)));
      extra = { entries, new_count: entries.filter((e) => e.is_new).length };
    } catch (e) {
      extra = dbx.isPathNotFound(e)
        ? { entries: [], new_count: 0,
            note: 'This folder does not exist in Dropbox yet — a file request\'s ' +
                  'destination appears when the first upload lands.' }
        : { entries: null, new_count: 0, error: e.message };
    }
    // ── the honest degradation for tracked files ──────────────────────────
    // A remote row whose path was inside this folder and is no longer in the
    // live listing has MOVED OR BEEN DELETED in Dropbox. Record the fact;
    // clear it the moment the path answers again. Never a generic error.
    if (livePaths) {
      for (const f of remoteRows) {
        if (!underPath(f.external_path, row.path)) continue;
        const present = livePaths.has(lower(f.external_path));
        if (!present && !f.external_missing_at) {
          await pool.query(`UPDATE files SET external_missing_at=NOW() WHERE id=$1`, [f.id]);
          f.external_missing_at = new Date();
        } else if (present && f.external_missing_at) {
          await pool.query(`UPDATE files SET external_missing_at=NULL WHERE id=$1`, [f.id]);
          f.external_missing_at = null;
        }
      }
    }
    links.push(dbToDropboxLink(row, extra));
  }
  res.json({ links });
}));

// POST /api/shows/:id/dropbox-links — link a folder (or a file request).
// Two forms:
//   { path, roles, label?, file_request_url? }   the browse-picker form; the
//       optional URL is a hand-paste, so copy-to-clipboard works even when
//       the file_requests scopes are not granted;
//   { file_request_id, roles?, label? }          the API form — resolves the
//       request's destination + URL (needs file_requests.read).
router.post('/shows/:id/dropbox-links', requireRole('pm'), asyncH(async (req, res) => {
  requireDropbox();
  const show = await loadShowOr404(idParam(req));
  await assertCanEditShow(req, show);
  const b = req.body || {};

  let path;
  let label = String(pick(b, 'label') || '').trim();
  let fileRequestId = null;
  let fileRequestUrl = String(pick(b, 'file_request_url') || '').trim();
  let roles;

  const reqId = String(pick(b, 'file_request_id') || '').trim();
  if (reqId) {
    const fr = await dbx.fileRequestGet(reqId);
    path = fr.destination;
    if (!path) throw badRequest('that file request has no destination folder');
    fileRequestId = fr.id;
    fileRequestUrl = fr.url || fileRequestUrl;
    if (!label) label = fr.title || '';
    roles = readRoles(pick(b, 'roles'), ['incoming']);   // a request is an inbound door
  } else {
    path = dbx.normPath(pick(b, 'path'));
    if (!path) throw badRequest('path required — pick a folder in the browse picker, or name a file request');
    roles = readRoles(pick(b, 'roles'));
    if (fileRequestUrl && !/^https:\/\//.test(fileRequestUrl)) {
      throw badRequest('file_request_url must be an https:// link (paste it from Dropbox)');
    }
    // Verify the folder is REAL before linking it — a typo'd path would sit
    // on the show erroring forever. Not-found is a 400 in plain words.
    let meta;
    try {
      meta = await dbx.getMetadata(path);
    } catch (e) {
      if (dbx.isPathNotFound(e)) throw badRequest(`${path} names nothing in Dropbox — check the path`);
      throw e;
    }
    if (meta['.tag'] !== 'folder') throw badRequest(`${path} is a file — link the folder that holds it`);
    path = meta.path_display || path;
  }

  const dup = await pool.query(
    `SELECT id FROM show_dropbox_links WHERE show_id=$1 AND LOWER(path)=LOWER($2)`, [show.id, path]);
  if (dup.rows.length) {
    throw conflict(`${path} is already linked to this show — edit that link's roles instead of doubling it`);
  }

  const out = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO show_dropbox_links (show_id, project_id, path, label, roles,
         file_request_id, file_request_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [show.id, show.project_id, path, label, roles, fileRequestId, fileRequestUrl, req.actor]);
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'dropbox.link',
      detail: `${path} (${roles.join(' + ')})${fileRequestId ? ' — a file request\'s destination' : ''}`,
      accent: true });
    return ins.rows[0];
  });
  res.json(dbToDropboxLink(out, { entries: [], new_count: 0 }));
}));

// POST /api/shows/:id/dropbox-links/create-file-request { title } — mint the
// request over in Dropbox (file_requests.write — the named 501 until the
// admin grants it), link its destination as an incoming folder, hand back the
// URL to send the client.
router.post('/shows/:id/dropbox-links/create-file-request', requireRole('pm'), asyncH(async (req, res) => {
  requireDropbox();
  const show = await loadShowOr404(idParam(req));
  const project = await assertCanEditShow(req, show);
  const b = req.body || {};
  const title = String(pick(b, 'title') || '').trim();
  if (!title) throw badRequest('title required — what should the client see on the request page?');
  // Dropbox needs a destination; default it under one predictable roof. The
  // folder itself is created by Dropbox when the first upload lands.
  const clean = (s) => String(s || '').replace(/[\\/:?*<>"|]/g, ' ').replace(/\s+/g, ' ').trim();
  const destination = dbx.normPath(pick(b, 'destination')) ||
    `/File requests/${clean(show.name || project.name)} — ${clean(title)}`;

  const fr = await dbx.fileRequestCreate({ title, destination });
  const out = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO show_dropbox_links (show_id, project_id, path, label, roles,
         file_request_id, file_request_url, created_by)
       VALUES ($1,$2,$3,$4,'{incoming}',$5,$6,$7) RETURNING *`,
      [show.id, show.project_id, fr.destination || destination, title, fr.id, fr.url || '', req.actor]);
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'dropbox.request', detail: `“${title}” → ${fr.destination || destination}`, accent: true });
    return ins.rows[0];
  });
  res.json({ link: dbToDropboxLink(out, { entries: [], new_count: 0 }), url: fr.url || '' });
}));

// DELETE /api/shows/:id/dropbox-links/:linkId — LOCAL ONLY, the invariant.
// This route holds no Dropbox client call and works with Dropbox entirely
// unconfigured — which is the strongest proof available that unlinking can
// never reach the folder: there is nothing here that knows how. The fake's
// zero-deletes counter and its mutation test stand guard over this exact
// property.
router.delete('/shows/:id/dropbox-links/:linkId', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShowOr404(idParam(req));
  await assertCanEditShow(req, show);
  const link = await loadLinkOr404(idParam(req, 'linkId'));
  if (link.show_id !== show.id) throw notFound('That link is not on this show');
  await withTx(async (c) => {
    await c.query(`DELETE FROM show_dropbox_links WHERE id=$1`, [link.id]);
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'dropbox.unlink',
      detail: `${link.path} — link removed; the Dropbox folder and its files are untouched` });
  });
  res.json({ ok: true, touched_dropbox: false });
}));

// POST /api/dropbox-links/:id/seen — "mark seen": rewrite the NEW-badge
// baseline to what the folder holds right now. The probe cache rides along
// untouched — seeing a file does not forget its measurements.
router.post('/dropbox-links/:id/seen', requireRole('pm'), asyncH(async (req, res) => {
  requireDropbox();
  const link = await loadLinkOr404(idParam(req));
  const show = await loadShowOr404(link.show_id);
  await assertCanEditShow(req, show);
  const entries = await dbx.listFolder(link.path);
  const seen = {};
  for (const e of entries) {
    if (e['.tag'] !== 'file') continue;
    seen[lower(e.path_display)] = { size: Number(e.size) || 0,
                                    server_modified: e.server_modified || null };
  }
  const snap = snapOf(link);
  const r = await pool.query(
    `UPDATE show_dropbox_links SET snapshot=$1, last_checked_at=NOW(),
       updated_at=NOW(), updated_by=$2 WHERE id=$3 RETURNING *`,
    [JSON.stringify({ seen, probes: snap.probes }), req.actor, link.id]);
  res.json(dbToDropboxLink(r.rows[0], { seen_count: Object.keys(seen).length }));
}));

// ════════════════════════════════════════════════════════════════════════════
// PROBE — pixel specs and codec, from the file's own bytes, bounded
// ════════════════════════════════════════════════════════════════════════════
// POST /api/dropbox-links/:id/probe { entry_path }. Signed-in: measuring a
// file is reading it. Range reads only, capped by lib/mediaprobe.js; the
// verdict — including an honest "couldn't read the container" — is cached in
// the link snapshot per file REVISION, so a probe happens once per rev and
// the listing serves it to everyone thereafter. A remote files row tracking
// this exact path+rev gets the measured numbers too, so the version ladder's
// ✓/? chips stand on real measurement.
router.post('/dropbox-links/:id/probe', asyncH(async (req, res) => {
  requireDropbox();
  const link = await loadLinkOr404(idParam(req));
  await loadShowOr404(link.show_id);
  const entryPath = String(pick(req.body || {}, 'entry_path') || '').trim();
  assertEntryUnderLink(entryPath, link);

  let meta;
  try {
    meta = await dbx.getMetadata(entryPath);
  } catch (e) {
    if (dbx.isPathNotFound(e)) {
      throw notFound(`${entryPath} is no longer in Dropbox (moved or deleted over there)`);
    }
    throw e;
  }
  if (meta['.tag'] !== 'file') throw badRequest(`${entryPath} is a folder — probe a file`);

  const key = probeKey(meta.path_display, meta.rev);
  const snap = snapOf(link);
  let result = snap.probes[key];
  const wasCached = !!result;
  if (!result) {
    try {
      const spec = await probeSpecs({
        size: Number(meta.size) || 0,
        fetchRange: (a, b) => dbx.downloadRange(meta.path_display, a, b)
      });
      result = { ...spec, probed_at: new Date().toISOString() };
    } catch (e) {
      if (e.code === 'PROBE_UNREADABLE' || e.code === 'PROBE_BUDGET') {
        // the honest failure is a result too — cached so the next click does
        // not re-spend the ranges discovering the same nothing
        result = { unreadable: true, note: e.message, probed_at: new Date().toISOString() };
      } else {
        throw e;
      }
    }
    snap.probes[key] = result;
    await pool.query(
      `UPDATE show_dropbox_links SET snapshot=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify({ seen: snap.seen, probes: snap.probes }), link.id]);
    if (!result.unreadable) {
      await pool.query(
        `UPDATE files SET width=COALESCE($1, width), height=COALESCE($2, height),
           duration_s=COALESCE($3, duration_s),
           dim=CASE WHEN $1 IS NOT NULL AND $2 IS NOT NULL THEN $1 || ' x ' || $2 ELSE dim END
         WHERE external_store='dropbox' AND LOWER(external_path)=LOWER($4) AND external_rev=$5`,
        [result.w || null, result.h || null, result.duration_s || null,
         meta.path_display, meta.rev || null]);
    }
  }
  res.json({ path: meta.path_display, rev: meta.rev || null, cached: wasCached, ...result });
}));

// ════════════════════════════════════════════════════════════════════════════
// TRACK IN PLACE — the primary bridge (no bytes copied, ever)
// ════════════════════════════════════════════════════════════════════════════
// POST /api/dropbox-links/:id/track { entry_path, content_piece_id }
// An arrival becomes an owed piece's next version by REFERENCE: a files row
// with a remote locator (path + rev, size as Dropbox reports it — real and
// reported, never stamped) and the piece's version ladder pointing at it.
// Dimensions land only from the probe cache / Dropbox media info — measured,
// or absent. Gate: the step-owner predicate, same as filing a version by
// hand.
router.post('/dropbox-links/:id/track', asyncH(async (req, res) => {
  requireDropbox();
  const link = await loadLinkOr404(idParam(req));
  const show = await loadShowOr404(link.show_id);
  const b = req.body || {};
  if (!link.roles.includes('incoming')) {
    throw badRequest(`arrivals are tracked from an 'incoming' folder — this link is ${link.roles.join(' + ')}. ` +
      'Add the incoming role to it if clients really drop files here.');
  }
  const entryPath = String(pick(b, 'entry_path') || '').trim();
  assertEntryUnderLink(entryPath, link);
  const pieceId = intOrNull(pick(b, 'content_piece_id'));
  if (!pieceId) throw badRequest('content_piece_id required — track links an arrival TO a piece');
  const piece = await loadRow('content_pieces', pieceId);
  if (!piece) throw notFound('Content piece not found');
  if (piece.show_id !== show.id) {
    throw badRequest('that piece belongs to a different show — a version must be one of this show\'s own pieces');
  }
  if (!(await canWorkPiece(req, piece))) {
    throw forbidden('filing a version is for the folder\'s editors — or the piece\'s own owner');
  }

  let meta;
  try {
    meta = await dbx.getMetadata(entryPath);
  } catch (e) {
    if (dbx.isPathNotFound(e)) {
      throw notFound(`${entryPath} is no longer in Dropbox (moved or deleted over there)`);
    }
    throw e;
  }
  if (meta['.tag'] !== 'file') throw badRequest(`${entryPath} is a folder — track a file`);

  // specs: the probe cache first (measured from bytes), Dropbox media info
  // second (reported), nothing third — the §12b rule, server-side.
  const snap = snapOf(link);
  const cached = snap.probes[probeKey(meta.path_display, meta.rev)];
  const media = mediaOf(meta) || {};
  const w = (cached && !cached.unreadable && cached.w) || media.w || null;
  const h = (cached && !cached.unreadable && cached.h) || media.h || null;
  const dur = (cached && !cached.unreadable && cached.duration_s) || media.duration_s || null;

  const dot = meta.name.lastIndexOf('.');
  const base = dot > 0 ? meta.name.slice(0, dot) : meta.name;
  const ext = dot > 0 ? meta.name.slice(dot + 1) : '';

  const out = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO files (project_id, show_id, name, ext, kind, ver, dim, meta, nas_path,
         size, uploaded_by, status, source_ref,
         external_store, external_path, external_rev, width, height, duration_s)
       VALUES (NULL,$1,$2,$3,'proof','v1',$4,$5,NULL,$6,$7,'filed',$8,'dropbox',$9,$10,$11,$12,$13)
       RETURNING *`,
      [show.id, base, ext,
       w && h ? `${w} x ${h}` : null,
       'lives in Dropbox — tracked in place, no copy made',
       Number(meta.size) || 0, req.session.username,
       `dropbox:${meta.path_display}`,
       meta.path_display, meta.rev || null, w, h, dur]);
    const file = ins.rows[0];
    const version = await fileContentVersion(c, piece, file.id, req.actor,
      { detailSuffix: ' — tracked in Dropbox, no copy made' });
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'dropbox.track',
      detail: `${meta.name} → ${piece.name} (bytes stay in Dropbox at ${meta.path_display})`,
      accent: true });
    return { file, version };
  });
  res.json({ file: dbToFile(out.file), version: dbToContentVersion(out.version, out.file) });
}));

// ════════════════════════════════════════════════════════════════════════════
// INGEST A COPY — the explicit, secondary archival door
// ════════════════════════════════════════════════════════════════════════════
// POST /api/dropbox-links/:id/ingest { entry_path, content_piece_id? }
// Downloads the file and stores it through the SAME server-side write the
// upload routes use (storage.put -> the driver's own byte count -> the row),
// so the size on the record is the size on the disk — measured, never
// stamped. With a piece, the copy files as its next version through the same
// writer as every other round. pm floor + ownership: copying bytes into the
// show's storage is a folder-editor act.
router.post('/dropbox-links/:id/ingest', requireRole('pm'), asyncH(async (req, res) => {
  requireDropbox();
  const link = await loadLinkOr404(idParam(req));
  const show = await loadShowOr404(link.show_id);
  const project = await assertCanEditShow(req, show);
  const b = req.body || {};
  if (!link.roles.includes('incoming')) {
    throw badRequest(`ingest reads from an 'incoming' folder — this link is ${link.roles.join(' + ')}`);
  }
  const entryPath = String(pick(b, 'entry_path') || '').trim();
  assertEntryUnderLink(entryPath, link);
  if (!storageReady()) {
    const e = new Error('Ingest needs somewhere to PUT the copy and this server has no byte storage ' +
      'configured (STORAGE_ROOT / the webdav driver). Track the file in place instead — that needs no storage.');
    e.status = 501;
    throw e;
  }
  const pieceId = intOrNull(pick(b, 'content_piece_id'));
  let piece = null;
  if (pieceId) {
    piece = await loadRow('content_pieces', pieceId);
    if (!piece) throw notFound('Content piece not found');
    if (piece.show_id !== show.id) {
      throw badRequest('that piece belongs to a different show — a version must be one of this show\'s own pieces');
    }
  }

  let dl;
  try {
    dl = await dbx.download(entryPath);
  } catch (e) {
    if (dbx.isPathNotFound(e)) {
      throw notFound(`${entryPath} is no longer in Dropbox (moved or deleted over there)`);
    }
    throw e;
  }
  const bytes = dl.bytes;
  const entryName = (dl.meta && dl.meta.name) || entryPath.split('/').pop();
  const dot = entryName.lastIndexOf('.');
  const base = dot > 0 ? entryName.slice(0, dot) : entryName;
  const ext = dot > 0 ? entryName.slice(dot + 1) : '';

  // measure the copy we actually hold — the probe over the very buffer that
  // lands on disk, so dims are parsed-from-bytes or absent, mechanically
  let spec = null;
  try {
    spec = await probeSpecs({ size: bytes.length,
      fetchRange: async (a, bEnd) => bytes.subarray(a, bEnd + 1) });
  } catch { spec = null; }

  const out = await withTx(async (c) => {
    const nasPath = buildNasPath(project, show, { kind: 'proof', name: base, ext });
    const ins = await c.query(
      `INSERT INTO files (project_id, show_id, name, ext, kind, ver, dim, meta, nas_path,
         size, uploaded_by, status, source_ref, width, height, duration_s)
       VALUES (NULL,$1,$2,$3,'proof','v1',$4,$5,$6,0,$7,'filed',$8,$9,$10,$11) RETURNING *`,
      [show.id, base, ext,
       spec && spec.w && spec.h ? `${spec.w} x ${spec.h}` : null,
       `ingested copy from Dropbox ${entryPath}`,
       nasPath, req.session.username, `dropbox:${entryPath}`,
       spec ? spec.w || null : null, spec ? spec.h || null : null,
       spec ? spec.duration_s || null : null]);
    let file = ins.rows[0];

    // the EXACT storage write PUT /files/:id/content performs: driver put,
    // warm-copy invalidation, then the row records the driver's own count
    const result = await storage.put(nasPath, bytes);
    fileCache.invalidatePath(nasPath);
    file = (await c.query(`UPDATE files SET size=$1 WHERE id=$2 RETURNING *`,
      [result.size, file.id])).rows[0];

    let version = null;
    if (piece) {
      version = await fileContentVersion(c, piece, file.id, req.actor,
        { detailSuffix: ' — ingested copy from Dropbox' });
    }
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'dropbox.ingest',
      detail: `${entryName} — ${result.size.toLocaleString()} bytes copied from ${link.path}` +
              (piece ? ` → ${piece.name}` : ''),
      accent: true });
    return { file, version };
  });
  res.json({ file: dbToFile(out.file),
             version: out.version ? dbToContentVersion(out.version, out.file) : null });
}));

// ════════════════════════════════════════════════════════════════════════════
// DEPOSIT — push a show file's bytes out to a delivery folder
// ════════════════════════════════════════════════════════════════════════════
// POST /api/dropbox-links/:id/deposit { file_id }. to_client / to_operator
// folders only — the roles are load-bearing. The bytes must really exist on
// the NAS (the 9/3 honesty rule: a byteless row is a 404 that says so), and
// Dropbox autorenames on collision, so a deposit can never eat a file.
router.post('/dropbox-links/:id/deposit', requireRole('pm'), asyncH(async (req, res) => {
  requireDropbox();
  const link = await loadLinkOr404(idParam(req));
  const show = await loadShowOr404(link.show_id);
  await assertCanEditShow(req, show);
  if (!link.roles.includes('to_client') && !link.roles.includes('to_operator')) {
    throw badRequest(`deposits go to a 'to_client' or 'to_operator' folder — this link is ` +
      `${link.roles.join(' + ')}. Add the delivery role to it if this really is where deliveries land.`);
  }
  const fileId = intOrNull(pick(req.body || {}, 'file_id'));
  if (!fileId) throw badRequest('file_id required — which of this show\'s files goes out?');
  const file = await loadRow('files', fileId);
  if (!file) throw notFound('File not found');
  if (file.show_id !== show.id) {
    throw badRequest('that file belongs to a different show — deposit one of this show\'s own files');
  }
  if (file.external_store === 'dropbox') {
    throw badRequest(`that file already lives in Dropbox (${file.external_path}) — ` +
      'share that path instead of copying it through here');
  }
  if (!file.nas_path || !Number(file.size)) {
    throw notFound(`“${file.name}” has no bytes on the NAS — the row is metadata only, so there is ` +
      'nothing to send. Upload the missing document first.');
  }

  const bytes = await storage.get(file.nas_path);
  const dest = `${link.path}/${fileName({ name: file.name, ext: file.ext })}`;
  const result = await dbx.upload(dest, bytes);
  await logActivity(pool, { projectId: show.project_id, showId: show.id, actor: req.actor,
    action: 'dropbox.deposit',
    detail: `${fileName({ name: file.name, ext: file.ext })} — ${bytes.length.toLocaleString()} bytes → ` +
            `${(result && result.path_display) || dest}`,
    accent: true });
  res.json({ ok: true, path: (result && result.path_display) || dest, size: bytes.length });
}));

module.exports = router;
