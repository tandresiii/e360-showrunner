// ════════════════════════════════════════════════════════════════════════════
// routes/meetings.js — MEETING SUMMARIES on a folder
// ────────────────────────────────────────────────────────────────────────────
// Tom, verbatim: "we should definitely add a meeting summary feature to
// projects... we can add these summaries."
//
// WHAT THIS IS, AND WHAT IT IS NOT. The 9/18 transcript reader (lib/graph.js +
// lib/transcripts.js) already files the MACHINE record: a `transcript` document
// with real bytes, full provenance and an audit row per Graph touch. Nobody
// browses a vtt. This is the HUMAN layer over it — one row per meeting, with
// the title, the day, who was in the room, and the DIGEST somebody (or
// something) wrote from the recording: markdown with headings, action items and
// verbatim quoted receipts. A season's meetings become one browsable list on
// the folder that owns them.
//
// THE MANUAL DOOR SHIPS FIRST (the 9/16 law). Every route here is a person's:
// `source` is 'manual' and the only writer is the dialog on the season
// dashboard. 'graph' is RESERVED for the extraction pipeline that will one day
// write these rows off a transcript — and it does not exist yet, so nothing
// here pretends it does.
//
// ROLES — the SCHEDULE FAMILY's gate, reused, not re-derived: pm+ rank
// (ROS-style `requireRole('pm')`) AND `canEditProject` on the owning FOLDER, so
// a pm may file meetings on their own seasons and nobody else's. Reads are open
// to anyone signed in: a tech who missed the call is exactly who needs to read
// what was decided on it.
//
// THE TWO HALVES ARE NOT INTERCHANGEABLE, AND ARE NOT REDUNDANT THE WAY THEY
// LOOK. canEditProject() already refuses every role the rank floor would refuse
// — so from outside, deleting `pmPlus` changes no STATUS CODE, only the
// sentence. That is exactly why smoke's gate assertions pin each 403 to the
// WORDING of the half that produced it: a bare `status === 403` pair would stay
// green with the rank floor gone and would pin only one of the two things it
// appears to pin. The floor stays because it is the thing that keeps holding if
// canEditProject is ever widened.
//
// MARKDOWN IS STORED RAW. `summary_md` goes to the database as the person typed
// it and comes back the same way. Rendering — and the escaping that makes a
// hostile paste inert — happens ONCE, in public/components.js mdHTML(), which
// escapes first and transforms second. A server that shipped half-rendered HTML
// would be a server nobody downstream could re-escape.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadProject, loadShow } = require('../lib/db');
const { isISODate, isHHMM, intOrNull, oneOf, marketOrNull } = require('../lib/enums');
const { pick, has, dbToMeeting } = require('../lib/mappers');
const { asyncH, badRequest, forbidden, notFound, idParam } = require('../lib/http');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');

const router = express.Router();

// server.js mounts this at /api and does NOT authenticate for us. Every route
// in this module — the reads included — needs a session.
router.use(requireAuth);

// pm+ is the rank half of the gate; canEditProject() is the ownership half.
// The SAME pair routes/schedule.js uses, deliberately: a meeting is season
// planning, and season planning belongs to the folder's pm.
const pmPlus = requireRole('pm');

// Where a meeting may come from. 'manual' is the only one a human door writes;
// 'graph' is reserved for the extraction pipeline (see the header).
const MEETING_SOURCES = ['manual', 'graph'];

// F3/F8's device: the material set as DATA, so "material vs routine" is
// something a reader can check rather than an if-statement inside a handler.
// `summary_md` is deliberately ABSENT — see summaryChange() below, which is
// where an edit to the digest becomes a change entry that does not dump a whole
// internal digest into the activity feed.
const MATERIAL_MEETING_FIELDS = {
  title: 'title', held_at: 'held on', held_time: 'time',
  attendees: 'attendees', show_id: 'show', transcript_file_id: 'transcript',
  market: 'market'
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// The folder, or a 404. Reads only.
async function projectOr404(projectId, q = pool) {
  const project = await loadProject(projectId, q);
  if (!project) throw notFound(`project ${projectId} not found`);
  return project;
}

// The full edit gate: pm+ (the middleware) AND edit rights on the folder.
async function editableProject(req, projectId, q = pool) {
  const project = await projectOr404(projectId, q);
  if (!canEditProject(req.session, project)) {
    throw forbidden('filing a meeting requires pm, manager or admin on this project');
  }
  return project;
}

function heldOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!isISODate(s)) throw badRequest(`held_at must be an ISO date (YYYY-MM-DD) or null — got "${value}"`);
  return s;
}
function timeOrBlank(value) {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value).trim();
  if (!isHHMM(s)) throw badRequest(`held_time must be HH:MM or empty — got "${value}"`);
  return s;
}

// A linked show must be a real one IN THIS FOLDER. A meeting quietly pointing
// at another season's show is the cross-wiring this refuses to let a stale
// screen (or an agent) create — the same validation shape as
// roomBookingOrNull() in routes/schedule.js.
async function showInProjectOrNull(rawId, projectId, q = pool) {
  const showId = intOrNull(rawId);
  if (!showId) return null;
  const show = await loadShow(showId, q);
  if (!show) throw badRequest(`show ${showId} not found`);
  if (show.project_id !== projectId) {
    throw badRequest(`show ${showId} belongs to another folder — a meeting links only to a show in its own folder`);
  }
  return showId;
}

// MARKETS (2026-09-30) — a meeting may anchor to a MARKET of its folder
// instead of one show: the "Season Beginning" calls are about Grand Rapids,
// not about its install OR its scrimmage. The market must be one a show in
// THIS folder is actually filed under (case-insensitive), and the stored
// spelling is the shows' own — so a hand-typed "grand rapids" lands as the
// "Grand Rapids" every surface already prints. A market nobody is in would
// be a meeting anchored to nothing any page can reach.
async function marketInProjectOrNull(raw, projectId, q = pool) {
  const market = marketOrNull(raw);
  if (!market) return null;
  const r = await q.query(
    `SELECT market FROM shows WHERE project_id=$1 AND lower(market)=lower($2)
      ORDER BY event_date ASC, id ASC LIMIT 1`, [projectId, market]);
  if (!r.rows.length) {
    throw badRequest(`no show in this folder is in the market "${market}" — name the market on a show first`);
  }
  return r.rows[0].market;
}
// ONE anchor: a show, a market, or neither (the whole season). Both at once
// would render the call in two places for two different reasons.
function oneAnchor(showId, market) {
  if (showId && market) {
    throw badRequest('a meeting anchors to ONE show or ONE market, not both — clear one of them');
  }
}

// …and the same rule for the transcript document. A `files` row reaches its
// folder either directly (project_id, the folder-level door) or through its
// show — both count, nothing outside the folder does.
async function fileInProjectOrNull(rawId, projectId, q = pool) {
  const fileId = intOrNull(rawId);
  if (!fileId) return null;
  const r = await q.query('SELECT id, project_id, show_id FROM files WHERE id=$1', [fileId]);
  const f = r.rows[0];
  if (!f) throw badRequest(`file ${fileId} not found`);
  let ownerId = f.project_id || null;
  if (!ownerId && f.show_id) {
    const show = await loadShow(f.show_id, q);
    ownerId = show ? show.project_id : null;
  }
  if (ownerId !== projectId) {
    throw badRequest(`file ${fileId} belongs to another folder — a meeting links only to its own folder's documents`);
  }
  return fileId;
}

// The digest is the whole point of the record, so an edit to it IS material —
// but the activity feed is read by everybody and a digest is INTERNAL (it is
// why `meetings` sits in the recap firewall's forbidden tables). So the change
// entry carries the SHAPE of the edit, never the text: "summary 1,240 → 1,310
// characters". Structured like every other change row, and safe to render
// anywhere the feed renders.
function summaryChange(before, after) {
  const a = String(before == null ? '' : before);
  const b = String(after == null ? '' : after);
  if (a === b) return null;
  const n = (s) => `${s.length.toLocaleString('en-US')} characters`;
  return { field: 'summary_md', label: 'summary', from: a ? n(a) : null, to: b ? n(b) : null };
}

function meetingLabel(row) {
  return `${row.title}${row.held_at ? ' · ' + row.held_at : ''}`;
}

// Newest first — a season's most recent call is the one somebody is looking
// for. Meetings with no date sort after the dated ones rather than to the top,
// which is what NULLS LAST buys; `id DESC` breaks a same-day tie by "filed
// most recently", the only ordering the row itself can justify.
//
// MARKETS — the two narrowed listings, the server half of what the client's
// meetingsForShow()/meetingsForMarket() (public/data.js) compute off the
// flat store. They must agree, and the walk asks both:
//   { showId }  the show's OWN tab: pinned to it, OR anchored to its market
//               (market set, show_id null, same folder, same market)
//   { market }  the market HUB: anchored to the market, OR pinned to any
//               show filed under it
async function meetingsForProject(projectId, q = pool, { showId = null, market = null } = {}) {
  const order = ' ORDER BY held_at DESC NULLS LAST, id DESC';
  let r;
  if (showId) {
    r = await q.query(
      `SELECT m.* FROM meetings m
        WHERE m.project_id=$1
          AND (m.show_id=$2
               OR (m.show_id IS NULL AND m.market IS NOT NULL AND lower(m.market) =
                   (SELECT lower(s.market) FROM shows s WHERE s.id=$2 AND s.project_id=$1)))` + order,
      [projectId, showId]);
  } else if (market) {
    r = await q.query(
      `SELECT m.* FROM meetings m
        WHERE m.project_id=$1
          AND ((m.show_id IS NULL AND lower(m.market)=lower($2))
               OR m.show_id IN (SELECT s.id FROM shows s
                                 WHERE s.project_id=$1 AND lower(s.market)=lower($2)))` + order,
      [projectId, market]);
  } else {
    r = await q.query(`SELECT * FROM meetings WHERE project_id=$1` + order, [projectId]);
  }
  return r.rows.map(dbToMeeting);
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/projects/:id/meetings — anyone signed in. A tech who missed the call
// is exactly who needs to read what was decided on it.
//   ?show_id=N  → that show's tab (pinned + its market's anchored calls)
//   ?market=M   → that market's hub (anchored + its shows' pinned calls)
router.get('/projects/:id/meetings', asyncH(async (req, res) => {
  const projectId = idParam(req);
  await projectOr404(projectId);
  const q = req.query || {};
  if (q.show_id !== undefined && q.show_id !== '') {
    const showId = await showInProjectOrNull(q.show_id, projectId);
    if (!showId) throw badRequest(`show_id must be a show id — got "${q.show_id}"`);
    return res.json(await meetingsForProject(projectId, pool, { showId }));
  }
  if (q.market !== undefined && q.market !== '') {
    const market = marketOrNull(q.market);
    if (market) return res.json(await meetingsForProject(projectId, pool, { market }));
  }
  res.json(await meetingsForProject(projectId));
}));

// POST /api/projects/:id/meetings — pm+ on this folder.
router.post('/projects/:id/meetings', pmPlus, asyncH(async (req, res) => {
  const projectId = idParam(req);
  const body = req.body || {};
  await editableProject(req, projectId);

  const title = String(pick(body, 'title') || '').trim();
  if (!title) throw badRequest('a meeting needs a title — what the call was about');
  const heldAt = heldOrNull(pick(body, 'held_at'));
  const heldTime = timeOrBlank(pick(body, 'held_time'));
  const showId = await showInProjectOrNull(pick(body, 'show_id'), projectId);
  const market = await marketInProjectOrNull(pick(body, 'market'), projectId);
  oneAnchor(showId, market);
  const fileId = await fileInProjectOrNull(pick(body, 'transcript_file_id'), projectId);
  // 'manual' unless a caller names a source we know. The pipeline that will
  // write 'graph' rows does not exist yet — this accepts the value rather than
  // making the future write a migration to say where a row came from.
  const source = oneOf(String(pick(body, 'source') || 'manual').trim(), MEETING_SOURCES, 'manual');

  const meeting = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO meetings
         (project_id, show_id, title, held_at, held_time, attendees, summary_md,
          transcript_file_id, source, created_by, market)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [projectId, showId, title, heldAt, heldTime,
       String(pick(body, 'attendees') || '').trim(),
       String(pick(body, 'summary_md') || ''), fileId, source, req.actor, market]);
    const row = r.rows[0];
    await logActivity(c, {
      projectId, showId,
      actor: req.actor, action: 'meeting.add', accent: true,
      detail: meetingLabel(row)
    });
    return dbToMeeting(row);
  });

  res.json(meeting);
}));

// PUT /api/meetings/:id — partial patch, same gate, same validation. The
// FOLDER is taken from the stored row, never from the body: re-homing a meeting
// into another season would be a second, differently-gated act.
router.put('/meetings/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const existing = (await pool.query('SELECT * FROM meetings WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`meeting ${id} not found`);
  await editableProject(req, existing.project_id);

  const sets = [];
  const params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

  if (has(body, 'title')) {
    const title = String(pick(body, 'title') || '').trim();
    if (!title) throw badRequest('a meeting needs a title — delete the meeting instead of blanking it');
    set('title', title);
  }
  if (has(body, 'held_at')) set('held_at', heldOrNull(pick(body, 'held_at')));
  if (has(body, 'held_time')) set('held_time', timeOrBlank(pick(body, 'held_time')));
  if (has(body, 'attendees')) set('attendees', String(pick(body, 'attendees') || '').trim());
  // The digest is stored EXACTLY as typed — no trim, because leading blank
  // lines and trailing structure are the author's, and the renderer already
  // handles both.
  if (has(body, 'summary_md')) set('summary_md', String(pick(body, 'summary_md') || ''));
  // the anchor pair is resolved TOGETHER: what the row would hold after this
  // patch must still be one anchor (a show, a market, or the season)
  let nextShow = existing.show_id || null;
  let nextMarket = existing.market || null;
  if (has(body, 'show_id')) {
    nextShow = await showInProjectOrNull(pick(body, 'show_id'), existing.project_id);
    set('show_id', nextShow);
  }
  if (has(body, 'market')) {
    nextMarket = await marketInProjectOrNull(pick(body, 'market'), existing.project_id);
    set('market', nextMarket);
  }
  oneAnchor(nextShow, nextMarket);
  if (has(body, 'transcript_file_id')) {
    set('transcript_file_id',
      await fileInProjectOrNull(pick(body, 'transcript_file_id'), existing.project_id));
  }
  if (!sets.length) throw badRequest('nothing to update');
  sets.push('updated_at=NOW()');
  params.push(id);

  const meeting = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE meetings SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    const row = r.rows[0];
    const changes = diffFields(existing, row, MATERIAL_MEETING_FIELDS);
    const sum = summaryChange(existing.summary_md, row.summary_md);
    if (sum) changes.push(sum);
    await logActivity(c, {
      projectId: row.project_id, showId: row.show_id,
      actor: req.actor, action: 'meeting.update',
      detail: changes.length ? `${row.title} · ${changeSummary(changes)}` : meetingLabel(row),
      changes
    });
    return dbToMeeting(row);
  });

  res.json(meeting);
}));

// DELETE /api/meetings/:id — pm+, and a 404 on a row that never existed (the H3
// rule: a stale screen must not be told it deleted nothing successfully).
router.delete('/meetings/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const existing = (await pool.query('SELECT * FROM meetings WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`meeting ${id} not found`);
  await editableProject(req, existing.project_id);

  await withTx(async (c) => {
    await c.query('DELETE FROM meetings WHERE id=$1', [id]);
    await logActivity(c, {
      projectId: existing.project_id, showId: existing.show_id,
      actor: req.actor, action: 'meeting.remove', accent: true,
      detail: meetingLabel(existing)
    });
  });

  // The linked transcript document is UNTOUCHED — deleting the human summary
  // does not un-file the recording it was written from.
  res.json({ ok: true, project_id: existing.project_id });
}));

module.exports = router;
