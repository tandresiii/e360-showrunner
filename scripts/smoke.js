#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/smoke.js — end-to-end smoke test against a REAL PostgreSQL
// ────────────────────────────────────────────────────────────────────────────
//   DATABASE_URL=postgres://user:pass@host:5432/scratch_db node scripts/smoke.js
//
// Boots the real server in-process on an ephemeral port and drives it over
// HTTP, exactly as a browser or an agent would. It creates everything it
// touches under a unique run tag and CASCADE-DELETES it at the end, so it is
// safe to point at a scratch database — but never at production.
//
// What it proves (the wiring-pass checklist):
//   1  initDB is idempotent            — runs twice, second run is a no-op
//   2  the templates.json seed loader  — 4 templates, owner_role kept,
//                                        evidence_type file -> flex_element
//   3  auth                            — bcrypt hash, login, durable session,
//                                        legacy sha256 upgrade-on-login
//   4  a representative CRUD per route family
//   5  the agent API happy path        — key -> whoami -> match -> file a
//                                        document proposal -> confirm
//   6  cascade integrity               — a folder with a child of EVERY type,
//                                        deleted, asserting ZERO orphans
//   7  confidence bands                — status:"filed" below 85 is 422
//   8  idempotency                     — replay returns the ORIGINAL response;
//                                        a different body on the same key is 409
//   9  the §9 guardrails               — no DELETE on the agent surface, no
//                                        scheduler push, no self-confirm
//  10  the recap content firewall      — a dollar figure is refused
// ════════════════════════════════════════════════════════════════════════════

'use strict';

process.env.SEED_ROSTER = process.env.SEED_ROSTER || '1';
process.env.STORAGE_ROOT = process.env.STORAGE_ROOT ||
  require('path').join(require('os').tmpdir(), 'showrunner-smoke-storage');

const assert = require('assert');
const { pool } = require('../lib/db');

const TAG = 'smoke' + Date.now().toString(36);
let BASE = '';
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else {
    fail += 1; failures.push(name);
    console.log(`  ✗ ${name}${extra ? '  ->  ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  }
}
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }

async function call(method, path, { token, key, body, idem, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['x-auth-token'] = token;
  if (key) h['x-agent-key'] = key;
  if (idem) h['x-idempotency-key'] = idem;
  let payload;
  if (raw) { h['Content-Type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, body: json, headers: res.headers };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, b, o) => call('POST', p, { ...o, body: b });
const PUT = (p, b, o) => call('PUT', p, { ...o, body: b });
const PATCH = (p, b, o) => call('PATCH', p, { ...o, body: b });
const DEL = (p, o) => call('DELETE', p, o);

(async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. See SMOKE.md.');
    process.exit(2);
  }
  console.log(`E360 Showrunner smoke — run tag ${TAG}`);
  console.log(`DB: ${String(process.env.DATABASE_URL).replace(/:[^:@/]*@/, ':***@')}`);

  // ── 1. initDB idempotency: boot twice ──────────────────────────────────────
  section('1. initDB idempotency + seed loader');
  const { initDB } = require('../lib/db');
  const { seedAll } = require('../lib/seed');
  await initDB();
  await seedAll();
  const firstTables = await tableCount();
  await initDB();                       // second run must be a clean no-op
  await seedAll();
  const secondTables = await tableCount();
  ok('initDB runs twice without error', true);
  ok('table count is stable across two initDB runs', firstTables === secondTables,
     { firstTables, secondTables });

  // ── 2. the templates.json seed loader ─────────────────────────────────────
  const tpl = await pool.query(`SELECT id, name, event_type FROM event_type_templates
                                WHERE source_key IS NOT NULL ORDER BY id`);
  ok('templates.json loaded 4 templates', tpl.rows.length === 4, tpl.rows.map((t) => t.name));
  const roles = await pool.query(
    `SELECT COUNT(*)::int AS n FROM template_steps WHERE owner_role IS NOT NULL`);
  ok('template_steps carry owner_role (punch B)', roles.rows[0].n > 40, roles.rows[0]);
  const flexFile = await pool.query(
    `SELECT COUNT(*)::int AS n FROM template_steps WHERE auto_source='flex' AND evidence_type='file'`);
  const flexElem = await pool.query(
    `SELECT COUNT(*)::int AS n FROM template_steps WHERE auto_source='flex' AND evidence_type='flex_element'`);
  ok('evidence_type reconciled: no flex step left as file (punch A)', flexFile.rows[0].n === 0, flexFile.rows[0]);
  ok('evidence_type reconciled: flex steps are flex_element', flexElem.rows[0].n > 0, flexElem.rows[0]);
  const dupCheck = await pool.query(
    `SELECT source_key, COUNT(*)::int AS n FROM event_type_templates
     WHERE source_key IS NOT NULL GROUP BY source_key HAVING COUNT(*) > 1`);
  ok('seed loader is idempotent (no duplicate templates)', dupCheck.rows.length === 0, dupCheck.rows);
  const lanesRow = await pool.query(`SELECT key, lanes FROM event_types ORDER BY sort_order`);
  const byKey = Object.fromEntries(lanesRow.rows.map((r) => [r.key, r.lanes]));
  ok('lanes are per-event-type config (punch C): led=6 print=8 both=10',
     byKey.led.length === 6 && byKey.print.length === 8 && byKey.both.length === 10, byKey);

  // ── boot the server ───────────────────────────────────────────────────────
  const { boot } = require('../server');
  process.env.PORT = process.env.SMOKE_PORT || '31879';
  const server = await boot();
  BASE = `http://127.0.0.1:${server.address().port}`;

  const health = await GET('/api/health');
  ok('GET /api/health', health.status === 200 && health.body.ok === true, health.body);

  // ── 3. auth ───────────────────────────────────────────────────────────────
  section('3. auth — bcrypt, durable sessions, legacy upgrade');
  const admin = await POST('/api/auth/login', { username: 'admin', password: 'e360admin' });
  ok('admin login', admin.status === 200 && !!admin.body.token, admin.body);
  const A = admin.body.token;

  const badLogin = await POST('/api/auth/login', { username: 'admin', password: 'wrong' });
  ok('wrong password is 401', badLogin.status === 401);

  const hashRow = await pool.query(`SELECT password_hash FROM users WHERE username='admin'`);
  ok('the admin password is a bcrypt hash', /^\$2[aby]\$/.test(hashRow.rows[0].password_hash));

  const sessRow = await pool.query('SELECT COUNT(*)::int AS n FROM sessions');
  ok('the session is DURABLE (a row, not a Map)', sessRow.rows[0].n > 0, sessRow.rows[0]);

  // legacy sha256 -> bcrypt on next login
  const legacy = require('../lib/auth').legacyHash('legacypw');
  await pool.query(
    `INSERT INTO users (username, password_hash, role, pw_algo) VALUES ($1,$2,'viewer','sha256')
     ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, pw_algo='sha256'`,
    [TAG + 'legacy', legacy]);
  const legacyLogin = await POST('/api/auth/login', { username: TAG + 'legacy', password: 'legacypw' });
  ok('a legacy sha256 password still logs in', legacyLogin.status === 200, legacyLogin.body);
  const upgraded = await pool.query('SELECT password_hash, pw_algo FROM users WHERE username=$1',
    [TAG + 'legacy']);
  ok('...and is transparently re-hashed to bcrypt (punch F)',
     /^\$2[aby]\$/.test(upgraded.rows[0].password_hash) && upgraded.rows[0].pw_algo === 'bcrypt');

  const noAuth = await GET('/api/projects');
  ok('an unauthenticated read is 401', noAuth.status === 401);

  // a pm and a tech, for the role gates
  // `mgrUser` is a MANAGER WITHOUT the finance flag, and he exists purely to
  // discriminate. Under the OLD rule (manager+ ‖ finance) he saw margin and
  // could approve a PO; under the rule Tom actually decided (admin ‖ finance)
  // he can do neither. Testing the gate on a pm or a tech proves nothing —
  // they fail BOTH rules — so an assertion written that way survives a
  // reversal of the very decision it is supposed to protect.
  // `admNoFin` is an ADMIN WITHOUT the flag — Tony and Jim. He is the other
  // half of the discrimination: he must SEE margin, because the rule is
  // admin OR finance, not finance alone. Between him and mgrUser, no single
  // edit to the predicate can leave every gate assertion green.
  // `pm2User` is a pm who OWNS NOTHING. He separates the two different pm+
  // gates in this app, which look identical from an admin's seat:
  //   · schedule + recap = pm+ AND canEditProject  -> he is OUT
  //   · photo curation   = pm+ RANK ONLY           -> he is IN, deliberately
  // Testing either gate with an admin proves neither.
  const pmUser = TAG + 'pm', techUser = TAG + 'tech', finUser = TAG + 'fin',
        mgrUser = TAG + 'mgr', admNoFin = TAG + 'adm', pm2User = TAG + 'pm2';
  for (const [u, role, finance] of [[pmUser, 'pm', false], [techUser, 'tech', false],
                                    [finUser, 'manager', true], [mgrUser, 'manager', false],
                                    [admNoFin, 'admin', false], [pm2User, 'pm', false]]) {
    const r = await POST('/api/users', { username: u, password: 'smokepass123', role, finance,
                                         name: u.toUpperCase() }, { token: A });
    ok(`created user ${role}${finance ? '+finance' : ''}`, r.status === 200, r.body);
  }
  const PMT = (await POST('/api/auth/login', { username: pmUser, password: 'smokepass123' })).body.token;
  const TECHT = (await POST('/api/auth/login', { username: techUser, password: 'smokepass123' })).body.token;
  const FINT = (await POST('/api/auth/login', { username: finUser, password: 'smokepass123' })).body.token;
  const MGRT = (await POST('/api/auth/login', { username: mgrUser, password: 'smokepass123' })).body.token;
  const ADMNFT = (await POST('/api/auth/login', { username: admNoFin, password: 'smokepass123' })).body.token;
  const PM2T = (await POST('/api/auth/login', { username: pm2User, password: 'smokepass123' })).body.token;

  // ── 4. CRUD per route family ──────────────────────────────────────────────
  section('4. CRUD — one representative call per route family');
  const proj = await POST('/api/projects', {
    name: TAG + ' LOVB Season', client: 'League One Volleyball', type: 'led',
    stage: 'planning', owner: pmUser, description: 'smoke folder'
  }, { token: A });
  ok('POST /api/projects', proj.status === 200 && proj.body.id > 0, proj.body);
  const P = proj.body.id;
  ok('...auto-created its single job', (proj.body.jobs || []).length === 1, proj.body.jobs);
  const J = proj.body.jobs[0].id;

  const show = await POST('/api/shows', {
    project_id: P, name: TAG + ' Madison', venue: 'UW Field House', city: 'Madison, WI',
    load_in_date: '2026-11-12', event_date: '2026-11-14', strike_date: '2026-11-15',
    stage: 'planning', cabinets: 40, template_id: tpl.rows.find((t) => t.event_type === 'led').id
  }, { token: A });
  ok('POST /api/shows (+ template instantiation)',
     show.status === 200 && show.body.instantiated_steps > 10, show.body.instantiated_steps);
  const S = show.body.id;

  const showGet = await GET(`/api/shows/${S}`, { token: A });
  ok('GET /api/shows/:id is hydrated (steps + project + job + lanes)',
     Array.isArray(showGet.body.steps) && !!showGet.body.project && Array.isArray(showGet.body.lanes),
     Object.keys(showGet.body));
  ok('due dates were back-scheduled from event_date',
     showGet.body.steps.some((s) => s.due_date && s.due_date < '2026-11-14'));
  ok('a template step kept its owner_role',
     showGet.body.steps.some((s) => !!s.owner_role));

  // punch C: a lane the event type does not declare is refused
  const badLane = await POST('/api/steps', { show_id: S, lane: 'proof', title: 'nope' }, { token: A });
  ok('a lane outside the event type is 400 (punch C)', badLane.status === 400, badLane.body);

  const step = await POST('/api/steps', {
    show_id: S, lane: 'logistics', title: TAG + ' Book truck', owner: techUser,
    due_offset_days: -21, risk: true
  }, { token: A });
  ok('POST /api/steps', step.status === 200, step.body);
  ok('steps.risk round-trips (punch 4)', step.body.risk === true);
  const ST = step.body.id;

  const techStatus = await PUT(`/api/steps/${ST}/status`, { status: 'in_progress' }, { token: TECHT });
  ok('a tech may update the status of a step they own', techStatus.status === 200, techStatus.body);
  const techEdit = await PUT(`/api/steps/${ST}`, { title: 'hijack' }, { token: TECHT });
  ok('...but may not edit the step itself', techEdit.status === 403, techEdit.body);

  // 9. RAG derived + override
  const ragShow = await GET(`/api/shows/${S}`, { token: A });
  ok('shows.rag is DERIVED from steps (punch 9)', ['go', 'warn', 'crit', 'idle'].includes(ragShow.body.rag),
     ragShow.body.rag);
  await PUT(`/api/shows/${S}`, { rag_override: 'go' }, { token: A });
  const overridden = await GET(`/api/shows/${S}`, { token: A });
  ok('...and a manager override WINS', overridden.body.rag === 'go', overridden.body.rag);

  // milestones (8)
  const ms = await POST(`/api/shows/${S}/milestones`, { label: 'Content due', date: '2026-11-07' }, { token: A });
  ok('POST /api/shows/:id/milestones (punch 8)', ms.status === 200, ms.body);

  // files + financial doc (23, 29)
  const file = await POST('/api/files', {
    show_id: S, name: TAG + ' season spec', ext: '.e360', kind: 'spec', spec_type: 'e360',
    ver: 'v1', dim: '2 zones · 1408 x 96', artifact: 'document', chain_key: 'content', size: 4096
  }, { token: A });
  ok('POST /api/files with artifact/ver/dim (punch 1,2,3)',
     file.status === 200 && file.body.ver === 'v1' && !!file.body.dim, file.body);
  ok('nas_path is server-derived', String(file.body.nas_path).includes('\\spec\\'), file.body.nas_path);
  const F = file.body.id;

  const bytes = await call('PUT', `/api/files/${F}/content`, { token: A, raw: Buffer.from('spec bytes') });
  ok('PUT /api/files/:id/content writes through the storage driver',
     bytes.status === 200 && bytes.body.size === 10, bytes.body);

  const invoice = await POST('/api/files', {
    show_id: S, name: TAG + " O'Brien freight", ext: '.pdf', kind: 'invoice',
    amount: 8400, vendor: "O'Brien Freight", doc_date: '2026-11-01', category: 'freight'
  }, { token: A });
  ok('a financial doc with an amount also creates its expense (punch 23/29)',
     invoice.status === 200 && !!invoice.body.created.expense_id, invoice.body.created);

  // ── POLISH_LIST #5 · TEMP JOB NUMBERS ──────────────────────────────────
  // A deal exists days before accounting cuts the QuickBooks number, and costs
  // start landing against it immediately — so a job is never numberless.
  const tempJob = await POST('/api/jobs', { project_id: P, name: TAG + ' late team deal',
    client: TAG + ' Client', deal_type: 'sale' }, { token: PMT });
  ok('POST /api/jobs with no number: a pm may open the job (POLISH_LIST #5)',
     tempJob.status === 200, tempJob.body);
  ok('...and the server minted a TEMP-{yy}-{seq} placeholder',
     /^TEMP-\d{2}-\d{3,}$/.test(String(tempJob.body.qb_job_number)), tempJob.body.qb_job_number);
  ok('...with qb_number_status = temp',
     tempJob.body.qb_number_status === 'temp', tempJob.body.qb_number_status);
  const TJ = tempJob.body.id;

  const tempJob2 = await POST('/api/jobs', { project_id: P, name: TAG + ' second late deal' },
    { token: PMT });
  ok('...a second placeholder takes the NEXT sequence, never a collision',
     tempJob2.body.qb_job_number !== tempJob.body.qb_job_number &&
     parseInt(String(tempJob2.body.qb_job_number).split('-')[2], 10) ===
     parseInt(String(tempJob.body.qb_job_number).split('-')[2], 10) + 1,
     [tempJob.body.qb_job_number, tempJob2.body.qb_job_number]);

  const pmRealNum = await POST('/api/jobs', { project_id: P, name: TAG + ' pm tries a real number',
    qb_job_number: '26-9999' }, { token: PMT });
  ok('a pm still may NOT type a real QuickBooks number (§9, accounting owns it)',
     pmRealNum.status === 403, pmRealNum.body);

  // a temp job with NOTHING riding on it is not a chase yet
  const excQuiet = await GET('/api/finance/exceptions', { token: FINT });
  ok('an untouched temp job is NOT on the chase list — it is just an early folder',
     !(excQuiet.body || []).some((x) => x.kind === 'job_number' && x.id === TJ),
     (excQuiet.body || []).filter((x) => x.kind === 'job_number').map((x) => x.id));

  // ...but a budget line riding on it makes it Candice's problem
  await POST(`/api/jobs/${TJ}/budget`, { category: 'gear', allotted: 4200 }, { token: FINT });
  const excLoud = await GET('/api/finance/exceptions', { token: FINT });
  const jobNumExc = (excLoud.body || []).find((x) => x.kind === 'job_number' && x.id === TJ);
  ok('once something rides on it, the temp job feeds the finance exceptions list',
     !!jobNumExc, (excLoud.body || []).map((x) => x.kind + ':' + x.id).join(' '));
  ok("...as kind 'job_number', chased to Candice, with no amount and no show",
     !!jobNumExc && jobNumExc.chase === 'candice' && jobNumExc.missing === 'a QB job number — Candice' &&
     jobNumExc.amount === null && jobNumExc.show === null && jobNumExc.job_id === TJ,
     jobNumExc);

  // confirming it: accounting only, and it logs its OWN activity row
  const pmConfirm = await call('PUT', `/api/jobs/${TJ}`, { token: PMT, body: { qb_job_number: '26-1241' } });
  ok('a pm may not confirm the number either', pmConfirm.status === 403, pmConfirm.body);
  const wasTemp = tempJob.body.qb_job_number;
  const numConfirmed = await call('PUT', `/api/jobs/${TJ}`, { token: FINT, body: { qb_job_number: '26-1241' } });
  ok('accounting writes the real number', numConfirmed.status === 200 &&
     numConfirmed.body.qb_job_number === '26-1241', numConfirmed.body);
  ok('...and the status flips to confirmed on its own',
     numConfirmed.body.qb_number_status === 'confirmed', numConfirmed.body.qb_number_status);
  const jobActs = await GET(`/api/activity?job_id=${TJ}`, { token: FINT });
  const confirmAct = (jobActs.body || []).find((a) => a.action === 'job.number.confirm');
  ok('...logging job.number.confirm, naming the new number AND the old placeholder',
     !!confirmAct && confirmAct.detail === `job number confirmed 26-1241 (was ${wasTemp})`,
     confirmAct && confirmAct.detail);
  const excGone = await GET('/api/finance/exceptions', { token: FINT });
  ok('...and the chase row clears',
     !(excGone.body || []).some((x) => x.kind === 'job_number' && x.id === TJ));

  // NOTHING re-linked: the budget line still hangs off the same job id
  const tjBudget = await GET(`/api/jobs/${TJ}/budget`, { token: FINT });
  ok('the swap re-linked NOTHING — every reference is on jobs.id, never the number',
     tjBudget.status === 200 && tjBudget.body.length === 1 &&
     Number(tjBudget.body[0].allotted) === 4200, tjBudget.body);

  // clearing the number re-mints a placeholder rather than blanking the chip
  const cleared = await call('PUT', `/api/jobs/${TJ}`, { token: FINT, body: { qb_job_number: '' } });
  ok('clearing the number re-mints a TEMP placeholder — a job is never numberless',
     cleared.status === 200 && /^TEMP-\d{2}-\d{3,}$/.test(String(cleared.body.qb_job_number)) &&
     cleared.body.qb_number_status === 'temp', cleared.body.qb_job_number);

  // finance (5,16,17,18,20,21)
  const bl = await POST(`/api/jobs/${J}/budget`, { category: 'freight', allotted: 14000,
    notes: 'league-covered kit freight' }, { token: FINT });
  ok('POST /api/jobs/:id/budget (finance capability)', bl.status === 200, bl.body);
  const blDenied = await POST(`/api/jobs/${J}/budget`, { category: 'travel', allotted: 1 }, { token: TECHT });
  ok('...refused to a tech', blDenied.status === 403);
  const badCat = await POST(`/api/jobs/${J}/budget`, { category: 'bribes', allotted: 1 }, { token: FINT });
  ok('the shared category vocabulary is enforced (punch 17)', badCat.status === 400, badCat.body);

  const jobFin = await GET(`/api/jobs/${J}/finance`, { token: FINT });
  ok('GET /api/jobs/:id/finance', jobFin.status === 200, jobFin.body && jobFin.body.error);
  ok('budget_total is DERIVED from the lines (punch 20)', jobFin.body.budget_total === 14000,
     jobFin.body.budget_total);
  ok('margin is visible to the finance capability', jobFin.body.margin !== undefined);
  const jobFinTech = await GET(`/api/jobs/${J}/finance`, { token: TECHT });
  ok('margin is STRIPPED for a tech (Tom 8/27: admin || finance)',
     jobFinTech.body.margin === undefined && jobFinTech.body.budget_total !== undefined,
     Object.keys(jobFinTech.body));
  // THE DISCRIMINATING ONE: a manager without the flag saw margin under the
  // old manager+ rule. If this passes, the rule really is admin || finance.
  const jobFinMgr = await GET(`/api/jobs/${J}/finance`, { token: MGRT });
  ok('margin is STRIPPED for a MANAGER without the finance flag (POLISH_LIST #4)',
     jobFinMgr.body.margin === undefined && jobFinMgr.body.marginPct === undefined
     && jobFinMgr.body.billed === undefined, Object.keys(jobFinMgr.body));
  ok('...while budgets, burn and committed stay visible to them',
     jobFinMgr.body.budget_total !== undefined && jobFinMgr.body.committed !== undefined
     && jobFinMgr.body.burnPct !== undefined, Object.keys(jobFinMgr.body));
  const statsMgr = await GET('/api/finance/stats', { token: MGRT });
  ok('...and the headline stats strip margin for them too',
     statsMgr.body.margin === undefined && statsMgr.body.actual !== undefined, statsMgr.body);
  // THE OTHER HALF: an ADMIN without the flag (Tony, Jim) must still SEE it.
  // Together with mgrUser above, this pins the rule from both sides — drop the
  // admin clause and this goes red; widen it back to manager+ and mgrUser does.
  const jobFinAdmNF = await GET(`/api/jobs/${J}/finance`, { token: ADMNFT });
  ok('margin IS visible to an ADMIN without the finance flag (Tony/Jim)',
     jobFinAdmNF.body.margin !== undefined && jobFinAdmNF.body.billed !== undefined,
     Object.keys(jobFinAdmNF.body));
  const admApprove = await GET('/api/config/po-approval-threshold', { token: ADMNFT });
  ok('...and he can read the approval config', admApprove.status === 200, admApprove.body);

  const exceptions = await GET('/api/finance/exceptions', { token: FINT });
  ok('GET /api/finance/exceptions', exceptions.status === 200 && Array.isArray(exceptions.body));
  const overview = await GET('/api/finance/overview', { token: FINT });
  ok('GET /api/finance/overview (stats + exceptions + feed + jobs)',
     overview.status === 200 && !!overview.body.stats && Array.isArray(overview.body.jobs),
     Object.keys(overview.body || {}));

  // the shapes public/api.js reads back verbatim
  const folder = await GET(`/api/projects/${P}/folder`, { token: A });
  // one show in the folder -> it auto-collapses and the show comes back hydrated
  ok('GET /api/projects/:id/folder carries the auto-collapse rule (api.resolveFolder)',
     folder.status === 200 && folder.body.single === true
     && !!folder.body.show && Array.isArray(folder.body.show.steps), folder.body.single);
  const roster = await GET('/api/users', { token: TECHT });
  ok('GET /api/users is readable by everyone (the roster drives pickers + mentions)',
     roster.status === 200 && roster.body.length > 0 && roster.body[0].initials !== undefined,
     roster.status);
  ok('...and never leaks a password hash', !JSON.stringify(roster.body).includes('password'));
  const types = await GET('/api/event-types', { token: A });
  ok('GET /api/event-types exposes the lane sets (punch C)',
     types.status === 200 && types.body.types.length === 3 && types.body.lanes.length === 14,
     (types.body.types || []).length);

  // purchasing (25-28)
  const po = await POST('/api/pos', { vendor: 'ROE Visual', project_id: P, job_id: J,
    memo: TAG + ' season hardware' }, { token: A });
  ok('POST /api/pos', po.status === 200 && !!po.body.po_number, po.body);
  const PO = po.body.id;
  const line = await POST(`/api/pos/${PO}/lines`, { item: 'CB5 cabinets', qty: 10, unit_cost: 1240,
    category: 'gear', show_id: S }, { token: A });
  ok('POST /api/pos/:id/lines', line.status === 200, line.body);
  const quoted = await PUT(`/api/pos/${PO}/status`, { status: 'quoted' }, { token: A });
  ok('PO advances needed -> quoted', quoted.status === 200, quoted.body);
  const skip = await PUT(`/api/pos/${PO}/status`, { status: 'received' }, { token: A });
  ok('a PO cannot skip a stage', skip.status === 400, skip.body);
  const gated = await PUT(`/api/pos/${PO}/status`, { status: 'ordered' }, { token: PMT });
  ok('the $5k approval gate blocks quoted -> ordered (punch 28)', gated.status === 403, gated.body);
  const pmApprove = await POST(`/api/pos/${PO}/approve`, {}, { token: PMT });
  ok('...and a pm may NOT approve', pmApprove.status === 403, pmApprove.body);
  // Same discrimination on the approval gate: a manager without the flag could
  // approve under the old manager+ predicate. Tom's 8/21 decision says no.
  const mgrApprove = await POST(`/api/pos/${PO}/approve`, {}, { token: MGRT });
  ok('...nor a MANAGER without the finance flag (Tom 8/21: admins + Candice)',
     mgrApprove.status === 403, mgrApprove.body);
  const finApprove = await POST(`/api/pos/${PO}/approve`, {}, { token: FINT });
  ok('...but the finance capability may (Tom 8/21: admins + Candice)', finApprove.status === 200, finApprove.body);
  const ordered = await PUT(`/api/pos/${PO}/status`, { status: 'ordered' }, { token: A });
  ok('...after which it orders', ordered.status === 200, ordered.body);
  const committed = await GET(`/api/jobs/${J}/committed`, { token: FINT });
  ok('GET /api/jobs/:id/committed (ordered = COMMITTED, punch 26)',
     committed.status === 200 && committed.body.total + committed.body.capex === 12400, committed.body);
  const purchOverview = await GET('/api/purchasing/overview', { token: A });
  ok('GET /api/purchasing/overview', purchOverview.status === 200 && !!purchOverview.body.stats,
     Object.keys(purchOverview.body || {}));
  const threshold = await GET('/api/config/po-approval-threshold', { token: A });
  ok('the PO approval threshold is server config, default 5000 (punch 28)',
     threshold.status === 200 && Number(threshold.body.value) === 5000, threshold.body);

  // notes (31-37)
  const note = await POST('/api/notes', { anchor_type: 'show', anchor_id: S,
    body: `Power tie-in is the risk here. @${pmUser} can you confirm the dock window?` }, { token: A });
  ok('POST /api/notes', note.status === 200, note.body);
  ok('mentions are parsed SERVER-SIDE (punch 31)',
     (note.body.mentions || []).includes(pmUser), note.body.mentions);
  const N = note.body.id;
  const reply = await POST('/api/notes', { anchor_type: 'show', anchor_id: S,
    body: 'Dock window confirmed 07:00–11:00.', parent_id: N }, { token: PMT });
  ok('a reply attaches to its root', reply.body.parent_id === N, reply.body);
  const deepReply = await POST('/api/notes', { anchor_type: 'show', anchor_id: S,
    body: 'Noted.', parent_id: reply.body.id }, { token: A });
  ok('a reply-to-a-reply RE-ANCHORS to the thread root (punch 33)',
     deepReply.body.parent_id === N, deepReply.body.parent_id);
  const noteAct = await pool.query(
    `SELECT detail FROM activity WHERE show_id=$1 AND action='note.add' ORDER BY id LIMIT 1`, [S]);
  ok('the activity row carries the MENTION LIST, never the body (punch 36)',
     noteAct.rows.length > 0 && !noteAct.rows[0].detail.includes('Power tie-in'), noteAct.rows[0]);
  const inbox = await GET('/api/me/inbox', { token: PMT });
  ok('GET /api/me/inbox surfaces the mention (punch 35)',
     inbox.status === 200 && inbox.body.items.some((i) => i.note.id === N), inbox.body.items.length);
  const badge = await GET('/api/me/inbox/count', { token: PMT });
  ok('GET /api/me/inbox/count returns a badge', badge.status === 200 && badge.body.badge >= 1, badge.body);
  const readIt = await POST('/api/me/inbox/read', { ids: [N] }, { token: PMT });
  ok('POST /api/me/inbox/read', readIt.status === 200 && readIt.body.marked === 1, readIt.body);
  const notMine = await PUT(`/api/notes/${N}`, { body: 'rewritten' }, { token: PMT });
  ok('only the author may edit a note (punch 37)', notMine.status === 403, notMine.body);

  // the notification principle — `notify` on the four routes the picker uses
  // that did not previously implement it (rest-swap's request, 2026-08-27)
  const notifyFile = await POST('/api/files', {
    show_id: S, name: TAG + ' notify doc', ext: '.pdf', kind: 'confirmation',
    notify: [pmUser]
  }, { token: A });
  ok('POST /api/files honours notify', notifyFile.status === 200, notifyFile.body);
  const notifyExp = await POST('/api/expenses', {
    show_id: S, vendor: 'Notify Vendor', amount: 100, category: 'misc', notify: [pmUser]
  }, { token: A });
  ok('POST /api/expenses honours notify', notifyExp.status === 200, notifyExp.body);
  const notifyChain = await PUT(`/api/shows/${S}/chain/cabling`, { gen: true, notify: [pmUser] },
    { token: A });
  ok('PUT /api/shows/:id/chain/:node honours notify', notifyChain.status === 200, notifyChain.body);
  const notifyBad = await POST('/api/expenses', {
    show_id: S, vendor: 'x', amount: 1, notify: ['ghost-user']
  }, { token: A });
  ok('...and an unknown notify target is 400, never a silent drop',
     notifyBad.status === 400, notifyBad.body);
  const notifyInbox = await GET('/api/me/inbox', { token: PMT });
  ok('...all three land in the target\'s inbox',
     notifyInbox.body.items.filter((i) => /filed a confirmation|recorded a cost|bound the cabling spec/
       .test(i.note.body)).length === 3,
     notifyInbox.body.items.map((i) => i.note.body.slice(0, 40)));

  // run of show (38-41)
  const sched = await POST(`/api/shows/${S}/schedule`, { day: '2026-11-12', start_time: '07:00',
    title: 'Dock opens — floor protection down', kind: 'work', who: 'all' }, { token: A });
  ok('POST /api/shows/:id/schedule (punch 39)', sched.status === 200, sched.body);
  const crew = await POST(`/api/shows/${S}/crew`, { username: techUser, role_on_site: 'LED tech',
    call_time: '07:30' }, { token: A });
  ok('POST /api/shows/:id/crew (punch 40)', crew.status === 200, crew.body);
  const callSheet = await PUT(`/api/shows/${S}/call-sheet`, { load_in_time: '07:00',
    doors_time: '17:00', event_time: '18:30', strike_time: '21:30',
    venue_address: '1450 Monroe St, Madison, WI', radio_channel: 'CH 1',
    venue_poc: { name: 'Terry Novak', phone: '(608) 555-0187', title: 'UW ops' } }, { token: A });
  ok('PUT /api/shows/:id/call-sheet (punch 38)', callSheet.status === 200, callSheet.body);
  // POLISH_LIST #1: the assembled sheet is the CALL SHEET. /call-sheet is the
  // canonical path (and now pairs with the PUT above); /run-of-show is retained
  // as an alias on the same handler so nothing pointing at it breaks.
  const ros = await GET(`/api/shows/${S}/call-sheet`, { token: A });
  ok('GET /api/shows/:id/call-sheet assembles the sheet',
     ros.status === 200 && Array.isArray(ros.body.days) && !!ros.body.pocs, Object.keys(ros.body || {}));
  const rosAlias = await GET(`/api/shows/${S}/run-of-show`, { token: A });
  ok('...and /run-of-show still answers, identically (retained alias)',
     rosAlias.status === 200 &&
     JSON.stringify(rosAlias.body.days) === JSON.stringify(ros.body.days) &&
     JSON.stringify(rosAlias.body.pocs) === JSON.stringify(ros.body.pocs), rosAlias.status);
  ok('no user-facing string in the sheet says "run of show"',
     !/run.of.show/i.test(JSON.stringify(ros.body.days) + JSON.stringify(ros.body.pocs || {})));

  // photos (43-48)
  const photo = await POST(`/api/shows/${S}/photos`, { name: '20261112_0744_regent-st-dock',
    ext: 'jpg', taken_at: '2026-11-12T07:44:00Z', width: 4032, height: 3024,
    caption: 'Case push inside the Regent St dock window', tags: ['load-in', 'dock'],
    shot_by: techUser, size: 3200000 }, { token: A });
  ok('POST /api/shows/:id/photos (punch 43)', photo.status === 200, photo.body);
  ok('a photo lands under the mechanical \\photo\\ folder (punch 45)',
     String(photo.body.nas_path).includes('\\photo\\'), photo.body.nas_path);
  const PH = photo.body.id;
  const badPatch = await PUT(`/api/photos/${PH}`, { caption: 'ok', kind: 'invoice' }, { token: A });
  ok('the photo edit whitelist refuses anything but caption/tags (punch 47)',
     badPatch.status === 400, badPatch.body);
  const pick = await PUT(`/api/photos/${PH}/pick`, { on: true }, { token: A });
  ok('PUT /api/photos/:id/pick (punch 47)', pick.status === 200 && pick.body.recap_pick === true, pick.body);
  const thumb = await PATCH(`/api/photos/${PH}/thumb`, {}, { token: A });
  ok('PATCH /api/photos/:id/thumb derives the _t320 path (punch 46)',
     thumb.status === 200 && String(thumb.body.thumb_path || '').includes('_t320'), thumb.body);

  // ── the pm BOUNDARY, per gate ────────────────────────────────────────────
  // Every other role assertion in this file checks an admin (yes) or a tech
  // (no), and BOTH survive moving any of these gates from pm+ to manager+.
  // These nine pin the actual edges, including the one deliberate asymmetry:
  // photo curation is a RANK gate with no ownership check, so a pm who owns
  // nothing still curates. If someone "tidies" that by adding canEditProject,
  // this is what says no.
  section('4b. the pm boundary — rank gates vs ownership gates');
  const schedPm = await POST(`/api/shows/${S}/schedule`, { day: '2026-11-13', start_time: '09:00',
    title: TAG + ' owner-pm may schedule' }, { token: PMT });
  ok('schedule: the OWNING pm is in', schedPm.status === 200, schedPm.body);
  const schedPm2 = await POST(`/api/shows/${S}/schedule`, { day: '2026-11-13', start_time: '09:30',
    title: TAG + ' non-owner pm' }, { token: PM2T });
  ok('schedule: a pm who does NOT own the project is out', schedPm2.status === 403, schedPm2.body);
  const schedTech = await POST(`/api/shows/${S}/schedule`, { day: '2026-11-13', start_time: '10:00',
    title: TAG + ' tech' }, { token: TECHT });
  ok('schedule: a tech is out', schedTech.status === 403, schedTech.body);

  const pickPm = await PUT(`/api/photos/${PH}/pick`, { on: true }, { token: PMT });
  ok('photo curation: the owning pm is in', pickPm.status === 200, pickPm.body);
  const pickPm2 = await PUT(`/api/photos/${PH}/pick`, { on: true }, { token: PM2T });
  ok('photo curation: a NON-owner pm is ALSO in — it is a rank gate by design',
     pickPm2.status === 200, pickPm2.body);
  const pickTech = await PUT(`/api/photos/${PH}/pick`, { on: false }, { token: TECHT });
  ok('photo curation: a tech is out', pickTech.status === 403, pickTech.body);

  const recapPm = await POST(`/api/shows/${S}/recap`, {}, { token: PMT });
  ok('recap draft: the OWNING pm is in', recapPm.status === 200, recapPm.body);
  const recapPm2 = await POST(`/api/shows/${S}/recap`, {}, { token: PM2T });
  ok('recap draft: a pm who does NOT own the show is out', recapPm2.status === 403, recapPm2.body);
  const recapTech = await POST(`/api/shows/${S}/recap`, {}, { token: TECHT });
  ok('recap draft: a tech is out', recapTech.status === 403, recapTech.body);

  // ── the recap closeout belongs to the SHOW's owner (settled 2026-08-27) ───
  // Drafting and approving are ONE decision and share ONE predicate,
  // lib/auth.js canApproveRecap: manager+ OR the show's own owner. These
  // assertions test that rule from all four sides on a show whose owner
  // deliberately differs from its project's, which is the case that used to
  // expose the old project-owner/show-owner split.
  const s2 = await POST('/api/shows', { project_id: P, name: TAG + ' owner-split show',
    venue: 'Elsewhere', event_date: '2026-12-01', load_in_date: '2026-11-30',
    strike_date: '2026-12-02', owner: pm2User }, { token: A });
  const S2 = s2.body.id;
  ok('a show may carry an owner different from its project\'s',
     s2.status === 200 && s2.body.owner === pm2User && s2.body.owner !== proj.body.owner,
     { show_owner: s2.body.owner, project_owner: proj.body.owner });
  const splitDraft = await POST(`/api/shows/${S2}/recap`, {}, { token: PM2T });
  ok('recap draft: the SHOW\'s own pm CAN draft it, project owner or not',
     splitDraft.status === 200, splitDraft.body);
  ok('...credited to agent:<show.owner> — the gate and the byline now agree',
     splitDraft.body.generated_by === 'agent:' + pm2User, splitDraft.body.generated_by);
  const splitOtherPm = await POST(`/api/shows/${S2}/recap`, {}, { token: PMT });
  ok('recap draft: the PROJECT\'s pm cannot draft a show he does not own',
     splitOtherPm.status === 403, splitOtherPm.body);
  const splitMgr = await POST(`/api/shows/${S2}/recap`, {}, { token: MGRT });
  ok('recap draft: a manager drafts anywhere, as cover',
     splitMgr.status === 200, splitMgr.body);
  const splitMade = await POST(`/api/shows/${S2}/recap`, {}, { token: A });
  ok('recap draft: an admin drafts anywhere, still credited to agent:<show.owner>',
     splitMade.status === 200 && splitMade.body.generated_by === 'agent:' + pm2User,
     splitMade.body.generated_by);
  const splitApprove = await POST(`/api/recaps/${splitMade.body.id}/approve`, {}, { token: PM2T });
  ok('...and the same show owner approves it — draft and approve are one set',
     splitApprove.status === 200, splitApprove.body);

  // ── the pm+ floor applies to BOTH halves (settled, hardening 14) ─────────
  // Tom settled "the show's owner + managers/admins"; the hardening pass
  // settled what "owner" means when the owner is below pm. The floor moved
  // INTO canApproveRecap(), so draft and approve are one expression and cannot
  // disagree for any role. This block used to record the opposite (two
  // [known gap] assertions pinning the disagreement) — it now asserts the rule.
  //
  // REVERSIBLE: if Tom decides a tech owner SHOULD sign off his own show, drop
  // the ROLE_RANK.pm line from canApproveRecap() in lib/auth.js and its mirror
  // in public/data.js canApproveRecapFor(), and flip the two expectations here.
  const techShow = await POST('/api/shows', { project_id: P, name: TAG + ' tech-owned show',
    venue: 'Corner', event_date: '2026-12-05', load_in_date: '2026-12-04',
    strike_date: '2026-12-06', owner: techUser }, { token: A });
  const TS = techShow.body.id;
  ok('a show may be handed to a sub-pm owner at all (shows.owner is free text)',
     techShow.status === 200 && techShow.body.owner === techUser, techShow.body.owner);
  const techDraft = await POST(`/api/shows/${TS}/recap`, {}, { token: TECHT });
  const techMade = await POST(`/api/shows/${TS}/recap`, {}, { token: A });
  const techApprove = await POST(`/api/recaps/${techMade.body.id}/approve`, {}, { token: TECHT });
  ok('a sub-pm show owner is refused the DRAFT (pm+ floor)',
     techDraft.status === 403, techDraft.body);
  ok('...and the APPROVE — one predicate, so the two gates now agree',
     techApprove.status === 403, techApprove.body);
  // The badge asked WHILE that draft is still open and still his: without the
  // floor the tech would be shown one recap waiting on him and then refused it.
  const techBell = await GET('/api/me/inbox/count', { token: TECHT });
  const techList = await GET('/api/me/recaps-awaiting-review', { token: TECHT });
  ok('the bell offers the tech owner nothing to approve — badge and gate agree (9)',
     techBell.body.recaps === 0 && techList.body.length === 0,
     { badge: techBell.body.recaps, list: techList.body.length });
  // ...and it is NOT simply empty for everyone: the manager who can act on that
  // same draft is shown it. Without this the assertion above passes on a bug.
  const mgrList = await GET('/api/me/recaps-awaiting-review', { token: MGRT });
  const mgrBell = await GET('/api/me/inbox/count', { token: MGRT });
  ok('...while the manager who CAN act on it sees it, and the two counts match',
     mgrList.body.some((d) => d.id === techMade.body.id)
     && mgrBell.body.recaps === mgrList.body.length,
     { badge: mgrBell.body.recaps, list: mgrList.body.length });
  // the floor is a FLOOR, not a wall: cover still works
  const mgrApproveTech = await POST(`/api/recaps/${techMade.body.id}/approve`, {}, { token: MGRT });
  ok('...and a manager still approves it — nothing is stranded by the floor',
     mgrApproveTech.status === 200, mgrApproveTech.body);
  // reopen asks the same question — but only reachable once it IS approved,
  // so it has to come after the manager's approve or the 409 masks the 403.
  const techReopen = await POST(`/api/recaps/${techMade.body.id}/reopen`, {}, { token: TECHT });
  ok('...and the REOPEN of that approved recap is refused too — same predicate',
     techReopen.status === 403, techReopen.body);

  // ── THE SPLIT IS ON PURPOSE — this is what would notice it drifting ──────
  // A SCHEDULE belongs to the FOLDER's pm (canEditProject). A CLOSEOUT belongs
  // to the SHOW's owner (canApproveRecap). Two different owners, deliberately,
  // and on this one show the SAME PERSON lands on opposite sides of them. The
  // two gates look alike enough that someone will eventually "unify" them; the
  // pair below is the only thing that would say no. Do not relax either half
  // to make them agree — that is the bug, not the fix.
  const splitSched = await POST(`/api/shows/${S2}/schedule`, { day: '2026-11-30',
    start_time: '08:00', title: TAG + ' show-owner tries the schedule' }, { token: PM2T });
  ok('schedule: the SHOW\'s owner may NOT edit it — the schedule is the folder\'s',
     splitSched.status === 403, splitSched.body);
  const splitSchedOwner = await POST(`/api/shows/${S2}/schedule`, { day: '2026-11-30',
    start_time: '08:30', title: TAG + ' folder pm schedules' }, { token: PMT });
  ok('schedule: the PROJECT\'s pm may — the exact inverse of the recap rule',
     splitSchedOwner.status === 200, splitSchedOwner.body);

  // deliverables + the content firewall (49-54)
  const recap = await POST(`/api/shows/${S}/recap`, {}, { token: A });
  ok('POST /api/shows/:id/recap generates a draft (punch 49/52)', recap.status === 200, recap.body);
  ok('...attributed to the owner\'s agent', String(recap.body.generated_by).startsWith('agent:'),
     recap.body.generated_by);
  ok('...with closeout provenance at confidence 100 (punch 50)',
     recap.body.provenance && recap.body.provenance.source_kind === 'closeout'
     && Number(recap.body.provenance.confidence) === 100, recap.body.provenance);
  const RC = recap.body.id;
  const leak = await PUT(`/api/recaps/${RC}`, { headline: 'We came in $4,200 under budget' }, { token: A });
  ok('the content firewall REFUSES a dollar figure (punch 52)', leak.status === 400, leak.body);
  const leak2 = await PUT(`/api/recaps/${RC}`, { closing: 'Invoice to follow from our vendor.' }, { token: A });
  ok('...and internal accounting language', leak2.status === 400, leak2.body);
  const goodEdit = await PUT(`/api/recaps/${RC}`, { headline: 'A clean show in Madison' }, { token: A });
  ok('...but accepts client-safe prose', goodEdit.status === 200, goodEdit.body);
  const approve = await POST(`/api/recaps/${RC}/approve`, {}, { token: A });
  ok('POST /api/recaps/:id/approve', approve.status === 200 && approve.body.status === 'approved', approve.body);
  const sent = await POST(`/api/recaps/${RC}/sent`, { sent_to: 'LOVB production' }, { token: A });
  ok('POST /api/recaps/:id/sent records a HUMAN send (no outbound path exists)',
     sent.status === 200 && /no outbound/i.test(JSON.stringify(sent.body)), sent.body);

  // ── 5. the agent API ──────────────────────────────────────────────────────
  section('5. agent API — key, whoami, match, propose, confirm');
  const keyRes = await POST('/api/keys', { label: TAG + " Tom's M365 agent",
    scopes: ['agent:read', 'agent:file', 'agent:propose'] }, { token: A });
  ok('POST /api/keys returns the key ONCE', keyRes.status === 200 && /^sk_sr_live_/.test(keyRes.body.key || ''),
     keyRes.body);
  const K = keyRes.body.key;
  const keyList = await GET('/api/keys', { token: A });
  ok('GET /api/keys never returns the key itself',
     keyList.status === 200 && !JSON.stringify(keyList.body).includes(K), keyList.body);

  const who = await GET('/api/agent/whoami', { key: K });
  ok('GET /api/agent/whoami', who.status === 200 && who.body.actor === 'agent:admin', who.body);

  const badKey = await GET('/api/agent/whoami', { key: 'sk_sr_live_nope' });
  ok('an unknown key is 401', badKey.status === 401, badKey.body);

  const match = await POST('/api/agent/match', {
    sourceKind: 'email', subject: `Re: ${TAG} Madison — forklift invoice`,
    bodyExcerpt: 'Invoice attached for the forklift rental at UW Field House on 2026-11-14',
    dates: ['2026-11-14'], vendors: ["O'Brien Freight"],
    hints: { clientName: 'League One Volleyball' }
  }, { key: K });
  ok('POST /api/agent/match ranks candidates with reasons',
     match.status === 200 && Array.isArray(match.body.candidates), match.body);
  const hit = (match.body.candidates || []).find((c) => c.showId === S);
  ok('...and finds the smoke show', !!hit, (match.body.candidates || []).slice(0, 2));
  ok('...with matchedBy tokens and a band', !!hit && hit.matchedBy.length > 0 && !!hit.band, hit);

  const ctx = await GET(`/api/agent/shows/${S}/context`, { key: K });
  ok('GET /api/agent/shows/:id/context', ctx.status === 200 && !!ctx.body.show && !!ctx.body.lanes,
     Object.keys(ctx.body || {}));
  ok('...is budget-capped at 20 open steps / 20 activity rows',
     ctx.body.openSteps.length <= 20 && ctx.body.recentActivity.length <= 20);
  ok('...and shows dollars to an admin\'s agent', ctx.body.money.expensesTotal !== undefined,
     ctx.body.money);
  // The same admin||finance rule on the agent surface: a MANAGER's agent sees
  // counts, not dollars. A key inherits its user's role, read live.
  const mgrKey = (await POST('/api/keys', { label: TAG + ' mgr agent', username: mgrUser,
    scopes: ['agent:read'] }, { token: A })).body.key;
  const mgrCtx = await GET(`/api/agent/shows/${S}/context`, { key: mgrKey });
  ok("a MANAGER's agent sees counts, not dollars (§10 role filter)",
     mgrCtx.status === 200 && mgrCtx.body.money.expensesTotal === undefined
     && mgrCtx.body.money.proposedCount !== undefined, mgrCtx.body.money);

  // provenance is mandatory
  const noProv = await POST('/api/agent/documents', { showId: S, kind: 'invoice', name: 'x' },
    { key: K, idem: TAG + ':noprov' });
  ok('an agent write without provenance is 400 (§7)', noProv.status === 400, noProv.body);

  // idempotency key is mandatory
  const noIdem = await POST('/api/agent/documents', {
    showId: S, kind: 'invoice', name: 'x',
    provenance: { sourceKind: 'email', sourceRef: 'x', confidence: 90 }
  }, { key: K });
  ok('a required endpoint without x-idempotency-key is 400 (§8)', noIdem.status === 400, noIdem.body);

  // ── 7. confidence bands ───────────────────────────────────────────────────
  section('7. confidence bands — server-enforced, not advisory');
  const lowFiled = await POST('/api/agent/documents', {
    showId: S, kind: 'receipt', name: TAG + ' low-band', status: 'filed',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':low', confidence: 40, matchedBy: ['keyword'] }
  }, { key: K, idem: TAG + ':low#doc' });
  ok('status:"filed" at confidence 40 is 422 (§2)', lowFiled.status === 422, lowFiled.body);
  ok('...and names the band', lowFiled.body && lowFiled.body.band === 'low', lowFiled.body);

  const ambiguous = await POST('/api/agent/documents', {
    showId: S, kind: 'receipt', name: TAG + ' ambiguous', status: 'filed', ambiguous: true,
    provenance: { sourceKind: 'email', sourceRef: TAG + ':amb', confidence: 95, matchedBy: ['client_name'] }
  }, { key: K, idem: TAG + ':amb#doc' });
  ok('ambiguous:true forces a proposal even at 95 (§2)', ambiguous.status === 422, ambiguous.body);

  const highFiled = await POST('/api/agent/documents', {
    showId: S, jobId: J, kind: 'invoice', name: TAG + ' high-band forklift', ext: '.pdf',
    amount: 1240, vendor: 'Sunbelt Rentals', docDate: '2026-11-14', status: 'filed',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':high', sourceLabel: 'Forklift invoice',
                  confidence: 93, matchedBy: ['client_name', 'date_window', 'vendor_history'] }
  }, { key: K, idem: TAG + ':high#doc' });
  ok('status:"filed" at 93 lands directly (§2/§3)',
     highFiled.status === 200 && highFiled.body.status === 'filed', highFiled.body);
  ok('...creating the file AND its expense', !!highFiled.body.fileId && !!highFiled.body.expenseId,
     highFiled.body);
  ok('...with an activity row', !!highFiled.body.activityId);
  const filedRow = await pool.query('SELECT uploaded_by, provenance FROM files WHERE id=$1',
    [highFiled.body.fileId]);
  ok('...attributed to agent:<username> (§1)', filedRow.rows[0].uploaded_by === 'agent:admin',
     filedRow.rows[0].uploaded_by);
  ok('...carrying its provenance', !!filedRow.rows[0].provenance
     && filedRow.rows[0].provenance.agent_user === 'admin', filedRow.rows[0].provenance);

  // ── 8. idempotency ────────────────────────────────────────────────────────
  section('8. idempotency');
  const replay = await POST('/api/agent/documents', {
    showId: S, jobId: J, kind: 'invoice', name: TAG + ' high-band forklift', ext: '.pdf',
    amount: 1240, vendor: 'Sunbelt Rentals', docDate: '2026-11-14', status: 'filed',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':high', sourceLabel: 'Forklift invoice',
                  confidence: 93, matchedBy: ['client_name', 'date_window', 'vendor_history'] }
  }, { key: K, idem: TAG + ':high#doc' });
  ok('an identical replay returns the ORIGINAL response',
     replay.status === 200 && replay.body.fileId === highFiled.body.fileId, replay.body);
  ok('...flagged x-idempotent-replay', replay.headers.get('x-idempotent-replay') === 'true');
  const dupCount = await pool.query('SELECT COUNT(*)::int AS n FROM files WHERE name=$1',
    [TAG + ' high-band forklift']);
  ok('...and did NOT duplicate the row', dupCount.rows[0].n === 1, dupCount.rows[0]);

  // THE TIGHT RETRY. An agent that gets its 200 and immediately retries — no
  // intervening work at all — is the shape that caught the fire-and-forget
  // ledger write. Two back-to-back calls, zero awaits between, must produce
  // ONE row.
  const tightBody = {
    showId: S, kind: 'receipt', name: TAG + ' tight retry', ext: '.pdf',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':tight', confidence: 92 }
  };
  const tight1 = await POST('/api/agent/documents', tightBody, { key: K, idem: TAG + ':tight#doc' });
  const tight2 = await POST('/api/agent/documents', tightBody, { key: K, idem: TAG + ':tight#doc' });
  ok('a tight back-to-back retry returns the same fileId',
     tight1.status === 200 && tight2.status === 200 && tight1.body.fileId === tight2.body.fileId,
     { first: tight1.body.fileId, second: tight2.body.fileId });
  const tightRows = await pool.query('SELECT COUNT(*)::int AS n FROM files WHERE name=$1',
    [TAG + ' tight retry']);
  ok('...and creates exactly ONE row (the ledger commits before the response)',
     tightRows.rows[0].n === 1, tightRows.rows[0]);

  const conflictRes = await POST('/api/agent/documents', {
    showId: S, kind: 'invoice', name: TAG + ' DIFFERENT BODY', status: 'filed',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':high', confidence: 93 }
  }, { key: K, idem: TAG + ':high#doc' });
  ok('the same key with a different body is 409 (§8)', conflictRes.status === 409, conflictRes.body);

  // ── medium band -> proposal -> confirm ────────────────────────────────────
  section('6. proposals — file, don\'t fire');
  const proposed = await POST('/api/agent/documents', {
    showId: S, kind: 'invoice', name: TAG + ' UW stagehand deposit', ext: '.pdf',
    amount: 1500, vendor: 'UW Field House labor', docDate: '2026-11-10',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':med', sourceLabel: 'Inv 2291',
                  confidence: 68, matchedBy: ['client_name'] }
  }, { key: K, idem: TAG + ':med#doc' });
  ok('a 68-confidence doc lands as a PROPOSAL',
     proposed.status === 200 && proposed.body.status === 'proposed' && !!proposed.body.proposalId,
     proposed.body);
  ok('...quarantined under _agent-inbox, never a real show folder (§3)',
     String(proposed.body.nasPath).includes('_agent-inbox'), proposed.body.nasPath);
  const PR = proposed.body.proposalId;
  const noExpenseYet = await pool.query(
    `SELECT COUNT(*)::int AS n FROM expenses WHERE vendor='UW Field House labor'`);
  ok('...and creates NO expense row until confirm (punch 24)', noExpenseYet.rows[0].n === 0,
     noExpenseYet.rows[0]);

  // upload quarantined bytes so the confirm move has something to move
  await call('PUT', `/api/agent/documents/${proposed.body.fileId}/content`,
    { key: K, raw: Buffer.from('quarantined invoice bytes') });

  const byFile = await GET(`/api/files/${proposed.body.fileId}/proposal`, { token: A });
  ok('GET /api/files/:id/proposal resolves file -> proposal (for api.confirmDoc)',
     byFile.status === 200 && byFile.body.id === PR, byFile.body);

  const selfConfirm = await POST(`/api/agent/proposals/${PR}/confirm`, {}, { key: K });
  ok('an agent key CANNOT confirm — no such route exists (§6/§9)',
     selfConfirm.status === 404 || selfConfirm.status === 403, selfConfirm.body);
  const keyOnHuman = await POST(`/api/proposals/${PR}/confirm`, {}, { key: K });
  ok('...and an agent key on the human confirm route is 403',
     keyOnHuman.status === 403, keyOnHuman.body);

  const confirmed = await POST(`/api/proposals/${PR}/confirm`, { notify: [pmUser] }, { token: A });
  ok('POST /api/proposals/:id/confirm honours notify',
     confirmed.status === 200 && (confirmed.body.notified || []).includes(pmUser),
     confirmed.body.notified);
  ok('a human confirms it', confirmed.status === 200 && confirmed.body.status === 'confirmed',
     confirmed.body);
  ok('...materializing the expense', (confirmed.body.created.expenses || []).length === 1,
     confirmed.body.created);
  const movedFile = await pool.query('SELECT nas_path, status FROM files WHERE id=$1',
    [proposed.body.fileId]);
  ok('...moving the doc to its canonical NAS path',
     !movedFile.rows[0].nas_path.includes('_agent-inbox') && movedFile.rows[0].status === 'filed',
     movedFile.rows[0]);
  ok('...and physically moving the bytes',
     confirmed.body.bytesMoved && confirmed.body.bytesMoved.ok === true, confirmed.body.bytesMoved);
  const reconfirm = await POST(`/api/proposals/${PR}/confirm`, {}, { token: A });
  ok('re-confirming an already-resolved proposal is 409', reconfirm.status === 409, reconfirm.body);

  // reject leaves no bytes and deletes nothing
  const toReject = await POST('/api/agent/documents', {
    showId: S, kind: 'receipt', name: TAG + ' wrong show receipt', ext: '.pdf', amount: 99,
    vendor: 'Wrong Vendor',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':rej', confidence: 61 }
  }, { key: K, idem: TAG + ':rej#doc' });
  await call('PUT', `/api/agent/documents/${toReject.body.fileId}/content`,
    { key: K, raw: Buffer.from('bytes that must not survive') });
  const rejected = await POST(`/api/proposals/${toReject.body.proposalId}/reject`,
    { reason: 'wrong show' }, { token: A });
  ok('a human rejects a proposal', rejected.status === 200 && rejected.body.status === 'rejected',
     rejected.body);
  const rejRow = await pool.query('SELECT status FROM files WHERE id=$1', [toReject.body.fileId]);
  ok('...the row is MARKED rejected, never deleted (punch 24)', rejRow.rows[0].status === 'rejected',
     rejRow.rows[0]);
  ok('...and the quarantined bytes are purged', rejected.body.bytesPurged === 1, rejected.body);

  // tasks:batch
  const batch = await POST('/api/agent/tasks:batch', {
    showId: S, status: 'filed',
    provenance: { sourceKind: 'meeting', sourceRef: TAG + ':meeting',
                  sourceLabel: 'Madison production call', confidence: 91, matchedBy: ['participant'] },
    steps: [
      { lane: 'venue', title: TAG + ' Confirm dock height', owner: 'admin', dueDate: '2026-11-05' },
      { lane: 'logistics', title: TAG + ' Rent forklift', dueOffsetDays: -6 }
    ]
  }, { key: K, idem: TAG + ':meeting#tasks' });
  ok('POST /api/agent/tasks:batch files atomically (§4)',
     batch.status === 200 && batch.body.stepIds.length === 2, batch.body);

  const badBatch = await POST('/api/agent/tasks:batch', {
    showId: S, status: 'filed',
    provenance: { sourceKind: 'meeting', sourceRef: TAG + ':bad', confidence: 91 },
    steps: [{ lane: 'venue', title: 'fine' }, { lane: 'nonsense', title: 'bad' }]
  }, { key: K, idem: TAG + ':bad#tasks' });
  ok('one bad lane rejects the WHOLE batch, naming the index (§4)',
     badBatch.status === 400 && badBatch.body.index === 1, badBatch.body);
  const noPartial = await pool.query(`SELECT COUNT(*)::int AS n FROM steps WHERE title='fine'`);
  ok('...writing nothing at all', noPartial.rows[0].n === 0, noPartial.rows[0]);

  const bigBatch = await POST('/api/agent/tasks:batch', {
    showId: S, status: 'proposed',
    provenance: { sourceKind: 'meeting', sourceRef: TAG + ':big', confidence: 70 },
    steps: Array.from({ length: 26 }, (_, i) => ({ lane: 'venue', title: 'step ' + i }))
  }, { key: K, idem: TAG + ':big#tasks' });
  ok('a batch over 25 steps is 400 (§4)', bigBatch.status === 400, bigBatch.body);

  const invented = await POST('/api/agent/tasks:batch', {
    showId: S, status: 'filed',
    provenance: { sourceKind: 'meeting', sourceRef: TAG + ':inv', confidence: 91 },
    steps: [{ lane: 'venue', title: 'x', owner: 'nobody-real' }]
  }, { key: K, idem: TAG + ':inv#tasks' });
  ok('an agent may assign, but may not INVENT people (§4)', invented.status === 400, invented.body);

  // agent notes
  const agentNote = await POST('/api/agent/notes', {
    target: { kind: 'file', id: highFiled.body.fileId },
    body: `Filed the Sunbelt forklift invoice to Madison. @${pmUser} — please eyeball it.`,
    mentions: [pmUser],
    provenance: { sourceKind: 'email', sourceRef: TAG + ':note', confidence: 93 }
  }, { key: K, idem: TAG + ':note#note' });
  ok('POST /api/agent/notes (§5)', agentNote.status === 200 && !!agentNote.body.noteId, agentNote.body);
  ok('...notifies the mention', (agentNote.body.notified || []).includes(pmUser), agentNote.body);
  const agentNoteRow = await pool.query('SELECT author FROM notes WHERE id=$1', [agentNote.body.noteId]);
  ok('...authored as agent:<username>', agentNoteRow.rows[0].author === 'agent:admin',
     agentNoteRow.rows[0]);
  const editAgentNote = await PUT(`/api/notes/${agentNote.body.noteId}`, { body: 'rewritten' }, { token: A });
  ok('an agent-authored note is immutable to humans (punch 37)', editAgentNote.status === 403,
     editAgentNote.body);

  const badMention = await POST('/api/agent/notes', {
    target: { kind: 'show', id: S }, body: 'hi', mentions: ['ghost'],
    provenance: { sourceKind: 'email', sourceRef: TAG + ':gm', confidence: 93 }
  }, { key: K });
  ok('a mention of an unknown user is 400 (§5)', badMention.status === 400, badMention.body);

  // agent projects — ALWAYS a proposal
  const agentProj = await POST('/api/agent/projects', {
    project: { name: TAG + ' Vail Summit LED', client: 'Vail Resorts', type: 'led', stage: 'lead' },
    show: { name: 'Base Village screen', venue: 'Vail Base Village', eventDate: '2026-12-12' },
    job: { name: TAG + ' Vail Summit LED 2026' },
    provenance: { sourceKind: 'email', sourceRef: TAG + ':rfp', sourceLabel: 'RFP — Vail',
                  confidence: 99, matchedBy: ['thread_ref'] }
  }, { key: K, idem: TAG + ':rfp#project' });
  ok('POST /api/agent/projects is ALWAYS a proposal, even at 99 (§5)',
     agentProj.status === 200 && agentProj.body.status === 'proposed', agentProj.body);
  const qbAttempt = await POST('/api/agent/projects', {
    project: { name: TAG + ' QB attempt' }, job: { qbJobNumber: '26-9999' },
    provenance: { sourceKind: 'email', sourceRef: TAG + ':qb', confidence: 99 }
  }, { key: K, idem: TAG + ':qb#project' });
  ok('an agent may never set qb_job_number (§9)', qbAttempt.status === 403, qbAttempt.body);

  const confirmProj = await POST(`/api/proposals/${agentProj.body.proposalId}/confirm`,
    { overrides: { job: { qbJobNumber: '26-1180' }, instantiateTemplate: true } }, { token: A });
  ok('confirm creates project + show + job in one transaction (§5)',
     confirmProj.status === 200 && confirmProj.body.created.projects.length === 1
     && confirmProj.body.created.jobs.length === 1 && confirmProj.body.created.shows.length === 1,
     confirmProj.body.created);
  ok('...and instantiates the template when asked',
     confirmProj.body.created.steps_created > 0, confirmProj.body.created);
  const qbRow = await pool.query('SELECT qb_job_number FROM jobs WHERE id=$1',
    [confirmProj.body.created.jobs[0]]);
  ok('...with the QuickBooks number entered by the HUMAN on confirm',
     qbRow.rows[0].qb_job_number === '26-1180', qbRow.rows[0]);
  const P2 = confirmProj.body.created.projects[0];

  // purchase requests (punch 30)
  const pr = await POST('/api/agent/purchase-requests', {
    projectId: P, jobId: J, vendor: 'TBD — quotes out', memo: 'from the season planning meeting',
    lines: [{ item: 'Spare LED modules + PSU kit', qty: 1, unitCost: 4800, category: 'gear' }],
    provenance: { sourceKind: 'meeting', sourceRef: TAG + ':pr', sourceLabel: 'Season planning',
                  confidence: 82, matchedBy: ['participant'] }
  }, { key: K, idem: TAG + ':pr#po' });
  ok('POST /api/agent/purchase-requests lands status needed (punch 30)',
     pr.status === 200 && pr.body.status === 'needed', pr.body);

  // ── 9. §9 guardrails ──────────────────────────────────────────────────────
  section('9. §9 hard guardrails');
  const agentDelete = await DEL(`/api/agent/shows/${S}`, { key: K });
  ok('no DELETE verb is routed under /api/agent/* at all', agentDelete.status === 404, agentDelete.body);
  const agentPush = await POST(`/api/shows/${S}/push-to-scheduler`, {}, { key: K });
  ok('push-to-scheduler with an agent key is 403 (route topology)', agentPush.status === 403,
     agentPush.body);
  const agentUsers = await GET('/api/users', { key: K });
  ok('user admin with an agent key is 403', agentUsers.status === 403, agentUsers.body);
  const agentKeys = await GET('/api/keys', { key: K });
  ok('key management with an agent key is 403 (§1)', agentKeys.status === 403, agentKeys.body);
  const agentRecap = await POST(`/api/agent/shows/${S}/recap`, {}, { key: K });
  ok('deliverables are absent from the agent surface (punch 53)', agentRecap.status === 404,
     agentRecap.body);
  const agentTypo = await GET('/api/agent/projects/1', { key: K });
  ok('an unknown agent path 404s HERE, never falling through to the human surface',
     agentTypo.status === 404, agentTypo.body);

  // scope enforcement
  const readOnly = await POST('/api/keys', { label: TAG + ' read-only', scopes: ['agent:read'] },
    { token: A });
  const RK = readOnly.body.key;
  const scopeDenied = await POST('/api/agent/documents', {
    showId: S, kind: 'receipt', name: 'x',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':scope', confidence: 90 }
  }, { key: RK, idem: TAG + ':scope#doc' });
  ok("a key lacking 'agent:file' is 403 (§1)",
     scopeDenied.status === 403 && /scope/.test(scopeDenied.body.error || ''), scopeDenied.body);

  // revoked key
  const revokeId = keyList.body.find((k) => k.label === TAG + ' read-only')
    || (await GET('/api/keys', { token: A })).body.find((k) => k.label === TAG + ' read-only');
  await DEL(`/api/keys/${revokeId.id}`, { token: A });
  const revoked = await GET('/api/agent/whoami', { key: RK });
  ok('a revoked key is 401', revoked.status === 401, revoked.body);

  // ══════════════════════════════════════════════════════════════════════════
  // 12. PUSH TO SCHEDULER — the mapping, field by field
  // ─────────────────────────────────────────────────────────────────────────
  // The dry run IS the contract test. Every assertion below is one of the
  // fourteen mismatches from INTEGRATIONS_SPEC.md §2.4, checked against the
  // payload the LIVE path would send — because both come out of the same
  // builder in lib/scheduler.js, so they cannot drift.
  // ══════════════════════════════════════════════════════════════════════════
  section('12. push-to-scheduler — the M1–M14 field mapping');

  // give the show the shapes the mapping actually has to handle
  await POST('/api/steps', { show_id: S, lane: 'logistics', title: 'Hotel block for install crew',
    status: 'todo' }, { token: A });
  await POST('/api/steps', { show_id: S, lane: 'logistics', title: '53ft dry van to venue',
    status: 'done', evidence_type: 'booking', evidence_ref: 'https://landstar.example/conf/889' },
    { token: A });
  await POST('/api/steps', { show_id: S, lane: 'logistics', title: 'Strike labor — 6 hands',
    status: 'todo' }, { token: A });
  await POST('/api/steps', { show_id: S, lane: 'logistics', title: 'Feeder cable + distro',
    status: 'todo' }, { token: A });
  const crewRow = await POST(`/api/shows/${S}/crew`, {
    name: 'Dana Fields', role_on_site: 'Lead Tech', call_time: '07:00',
    travel: { out: { flight_num: 'AA1234', arrival_date: '2026-11-08', arrival_time: '14:20',
                     departure_city: 'DFW', record_locator: 'ABCDEF' },
              back: { flight_num: 'AA9876', departure_date: '2026-11-12', departure_time: '18:05' } }
  }, { token: A });
  ok('a crew line with staffing-shaped travel is accepted', crewRow.status === 200, crewRow.body);

  const dry = await POST(`/api/shows/${S}/push-to-scheduler`, {}, { token: A });
  ok('push-to-scheduler dry run returns the payloads', dry.status === 200 && dry.body.dryRun === true,
     Object.keys(dry.body || {}));
  const pl = (dry.body && dry.body.payloads) || {};
  const cats = (pl.bookings || []).map((b) => b.category);
  const LEGAL_CATS = ['trucking', 'forklift', 'feeder_cable', 'install_labor', 'strike_labor',
                      'hotel', 'other'];
  ok('M1: every booking category is inside staffing\'s closed 7-key enum',
     cats.length > 0 && cats.every((c) => LEGAL_CATS.includes(c)), cats);
  ok('M2: a hotel booking is LOWERCASE "hotel" (the packet builder tests it twice)',
     cats.includes('hotel'), cats);
  ok('M1: "Strike labor" maps to strike_labor, not install_labor (order matters)',
     cats.includes('strike_labor'), cats);
  ok('M1: "Feeder cable + distro" maps to feeder_cable',
     cats.includes('feeder_cable'), cats);
  ok('M3: booking status is only "booked" or "needed" — never "confirmed"',
     (pl.bookings || []).every((b) => b.status === 'booked' || b.status === 'needed'),
     (pl.bookings || []).map((b) => b.status));
  ok('M3: the done step is "booked"',
     (pl.bookings || []).some((b) => b.customLabel === '53ft dry van to venue' && b.status === 'booked'),
     pl.bookings);
  ok('M10: vendorName is empty and the evidence ref rides in notes',
     (pl.bookings || []).every((b) => b.vendorName === '')
     && (pl.bookings || []).some((b) => /landstar\.example/.test(b.notes || '')),
     (pl.bookings || []).map((b) => ({ v: b.vendorName, n: b.notes })));
  ok('R10: quantity is a STRING (the staffing column is TEXT)',
     (pl.bookings || []).every((b) => b.quantity === '1'), (pl.bookings || [])[0]);

  ok('M4: travel is in the payload at all (it never used to be)',
     Array.isArray(pl.travel) && pl.travel.length === 2, pl.travel);
  const arr = (pl.travel || []).find((t) => t.leg === 'arrival');
  const dep = (pl.travel || []).find((t) => t.leg === 'departure');
  ok('M5: the arrival key uses the |inbound sentinel, event id in position 1',
     !!arr && /\|inbound$/.test(arr.key) && arr.key.split('|').length === 3, arr && arr.key);
  ok('M5: the departure key uses the |outbound sentinel',
     !!dep && /\|outbound$/.test(dep.key) && dep.key.split('|').length === 3, dep && dep.key);
  ok('M5: no travel key has an empty segment (a row staffing would never find)',
     (pl.travel || []).every((t) => t.key.split('|').every((seg) => seg.length > 0)),
     (pl.travel || []).map((t) => t.key));
  ok('B.6: the travel body carries the ten staffing column names',
     !!arr && ['flightNum', 'arrivalTime', 'arrivalDate', 'isDriving', 'departureCity',
               'departureDate', 'departureTime', 'goingHome', 'recordLocator']
       .every((k) => k in arr), arr && Object.keys(arr));
  ok('§2.6: the outbound leg is goingHome:true', !!dep && dep.goingHome === true, dep);

  const ep = pl.eventPayload || {};
  ok('M9: techNotes / mediaServer / archived are ABSENT from the event payload',
     !('techNotes' in ep) && !('mediaServer' in ep) && !('archived' in ep), Object.keys(ep));
  ok('M11: the five legacy clientContact* fields are ABSENT',
     !Object.keys(ep).some((k) => k.startsWith('clientContact')), Object.keys(ep));
  ok('M13: eventDate is omitted rather than sent as an empty string',
     !('eventDate' in ep) || ep.eventDate !== '', ep.eventDate);
  ok('M14: no booking is categorised "Travel" or "Power/Cable"',
     !cats.includes('Travel') && !cats.includes('Power/Cable'), cats);
  ok('the dry run advertises the /api/travel target it would call',
     /\/api\/travel/.test(String(dry.body.targets && dry.body.targets.travel)), dry.body.targets);
  ok('the dry run advertises programmatic login, NOT a static token',
     /auth\/login/.test(String(dry.body.targets && dry.body.targets.auth))
     && !/SCHEDULER_API_TOKEN/.test(JSON.stringify(dry.body)), dry.body.targets);

  // M7 — a show with no load-in date must be refused, not silently pushed into
  // an event that can never get a Flex folder.
  const noLoadIn = await POST('/api/shows',
    { project_id: P, name: TAG + ' no-load-in', venue: 'TBD', event_date: '2026-12-01' }, { token: A });
  const dryNo = await POST(`/api/shows/${noLoadIn.body.id}/push-to-scheduler`, {}, { token: A });
  ok('M7: a show with no load-in date is reported NOT ready, with the reason',
     dryNo.status === 200 && dryNo.body.ready === false
     && dryNo.body.problems.some((p) => /load-in/i.test(p)), dryNo.body.problems);

  const live = await POST(`/api/shows/${S}/push-to-scheduler`, { live: true }, { token: A });
  ok('the LIVE path is 501 while SCHEDULER_BASE_URL is unset — the safe default',
     live.status === 501, live.body && live.body.error);
  ok('...and the 501 names what is missing, not "not implemented"',
     /SCHEDULER_BASE_URL/.test(JSON.stringify(live.body || {})), live.body);
  ok('...and does NOT ask for the retired SCHEDULER_API_TOKEN',
     !/SCHEDULER_API_TOKEN=/.test(JSON.stringify(live.body || {})), live.body);

  // travel read-back must never break the call sheet when staffing is unreachable
  const tv = await GET(`/api/shows/${S}/travel`, { token: A });
  ok('GET /shows/:id/travel answers 200 with the scheduler unconfigured',
     tv.status === 200 && Array.isArray(tv.body.crew), tv.body && Object.keys(tv.body));
  ok('...and says the show is not linked rather than implying nobody is flying',
     tv.body.scheduler && tv.body.scheduler.linked === false, tv.body.scheduler);
  const ros2 = await GET(`/api/shows/${S}/run-of-show`, { token: A });
  ok('the run of show still renders with no scheduler (the call sheet must not fail)',
     ros2.status === 200 && Array.isArray(ros2.body.crew) && !!ros2.body.scheduler, ros2.status);

  // ══════════════════════════════════════════════════════════════════════════
  // 13. SPEC BIND (D1–D4, D6–D8) — bound against Tom's REAL banked specs
  // ══════════════════════════════════════════════════════════════════════════
  section('13. spec-bind, the chain, and the stack-aware checker');

  // D4. the public config the popup reads to know whose postMessage to trust
  const cfg = await GET('/api/config');
  ok('D4: GET /api/config is public (no session needed)', cfg.status === 200, cfg.status);
  ok('D4: it serves toolsOrigins so public/ never hardcodes an origin',
     Array.isArray(cfg.body.toolsOrigins), cfg.body);
  ok('T2: the extension comes from a MAP, not a ternary (pcfg is not ".nsf")',
     cfg.body.specExt && cfg.body.specExt.pcfg === '.pcfg', cfg.body.specExt);
  ok('D4: it reports the scheduler/flex features as OFF here',
     cfg.body.features && cfg.body.features.schedulerPush === false
     && cfg.body.features.flex === false, cfg.body.features);

  const { e360Doc, nsfDoc, sampleSource } = loadSpecSamples();
  console.log(`  (spec samples: ${sampleSource})`);

  // D1. bind the .e360 -> the `content` node
  const bind1 = await POST(`/api/shows/${S}/spec-bind`, {
    specType: 'e360', json: e360Doc, svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    pageHtml: '<!doctype html><html><body>vnl</body></html>',
    png: 'data:image/png;base64,iVBORw0KGgo=',
    suggestedName: TAG + ' VNL Chicago', toolVersion: 'e360/probe', sourceUrl: 'https://tools.example/e360/'
  }, { token: A });
  ok('D1: POST /shows/:id/spec-bind binds the .e360', bind1.status === 200 && bind1.body.ok === true,
     bind1.body);
  ok('D1: it lands on the `content` node at rev 1',
     bind1.body.node === 'content' && bind1.body.rev === 1, bind1.body);
  ok('D1: the .e360 extension comes from the map', bind1.body.ext === '.e360', bind1.body.ext);
  const specFileId = bind1.body.fileId;
  const fRow = await pool.query('SELECT * FROM files WHERE id=$1', [specFileId]);
  ok('D1: the files row carries kind/spec_type/chain_key together',
     fRow.rows[0].kind === 'spec' && fRow.rows[0].spec_type === 'e360'
     && fRow.rows[0].chain_key === 'content', fRow.rows[0]);
  ok('D1: nas_path is server-derived under the show folder',
     /\\S\d+-.*\\spec\\/.test(fRow.rows[0].nas_path), fRow.rows[0].nas_path);
  const specBytes = await storageGet(fRow.rows[0].nas_path);
  ok('D1: the .e360 BYTES are on the NAS and re-parse to the same document',
     !!specBytes && JSON.parse(specBytes).fields.cabinetType === e360Doc.fields.cabinetType,
     specBytes && specBytes.slice(0, 40));

  // D2. the render bundle
  const rRow = await pool.query('SELECT * FROM spec_renders WHERE file_id=$1', [specFileId]);
  ok('D2: a spec_renders row exists for the bind', rRow.rows.length === 1, rRow.rows.length);
  ok('D2: it stores svg + html + png + json at the bind rev',
     rRow.rows[0] && rRow.rows[0].svg && rRow.rows[0].html && rRow.rows[0].png
     && rRow.rows[0].json && rRow.rows[0].rev === 1, rRow.rows[0] && Object.keys(rRow.rows[0]));
  const rend = await GET(`/api/shows/${S}/spec-render/content`, { token: A });
  ok('D2: GET /shows/:id/spec-render/:node serves it back',
     rend.status === 200 && rend.body.specType === 'e360' && !!rend.body.html, rend.status);

  // D1 step 2 — the type sniff the staffing app never does
  const wrongType = await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'e360', json: nsfDoc }, { token: A });
  ok('D1: a .nsf declared as e360 is REFUSED, naming both types',
     wrongType.status === 400 && /NovaSpec|nsf/.test(wrongType.body.error), wrongType.body);
  const notASpec = await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'pcfg', json: { hello: 'world' } }, { token: A });
  ok('D1: a document with no type marker at all is refused', notASpec.status === 400, notASpec.body);
  const badSvg = await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'nsf', json: nsfDoc, svg: '<html>nope' }, { token: A });
  ok("D1: svg must start with '<svg'", badSvg.status === 400, badSvg.body);

  // D8. the logo MIME gate — a stored .e360 is attacker-influenced input
  const evil = JSON.parse(JSON.stringify(e360Doc));
  evil.clientLogoDataUrl = 'data:image/svg+xml,<svg onload=alert(1)>';
  const bindEvil = await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'e360', json: evil, suggestedName: TAG + ' evil-logo' }, { token: A });
  ok('D8: a bind carrying an svg+xml logo still succeeds...',
     bindEvil.status === 200, bindEvil.body);
  ok('D8: ...but the logo is STRIPPED, and the caller is told',
     bindEvil.body.logoStripped === true, bindEvil.body.logoStripped);
  const evilStored = await pool.query('SELECT json FROM spec_renders WHERE file_id=$1',
    [bindEvil.body.fileId]);
  ok('D8: no svg+xml data URL reaches a render path',
     evilStored.rows[0].json.clientLogoDataUrl === null, evilStored.rows[0].json.clientLogoDataUrl);
  ok('D8: a legitimate webp/png logo is NOT stripped', bind1.body.logoStripped === false,
     bind1.body.logoStripped);

  // supersede, never delete
  const supIds = bindEvil.body.supersededFileIds || [];
  ok('D1: re-binding the same node SUPERSEDES the previous file, never deletes it',
     supIds.includes(specFileId), supIds);
  const supRow = await pool.query('SELECT status FROM files WHERE id=$1', [specFileId]);
  ok('D1: ...the superseded row is still there, marked',
     supRow.rows[0] && supRow.rows[0].status === 'superseded', supRow.rows[0]);
  ok('D1: the rebind bumped content to rev 2', bindEvil.body.rev === 2, bindEvil.body.rev);

  // the stale-flag cascade
  const bindNsf = await POST(`/api/shows/${S}/spec-bind`, {
    specType: 'nsf', json: nsfDoc, suggestedName: TAG + ' VNL cabling'
  }, { token: A });
  ok('D1: the .nsf binds to the `cabling` node',
     bindNsf.status === 200 && bindNsf.body.node === 'cabling', bindNsf.body);
  ok('the chain: cabling is NOT stale right after binding under content v2',
     bindNsf.body.chain.cabling.stale === false
     && bindNsf.body.chain.cabling.derivedRev === 2, bindNsf.body.chain);
  const rebind = await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'e360', json: e360Doc, suggestedName: TAG + ' VNL v3' }, { token: A });
  ok('re-binding the PARENT bumps content to rev 3', rebind.body.rev === 3, rebind.body.rev);
  ok('...and the stale flag cascades to cabling with no extra code',
     rebind.body.stale.cabling === true, rebind.body.stale);
  ok('...while content itself is never stale (it has no parent)',
     rebind.body.stale.content === false, rebind.body.stale);

  // ── D7. the stack-aware checker, on the case that made it necessary ───────
  const chk = await GET(`/api/shows/${S}/spec-check`, { token: A });
  ok('D7: GET /shows/:id/spec-check returns the checker output', chk.status === 200, chk.status);
  // Tom's rule: a question, never an accusation. The sentence the operator
  // actually reads (`ask`) may not call anything an error, a mismatch or
  // invalid — it must ask. (`detail` MAY say "this is not an error", and does.)
  ok('D7: every finding is kind:"question"',
     (chk.body.questions || []).length > 0
     && (chk.body.questions || []).every((q) => q.kind === 'question'),
     (chk.body.questions || []).map((q) => q.id));
  ok('D7: no `ask` accuses — no "error" / "mismatch" / "invalid", and each one asks',
     (chk.body.questions || []).every((q) =>
       !/\b(error|mismatch|invalid|wrong)\b/i.test(q.ask)
       && /\?|confirm|verify/i.test(q.ask)),
     (chk.body.questions || []).map((q) => q.ask));
  ok('D7: it is marked provisional pending Tom\'s stacked-zone walkthrough',
     chk.body.provisional === true, chk.body.provisional);
  const qids = (chk.body.questions || []).map((q) => q.id);
  ok('D7 rule 1: 144 declared vs 120 geometry is asked about, not asserted',
     qids.includes('e360.declared-vs-geometry'), qids);
  const dq = (chk.body.questions || []).find((q) => q.id === 'e360.declared-vs-geometry');
  ok('...with both numbers named (declared 144, geometry 120)',
     dq && dq.values.declared === 144 && dq.values.geometry === 120, dq && dq.values);
  ok('D7 rule 2: NSF-only stacking is reported as NORMAL, not as drift',
     qids.includes('stacking.nsf-only')
     && /normal/i.test((chk.body.questions.find((q) => q.id === 'stacking.nsf-only') || {}).ask || ''),
     chk.body.questions.find((q) => q.id === 'stacking.nsf-only'));
  ok('D7 rule 3: 120 vs 124 is NOT flagged — the .e360 has no stacking data to compare',
     !qids.includes('total.stack-aware') && !qids.includes('total.single-height'), qids);
  ok('D7: the facts block computes cxPathTotal correctly (120 flat, 124 stack-aware)',
     chk.body.facts.nsf.sectionTotal === 120 && chk.body.facts.nsf.stackAwareTotal === 124,
     chk.body.facts.nsf);
  ok('D7: matching cab type / dimensions raise NO question',
     !qids.some((i) => /^cabtype|^fieldlength|^fieldwidth|^bearing/.test(i)), qids);

  // and the drift a checker SHOULD surface
  const drifted = JSON.parse(JSON.stringify(nsfDoc));
  drifted.fields.fieldWidth = '56';
  drifted.fields.cabType = 'p10';
  await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'nsf', json: drifted, suggestedName: TAG + ' drifted' }, { token: A });
  const chk2 = await GET(`/api/shows/${S}/spec-check`, { token: A });
  const q2 = (chk2.body.questions || []).map((q) => q.id);
  ok('D7: a real one-field edit (width 59 -> 56) IS surfaced',
     q2.includes('fieldwidth.e360-nsf'), q2);
  ok('D7: a cabinet-type change IS surfaced', q2.includes('cabtype.e360-nsf'), q2);

  // D3. the per-route body limit
  ok('D3: the spec-bind route accepts a payload over the 1 MB global JSON limit',
     bind1.status === 200 && JSON.stringify(e360Doc).length > 20000, JSON.stringify(e360Doc).length);
  const fat = await POST(`/api/notes`, { anchor_type: 'show', anchor_id: S,
    body: 'x'.repeat(1200 * 1024) }, { token: A });
  ok('D3: ...while every OTHER route keeps the 1 MB default', fat.status === 413, fat.status);

  // D6. an agent can FILE a spec artifact — but still cannot BIND the chain
  const agentSpec = await POST('/api/agent/documents', {
    showId: S, kind: 'spec', name: TAG + ' spec from email', ext: '.e360',
    spec_type: 'e360', chain_key: 'content', artifact: 'document', status: 'filed',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':spec', sourceLabel: 'VNL spec sheet',
                  confidence: 92, matchedBy: ['client_name', 'date_window'] }
  }, { key: K, idem: TAG + ':spec#doc' });
  ok('D6: an agent can file a spec artifact', agentSpec.status === 200, agentSpec.body);
  const aRow = await pool.query('SELECT spec_type, chain_key, artifact FROM files WHERE id=$1',
    [agentSpec.body.fileId]);
  ok('D6: ...with spec_type, chain_key and artifact actually persisted',
     aRow.rows[0].spec_type === 'e360' && aRow.rows[0].chain_key === 'content'
     && aRow.rows[0].artifact === 'document', aRow.rows[0]);
  const revNow = await pool.query(`SELECT rev FROM spec_chain WHERE show_id=$1 AND node='content'`, [S]);
  ok('D6: ...and it did NOT bump the chain rev — binding stays session-only',
     revNow.rows[0].rev === 3, revNow.rows[0]);
  const badChainKey = await POST('/api/agent/documents', {
    showId: S, kind: 'spec', name: TAG + ' bad node', spec_type: 'e360', chain_key: 'nonsense',
    provenance: { sourceKind: 'email', sourceRef: TAG + ':bad', confidence: 92 }
  }, { key: K, idem: TAG + ':badnode#doc' });
  ok('D6: an unknown chain_key is a 400', badChainKey.status === 400, badChainKey.body);
  const agentBind = await POST(`/api/shows/${S}/spec-bind`,
    { specType: 'e360', json: e360Doc }, { key: K });
  ok('§9: an agent key cannot reach spec-bind at all (route topology)',
     agentBind.status === 403 || agentBind.status === 404, agentBind.status);

  // ══════════════════════════════════════════════════════════════════════════
  // 14. THE PRE-DEPLOY HARDENING PASS (HARDENING_TODO.md, 2026-08-27)
  // ─────────────────────────────────────────────────────────────────────────
  // One block per fixed item. Each is written to FAIL on the old behaviour, so
  // reverting a fix turns one of these red rather than passing quietly.
  // ══════════════════════════════════════════════════════════════════════════
  section('14. hardening — margin leak, PO numbering, routing, cascades');

  // ── 2. contract_value is margin by subtraction ───────────────────────────
  // Costs are visible to everyone by design, so shipping the contract value to
  // a caller who may not see `margin` handed them the margin anyway.
  const jobAsFin = await GET(`/api/jobs/${J}`, { token: FINT });
  const jobAsPm = await GET(`/api/jobs/${J}`, { token: PMT });
  ok('2: finance still sees contract_value on a job',
     jobAsFin.status === 200 && jobAsFin.body.contract_value !== undefined, jobAsFin.body);
  ok('2: a pm does NOT — it is the missing term in billed − costs',
     jobAsPm.status === 200 && jobAsPm.body.contract_value === undefined, jobAsPm.body);
  const jobsAsPm = await GET('/api/jobs', { token: PMT });
  ok('2: ...on the LIST route too', jobsAsPm.body.every((j) => j.contract_value === undefined),
     jobsAsPm.body.slice(0, 2));
  const projAsPm = await GET(`/api/projects/${P}`, { token: PMT });
  const projAsFin = await GET(`/api/projects/${P}`, { token: FINT });
  ok('2: ...and inside a hydrated project, which is where it actually leaked',
     (projAsPm.body.jobs || []).every((j) => j.contract_value === undefined)
     && (projAsFin.body.jobs || []).some((j) => j.contract_value !== undefined),
     { pm: (projAsPm.body.jobs || [])[0], fin: (projAsFin.body.jobs || [])[0] });
  const finAsPm = await GET(`/api/jobs/${J}/finance`, { token: PMT });
  ok('2: ...and nested under jobFinance, whose `job` the top-level strip missed',
     finAsPm.body.margin === undefined && finAsPm.body.billed === undefined
     && finAsPm.body.job && finAsPm.body.job.contract_value === undefined, finAsPm.body.job);
  ok('2: budgets and burn stay visible to the pm — the gate is margin, not money',
     finAsPm.body.budget_total !== undefined && finAsPm.body.actual !== undefined,
     { budget_total: finAsPm.body.budget_total, actual: finAsPm.body.actual });

  // ── 4. PO numbering is NUMERIC, and a collision is not a 500 ──────────────
  // THE DISCRIMINATING PAIR. Planting a 4-digit number alone proves nothing:
  // 'PO-26-4000' sorts last either way. The bug only shows when a number with a
  // HIGHER leading digit sits beside a longer one — 'PO-26-999' sorts ABOVE
  // 'PO-26-1000' as text, so a lexicographic max says "next is 1000", which is
  // already taken, and the unique index turns that into a raw 500.
  const yy = new Date().getFullYear().toString().slice(-2);
  for (const n of [`PO-${yy}-999`, `PO-${yy}-1000`]) {
    await pool.query(
      `INSERT INTO purchase_orders (po_number, vendor, project_id, status, created_by)
       VALUES ($1,'smoke-plant',$2,'needed',$3)`, [n, P, TAG]);
  }
  const afterPlant = await POST('/api/pos', { project_id: P, vendor: 'Numbering probe' },
    { token: A });
  ok('4: the human path takes the NUMERIC max — 1001, not a re-issued 1000',
     afterPlant.status === 200 && afterPlant.body.po_number === `PO-${yy}-1001`,
     afterPlant.body.po_number);
  const agentPo = await POST('/api/agent/purchase-requests', {
    projectId: P, vendor: 'Agent numbering probe',
    lines: [{ item: 'probe', qty: 1, unitCost: 1, category: 'gear' }],
    provenance: { sourceKind: 'email', sourceRef: TAG + ':num', confidence: 90 }
  }, { key: K, idem: TAG + ':num#po' });
  ok('4: the AGENT path agrees — it shares nextPoNumber() now, not a copy of it',
     agentPo.status === 200 && agentPo.body.poNumber === `PO-${yy}-1002`, agentPo.body);
  // and two at once do not both take the same number
  const [race1, race2] = await Promise.all([
    POST('/api/pos', { project_id: P, vendor: 'Race A' }, { token: A }),
    POST('/api/pos', { project_id: P, vendor: 'Race B' }, { token: A })
  ]);
  ok('4: two concurrent creates neither 500 nor collide',
     race1.status === 200 && race2.status === 200
     && race1.body.po_number !== race2.body.po_number,
     { a: race1.body.po_number, b: race2.body.po_number, sa: race1.status, sb: race2.status });
  const dupAttempt = await POST('/api/pos',
    { project_id: P, vendor: 'Dup', po_number: `PO-${yy}-1000` }, { token: A });
  ok('4: a CALLER-SUPPLIED duplicate is a 409, never a raw 500',
     dupAttempt.status === 409, dupAttempt.body);

  // ── 5. the thumbnailer PATCH is reachable at all ─────────────────────────
  // Six routers applying requireAuth at the router level sat above photos.js,
  // so this token-authenticated daemon route was answered 401 by a router that
  // does not own it. The assertion is that it is NOT 401 — reaching photos.js
  // and being judged there is the whole point.
  const thumbPhoto = await POST(`/api/shows/${S}/photos`, {
    name: TAG + '-thumb-probe', ext: '.jpg', taken_at: '2026-06-01T10:00:00Z'
  }, { token: A });
  const PHID = thumbPhoto.body && thumbPhoto.body.id;
  ok('5: fixture — a photo exists to thumbnail', thumbPhoto.status === 200 && !!PHID,
     thumbPhoto.body);
  // The daemon carries x-thumbnailer-token and NO session. That is the request
  // the six blanket-auth routers used to answer 401 before photos.js ever saw
  // it. tokenMatches() reads the env var per request, so setting it here is
  // enough to make the daemon real.
  const prevThumbTok = process.env.THUMBNAILER_TOKEN;
  process.env.THUMBNAILER_TOKEN = TAG + '-thumb-secret';
  const daemonThumb = await call('PATCH', `/api/photos/${PHID}/thumb`,
    { headers: { 'x-thumbnailer-token': TAG + '-thumb-secret' }, body: {} });
  ok('5: the NAS daemon\'s token-only PATCH REACHES photos.js and succeeds',
     daemonThumb.status === 200
     && /_t320\.jpg$/.test(String(daemonThumb.body.thumb_path || '')),
     { status: daemonThumb.status, body: daemonThumb.body });
  const wrongTok = await call('PATCH', `/api/photos/${PHID}/thumb`,
    { headers: { 'x-thumbnailer-token': 'not-the-secret' }, body: {} });
  ok('5: ...a WRONG token is 403 from photos.js — the gate is real, not absent',
     wrongTok.status === 403 && /thumbnailer/i.test(wrongTok.body.error || ''), wrongTok.body);
  if (prevThumbTok === undefined) delete process.env.THUMBNAILER_TOKEN;
  else process.env.THUMBNAILER_TOKEN = prevThumbTok;
  const noTokenThumb = await call('PATCH', `/api/photos/${PHID}/thumb`, { body: {} });
  ok('5: ...and with no credential at all it is still refused',
     noTokenThumb.status === 401 || noTokenThumb.status === 403, noTokenThumb.body);
  const sessionThumb = await call('PATCH', `/api/photos/${PHID}/thumb`, { token: A, body: {} });
  ok('5: a pm+ session sets the thumb too, path derived server-side',
     sessionThumb.status === 200 && /_t320\.jpg$/.test(String(sessionThumb.body.thumb_path || '')),
     sessionThumb.body.thumb_path);

  // ── 6. superseded is a real status, and history is not inventory ─────────
  const supName = TAG + '-supersede';
  const f1 = await POST('/api/files', { show_id: S, name: supName, ext: '.e360',
    kind: 'spec', spec_type: 'e360', chain_key: TAG + ':chain' }, { token: A });
  const f2 = await POST('/api/files', { show_id: S, name: supName + '-v2', ext: '.e360',
    kind: 'spec', spec_type: 'e360', chain_key: TAG + ':chain', replace_chain: true },
    { token: A });
  ok('6: fixture — the second file superseded the first',
     f2.status === 200
     && (await pool.query('SELECT status FROM files WHERE id=$1', [f1.body.id])).rows[0].status === 'superseded');
  const liveList = await GET(`/api/files?show_id=${S}&chain_key=${encodeURIComponent(TAG + ':chain')}`,
    { token: A });
  ok('6: the default listing shows only the LIVE revision',
     liveList.body.length === 1 && liveList.body[0].id === f2.body.id,
     liveList.body.map((f) => ({ id: f.id, status: f.status })));
  const histList = await GET(
    `/api/files?show_id=${S}&chain_key=${encodeURIComponent(TAG + ':chain')}&status=superseded`,
    { token: A });
  ok('6: ...and the retired one is still reachable by asking for it',
     histList.body.length === 1 && histList.body[0].id === f1.body.id,
     histList.body.map((f) => f.id));
  const bornRetired = await POST('/api/files', { show_id: S, name: TAG + '-born-retired',
    ext: '.pdf', kind: 'other', status: 'superseded' }, { token: A });
  ok('6: a client may not FILE something already superseded — that is a server act',
     bornRetired.body.status === 'filed', bornRetired.body.status);

  // ── 7. deleting a file takes its spec renders with it ────────────────────
  await pool.query(
    `INSERT INTO spec_renders (file_id, show_id, node, spec_type, rev, svg)
     VALUES ($1,$2,'content','e360',1,'<svg/>')`, [f2.body.id, S]);
  const rendersBefore = parseInt((await pool.query(
    'SELECT COUNT(*) n FROM spec_renders WHERE file_id=$1', [f2.body.id])).rows[0].n, 10);
  const delFile = await DEL(`/api/files/${f2.body.id}`, { token: A });
  const rendersAfter = parseInt((await pool.query(
    'SELECT COUNT(*) n FROM spec_renders WHERE file_id=$1', [f2.body.id])).rows[0].n, 10);
  ok('7: DELETE /files/:id removes the file\'s spec_renders (file_id is NOT NULL)',
     delFile.status === 200 && rendersBefore === 1 && rendersAfter === 0,
     { before: rendersBefore, after: rendersAfter });

  // ── 8. one hydrateShow — the call sheet and the dashboard agree on RAG ───
  // The call sheet used to build its own show object with no derived rag, so it
  // reported the STORED column while every other route reported the derivation.
  // A blocked step makes those two disagree, which is what makes this a test:
  // stored 'go', derived 'crit'. Both precedence levels are checked, because a
  // wrapper that dropped `extra` entirely would still pass the derived half.
  await POST('/api/steps', { show_id: S, lane: 'logistics',
    title: TAG + ' blocked on purpose', status: 'blocked' }, { token: A });
  await pool.query(`UPDATE shows SET rag='go', rag_override=NULL WHERE id=$1`, [S]);
  const showView = await GET(`/api/shows/${S}`, { token: A });
  const sheetView = await GET(`/api/shows/${S}/call-sheet`, { token: A });
  ok('8: the show detail DERIVES the rag rather than reading the column',
     showView.body.rag === 'crit', { derived: showView.body.rag, stored: 'go' });
  ok('8: ...and the call sheet says the SAME thing — one hydrateShow now',
     sheetView.body.show.rag === 'crit', sheetView.body.show.rag);
  ok('8: ...while still carrying the call sheet\'s own extras',
     !!sheetView.body.show.project && !!sheetView.body.show.type, sheetView.body.show.type);
  // and a manager's explicit override still beats the derivation on BOTH
  await pool.query(`UPDATE shows SET rag_override='go' WHERE id=$1`, [S]);
  const showOv = await GET(`/api/shows/${S}`, { token: A });
  const sheetOv = await GET(`/api/shows/${S}/call-sheet`, { token: A });
  ok('8: an explicit rag_override wins on both routes, not just one',
     showOv.body.rag === 'go' && sheetOv.body.show.rag === 'go',
     { detail: showOv.body.rag, callSheet: sheetOv.body.show.rag });

  // ── 10. one notify mechanism, four callers ───────────────────────────────
  // The axes that used to differ per module: a non-array is loud everywhere, a
  // self-notify is dropped everywhere, an unknown name is a 400 everywhere.
  const poForNotify = await POST('/api/pos', { project_id: P, vendor: 'Notify probe' },
    { token: A });
  const badShape = await POST(`/api/pos/${poForNotify.body.id}/lines`,
    { item: 'x', qty: 1, unit_cost: 1, notify: { not: 'an array' } }, { token: A });
  ok('10: a non-array notify is a 400 on purchasing (it used to be ignored here)',
     badShape.status === 400, badShape.body);
  const badShapeSched = await POST(`/api/shows/${S}/schedule`,
    { day: '2026-12-01', start_time: '09:00', title: 'x', notify: 5 }, { token: A });
  ok('10: ...and on schedule, with the same message', badShapeSched.status === 400,
     badShapeSched.body);
  const selfNotify = await POST(`/api/pos/${poForNotify.body.id}/lines`,
    { item: 'self', qty: 1, unit_cost: 1, notify: ['admin'] }, { token: A });
  ok('10: notifying only yourself notifies nobody — dropped in every family now',
     selfNotify.status === 200, selfNotify.body);
  const selfNoteCount = parseInt((await pool.query(
    `SELECT COUNT(*) n FROM note_mentions WHERE username='admin'`)).rows[0].n, 10);
  ok('10: ...and left no self-mention row behind', selfNoteCount === 0, { rows: selfNoteCount });
  const csvNotify = await POST(`/api/pos/${poForNotify.body.id}/lines`,
    { item: 'csv', qty: 1, unit_cost: 1, notify: `${pmUser},${techUser}` }, { token: A });
  ok('10: a comma string still works — purchasing\'s affordance, now shared',
     csvNotify.status === 200, csvNotify.body);
  const ghostNotify = await POST(`/api/shows/${S}/schedule`,
    { day: '2026-12-01', start_time: '10:00', title: 'x', notify: ['ghost-person'] },
    { token: A });
  ok('10: an unknown name is a 400 that NAMES it, from any family',
     ghostNotify.status === 400 && /ghost-person/.test(ghostNotify.body.error || ''),
     ghostNotify.body);

  // ── 13. the bind popup can tell "not configured" from "refused" ──────────
  const hardCfg = await GET('/api/config');
  ok('13: /api/config reports features.specBind',
     typeof hardCfg.body.features.specBind === 'boolean', hardCfg.body.features);
  ok('13: ...and it agrees with the allowlist it is derived from',
     hardCfg.body.features.specBind === (hardCfg.body.toolsOrigins.length > 0),
     { flag: hardCfg.body.features.specBind, origins: hardCfg.body.toolsOrigins });

  // ── 6. cascade integrity ──────────────────────────────────────────────────
  section('6. cascade integrity — a folder with a child of EVERY type');
  const before = await childCounts(P);
  ok('the smoke folder has children of every wired type',
     Object.values(before).every((n) => n >= 0)
     && before.shows > 0 && before.steps > 0 && before.files > 0 && before.expenses > 0
     && before.jobs > 0 && before.budget_lines > 0 && before.notes > 0 && before.note_reads > 0
     && before.note_mentions > 0 && before.schedule_items > 0 && before.crew_assignments > 0
     && before.deliverables > 0 && before.milestones > 0 && before.proposals > 0
     && before.purchase_orders > 0 && before.po_lines > 0 && before.activity > 0,
     before);
  // add the remaining child types so the cascade is exercised in full
  await POST('/api/bookings', { show_id: S, category: 'Truck / freight', vendor: 'Landstar',
    status: 'done', amount: 7200, booked_date: '2026-10-20' }, { token: A });
  await POST('/api/proofs', { show_id: S, code: 'P-01', name: 'Perimeter wraps', status: 'approved',
    rounds: [{ round: 'R1', date: '2026-10-01', status: 'approved', note: 'ok' }] }, { token: A });
  await PUT(`/api/shows/${S}/chain/content`, { gen: true }, { token: A });
  await PUT(`/api/shows/${S}/gear`, { linked: true, pulled: true, element_id: 'abc-123' }, { token: A });
  const before2 = await childCounts(P);
  ok('...plus bookings, proofs, proof_rounds, spec_chain, flex_state',
     before2.bookings > 0 && before2.proofs > 0 && before2.proof_rounds > 0
     && before2.spec_chain > 0 && before2.flex_state > 0, before2);

  const delP = await DEL(`/api/projects/${P}`, { token: A });
  ok('DELETE /api/projects/:id', delP.status === 200, delP.body);
  const after = await childCounts(P);
  const orphans = Object.entries(after).filter(([, n]) => n > 0);
  ok('ZERO orphans across every wired table', orphans.length === 0, Object.fromEntries(orphans));

  // ── cleanup ───────────────────────────────────────────────────────────────
  section('cleanup');
  await DEL(`/api/projects/${P2}`, { token: A });
  await pool.query(`DELETE FROM agent_idempotency WHERE key LIKE $1`, [TAG + '%']);
  await pool.query(`DELETE FROM api_keys WHERE label LIKE $1`, [TAG + '%']);
  await pool.query(`DELETE FROM sessions WHERE username LIKE $1`, [TAG + '%']);
  await pool.query(`DELETE FROM users WHERE username LIKE $1`, [TAG + '%']);
  await pool.query(`DELETE FROM activity WHERE detail LIKE $1 OR actor LIKE $1`, ['%' + TAG + '%']);
  const leftovers = await pool.query(
    `SELECT (SELECT COUNT(*) FROM projects WHERE name LIKE $1)
          + (SELECT COUNT(*) FROM users WHERE username LIKE $1)
          + (SELECT COUNT(*) FROM proposals WHERE payload::text LIKE $1) AS n`, ['%' + TAG + '%']);
  ok('the smoke run cleaned up after itself', parseInt(leftovers.rows[0].n, 10) === 0,
     leftovers.rows[0]);

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  FAILURES:'); failures.forEach((f) => console.log('    · ' + f)); }
  console.log(`${'═'.repeat(66)}\n`);

  server.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nSMOKE ABORTED:', e && e.stack ? e.stack : e);
  try { await pool.end(); } catch (_) { /* already closed */ }
  process.exit(3);
});

// ── helpers ─────────────────────────────────────────────────────────────────

// The spec-bind assertions run against TOM'S REAL BANKED SPECS when they are on
// this machine — the VNL Chicago pair is the whole reason the checker exists,
// and a synthetic fixture would not reproduce it honestly. When the staffing
// repo is not present (CI, a fresh clone) we fall back to a minimal pair that
// carries the SAME three numbers: .e360 declares 144, its five sections sum to
// 120, its zones array is empty, and the .nsf marks the 4-cabinet section
// double-stacked for a stack-aware total of 124.
function loadSpecSamples() {
  const fs = require('fs');
  const path = require('path');
  const dir = process.env.SPEC_SAMPLE_DIR ||
    path.join('C:', 'code', 'e360-staffing3', 'docs', 'spec-samples');
  try {
    const e360Doc = JSON.parse(fs.readFileSync(path.join(dir, 'e360_vnl_chicago_sample.e360'), 'utf8'));
    const nsfDoc = JSON.parse(fs.readFileSync(path.join(dir, 'VNL_Chicago_2026-05-13.nsf'), 'utf8'));
    return { e360Doc, nsfDoc, sampleSource: `REAL banked specs from ${dir}` };
  } catch (_) {
    const sections = [
      { name: 'Section 1', side: 'south', count: '34', offset: '0', fieldDist: '10', direction: 'ltr' },
      { name: 'Section 2', side: 'east',  count: '24', offset: '0', fieldDist: '10', direction: 'ltr' },
      { name: 'Section 3', side: 'north', count: '4',  offset: '0', fieldDist: '10', direction: 'ltr' },
      { name: 'Section 4', side: 'west',  count: '24', offset: '0', fieldDist: '10', direction: 'ltr' },
      { name: 'Section 5', side: 'south', count: '34', offset: '0', fieldDist: '10', direction: 'ltr' }
    ];
    return {
      e360Doc: {
        version: 1, layoutMode: 'complex', complexUnit: 'ft', compassBearing: 0,
        reverseNumbering: false, sideStates: { south: true, north: true, east: true, west: true },
        fields: { clientName: 'VNL Chicago', venueName: 'Now Arena', cabinetType: 'p391',
                  fieldLength: '110', fieldWidth: '59', totalCabinets: '144' },
        complexSections: sections.map((s) => ({ ...s })),
        zones: [],                                   // ← carries NO stacking data
        clientLogoDataUrl: null,
        _fixture: 'x'.repeat(24000)                  // keep it over the 1 MB-limit assertion's floor
      },
      nsfDoc: {
        _version: 1, _app: 'NovaSpec', complexUnit: 'ft', compassBearing: 0, reverseNumbering: false,
        fields: { jobName: 'VNL Chicago', venue: 'Now Arena', cabType: 'p391',
                  fieldLength: '110', fieldWidth: '59' },
        complexSections: sections.map((s) => ({
          ...s, doubleStacked: s.name === 'Section 3', stackFlow: 'snake', cabOverride: null }))
      },
      sampleSource: 'SYNTHETIC fallback (the staffing repo is not on this machine) — ' +
                    'same 144/120/124 numbers as the real VNL pair'
    };
  }
}

// Read bytes back out of the storage driver the server actually used.
async function storageGet(nasPath) {
  try {
    const { storage } = require('../lib/storage');
    return (await storage.get(nasPath)).toString('utf8');
  } catch (_) { return null; }
}

async function tableCount() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
  return r.rows[0].n;
}

// Every table that lib/db.js's cascades are supposed to reach.
async function childCounts(projectId) {
  const q = async (sql, params = [projectId]) =>
    parseInt((await pool.query(sql, params)).rows[0].n, 10);
  const inShows = 'IN (SELECT id FROM shows WHERE project_id=$1)';
  return {
    projects:         await q('SELECT COUNT(*) n FROM projects WHERE id=$1'),
    shows:            await q('SELECT COUNT(*) n FROM shows WHERE project_id=$1'),
    jobs:             await q('SELECT COUNT(*) n FROM jobs WHERE project_id=$1'),
    budget_lines:     await q(`SELECT COUNT(*) n FROM budget_lines WHERE job_id IN (SELECT id FROM jobs WHERE project_id=$1)`),
    steps:            await q(`SELECT COUNT(*) n FROM steps WHERE project_id=$1 OR show_id ${inShows}`),
    files:            await q(`SELECT COUNT(*) n FROM files WHERE project_id=$1 OR show_id ${inShows}`),
    expenses:         await q(`SELECT COUNT(*) n FROM expenses WHERE project_id=$1 OR show_id ${inShows}`),
    bookings:         await q(`SELECT COUNT(*) n FROM bookings WHERE show_id ${inShows}`),
    purchase_orders:  await q('SELECT COUNT(*) n FROM purchase_orders WHERE project_id=$1'),
    po_lines:         await q(`SELECT COUNT(*) n FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE project_id=$1)`),
    notes:            await q('SELECT COUNT(*) n FROM notes WHERE project_id=$1'),
    note_reads:       await q(`SELECT COUNT(*) n FROM note_reads WHERE note_id IN (SELECT id FROM notes WHERE project_id=$1)`),
    note_mentions:    await q(`SELECT COUNT(*) n FROM note_mentions WHERE note_id IN (SELECT id FROM notes WHERE project_id=$1)`),
    schedule_items:   await q(`SELECT COUNT(*) n FROM schedule_items WHERE show_id ${inShows}`),
    crew_assignments: await q(`SELECT COUNT(*) n FROM crew_assignments WHERE show_id ${inShows}`),
    deliverables:     await q(`SELECT COUNT(*) n FROM deliverables WHERE project_id=$1 OR show_id ${inShows}`),
    milestones:       await q(`SELECT COUNT(*) n FROM milestones WHERE project_id=$1 OR show_id ${inShows}`),
    proofs:           await q(`SELECT COUNT(*) n FROM proofs WHERE show_id ${inShows}`),
    proof_rounds:     await q(`SELECT COUNT(*) n FROM proof_rounds WHERE proof_id IN (SELECT id FROM proofs WHERE show_id ${inShows})`),
    spec_chain:       await q(`SELECT COUNT(*) n FROM spec_chain WHERE show_id ${inShows}`),
    spec_renders:     await q(`SELECT COUNT(*) n FROM spec_renders WHERE show_id ${inShows}`),
    flex_state:       await q(`SELECT COUNT(*) n FROM flex_state WHERE show_id ${inShows}`),
    proposals:        await q(`SELECT COUNT(*) n FROM proposals WHERE project_id=$1 OR show_id ${inShows}`),
    activity:         await q(`SELECT COUNT(*) n FROM activity WHERE project_id=$1 OR show_id ${inShows}`)
  };
}
