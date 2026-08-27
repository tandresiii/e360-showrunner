// ════════════════════════════════════════════════════════════════════════════
// routes/purchasing.js — purchase orders, their lines, and the approval gate
// ────────────────────────────────────────────────────────────────────────────
// Punch-list 25–30. public/data.js (the purchasing block, ~line 1234) is the
// behavioural spec; public/api.js's PURCHASING section is the wire contract.
// Every rollup below is a SQL-backed port of one of those pure helpers.
//
// THE BUDGET MECHANIC — the whole reason this module exists:
//
//   needed → quoted → ordered → shipped → received → reconciled
//                     └────────┬───────┘   └────┬───┘
//                          COMMITTED          ACTUAL
//
//   · ORDERED / SHIPPED = COMMITTED. The money is promised but not yet spent;
//     it rides the job budget between `allotted` and `actual`.
//   · RECEIVED = ACTUAL. cogs lines generate `expenses` rows at that moment
//     (and only once — a line that already carries an expense_id is skipped,
//     so reconciled history never double-counts).
//   · ownership 'cogs'      -> a JOB COST. Lands on the job's budget category.
//   · ownership 'inventory' -> E360 CAPEX. The gear stays ours (rental deals
//     keep the kit), so it is tracked as "→ inventory" spend on the PO and in
//     the purchasing stats, and NEVER as a job cost.
//
// THE GATE (28 · Tom's decision 2026-08-21, supersedes manager+): a PO whose
// total exceeds `po_approval_threshold` (config, default 5000) cannot leave
// 'quoted' without an approval.approved_by. Approvers are the ADMINS (Tom ·
// Tony · Jim) and CANDICE via the finance capability — canApprovePO(), not the
// generic manager+ predicate. A manager without finance runs shows, not spend.
//
// House rules honoured here: no SQL foreign keys (joins are plain integer
// columns), every multi-row write inside withTx(), money coerced through
// money()/num() and never trusted raw off the body, responses in snake_case
// via the dbTo* mappers, request bodies read through pick() so both spellings
// work, and every mutating route writes an activity row + accepts an optional
// notify[] list (the notification principle: the actor picks who hears about
// it; routine edits stay silent).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const router = express.Router();

const {
  PO_STATUSES, PO_COMMITTED, PO_OWNERSHIP, BUDGET_CATS,
  oneOf, money, num, isoDiffDays, isISODate, todayISO
} = require('../lib/enums');
const {
  pool, withTx, loadProject, loadShow, loadJob, loadRow,
  deletePoCascade, getConfig, setConfig
} = require('../lib/db');
const {
  pick, has, dbToPO, dbToPOLine, dbToExpense, dbToShow, dbToActivity
} = require('../lib/mappers');
const {
  asyncH, badRequest, forbidden, notFound, conflict, idParam, limitOf
} = require('../lib/http');
const {
  requireAuth, requireRole, canEditProject, canApprovePO, hasFinance
} = require('../lib/auth');
const { logActivity } = require('../lib/activity');
const { notifyTargets } = require('../lib/mentions');

// server.js mounts this router at /api and does NOT pre-apply auth, so every
// route below carries requireAuth itself. Deliberately per-route rather than
// router.use(): this router shares the /api mount point with the others, and a
// router-level guard here would 401 requests (login, health) that merely pass
// through on their way to a later router.

const THRESHOLD_KEY = 'po_approval_threshold';
const THRESHOLD_DEFAULT = 5000;
const ACTIVITY_CAP = 25;

// PO_STATUS_META labels, server-side (the front-end copy is presentation only).
const STATUS_LABEL = {
  needed: 'Needed', quoted: 'Quoted', ordered: 'Ordered',
  shipped: 'Shipped', received: 'Received', reconciled: 'Reconciled'
};
// lines are a commitment the moment a PO is ordered — edits stop here.
const LINE_EDITABLE = ['needed', 'quoted'];

// ════════════════════════════════════════════════════════════════════════════
// PURE ROLLUPS — ports of the public/data.js helpers. They operate on MAPPED
// records (dbToPO / dbToPOLine), so qty and unit_cost are already Numbers.
// ════════════════════════════════════════════════════════════════════════════

// poLineTotal
function lineTotal(l) { return num(l.qty, 0) * num(l.unit_cost, 0); }
// poTotal — the PO record carries its own lines[]
function poTotal(po) { return (po.lines || []).reduce((a, l) => a + lineTotal(l), 0); }
// poLineJobId — a null line job inherits the PO's default allocation
function lineJobId(l, po) { return l.job_id || (po && po.job_id) || null; }
// poNeedsApproval
function poNeedsApproval(po, threshold) {
  return poTotal(po) > threshold && !(po.approval && po.approval.approved_by);
}
// poUnreconciled — committed-or-landed money with no vendor invoice on file
function poUnreconciled(po) {
  return (po.status === 'ordered' || po.status === 'shipped' || po.status === 'received')
    && !po.invoice_file_id;
}
// poShowsLinked — season-wide lines (show_id null) pin to no load-in, so only
// lines with an explicit show carry delivery risk.
function linkedShowIds(po) {
  const seen = [];
  for (const l of po.lines || []) {
    if (l.show_id && !seen.includes(l.show_id)) seen.push(l.show_id);
  }
  return seen;
}
// poRiskForShow — the killer feature: hardware landing after (or hair-close to)
// a load-in. `show` is a raw shows row or a mapped show record; both carry
// load_in_date.
function poRiskForShow(po, show) {
  if (!show || !show.load_in_date) return null;
  if (po.status === 'received' || po.status === 'reconciled') return null;
  const li = show.load_in_date;
  if (po.expected_date) {
    const gap = isoDiffDays(po.expected_date, li);      // load-in minus expected
    if (gap == null) return null;
    if (gap < 0) return { level: 'crit', days: -gap, why: `lands ${-gap}d after load-in` };
    if (gap <= 5) return { level: 'warn', days: gap, why: `T−${gap}d before load-in` };
    return null;
  }
  const d = isoDiffDays(todayISO(), li);                 // no ETA at all
  if (d != null && d >= 0 && d <= 5) return { level: 'warn', days: d, why: `no ETA · load-in in ${d}d` };
  return null;
}
// poRisks, against a Map of show rows
function poRisks(po, showMap) {
  const out = [];
  for (const sid of linkedShowIds(po)) {
    const row = showMap.get(sid);
    if (!row) continue;
    const r = poRiskForShow(po, row);
    if (r) out.push({ po, show: dbToShow(row), level: r.level, why: r.why, days: r.days });
  }
  return out;
}
// listAllPoRisks ordering: crit first, then by the show's load-in date.
function sortRisks(a, b) {
  if (a.level !== b.level) return a.level === 'crit' ? -1 : 1;
  const la = a.show.load_in_date || '', lb = b.show.load_in_date || '';
  return la < lb ? -1 : la > lb ? 1 : 0;
}
// purchasingStats
function purchasingStats(pos, risks, threshold) {
  let open = 0, committed = 0, capex = 0, pipeline = 0;
  let awaiting = 0, awaitingAmount = 0, unreconciled = 0, unreconciledAmount = 0;
  const needs = new Set();
  const riskyPo = new Set(risks.map((r) => r.po.id));
  for (const po of pos) {
    const t = poTotal(po);
    if (po.status !== 'reconciled') open += 1;
    if (PO_COMMITTED.includes(po.status)) {
      for (const l of po.lines || []) {
        if (l.ownership === 'inventory') capex += lineTotal(l); else committed += lineTotal(l);
      }
    }
    if (po.status === 'needed' || po.status === 'quoted') pipeline += t;
    if (po.status === 'quoted' && poNeedsApproval(po, threshold)) {
      awaiting += 1; awaitingAmount += t; needs.add(po.id);
    }
    if (poUnreconciled(po)) { unreconciled += 1; unreconciledAmount += t; needs.add(po.id); }
    if (riskyPo.has(po.id)) needs.add(po.id);
  }
  const crit = risks.filter((r) => r.level === 'crit').length;
  return {
    open, committed: money(committed, 0), capex: money(capex, 0), pipeline: money(pipeline, 0),
    awaiting, awaitingAmount: money(awaitingAmount, 0),
    risks: risks.length, riskCrit: crit, riskWarn: risks.length - crit,
    unreconciled, unreconciledAmount: money(unreconciledAmount, 0),
    needsAction: needs.size
  };
}

// ════════════════════════════════════════════════════════════════════════════
// LOADERS
// ════════════════════════════════════════════════════════════════════════════

async function poThreshold(q = pool) {
  return num(await getConfig(THRESHOLD_KEY, String(THRESHOLD_DEFAULT), q), THRESHOLD_DEFAULT);
}
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US');

// Hydrate PO rows with their lines and (optionally) their newest activity.
async function hydrate(q, rows, { activity = true } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const byPo = new Map(ids.map((id) => [id, []]));
  const actBy = new Map(ids.map((id) => [id, []]));

  const lines = await q.query(
    'SELECT * FROM po_lines WHERE po_id = ANY($1::int[]) ORDER BY id', [ids]);
  for (const l of lines.rows) (byPo.get(l.po_id) || []).push(dbToPOLine(l));

  if (activity) {
    // newest ACTIVITY_CAP rows PER PO in one round trip
    const a = await q.query(
      `SELECT * FROM (
         SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.po_id
                                        ORDER BY a.created_at DESC, a.id DESC) AS rn
         FROM activity a WHERE a.po_id = ANY($1::int[])
       ) t WHERE t.rn <= ${ACTIVITY_CAP} ORDER BY t.po_id, t.rn`, [ids]);
    for (const r of a.rows) (actBy.get(r.po_id) || []).push(dbToActivity(r));
  }
  return rows.map((r) => dbToPO(r, { lines: byPo.get(r.id) || [], activity: actBy.get(r.id) || [] }));
}

async function loadPO(id, q = pool, opts) {
  const r = await q.query('SELECT * FROM purchase_orders WHERE id=$1', [id]);
  if (!r.rows.length) throw notFound(`PO ${id} not found`);
  return (await hydrate(q, r.rows, opts))[0];
}

// The shows referenced by any line on these POs (risk needs their load-in dates).
async function showMapFor(q, pos) {
  const ids = [];
  for (const po of pos) for (const sid of linkedShowIds(po)) if (!ids.includes(sid)) ids.push(sid);
  if (!ids.length) return new Map();
  const r = await q.query('SELECT * FROM shows WHERE id = ANY($1::int[])', [ids]);
  return new Map(r.rows.map((s) => [s.id, s]));
}

// poPrimaryShow — a linked show wins; else the show this PO's job is the
// default allocation for; else the project's first show.
async function primaryShow(q, po) {
  const linked = linkedShowIds(po);
  if (linked.length) return loadShow(linked[0], q);
  if (po.job_id) {
    const r = await q.query('SELECT * FROM shows WHERE default_job_id=$1 ORDER BY id LIMIT 1', [po.job_id]);
    if (r.rows.length) return r.rows[0];
  }
  if (po.project_id) {
    const r = await q.query('SELECT * FROM shows WHERE project_id=$1 ORDER BY id LIMIT 1', [po.project_id]);
    if (r.rows.length) return r.rows[0];
  }
  return null;
}
// poLineShowResolved — which show an expense generated from this line belongs to.
async function lineShow(q, po, line) {
  if (line.show_id) return loadShow(line.show_id, q);
  const jid = lineJobId(line, po);
  if (jid) {
    const r = await q.query('SELECT * FROM shows WHERE default_job_id=$1 ORDER BY id LIMIT 1', [jid]);
    if (r.rows.length) return r.rows[0];
  }
  if (po.project_id) {
    const r = await q.query('SELECT * FROM shows WHERE project_id=$1 ORDER BY id LIMIT 1', [po.project_id]);
    if (r.rows.length) return r.rows[0];
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// GATES + SHARED WRITE HELPERS
// ════════════════════════════════════════════════════════════════════════════

// pm+ : manager and above edit anything, a pm edits only projects they own.
async function assertCanEdit(req, po, q = pool) {
  const project = po.project_id ? await loadProject(po.project_id, q) : null;
  if (!canEditProject(req.session, project)) {
    throw forbidden(`${po.po_number} belongs to a project you do not own — pm (owner) or manager+ required`);
  }
  return project;
}

// The notification principle. `notify: ['candice', …]` lands a one-line system
// note anchored on the PO plus the note_mentions rows the inbox reads.
// Unknown usernames are a 400 — never silently dropped.
//
// HARDENING 10: this WAS a fourth copy of the mechanism. The mechanism now
// lives in lib/mentions.js; all that was ever purchasing-specific is the anchor
// (the PO) and the "· cc" wording, which is what remains here.
async function notifyFrom(c, req, { po, summary, anchorType = 'po', anchorId = null }) {
  return notifyTargets(c, {
    body: req.body,
    anchorType,
    anchorId: anchorId != null ? anchorId : po.id,
    projectId: po.project_id || null,
    actor: req.session.username,
    summary,
    format: (line, mentions) => `${line} · cc ${mentions.map((u) => '@' + u).join(' ')}`
  });
}

// Validate an optional FK-by-convention id against its table.
async function assertRow(table, id, q, label) {
  if (id == null) return null;
  const row = await loadRow(table, id, q);
  if (!row) throw badRequest(`${label} ${id} not found`);
  return row;
}
function readCategory(body, fallback) {
  if (!has(body, 'category')) return fallback;
  const c = String(pick(body, 'category') || '');
  if (!BUDGET_CATS.includes(c)) throw badRequest(`category must be one of ${BUDGET_CATS.join(', ')}`);
  return c;
}
function readOwnership(body) {
  if (!has(body, 'ownership')) return null;
  const o = pick(body, 'ownership');
  if (o === null || o === '') return null;
  if (!PO_OWNERSHIP.includes(o)) throw badRequest(`ownership must be one of ${PO_OWNERSHIP.join(', ')}`);
  return o;
}
function readISODate(body, key) {
  const v = pick(body, key);
  if (v === null || v === '' || v === undefined) return null;
  if (!isISODate(v)) throw badRequest(`${key} must be a YYYY-MM-DD date`);
  return String(v);
}
// deriveOwnership: a SALE keeps nothing — the client buys the gear, so it is a
// cost of goods. Anything else (rental, or no job at all) stays E360 inventory.
async function deriveOwnership(q, jobId) {
  const job = jobId ? await loadJob(jobId, q) : null;
  return job && job.deal_type === 'sale' ? 'cogs' : 'inventory';
}

// PO-{YY}-{NNN}, next free number for the current year.
//
// The max is taken NUMERICALLY, off the parsed suffix. Ordering by the string
// would put PO-26-999 above PO-26-1000 and re-issue a number already on the
// books — the agent surface had exactly that bug (hardening 4) and now shares
// this function instead of carrying its own copy.
async function nextPoNumber(q) {
  const yy = todayISO().slice(2, 4);
  const r = await q.query(
    `SELECT po_number FROM purchase_orders WHERE po_number LIKE $1`, [`PO-${yy}-%`]);
  const taken = new Set(r.rows.map((x) => x.po_number));
  let max = 0;
  for (const x of r.rows) {
    const m = /^PO-\d{2}-(\d+)$/.exec(x.po_number || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  let candidate = `PO-${yy}-${String(n).padStart(3, '0')}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `PO-${yy}-${String(n).padStart(3, '0')}`;
  }
  return candidate;
}

// Insert a purchase order, surviving a lost race for its number (hardening 4).
//
// nextPoNumber() reads, then the caller writes; two requests interleaving there
// compute the SAME number and the po_number unique index refuses the second.
// That is CONTENTION, not a bad request, and it used to surface as a raw 500.
//
// Retrying inside an open transaction needs a SAVEPOINT: a failed statement
// poisons the whole transaction, so without one the retry would just hit
// "current transaction is aborted". We roll back to the savepoint, ask for the
// next number again — the loser now SEES the winner's row — and re-insert.
//
// A number the CALLER supplied is never retried: they asked for that number
// specifically, so a duplicate is a 409 they need to hear about, not something
// to silently renumber.
const PO_NUMBER_TRIES = 5;
async function insertPO(c, { supplied = '', insert }) {
  if (supplied) {
    const dup = await c.query('SELECT id FROM purchase_orders WHERE po_number=$1', [supplied]);
    if (dup.rows.length) throw conflict(`${supplied} already exists`);
    try {
      return await insert(supplied);
    } catch (e) {
      if (e && e.code === '23505') throw conflict(`${supplied} already exists`);
      throw e;
    }
  }
  for (let attempt = 0; attempt < PO_NUMBER_TRIES; attempt += 1) {
    const poNumber = await nextPoNumber(c);
    await c.query('SAVEPOINT po_number_try');
    try {
      const row = await insert(poNumber);
      await c.query('RELEASE SAVEPOINT po_number_try');
      return row;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT po_number_try');
      if (!e || e.code !== '23505') throw e;
    }
  }
  throw conflict('could not allocate a PO number — too many concurrent writes, try again');
}

// received: cogs lines with no expense yet become actuals. Inventory lines
// generate nothing — capex, not a job cost.
async function generateExpenses(c, po) {
  const made = [];
  for (const l of po.lines || []) {
    if (l.expense_id || l.ownership !== 'cogs') continue;
    const show = await lineShow(c, po, l);
    if (!show) continue;                       // nowhere to file it — skip, never guess
    const jid = lineJobId(l, po);
    const r = await c.query(
      `INSERT INTO expenses (show_id, project_id, job_id, budget_line_category, category,
                             vendor, amount, txn_date, status, file_id, po_id, by, memo)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'filed',$8,$9,$10,$11) RETURNING *`,
      [show.id, show.project_id || null,
       jid && jid !== show.default_job_id ? jid : null,   // null = inherit the show's default job
       l.category || 'misc', po.vendor || '', money(lineTotal(l), 0), todayISO(),
       po.invoice_file_id || null, po.id, po.created_by || '', `${po.po_number} received`]);
    const exp = r.rows[0];
    await c.query('UPDATE po_lines SET expense_id=$1 WHERE id=$2', [exp.id, l.id]);
    l.expense_id = exp.id;
    made.push(dbToExpense(exp));
  }
  return made;
}

// ════════════════════════════════════════════════════════════════════════════
// READ ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/pos?status=&projectId=&jobId=&showId=   (api.js listPOs)
router.get('/pos', requireAuth, asyncH(async (req, res) => {
  const rawStatus = req.query.status || '';
  const status = rawStatus ? oneOf(String(rawStatus), PO_STATUSES, null) : null;
  if (rawStatus && !status) throw badRequest(`unknown PO status "${rawStatus}"`);
  const projectId = num(req.query.projectId != null ? req.query.projectId : req.query.project_id, null);
  const jobId = num(req.query.jobId != null ? req.query.jobId : req.query.job_id, null);
  const showId = num(req.query.showId != null ? req.query.showId : req.query.show_id, null);

  const params = [];
  const P = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];
  if (status) where.push(`p.status = ${P(status)}`);
  if (projectId) where.push(`p.project_id = ${P(projectId)}`);
  // a line's job is its own job_id, or the PO's default allocation
  if (jobId) {
    where.push(`EXISTS (SELECT 1 FROM po_lines l
                        WHERE l.po_id = p.id AND COALESCE(l.job_id, p.job_id) = ${P(jobId)})`);
  }
  if (showId) {
    where.push(`EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id = p.id AND l.show_id = ${P(showId)})`);
  }
  const sql = `SELECT p.* FROM purchase_orders p
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY p.id LIMIT ${P(limitOf(req, 200, 500))}`;
  const r = await pool.query(sql, params);
  res.json(await hydrate(pool, r.rows));
}));

// GET /api/pos/:id   (api.js getPO)
router.get('/pos/:id', requireAuth, asyncH(async (req, res) => {
  res.json(await loadPO(idParam(req), pool));
}));

// GET /api/purchasing/overview — one call for the Purchasing view.
// {stats, pos, risks, approvals}  (api.js getPurchasingOverview)
router.get('/purchasing/overview', requireAuth, asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM purchase_orders ORDER BY id');
  const pos = await hydrate(pool, r.rows);
  const showMap = await showMapFor(pool, pos);
  const risks = pos.flatMap((po) => poRisks(po, showMap)).sort(sortRisks);
  const t = await poThreshold();
  res.json({
    stats: purchasingStats(pos, risks, t),
    pos,
    risks,
    approvals: pos.filter((po) => po.status === 'quoted' && poNeedsApproval(po, t))
  });
}));

// GET /api/procurement/risks   (api.js listProcurementRisks -> listAllPoRisks)
router.get('/procurement/risks', requireAuth, asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM purchase_orders ORDER BY id');
  const pos = await hydrate(pool, r.rows);
  const showMap = await showMapFor(pool, pos);
  res.json(pos.flatMap((po) => poRisks(po, showMap)).sort(sortRisks));
}));

// GET /api/shows/:id/procurement-risks — the show drill-in's strip.
router.get('/shows/:id/procurement-risks', requireAuth, asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound(`show ${showId} not found`);
  const r = await pool.query(
    `SELECT p.* FROM purchase_orders p
     WHERE EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id = p.id AND l.show_id = $1)
     ORDER BY p.id`, [showId]);
  const pos = await hydrate(pool, r.rows);
  const out = [];
  for (const po of pos) {
    const risk = poRiskForShow(po, show);
    if (risk) out.push({ po, show: dbToShow(show), level: risk.level, why: risk.why, days: risk.days });
  }
  out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'crit' ? -1 : 1));
  res.json(out);
}));

// GET /api/jobs/:id/committed — committedForJob(): cogs -> budget committed,
// inventory -> E360 capex (never a job cost).   (api.js listCommitted)
router.get('/jobs/:id/committed', requireAuth, asyncH(async (req, res) => {
  const jobId = idParam(req);
  const job = await loadJob(jobId);
  if (!job) throw notFound(`job ${jobId} not found`);
  const r = await pool.query(
    `SELECT p.* FROM purchase_orders p
     WHERE p.status = ANY($1::text[])
       AND EXISTS (SELECT 1 FROM po_lines l
                   WHERE l.po_id = p.id AND COALESCE(l.job_id, p.job_id) = $2)
     ORDER BY p.id`, [PO_COMMITTED, jobId]);
  const pos = await hydrate(pool, r.rows, { activity: false });

  const out = { total: 0, capex: 0, byCat: {}, lines: [] };
  for (const po of pos) {
    for (const line of po.lines || []) {
      if (lineJobId(line, po) !== jobId) continue;
      const t = lineTotal(line);
      if (line.ownership === 'inventory') out.capex += t;
      else {
        out.total += t;
        out.byCat[line.category] = money((out.byCat[line.category] || 0) + t, 0);
      }
      out.lines.push({ po, line });
    }
  }
  out.total = money(out.total, 0);
  out.capex = money(out.capex, 0);
  res.json(out);
}));

// ── 28. the threshold, read + written server-side ───────────────────────────
// GET is open to any signed-in user: every PO card renders the approval chip
// off this number. Writing it is admin-or-finance.
router.get('/config/po-approval-threshold', requireAuth, asyncH(async (req, res) => {
  res.json({ key: THRESHOLD_KEY, value: await poThreshold() });
}));

router.put('/config/po-approval-threshold', requireAuth, asyncH(async (req, res) => {
  if (!hasFinance(req.session)) {
    throw forbidden('Changing the PO approval threshold sits with the admins and Candice (finance)');
  }
  const raw = has(req.body, 'value') ? pick(req.body, 'value') : pick(req.body, 'threshold');
  const value = money(raw, null);
  if (value == null || value < 0) throw badRequest('value must be a non-negative number');
  const before = await poThreshold();
  await setConfig(THRESHOLD_KEY, String(value), req.actor);
  await logActivity(pool, {
    actor: req.actor, action: 'config.update', accent: true,
    detail: `PO approval threshold ${usd(before)} → ${usd(value)}`
  });
  res.json({ key: THRESHOLD_KEY, value });
}));

// ════════════════════════════════════════════════════════════════════════════
// WRITE ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/pos — pm+. Lands 'needed'.   (api.js createPO)
router.post('/pos', requireAuth, requireRole('pm'), asyncH(async (req, res) => {
  const projectId = num(pick(req.body, 'project_id'), null);
  const project = projectId ? await loadProject(projectId) : null;
  if (!project) throw badRequest(`project ${pick(req.body, 'project_id')} not found`);
  if (!canEditProject(req.session, project)) {
    throw forbidden('You may only open POs on projects you own (pm) — manager+ otherwise');
  }
  const jobId = num(pick(req.body, 'job_id'), null);
  if (jobId) await assertRow('jobs', jobId, pool, 'job');

  const vendor = String(pick(req.body, 'vendor') || 'TBD').slice(0, 200);
  const memo = String(pick(req.body, 'memo') || '');
  const expected = readISODate(req.body, 'expected_date');
  const provenance = pick(req.body, 'provenance') || null;
  const sourceRef = pick(req.body, 'source_ref') || null;
  const supplied = pick(req.body, 'po_number');

  const po = await withTx(async (c) => {
    const row = await insertPO(c, {
      supplied: supplied ? String(supplied).trim().slice(0, 40) : '',
      insert: async (poNumber) => (await c.query(
        `INSERT INTO purchase_orders (po_number, vendor, project_id, job_id, status, created_by,
                                      expected_date, memo, provenance, source_ref)
         VALUES ($1,$2,$3,$4,'needed',$5,$6,$7,$8,$9) RETURNING *`,
        [poNumber, vendor, project.id, jobId, req.actor, expected, memo,
         provenance ? JSON.stringify(provenance) : null, sourceRef])).rows[0]
    });
    const poNumber = row.po_number;
    const summary = `opened ${poNumber} for ${vendor}`;
    await logActivity(c, {
      projectId: project.id, poId: row.id, jobId, actor: req.actor, action: 'po.create',
      detail: `${summary} — needed, add lines then quote it out`,
      provenance: provenance || null
    });
    await notifyFrom(c, req, { po: { id: row.id, project_id: project.id }, summary });
    return (await hydrate(c, [row]))[0];
  });
  res.json(po);
}));

// POST /api/pos/:id/lines — pm+.   (api.js addPOLine)
router.post('/pos/:id/lines', requireAuth, requireRole('pm'), asyncH(async (req, res) => {
  const po = await loadPO(idParam(req), pool, { activity: false });
  await assertCanEdit(req, po);

  const item = String(pick(req.body, 'item') || '').trim();
  const qty = num(pick(req.body, 'qty'), null);
  if (!item || !(qty > 0)) throw badRequest('a line needs an item and a quantity');

  const detail = String(pick(req.body, 'detail') || '');
  const unitCost = money(pick(req.body, 'unit_cost'), 0);
  const category = readCategory(req.body, 'gear');
  const jobId = num(pick(req.body, 'job_id'), null);
  const showId = num(pick(req.body, 'show_id'), null);
  if (jobId) await assertRow('jobs', jobId, pool, 'job');
  if (showId) await assertRow('shows', showId, pool, 'show');

  // ownership: explicit wins; otherwise derive from the RESOLVED job's deal type.
  const ownership = readOwnership(req.body) || await deriveOwnership(pool, jobId || po.job_id || null);

  const line = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO po_lines (po_id, item, detail, qty, unit_cost, category, job_id, show_id, ownership)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [po.id, item.slice(0, 300), detail, money(qty, 0), unitCost, category, jobId, showId, ownership]);
    const mapped = dbToPOLine(r.rows[0]);
    const summary = `added a line to ${po.po_number}`;
    await logActivity(c, {
      projectId: po.project_id, showId, poId: po.id, jobId: jobId || po.job_id || null,
      actor: req.actor, action: 'po.line.add',
      detail: `${mapped.item} · ${mapped.qty} × ${usd(mapped.unit_cost)}${ownership === 'inventory' ? ' → inventory' : ''}`
    });
    await notifyFrom(c, req, { po, summary });
    return mapped;
  });
  res.json(line);
}));

// PUT /api/pos/:id/lines/:lineId — pm+, and only while the PO is still needed
// or quoted. An ordered PO's lines are a commitment.
router.put('/pos/:id/lines/:lineId', requireAuth, requireRole('pm'), asyncH(async (req, res) => {
  const po = await loadPO(idParam(req), pool, { activity: false });
  await assertCanEdit(req, po);
  const lineId = idParam(req, 'lineId');
  const line = (po.lines || []).find((l) => l.id === lineId);
  if (!line) throw notFound(`line ${lineId} is not on ${po.po_number}`);
  if (!LINE_EDITABLE.includes(po.status)) {
    throw conflict(`${po.po_number} is ${po.status} — an ordered PO's lines are a commitment`);
  }

  const sets = [];
  const params = [];
  const P = (v) => { params.push(v); return `$${params.length}`; };

  if (has(req.body, 'item')) {
    const item = String(pick(req.body, 'item') || '').trim();
    if (!item) throw badRequest('a line needs an item');
    sets.push(`item = ${P(item.slice(0, 300))}`);
  }
  if (has(req.body, 'detail')) sets.push(`detail = ${P(String(pick(req.body, 'detail') || ''))}`);
  if (has(req.body, 'qty')) {
    const qty = num(pick(req.body, 'qty'), null);
    if (!(qty > 0)) throw badRequest('qty must be greater than zero');
    sets.push(`qty = ${P(money(qty, 0))}`);
  }
  if (has(req.body, 'unit_cost')) sets.push(`unit_cost = ${P(money(pick(req.body, 'unit_cost'), 0))}`);
  if (has(req.body, 'category')) sets.push(`category = ${P(readCategory(req.body, line.category))}`);
  if (has(req.body, 'job_id')) {
    const jid = num(pick(req.body, 'job_id'), null);
    if (jid) await assertRow('jobs', jid, pool, 'job');
    sets.push(`job_id = ${P(jid)}`);
  }
  if (has(req.body, 'show_id')) {
    const sid = num(pick(req.body, 'show_id'), null);
    if (sid) await assertRow('shows', sid, pool, 'show');
    sets.push(`show_id = ${P(sid)}`);
  }
  if (has(req.body, 'ownership')) {
    const own = readOwnership(req.body);
    sets.push(`ownership = ${P(own || await deriveOwnership(pool, line.job_id || po.job_id || null))}`);
  }
  if (!sets.length) throw badRequest('nothing to update');

  const updated = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE po_lines SET ${sets.join(', ')} WHERE id = ${P(lineId)} AND po_id = ${P(po.id)} RETURNING *`,
      params);
    const mapped = dbToPOLine(r.rows[0]);
    const summary = `edited a line on ${po.po_number}`;
    await logActivity(c, {
      projectId: po.project_id, showId: mapped.show_id, poId: po.id,
      jobId: mapped.job_id || po.job_id || null, actor: req.actor, action: 'po.line.update',
      detail: `${mapped.item} · ${mapped.qty} × ${usd(mapped.unit_cost)}`
    });
    await notifyFrom(c, req, { po, summary });
    return mapped;
  });
  res.json(updated);
}));

// DELETE /api/pos/:id/lines/:lineId — same window as the edit route.
router.delete('/pos/:id/lines/:lineId', requireAuth, requireRole('pm'), asyncH(async (req, res) => {
  const po = await loadPO(idParam(req), pool, { activity: false });
  await assertCanEdit(req, po);
  const lineId = idParam(req, 'lineId');
  const line = (po.lines || []).find((l) => l.id === lineId);
  if (!line) throw notFound(`line ${lineId} is not on ${po.po_number}`);
  if (!LINE_EDITABLE.includes(po.status)) {
    throw conflict(`${po.po_number} is ${po.status} — an ordered PO's lines are a commitment`);
  }

  await withTx(async (c) => {
    await c.query('DELETE FROM po_lines WHERE id=$1 AND po_id=$2', [lineId, po.id]);
    const summary = `removed a line from ${po.po_number}`;
    await logActivity(c, {
      projectId: po.project_id, showId: line.show_id, poId: po.id,
      jobId: line.job_id || po.job_id || null, actor: req.actor, action: 'po.line.delete',
      detail: `${line.item} · ${usd(lineTotal(line))}`
    });
    await notifyFrom(c, req, { po, summary });
  });
  res.json({ ok: true, id: lineId, po_id: po.id });
}));

// ── PUT /api/pos/:id/status — the pipeline gate.  (api.js updatePOStatus) ────
// One stage at a time. The approval gate lives on quoted→ordered and is
// enforced HERE, server-side (28) — not advisory, same posture as the agent
// API's confidence bands.
router.put('/pos/:id/status', requireAuth, requireRole('pm'), asyncH(async (req, res) => {
  const id = idParam(req);
  const status = String(pick(req.body, 'status') || '');
  const out = await withTx(async (c) => {
    const po = await loadPO(id, c, { activity: false });
    await assertCanEdit(req, po, c);

    const from = PO_STATUSES.indexOf(po.status);
    const to = PO_STATUSES.indexOf(status);
    if (to < 0) throw badRequest(`unknown PO status "${status}"`);
    if (to !== from + 1) {
      throw badRequest(`${po.po_number} is ${po.status} — advance one stage at a time`);
    }

    const t = await poThreshold(c);
    if (status === 'ordered' && poNeedsApproval(po, t)) {
      throw forbidden(`${po.po_number} is over the ${usd(t)} threshold — an admin or Candice ` +
        'must approve it before it can be ordered');
    }
    if (status === 'reconciled' && !po.invoice_file_id) {
      throw badRequest(`attach the vendor invoice to reconcile ${po.po_number}`);
    }

    const sets = ['status = $2', 'updated_at = NOW()'];
    const params = [po.id, status];
    const P = (v) => { params.push(v); return `$${params.length}`; };

    if (status === 'ordered') {
      if (!po.ordered_date) sets.push(`ordered_date = ${P(todayISO())}`);
      // under the threshold auto-approves: the record still says so out loud.
      if (!po.approval) {
        sets.push(`approval = ${P(JSON.stringify({
          required: false, threshold_exceeded: false, approved_by: null, approved_at: null
        }))}::jsonb`);
      }
    }

    let made = [];
    let finalStatus = status;
    if (status === 'received') {
      sets.push(`received_date = ${P(todayISO())}`);
      made = await generateExpenses(c, po);          // cogs lines become actuals
      if (po.invoice_file_id) {                      // invoice already on file
        finalStatus = 'reconciled';
        params[1] = 'reconciled';
      }
    }

    const r = await c.query(
      `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    const updated = (await hydrate(c, r.rows, { activity: false }))[0];

    if (status === 'received') {
      const show = await primaryShow(c, updated);
      await logActivity(c, {
        projectId: updated.project_id, showId: show ? show.id : null, poId: updated.id,
        jobId: updated.job_id, actor: req.actor, action: 'po.receive', accent: true,
        detail: made.length
          ? `${made.length} cost line${made.length === 1 ? '' : 's'} now actuals`
          : '→ Flex inventory intake'
      });
    }
    await logActivity(c, {
      projectId: updated.project_id, poId: updated.id, jobId: updated.job_id,
      actor: req.actor, action: 'po.status',
      accent: finalStatus === 'ordered' || finalStatus === 'received' || finalStatus === 'reconciled',
      detail: `marked ${updated.po_number} ${STATUS_LABEL[finalStatus] || finalStatus}`
    });
    await notifyFrom(c, req, {
      po: updated, summary: `${updated.po_number} is now ${STATUS_LABEL[finalStatus] || finalStatus}`
    });

    return { po: await loadPO(updated.id, c), expenses: made };
  });
  res.json({ ...out.po, expenses_created: out.expenses });
}));

// ── POST /api/pos/:id/approve — admins + the finance capability ──────────────
// NOT the generic manager+ predicate (28, Tom's decision 2026-08-21).
router.post('/pos/:id/approve', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  const out = await withTx(async (c) => {
    const po = await loadPO(id, c, { activity: false });
    const t = await poThreshold(c);
    if (!poNeedsApproval(po, t)) throw badRequest(`${po.po_number} has nothing awaiting approval`);
    if (!canApprovePO(req.session)) {
      throw forbidden('PO approval sits with the admins — Tom, Tony, Jim — and Candice (finance)');
    }
    const approval = {
      required: true, threshold_exceeded: true,
      approved_by: req.session.username, approved_at: todayISO()
    };
    const r = await c.query(
      `UPDATE purchase_orders SET approval = $2::jsonb, updated_at = NOW()
       WHERE id = $1 RETURNING *`, [po.id, JSON.stringify(approval)]);
    const updated = (await hydrate(c, r.rows, { activity: false }))[0];
    await logActivity(c, {
      projectId: updated.project_id, poId: updated.id, jobId: updated.job_id,
      actor: req.actor, action: 'po.approve', accent: true,
      detail: `over the ${usd(t)} threshold — cleared to order (${usd(poTotal(updated))})`
    });
    await notifyFrom(c, req, { po: updated, summary: `${updated.po_number} approved — cleared to order` });
    return loadPO(updated.id, c);
  });
  res.json(out);
}));

// PUT /api/pos/:id — pm+, editable scalars only.
router.put('/pos/:id', requireAuth, requireRole('pm'), asyncH(async (req, res) => {
  const id = idParam(req);
  const out = await withTx(async (c) => {
    const po = await loadPO(id, c, { activity: false });
    await assertCanEdit(req, po, c);

    const sets = ['updated_at = NOW()'];
    const params = [po.id];
    const P = (v) => { params.push(v); return `$${params.length}`; };

    if (has(req.body, 'vendor')) sets.push(`vendor = ${P(String(pick(req.body, 'vendor') || '').slice(0, 200))}`);
    if (has(req.body, 'memo')) sets.push(`memo = ${P(String(pick(req.body, 'memo') || ''))}`);
    if (has(req.body, 'tracking')) {
      const tr = pick(req.body, 'tracking');
      sets.push(`tracking = ${P(tr === null || tr === '' ? null : String(tr).slice(0, 120))}`);
    }
    if (has(req.body, 'expected_date')) sets.push(`expected_date = ${P(readISODate(req.body, 'expected_date'))}`);
    if (has(req.body, 'job_id')) {
      const jid = num(pick(req.body, 'job_id'), null);
      if (jid) await assertRow('jobs', jid, c, 'job');
      sets.push(`job_id = ${P(jid)}`);
    }
    if (has(req.body, 'quote_file_id')) {
      const fid = num(pick(req.body, 'quote_file_id'), null);
      if (fid) await assertRow('files', fid, c, 'file');
      sets.push(`quote_file_id = ${P(fid)}`);
    }
    if (has(req.body, 'invoice_file_id')) {
      const fid = num(pick(req.body, 'invoice_file_id'), null);
      if (fid) await assertRow('files', fid, c, 'file');
      sets.push(`invoice_file_id = ${P(fid)}`);
    }
    // 25. the number is the paper trail — it freezes the moment money is committed.
    if (has(req.body, 'po_number')) {
      if (!LINE_EDITABLE.includes(po.status)) {
        throw conflict(`${po.po_number} is ${po.status} — a PO number is locked once it is ordered`);
      }
      const nextNum = String(pick(req.body, 'po_number') || '').trim().slice(0, 40);
      if (!nextNum) throw badRequest('po_number cannot be blank');
      const dup = await c.query('SELECT id FROM purchase_orders WHERE po_number=$1 AND id<>$2',
        [nextNum, po.id]);
      if (dup.rows.length) throw conflict(`${nextNum} already exists`);
      sets.push(`po_number = ${P(nextNum)}`);
    }
    if (sets.length === 1) throw badRequest('nothing to update');

    const r = await c.query(
      `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    const updated = (await hydrate(c, r.rows, { activity: false }))[0];
    await logActivity(c, {
      projectId: updated.project_id, poId: updated.id, jobId: updated.job_id,
      actor: req.actor, action: 'po.update', detail: `updated ${updated.po_number}`
    });
    await notifyFrom(c, req, { po: updated, summary: `${updated.po_number} was updated` });
    return loadPO(updated.id, c);
  });
  res.json(out);
}));

// DELETE /api/pos/:id — manager+. 25's delete-cascade wiring: po_lines, notes
// (+ their reads/mentions), the PO's activity, and every expense's po_id
// nulled so the actual survives the order that created it.
router.delete('/pos/:id', requireAuth, requireRole('manager'), asyncH(async (req, res) => {
  const id = idParam(req);
  const out = await withTx(async (c) => {
    const po = await loadPO(id, c, { activity: false });
    const total = poTotal(po);
    await deletePoCascade(c, po.id);
    // The cascade removes activity WHERE po_id = this PO, so the tombstone is
    // project-scoped with the number in the detail — never a dangling po_id.
    await logActivity(c, {
      projectId: po.project_id, jobId: po.job_id, actor: req.actor, action: 'po.delete',
      accent: true, detail: `deleted ${po.po_number} (${po.vendor}, ${usd(total)})`
    });
    // Notes anchored on the PO went with it; a delete notification anchors on
    // the project instead.
    if (po.project_id) {
      await notifyFrom(c, req, {
        po, anchorType: 'project', anchorId: po.project_id,
        summary: `${po.po_number} (${po.vendor}) was deleted`
      });
    }
    return { ok: true, id: po.id, po_number: po.po_number };
  });
  res.json(out);
}));

module.exports = router;
// The agent surface files purchase REQUESTS into the same pipeline, so it mints
// numbers with the same function rather than a second copy of the rule
// (hardening 4). See routes/agent.js POST /purchase-requests.
module.exports.nextPoNumber = nextPoNumber;
module.exports.insertPO = insertPO;
