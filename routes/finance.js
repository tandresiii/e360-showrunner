// ════════════════════════════════════════════════════════════════════════════
// routes/finance.js — jobs, budgets, expenses, and the money views
// ────────────────────────────────────────────────────────────────────────────
// JOB ATTRIBUTION RULE, everywhere, without exception:
//     the item's own job_id  >  the show's default_job_id
// One show can bill to two jobs (the LOVB league deal covers LED freight while
// a team separately bought print at the same match), so every cost-bearing row
// may override.
//
// Punch coverage: 5 (jobs + expenses.job_id), 16 (deal_type drives COGS
// treatment and P&L grouping), 17 (budget_lines + ONE shared category
// vocabulary enforced on expenses too), 18 (expenses.by + memo), 19 (bookings
// amount/booked_date/file_id feed the feed and the chase list), 20 (jobs.
// budget_total is DERIVED in the query — never double-entered), 21 (budget-line
// change audit: updated_at/updated_by + activity rows), 27 (PO-generated
// actuals carry po_id and are excluded from the exceptions scan — the PO
// carries that exception, never both).
//
// VISIBILITY: budgets are broadly visible (TEAM_FEEDBACK). MARGIN and
// profitability are gated to manager+ or the finance capability, and are
// stripped from the payload rather than zeroed, so a tech's client never sees
// a field it should not have.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadProject, loadShow, loadJob, mintTempJobNumber } = require('../lib/db');
const { requireAuth, requireRole, canEditProject, hasFinance, roleRank } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf } = require('../lib/http');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');
const { notifyTargets } = require('../lib/mentions');
const { pick, has, dbToJob, dbToBudgetLine, dbToExpense, dbToFile, dbToBooking,
        dbToShow, dbToPO, dbToActivity, stripMoney } = require('../lib/mappers');
const { BUDGET_CATS, DEAL_TYPES, FIN_KINDS, PO_COMMITTED, EXPENSE_STATUS,
        isTempJobNumber,
        oneOf, money, intOrNull, isISODate, todayISO, dayAge } = require('../lib/enums');

const router = express.Router();
router.use(requireAuth);

// F3. The material sets for the money family. `qb_job_number` is absent because
// its change already has its own accented `job.number.confirm` row naming both
// numbers (POLISH_LIST #5) — logging it twice would double-count the one event
// accounting actually watches for.
const MATERIAL_JOB_FIELDS = {
  name: 'name', client: 'client', deal_type: 'deal type',
  contract_value: 'contract value', description: 'description', status: 'status'
};
const MATERIAL_EXPENSE_FIELDS = {
  vendor: 'vendor', amount: 'amount', budget_line_category: 'category',
  status: 'status', job_id: 'job', txn_date: 'date', file_id: 'receipt'
};

// Can this caller see margin / profitability?
// Tom's decision (2026-08-27, mid-build): **admin OR the finance capability** —
// the same predicate shape as PO approval. Tom/Tony/Jim are admins; Candice
// carries the flag. A manager WITHOUT the flag does not see margin.
// Budgets, burn and committed stay visible to everyone (TEAM_FEEDBACK).
function canSeeMargin(session) {
  return hasFinance(session);      // role === 'admin' || finance === true
}
// The PROJECTION lives in lib/mappers.js stripMoney(); this is the one place
// that binds it to the DECISION. Note it also drops `contract_value` — see the
// note on stripMoney: costs are visible to everyone, so shipping the contract
// value made the margin derivable by subtraction for exactly the callers this
// gate exists to keep it from (hardening 2, 2026-08-27).
function stripMargin(payload, session) {
  return stripMoney(payload, canSeeMargin(session));
}

// ════════════════════════════════════════════════════════════════════════════
// JOBS
// ════════════════════════════════════════════════════════════════════════════
// 20. budget_total is the SUM OF LINES, computed here. There is no such column.
const JOB_SELECT = `
  SELECT j.*, COALESCE(b.total,0) AS budget_total
  FROM jobs j
  LEFT JOIN (SELECT job_id, SUM(allotted) AS total FROM budget_lines GROUP BY job_id) b
    ON b.job_id = j.id`;

router.get('/jobs', asyncH(async (req, res) => {
  const projectId = intOrNull(pick(req.query, 'project_id'));
  const r = projectId
    ? await pool.query(`${JOB_SELECT} WHERE j.project_id=$1 ORDER BY j.id`, [projectId])
    : await pool.query(`${JOB_SELECT} ORDER BY j.id`);
  res.json(r.rows.map((row) => stripMargin(dbToJob(row), req.session)));
}));

router.get('/jobs/:id', asyncH(async (req, res) => {
  const r = await pool.query(`${JOB_SELECT} WHERE j.id=$1`, [idParam(req)]);
  if (!r.rows.length) throw notFound();
  res.json(stripMargin(dbToJob(r.rows[0]), req.session));
}));

// ── POLISH_LIST #5. TEMP JOB NUMBERS ────────────────────────────────────────
// A deal exists days before Candice cuts the QuickBooks number, and work
// (costs, POs, activity) starts against it immediately. So a job is NEVER
// numberless: created without a number it gets `TEMP-{yy}-{seq}` and
// qb_number_status='temp'. Nothing joins on the number — every link in this
// schema is jobs.id — so confirming the real number re-links nothing.
// The minter lives in lib/db.js because routes/proposals.js needs it too.

router.post('/jobs', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const projectId = intOrNull(pick(b, 'project_id'));
  const project = await loadProject(projectId);
  if (!project) throw notFound('Project not found');
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to add jobs to this project');
  // AGENT_API §9: a REAL qb_job_number is accounting-owned. Only the finance
  // capability (or an admin) may set one — Candice creates it in QuickBooks.
  // A TEMP label is not a QuickBooks number, so any pm may create a job and
  // this route mints the placeholder for them.
  const asked = pick(b, 'qb_job_number');
  if (asked && !isTempJobNumber(asked) && !hasFinance(req.session)) {
    throw forbidden('Only accounting (the finance capability) may set qb_job_number');
  }
  const qb = asked || await mintTempJobNumber();
  const status = isTempJobNumber(qb) ? 'temp' : 'confirmed';
  const r = await pool.query(
    `INSERT INTO jobs (project_id, name, qb_job_number, qb_number_status, client, deal_type,
                       description, contract_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [projectId, pick(b, 'name') || project.name, qb, status,
     pick(b, 'client') || project.client || '', oneOf(pick(b, 'deal_type'), DEAL_TYPES, 'rental'),
     pick(b, 'description') || '', money(pick(b, 'contract_value'), 0)]);
  await logActivity(pool, { projectId, jobId: r.rows[0].id, actor: req.actor,
    action: 'job.create', detail: r.rows[0].name, accent: true });
  res.json(stripMargin(dbToJob({ ...r.rows[0], budget_total: 0 }), req.session));
}));

router.put('/jobs/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = await loadJob(idParam(req));
  if (!cur) throw notFound();
  const project = await loadProject(cur.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this job');
  const b = req.body || {};
  // Editing the number is accounting's: the three admins + Candice (hasFinance).
  if (has(b, 'qb_job_number') && !hasFinance(req.session)) {
    throw forbidden('Only accounting (the finance capability) may set qb_job_number');
  }
  // C2. `contract_value` is `billed` — margin is billed minus actual, and the
  // whole stripMoney / MONEY_FIELDS / hasFinance apparatus exists to stop the
  // wrong person READING it. It was writable by any pm who owned the folder,
  // which meant the most heavily defended number in the codebase could be set
  // by someone who could not then see it. One predicate, both directions.
  if (has(b, 'contract_value') && !hasFinance(req.session)) {
    throw forbidden('Only accounting (the finance capability) may set the contract value');
  }
  // 16. rental vs sale decides whether a received PO line becomes E360 capex or
  // job COGS. That is an accounting classification, not a scheduling one.
  if (has(b, 'deal_type') && !hasFinance(req.session)) {
    throw forbidden('Only accounting (the finance capability) may change the deal type');
  }
  // A job never goes back to having no number at all: clearing it re-mints a
  // placeholder rather than leaving the chip blank everywhere it renders.
  let qb = has(b, 'qb_job_number') ? (pick(b, 'qb_job_number') || '') : cur.qb_job_number;
  if (!qb) qb = await mintTempJobNumber();
  const status = isTempJobNumber(qb) ? 'temp' : 'confirmed';
  const confirming = cur.qb_number_status === 'temp' && status === 'confirmed';
  const r = await pool.query(
    `UPDATE jobs SET name=$1, qb_job_number=$2, qb_number_status=$3, client=$4, deal_type=$5,
       description=$6, contract_value=$7, status=$8, updated_at=NOW() WHERE id=$9 RETURNING *`,
    [pick(b, 'name', cur.name), qb, status,
     pick(b, 'client', cur.client), oneOf(pick(b, 'deal_type'), DEAL_TYPES, cur.deal_type),
     pick(b, 'description', cur.description),
     has(b, 'contract_value') ? money(pick(b, 'contract_value'), 0) : cur.contract_value,
     pick(b, 'status', cur.status), cur.id]);
  // The confirmation is its own accented activity row — it is the moment the
  // deal becomes billable, and Candice's exception clears off the back of it.
  if (confirming) {
    await logActivity(pool, { projectId: cur.project_id, jobId: cur.id, actor: req.actor,
      action: 'job.number.confirm', accent: true,
      detail: `job number confirmed ${qb} (was ${cur.qb_job_number})` });
  } else {
    const changes = diffFields(cur, r.rows[0], MATERIAL_JOB_FIELDS);
    await logActivity(pool, { projectId: cur.project_id, jobId: cur.id, actor: req.actor,
      action: 'job.update',
      // A contract value landing is a commercial fact, not bookkeeping.
      accent: changes.some((ch) => ch.field === 'contract_value'),
      detail: changeSummary(changes, r.rows[0].name), changes });
  }
  const withTotal = await pool.query(`${JOB_SELECT} WHERE j.id=$1`, [cur.id]);
  res.json(stripMargin(dbToJob(withTotal.rows[0]), req.session));
}));

router.delete('/jobs/:id', requireRole('manager'), asyncH(async (req, res) => {
  const id = idParam(req);
  const inUse = await pool.query(
    `SELECT (SELECT COUNT(*) FROM shows WHERE default_job_id=$1)
          + (SELECT COUNT(*) FROM expenses WHERE job_id=$1)
          + (SELECT COUNT(*) FROM po_lines WHERE job_id=$1) AS n`, [id]);
  if (parseInt(inUse.rows[0].n, 10) > 0) {
    throw badRequest('This job still has shows, costs or PO lines attached — reassign them first');
  }
  await withTx(async (c) => {
    await c.query('DELETE FROM budget_lines WHERE job_id=$1', [id]);
    // the needs CHECKLIST goes with its job, like the budget lines — it is
    // bookkeeping about the job, not money in the record. A need that was
    // raised onto a PO left its po_line behind, which is what blocks above.
    await c.query('DELETE FROM purchase_needs WHERE job_id=$1', [id]);
    await c.query(`DELETE FROM notes WHERE anchor_type='job' AND anchor_id=$1`, [id]);
    await c.query('DELETE FROM jobs WHERE id=$1', [id]);
  });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// 17/21. BUDGET LINES
// ════════════════════════════════════════════════════════════════════════════
router.get('/jobs/:id/budget', asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM budget_lines WHERE job_id=$1 ORDER BY id', [idParam(req)]);
  res.json(r.rows.map(dbToBudgetLine));
}));

// Budget lines are accounting's. manager+ or the finance capability.
function requireBudgetRights(req, res, next) {
  if (roleRank(req.session.role) >= 3 || hasFinance(req.session)) return next();
  return next(forbidden('Editing budgets requires manager, admin, or the finance capability'));
}

router.post('/jobs/:id/budget', requireBudgetRights, asyncH(async (req, res) => {
  const jobId = idParam(req);
  const job = await loadJob(jobId);
  if (!job) throw notFound('Job not found');
  const category = pick(req.body, 'category');
  if (!BUDGET_CATS.includes(category)) {
    throw badRequest(`category must be one of: ${BUDGET_CATS.join(', ')}`);
  }
  const allotted = money(pick(req.body, 'allotted'), 0);
  const r = await pool.query(
    `INSERT INTO budget_lines (job_id, category, allotted, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [jobId, category, allotted, pick(req.body, 'notes') || '', req.actor]);
  // 21. the change audit — a budget move is a decision, and it gets a row.
  await logActivity(pool, { projectId: job.project_id, jobId, actor: req.actor,
    action: 'budget.line.add', accent: true,
    detail: `${category} · $${allotted.toLocaleString('en-US')}`,
    changes: [{ field: 'allotted', label: `${category} allotment`,
                from: null, to: `$${allotted.toLocaleString('en-US')}` }] });
  res.json(dbToBudgetLine(r.rows[0]));
}));

router.put('/budget-lines/:id', requireBudgetRights, asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM budget_lines WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const b = req.body || {};
  const category = has(b, 'category')
    ? (BUDGET_CATS.includes(pick(b, 'category')) ? pick(b, 'category') : null) : cur.category;
  if (!category) throw badRequest(`category must be one of: ${BUDGET_CATS.join(', ')}`);
  const allotted = has(b, 'allotted') ? money(pick(b, 'allotted'), 0) : Number(cur.allotted);
  const r = await pool.query(
    `UPDATE budget_lines SET category=$1, allotted=$2, notes=$3, updated_by=$4, updated_at=NOW()
     WHERE id=$5 RETURNING *`,
    [category, allotted, pick(b, 'notes', cur.notes), req.actor, cur.id]);
  const job = await loadJob(cur.job_id);
  await logActivity(pool, { projectId: job ? job.project_id : null, jobId: cur.job_id,
    actor: req.actor, action: 'budget.line.update', accent: true,
    detail: `${category} · $${Number(cur.allotted).toLocaleString('en-US')} → $${allotted.toLocaleString('en-US')}`,
    changes: diffFields({ category: cur.category, allotted: Number(cur.allotted), notes: cur.notes },
                        { category, allotted, notes: pick(b, 'notes', cur.notes) },
                        { category: 'category', allotted: 'allotment', notes: 'notes' }) });
  res.json(dbToBudgetLine(r.rows[0]));
}));

router.delete('/budget-lines/:id', requireBudgetRights, asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM budget_lines WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  await pool.query('DELETE FROM budget_lines WHERE id=$1', [cur.id]);
  const job = await loadJob(cur.job_id);
  await logActivity(pool, { projectId: job ? job.project_id : null, jobId: cur.job_id,
    actor: req.actor, action: 'budget.line.delete', detail: cur.category,
    changes: [{ field: 'allotted', label: `${cur.category} allotment`,
                from: `$${Number(cur.allotted).toLocaleString('en-US')}`, to: null }] });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// EXPENSES
// ════════════════════════════════════════════════════════════════════════════
router.get('/expenses', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
  const showId = intOrNull(pick(req.query, 'show_id'));
  const jobId = intOrNull(pick(req.query, 'job_id'));
  if (showId) add('show_id=$?', showId);
  if (jobId) add('job_id=$?', jobId);
  if (req.query.status) add('status=$?', req.query.status);
  let q = 'SELECT * FROM expenses';
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  params.push(limitOf(req, 300, 2000));
  q += ` ORDER BY txn_date DESC NULLS LAST, id DESC LIMIT $${params.length}`;
  const r = await pool.query(q, params);
  res.json(r.rows.map(dbToExpense));
}));

router.post('/expenses', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const showId = intOrNull(pick(b, 'show_id'));
  const show = showId ? await loadShow(showId) : null;
  if (showId && !show) throw notFound('Show not found');
  if (show) {
    const project = await loadProject(show.project_id);
    if (!canEditProject(req.session, project)) throw forbidden('Not allowed to add expenses to this show');
  }
  const cat = BUDGET_CATS.includes(pick(b, 'category', pick(b, 'budget_line_category')))
    ? pick(b, 'category', pick(b, 'budget_line_category')) : 'misc';
  const txnDate = pick(b, 'txn_date') || todayISO();
  if (!isISODate(txnDate)) throw badRequest('txn_date must be YYYY-MM-DD');
  const r = await pool.query(
    `INSERT INTO expenses (show_id, project_id, job_id, budget_line_category, category, vendor,
       amount, txn_date, status, file_id, by, memo, match_confidence, match_reason, evidence_ref)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [showId, show ? show.project_id : intOrNull(pick(b, 'project_id')),
     intOrNull(pick(b, 'job_id')), cat, pick(b, 'vendor') || 'Vendor TBD',
     money(pick(b, 'amount'), 0), txnDate, oneOf(pick(b, 'status'), EXPENSE_STATUS, 'filed'),
     intOrNull(pick(b, 'file_id')), pick(b, 'by') || req.session.username, pick(b, 'memo') || '',
     money(pick(b, 'match_confidence'), null), pick(b, 'match_reason') || '',
     pick(b, 'evidence_ref') || '']);
  if (show) {
    await logActivity(pool, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'expense.add', detail: `${r.rows[0].vendor} · ${cat}` });
  }
  // Recording a cost with no doc attached puts it straight on accounting's
  // "waiting on me" list — so the actor gets to say who should know.
  await withTx(async (c) => notifyTargets(c, {
    body: b, anchorType: 'expense', anchorId: r.rows[0].id,
    projectId: show ? show.project_id : intOrNull(pick(b, 'project_id')),
    showId: show ? show.id : null, actor: req.actor,
    summary: `recorded a cost — ${r.rows[0].vendor} · ${cat} —`
  }));
  res.json(dbToExpense(r.rows[0]));
}));

router.put('/expenses/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM expenses WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  // H2. The ownership half used to run ONLY when the expense had a show, so a
  // folder-level or PO-generated cost — the ones with the biggest numbers on
  // them — was editable by any pm in the company. The predicate is now stated
  // once and answered for every shape the row can take: show → its project,
  // project → itself, neither (a pure job cost) → the job's project.
  const owningProject = await expenseProject(cur);
  if (owningProject && !canEditProject(req.session, owningProject)) {
    throw forbidden('Not allowed to edit this expense');
  }
  const b = req.body || {};
  const cat = has(b, 'category') || has(b, 'budget_line_category')
    ? (BUDGET_CATS.includes(pick(b, 'category', pick(b, 'budget_line_category')))
       ? pick(b, 'category', pick(b, 'budget_line_category')) : cur.budget_line_category)
    : cur.budget_line_category;
  const r = await pool.query(
    `UPDATE expenses SET vendor=$1, amount=$2, budget_line_category=$3, category=$3, status=$4,
       job_id=$5, txn_date=$6, file_id=$7, by=$8, memo=$9, match_confidence=$10, match_reason=$11,
       evidence_ref=$12 WHERE id=$13 RETURNING *`,
    [pick(b, 'vendor', cur.vendor), has(b, 'amount') ? money(pick(b, 'amount'), 0) : cur.amount,
     cat, oneOf(pick(b, 'status'), EXPENSE_STATUS, cur.status),
     has(b, 'job_id') ? intOrNull(pick(b, 'job_id')) : cur.job_id,
     pick(b, 'txn_date', cur.txn_date),
     has(b, 'file_id') ? intOrNull(pick(b, 'file_id')) : cur.file_id,
     pick(b, 'by', cur.by), pick(b, 'memo', cur.memo),
     has(b, 'match_confidence') ? money(pick(b, 'match_confidence'), null) : cur.match_confidence,
     pick(b, 'match_reason', cur.match_reason), pick(b, 'evidence_ref', cur.evidence_ref), cur.id]);
  // C4/F6. Creating a cost could notify and correcting one could not, and a
  // correction left no trace at all — for a finance persona that is
  // disqualifying: an amount that changed with no row saying so is
  // indistinguishable from an amount that was always wrong.
  const changes = diffFields(cur, r.rows[0], MATERIAL_EXPENSE_FIELDS);
  await logActivity(pool, {
    projectId: owningProject ? owningProject.id : null, showId: cur.show_id || null,
    jobId: r.rows[0].job_id || null, actor: req.actor, action: 'expense.update',
    accent: changes.some((ch) => ch.field === 'amount' || ch.field === 'status'),
    detail: changeSummary(changes, r.rows[0].vendor), changes });
  await withTx(async (c) => notifyTargets(c, {
    body: b, anchorType: 'expense', anchorId: cur.id,
    projectId: owningProject ? owningProject.id : null, showId: cur.show_id || null,
    actor: req.actor,
    summary: `corrected a cost — ${r.rows[0].vendor}${changes.length ? ' · ' + changeSummary(changes) : ''} —`
  }));
  res.json(dbToExpense(r.rows[0]));
}));

router.delete('/expenses/:id', requireRole('manager'), asyncH(async (req, res) => {
  const id = idParam(req);
  // H3-shaped: a delete that answers {ok:true} for an id that never existed
  // lets a stale screen report success for a no-op. Money especially.
  const cur = (await pool.query('SELECT * FROM expenses WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound(`expense ${id} not found`);
  const owningProject = await expenseProject(cur);
  await withTx(async (c) => {
    await c.query('UPDATE po_lines SET expense_id=NULL WHERE expense_id=$1', [id]);
    await c.query(`DELETE FROM notes WHERE anchor_type='expense' AND anchor_id=$1`, [id]);
    await c.query('DELETE FROM expenses WHERE id=$1', [id]);
    await logActivity(c, {
      projectId: owningProject ? owningProject.id : null, showId: cur.show_id || null,
      jobId: cur.job_id || null, actor: req.actor, action: 'expense.delete', accent: true,
      detail: `${cur.vendor || 'expense'} · $${Number(cur.amount || 0).toLocaleString('en-US')}`,
      changes: [{ field: 'amount', label: cur.vendor || 'expense',
                  from: `$${Number(cur.amount || 0).toLocaleString('en-US')}`, to: null }] });
    await notifyTargets(c, {
      body: req.body, anchorType: 'show',
      anchorId: cur.show_id || null,
      projectId: owningProject ? owningProject.id : null, showId: cur.show_id || null,
      actor: req.actor, summary: `voided a cost — ${cur.vendor || 'expense'} —`
    });
  });
  res.json({ ok: true });
}));

// The owning project of an expense, whatever shape the row is. One expression,
// so the gate cannot answer differently depending on which column happens to be
// populated (H2).
async function expenseProject(row) {
  if (!row) return null;
  if (row.show_id) {
    const show = await loadShow(row.show_id);
    return show ? loadProject(show.project_id) : null;
  }
  if (row.project_id) return loadProject(row.project_id);
  if (row.job_id) {
    const job = await loadJob(row.job_id);
    return job ? loadProject(job.project_id) : null;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// THE MONEY VIEWS
// ════════════════════════════════════════════════════════════════════════════
// Every rollup below resolves job attribution with COALESCE(x.job_id,
// shows.default_job_id) — the override rule, in SQL, once.

// committed tier (procurement): ordered/shipped PO lines sit between allotted
// and actual. `cogs` lines ride the job budget; `inventory` lines are E360
// capex and are NEVER a job cost.
async function committedForJob(jobId, q = pool) {
  const r = await q.query(
    `SELECT l.*, p.po_number, p.vendor, p.status AS po_status, p.expected_date
     FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id
     WHERE p.status = ANY($1::text[]) AND COALESCE(l.job_id, p.job_id) = $2`,
    [PO_COMMITTED, jobId]);
  const out = { total: 0, capex: 0, byCat: {}, lines: [] };
  for (const l of r.rows) {
    const t = Number(l.qty || 0) * Number(l.unit_cost || 0);
    if (l.ownership === 'inventory') out.capex += t;
    else { out.total += t; out.byCat[l.category] = (out.byCat[l.category] || 0) + t; }
    out.lines.push({ po: { id: l.po_id, po_number: l.po_number, vendor: l.vendor,
                           status: l.po_status, expected_date: l.expected_date },
                     line: { id: l.id, item: l.item, qty: Number(l.qty), unit_cost: Number(l.unit_cost),
                             category: l.category, ownership: l.ownership, total: t } });
  }
  return out;
}

// NOTE: GET /api/jobs/:id/committed is served by routes/purchasing.js, which
// owns purchase orders and returns the richer {po, line} pairs the UI wants.
// This function stays here because jobFinance() needs the same rollup inline.

// Everything the money views need to know about ONE job.
async function jobFinance(jobId, q = pool) {
  const jr = await q.query(`${JOB_SELECT} WHERE j.id=$1`, [jobId]);
  if (!jr.rows.length) return null;
  const job = jr.rows[0];

  const lines = (await q.query('SELECT * FROM budget_lines WHERE job_id=$1 ORDER BY id', [jobId])).rows;
  const exps = (await q.query(
    `SELECT e.*, s.name AS show_name, s.venue AS show_venue
     FROM expenses e LEFT JOIN shows s ON s.id = e.show_id
     WHERE COALESCE(e.job_id, s.default_job_id) = $1
     ORDER BY e.txn_date DESC NULLS LAST, e.id DESC`, [jobId])).rows;
  const docs = (await q.query(
    `SELECT f.*, s.name AS show_name FROM files f LEFT JOIN shows s ON s.id = f.show_id
     WHERE f.kind = ANY($2::text[]) AND f.status <> 'rejected'
       AND COALESCE(f.job_id, s.default_job_id) = $1
     ORDER BY f.created_at DESC, f.id DESC`, [jobId, FIN_KINDS])).rows;
  const shows = (await q.query(
    `SELECT DISTINCT s.* FROM shows s
     WHERE s.default_job_id=$1
        OR s.id IN (SELECT show_id FROM expenses WHERE job_id=$1 AND show_id IS NOT NULL)
     ORDER BY s.event_date, s.id`, [jobId])).rows;

  let actual = 0, proposedTotal = 0, proposedCount = 0;
  const byCat = {};
  for (const e of exps) {
    const amt = Number(e.amount || 0);
    if (e.status === 'proposed') { proposedTotal += amt; proposedCount += 1; }
    else { actual += amt; byCat[e.budget_line_category] = (byCat[e.budget_line_category] || 0) + amt; }
  }
  const cm = await committedForJob(jobId, q);

  const lineRows = lines.map((l) => ({
    category: l.category, allotted: Number(l.allotted || 0),
    actual: byCat[l.category] || 0, committed: cm.byCat[l.category] || 0,
    notes: l.notes || '', id: l.id
  }));
  const budgeted = new Set(lines.map((l) => l.category));
  const extra = new Set([...Object.keys(byCat), ...Object.keys(cm.byCat)].filter((c) => !budgeted.has(c)));
  const unbudgeted = [...extra].map((c) => ({
    category: c, allotted: 0, actual: byCat[c] || 0, committed: cm.byCat[c] || 0
  }));

  const budgetTotal = lines.reduce((a, l) => a + Number(l.allotted || 0), 0);
  const billed = Number(job.contract_value || 0);
  return {
    job: dbToJob(job), project_id: job.project_id,
    lines: lineRows, unbudgeted,
    budget_total: budgetTotal, actual,
    committed: cm.total, capexCommitted: cm.capex,
    proposedTotal, proposedCount,
    billed, margin: billed - actual,
    marginPct: billed ? (billed - actual) / billed * 100 : null,
    burnPct: budgetTotal ? actual / budgetTotal * 100 : null,
    expenses: exps.map((e) => ({ e: dbToExpense(e),
      show: e.show_id ? { id: e.show_id, name: e.show_name, venue: e.show_venue } : null })),
    docs: docs.map((f) => ({ f: dbToFile(f),
      show: f.show_id ? { id: f.show_id, name: f.show_name } : null })),
    shows: shows.map((s) => dbToShow(s))
  };
}

router.get('/jobs/:id/finance', asyncH(async (req, res) => {
  const jf = await jobFinance(idParam(req));
  if (!jf) throw notFound('Job not found');
  res.json(stripMargin(jf, req.session));
}));

// ── "waiting on me": booked/ordered money with no doc on file ───────────────
async function financeExceptions(q = pool) {
  const out = [];
  // 19. bookings that are committed (done/in_progress) with money or a booked
  // date, and no confirmation attached.
  const bk = await q.query(
    `SELECT b.*, s.name AS show_name, s.owner AS show_owner, s.default_job_id, s.project_id
     FROM bookings b JOIN shows s ON s.id = b.show_id
     WHERE b.file_id IS NULL AND b.status IN ('done','in_progress')
       AND (b.amount IS NOT NULL OR b.booked_date IS NOT NULL)`);
  for (const b of bk.rows) {
    out.push({ kind: 'booking', id: b.id,
      show: { id: b.show_id, name: b.show_name, project_id: b.project_id },
      label: b.category, vendor: b.vendor, amount: b.amount == null ? null : Number(b.amount),
      category: null, job_id: b.job_id || b.default_job_id || null,
      age: dayAge(b.booked_date), chase: b.show_owner, missing: 'confirmation' });
  }
  // 27. expenses with no evidence doc. A PO-generated actual is EXCLUDED —
  // its PO carries that exception, never both.
  const ex = await q.query(
    `SELECT e.*, s.name AS show_name, s.owner AS show_owner, s.default_job_id
     FROM expenses e LEFT JOIN shows s ON s.id = e.show_id
     WHERE e.file_id IS NULL AND e.status <> 'proposed' AND e.po_id IS NULL`);
  for (const e of ex.rows) {
    out.push({ kind: 'expense', id: e.id,
      show: e.show_id ? { id: e.show_id, name: e.show_name, project_id: e.project_id } : null,
      label: e.vendor, vendor: e.vendor, amount: Number(e.amount || 0),
      category: e.budget_line_category, job_id: e.job_id || e.default_job_id || null,
      age: dayAge(e.txn_date), chase: e.by || e.show_owner, missing: 'receipt' });
  }
  // ordered/shipped/received POs with no vendor invoice on file
  const po = await q.query(
    `SELECT p.*, COALESCE(t.total,0) AS total FROM purchase_orders p
     LEFT JOIN (SELECT po_id, SUM(qty*unit_cost) AS total FROM po_lines GROUP BY po_id) t
       ON t.po_id = p.id
     WHERE p.invoice_file_id IS NULL AND p.status IN ('ordered','shipped','received')`);
  for (const p of po.rows) {
    out.push({ kind: 'po', id: p.id, show: null,
      label: `${p.po_number} · ${p.vendor}`, vendor: p.vendor, amount: Number(p.total || 0),
      category: null, job_id: p.job_id || null,
      age: dayAge(p.received_date || p.ordered_date), chase: p.created_by, missing: 'invoice' });
  }
  // POLISH_LIST #5. A job still carrying a TEMP placeholder is only Candice's
  // problem once something is RIDING on it — a cost, a PO line, or any activity
  // row. A temp job nobody has touched is just an early folder and stays quiet.
  // "Riding on it" excludes the job's OWN creation row — every job has one of
  // those, and a folder opened this morning is not yet a chase.
  const tmp = await q.query(
    `SELECT j.id, j.qb_job_number, j.client, j.name, j.project_id,
            to_char(j.created_at, 'YYYY-MM-DD') AS created_day,
            p.name AS project_name,
            (SELECT COUNT(*) FROM expenses WHERE job_id = j.id)
          + (SELECT COUNT(*) FROM po_lines WHERE job_id = j.id)
          + (SELECT COUNT(*) FROM budget_lines WHERE job_id = j.id)
          + (SELECT COUNT(*) FROM activity
              WHERE job_id = j.id AND action <> 'job.create') AS touches
     FROM jobs j LEFT JOIN projects p ON p.id = j.project_id
     WHERE j.qb_number_status = 'temp'`);
  for (const j of tmp.rows) {
    if (parseInt(j.touches, 10) <= 0) continue;
    out.push({ kind: 'job_number', id: j.id, show: null,
      label: `${j.qb_job_number} · ${j.client || j.project_name || j.name}`,
      vendor: null, amount: null, category: null, job_id: j.id,
      age: dayAge(j.created_day), chase: 'candice',
      missing: 'a QB job number — Candice' });
  }
  out.sort((a, b) => (b.age || 0) - (a.age || 0));
  return out;
}

router.get('/finance/exceptions', asyncH(async (req, res) => {
  res.json(await financeExceptions());
}));

// ── the money feed. An expense WITH an evidence doc reports ONCE, as its doc ──
async function financeFeed(q = pool, limit = 120) {
  const evs = [];
  const docs = await q.query(
    `SELECT f.*, s.name AS show_name FROM files f LEFT JOIN shows s ON s.id = f.show_id
     WHERE f.kind = ANY($1::text[]) AND f.status <> 'rejected'
     ORDER BY f.created_at DESC LIMIT $2`, [FIN_KINDS, limit]);
  for (const f of docs.rows) {
    evs.push({ type: 'doc', ts: f.created_at, id: f.id, file: dbToFile(f),
               show: f.show_id ? { id: f.show_id, name: f.show_name } : null });
  }
  const exps = await q.query(
    `SELECT e.*, s.name AS show_name FROM expenses e LEFT JOIN shows s ON s.id = e.show_id
     WHERE e.file_id IS NULL ORDER BY e.txn_date DESC NULLS LAST, e.id DESC LIMIT $1`, [limit]);
  for (const e of exps.rows) {
    evs.push({ type: 'expense', ts: e.txn_date, id: e.id, exp: dbToExpense(e),
               show: e.show_id ? { id: e.show_id, name: e.show_name } : null });
  }
  const bks = await q.query(
    `SELECT b.*, s.name AS show_name FROM bookings b JOIN shows s ON s.id = b.show_id
     WHERE b.booked_date IS NOT NULL AND b.status='done'
     ORDER BY b.booked_date DESC LIMIT $1`, [limit]);
  for (const b of bks.rows) {
    evs.push({ type: 'booking', ts: b.booked_date, id: b.id, bk: dbToBooking(b),
               show: { id: b.show_id, name: b.show_name } });
  }
  // an ORDERED PO is a money event: committed spend enters the record
  const pos = await q.query(
    `SELECT p.*, COALESCE(t.total,0) AS total FROM purchase_orders p
     LEFT JOIN (SELECT po_id, SUM(qty*unit_cost) AS total FROM po_lines GROUP BY po_id) t
       ON t.po_id = p.id
     WHERE p.ordered_date IS NOT NULL ORDER BY p.ordered_date DESC LIMIT $1`, [limit]);
  for (const p of pos.rows) {
    evs.push({ type: 'po', ts: p.ordered_date, id: 9000 + p.id,
               po: { ...dbToPO(p), total: Number(p.total || 0) } });
  }
  // 21. budget-line changes are money events too, read straight off `activity`.
  const budget = await q.query(
    `SELECT * FROM activity WHERE action LIKE 'budget.line.%'
     ORDER BY created_at DESC LIMIT $1`, [limit]);
  for (const a of budget.rows) {
    evs.push({ type: 'budget', ts: a.created_at, id: a.id, ev: dbToActivity(a), show: null });
  }
  evs.sort((a, b) => {
    const at = String(a.ts instanceof Date ? a.ts.toISOString() : a.ts || '');
    const bt = String(b.ts instanceof Date ? b.ts.toISOString() : b.ts || '');
    return at < bt ? 1 : at > bt ? -1 : b.id - a.id;
  });
  return evs.slice(0, limit);
}

router.get('/finance/feed', asyncH(async (req, res) => {
  res.json(await financeFeed(pool, limitOf(req, 120, 500)));
}));

// ── headline numbers ────────────────────────────────────────────────────────
async function financeStats(q = pool) {
  const exc = await financeExceptions(q);
  const excAmount = exc.reduce((a, x) => a + (x.amount || 0), 0);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const d = await q.query(
    `SELECT COUNT(*) FILTER (WHERE created_at >= $2) AS week,
            COUNT(*) FILTER (WHERE status='proposed') AS proposed
     FROM files WHERE kind = ANY($1::text[]) AND status <> 'rejected'`, [FIN_KINDS, weekAgo]);
  const a = await q.query(
    `SELECT COALESCE(SUM(amount),0) AS actual FROM expenses WHERE status <> 'proposed'`);
  const j = await q.query(
    `SELECT COALESCE(SUM(contract_value),0) AS billed FROM jobs`);
  const bl = await q.query(`SELECT COALESCE(SUM(allotted),0) AS budgeted FROM budget_lines`);
  const cm = await q.query(
    `SELECT COALESCE(SUM(l.qty*l.unit_cost) FILTER (WHERE l.ownership='cogs'),0) AS committed,
            COALESCE(SUM(l.qty*l.unit_cost) FILTER (WHERE l.ownership='inventory'),0) AS capex
     FROM po_lines l JOIN purchase_orders p ON p.id=l.po_id WHERE p.status = ANY($1::text[])`,
    [PO_COMMITTED]);
  const actual = Number(a.rows[0].actual);
  const billed = Number(j.rows[0].billed);
  return {
    exceptions: exc.length, excAmount,
    docsWeek: parseInt(d.rows[0].week, 10), proposed: parseInt(d.rows[0].proposed, 10),
    actual, budgeted: Number(bl.rows[0].budgeted), billed,
    committed: Number(cm.rows[0].committed), capex: Number(cm.rows[0].capex),
    margin: billed - actual, marginPct: billed ? (billed - actual) / billed * 100 : null
  };
}

router.get('/finance/stats', asyncH(async (req, res) => {
  res.json(stripMargin(await financeStats(), req.session));
}));

// One call for the Finance view — stats + chase list + feed + every job.
router.get('/finance/overview', asyncH(async (req, res) => {
  const jobsR = await pool.query(`${JOB_SELECT} ORDER BY j.id`);
  const jobs = [];
  for (const row of jobsR.rows) {
    const jf = await jobFinance(row.id);
    if (jf) jobs.push(stripMargin(jf, req.session));
  }
  res.json({
    stats: stripMargin(await financeStats(), req.session),
    exceptions: await financeExceptions(),
    feed: await financeFeed(pool, limitOf(req, 120, 500)),
    jobs
  });
}));

module.exports = router;
module.exports.jobFinance = jobFinance;
module.exports.financeExceptions = financeExceptions;
module.exports.financeStats = financeStats;
module.exports.committedForJob = committedForJob;
