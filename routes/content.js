// ════════════════════════════════════════════════════════════════════════════
// routes/content.js — content pieces: the graphic-design pipeline
// ────────────────────────────────────────────────────────────────────────────
// Tom (2026-09-10): "a graphic design deliverables feature." Every show owes a
// set of CONTENT PIECES — "Sponsor loop — ribbon — 11520×90 — :30", "Court
// wrap print — 48'×8'", "Team intro sting — center hung" — and until this
// module nothing tracked them. Three shape decisions, all Tom's:
//
//   1. MIXED PRODUCERS. Sometimes E360 is hired to create the files, sometimes
//      the client (or a third party) supplies them, sometimes it is a mix. So
//      every piece carries a `source`: an 'e360' piece gets an internal owner
//      + due date, assigned like a task; a 'client'/'third_party' piece is
//      OWED TO US and points at a rolodex contact — "what the client still
//      owes" is this feature's reason to exist as much as tracking our own.
//   2. FULL PROOF ROUNDS. v1 sent → feedback → v2 → approved. The paper trail
//      lives on the piece as `content_versions`: each version references a
//      REAL uploaded `files` row, and a new version SUPERSEDES the old one —
//      kept, never deleted, the spec chain's word and the spec chain's rule.
//   3. SPEC INTEGRATION. Required pixel sizes prefill from the bound .e360's
//      media-server zones (stack-aware — a double-stacked zone is twice the
//      height), and a delivered file's MEASURED pixels are compared to the
//      piece's spec. A difference is a QUESTION chip — ask, don't accuse —
//      never a silent accept and never a hard reject (lib/speccheck.js).
//
// NAMING: deliberately NOT `deliverables` — that table + routes/deliverables.js
// are the post-event client recap, an unrelated, firewalled domain this module
// never reads or extends. And deliberately NOT `proofs` — see the schema
// comment in lib/db.js for why a clean own-table beat that marriage.
//
// GATES mirror the schedule/crew family: pm floor + folder ownership
// (canEditProject) to create/edit/delete; a piece's OWNER may walk ITS status
// and file ITS versions (the step-owner rule — the designer holding the file
// is the person with the news); everyone signed in reads.
//
// NOTIFICATIONS: none in v1 beyond the house notify-picker passthrough the
// sibling routes already honour (notifyTargets on create) — no new behaviour.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadShow, loadProject, loadRow } = require('../lib/db');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf } = require('../lib/http');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');
const { pick, has, dbToContentPiece, dbToContentVersion, dbToContact } = require('../lib/mappers');
const { CONTENT_SOURCES, CONTENT_KINDS, CONTENT_STATUSES, oneOf, sameUser, intOrNull,
        isISODate } = require('../lib/enums');
const { contentZonesFromDocs, contentQuestion } = require('../lib/speccheck');
const { boundSpecDocs } = require('./files');
const { notifyTargets } = require('../lib/mentions');

const router = express.Router();
router.use(requireAuth);

// The material set — a change to any of these is a diff worth reading back.
// `notes` stays outside it, the contacts-module rule: a scratchpad edit is
// routine.
const MATERIAL_PIECE_FIELDS = {
  name: 'name', surface: 'surface', kind: 'kind',
  spec_w: 'spec width', spec_h: 'spec height',
  duration_spec: 'duration', print_spec: 'print spec',
  source: 'source', owner: 'owner', contact_id: 'contact',
  due_date: 'due date', status: 'status'
};

// The newer loud-refusal oneOf style (needs list / rolodex): a vocabulary miss
// is a 400 that names the list, never a silent re-file.
function readOneOf(raw, list, label, fallback) {
  if (raw === undefined) return fallback;
  const v = oneOf(String(raw || ''), list, null);
  if (!v) throw badRequest(`${label} must be one of ${list.join(', ')}`);
  return v;
}

async function loadShowOr404(id, q = pool) {
  const show = await loadShow(id, q);
  if (!show) throw notFound('Show not found');
  return show;
}
async function assertCanEditShow(req, show, q = pool) {
  const project = await loadProject(show.project_id, q);
  if (!canEditProject(req.session, project)) {
    throw forbidden('This show belongs to a folder you do not own — pm (owner) or manager+ required');
  }
  return project;
}
async function loadPieceOr404(id, q = pool) {
  const piece = await loadRow('content_pieces', id, q);
  if (!piece) throw notFound('Content piece not found');
  return piece;
}
// The step-owner rule, applied to pieces: the folder's editors, OR the person
// the piece is assigned to. Used by the status walk and the version writes —
// the designer files their own proof round without hunting down a manager.
async function canWorkPiece(req, piece, q = pool) {
  if (sameUser(piece.owner, req.session.username)) return true;
  const show = await loadShow(piece.show_id, q);
  const project = show ? await loadProject(show.project_id, q) : null;
  return canEditProject(req.session, project);
}

// One piece, hydrated the way the tab renders it: the version ladder (oldest
// first, each with its file joined), the contact card for an owed piece, and
// the measured-vs-spec verdict computed from the CURRENT version's file.
async function hydratePieces(rows, q = pool) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const vers = await q.query(
    `SELECT v.*, row_to_json(f.*) AS file
     FROM content_versions v LEFT JOIN files f ON f.id = v.file_id
     WHERE v.piece_id = ANY($1::int[])
     ORDER BY v.piece_id, v.version_n ASC`, [ids]);
  const byPiece = {};
  for (const v of vers.rows) (byPiece[v.piece_id] = byPiece[v.piece_id] || []).push(v);

  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
  const contacts = {};
  if (contactIds.length) {
    const cr = await q.query('SELECT * FROM contacts WHERE id = ANY($1::int[])', [contactIds]);
    for (const c of cr.rows) contacts[c.id] = dbToContact(c);
  }

  return rows.map((row) => {
    const vlist = byPiece[row.id] || [];
    const current = vlist.filter((v) => v.status === 'current').slice(-1)[0] || vlist.slice(-1)[0] || null;
    const measured = current && current.file
      ? { w: current.file.width, h: current.file.height } : null;
    const verdict = contentQuestion(row, measured);
    return dbToContentPiece(row, {
      versions: vlist.map((v) => dbToContentVersion(v, v.file)),
      contact: row.contact_id ? contacts[row.contact_id] || null : null,
      question: verdict.question,
      match: verdict.match,
      measure_state: verdict.state
    });
  });
}

// approved + delivered over everything that is not 'na' — the "content 7/12"
// chip's arithmetic, in ONE place so the header, the season row and the tab
// cannot disagree.
function rollupOf(pieces) {
  const counted = pieces.filter((p) => p.status !== 'na');
  return {
    total: counted.length,
    done: counted.filter((p) => p.status === 'approved' || p.status === 'delivered').length
  };
}

// ── reads ───────────────────────────────────────────────────────────────────
// api.listContent(showId) — the Content tab's one read.
router.get('/shows/:id/content', asyncH(async (req, res) => {
  const show = await loadShowOr404(idParam(req));
  const r = await pool.query(
    `SELECT * FROM content_pieces WHERE show_id=$1 ORDER BY sort_order ASC, id ASC`, [show.id]);
  const pieces = await hydratePieces(r.rows);
  res.json({ pieces, rollup: rollupOf(pieces) });
}));

// Cross-show list — what the season dashboard's per-row chips read in one
// call. Filters: project_id (through the show table) · show_id · source.
router.get('/content', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const P = (v) => { params.push(v); return `$${params.length}`; };
  const projectId = intOrNull(pick(req.query, 'project_id'));
  if (projectId) where.push(`show_id IN (SELECT id FROM shows WHERE project_id=${P(projectId)})`);
  const showId = intOrNull(pick(req.query, 'show_id'));
  if (showId) where.push(`show_id=${P(showId)}`);
  const source = pick(req.query, 'source');
  if (source) where.push(`source=${P(readOneOf(source, CONTENT_SOURCES, 'source', null))}`);
  const r = await pool.query(
    `SELECT * FROM content_pieces ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY show_id, sort_order ASC, id ASC LIMIT ${limitOf(req, 500, 2000)}`, params);
  res.json(await hydratePieces(r.rows));
}));

// ── create / edit / delete (pm floor + folder ownership) ────────────────────
router.post('/shows/:id/content', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShowOr404(idParam(req));
  await assertCanEditShow(req, show);
  const b = req.body || {};
  const name = String(pick(b, 'name') || '').trim();
  if (!name) throw badRequest('a content piece is a named thing — name is required');
  const source = readOneOf(pick(b, 'source'), CONTENT_SOURCES, 'source', 'e360');
  const kind = readOneOf(pick(b, 'kind'), CONTENT_KINDS, 'kind', 'video');
  const status = readOneOf(pick(b, 'status'), CONTENT_STATUSES, 'status', 'needed');
  const due = String(pick(b, 'due_date') || '').trim();
  if (due && !isISODate(due)) throw badRequest('due_date must be YYYY-MM-DD');
  const contactId = intOrNull(pick(b, 'contact_id'));
  if (contactId) {
    const contact = await loadRow('contacts', contactId);
    if (!contact) throw notFound('Contact not found');
  }
  const jobId = intOrNull(pick(b, 'job_id'));
  if (jobId) {
    const job = await loadRow('jobs', jobId);
    if (!job || job.project_id !== show.project_id) {
      throw badRequest('job_id must name a job on this show\'s own folder');
    }
  }

  const out = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO content_pieces (show_id, project_id, job_id, name, surface, kind,
         spec_w, spec_h, duration_spec, print_spec, source, owner, contact_id,
         due_date, status, notes, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [show.id, show.project_id, jobId, name,
       String(pick(b, 'surface') || '').trim(), kind,
       intOrNull(pick(b, 'spec_w')), intOrNull(pick(b, 'spec_h')),
       String(pick(b, 'duration_spec') || '').trim(),
       String(pick(b, 'print_spec') || '').trim(),
       source,
       source === 'e360' ? (String(pick(b, 'owner') || '').trim() || null) : null,
       source === 'e360' ? null : contactId,
       due, status, String(pick(b, 'notes') || ''),
       intOrNull(pick(b, 'sort_order')) || 0, req.actor]);
    const piece = r.rows[0];
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'content.add',
      detail: `${name} (${source === 'e360' ? 'e360 build' : source === 'client' ? 'client supplies' : 'third party'})` });
    // the house notify passthrough, nothing invented: same anchored delivery
    // the sibling creates offer.
    await notifyTargets(c, {
      body: b, anchorType: 'show', anchorId: show.id,
      projectId: show.project_id, showId: show.id, actor: req.actor,
      summary: `added a content piece — ${name} —`
    });
    return piece;
  });
  res.json((await hydratePieces([out]))[0]);
}));

router.put('/content/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = await loadPieceOr404(idParam(req));
  const show = await loadShowOr404(cur.show_id);
  await assertCanEditShow(req, show);
  const b = req.body || {};

  const name = has(b, 'name') ? String(pick(b, 'name') || '').trim() : cur.name;
  if (!name) throw badRequest('a content piece keeps its name — blank is not a rename');
  const source = has(b, 'source') ? readOneOf(pick(b, 'source'), CONTENT_SOURCES, 'source', cur.source) : cur.source;
  const kind = has(b, 'kind') ? readOneOf(pick(b, 'kind'), CONTENT_KINDS, 'kind', cur.kind) : cur.kind;
  const status = has(b, 'status') ? readOneOf(pick(b, 'status'), CONTENT_STATUSES, 'status', cur.status) : cur.status;
  const due = has(b, 'due_date') ? String(pick(b, 'due_date') || '').trim() : cur.due_date;
  if (due && !isISODate(due)) throw badRequest('due_date must be YYYY-MM-DD');
  let contactId = has(b, 'contact_id') ? intOrNull(pick(b, 'contact_id')) : cur.contact_id;
  if (contactId && contactId !== cur.contact_id) {
    if (!(await loadRow('contacts', contactId))) throw notFound('Contact not found');
  }
  let owner = has(b, 'owner') ? (String(pick(b, 'owner') || '').trim() || null) : cur.owner;
  // The source decides which column means anything: an e360 piece has an
  // owner, an owed piece has a contact. Flipping source clears the other half
  // rather than leaving a stale claim.
  if (source === 'e360') contactId = null; else owner = null;
  let jobId = has(b, 'job_id') ? intOrNull(pick(b, 'job_id')) : cur.job_id;
  if (jobId && jobId !== cur.job_id) {
    const job = await loadRow('jobs', jobId);
    if (!job || job.project_id !== show.project_id) {
      throw badRequest('job_id must name a job on this show\'s own folder');
    }
  }

  const r = await pool.query(
    `UPDATE content_pieces SET name=$1, surface=$2, kind=$3, spec_w=$4, spec_h=$5,
       duration_spec=$6, print_spec=$7, source=$8, owner=$9, contact_id=$10,
       due_date=$11, status=$12, notes=$13, sort_order=$14, job_id=$15,
       updated_at=NOW(), updated_by=$16
     WHERE id=$17 RETURNING *`,
    [name,
     has(b, 'surface') ? String(pick(b, 'surface') || '').trim() : cur.surface,
     kind,
     has(b, 'spec_w') ? intOrNull(pick(b, 'spec_w')) : cur.spec_w,
     has(b, 'spec_h') ? intOrNull(pick(b, 'spec_h')) : cur.spec_h,
     has(b, 'duration_spec') ? String(pick(b, 'duration_spec') || '').trim() : cur.duration_spec,
     has(b, 'print_spec') ? String(pick(b, 'print_spec') || '').trim() : cur.print_spec,
     source, owner, contactId, due, status,
     has(b, 'notes') ? String(pick(b, 'notes') || '') : cur.notes,
     has(b, 'sort_order') ? (intOrNull(pick(b, 'sort_order')) || 0) : cur.sort_order,
     jobId, req.actor, cur.id]);

  const changes = diffFields(cur, r.rows[0], MATERIAL_PIECE_FIELDS);
  await logActivity(pool, { projectId: show.project_id, showId: show.id, actor: req.actor,
    action: 'content.update', accent: changes.length > 0,
    detail: changeSummary(changes, r.rows[0].name), changes });
  res.json((await hydratePieces([r.rows[0]]))[0]);
}));

// The status walk — the one write a piece's OWNER may make without folder
// ownership, exactly like a tech walking a step they own.
router.put('/content/:id/status', asyncH(async (req, res) => {
  const cur = await loadPieceOr404(idParam(req));
  if (!(await canWorkPiece(req, cur))) {
    throw forbidden('walking a piece\'s status is for the folder\'s editors — or the piece\'s own owner');
  }
  const status = readOneOf(pick(req.body || {}, 'status'), CONTENT_STATUSES, 'status', null);
  if (!status) throw badRequest(`status must be one of ${CONTENT_STATUSES.join(', ')}`);
  const r = await pool.query(
    `UPDATE content_pieces SET status=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3 RETURNING *`,
    [status, req.actor, cur.id]);
  if (status !== cur.status) {
    await logActivity(pool, { projectId: cur.project_id, showId: cur.show_id, actor: req.actor,
      action: 'content.status',
      detail: `${cur.name} · ${cur.status} → ${status}`,
      accent: status === 'approved' || status === 'delivered',
      changes: [{ field: 'status', label: 'status', from: cur.status, to: status }] });
  }
  res.json((await hydratePieces([r.rows[0]]))[0]);
}));

router.delete('/content/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = await loadPieceOr404(idParam(req));
  const show = await loadShowOr404(cur.show_id);
  await assertCanEditShow(req, show);
  await withTx(async (c) => {
    // versions die with their piece; the FILES they pointed at are the show's
    // and deliberately survive — deleting a piece must never eat a document.
    await c.query('DELETE FROM content_versions WHERE piece_id=$1', [cur.id]);
    await c.query('DELETE FROM content_pieces WHERE id=$1', [cur.id]);
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'content.delete', detail: cur.name });
  });
  res.json({ ok: true });
}));

// ── versions: the proof rounds ──────────────────────────────────────────────
// POST a new version pointing at a REAL uploaded files row. The previous
// current version is SUPERSEDED — kept, never deleted — which is the whole
// paper-trail promise, and the gate a mutation test stands on.
router.post('/content/:id/versions', asyncH(async (req, res) => {
  const piece = await loadPieceOr404(idParam(req));
  if (!(await canWorkPiece(req, piece))) {
    throw forbidden('filing a version is for the folder\'s editors — or the piece\'s own owner');
  }
  const fileId = intOrNull(pick(req.body || {}, 'file_id'));
  if (!fileId) throw badRequest('file_id required — a version IS an uploaded file');
  const file = await loadRow('files', fileId);
  if (!file) throw notFound('File not found');
  if (file.show_id !== piece.show_id) {
    throw badRequest('that file belongs to a different show — a version must be one of this show\'s own files');
  }

  const out = await withTx(async (c) => {
    const prev = await c.query(
      `SELECT COALESCE(MAX(version_n), 0)::int AS n FROM content_versions WHERE piece_id=$1`,
      [piece.id]);
    const n = prev.rows[0].n + 1;
    // supersede, never delete — the old rounds ARE the paper trail
    await c.query(
      `UPDATE content_versions SET status='superseded' WHERE piece_id=$1 AND status='current'`,
      [piece.id]);
    const r = await c.query(
      `INSERT INTO content_versions (piece_id, version_n, file_id, status, created_by)
       VALUES ($1,$2,$3,'current',$4) RETURNING *`, [piece.id, n, fileId, req.actor]);
    await logActivity(c, { projectId: piece.project_id, showId: piece.show_id, actor: req.actor,
      action: 'content.version',
      detail: `${piece.name} · v${n}${n > 1 ? ' (supersedes v' + (n - 1) + ')' : ''}` });
    return r.rows[0];
  });
  res.json(dbToContentVersion(out, file));
}));

async function loadVersionOr404(id, q = pool) {
  const v = await loadRow('content_versions', id, q);
  if (!v) throw notFound('Content version not found');
  return v;
}

// Mark a version sent-to-client. A stamp, not a send: this app has no
// outbound path — the send itself happens in somebody's own mail, and the
// record here says who recorded it and when. Idempotent: re-marking keeps the
// FIRST stamp, because the history must not move under a double click.
router.put('/content/versions/:id/send', asyncH(async (req, res) => {
  const v = await loadVersionOr404(idParam(req));
  const piece = await loadPieceOr404(v.piece_id);
  if (!(await canWorkPiece(req, piece))) {
    throw forbidden('marking a version sent is for the folder\'s editors — or the piece\'s own owner');
  }
  if (v.sent_at) {
    return res.json({ ...dbToContentVersion(v), already: true });
  }
  const r = await pool.query(
    `UPDATE content_versions SET sent_at=NOW(), sent_by=$1 WHERE id=$2 RETURNING *`,
    [req.actor, v.id]);
  await logActivity(pool, { projectId: piece.project_id, showId: piece.show_id, actor: req.actor,
    action: 'content.send', detail: `${piece.name} · v${v.version_n} sent to client`, accent: true });
  res.json({ ...dbToContentVersion(r.rows[0]), already: false });
}));

// Record the client's feedback on a round. Overwriting is allowed (feedback
// arrives in pieces and gets consolidated); the stamp tracks the last edit.
router.put('/content/versions/:id/feedback', asyncH(async (req, res) => {
  const v = await loadVersionOr404(idParam(req));
  const piece = await loadPieceOr404(v.piece_id);
  if (!(await canWorkPiece(req, piece))) {
    throw forbidden('recording feedback is for the folder\'s editors — or the piece\'s own owner');
  }
  const text = String(pick(req.body || {}, 'feedback') || '').trim();
  if (!text) throw badRequest('feedback needs words — what did they say?');
  const r = await pool.query(
    `UPDATE content_versions SET feedback=$1, feedback_by=$2, feedback_at=NOW()
     WHERE id=$3 RETURNING *`, [text, req.actor, v.id]);
  await logActivity(pool, { projectId: piece.project_id, showId: piece.show_id, actor: req.actor,
    action: 'content.feedback', detail: `${piece.name} · v${v.version_n}: ${text.slice(0, 80)}` });
  res.json(dbToContentVersion(r.rows[0]));
}));

// ── spec seeding: "Add pieces from spec" ────────────────────────────────────
// GET proposes — one candidate piece per media-server zone of the bound
// .e360, stack-aware pixel sizes derived by the tool's own math
// (lib/speccheck contentZonesFromDocs). No bound spec, or a spec with no
// zones, answers honestly instead of proposing nothing silently.
router.get('/shows/:id/content-seed', asyncH(async (req, res) => {
  const show = await loadShowOr404(idParam(req));
  const { docs } = await boundSpecDocs(show.id);
  res.json(contentZonesFromDocs(docs));
}));

// POST creates the CHOSEN zones — `picks` is zone indexes from the GET above,
// and the server RE-DERIVES every number from the bound spec so a pixel size
// can never arrive client-typed wearing the spec's authority. pm floor +
// folder ownership, same as any other create.
router.post('/shows/:id/content-seed', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShowOr404(idParam(req));
  await assertCanEditShow(req, show);
  const picks = pick(req.body || {}, 'picks');
  if (!Array.isArray(picks) || !picks.length) {
    throw badRequest('picks required — the zone indexes a human chose in the picker');
  }
  const { docs } = await boundSpecDocs(show.id);
  const seed = contentZonesFromDocs(docs);
  if (!seed.available) throw badRequest(seed.reason);

  const chosen = [];
  for (const raw of picks) {
    const i = intOrNull(raw);
    const z = seed.zones.find((x) => x.index === i);
    if (!z) throw badRequest(`pick ${raw} names no zone on the bound spec — nothing was created`);
    chosen.push(z);
  }

  const created = await withTx(async (c) => {
    const out = [];
    for (const z of chosen) {
      const r = await c.query(
        `INSERT INTO content_pieces (show_id, project_id, name, surface, kind, spec_w, spec_h,
           duration_spec, source, status, created_by)
         VALUES ($1,$2,$3,$4,'video',$5,$6,$7,'e360','needed',$8) RETURNING *`,
        [show.id, show.project_id, z.name, z.name, z.spec_w, z.spec_h,
         seed.duration_spec || '', req.actor]);
      out.push(r.rows[0]);
    }
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'content.seed',
      detail: `${out.length} piece${out.length === 1 ? '' : 's'} from the bound content spec — ` +
              out.map((p) => p.name).join(', '), accent: true });
    return out;
  });
  res.json({ created: await hydratePieces(created) });
}));

module.exports = router;
