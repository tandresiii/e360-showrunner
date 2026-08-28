// ════════════════════════════════════════════════════════════════════════════
// routes/notes.js — anchored notes, @mentions, and the personal inbox
// ────────────────────────────────────────────────────────────────────────────
// The decided model (TEAM_FEEDBACK): threads live ON things, never free-
// floating. AGENT_API §5 is the contract these shapes track.
//
// Punch coverage:
//   31. notes {anchor_type/anchor_id, author (accepts 'agent:<u>'), body,
//       created_at, edited_at, mentions[] denormalised, parent_id, provenance}.
//   32. note_reads (read state) is SEPARATE from note_mentions (the fact).
//   33. ONE level of replies: replying to a reply re-anchors to the thread ROOT.
//   34. Anchor whitelist: project·show·step·file·job·expense·po.
//   35. GET /me/inbox + POST /me/inbox/read; the badge = unread + my agent's
//       pending proposals.
//   36. Notes write an activity row whose detail is the MENTION LIST — NEVER
//       the body. A note can say anything; the audit feed is not the place for
//       it. Job- and project-anchored notes also write a project-scoped row so
//       the folder feed sees them.
//   37. Edit is AUTHOR-ONLY, sets edited_at, re-parses mentions server-side —
//       and agent-authored notes are IMMUTABLE to humans (an agent's statement
//       of what it did is a record, not a draft).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadShow, loadRow } = require('../lib/db');
// canApproveRecap is THE closeout predicate (lib/auth.js). The bell badge reads
// it rather than re-expressing it in SQL — see /me/inbox/count (hardening 9).
const { requireAuth, canApproveRecap } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf } = require('../lib/http');
const { logActivity, actorUser, isAgentActor } = require('../lib/activity');
const { parseMentions, resolveUsernames, recordMentions, markRead } = require('../lib/mentions');
const notify = require('../lib/notify');
const { pick, has, dbToNote } = require('../lib/mappers');
const { NOTE_ANCHORS, intOrNull } = require('../lib/enums');

const router = express.Router();
router.use(requireAuth);

const MAX_BODY = 8000;

// 34. resolve an anchor to its owning project/show so the note joins the right
// cascades and the right activity feed. Also proves the anchor EXISTS — you
// cannot leave a note on a row that isn't there.
async function resolveAnchor(anchorType, anchorId, q = pool) {
  if (!NOTE_ANCHORS.includes(anchorType)) throw badRequest(`unknown note anchor "${anchorType}"`);
  const id = parseInt(anchorId, 10);
  if (!Number.isFinite(id) || id <= 0) throw badRequest('anchor_id required');

  const one = async (table) => loadRow(table, id, q);
  switch (anchorType) {
    case 'project': {
      const p = await one('projects');
      if (!p) throw notFound('Project not found');
      return { projectId: p.id, showId: null, label: p.name, projectScoped: true };
    }
    case 'show': {
      const s = await one('shows');
      if (!s) throw notFound('Show not found');
      return { projectId: s.project_id, showId: s.id, label: s.name || s.venue };
    }
    case 'step': {
      const st = await one('steps');
      if (!st) throw notFound('Step not found');
      const s = st.show_id ? await loadShow(st.show_id, q) : null;
      return { projectId: s ? s.project_id : st.project_id, showId: st.show_id || null, label: st.title };
    }
    case 'file': {
      const f = await one('files');
      if (!f) throw notFound('File not found');
      const s = f.show_id ? await loadShow(f.show_id, q) : null;
      return { projectId: s ? s.project_id : f.project_id, showId: f.show_id || null, label: f.name };
    }
    case 'job': {
      const j = await one('jobs');
      if (!j) throw notFound('Job not found');
      return { projectId: j.project_id, showId: null,
               label: 'Job ' + (j.qb_job_number || j.name), projectScoped: true };
    }
    case 'expense': {
      const e = await one('expenses');
      if (!e) throw notFound('Expense not found');
      const s = e.show_id ? await loadShow(e.show_id, q) : null;
      return { projectId: s ? s.project_id : e.project_id, showId: e.show_id || null, label: e.vendor };
    }
    case 'po': {
      const p = await one('purchase_orders');
      if (!p) throw notFound('PO not found');
      return { projectId: p.project_id, showId: null, poId: p.id,
               label: `${p.po_number} · ${p.vendor}` };
    }
    default:
      throw badRequest(`unknown note anchor "${anchorType}"`);
  }
}

// 33. ONE level, always. Replying to a reply re-anchors onto its thread root.
async function resolveParent(parentId, q = pool) {
  if (!parentId) return null;
  const p = await loadRow('notes', parentId, q);
  if (!p) throw notFound(`note ${parentId} not found`);
  return p.parent_id ? p.parent_id : p.id;
}

// ── read ────────────────────────────────────────────────────────────────────
// api.listNotes(anchorType, anchorId) — chronological roots, each with replies.
router.get('/notes', asyncH(async (req, res) => {
  const anchorType = pick(req.query, 'anchor_type', pick(req.query, 'target_kind'));
  const anchorId = intOrNull(pick(req.query, 'anchor_id', pick(req.query, 'target_id')));
  if (!anchorType) throw badRequest('anchor_type required');
  if (!NOTE_ANCHORS.includes(anchorType)) throw badRequest(`unknown note anchor "${anchorType}"`);
  if (!anchorId) throw badRequest('anchor_id required');

  const r = await pool.query(
    `SELECT * FROM notes WHERE anchor_type=$1 AND anchor_id=$2 ORDER BY created_at ASC, id ASC`,
    [anchorType, anchorId]);
  const reads = await pool.query(
    `SELECT note_id FROM note_reads WHERE username=$1 AND note_id = ANY($2::int[])`,
    [req.session.username, r.rows.map((x) => x.id)]);
  const readSet = new Set(reads.rows.map((x) => x.note_id));

  const roots = [];
  const byParent = new Map();
  for (const n of r.rows) {
    if (n.parent_id) {
      if (!byParent.has(n.parent_id)) byParent.set(n.parent_id, []);
      byParent.get(n.parent_id).push(n);
    } else roots.push(n);
  }
  res.json(roots.map((root) => ({
    root: dbToNote(root, { read: readSet.has(root.id) }),
    replies: (byParent.get(root.id) || []).map((n) => dbToNote(n, { read: readSet.has(n.id) }))
  })));
}));

router.get('/notes/:id', asyncH(async (req, res) => {
  const n = await loadRow('notes', idParam(req));
  if (!n) throw notFound();
  res.json(dbToNote(n));
}));

// A cheap count for the badge on a tab (never the bodies).
router.get('/notes/count/:anchorType/:anchorId', asyncH(async (req, res) => {
  const t = String(req.params.anchorType);
  if (!NOTE_ANCHORS.includes(t)) throw badRequest(`unknown note anchor "${t}"`);
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notes WHERE anchor_type=$1 AND anchor_id=$2',
    [t, parseInt(req.params.anchorId, 10) || 0]);
  res.json({ count: r.rows[0].n });
}));

// ── write ───────────────────────────────────────────────────────────────────
// Shared by this route and POST /api/agent/notes so a note written by a person
// and a note written by their agent are the same row, differing only in `author`.
async function createNote(c, {
  anchorType, anchorId, body, author, parentId = null, provenance = null, sourceRef = null,
  extraMentions = []
}) {
  const text = String(body || '').trim();
  if (!text) throw badRequest('a note needs a body');
  if (text.length > MAX_BODY) throw badRequest(`a note is capped at ${MAX_BODY} characters`);

  const anchor = await resolveAnchor(anchorType, anchorId, c);
  const parent = await resolveParent(parentId, c);

  // 37/31. mentions are parsed HERE, from the body, every time. A client can
  // neither invent one nor suppress one.
  const parsed = await parseMentions(text, c);
  const merged = [...new Set([...parsed, ...extraMentions])];
  if (extraMentions.length) {
    const { unknown } = await resolveUsernames(extraMentions, c);
    if (unknown.length) throw badRequest(`Unknown user '${unknown[0]}' in mentions`);
  }

  const ins = await c.query(
    `INSERT INTO notes (anchor_type, anchor_id, project_id, show_id, author, body, parent_id,
       mentions, provenance, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [anchorType, anchorId, anchor.projectId || null, anchor.showId || null, author, text, parent,
     merged, provenance ? JSON.stringify(provenance) : null, sourceRef]);
  const note = ins.rows[0];

  await recordMentions(c, note.id, merged);
  // your own note is read the moment you write it (an agent's note is read by
  // the person it acts as — it IS them)
  await markRead(c, note.id, actorUser(author));

  // 36. the activity row carries the MENTION LIST, never the body.
  const detail = merged.length ? '@ ' + merged.join(', ') : null;
  const verb = parent ? 'replied to a note on' : 'left a note on';
  await logActivity(c, {
    projectId: anchor.projectId || null,
    showId: anchor.showId || null,
    poId: anchor.poId || null,
    actor: author, action: 'note.add',
    detail: `${verb} ${anchor.label || anchorType}${detail ? ' · ' + detail : ''}`
  });
  // 36. job/project-anchored notes ALSO write a project-scoped row so the
  // folder feed sees them (they have no show to hang on).
  if (anchor.projectScoped && anchor.projectId) {
    await logActivity(c, { projectId: anchor.projectId, actor: author, action: 'note.add.project',
      detail: anchor.label || '' });
  }
  // F3. An @mention is a REAL delivery, so it mirrors into the outbox — same
  // transaction, immediate by default (Tom's rule). The BODY travels because a
  // mention without its sentence is useless; note that this is the person's own
  // mail, not the audit trail, which still carries only the mention list (36).
  await notify.enqueueMany(c, merged.filter((u) => u.toLowerCase() !== actorUser(author).toLowerCase()), {
    kind: 'mention', actor: author,
    subject: `${actorUser(author)} mentioned you on ${anchor.label || anchorType}`,
    body: text, noteId: note.id,
    projectId: anchor.projectId || null, showId: anchor.showId || null,
    link: anchor.showId ? '/#show/' + anchor.showId
      : (anchor.projectId ? '/#folder/' + anchor.projectId : '')
  });
  return note;
}

router.post('/notes', asyncH(async (req, res) => {
  const b = req.body || {};
  const anchorType = pick(b, 'anchor_type', pick(b, 'target_kind'));
  const anchorId = pick(b, 'anchor_id', pick(b, 'target_id'));
  const note = await withTx(async (c) => createNote(c, {
    anchorType, anchorId,
    body: pick(b, 'body'),
    author: req.session.username,               // humans post as themselves
    parentId: intOrNull(pick(b, 'parent_id')),
    extraMentions: Array.isArray(pick(b, 'mentions')) ? pick(b, 'mentions') : []
  }));
  res.json(dbToNote(note, { notified: note.mentions }));
}));

// 37. author-only; agent-authored notes are immutable to humans.
router.put('/notes/:id', asyncH(async (req, res) => {
  const cur = await loadRow('notes', idParam(req));
  if (!cur) throw notFound();
  if (isAgentActor(cur.author)) {
    throw forbidden('An agent-authored note is a record of what it did — it cannot be edited');
  }
  if (cur.author !== req.session.username) throw forbidden('only the author can edit a note');
  const text = String(pick(req.body, 'body', req.body) || '').trim();
  if (!text) throw badRequest('a note needs a body');
  if (text.length > MAX_BODY) throw badRequest(`a note is capped at ${MAX_BODY} characters`);

  const note = await withTx(async (c) => {
    const mentions = await parseMentions(text, c);     // re-parsed on every edit
    const r = await c.query(
      'UPDATE notes SET body=$1, mentions=$2, edited_at=NOW() WHERE id=$3 RETURNING *',
      [text, mentions, cur.id]);
    await recordMentions(c, cur.id, mentions);
    return r.rows[0];
  });
  res.json(dbToNote(note));
}));

// Deleting a note is an author-or-admin act, and it takes its mention/read rows
// with it (there is no orphan story for a note that no longer exists).
router.delete('/notes/:id', asyncH(async (req, res) => {
  const cur = await loadRow('notes', idParam(req));
  if (!cur) throw notFound();
  if (cur.author !== req.session.username && req.session.role !== 'admin') {
    throw forbidden('only the author or an admin can delete a note');
  }
  await withTx(async (c) => {
    await c.query('DELETE FROM note_reads WHERE note_id=$1', [cur.id]);
    await c.query('DELETE FROM note_mentions WHERE note_id=$1', [cur.id]);
    // a deleted root takes its replies with it — a headless reply reads as noise
    const kids = await c.query('SELECT id FROM notes WHERE parent_id=$1', [cur.id]);
    for (const k of kids.rows) {
      await c.query('DELETE FROM note_reads WHERE note_id=$1', [k.id]);
      await c.query('DELETE FROM note_mentions WHERE note_id=$1', [k.id]);
    }
    await c.query('DELETE FROM notes WHERE id=$1 OR parent_id=$1', [cur.id]);
  });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// 35. THE PERSONAL INBOX
// ════════════════════════════════════════════════════════════════════════════
// Mentions of me + replies to my notes + later notes on threads I wrote in.
// My own notes (and my agent's — it acts as me) never notify me.
async function inboxFor(username, q = pool, limit = 100) {
  const r = await q.query(
    `WITH mine AS (
       SELECT COALESCE(parent_id, id) AS root_id, id, author FROM notes
       WHERE author = $1 OR author = 'agent:' || $1
     )
     SELECT n.*,
       CASE
         WHEN $1 = ANY(n.mentions) THEN 'mention'
         WHEN n.parent_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM notes r WHERE r.id = n.parent_id
             AND (r.author = $1 OR r.author = 'agent:' || $1)) THEN 'reply'
         ELSE 'thread'
       END AS reason,
       (nr.note_id IS NOT NULL) AS read
     FROM notes n
     LEFT JOIN note_reads nr ON nr.note_id = n.id AND nr.username = $1
     WHERE n.author <> $1 AND n.author <> 'agent:' || $1
       AND ( $1 = ANY(n.mentions)
             OR (n.parent_id IS NOT NULL AND n.parent_id IN (SELECT root_id FROM mine)) )
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $2`, [username, limit]);
  return r.rows;
}

// AGENT_API §6: proposals whose agent acted AS this user — the person who
// confirms is the agent's user.
async function pendingProposalsFor(username, q = pool) {
  const r = await q.query(
    `SELECT * FROM proposals WHERE status='pending' AND (assigned_to=$1 OR proposed_by='agent:' || $1)
     ORDER BY created_at DESC, id DESC LIMIT 100`, [username]);
  return r.rows;
}

router.get('/me/inbox', asyncH(async (req, res) => {
  const me = req.session.username;
  const rows = await inboxFor(me, pool, limitOf(req, 100, 300));
  const proposals = await pendingProposalsFor(me);
  // hydrate each note's anchor label so the inbox row is readable without a
  // second round trip
  const items = [];
  for (const n of rows) {
    let label = null;
    try { label = (await resolveAnchor(n.anchor_type, n.anchor_id)).label; } catch { label = null; }
    items.push({
      note: dbToNote(n), reason: n.reason, read: !!n.read,
      anchor: { type: n.anchor_type, id: n.anchor_id, label,
                show_id: n.show_id, project_id: n.project_id }
    });
  }
  res.json({
    items,
    proposals: proposals.map((p) => ({
      id: p.id, kind: p.kind, status: p.status, proposed_by: p.proposed_by,
      show_id: p.show_id, project_id: p.project_id, confidence: p.confidence == null ? null : Number(p.confidence),
      created_at: p.created_at, payload: p.payload, provenance: p.provenance
    }))
  });
}));

// The bell badge: unread mentions/replies + my agent's pending proposals +
// draft recaps I am the one who can approve.
router.get('/me/inbox/count', asyncH(async (req, res) => {
  const me = req.session.username;
  const rows = await inboxFor(me);
  const unread = rows.filter((n) => !n.read).length;
  const proposals = (await pendingProposalsFor(me)).length;
  // HARDENING 9. This COUNT used to recompile canApproveRecap() as SQL —
  // `$2 OR s.owner = $1` with a hand-rolled ['admin','manager'] rank test — so
  // the badge and the list it opens were two implementations of one rule. They
  // disagreed in three ways: `s.owner = $1` is case-SENSITIVE where sameUser()
  // is not (an owner stored 'LFarkos' counted for nobody), the role list
  // duplicated ROLE_RANK, and the pm+ floor added in hardening 14 would only
  // ever have reached one of them. Now the rows come back and the ONE predicate
  // in lib/auth.js decides, exactly as GET /me/recaps-awaiting-review does.
  // The row cap matches that route's default so the two cannot disagree at the
  // boundary either.
  const draftRecaps = await pool.query(
    `SELECT s.owner AS s_owner FROM deliverables d JOIN shows s ON s.id = d.show_id
     WHERE d.kind='recap' AND d.status='draft'
     ORDER BY d.generated_at DESC, d.id DESC
     LIMIT 500`);
  const awaiting = draftRecaps.rows
    .filter((row) => canApproveRecap(req.session, { owner: row.s_owner })).length;
  res.json({ unread, proposals, recaps: awaiting, badge: unread + proposals + awaiting });
}));

router.post('/me/inbox/read', asyncH(async (req, res) => {
  const me = req.session.username;
  const b = req.body || {};
  const all = !!pick(b, 'all');
  const ids = Array.isArray(pick(b, 'ids')) ? pick(b, 'ids').map((n) => parseInt(n, 10)).filter(Boolean) : [];
  const targets = all ? (await inboxFor(me)).map((n) => n.id) : ids;
  if (!targets.length) return res.json({ ok: true, marked: 0 });
  await withTx(async (c) => {
    for (const id of targets) await markRead(c, id, me);
  });
  res.json({ ok: true, marked: targets.length });
}));

module.exports = router;
module.exports.createNote = createNote;
module.exports.resolveAnchor = resolveAnchor;
module.exports.inboxFor = inboxFor;
