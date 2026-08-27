// ════════════════════════════════════════════════════════════════════════════
// routes/proposals.js — confirm / reject.  SESSION AUTH ONLY.
// ────────────────────────────────────────────────────────────────────────────
// AGENT_API §6: "file, don't fire" is meaningless if the agent that proposed
// can also confirm. These routes live on the HUMAN surface; an agent key is
// refused 403 by `requireAuth` itself, which rejects x-agent-key outright.
//
// Confirm applies the proposal in ONE withTx: materializes the row(s), moves
// any quarantined bytes to the canonical NAS path, copies the provenance onto
// the created row(s) with confirmed_by/confirmed_at appended, and logs
// agent.proposal.confirm. An already-resolved proposal returns 409.
//
// Punch item 24 — REJECT SEMANTICS. Reject RESOLVES the proposals row. It never
// materializes rows in order to delete them: nothing that costs money or work
// (expenses, steps, projects, shows, jobs) is created until confirm. The one
// row a `document` proposal creates up front is its quarantined `files` row —
// the byte-upload and NAS-thumbnailer contracts both need a stable file id
// (punch 46) — and reject marks that row `status='rejected'` and removes the
// quarantined bytes. There is no DELETE of a DB row anywhere in this path.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadProject, loadShow, loadJob, mintTempJobNumber } = require('../lib/db');
const { requireAuth, roleRank, canEditProject } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, conflict, idParam, limitOf } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { notifyTargets } = require('../lib/mentions');
const { storage, buildNasPath, buildQuarantinePath, thumbPathFor } = require('../lib/storage');
const { dbToProposal, pick } = require('../lib/mappers');
const { BUDGET_CATS, PROJECT_TYPES, STAGES, DEAL_TYPES, isTempJobNumber, oneOf, money,
        intOrNull, slug, todayISO, addDays } = require('../lib/enums');
const core = require('./core');

const router = express.Router();
router.use(requireAuth);

// The human-surface listing (the Agent inbox's other half is /me/inbox).
router.get('/proposals', asyncH(async (req, res) => {
  const me = req.session.username;
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
  if (String(req.query.user) === 'all') {
    if (roleRank(req.session.role) < 3) throw forbidden("Requires 'manager' role or higher");
  } else {
    params.push(me); params.push('agent:' + me);
    where.push(`(assigned_to=$${params.length - 1} OR proposed_by=$${params.length})`);
  }
  if (req.query.status) add('status=$?', req.query.status);
  if (req.query.kind) add('kind=$?', req.query.kind);
  if (req.query.showId) add('show_id=$?', parseInt(req.query.showId, 10));
  params.push(limitOf(req, 50, 200));
  const r = await pool.query(
    `SELECT * FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  res.json(r.rows.map((row) => dbToProposal(row, { full: true })));
}));

router.get('/proposals/:id', asyncH(async (req, res) => {
  const p = (await pool.query('SELECT * FROM proposals WHERE id=$1', [idParam(req)])).rows[0];
  if (!p) throw notFound('Proposal not found');
  if (roleRank(req.session.role) < 3 && p.assigned_to !== req.session.username
      && p.proposed_by !== 'agent:' + req.session.username) {
    throw forbidden('Not your proposal');
  }
  res.json(dbToProposal(p, { full: true }));
}));

// The front-end's confirmDoc(fileId)/rejectDoc(fileId) hold a FILE id; the
// server resolves a PROPOSAL. This is the one lookup that makes that swap
// mechanical instead of a refactor.
router.get('/files/:id/proposal', asyncH(async (req, res) => {
  const fileId = idParam(req);
  const r = await pool.query(
    `SELECT * FROM proposals
     WHERE created_rows -> 'files' @> to_jsonb($1::int)
     ORDER BY id DESC LIMIT 1`, [fileId]);
  if (!r.rows.length) throw notFound('No proposal is attached to that file');
  res.json(dbToProposal(r.rows[0], { full: true }));
}));

// Who may resolve a proposal: the person it is assigned to, the owner of the
// target project, or manager+.
async function canResolve(session, proposal) {
  if (roleRank(session.role) >= 3) return true;
  if (proposal.assigned_to === session.username) return true;
  if (proposal.project_id) {
    const p = await loadProject(proposal.project_id);
    if (canEditProject(session, p)) return true;
  }
  return false;
}

// Provenance carried onto every created row, with the confirmation appended.
function confirmedProvenance(provenance, username) {
  return { ...(provenance || {}), confirmed_by: username, confirmed_at: new Date().toISOString() };
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIRM
// ════════════════════════════════════════════════════════════════════════════
router.post('/proposals/:id/confirm', asyncH(async (req, res) => {
  const id = idParam(req);
  const proposal = (await pool.query('SELECT * FROM proposals WHERE id=$1', [id])).rows[0];
  if (!proposal) throw notFound('Proposal not found');
  if (proposal.status !== 'pending') {
    throw conflict(`This proposal is already ${proposal.status}`, { status: proposal.status });
  }
  if (!(await canResolve(req.session, proposal))) throw forbidden('Not yours to confirm');

  const overrides = pick(req.body, 'overrides') || {};
  // `overrides` may change the target and scalar fields — NEVER the kind.
  if (overrides.kind) throw badRequest('overrides may not change a proposal\'s kind');

  const result = await withTx(async (c) => {
    switch (proposal.kind) {
      case 'document':      return confirmDocument(c, proposal, overrides, req.session);
      case 'tasks_batch':   return confirmTasksBatch(c, proposal, overrides, req.session);
      case 'project':       return confirmProject(c, proposal, overrides, req.session);
      case 'expense':       return confirmExpense(c, proposal, overrides, req.session);
      default:
        throw badRequest(`Cannot confirm a proposal of kind '${proposal.kind}'`);
    }
  });

  // Byte moves happen AFTER the transaction commits: a NAS that is unreachable
  // must not roll back a decision a human already made. A failed move leaves
  // the record correct and the bytes findable in quarantine, and says so.
  let moved = null;
  if (result.moveBytes) {
    try {
      moved = await storage.move(result.moveBytes.from, result.moveBytes.to);
      if (result.moveBytes.thumbFrom) {
        await storage.move(result.moveBytes.thumbFrom, result.moveBytes.thumbTo);
      }
    } catch (e) {
      moved = { ok: false, reason: e.message };
    }
  }

  // Confirming somebody's agent proposal is a decision other people may be
  // waiting on — the proposer especially. Anchored on the target show when
  // there is one, else the project.
  // A `project` proposal has no target until confirm creates one, so fall back
  // to the rows we just made rather than anchoring on a null id.
  const madeShow = (result.created.shows || [])[0] || null;
  const madeProject = (result.created.projects || [])[0] || null;
  const anchorShow = proposal.show_id || madeShow;
  const anchorProject = proposal.project_id || madeProject;
  const notified = (anchorShow || anchorProject)
    ? await withTx(async (c) => notifyTargets(c, {
        body: req.body, actor: req.session.username,
        anchorType: anchorShow ? 'show' : 'project',
        anchorId: anchorShow || anchorProject,
        projectId: anchorProject, showId: anchorShow,
        summary: `confirmed a proposed ${proposal.kind} from ${proposal.proposed_by} —`
      }))
    : [];

  res.json({
    ok: true, proposalId: id, status: 'confirmed',
    created: result.created, bytesMoved: moved, notified
  });
}));

// ── document ────────────────────────────────────────────────────────────────
async function confirmDocument(c, proposal, overrides, session) {
  const files = (proposal.created_rows && proposal.created_rows.files) || [];
  const fileId = files[0];
  const file = fileId
    ? (await c.query('SELECT * FROM files WHERE id=$1', [fileId])).rows[0] : null;
  if (!file) throw notFound('The proposed document row is gone');

  const showId = intOrNull(overrides.showId != null ? overrides.showId : proposal.show_id);
  const show = showId ? await loadShow(showId, c) : null;
  const projectId = intOrNull(overrides.projectId != null ? overrides.projectId
    : (show ? show.project_id : proposal.project_id));
  const project = await loadProject(projectId, c);
  if (!project) throw badRequest('A confirmed document needs a project or show — set one in overrides');

  let jobId = overrides.jobId !== undefined ? intOrNull(overrides.jobId) : file.job_id;
  if (jobId && !(await loadJob(jobId, c))) throw notFound('Job not found');
  if (!jobId && show) jobId = show.default_job_id;

  const resolved = (proposal.payload && proposal.payload._resolved) || {};
  const amount = overrides.amount !== undefined ? money(overrides.amount, null)
    : (file.amount != null ? Number(file.amount) : null);
  const vendor = overrides.vendor !== undefined ? overrides.vendor : file.vendor;

  const from = file.nas_path;
  const to = buildNasPath(project, show, { kind: file.kind, name: file.name, ext: file.ext });
  const prov = confirmedProvenance(proposal.provenance, session.username);

  await c.query(
    `UPDATE files SET project_id=$1, show_id=$2, job_id=$3, amount=$4, vendor=$5,
       nas_path=$6, status='filed', meta='', provenance=$7,
       thumb_path = CASE WHEN thumb_path IS NULL THEN NULL ELSE $8 END
     WHERE id=$9`,
    [show ? null : project.id, show ? show.id : null, jobId, amount, vendor, to,
     JSON.stringify(prov), thumbPathFor(to), file.id]);

  // The expense is created HERE, on confirm — never on propose.
  let expenseId = null;
  if (amount != null && show) {
    const cat = BUDGET_CATS.includes(overrides.category || resolved.category)
      ? (overrides.category || resolved.category) : 'misc';
    const e = await c.query(
      `INSERT INTO expenses (show_id, project_id, job_id, budget_line_category, category, vendor,
         amount, txn_date, status, file_id, by, memo, evidence_ref, match_confidence,
         provenance, source_ref)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'filed',$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [show.id, project.id, jobId, cat, vendor || '', amount,
       file.doc_date || todayISO(), file.id, proposal.proposed_by, '', String(file.id),
       proposal.confidence, JSON.stringify(prov), prov.source_ref || null]);
    expenseId = e.rows[0].id;
  }

  const created = { files: [file.id], expenses: expenseId ? [expenseId] : [] };
  await resolveProposal(c, proposal, 'confirmed', session, created, null);
  await logActivity(c, {
    projectId: project.id, showId: show ? show.id : null, actor: session.username,
    action: 'agent.proposal.confirm', accent: true, provenance: prov,
    detail: `confirmed ${file.kind}: ${file.name}`
  });
  return { created, moveBytes: from !== to
    ? { from, to, thumbFrom: file.thumb_path || null, thumbTo: thumbPathFor(to) } : null };
}

// ── tasks_batch ─────────────────────────────────────────────────────────────
async function confirmTasksBatch(c, proposal, overrides, session) {
  const showId = intOrNull(overrides.showId != null ? overrides.showId : proposal.show_id);
  const show = await loadShow(showId, c);
  if (!show) throw badRequest('A confirmed task batch needs a show — set showId in overrides');
  const prepared = (proposal.payload && proposal.payload._prepared) || [];
  const prov = confirmedProvenance(proposal.provenance, session.username);

  let sort = (await c.query(
    'SELECT COALESCE(MAX(sort_order),0) AS m FROM steps WHERE show_id=$1', [show.id])).rows[0].m;
  const stepIds = [];
  for (const s of prepared) {
    // Re-derive the due date against THIS show — an override may have moved
    // the batch to a show with a different event date.
    const due = s.dueDate || (s.off != null && show.event_date ? addDays(show.event_date, s.off) : '');
    const r = await c.query(
      `INSERT INTO steps (show_id, lane, title, status, owner, due_date, due_offset_days,
         evidence_type, auto_source, sort_order, notes, provenance, source_ref)
       VALUES ($1,$2,$3,'todo',$4,$5,$6,'none','none',$7,$8,$9,$10) RETURNING id`,
      [show.id, s.lane, s.title, s.owner || '', due, s.off, ++sort, s.notes || '',
       JSON.stringify(prov), prov.source_ref || null]);
    stepIds.push(r.rows[0].id);
  }
  const created = { steps: stepIds };
  await resolveProposal(c, proposal, 'confirmed', session, created, null);
  await logActivity(c, { projectId: show.project_id, showId: show.id, actor: session.username,
    action: 'agent.proposal.confirm', accent: true, provenance: prov,
    detail: `confirmed ${stepIds.length} derived task(s)` });
  return { created, moveBytes: null };
}

// ── project (folder + show + job, in one transaction) ───────────────────────
async function confirmProject(c, proposal, overrides, session) {
  if (roleRank(session.role) < 2) throw forbidden("Requires 'pm' role or higher");
  const payload = proposal.payload || {};
  const p = { ...(payload.project || {}), ...(overrides.project || {}) };
  const s = { ...(payload.show || {}), ...(overrides.show || {}) };
  const j = { ...(payload.job || {}), ...(overrides.job || {}) };
  const prov = confirmedProvenance(proposal.provenance, session.username);
  if (!p.name) throw badRequest('project.name is missing from the proposal');

  const proj = (await c.query(
    `INSERT INTO projects (name, slug, client, type, stage, owner, description, provenance, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [p.name, slug(p.name), p.client || '', oneOf(p.type, PROJECT_TYPES, 'led'),
     oneOf(p.stage, STAGES, 'lead'), p.owner || session.username, p.description || '',
     JSON.stringify(prov), prov.source_ref || null])).rows[0];

  // qbJobNumber is entered HERE, by a human, on confirm — never by the agent.
  // POLISH_LIST #5: if the confirming human has not got the QuickBooks number
  // yet (the usual case — the agent proposed this off an email an hour ago),
  // the job opens on a TEMP placeholder and Candice is chased for the real one
  // through the finance exceptions list. The agent-proposed folder is never
  // blocked on accounting.
  const askedQb = j.qbJobNumber || j.qb_job_number || '';
  const qb = askedQb || await mintTempJobNumber(c);
  const job = (await c.query(
    `INSERT INTO jobs (project_id, name, qb_job_number, qb_number_status, client, deal_type,
                       description, contract_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [proj.id, j.name || p.name, qb, isTempJobNumber(qb) ? 'temp' : 'confirmed',
     j.client || p.client || '', oneOf(j.dealType || j.deal_type, DEAL_TYPES, 'rental'),
     j.description || '', money(j.contractValue || j.contract_value, 0)])).rows[0];

  let show = null;
  if (s.name || s.venue || s.eventDate || s.event_date) {
    show = (await c.query(
      `INSERT INTO shows (project_id, name, slug, venue, city, load_in_date, event_date, strike_date,
         stage, rag, owner, default_job_id, provenance, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'idle',$10,$11,$12,$13) RETURNING *`,
      [proj.id, s.name || p.name, slug(s.name || p.name), s.venue || '', s.city || '',
       s.loadInDate || s.load_in_date || '', s.eventDate || s.event_date || '',
       s.strikeDate || s.strike_date || '', oneOf(s.stage, STAGES, 'lead'),
       proj.owner, job.id, JSON.stringify(prov), prov.source_ref || null])).rows[0];
  }

  let instantiated = 0;
  const wantTemplate = overrides.instantiateTemplate !== undefined
    ? overrides.instantiateTemplate : payload.instantiateTemplate;
  if (wantTemplate && show) {
    const t = await c.query(
      'SELECT id FROM event_type_templates WHERE event_type=$1 ORDER BY id LIMIT 1', [proj.type]);
    if (t.rows.length) {
      instantiated = await core.instantiateTemplateOnShow(c, t.rows[0].id, show, proj);
    }
  }

  const created = { projects: [proj.id], jobs: [job.id],
                    shows: show ? [show.id] : [], steps_created: instantiated };
  await resolveProposal(c, proposal, 'confirmed', session, created, proj.id);
  await logActivity(c, { projectId: proj.id, showId: show ? show.id : null, actor: session.username,
    action: 'agent.proposal.confirm', accent: true, provenance: prov,
    detail: `confirmed the folder “${proj.name}”${instantiated ? ` (+${instantiated} steps)` : ''}` });
  return { created, moveBytes: null };
}

// ── expense ─────────────────────────────────────────────────────────────────
async function confirmExpense(c, proposal, overrides, session) {
  const payload = { ...(proposal.payload || {}), ...overrides };
  const showId = intOrNull(overrides.showId != null ? overrides.showId : proposal.show_id);
  const show = showId ? await loadShow(showId, c) : null;
  if (!show) throw badRequest('A confirmed cost needs a show — set showId in overrides');
  const prov = confirmedProvenance(proposal.provenance, session.username);
  const cat = BUDGET_CATS.includes(payload.category) ? payload.category : 'misc';
  const jobId = overrides.jobId !== undefined ? intOrNull(overrides.jobId)
    : (proposal.job_id || show.default_job_id);
  const e = await c.query(
    `INSERT INTO expenses (show_id, project_id, job_id, budget_line_category, category, vendor,
       amount, txn_date, status, by, memo, provenance, source_ref, match_confidence)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'filed',$8,$9,$10,$11,$12) RETURNING id`,
    [show.id, show.project_id, jobId, cat, payload.vendor || '', money(payload.amount, 0),
     payload.txnDate || payload.txn_date || todayISO(), proposal.proposed_by, payload.memo || '',
     JSON.stringify(prov), prov.source_ref || null, proposal.confidence]);
  const created = { expenses: [e.rows[0].id] };
  await resolveProposal(c, proposal, 'confirmed', session, created, null);
  await logActivity(c, { projectId: show.project_id, showId: show.id, actor: session.username,
    action: 'agent.proposal.confirm', accent: true, provenance: prov,
    detail: `confirmed a cost: ${payload.vendor || ''}` });
  return { created, moveBytes: null };
}

async function resolveProposal(c, proposal, status, session, createdRows, projectId) {
  await c.query(
    `UPDATE proposals SET status=$1, resolved_by=$2, resolved_at=NOW(), resolve_reason=$3,
       created_rows=$4, project_id=COALESCE($5, project_id) WHERE id=$6`,
    [status, session.username, null, createdRows ? JSON.stringify(createdRows) : null,
     projectId || null, proposal.id]);
}

// ════════════════════════════════════════════════════════════════════════════
// REJECT
// ════════════════════════════════════════════════════════════════════════════
router.post('/proposals/:id/reject', asyncH(async (req, res) => {
  const id = idParam(req);
  const proposal = (await pool.query('SELECT * FROM proposals WHERE id=$1', [id])).rows[0];
  if (!proposal) throw notFound('Proposal not found');
  if (proposal.status !== 'pending') {
    throw conflict(`This proposal is already ${proposal.status}`, { status: proposal.status });
  }
  if (!(await canResolve(req.session, proposal))) throw forbidden('Not yours to reject');
  const reason = String(pick(req.body, 'reason') || '').slice(0, 500);

  const quarantined = [];
  await withTx(async (c) => {
    // Resolve the proposal. Nothing is deleted; a document's quarantined row is
    // MARKED rejected so the audit still shows what the agent tried to file.
    const files = (proposal.created_rows && proposal.created_rows.files) || [];
    for (const fid of files) {
      const f = (await c.query(
        `UPDATE files SET status='rejected', meta=$2 WHERE id=$1 RETURNING nas_path, thumb_path`,
        [fid, reason ? 'rejected: ' + reason : 'rejected'])).rows[0];
      if (f) quarantined.push(f);
    }
    await c.query(
      `UPDATE proposals SET status='rejected', resolved_by=$1, resolved_at=NOW(), resolve_reason=$2
       WHERE id=$3`, [req.session.username, reason || null, proposal.id]);
    await logActivity(c, {
      projectId: proposal.project_id, showId: proposal.show_id, actor: req.session.username,
      action: 'agent.proposal.reject', provenance: proposal.provenance,
      detail: `rejected a proposed ${proposal.kind}${reason ? ' — ' + reason : ''}`
    });
  });

  // A rejected proposal must leave NO TRACE on the NAS for someone to find
  // later. The DB row stays (audit); the quarantined bytes go.
  let purged = 0;
  for (const f of quarantined) {
    try {
      if (f.nas_path) { await storage.remove(f.nas_path); purged += 1; }
      if (f.thumb_path) await storage.remove(f.thumb_path);
    } catch (_) { /* best effort — the record is already correct */ }
  }
  res.json({ ok: true, proposalId: id, status: 'rejected', bytesPurged: purged });
}));

module.exports = router;
