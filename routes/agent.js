// ════════════════════════════════════════════════════════════════════════════
// routes/agent.js — the agent-facing API  (AGENT_API.md, implemented as written)
// ────────────────────────────────────────────────────────────────────────────
// Mounted at /api/agent ONLY. Every route here authenticates with a durable,
// hashed API key in `x-agent-key`; a key ACTS AS its user and inherits that
// user's role, read live from `users` on every request.
//
// §9 HARD GUARDRAILS, enforced by scope + ROUTE TOPOLOGY:
//   · No outbound send of any kind — no such endpoint exists here.
//   · No push-to-scheduler — that route lives on the human surface, so an
//     agent key gets 403 by topology, not by a check someone can forget.
//   · No DELETE verb is routed under /api/agent/* AT ALL.
//   · No user/role admin, no /api/keys — session-only.
//   · No confirming its own proposals — confirm/reject are session-only
//     (routes/proposals.js).
//   · No deliverables (punch 53) — a recap is client-facing; no agent path may
//     create, edit, approve or send one.
//   · v1 is APPEND-ONLY: no PUT of an existing step/file/expense. The single
//     PUT here is :id/content, which completes a create flow the same call
//     started (§3's metadata-first contract).
//
// Responses on this surface are camelCase, per the spec. (The human surface is
// snake_case, matching public/data.js — see lib/mappers.js for why.)
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadProject, loadShow, loadJob } = require('../lib/db');
const { requireAgentKey, requireScope, requireRole, getSession, agentRateLimit,
        roleRank, hasFinance } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { storage, buildNasPath, buildQuarantinePath, MAX_BYTES } = require('../lib/storage');
const { createNote } = require('./notes');
// PO numbering is the human pipeline's rule; the agent surface shares it rather
// than keeping a second copy (hardening 4).
const { insertPO } = require('./purchasing');
const {
  bandFor, assertBand, normalizeProvenance, matchCandidates,
  checkIdempotency, recordIdempotency, createProposal, assigneeFor
} = require('../lib/agent');
const { agentShow, agentProject, agentJob, agentStep, agentActivity, agentProposal,
        pick, dbToFile } = require('../lib/mappers');
const {
  FILE_KINDS, BUDGET_CATS, STEP_STATUSES, PROJECT_TYPES, STAGES, DEAL_TYPES,
  EVIDENCE_TYPES, NOTE_ANCHORS, SPEC_TYPES, FILE_ARTIFACTS,
  CHAIN_NODES: CHAIN_NODE_KEYS,
  oneOf, money, num, intOrNull, isISODate, addDays, todayISO
} = require('../lib/enums');
const { lanesForType } = require('../lib/seed');

const router = express.Router();

// Every route: key auth, then the §9 rate limits (120 writes/hour, 600 reads/
// hour, per key). GET /proposals additionally accepts a session — see below.
router.use(asyncH(async (req, res, next) => {
  // §6: the proposals READ endpoints accept a key OR a session.
  if (req.method === 'GET' && /^\/proposals(\/|$)/.test(req.path) && !req.headers['x-agent-key']) {
    const session = await getSession(req.headers['x-auth-token']);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    req.session = session; req.actor = session.username;
    return next();
  }
  return requireAgentKey(req, res, next);
}));
router.use(agentRateLimit);

// ── idempotency wrapper (§8) ────────────────────────────────────────────────
// `required` endpoints: documents, tasks:batch, projects, purchase-requests.
// Optional for notes.
function idempotent(endpoint, { required = true } = {}) {
  return asyncH(async (req, res, next) => {
    const key = req.headers['x-idempotency-key'];
    if (!key) {
      if (required) throw badRequest('x-idempotency-key required');
      return next();
    }
    if (String(key).length > 400) throw badRequest('x-idempotency-key is too long');
    const check = await checkIdempotency(
      { key, username: req.agent.username, endpoint, body: req.body });
    if (check.replay) {
      res.set('x-idempotent-replay', 'true');
      return res.json(check.response);          // the ORIGINAL body, verbatim
    }
    req.idem = { key, endpoint, hash: check.hash };
    // res.json is wrapped so every success path records itself without each
    // handler having to remember to.
    //
    // The ledger write is AWAITED BEFORE THE RESPONSE GOES OUT. It used to be
    // fire-and-forget, which left a real race: an agent that retries the
    // instant it gets its 200 could beat the INSERT and file the document
    // twice — precisely the failure idempotency exists to prevent. Agents
    // retry faster than people do, so this is not a theoretical window.
    // Holding the response until the row is committed costs one round trip and
    // makes the guarantee actually true. (Caught by the smoke, 2026-08-27.)
    const json = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode < 200 || res.statusCode >= 300) return json(payload);
      recordIdempotency({ key, username: req.agent.username, endpoint,
                          hash: check.hash, response: payload })
        .then(() => json(payload))
        .catch((e) => {
          // A ledger failure must not lose the write the caller just made —
          // answer anyway, loudly, and let the 409-on-different-body path stay
          // the backstop.
          console.error('[idempotency] record failed:', e.message);
          json(payload);
        });
      return res;
    };
    next();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// §1. WHOAMI — the agent's first call, so it knows what it may attempt
// ════════════════════════════════════════════════════════════════════════════
router.get('/whoami', asyncH(async (req, res) => {
  res.json({
    username: req.agent.username, role: req.agent.role, scopes: req.agent.scopes,
    actor: req.agent.actor, finance: req.agent.finance
  });
}));

// ════════════════════════════════════════════════════════════════════════════
// §2. MATCH — the confidence guardrail. Never writes; safe to call repeatedly.
// ════════════════════════════════════════════════════════════════════════════
router.post('/match', requireScope('agent:read'), asyncH(async (req, res) => {
  const b = req.body || {};
  const result = await matchCandidates({
    sourceKind: b.sourceKind, subject: b.subject, participants: b.participants,
    bodyExcerpt: b.bodyExcerpt, dates: b.dates, amounts: b.amounts, vendors: b.vendors,
    hints: b.hints || {}, sourceRef: b.sourceRef
  });
  res.json(result);
}));

// ════════════════════════════════════════════════════════════════════════════
// §10. SHOW CONTEXT — budget-capped so an agent can pull it every turn
// ════════════════════════════════════════════════════════════════════════════
router.get('/shows/:id/context', requireScope('agent:read'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);

  const steps = (await pool.query('SELECT * FROM steps WHERE show_id=$1', [show.id])).rows;
  const lanes = {};
  for (const s of steps) {
    lanes[s.lane] = lanes[s.lane] || {};
    lanes[s.lane][s.status] = (lanes[s.lane][s.status] || 0) + 1;
  }
  const openSteps = steps
    .filter((s) => s.status !== 'done' && s.status !== 'na')
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')))
    .slice(0, 20).map(agentStep);

  const activity = (await pool.query(
    'SELECT * FROM activity WHERE show_id=$1 ORDER BY created_at DESC, id DESC LIMIT 20',
    [show.id])).rows.map(agentActivity);

  const jobs = (await pool.query('SELECT * FROM jobs WHERE project_id=$1 ORDER BY id',
    [show.project_id])).rows.map((j) => agentJob(j, j.id === show.default_job_id));

  // `money` is ROLE-FILTERED. Tom's decision (2026-08-27): dollar visibility is
  // **admin OR the finance capability**, the same predicate as PO approval.
  // Every other agent — including a manager's — sees COUNTS, not dollars.
  const canSeeMoney = hasFinance(req.agent);
  const m = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status <> 'proposed'),0) AS total,
            COUNT(*) FILTER (WHERE status = 'proposed') AS proposed
     FROM expenses WHERE show_id=$1`, [show.id]);
  const missingDocs = steps
    .filter((s) => s.evidence_type === 'booking' && s.status === 'done' && !s.evidence_ref)
    .map((s) => s.title).slice(0, 10);
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proposals WHERE show_id=$1 AND status='pending'`, [show.id]);

  res.json({
    show: agentShow(show),
    project: agentProject(project),
    jobs, lanes, openSteps, recentActivity: activity,
    money: canSeeMoney
      ? { expensesTotal: Number(m.rows[0].total), proposedCount: parseInt(m.rows[0].proposed, 10), missingDocs }
      : { proposedCount: parseInt(m.rows[0].proposed, 10), missingDocs },
    pendingProposals: pending.rows[0].n
  });
}));

// Light lookup by name/client/venue/date when the agent already knows the target.
router.get('/shows', requireScope('agent:read'), asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
  if (req.query.q) add(`(s.name ILIKE '%' || $? || '%' OR s.venue ILIKE '%' || $? || '%')`, req.query.q);
  if (req.query.client) add(`p.client ILIKE '%' || $? || '%'`, req.query.client);
  if (req.query.from) add('s.event_date >= $?', req.query.from);
  if (req.query.to) add('s.event_date <= $?', req.query.to);
  params.push(limitOf(req, 25, 100));
  const r = await pool.query(
    `SELECT s.*, p.name AS project_name, p.client FROM shows s JOIN projects p ON p.id = s.project_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.event_date DESC NULLS LAST, s.id DESC LIMIT $${params.length}`, params);
  res.json(r.rows.map((row) => ({
    ...agentShow(row), projectName: row.project_name, client: row.client
  })));
}));

// ════════════════════════════════════════════════════════════════════════════
// §3. FILING DOCUMENTS
// ════════════════════════════════════════════════════════════════════════════
// Two-tier as always: metadata in Postgres, bytes on the NAS in a second call.
//
// PROPOSED DOCUMENTS — a deliberate, documented deviation from a strict
// reading of punch item 24. Item 24 says the reject path must never
// materialize-then-delete. It does not here: a proposed document creates ONE
// `files` row, quarantined under _agent-inbox, because the byte-upload and
// NAS-thumbnailer contracts (punch 46) both need a stable file id — and REJECT
// resolves the proposal and marks that row `status='rejected'`. There is no
// DELETE anywhere in the reject path. Everything that would actually cost
// money or work — the `expenses` row, the steps, the project/show/job — is NOT
// created until confirm.
router.post('/documents', requireScope('agent:file'), idempotent('documents'),
  asyncH(async (req, res) => {
    const b = req.body || {};
    if (roleRank(req.agent.role) < 1) throw forbidden("Requires 'tech' role or higher");

    const kind = pick(b, 'kind');
    if (!FILE_KINDS.includes(kind)) {
      throw badRequest(`Unknown kind '${kind}' — one of: ${FILE_KINDS.join(', ')}`);
    }
    const name = pick(b, 'name');
    if (!name) throw badRequest('name required');
    const showId = intOrNull(pick(b, 'show_id'));
    const projectId = intOrNull(pick(b, 'project_id'));
    if (!showId && !projectId) throw badRequest('neither showId nor projectId supplied');

    const provenance = normalizeProvenance(b.provenance, req.agent.username);
    const { status } = assertBand(pick(b, 'status'), provenance.confidence, !!pick(b, 'ambiguous'));

    const show = showId ? await loadShow(showId) : null;
    if (showId && !show) throw notFound('Show not found');
    const project = show ? await loadProject(show.project_id) : await loadProject(projectId);
    if (!project) throw notFound('Project not found');

    // jobId defaults to the show's default_job_id; supply it only to override.
    let jobId = intOrNull(pick(b, 'job_id'));
    if (jobId) { if (!(await loadJob(jobId))) throw notFound('Job not found'); }
    else jobId = show ? show.default_job_id : null;

    const amountRaw = pick(b, 'amount');
    if (amountRaw !== undefined && amountRaw !== null && !Number.isFinite(Number(amountRaw))) {
      throw badRequest('amount must be numeric');
    }
    const amount = money(amountRaw, null);
    const docDate = pick(b, 'doc_date') || null;
    if (docDate && !isISODate(docDate)) throw badRequest('docDate must be YYYY-MM-DD');

    // ── D6. spec artifacts on the agent surface ─────────────────────────────
    // Until now this insert omitted the three columns the human POST /api/files
    // sets, so a server-side agent literally could not FILE a spec artifact —
    // "the agent files the .e360 it found in an email" was blocked on a missing
    // column list, not on a policy.
    //
    // What this does NOT do, deliberately: it never touches `spec_chain`.
    // BINDING a chain node stays session-only, and that is a correct guardrail,
    // not an oversight — requireAuth 403s any request carrying an x-agent-key
    // outside /api/agent/*, so an agent key can never reach PUT /chain/:node or
    // POST /spec-bind. An agent may put the file on the shelf; a human decides
    // it is the spec of record and bumps the rev.
    const specType = SPEC_TYPES.includes(pick(b, 'spec_type')) ? pick(b, 'spec_type') : null;
    const artifact = FILE_ARTIFACTS.includes(pick(b, 'artifact')) ? pick(b, 'artifact') : null;
    const chainKey = pick(b, 'chain_key') || null;
    if (chainKey && !CHAIN_NODE_KEYS.includes(chainKey)) {
      throw badRequest(`chain_key must be one of: ${CHAIN_NODE_KEYS.join(', ')}`);
    }
    // A spec artifact that names no type is almost always a mis-filed document.
    if (chainKey && !specType && kind === 'spec') {
      throw badRequest('a spec filed against a chain_key must also carry spec_type ' +
                       `(${SPEC_TYPES.join(', ')})`);
    }

    // nasPath is ALWAYS server-derived. The agent may not supply one — a
    // rejected proposal must leave no trace in a real show folder.
    const fileStub = { kind, name, ext: pick(b, 'ext') || '' };
    const nasPath = status === 'filed'
      ? buildNasPath(project, show, fileStub)
      : buildQuarantinePath(req.agent.username, fileStub);

    const out = await withTx(async (c) => {
      const ins = await c.query(
        `INSERT INTO files (project_id, show_id, name, ext, kind, nas_path, size, uploaded_by,
           amount, vendor, doc_date, job_id, status, provenance, source_ref,
           taken_at, width, height, caption, tags, shot_by, meta,
           spec_type, artifact, chain_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25)
         RETURNING *`,
        [show ? null : project.id, show ? show.id : null, name, pick(b, 'ext') || '', kind,
         nasPath, parseInt(pick(b, 'size'), 10) || 0, req.agent.actor,
         amount, pick(b, 'vendor') || null, docDate, jobId, status,
         JSON.stringify(provenance), provenance.source_ref,
         pick(b, 'taken_at') || null, intOrNull(pick(b, 'width')), intOrNull(pick(b, 'height')),
         pick(b, 'caption') || null,
         Array.isArray(pick(b, 'tags')) ? pick(b, 'tags').map((t) => String(t).toLowerCase()) : null,
         pick(b, 'shot_by') || null,
         status === 'proposed' ? 'awaiting review' : '',
         specType, artifact, chainKey]                                   // D6
      );
      const file = ins.rows[0];

      let expenseId = null;
      let proposalId = null;

      if (status === 'filed') {
        // amount + vendor + a job -> the doc reaches accounting's feed as a
        // COST, not just a PDF. No amount -> no expense.
        if (amount != null && show) {
          const cat = BUDGET_CATS.includes(pick(b, 'category')) ? pick(b, 'category') : 'misc';
          const e = await c.query(
            `INSERT INTO expenses (show_id, project_id, job_id, budget_line_category, category,
               vendor, amount, txn_date, status, file_id, by, memo, evidence_ref,
               match_confidence, match_reason, provenance, source_ref)
             VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'proposed',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
            [show.id, project.id, jobId, cat, pick(b, 'vendor') || '', amount,
             docDate || todayISO(), file.id, req.agent.actor, pick(b, 'memo') || '',
             String(file.id), provenance.confidence, provenance.source_label || '',
             JSON.stringify(provenance), provenance.source_ref]);
          expenseId = e.rows[0].id;
        }
      } else {
        proposalId = (await createProposal(c, {
          kind: 'document', proposedBy: req.agent.actor,
          assignedTo: await assigneeFor({ projectId: project.id, showId: show ? show.id : null,
                                          agentUser: req.agent.username }, c),
          projectId: project.id, showId: show ? show.id : null, jobId,
          payload: { ...b, _resolved: { kind, name, ext: pick(b, 'ext') || '', amount, jobId,
                                        vendor: pick(b, 'vendor') || null, docDate,
                                        category: pick(b, 'category') || null } },
          provenance, confidence: provenance.confidence,
          createdRows: { files: [file.id] }
        })).id;
      }

      const activityId = await logActivity(c, {
        projectId: project.id, showId: show ? show.id : null, actor: req.agent.actor,
        action: 'file.add', detail: `${kind}: ${name}`, accent: true, provenance
      });
      return { file, expenseId, proposalId, activityId };
    });

    res.json({
      status,
      fileId: out.file.id,
      proposalId: out.proposalId,
      expenseId: out.expenseId,
      activityId: out.activityId,
      nasPath,
      uploadUrl: `/api/agent/documents/${out.file.id}/content`
    });
  }));

// Bytes. The ONE PUT on this surface, and only because §3 makes the create
// flow deliberately metadata-first: a failed upload leaves a resolvable
// record, not a ghost.
router.put('/documents/:id/content', requireScope('agent:file'),
  express.raw({ type: () => true, limit: MAX_BYTES }),
  asyncH(async (req, res) => {
    const id = idParam(req);
    const f = (await pool.query('SELECT * FROM files WHERE id=$1', [id])).rows[0];
    if (!f) throw notFound('File not found');
    // An agent may only put bytes into a row IT created.
    if (f.uploaded_by !== req.agent.actor) {
      throw forbidden('An agent key may only upload bytes to a document it filed');
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Empty body');
    const result = await storage.put(f.nas_path, req.body);
    await pool.query('UPDATE files SET size=$1 WHERE id=$2', [result.size, f.id]);
    res.json({ ok: true, size: result.size });
  }));

// ════════════════════════════════════════════════════════════════════════════
// §4. DERIVING TASKS — one meeting -> many steps, ATOMIC
// ════════════════════════════════════════════════════════════════════════════
router.post('/tasks:batch', idempotent('tasks:batch'), asyncH(async (req, res) => {
  const b = req.body || {};
  const provenance = normalizeProvenance(b.provenance, req.agent.username);
  const { status } = assertBand(pick(b, 'status'), provenance.confidence, !!pick(b, 'ambiguous'));

  // Scope depends on what is being asked for.
  const needed = status === 'filed' ? 'agent:file' : 'agent:propose';
  if (!req.agent.scopes.includes(needed)) {
    return res.status(403).json({ error: `Key lacks scope '${needed}'` });
  }
  // pm+ to FILE; any role may PROPOSE.
  if (status === 'filed' && roleRank(req.agent.role) < 2) {
    return res.status(403).json({ error: "Requires 'pm' role or higher" });
  }

  const showId = intOrNull(pick(b, 'show_id'));
  const show = showId ? await loadShow(showId) : null;
  if (showId && !show) throw notFound('Show not found');
  if (!show) throw badRequest('showId required');
  const project = await loadProject(show.project_id);
  const allowedLanes = await lanesForType(project ? project.type : 'led');

  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!steps.length) throw badRequest('steps[] required');
  if (steps.length > 25) throw badRequest('A batch is capped at 25 steps');

  // Validate EVERYTHING first, naming the index — one bad lane means nothing
  // is written at all.
  // ACTIVE people only. This roster exists to answer "may this step be given to
  // this person", and somebody who has left the company is not an answer to
  // that question — an agent assigning them work would put a former teammate's
  // name on a live task and on the call sheet built from it. The lookup that
  // has to keep resolving them (attribution, history) is a different one.
  const roster = (await pool.query('SELECT username FROM users WHERE active IS NOT FALSE'))
    .rows.map((u) => u.username.toLowerCase());
  const prepared = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const lane = s.lane;
    if (!allowedLanes.includes(lane)) {
      throw badRequest(`steps[${i}].lane invalid`, { index: i, allowed: allowedLanes });
    }
    if (!s.title || typeof s.title !== 'string') {
      throw badRequest(`steps[${i}].title required`, { index: i });
    }
    let owner = s.owner ? String(s.owner) : '';
    if (owner) {
      if (!roster.includes(owner.toLowerCase())) {
        // the agent may assign, it may not invent people
        throw badRequest(`steps[${i}].owner '${owner}' is not a known user`, { index: i });
      }
      // Below pm, an agent may only set owner to ITSELF or leave it blank.
      // Assigning work to a colleague is a management act.
      if (roleRank(req.agent.role) < 2 && owner.toLowerCase() !== req.agent.username.toLowerCase()) {
        throw forbidden(`steps[${i}]: below 'pm', an agent may only assign work to itself`);
      }
    }
    let dueDate = s.dueDate || s.due_date || '';
    if (dueDate && !isISODate(dueDate)) throw badRequest(`steps[${i}].dueDate must be YYYY-MM-DD`, { index: i });
    const off = s.dueOffsetDays != null ? s.dueOffsetDays : s.due_offset_days;
    if (!dueDate && off != null && show.event_date) dueDate = addDays(show.event_date, off);
    prepared.push({ lane, title: s.title, owner, dueDate,
                    off: off != null ? parseInt(off, 10) : null, notes: s.notes || '' });
  }

  const out = await withTx(async (c) => {
    if (status === 'proposed') {
      const p = await createProposal(c, {
        kind: 'tasks_batch', proposedBy: req.agent.actor,
        assignedTo: await assigneeFor({ projectId: show.project_id, showId: show.id,
                                        agentUser: req.agent.username }, c),
        projectId: show.project_id, showId: show.id, jobId: show.default_job_id,
        payload: { ...b, _prepared: prepared }, provenance, confidence: provenance.confidence
      });
      await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.agent.actor,
        action: 'agent.tasks.propose', detail: `${prepared.length} step(s) from ${provenance.source_kind}`,
        accent: true, provenance });
      return { proposalId: p.id, stepIds: [] };
    }
    const stepIds = [];
    let sort = (await c.query(
      'SELECT COALESCE(MAX(sort_order),0) AS m FROM steps WHERE show_id=$1', [show.id])).rows[0].m;
    for (const s of prepared) {
      // Filed steps land status 'todo', evidence_type 'none' — the provenance
      // carries the meeting link, not the evidence slot.
      const r = await c.query(
        `INSERT INTO steps (show_id, lane, title, status, owner, due_date, due_offset_days,
           evidence_type, auto_source, sort_order, notes, provenance, source_ref)
         VALUES ($1,$2,$3,'todo',$4,$5,$6,'none','none',$7,$8,$9,$10) RETURNING id`,
        [show.id, s.lane, s.title, s.owner, s.dueDate, s.off, ++sort, s.notes,
         JSON.stringify(provenance), provenance.source_ref]);
      stepIds.push(r.rows[0].id);
    }
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.agent.actor,
      action: 'agent.tasks.file', detail: `${stepIds.length} step(s) from ${provenance.source_kind}`,
      accent: true, provenance });
    return { proposalId: null, stepIds };
  });

  res.json({ status, proposalId: out.proposalId, count: prepared.length, stepIds: out.stepIds });
}));

// ════════════════════════════════════════════════════════════════════════════
// §5. PROPOSING A NEW EVENT — ALWAYS a proposal, at any confidence, any role
// ════════════════════════════════════════════════════════════════════════════
// Creating a client-facing commercial object (a folder, a show, and a
// qb_job_number accounting will reconcile against) is judgment, not clerking.
router.post('/projects', requireScope('agent:propose'), idempotent('projects'),
  asyncH(async (req, res) => {
    const b = req.body || {};
    const provenance = normalizeProvenance(b.provenance, req.agent.username);
    const p = b.project || {};
    if (!p.name) throw badRequest('project.name required');
    if (p.type && !PROJECT_TYPES.includes(p.type)) throw badRequest('project.type invalid');
    if (p.stage && !STAGES.includes(p.stage)) throw badRequest('project.stage invalid');
    const s = b.show || {};
    for (const k of ['eventDate', 'loadInDate', 'strikeDate']) {
      if (s[k] && !isISODate(s[k])) throw badRequest(`show.${k} must be YYYY-MM-DD`);
    }
    const j = b.job || {};
    if (j.dealType && !DEAL_TYPES.includes(j.dealType)) throw badRequest('job.dealType invalid');
    // §9: agents may PROPOSE a job, never set its number. Candice creates it in
    // QuickBooks and it is entered on confirm.
    if (j.qbJobNumber) throw forbidden('An agent may not set qb_job_number — accounting owns it');

    const proposal = await withTx(async (c) => createProposal(c, {
      kind: 'project', proposedBy: req.agent.actor,
      assignedTo: req.agent.username, projectId: null, showId: null, jobId: null,
      payload: b, provenance, confidence: provenance.confidence
    }));
    await logActivity(pool, { actor: req.agent.actor, action: 'agent.project.propose',
      detail: p.name, accent: true, provenance });
    res.json({ status: 'proposed', proposalId: proposal.id, targetKind: 'project' });
  }));

// ════════════════════════════════════════════════════════════════════════════
// §5. NOTES — always filed, never proposed
// ════════════════════════════════════════════════════════════════════════════
// Commentary is reversible and is the cheapest way for an agent to say "I did
// a thing, check me" — the natural companion to every high-confidence auto-file.
router.post('/notes', requireScope('agent:file'), idempotent('notes', { required: false }),
  asyncH(async (req, res) => {
    const b = req.body || {};
    const target = b.target || {};
    const kind = target.kind || pick(b, 'anchor_type');
    const id = target.id != null ? target.id : pick(b, 'anchor_id');
    if (!NOTE_ANCHORS.includes(kind)) {
      throw badRequest(`target.kind must be one of: ${NOTE_ANCHORS.join(', ')}`);
    }
    const provenance = normalizeProvenance(b.provenance, req.agent.username);
    const mentions = Array.isArray(b.mentions) ? b.mentions : [];

    const note = await withTx(async (c) => createNote(c, {
      anchorType: kind, anchorId: id, body: b.body,
      author: req.agent.actor,                       // 'agent:<username>'
      parentId: intOrNull(b.parentId || b.parent_id),
      provenance, sourceRef: provenance.source_ref,
      extraMentions: mentions
    }));
    res.json({ noteId: note.id, notified: note.mentions });
  }));

// ════════════════════════════════════════════════════════════════════════════
// PUNCH 30. PURCHASE REQUESTS — land as status 'needed', provenance mandatory
// ════════════════════════════════════════════════════════════════════════════
// A purchase REQUEST is not a purchase order: it enters the pipeline at the
// bottom, where a human quotes it out. Anything with money committed to it
// (quoted -> ordered) stays a human act behind the approval gate.
router.post('/purchase-requests', requireScope('agent:propose'),
  idempotent('purchase-requests'), asyncH(async (req, res) => {
    const b = req.body || {};
    const provenance = normalizeProvenance(b.provenance, req.agent.username);
    const projectId = intOrNull(pick(b, 'project_id'));
    const project = await loadProject(projectId);
    if (!project) throw notFound('Project not found');
    const jobId = intOrNull(pick(b, 'job_id'));
    if (jobId && !(await loadJob(jobId))) throw notFound('Job not found');

    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw badRequest('lines[] required');
    if (lines.length > 25) throw badRequest('A purchase request is capped at 25 lines');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] || {};
      if (!l.item) throw badRequest(`lines[${i}].item required`, { index: i });
      if (!(Number(l.qty) > 0)) throw badRequest(`lines[${i}].qty must be > 0`, { index: i });
      if (l.category && !BUDGET_CATS.includes(l.category)) {
        throw badRequest(`lines[${i}].category invalid`, { index: i });
      }
    }

    const out = await withTx(async (c) => {
      // HARDENING 4. This used to mint its own number with `ORDER BY po_number
      // DESC` — a LEXICOGRAPHIC max, which ranks PO-26-999 above PO-26-1000 and
      // re-issues a number already on the books; the unique index then turned
      // the collision into a raw 500. Both halves are fixed by deferring to the
      // human pipeline's insertPO(): a numeric max, and a savepoint retry that
      // treats a lost race as contention rather than an error.
      const po = await insertPO(c, {
        insert: async (poNumber) => (await c.query(
          `INSERT INTO purchase_orders (po_number, vendor, project_id, job_id, status, created_by,
             memo, provenance, source_ref)
           VALUES ($1,$2,$3,$4,'needed',$5,$6,$7,$8) RETURNING *`,
          [poNumber, pick(b, 'vendor') || 'TBD — quotes out', project.id, jobId, req.agent.actor,
           pick(b, 'memo') || '', JSON.stringify(provenance), provenance.source_ref])).rows[0]
      });
      const poNumber = po.po_number;
      const lineIds = [];
      for (const l of lines) {
        // ownership derives from the resolved job's deal_type: a sale is COGS,
        // a rental keeps the gear as E360 inventory.
        const j = await c.query('SELECT deal_type FROM jobs WHERE id=$1',
          [intOrNull(l.jobId || l.job_id) || jobId]);
        const ownership = j.rows.length && j.rows[0].deal_type === 'sale' ? 'cogs' : 'inventory';
        const r = await c.query(
          `INSERT INTO po_lines (po_id, item, detail, qty, unit_cost, category, job_id, show_id, ownership)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [po.id, l.item, l.detail || '', Number(l.qty), money(l.unitCost || l.unit_cost, 0),
           BUDGET_CATS.includes(l.category) ? l.category : 'gear',
           intOrNull(l.jobId || l.job_id), intOrNull(l.showId || l.show_id), ownership]);
        lineIds.push(r.rows[0].id);
      }
      await logActivity(c, { projectId: project.id, poId: po.id, actor: req.agent.actor,
        action: 'po.create', accent: true, provenance,
        detail: `drafted ${poNumber} from ${provenance.source_kind} '${provenance.source_label}'` });
      return { po, lineIds };
    });
    res.json({ status: 'needed', poId: out.po.id, poNumber: out.po.po_number,
               lineCount: out.lineIds.length });
  }));

// ════════════════════════════════════════════════════════════════════════════
// §6. THE REVIEW QUEUE (read side — key OR session)
// ════════════════════════════════════════════════════════════════════════════
router.get('/proposals', asyncH(async (req, res) => {
  const me = req.agent ? req.agent.username : req.session.username;
  const role = req.agent ? req.agent.role : req.session.role;
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };

  if (String(req.query.user) === 'all') {
    if (roleRank(role) < 3) return res.status(403).json({ error: "Requires 'manager' role or higher" });
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
  res.json(r.rows.map((row) => agentProposal(row)));
}));

router.get('/proposals/:id', asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM proposals WHERE id=$1', [idParam(req)]);
  if (!r.rows.length) throw notFound('Proposal not found');
  const p = r.rows[0];
  const me = req.agent ? req.agent.username : req.session.username;
  const role = req.agent ? req.agent.role : req.session.role;
  if (roleRank(role) < 3 && p.assigned_to !== me && p.proposed_by !== 'agent:' + me) {
    throw forbidden('Not your proposal');
  }
  res.json(agentProposal(p, { full: true }));
}));

// ── §9. terminal guard ──────────────────────────────────────────────────────
// Anything under /api/agent/* that is not one of the routes above ends HERE.
// It must never fall through to the human /api routers: route topology IS the
// guardrail, and a fall-through would turn a typo into a 403 from somewhere
// else — or, worse one day, into a match on a human route.
router.all('*', (req, res) => {
  res.status(404).json({
    error: `No agent endpoint ${req.method} /api/agent${req.path}`,
    hint: 'The agent surface is append-only. There is no DELETE, no scheduler push, ' +
          'no user admin, no deliverables, and no proposal confirm/reject here.'
  });
});

module.exports = router;
