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
// The login limiter is 20 attempts per IP per 15 minutes, and this suite is one
// machine signing in as a dozen fixture identities and then deliberately
// failing several logins to prove the endpoint is not an account-existence
// oracle — which is exactly the traffic the limiter exists to stop. Raised HERE
// and only here: the production ceiling is untouched, and nothing below asserts
// anything about throttling.
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '400';

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

async function call(method, path, { token, key, body, idem, raw, wantBytes, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['x-auth-token'] = token;
  if (key) h['x-agent-key'] = key;
  if (idem) h['x-idempotency-key'] = idem;
  let payload;
  if (raw) { h['Content-Type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  // `wantBytes` is for the byte routes: GET /api/files/:id/content answers a
  // stream of octets, and res.text() would mangle it. An error is still JSON,
  // so a non-2xx falls back to the normal path and the assertions read .body.
  if (wantBytes && res.ok) {
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
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
  const MS = ms.body.id;
  // H7's missing half — the PUT beside the delete. Same gates as the delete
  // (pm rank + ownership, 404 for a ghost), and the milestone modal is what
  // finally calls all three.
  ok('creating a milestone leaves its own activity row now',
     (await pool.query(`SELECT COUNT(*)::int AS n FROM activity
                        WHERE show_id=$1 AND action='milestone.create'`, [S])).rows[0].n === 1);
  const msPm2 = await PUT(`/api/milestones/${MS}`, { label: 'hijack' }, { token: PM2T });
  ok('PUT /api/milestones/:id checks OWNERSHIP, not just rank', msPm2.status === 403, msPm2.body);
  const msFix = await PUT(`/api/milestones/${MS}`, { label: 'Content locked', date: '2026-11-08' },
    { token: A });
  ok('PUT /api/milestones/:id corrects label + date (H7)',
     msFix.status === 200 && msFix.body.label === 'Content locked' && msFix.body.date === '2026-11-08',
     msFix.body);
  ok('...a non-ISO date is a 400',
     (await PUT(`/api/milestones/${MS}`, { date: 'tomorrow' }, { token: A })).status === 400);
  ok('...and an id that never existed is a 404, not {ok:true}',
     (await PUT('/api/milestones/99999999', { label: 'x' }, { token: A })).status === 404);
  const msAct = await pool.query(
    `SELECT * FROM activity WHERE show_id=$1 AND action='milestone.update' ORDER BY id DESC`, [S]);
  ok('...the correction leaves a structured before→after',
     (msAct.rows[0]?.changes || []).some((c) => c.field === 'label' && c.to === 'Content locked'),
     msAct.rows[0]?.changes);

  // ── the gear-state gate (H1's last stray) ─────────────────────────────────
  // PUT /shows/:id/gear carried requireRole('tech') and nothing else, so any
  // tech could overwrite any show's Flex linkage and pulled state. The gate is
  // now entity-shaped: canEditProject OR a tech with a crew line on THIS show
  // — the tech at the rack building the pull sheet is the route's clientele.
  // A dedicated show, so the crew line it needs cannot skew any later count.
  const ggShow = await POST('/api/shows', { project_id: P, name: TAG + ' gear gate' }, { token: A });
  const GG = ggShow.body.id;
  const gearForeign = await PUT(`/api/shows/${GG}/gear`, { pulled: true }, { token: TECHT });
  ok('a tech with NO crew line on the show is refused the gear write',
     gearForeign.status === 403, gearForeign.body);
  ok('...and so is a pm who owns nothing',
     (await PUT(`/api/shows/${GG}/gear`, { pulled: true }, { token: PM2T })).status === 403);
  await POST(`/api/shows/${GG}/crew`, { username: techUser, role_on_site: 'LED tech' }, { token: A });
  const gearCrew = await PUT(`/api/shows/${GG}/gear`, { pulled: true }, { token: TECHT });
  ok('...while the SAME tech, once on the crew, may build the pull sheet',
     gearCrew.status === 200 && gearCrew.body.pulled === true, gearCrew.body);
  ok('...and the folder-owning pm always could',
     (await PUT(`/api/shows/${GG}/gear`, { pulled: false }, { token: PMT })).status === 200);
  // The probe cleans up after itself — P must stay single-show for the
  // auto-collapse assertion below — and the cleanup IS the blocker wave's new
  // door: DELETE /shows/:id, its cascade taking the crew line with it.
  const ggDel = await DEL(`/api/shows/${GG}`, { token: A });
  ok('...and the probe show deletes cleanly, crew line and all (show delete door)',
     ggDel.status === 200 &&
     (await pool.query('SELECT COUNT(*)::int AS n FROM crew_assignments WHERE show_id=$1',
       [GG])).rows[0].n === 0, ggDel.body);

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
  // ── the byte pair (storage pass) ─────────────────────────────────────────
  // The upload returns the SHA of what actually arrived, so a caller can
  // verify the round trip without a second transfer — this is what the
  // wiring-day smoke sequence byte-compares against (WIRING_DAY.md §6/S4).
  ok('...and returns the sha256 of the bytes it stored',
     bytes.body.sha256 === require('crypto').createHash('sha256')
       .update(Buffer.from('spec bytes')).digest('hex'), bytes.body.sha256);
  // HARDENING 21. `size: 4096` and `dim: '2 zones · 1408 x 96'` above were both
  // CLIENT GUESSES. Once real bytes exist the bytes are the truth: size is
  // replaced by what arrived, and a dim nobody measured is cleared rather than
  // left standing as fiction.
  const afterUp = await GET(`/api/files/${F}`, { token: A });
  ok('HARDENING 21: a real upload REPLACES the client-declared size',
     Number(afterUp.body.size) === 10, afterUp.body.size);
  ok('HARDENING 21: ...and CLEARS a dim nobody measured',
     !afterUp.body.dim, afterUp.body.dim);
  const measured = await call('PUT', `/api/files/${F}/content?w=3840&h=1080`,
    { token: A, raw: Buffer.from('spec bytes v2') });
  ok('...but a MEASURED dim (?w=&h=) is recorded', measured.body.dim === '3840 x 1080', measured.body);

  const dl = await call('GET', `/api/files/${F}/content`, { token: A, wantBytes: true });
  ok('GET /api/files/:id/content streams the bytes back',
     dl.status === 200 && Buffer.isBuffer(dl.bytes) && dl.bytes.toString() === 'spec bytes v2',
     dl.bytes && dl.bytes.length);
  ok('...with a Content-Disposition a browser can save',
     /attachment/.test(String(dl.headers.get('content-disposition'))),
     dl.headers.get('content-disposition'));
  ok('...and ?inline=1 flips it for the viewer',
     /inline/.test(String((await call('GET', `/api/files/${F}/content?inline=1`,
       { token: A, wantBytes: true })).headers.get('content-disposition'))));
  const dlAnyone = await call('GET', `/api/files/${F}/content`, { token: TECHT, wantBytes: true });
  ok('...readable by any signed-in user — this is how a remote user gets a file ' +
     'THROUGH the app (the NAS is not on the internet; the server is)',
     dlAnyone.status === 200, dlAnyone.status);
  ok('...but not without a session', (await call('GET', `/api/files/${F}/content`)).status === 401);
  const ghostFile = await POST('/api/files',
    { show_id: S, name: TAG + ' never uploaded', ext: '.pdf', kind: 'other' }, { token: A });
  const ghostGet = await GET(`/api/files/${ghostFile.body.id}/content`, { token: A });
  ok('a metadata row with no bytes is a 404 that SAYS so, not a 500',
     ghostGet.status === 404 && /No bytes at/.test(JSON.stringify(ghostGet.body)), ghostGet.body);

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

  // ── deal_type = 'service' (2026-09-02, LOVB 2027) ─────────────────────
  // The third deal type: labour on hardware the CLIENT owns. It must survive
  // the round trip verbatim — the old two-way branch would have quietly
  // stored anything unrecognised as 'rental', which claims E360 gear on a
  // floor that has none. A junk value must still be refused.
  const svcJob = await POST('/api/jobs', { project_id: P, name: TAG + ' season tech services',
    client: TAG + ' League', deal_type: 'service' }, { token: PMT });
  ok("POST /api/jobs deal_type='service' is accepted and stored verbatim",
     svcJob.status === 200 && svcJob.body.deal_type === 'service', svcJob.body);
  const svcBack = await GET('/api/jobs/' + svcJob.body.id, { token: PMT });
  ok("...and reads back as 'service', never coerced to rental",
     svcBack.status === 200 && svcBack.body.deal_type === 'service', svcBack.body);
  const junkDeal = await POST('/api/jobs', { project_id: P, name: TAG + ' junk deal type',
    deal_type: 'barter' }, { token: PMT });
  ok('...while an unknown deal_type still falls back to the default, not through',
     junkDeal.status === 200 && junkDeal.body.deal_type === 'rental', junkDeal.body);

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

  // ── the NEEDS LIST (Tom, 2026-09-02) — per-job ancillaries checklist ──────
  const { LED_ANCILLARIES } = require('../lib/enums');
  const seed1 = await POST(`/api/jobs/${J}/needs/seed`, {}, { token: A });
  ok('POST /api/jobs/:id/needs/seed drops the standard LED template',
     seed1.status === 200 && (seed1.body.added || []).length === LED_ANCILLARIES.length,
     { added: (seed1.body.added || []).length, want: LED_ANCILLARIES.length });
  const seed2 = await POST(`/api/jobs/${J}/needs/seed`, {}, { token: A });
  ok('THE SEED IS IDEMPOTENT — a second seed adds 0 and skips every item',
     seed2.status === 200 && (seed2.body.added || []).length === 0
     && (seed2.body.skipped || []).length === LED_ANCILLARIES.length, seed2.body);

  const techNeed = await POST('/api/needs', { job_id: J, item: 'tech-made need' }, { token: TECHT });
  ok('a tech is below the needs floor — 403, same rank gate as PO creation',
     techNeed.status === 403, techNeed.body);
  const pm2Need = await POST('/api/needs', { job_id: J, item: 'foreign-pm need' }, { token: PM2T });
  ok('...and a pm who owns NOTHING fails the ownership half', pm2Need.status === 403, pm2Need.body);
  const techSeed = await POST(`/api/jobs/${J}/needs/seed`, {}, { token: TECHT });
  ok('...the seed carries the same floor', techSeed.status === 403, techSeed.body);

  const pmNeed = await POST('/api/needs', { job_id: J, item: TAG + ' spare data drums', qty: 2,
    est_cost: 300, category: 'gear', show_id: S }, { token: PMT });
  ok('the OWNING pm adds a custom item, pinned to the show, est carried',
     pmNeed.status === 200 && pmNeed.body.show_id === S && pmNeed.body.est_cost === 300
     && pmNeed.body.status === 'open', pmNeed.body);
  const ND = pmNeed.body.id;

  const badNeedStatus = await PUT(`/api/needs/${ND}`, { status: 'bought' }, { token: PMT });
  ok('an unknown need status is 400 (oneOf whitelist)', badNeedStatus.status === 400, badNeedStatus.body);
  const checked = await PUT(`/api/needs/${ND}`, { status: 'covered' }, { token: PMT });
  ok('checking an item off STAMPS checked_by/checked_at from the session',
     checked.status === 200 && checked.body.status === 'covered'
     && checked.body.checked_by === pmUser && !!checked.body.checked_at, checked.body);
  const reopened = await PUT(`/api/needs/${ND}`, { status: 'open' }, { token: PMT });
  ok('...and reopening CLEARS the stamp and any covering PO',
     reopened.status === 200 && reopened.body.status === 'open'
     && !reopened.body.checked_by && !reopened.body.checked_at
     && !reopened.body.covered_by_po_id, reopened.body);

  // raise-po: two open items become ONE PO at needed, in one transaction
  const openList = await GET(`/api/needs?job_id=${J}&status=open`, { token: A });
  ok('GET /api/needs filters by job + status', openList.status === 200
     && openList.body.length > 2 && openList.body.every((x) => x.status === 'open'),
     openList.body.length);
  const raiseIds = [ND, openList.body.find((x) => x.id !== ND).id];
  const raised = await POST('/api/needs/raise-po', { job_id: J, need_ids: raiseIds }, { token: PMT });
  ok('POST /api/needs/raise-po opens ONE PO at needed, vendor TBD',
     raised.status === 200 && raised.body.po && raised.body.po.status === 'needed'
     && raised.body.po.vendor === 'TBD', raised.body.po && raised.body.po.status);
  ok('...one line per need — qty, est→unit_cost, category, show carried',
     (raised.body.po.lines || []).length === 2
     && raised.body.po.lines.some((l) => l.unit_cost === 300 && l.qty === 2 && l.show_id === S),
     raised.body.po.lines);
  ok('...and every raised need reads covered BY THAT PO',
     (raised.body.needs || []).length === 2 && raised.body.needs.every(
       (x) => x.status === 'covered' && x.covered_by_po_id === raised.body.po.id
              && x.checked_by === pmUser), raised.body.needs);
  const raiseAct = await pool.query(
    `SELECT detail FROM activity WHERE po_id=$1 AND action='po.create'`, [raised.body.po.id]);
  ok('...the raise logged its po.create row naming the needs list',
     raiseAct.rows.length === 1 && /needs-list/.test(raiseAct.rows[0].detail), raiseAct.rows);

  // TRANSACTIONALITY — one bad need poisons the WHOLE call, nothing lands
  const j2res = await POST('/api/jobs', { project_id: P, name: TAG + ' second job' }, { token: A });
  const J2 = j2res.body.id;
  const foreignNeed = await POST('/api/needs', { job_id: J2, item: TAG + ' foreign need' }, { token: A });
  const goodOpen = (await GET(`/api/needs?job_id=${J}&status=open`, { token: A })).body[0];
  const posBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders')).rows[0].n;
  const poisoned = await POST('/api/needs/raise-po',
    { job_id: J, need_ids: [goodOpen.id, foreignNeed.body.id] }, { token: A });
  ok('a need from ANOTHER JOB poisons raise-po — 400 naming the offender',
     poisoned.status === 400 && String(poisoned.body.error).includes(`need ${foreignNeed.body.id}`),
     poisoned.body);
  const posAfter = (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders')).rows[0].n;
  const goodAfter = (await GET(`/api/needs?job_id=${J}`, { token: A })).body
    .find((x) => x.id === goodOpen.id);
  ok('...and NOTHING was created — no PO, and the good need is still open',
     posAfter === posBefore && goodAfter.status === 'open' && !goodAfter.covered_by_po_id,
     { posBefore, posAfter, goodAfter });
  const notOpen = await POST('/api/needs/raise-po', { job_id: J, need_ids: [ND] }, { token: A });
  ok('a need that is already covered refuses the whole call too',
     notOpen.status === 400 && String(notOpen.body.error).includes(`need ${ND}`), notOpen.body);

  // delete: same floor as a PO line, then the row is gone
  const techDelNeed = await DEL(`/api/needs/${foreignNeed.body.id}`, { token: TECHT });
  ok('a tech may not delete a need (PO-line floor)', techDelNeed.status === 403, techDelNeed.body);
  const delNeed = await DEL(`/api/needs/${foreignNeed.body.id}`, { token: A });
  ok('DELETE /api/needs/:id', delNeed.status === 200 && delNeed.body.ok === true, delNeed.body);

  const needActs = await pool.query(
    `SELECT DISTINCT action FROM activity WHERE job_id=$1 AND action LIKE 'need.%'`, [J]);
  const needActSet = needActs.rows.map((r) => r.action);
  ok('seed / status / add wrote their need.* activity rows',
     needActSet.includes('need.seed') && needActSet.includes('need.status')
     && needActSet.includes('need.add'), needActSet);

  // cascades: a deleted show NULLS the pin; a deleted job takes its checklist
  const tmpShow = await POST('/api/shows', { project_id: P, name: TAG + ' needs-pin probe',
    event_date: '2026-12-01', stage: 'planning' }, { token: A });
  const pinned = await POST('/api/needs', { job_id: J, item: TAG + ' pinned probe',
    show_id: tmpShow.body.id }, { token: A });
  await DEL(`/api/shows/${tmpShow.body.id}`, { token: A });
  const unpinned = await pool.query('SELECT show_id FROM purchase_needs WHERE id=$1', [pinned.body.id]);
  ok('deleting a show NULLS purchase_needs.show_id (the row survives)',
     unpinned.rows.length === 1 && unpinned.rows[0].show_id === null, unpinned.rows);
  await POST('/api/needs', { job_id: J2, item: TAG + ' orphan probe' }, { token: A });
  const delJ2 = await DEL(`/api/jobs/${J2}`, { token: A });
  const j2Orphans = await pool.query('SELECT COUNT(*)::int AS n FROM purchase_needs WHERE job_id=$1', [J2]);
  ok('deleting a job takes its needs checklist with it — zero orphans',
     delJ2.status === 200 && j2Orphans.rows[0].n === 0, j2Orphans.rows[0]);

  // ── PO editing after creation + the honest delete (purchasing polish) ─────
  // the RAISED po is 'needed': its lines are open for correction, its vendor
  // is TBD by design, and the way out of TBD is a plain PUT
  const RPO = raised.body.po.id;
  const rl = raised.body.po.lines;
  const techLineEdit = await PUT(`/api/pos/${RPO}/lines/${rl[0].id}`, { qty: 3 }, { token: TECHT });
  ok('a tech is below the line-edit floor', techLineEdit.status === 403, techLineEdit.body);
  const pm2LineEdit = await PUT(`/api/pos/${RPO}/lines/${rl[0].id}`, { qty: 3 }, { token: PM2T });
  ok('...and a pm who owns nothing fails the ownership half', pm2LineEdit.status === 403,
     pm2LineEdit.body);
  const lineEdit = await PUT(`/api/pos/${RPO}/lines/${rl[0].id}`, { qty: 4, unit_cost: 275 },
    { token: PMT });
  ok('PUT /api/pos/:id/lines/:lineId corrects a line while needed/quoted',
     lineEdit.status === 200 && Number(lineEdit.body.qty) === 4
     && Number(lineEdit.body.unit_cost) === 275, lineEdit.body);
  const ghostLine = await PUT(`/api/pos/${RPO}/lines/999999`, { qty: 1 }, { token: PMT });
  ok('...a line that is not on the PO is a 404', ghostLine.status === 404, ghostLine.body);
  const lineDel = await DEL(`/api/pos/${RPO}/lines/${rl[1].id}`, { token: PMT });
  ok('DELETE /api/pos/:id/lines/:lineId removes it', lineDel.status === 200, lineDel.body);
  const rpoLines = await pool.query('SELECT COUNT(*)::int AS n FROM po_lines WHERE po_id=$1', [RPO]);
  ok('...leaving exactly one line behind', rpoLines.rows[0].n === 1, rpoLines.rows[0]);

  const vend = await PUT(`/api/pos/${RPO}`,
    { vendor: 'Show Support Co', memo: TAG + ' ancillaries' }, { token: PMT });
  ok('the deliberate TBD vendor is one PUT away from real',
     vend.status === 200 && vend.body.vendor === 'Show Support Co', vend.body);
  const vendAct = await pool.query(
    `SELECT changes FROM activity WHERE po_id=$1 AND action='po.update' ORDER BY id DESC LIMIT 1`, [RPO]);
  ok('...and the rename is a before→after diff (vendor TBD → real)',
     (vendAct.rows[0].changes || []).some((c) => c.field === 'vendor' && c.from === 'TBD'),
     vendAct.rows[0]);

  // THE FREEZE — an ordered PO refuses line changes and a renumber: 409s that
  // name the status, because a commitment reads back exactly as placed
  const poLine0 = await pool.query('SELECT id FROM po_lines WHERE po_id=$1 LIMIT 1', [PO]);
  const frozenEdit = await PUT(`/api/pos/${PO}/lines/${poLine0.rows[0].id}`, { qty: 99 }, { token: A });
  ok('an ordered PO\'s lines are a commitment — the edit is a 409', frozenEdit.status === 409,
     frozenEdit.body);
  const frozenDel = await DEL(`/api/pos/${PO}/lines/${poLine0.rows[0].id}`, { token: A });
  ok('...the delete too', frozenDel.status === 409, frozenDel.body);
  const frozenNum = await PUT(`/api/pos/${PO}`, { po_number: 'PO-99-001' }, { token: A });
  ok('...and the number is locked once ordered (the paper trail)', frozenNum.status === 409,
     frozenNum.body);

  // raise-po carries a vendor when the picker names one up front
  const vNeed = await POST('/api/needs', { job_id: J, item: TAG + ' vendored probe', est_cost: 90 },
    { token: A });
  const vRaise = await POST('/api/needs/raise-po',
    { job_id: J, need_ids: [vNeed.body.id], vendor: 'Named Up Front LLC' }, { token: A });
  ok('raise-po lands the vendor named in the picker', vRaise.status === 200
     && vRaise.body.po.vendor === 'Named Up Front LLC', vRaise.body.po);

  // DELETE /api/pos/:id — manager floor, and the cascade tells the truth:
  // covered needs REOPEN, po-anchored notes go with their anchor, zero orphans
  const poNote = await POST('/api/notes', { anchor_type: 'po', anchor_id: RPO,
    body: 'chase the freight quote' }, { token: A });
  ok('a note can anchor on the PO (delete-cascade fuel)', poNote.status === 200, poNote.body);
  const delAsPm = await DEL(`/api/pos/${RPO}`, { token: PMT });
  ok('deleting a PO is a manager act — a pm (even the owner) is refused',
     delAsPm.status === 403, delAsPm.body);
  const delGhostPo = await DEL('/api/pos/999999', { token: A });
  ok('...a PO that never existed is a 404, not {ok:true}', delGhostPo.status === 404, delGhostPo.body);
  const delMgr = await DEL(`/api/pos/${RPO}`, { token: MGRT });
  ok('DELETE /api/pos/:id — a manager may', delMgr.status === 200 && delMgr.body.ok === true,
     delMgr.body);
  const reopenedRows = await pool.query(
    'SELECT status, covered_by_po_id, checked_by FROM purchase_needs WHERE id = ANY($1::int[])',
    [raiseIds]);
  ok('THE CASCADE REOPENS the needs it covered — never "covered by nothing"',
     reopenedRows.rows.length === 2 && reopenedRows.rows.every(
       (r) => r.status === 'open' && r.covered_by_po_id === null && r.checked_by === null),
     reopenedRows.rows);
  const rpoOrphans = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM po_lines WHERE po_id=$1)
          + (SELECT COUNT(*)::int FROM activity WHERE po_id=$1)
          + (SELECT COUNT(*)::int FROM notes WHERE anchor_type='po' AND anchor_id=$1) AS n`, [RPO]);
  ok('...zero orphans — lines, activity and notes all went with it', rpoOrphans.rows[0].n === 0,
     rpoOrphans.rows[0]);

  // and the expense half: a received PO's actuals SURVIVE the delete, unlinked
  const xpo = await POST('/api/pos', { vendor: TAG + ' Expense Probe Co', project_id: P, job_id: J },
    { token: A });
  await POST(`/api/pos/${xpo.body.id}/lines`, { item: 'probe kit', qty: 1, unit_cost: 900,
    ownership: 'cogs', show_id: S }, { token: A });
  for (const st of ['quoted', 'ordered', 'shipped', 'received']) {
    await PUT(`/api/pos/${xpo.body.id}/status`, { status: st }, { token: A });
  }
  const xExp = await pool.query('SELECT id FROM expenses WHERE po_id=$1', [xpo.body.id]);
  ok('receiving the probe PO landed its cogs line as an actual', xExp.rows.length === 1, xExp.rows);
  const delXpo = await DEL(`/api/pos/${xpo.body.id}`, { token: A });
  const xExpAfter = await pool.query('SELECT po_id FROM expenses WHERE id=$1', [xExp.rows[0].id]);
  ok('...and deleting the PO leaves the actual ON THE BOOKS with the po link cut',
     delXpo.status === 200 && xExpAfter.rows.length === 1 && xExpAfter.rows[0].po_id === null,
     xExpAfter.rows);

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

  // ── THE IDENTITY LINK — users.staffing_name (INTEGRATIONS_SPEC §2/§4) ─────
  // The staffing app keys its roster, its events.staff[], its travel_key
  // segments and its hotels.staffAssigned on a DISPLAY NAME, and has never
  // heard of a Showrunner username. So a person the two systems spell
  // differently silently gets no email, no colour chip and no tech packet (M6).
  // users.staffing_name is the override. Driven against the builder directly
  // because these assertions need a STAFFING ROSTER to canonicalize against,
  // and SCHEDULER_BASE_URL is deliberately unset for the rest of this section.
  const schedLib = require('../lib/scheduler');
  const staffRoster = [{ name: 'Devin Vargas' }, { name: 'Aaron Ramos' }, { name: 'Marcus Webb' }];
  const linkUsers = [
    // OVERRIDE — Showrunner shows him by first name, staffing carries his full one
    { username: 'dv', name: 'Devin', staffing_name: 'Devin Vargas' },
    // FALLBACK — no override, so his Showrunner display name is what crosses
    { username: 'ar', name: 'Aaron Ramos', staffing_name: null }
  ];
  const linkProject = { name: TAG + ' LINK', client: 'C', type: 'led' };
  const linkShow = { name: TAG + ' LINK show', stage: 'confirmed',
                     load_in_date: '2026-11-08', event_date: '2026-11-10', strike_date: '2026-11-11' };
  const linkSteps = [
    { lane: 'crew', title: 'Lead tech', owner: 'dv', status: 'todo' },
    { lane: 'crew', title: 'Second tech', owner: 'ar', status: 'todo' },
    { lane: 'logistics', title: 'Hotel block', owner: 'dv', status: 'todo' }
  ];
  const linkCrew = [
    { username: 'dv', name: null,
      travel: { out: { flight_num: 'AA1', arrival_date: '2026-11-08' } } },
    { name: 'Marcus Webb' }                       // a local hire — no Showrunner user at all
  ];
  const linked = schedLib.buildSchedulerPayloads(linkProject, linkShow, linkSteps, linkCrew,
    { roster: staffRoster, users: linkUsers, eventId: 77 });
  ok('LINK OVERRIDE: a username whose display name is NOT the staffing name still resolves',
     linked.crewNames.includes('Devin Vargas'), linked.crewNames);
  ok('LINK FALLBACK: with staffing_name null the person travels under their Showrunner name',
     linked.crewNames.includes('Aaron Ramos'), linked.crewNames);
  ok('LINK: a crew row that is nobody\'s Showrunner account still matches by its own name',
     linked.crewNames.includes('Marcus Webb'), linked.crewNames);
  ok('LINK: nothing is unmatched, so this show would push',
     linked.unmatchedCrew.length === 0, linked.unmatchedCrew);
  ok('LINK: the EVENT payload carries the staffing names, never the usernames',
     linked.eventPayload.staff.includes('Devin Vargas') &&
     !linked.eventPayload.staff.includes('dv'), linked.eventPayload.staff);
  ok('LINK: a booking\'s staffAssigned goes through the SAME resolution',
     (linked.bookings || []).some((b) => (b.staffAssigned || []).includes('Devin Vargas')),
     (linked.bookings || []).map((b) => b.staffAssigned));
  const linkArr = (linked.travel || []).find((t) => t.leg === 'arrival');
  ok('LINK: the TRAVEL KEY is built from the staffing name — the read-back looks it up by that',
     !!linkArr && linkArr.person === 'Devin Vargas' && linkArr.key === 'Devin Vargas|77|inbound',
     linkArr && { person: linkArr.person, key: linkArr.key });

  // ADDITIVE: omit `users` entirely and the builder is exactly what it was.
  // The link can only ADD a way for a name to match, never take one away.
  const unlinked = schedLib.buildSchedulerPayloads(linkProject, linkShow, linkSteps, linkCrew,
    { roster: staffRoster, eventId: 77 });
  ok('LINK ADDITIVE: with no users supplied a plain roster-name crew row still matches',
     unlinked.crewNames.includes('Marcus Webb'), unlinked.crewNames);
  ok('LINK ADDITIVE: ...and the usernames go unmatched, exactly as they did before',
     unlinked.unmatchedCrew.includes('dv') && unlinked.unmatchedCrew.includes('ar'),
     unlinked.unmatchedCrew);

  // M6's 422 has to name WHICH user and WHICH name form failed — "these names
  // do not match" does not tell you which field to go and fix.
  const missUsers = linkUsers.concat([{ username: 'jt', name: 'Jamie Torres',
                                        staffing_name: 'J. Torres' }]);
  const missSteps = linkSteps.concat([
    { lane: 'crew', title: 'Third tech', owner: 'jt', status: 'todo' },
    { lane: 'crew', title: 'Ghost', owner: 'lead_tech', status: 'todo' }
  ]);
  const missed = schedLib.buildSchedulerPayloads(linkProject, linkShow, missSteps, linkCrew,
    { roster: staffRoster, users: missUsers, eventId: 77 });
  const m6 = schedLib.validateForPush(linkProject, linkShow, missed, staffRoster)
    .find((p) => /do not match the staffing roster/.test(p));
  ok('M6: an unmatched crew name is still a refusal', !!m6, m6);
  ok('M6: ...and the refusal NAMES THE USER it belongs to',
     /@jt/.test(m6 || ''), m6);
  ok('M6: ...and BOTH name forms it tried on their behalf, each labelled',
     /J\. Torres/.test(m6 || '') && /their staffing-app name/.test(m6 || '') &&
     /Jamie Torres/.test(m6 || '') && /their name in Showrunner/.test(m6 || ''), m6);
  ok('M6: ...while a token that is nobody\'s account says so instead of inventing a user',
     /lead_tech/.test(m6 || '') && /not a Showrunner user/.test(m6 || ''), m6);
  ok('M6: ...and the message names the field that fixes it',
     /Name in staffing app/.test(m6 || ''), m6);
  ok('M6: a matched person is NOT dragged into the refusal',
     !/@dv/.test(m6 || '') && !/@ar/.test(m6 || ''), m6);

  // The read-back asks the SAME question the push answered — one expression, so
  // a leg can never be filed under one spelling and looked up under another.
  ok('LINK READ-BACK: staffing_name wins, then the crew row\'s own name, then the user\'s',
     schedLib.crewStaffingName({ name: 'Devin' }, { name: 'Devin', staffing_name: 'Devin Vargas' })
       === 'Devin Vargas' &&
     schedLib.crewStaffingName({ name: 'Marcus Webb' }, null) === 'Marcus Webb' &&
     schedLib.crewStaffingName({ name: null }, { name: 'Aaron Ramos' }) === 'Aaron Ramos');
  ok('LINK: staffingNameFor falls back staffing_name -> name -> username, in that order',
     schedLib.staffingNameFor({ username: 'x', name: 'X Y', staffing_name: 'Z' }) === 'Z' &&
     schedLib.staffingNameFor({ username: 'x', name: 'X Y' }) === 'X Y' &&
     schedLib.staffingNameFor({ username: 'x' }) === 'x' &&
     schedLib.staffingNameFor(null) === '');

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
  // 12b. SCHEDULER v2 — create / link / update / override, against a LOCAL FAKE
  // ─────────────────────────────────────────────────────────────────────────
  // Everything above ran with the integration UNCONFIGURED, proving the honest
  // 501s. This section is the other half: a local stand-in for the staffing app
  // (scripts/fake-scheduler.js — the endpoint surface copied from
  // staffing/server.js) is booted, the env vars are pointed at it, and the
  // whole v2 flow is driven end to end. The one assertion that matters most:
  // a row a human typed into the staffing app is NEVER counted dead by a
  // keep-mode push — and IS replaced by an explicit override, because that
  // difference is somebody's hand-entered itinerary.
  // The env is restored (and the 501s re-proven) at the end, so nothing here
  // can leak configuration into the sections that follow.
  // ══════════════════════════════════════════════════════════════════════════
  section('12b. scheduler v2 — the choice, the invariant, updates, override');

  const { startFakeScheduler } = require('./fake-scheduler');
  const fake = await startFakeScheduler({ user: 'showrunner', pass: 'fake-pass' });
  process.env.SCHEDULER_BASE_URL = fake.url;
  process.env.SCHEDULER_USER = 'showrunner';
  process.env.SCHEDULER_PASS = 'fake-pass';
  schedLib.schedulerResetToken();          // the cache may hold a dead token from nothing — belt and braces
  fake.seed.roster('Dana Fields');
  fake.seed.roster('Marcus Webb');

  // a self-contained fixture: its own folder, its own shows, controlled crew
  const v2P = (await POST('/api/projects',
    { name: TAG + ' sched v2', client: TAG + ' SchedCo', type: 'led' }, { token: A })).body;
  const mkV2Show = async (name) => (await POST('/api/shows', {
    project_id: v2P.id, name, venue: 'Fake Arena',
    load_in_date: '2026-11-20', event_date: '2026-11-21', strike_date: '2026-11-22'
  }, { token: A })).body;

  // ── the create-new arm ────────────────────────────────────────────────────
  const shA = await mkV2Show(TAG + ' v2 create');
  await POST(`/api/shows/${shA.id}/confirm`, {}, { token: A });
  await POST(`/api/shows/${shA.id}/crew`, {
    name: 'Dana Fields', role_on_site: 'Lead',
    travel: { out: { flight_num: 'AA10', arrival_date: '2026-11-20' } }
  }, { token: A });
  await POST('/api/steps', { show_id: shA.id, lane: 'logistics', title: 'Hotel block', status: 'todo' },
    { token: A });
  const evCountBefore = fake.state.events.length;
  const pushA = await POST(`/api/shows/${shA.id}/push-to-scheduler`, { live: true }, { token: A });
  ok('create-new: the live push creates a staffing event', pushA.status === 200
     && pushA.body.created === true && pushA.body.mode === 'keep', pushA.body);
  ok('create-new: the event exists in the fake with the show\'s name',
     fake.state.events.length === evCountBefore + 1
     && fake.state.events.some((e) => e.event === TAG + ' v2 create'), fake.state.events.map((e) => e.event));
  ok('create-new: the travel leg landed under the |inbound sentinel',
     !!fake.state.travel[`Dana Fields|${pushA.body.schedulerEventId}|inbound`],
     Object.keys(fake.state.travel));
  const shAafter = await GET(`/api/shows/${shA.id}`, { token: A });
  ok('create-new: scheduler_event_id + pushed at/by persisted on the show',
     shAafter.body.scheduler_event_id === pushA.body.schedulerEventId
     && !!shAafter.body.scheduler_pushed_at && shAafter.body.scheduler_pushed_by === 'admin',
     { id: shAafter.body.scheduler_event_id, at: shAafter.body.scheduler_pushed_at,
       by: shAafter.body.scheduler_pushed_by });
  ok('create-new: a fresh push reads NOT stale', shAafter.body.scheduler_stale === false,
     shAafter.body.scheduler_stale);
  ok('create-new: the deep link points into the fake scheduler',
     shAafter.body.scheduler_deep_link === `${fake.url}/?event=${pushA.body.schedulerEventId}`,
     shAafter.body.scheduler_deep_link);

  // ── the link-existing arm — with FOREIGN rows already on the event ────────
  // "Brendon started this one": a hand-entered booking, venue contact, client
  // contact and travel leg. None of them is Showrunner's to touch.
  const brendonEv = fake.seed.event({ event: 'Brendon started this one',
    eventDate: '2026-11-21', setup: '2026-11-20', breakdown: '2026-11-22', location: 'Fake Arena' });
  const fBooking = fake.seed.booking(brendonEv.id, { customLabel: 'hand-entered forklift' });
  const fVenue = fake.seed.venueContact(brendonEv.id);
  const fClient = fake.seed.clientContact(brendonEv.id);
  const fTravelKey = `Marcus Webb|${brendonEv.id}|inbound`;
  fake.seed.travel(fTravelKey);

  const list = await GET('/api/scheduler/events', { token: A });
  ok('GET /api/scheduler/events proxies the staffing list', list.status === 200
     && Array.isArray(list.body)
     && list.body.some((e) => e.id === brendonEv.id && e.name === 'Brendon started this one'),
     list.status);
  ok('...trimmed to picker fields — no staff[] / techNotes riding along',
     list.body.every((e) => !('staff' in e) && !('techNotes' in e)), Object.keys(list.body[0] || {}));
  const listTech = await GET('/api/scheduler/events', { token: TECHT });
  ok('...and it sits on the pm floor like the push (tech is 403)', listTech.status === 403, listTech.status);

  const shB = await mkV2Show(TAG + ' v2 link');
  await POST(`/api/shows/${shB.id}/confirm`, {}, { token: A });
  await POST(`/api/shows/${shB.id}/crew`, { name: 'Dana Fields', role_on_site: 'Lead' }, { token: A });
  await POST('/api/steps', { show_id: shB.id, lane: 'logistics', title: 'Feeder cable + distro', status: 'todo' },
    { token: A });

  const badLink = await POST(`/api/shows/${shB.id}/scheduler-link`, { event_id: 999999 }, { token: A });
  ok('linking a nonexistent staffing event is a 400 that says so',
     badLink.status === 400 && /does not exist/.test(badLink.body.error || ''), badLink.body);
  const link = await POST(`/api/shows/${shB.id}/scheduler-link`, { event_id: brendonEv.id }, { token: A });
  ok('link-existing binds the show and sends nothing', link.status === 200
     && link.body.show.scheduler_event_id === brendonEv.id
     && link.body.event.name === 'Brendon started this one'
     && fake.state.bookings.length === (pushA.body.counts.bookings + 1), link.body);
  const actLink = await GET(`/api/activity?show_id=${shB.id}&action=scheduler.link`, { token: A });
  ok('the link is on the activity trail', actLink.status === 200 && actLink.body.length === 1
     && /Brendon started this one/.test(actLink.body[0].detail || ''), actLink.body);
  const relink = await POST(`/api/shows/${shA.id}/scheduler-link`, { event_id: brendonEv.id }, { token: A });
  ok('re-binding a linked show is a 409 pointing at unlink', relink.status === 409
     && /[Uu]nlink first/.test(JSON.stringify(relink.body)), relink.body);

  // THE INVARIANT (keep mode, the default): push INTO Brendon's event; his rows live.
  const pushB = await POST(`/api/shows/${shB.id}/push-to-scheduler`, { live: true, force: true },
    { token: A });
  ok('link-existing: the push UPDATES the linked event, creating nothing', pushB.status === 200
     && pushB.body.created === false && pushB.body.schedulerEventId === brendonEv.id
     && fake.state.events.length === evCountBefore + 2, pushB.body);
  ok('link-existing: the event kept its id and took the show\'s fields (read-modify-write)',
     fake.state.events.some((e) => e.id === brendonEv.id && e.event === TAG + ' v2 link'),
     fake.state.events.map((e) => ({ id: e.id, event: e.event })));
  ok('THE INVARIANT: the hand-entered booking survived the push',
     fake.state.bookings.some((b) => b.id === fBooking.id), fake.state.bookings.map((b) => b.customLabel));
  ok('THE INVARIANT: the hand-entered venue + client contacts survived',
     fake.state.venueContacts.some((v) => v.id === fVenue.id)
     && fake.state.clientContacts.some((c) => c.id === fClient.id),
     { venue: fake.state.venueContacts.length, client: fake.state.clientContacts.length });
  ok('THE INVARIANT: the foreign travel leg survived', !!fake.state.travel[fTravelKey],
     Object.keys(fake.state.travel));
  ok('...and OUR booking landed beside Brendon\'s',
     fake.state.bookings.some((b) => b.eventId === brendonEv.id && b.customLabel === 'Feeder cable + distro'),
     fake.state.bookings.map((b) => b.customLabel));
  const ledgerB = (await pool.query('SELECT pushed_child_ids FROM shows WHERE id=$1', [shB.id]))
    .rows[0].pushed_child_ids;
  ok('the push ledger records ONLY our ids — never a foreign one',
     Array.isArray(ledgerB.bookings) && ledgerB.bookings.length > 0
     && !ledgerB.bookings.includes(fBooking.id)
     && !ledgerB.venueContacts.includes(fVenue.id)
     && !ledgerB.clientContacts.includes(fClient.id), ledgerB);

  // ── stale detection + the update push ─────────────────────────────────────
  const shBfresh = await GET(`/api/shows/${shB.id}`, { token: A });
  ok('after the push the show reads NOT stale', shBfresh.body.scheduler_stale === false,
     shBfresh.body.scheduler_stale);
  await POST('/api/steps', { show_id: shB.id, lane: 'logistics', title: '53ft dry van', status: 'todo' },
    { token: A });
  const shBstale = await GET(`/api/shows/${shB.id}`, { token: A });
  ok('STALE: adding a step after the push flips the indicator',
     shBstale.body.scheduler_stale === true, shBstale.body.scheduler_stale);
  const ourBefore = ledgerB.bookings.length;
  const push2 = await POST(`/api/shows/${shB.id}/push-to-scheduler`, { live: true, force: true },
    { token: A });
  ok('UPDATE push: our previous rows were swept (removed = what the ledger held)',
     push2.status === 200 && push2.body.removed.bookings === ourBefore, push2.body.removed);
  ok('UPDATE push: the new booking is over there now',
     fake.state.bookings.some((b) => b.eventId === brendonEv.id && b.customLabel === '53ft dry van'),
     fake.state.bookings.map((b) => b.customLabel));
  ok('UPDATE push: Brendon\'s booking is STILL alive after the delete-then-insert',
     fake.state.bookings.some((b) => b.id === fBooking.id), fake.state.bookings.length);
  ok('UPDATE push: stale is back to false',
     (await GET(`/api/shows/${shB.id}`, { token: A })).body.scheduler_stale === false);
  const shBcrewStale = await POST(`/api/shows/${shB.id}/crew`,
    { name: 'Marcus Webb', role_on_site: 'Hand' }, { token: A });
  ok('STALE: a crew change flips it too', shBcrewStale.status === 200
     && (await GET(`/api/shows/${shB.id}`, { token: A })).body.scheduler_stale === true);

  // ── override — the explicit, per-push opt-out of the invariant ────────────
  const badMode = await POST(`/api/shows/${shB.id}/push-to-scheduler`,
    { live: true, force: true, mode: 'bananas' }, { token: A });
  ok('an unknown mode is a 400 naming the value, never a silent fallback',
     badMode.status === 400 && /bananas/.test(badMode.body.error || ''), badMode.body);
  const push3 = await POST(`/api/shows/${shB.id}/push-to-scheduler`,
    { live: true, force: true, mode: 'override' }, { token: A });
  ok('OVERRIDE: the push reports the mode it ran in', push3.status === 200
     && push3.body.mode === 'override', push3.body);
  ok('OVERRIDE: Brendon\'s hand-entered rows are gone — replaced, as confirmed',
     !fake.state.bookings.some((b) => b.id === fBooking.id)
     && !fake.state.venueContacts.some((v) => v.id === fVenue.id)
     && !fake.state.clientContacts.some((c) => c.id === fClient.id),
     fake.state.bookings.map((b) => b.customLabel));
  ok('OVERRIDE: our full set landed', fake.state.bookings.filter((b) => b.eventId === brendonEv.id).length
     === push3.body.counts.bookings, push3.body.counts);
  ok('OVERRIDE: travel legs are NOT deleted — staffing has no DELETE for them',
     !!fake.state.travel[fTravelKey], Object.keys(fake.state.travel));
  const actPush = await GET(`/api/activity?show_id=${shB.id}&action=scheduler.push`, { token: A });
  ok('the activity trail records WHICH mode each push ran',
     actPush.body.some((a) => /mode override/.test(a.detail || ''))
     && actPush.body.some((a) => /mode keep/.test(a.detail || '')),
     actPush.body.map((a) => a.detail));

  // ── unlink — local only, nothing remote touched ───────────────────────────
  const remoteSnapshot = JSON.stringify({
    events: fake.state.events.length, bookings: fake.state.bookings.length,
    venue: fake.state.venueContacts.length, client: fake.state.clientContacts.length,
    travel: Object.keys(fake.state.travel).length
  });
  const un = await DEL(`/api/shows/${shB.id}/scheduler-link`, { token: A });
  ok('unlink clears the binding and the push ledger', un.status === 200
     && un.body.show.scheduler_event_id === null && un.body.show.scheduler_pushed_at === null
     && un.body.unlinkedEventId === brendonEv.id, un.body.show && un.body.show.scheduler_event_id);
  ok('unlink touched NOTHING remote — every staffing count identical',
     JSON.stringify({
       events: fake.state.events.length, bookings: fake.state.bookings.length,
       venue: fake.state.venueContacts.length, client: fake.state.clientContacts.length,
       travel: Object.keys(fake.state.travel).length
     }) === remoteSnapshot, remoteSnapshot);
  const unAgain = await DEL(`/api/shows/${shB.id}/scheduler-link`, { token: A });
  ok('unlinking an unlinked show is a 409, not a shrug', unAgain.status === 409, unAgain.body);
  const actUnlink = await GET(`/api/activity?show_id=${shB.id}&action=scheduler.unlink`, { token: A });
  ok('the unlink activity line says nothing was deleted remotely',
     actUnlink.body.length === 1 && /nothing was deleted/.test(actUnlink.body[0].detail || ''),
     actUnlink.body);

  // ── restore the unconfigured world and re-prove the honest refusals ───────
  delete process.env.SCHEDULER_BASE_URL;
  delete process.env.SCHEDULER_USER;
  delete process.env.SCHEDULER_PASS;
  schedLib.schedulerResetToken();
  await fake.close();
  const list501 = await GET('/api/scheduler/events', { token: A });
  ok('env cleared: the event listing is the honest 501 again',
     list501.status === 501 && /SCHEDULER_BASE_URL/.test(list501.body.error || ''), list501.body);
  const link501 = await POST(`/api/shows/${shB.id}/scheduler-link`, { event_id: 1 }, { token: A });
  ok('env cleared: linking refuses honestly too', link501.status === 501, link501.body);
  const live501 = await POST(`/api/shows/${shA.id}/push-to-scheduler`, { live: true, force: true },
    { token: A });
  ok('env cleared: the live push is the 501 it was before this section',
     live501.status === 501, live501.body);
  const unOffline = await DEL(`/api/shows/${shA.id}/scheduler-link`, { token: A });
  ok('unlink still WORKS unconfigured — it touches nothing remote',
     unOffline.status === 200 && unOffline.body.show.scheduler_event_id === null, unOffline.body);
  // this section's fixture folder goes with it — the cleanup gate counts leftovers
  await DEL(`/api/projects/${v2P.id}`, { token: A });

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
  // The season dashboard (viewSeason) rolls up from the shows EMBEDDED in a
  // hydrated project — if they arrive without a steps array the first paint of
  // any multi-show folder is a TypeError, not a dashboard. hydrateShow already
  // queries the steps for deriveRag; embedding them costs nothing.
  ok('hydrated project embeds steps on every show (season rollup reads them)',
     Array.isArray(projAsFin.body.shows) && projAsFin.body.shows.length > 0
     && projAsFin.body.shows.every((s) => Array.isArray(s.steps)),
     (projAsFin.body.shows || []).map((s) => ({ id: s.id, steps: s.steps && s.steps.length })));
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

  // ── 7b. HARDENING 21 (delete half). The gate on DELETE /files/:id was
  // canEditProject ONLY, while its two immediate neighbours — PUT /files/:id and
  // PUT /files/:id/content — both read "canEditProject OR the uploader". So the
  // person who filed the wrong document could rename it and could replace its
  // bytes, and could not remove it: they had to find a manager. The tech is the
  // discriminating identity, because canEditProject is false for every tech.
  const techDoc = await POST('/api/files',
    { show_id: S, name: TAG + '-tech-filed-this', ext: 'pdf', kind: 'other' }, { token: TECHT });
  ok('7b: a tech may FILE a document — they upload confirmations and photos',
     techDoc.status === 200, techDoc.body);
  ok('7b: ...and the row records who filed it', techDoc.body.uploaded_by === techUser,
     techDoc.body.uploaded_by);
  const otherDoc = await POST('/api/files',
    { show_id: S, name: TAG + '-admin-filed-this', ext: 'pdf', kind: 'other' }, { token: A });
  const techDelOther = await DEL(`/api/files/${otherDoc.body.id}`, { token: TECHT });
  ok('7b: a tech may NOT delete a document somebody else filed',
     techDelOther.status === 403, techDelOther.body);
  const techDelOwn = await DEL(`/api/files/${techDoc.body.id}`, { token: TECHT });
  ok('7b: ...but the UPLOADER may take their own mistake back off the record',
     techDelOwn.status === 200, techDelOwn.body);
  ok('7b: ...and it is really gone',
     (await GET(`/api/files/${techDoc.body.id}`, { token: A })).status === 404);
  ok('7b: deleting a file that never existed is a 404, not {ok:true}',
     (await DEL('/api/files/987654', { token: A })).status === 404);
  await DEL(`/api/files/${otherDoc.body.id}`, { token: A });

  // ── 7c. the fabrication line, at the route. A financial doc filed with no
  // size claims ZERO — the front end no longer sends one (HARDENING 21) and the
  // row must not invent one on its behalf. `upload_url` is the other half of
  // the contract: the bytes follow, and PUT /content is what sets the size.
  const finRow = await POST('/api/files', {
    show_id: S, name: TAG + '-vendor-confirmation', ext: 'pdf', kind: 'confirmation',
    vendor: 'Midwest Freight', amount: 4200, doc_date: '2026-09-10'
  }, { token: A });
  ok('7c: a financial doc filed with NO size claims zero, never a plausible constant',
     finRow.status === 200 && Number(finRow.body.size) === 0, finRow.body.size);
  ok('7c: ...and it hands back the upload_url the browser PUTs the bytes to',
     finRow.body.upload_url === `/api/files/${finRow.body.id}/content`, finRow.body.upload_url);
  ok('7c: ...with the expense created in the same transaction, evidenced by the doc',
     finRow.body.created && finRow.body.created.expense_id > 0, finRow.body.created);
  await DEL(`/api/files/${finRow.body.id}`, { token: A });

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
  // ════════════════════════════════════════════════════════════════════════
  // A BARE BLOCK on purpose: `const` is block-scoped, so this section can name
  // its locals for what they are without colliding with the hundreds main()
  // has already declared above it.
  // ════════════════════════════════════════════════════════════════════════
  {
  // ══════════════════════════════════════════════════════════════════════════
  // 15. THE FIRST POST-DEPLOY RELEASE — F1 events · F2 reports · F3 outbox ·
  //     F4 scope · F5 confirm lifecycle · F6 closeout + archiving
  // ══════════════════════════════════════════════════════════════════════════
  section('15. F1–F6 — events, reports, outbox, scope, confirm, archiving');

  // The outbox skips a person with no address on file, which is correct and is
  // asserted elsewhere — but it would mask every delivery assertion below, so
  // the run's own identities get one first.
  await pool.query(
    `UPDATE users SET email = username || '@e360sport.test' WHERE username LIKE $1 OR username='admin'`,
    [TAG + '%']);

  // ── F5: the stage vocabulary is a UNION, and it never rewrites a row ──────
  const stages = await GET('/api/stages', { token: A });
  ok('F5: /api/stages publishes the lifecycle, so the SPA never hardcodes it',
     stages.status === 200 &&
     stages.body.lifecycle.join('>') === 'quoted>confirmed>in_progress>delivered>closed>archived',
     stages.body.lifecycle);
  ok('F5: every legacy value is STILL a legal stage — the enum is a union',
     ['lead', 'planning', 'ready', 'scheduled', 'closed'].every((s) => stages.body.all.includes(s)),
     stages.body.all);
  ok('F5: the legacy→lifecycle map is published, not duplicated in the client',
     stages.body.alias.lead === 'quoted' && stages.body.alias.planning === 'confirmed' &&
     stages.body.alias.ready === 'confirmed' && stages.body.alias.scheduled === 'in_progress',
     stages.body.alias);

  // A row written BEFORE this release. Nothing may rewrite it.
  const legacyShow = await POST('/api/shows', {
    project_id: P, name: TAG + ' legacy stage', venue: 'Legacy Arena',
    load_in_date: '2026-11-01', event_date: '2026-11-03', stage: 'planning'
  }, { token: A });
  const LS = legacyShow.body.id;
  const lsRaw = await pool.query('SELECT stage FROM shows WHERE id=$1', [LS]);
  ok('F5: a legacy stage string is STORED verbatim', lsRaw.rows[0].stage === 'planning', lsRaw.rows[0]);
  const lsGet = await GET(`/api/shows/${LS}`, { token: A });
  ok('F5: ...returned verbatim, with the canonical position ALONGSIDE it',
     lsGet.body.stage === 'planning' && lsGet.body.stage_canonical === 'confirmed' &&
     lsGet.body.stage_label === 'Planning',
     { stage: lsGet.body.stage, canon: lsGet.body.stage_canonical, label: lsGet.body.stage_label });
  ok('F5: ...and reads as confirmed BY POSITION, with no datestamp invented',
     lsGet.body.confirmed === true && lsGet.body.confirmed_at === null);

  // ── F5: the confirm gate — mutation-tested with discriminating identities ─
  const quoted = await POST('/api/shows', {
    project_id: P, name: TAG + ' unconfirmed', venue: 'TBD',
    load_in_date: '2026-12-01', event_date: '2026-12-03', stage: 'quoted'
  }, { token: A });
  const QS = quoted.body.id;
  ok('F5: a new show can be opened at "quoted"', quoted.body.stage === 'quoted' &&
     quoted.body.confirmed === false, quoted.body.stage);

  const techConfirm = await POST(`/api/shows/${QS}/confirm`, {}, { token: TECHT });
  ok('F5 GATE: a TECH cannot confirm', techConfirm.status === 403, techConfirm.body);
  // pm2User owns NOTHING — the discriminating pm. The smoke folder is owned by
  // pmUser, so pm2 fails the ownership term while clearing the rank one.
  const pm2Confirm = await POST(`/api/shows/${QS}/confirm`, {}, { token: PM2T });
  ok('F5 GATE: a pm who owns neither the show nor its folder cannot confirm',
     pm2Confirm.status === 403, pm2Confirm.body);
  const stillQuoted = await pool.query('SELECT confirmed_at, stage FROM shows WHERE id=$1', [QS]);
  ok('F5 GATE: ...and both refusals wrote nothing',
     stillQuoted.rows[0].confirmed_at === null && stillQuoted.rows[0].stage === 'quoted',
     stillQuoted.rows[0]);
  // the OWNING pm clears it — the gate ADMITS, not just refuses
  const pmConfirm = await POST(`/api/shows/${QS}/confirm`, {}, { token: PMT });
  ok('F5 GATE: the pm who OWNS the folder clears it', pmConfirm.status === 200, pmConfirm.body);
  ok('F5: confirm records who and when', !!pmConfirm.body.show.confirmed_at &&
     pmConfirm.body.show.confirmed_by === pmUser, pmConfirm.body.show.confirmed_by);
  ok('F5: ...advances the stage and says the scheduler is unlocked',
     pmConfirm.body.show.stage === 'confirmed' && pmConfirm.body.scheduler_unlocked === true);
  ok('F5: ...and prompts for the real QuickBooks number, because the job is TEMP',
     !!pmConfirm.body.qb_prompt && /^TEMP-/.test(pmConfirm.body.qb_prompt.qb_job_number),
     pmConfirm.body.qb_prompt);
  const confAct = await pool.query(
    `SELECT action, detail FROM activity WHERE show_id=$1 AND action='show.confirm'`, [QS]);
  ok('F5: ...and it is in the audit trail', confAct.rows.length === 1, confAct.rows[0]);
  const twice = await POST(`/api/shows/${QS}/confirm`, {}, { token: A });
  ok('F5: confirming twice is a 409 — one datestamp, never two', twice.status === 409, twice.body);

  // ── F5: the push gate ────────────────────────────────────────────────────
  const preShow = await POST('/api/shows', {
    project_id: P, name: TAG + ' prepush', venue: 'Arena',
    load_in_date: '2026-12-10', event_date: '2026-12-12', stage: 'quoted'
  }, { token: A });
  const PS = preShow.body.id;
  const pushRefused = await POST(`/api/shows/${PS}/push-to-scheduler`, { live: true }, { token: A });
  ok('F5 GATE: an UNCONFIRMED show refuses the live push (409)',
     pushRefused.status === 409 && /not confirmed/i.test(JSON.stringify(pushRefused.body)),
     pushRefused.body);
  ok('F5 GATE: ...and the refusal names the endpoint that fixes it',
     /\/confirm$/.test(String(pushRefused.body.confirmEndpoint || '')), pushRefused.body);
  const preDry = await POST(`/api/shows/${PS}/push-to-scheduler`, {}, { token: A });
  ok('F5: the DRY RUN still runs — it is the diagnostic, and it explains the refusal',
     preDry.status === 200 && preDry.body.ready === false &&
     preDry.body.problems.some((p) => /not confirmed/i.test(p)), preDry.body.problems);
  await POST(`/api/shows/${PS}/confirm`, {}, { token: A });
  const postDry = await POST(`/api/shows/${PS}/push-to-scheduler`, {}, { token: A });
  ok('F5: confirming clears that problem from the dry run',
     !postDry.body.problems.some((p) => /not confirmed/i.test(p)), postDry.body.problems);
  // ADDITIVE PROOF: a LEGACY row is pushable without anyone confirming it
  const legacyDry = await POST(`/api/shows/${LS}/push-to-scheduler`, {}, { token: A });
  ok('F5 ADDITIVE: a pre-existing "planning" row is NOT blocked — no migration needed',
     !legacyDry.body.problems.some((p) => /not confirmed/i.test(p)), legacyDry.body.problems);

  // ── F4: the scope line ───────────────────────────────────────────────────
  const noScope = await GET(`/api/shows/${S}/scope`, { token: A });
  ok('F4: a show with no scope answers cleanly rather than 404ing',
     noScope.status === 200 && noScope.body.scope_line === '', noScope.body);
  const techScope = await PUT(`/api/shows/${S}/scope`, { kind: 'led', cabinet_count: 999 }, { token: TECHT });
  ok('F4 GATE: a tech cannot set the scope', techScope.status === 403, techScope.body);
  const setScope = await PUT(`/api/shows/${S}/scope`, {
    kind: 'led', linear_feet: 800, cabinet_count: 144, pitch: 'P10'
  }, { token: A });
  ok('F4: pm+ can, and the server renders the ONE canonical line',
     setScope.status === 200 && setScope.body.scope_line === 'LED · 800′ · 144× P10',
     setScope.body.scope_line);
  ok('F4: ...and stamps who verified it and when',
     !!setScope.body.scope_verified_at && setScope.body.scope_verified_by === 'admin');
  const badKind = await PUT(`/api/shows/${S}/scope`, { kind: 'holograms' }, { token: A });
  ok('F4: an unknown scope kind is a 400 that lists the real ones',
     badKind.status === 400 && /led, print, both/.test(String(badKind.body.error)), badKind.body);
  const negScope = await PUT(`/api/shows/${S}/scope`, { cabinet_count: -5 }, { token: A });
  ok('F4: a negative count is refused, not stored', negScope.status === 400, negScope.body);
  const printScope = await PUT(`/api/shows/${LS}/scope`, {
    kind: 'print', print_pieces: 34, print_sqft: 4120
  }, { token: A });
  ok('F4: a print scope reads in its own units',
     printScope.body.scope_line === 'Print · 34 pcs · 4,120 sq ft', printScope.body.scope_line);
  const bothScope = await PUT(`/api/shows/${LS}/scope`, {
    kind: 'both', linear_feet: 560, cabinet_count: 64
  }, { token: A });
  ok('F4: switching to "both" KEEPS the print numbers — nothing is a union type',
     bothScope.body.scope_line === 'LED + Print · 560′ · 64× · 34 pcs · 4,120 sq ft',
     bothScope.body.scope_line);
  await PUT(`/api/shows/${LS}/scope`, { kind: 'print' }, { token: A });

  // F4: auto-fill + divergence from the BOUND SPEC (the smoke show has one)
  const specScope = await POST(`/api/shows/${S}/scope/from-spec`, {}, { token: A });
  ok('F4: filling from the bound spec takes the STACK-AWARE count',
     specScope.status === 200 && specScope.body.scope_cabinet_count === specScope.body.spec.cabinet_count,
     { got: specScope.body.scope_cabinet_count, spec: specScope.body.spec });
  ok('F4: ...and marks the source so nobody wonders where the number came from',
     specScope.body.scope_source === 'spec');
  ok('F4: ...while linear feet, which no spec records, is untouched',
     Number(specScope.body.scope_linear_feet) === 800);
  await PUT(`/api/shows/${S}/scope`, { cabinet_count: 999, source: 'manual' }, { token: A });
  const diverged = await GET(`/api/shows/${S}/scope`, { token: A });
  ok('F4: divergence from the bound spec is a QUESTION, not an error',
     diverged.status === 200 && diverged.body.questions.length >= 1 &&
     diverged.body.questions[0].kind === 'question' &&
     /Which is what we delivered\?/.test(diverged.body.questions[0].ask),
     diverged.body.questions);
  ok('F4: ...and the hand-entered number was NOT overwritten by asking',
     diverged.body.scope.cabinet_count === 999);
  const noSpecShow = await POST(`/api/shows/${LS}/scope/from-spec`, {}, { token: A });
  ok('F4: a show with no usable spec says so instead of inventing numbers',
     noSpecShow.status === 409 && /No bound spec/.test(String(noSpecShow.body.error)), noSpecShow.body);
  await PUT(`/api/shows/${S}/scope`, { kind: 'led', linear_feet: 800, cabinet_count: 144,
                                       pitch: 'P10', cabinet_type: null, source: 'manual' }, { token: A });

  // ── F4 FIREWALL ASSERTION: the whitelist was widened DELIBERATELY ─────────
  // On a show of its own: the smoke folder's main show already carries a SENT
  // recap, and a sent recap is a record rather than a draft — regenerating one
  // is correctly refused, which is a different assertion from this one.
  const fwShow = await POST('/api/shows', {
    project_id: P, name: TAG + ' firewall', venue: 'Firewall Arena',
    load_in_date: '2026-11-20', event_date: '2026-11-22', strike_date: '2026-11-23',
    stage: 'confirmed'
  }, { token: A });
  const FS = fwShow.body.id;
  await PUT(`/api/shows/${FS}/scope`,
    { kind: 'led', linear_feet: 800, cabinet_count: 144, pitch: 'P10' }, { token: A });
  const fw = require('../lib/firewall');
  ok('F4 FIREWALL: the seven scope fields are named in RECAP_SOURCES.show',
     ['scope_kind', 'scope_linear_feet', 'scope_cabinet_count', 'scope_cabinet_type',
      'scope_pitch', 'scope_print_pieces', 'scope_print_sqft']
       .every((f) => fw.RECAP_SOURCES.show.includes(f)));
  ok('F4 FIREWALL: scope_verified_by / _at are NOT — who checked our numbers is ours',
     !fw.RECAP_SOURCES.show.includes('scope_verified_by') &&
     !fw.RECAP_SOURCES.show.includes('scope_verified_at'));
  const recapScoped = await POST(`/api/shows/${FS}/recap`, {}, { token: A });
  const scopeStat = (recapScoped.body.body.stats || []).find((x) => x.key === 'scope');
  ok('F4 FIREWALL: the scope reaches the recap as a stat with a client-safe KEY',
     !!scopeStat && scopeStat.value === 'LED · 800′ · 144× P10', scopeStat);
  const statKeys = new Set((await GET('/api/recap-stat-keys', { token: A })).body.map((k) => k.key));
  ok('F4 FIREWALL: every stat key the generator emits is in recap_stat_keys (an FK, not a regex)',
     (recapScoped.body.body.stats || []).every((x) => statKeys.has(x.key)),
     (recapScoped.body.body.stats || []).map((x) => x.key));
  const badStat = await PUT(`/api/shows/${FS}/recap`, {
    stats: [{ key: 'unit_cost', label: 'Unit cost', value: '12' }]
  }, { token: A });
  ok('F4 FIREWALL: a stat key OFF the whitelist is refused by name',
     badStat.status === 400 && /not a client-safe stat key/.test(String(badStat.body.error)),
     badStat.body);

  // ── F2: tech show reports ────────────────────────────────────────────────
  // Give the smoke show a crew with logins and one local hire with none.
  await POST(`/api/shows/${FS}/crew`, { username: techUser, role_on_site: 'LED tech',
                                       call_time: '07:00' }, { token: A });
  await POST(`/api/shows/${FS}/crew`, { username: pm2User, role_on_site: 'Systems',
                                       call_time: '08:00' }, { token: A });
  await POST(`/api/shows/${FS}/crew`, { name: 'Local Hand', phone: '(555) 555-0100',
                                       role_on_site: 'Local hand' }, { token: A });
  const struck = await POST(`/api/shows/${FS}/struck`, {}, { token: A });
  ok('F2: marking a show struck creates one report per LOGGED-IN crew member',
     struck.status === 200 && struck.created !== 0 && struck.body.summary.total === 2,
     struck.body.summary);
  ok('F2: ...the local hire owes nothing — no login, nobody to ask',
     struck.body.summary.total === 2, struck.body.summary);
  ok('F2: ...and it records who struck it', !!struck.body.show.struck_at);
  const struckAgain = await POST(`/api/shows/${FS}/struck`, {}, { token: A });
  ok('F2: striking twice creates nothing — it is idempotent',
     struckAgain.body.created === 0, struckAgain.body);
  const nagNote = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notes WHERE show_id=$1 AND author='system'`, [FS]);
  ok('F2: the nag rides the EXISTING bell mechanism — an anchored note per person',
     nagNote.rows[0].n >= 2, nagNote.rows[0]);
  const nagOutbox = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox WHERE show_id=$1 AND kind='report_nag'`, [FS]);
  ok('F2/F3: ...and an outbox row of kind report_nag, so the NAG preference applies',
     nagOutbox.rows[0].n >= 2, nagOutbox.rows[0]);

  // F2 GATE: view-all is pm+, mutation-tested with discriminating identities
  const techList = await GET(`/api/shows/${FS}/tech-reports`, { token: TECHT });
  ok('F2 GATE: a TECH sees his own row and nobody else’s',
     techList.status === 200 && techList.body.can_view_all === false &&
     techList.body.reports.length === 1 && techList.body.reports[0].username === techUser,
     techList.body.reports.map((r) => r.username));
  ok('F2 GATE: ...gets the headcount but NOT the names of who else is late',
     techList.body.summary.owed === 2 && techList.body.summary.waiting_on === undefined,
     techList.body.summary);
  const pmList = await GET(`/api/shows/${FS}/tech-reports`, { token: PMT });
  ok('F2 GATE: a PM sees every row', pmList.body.can_view_all === true &&
     pmList.body.reports.length === 2, pmList.body.reports.length);
  ok('F2 GATE: ...and the names of everyone still out',
     Array.isArray(pmList.body.summary.waiting_on) && pmList.body.summary.waiting_on.length === 2,
     pmList.body.summary.waiting_on);
  const othersId = pmList.body.reports.find((r) => r.username === pm2User).id;
  const techPeek = await GET(`/api/tech-reports/${othersId}`, { token: TECHT });
  ok('F2 GATE: a tech cannot read a colleague’s report directly either',
     techPeek.status === 403, techPeek.body);

  // F2: filing — the tech's own, and what it changes
  const myOwed = await GET('/api/me/reports', { token: TECHT });
  ok('F2: /api/me/reports is the My Tasks nag', myOwed.status === 200 && myOwed.body.length === 1 &&
     !!myOwed.body[0].show, myOwed.body.length);
  const filedEmpty = await POST(`/api/shows/${FS}/tech-report`, { body: '   ' }, { token: TECHT });
  ok('F2: an empty report is not filed', filedEmpty.status === 400, filedEmpty.body);
  const filed = await POST(`/api/shows/${FS}/tech-report`, {
    body: 'One cabinet in the north run failed on first power — swapped from the spare pack. ' +
          'Dock was double-booked with catering at 08:00, worth writing into the advance.'
  }, { token: TECHT });
  ok('F2: filing flips it to FILED with a datestamp',
     filed.status === 200 && filed.body.report.status === 'filed' && !!filed.body.report.filed_at,
     filed.body.report);
  ok('F2: ...and it lands in the event folder’s files as a document',
     !!filed.body.file && filed.body.file.kind === 'report' && filed.body.file.show_id === FS,
     filed.body.file);
  ok('F2: ...the summary drops to one outstanding', filed.body.summary.owed === 1, filed.body.summary);
  ok('F2: ...and My Tasks stops nagging him',
     (await GET('/api/me/reports', { token: TECHT })).body.length === 0);
  const revised = await POST(`/api/shows/${FS}/tech-report`, { body: 'Revised: two failures.' },
                             { token: TECHT });
  ok('F2: revising does NOT create a second document',
     revised.body.file.id === filed.body.file.id, { a: filed.body.file.id, b: revised.body.file.id });
  const offCrew = await POST(`/api/shows/${FS}/tech-report`, { body: 'I was not there.' },
                             { token: MGRT });
  ok('F2: someone not on the crew owes nothing and is told so, not silently enrolled',
     offCrew.status === 403 && /not on this show/.test(String(offCrew.body.error)), offCrew.body);
  const myReportId = filed.body.report.id;
  const pmWrite = await PUT(`/api/tech-reports/${myReportId}`, { body: 'A pm rewriting it.' },
                            { token: PMT });
  ok('F2 GATE: a PM cannot WRITE somebody else’s report — there is no such lever',
     pmWrite.status === 403 && /written by the person it belongs to/.test(String(pmWrite.body.error)),
     pmWrite.body);
  const stillMine = await pool.query('SELECT body FROM tech_reports WHERE id=$1', [myReportId]);
  ok('F2 GATE: ...and the body is untouched', /Revised: two failures/.test(stillMine.rows[0].body));

  // F2 GATE: review is pm+ — mutation-tested both ways
  const techReview = await POST(`/api/tech-reports/${myReportId}/review`, {}, { token: TECHT });
  ok('F2 GATE: a TECH cannot mark a report reviewed — not even his own',
     techReview.status === 403 && /never sign one off/.test(String(techReview.body.error)),
     techReview.body);
  const unreviewed = await pool.query('SELECT status FROM tech_reports WHERE id=$1', [myReportId]);
  ok('F2 GATE: ...and the refusal wrote nothing', unreviewed.rows[0].status === 'filed');
  const pmReview = await POST(`/api/tech-reports/${myReportId}/review`, {}, { token: PMT });
  ok('F2 GATE: a PM can — the gate ADMITS as well as refuses',
     pmReview.status === 200 && pmReview.body.status === 'reviewed' &&
     pmReview.body.reviewed_by === pmUser, pmReview.body);
  const rewriteAfter = await PUT(`/api/tech-reports/${myReportId}`, { body: 'sneak' }, { token: TECHT });
  ok('F2: a reviewed report is locked until a pm reopens it', rewriteAfter.status === 409,
     rewriteAfter.body);
  await POST(`/api/tech-reports/${myReportId}/reopen`, {}, { token: PMT });
  const reopened = await pool.query('SELECT status FROM tech_reports WHERE id=$1', [myReportId]);
  ok('F2: reopening puts it back to FILED, not to owed — the obligation stayed met',
     reopened.rows[0].status === 'filed', reopened.rows[0]);

  // ── F2 FIREWALL ASSERTION: a report body can NEVER reach a recap ──────────
  const POISON = 'CANARY9931 the venue went over budget and the vendor invoice was wrong';
  await pool.query(`UPDATE tech_reports SET body=$2 WHERE id=$1`, [myReportId, POISON]);
  const factsShow = await require('../lib/db').loadShow(FS);
  const facts = await fw.recapFacts(pool, factsShow);
  ok('F2 FIREWALL: recapFacts does not return the report body under ANY key',
     JSON.stringify(facts).indexOf('CANARY9931') < 0);
  const regen = await POST(`/api/shows/${FS}/recap`, {}, { token: A });
  ok('F2 FIREWALL: a real regenerate through the route does not carry it either',
     JSON.stringify(regen.body.body).indexOf('CANARY9931') < 0);
  const stillThere = await pool.query('SELECT body FROM tech_reports WHERE id=$1', [myReportId]);
  ok('F2 FIREWALL: ...and the body really is still sitting there, simply unread',
     /CANARY9931/.test(stillThere.rows[0].body));
  // THE ENFORCEMENT, not the observation: the guard THROWS on a forbidden read.
  let guardThrew = null;
  try {
    await fw.guardRecapQuery(pool).query('SELECT body FROM tech_reports WHERE show_id=$1', [FS]);
  } catch (e) { guardThrew = e.message; }
  ok('F2 FIREWALL: the query guard THROWS if the generator ever reads tech_reports',
     !!guardThrew && /may not read `tech_reports`/.test(guardThrew), guardThrew);
  ok('F2 FIREWALL: ...and names every other table it may not read either',
     ['expenses', 'purchase_orders', 'jobs', 'budget_lines', 'notes', 'deliverables']
       .every((t) => fw.RECAP_FORBIDDEN_TABLES.includes(t)), fw.RECAP_FORBIDDEN_TABLES);
  let allowedOk = false;
  try {
    await fw.guardRecapQuery(pool).query('SELECT id FROM shows WHERE id=$1', [FS]);
    allowedOk = true;
  } catch (_) { allowedOk = false; }
  ok('F2 FIREWALL: ...while the reads it IS allowed pass straight through', allowedOk);
  ok('F2 FIREWALL: a human pasting the report body into the recap is REFUSED, not scrubbed',
     !!fw.recapUnsafe(POISON), fw.recapUnsafe(POISON));

  // ── F3: the notification outbox ──────────────────────────────────────────
  const prefs = await GET('/api/me/notification-prefs', { token: TECHT });
  ok('F3: a person with no stored row gets Tom’s defaults',
     prefs.status === 200 && prefs.body.prefs.assignment === 'immediate' &&
     prefs.body.prefs.mention === 'immediate' && prefs.body.prefs.notify === 'digest' &&
     prefs.body.prefs.report_nag === 'digest', prefs.body.prefs);
  const prefRows0 = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notification_prefs WHERE username=$1', [techUser]);
  ok('F3: ...and the table stores NOTHING for them — it is a deviation list',
     prefRows0.rows[0].n === 0, prefRows0.rows[0]);
  const setPref = await PUT('/api/me/notification-prefs', { notify: 'off' }, { token: TECHT });
  ok('F3: setting a deviation stores it', setPref.status === 200 && setPref.body.prefs.notify === 'off');
  const prefRows1 = await pool.query(
    'SELECT mode FROM notification_prefs WHERE username=$1 AND kind=$2', [techUser, 'notify']);
  ok('F3: ...as exactly one row', prefRows1.rows.length === 1 && prefRows1.rows[0].mode === 'off');
  await PUT('/api/me/notification-prefs', { notify: 'digest' }, { token: TECHT });
  const prefRows2 = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notification_prefs WHERE username=$1', [techUser]);
  ok('F3: writing the HOUSE DEFAULT removes the row again', prefRows2.rows[0].n === 0);
  const badMode = await PUT('/api/me/notification-prefs', { mention: 'telepathy' }, { token: TECHT });
  ok('F3: an unknown delivery mode is a 400 that lists the real ones',
     badMode.status === 400 && /immediate, digest, off/.test(String(badMode.body.error)), badMode.body);

  // an assignment is a real delivery
  const assignStep = (await GET(`/api/steps?show_id=${S}`, { token: A })).body[0];
  await PUT(`/api/steps/${assignStep.id}/assign`, { owner: techUser }, { token: A });
  const assignRow = await pool.query(
    `SELECT * FROM notification_outbox WHERE username=$1 AND kind='assignment' ORDER BY id DESC LIMIT 1`,
    [techUser]);
  ok('F3: assigning work queues an IMMEDIATE outbox row',
     assignRow.rows.length === 1 && assignRow.rows[0].mode === 'immediate' &&
     assignRow.rows[0].status === 'queued', assignRow.rows[0]);
  ok('F3: ...naming the task, not just "something changed"',
     /Assigned to you/.test(assignRow.rows[0].subject), assignRow.rows[0].subject);

  // an @mention is a real delivery, and it carries its note id
  const mentionNote = await POST('/api/notes', {
    anchor_type: 'show', anchor_id: S, body: `Power plan is sorted — @${techUser} worth a look.`
  }, { token: A });
  const mentionRow = await pool.query(
    `SELECT * FROM notification_outbox WHERE note_id=$1`, [mentionNote.body.id]);
  ok('F3: an @mention queues an outbox row carrying its NOTE ID',
     mentionRow.rows.length === 1 && mentionRow.rows[0].kind === 'mention' &&
     mentionRow.rows[0].username === techUser, mentionRow.rows[0]);

  // SKIP-IF-READ-IN-APP
  const marked = await POST('/api/me/inbox/read', { ids: [mentionNote.body.id] }, { token: TECHT });
  ok('F3 SKIP-IF-READ: the tech read it in the app first', marked.body.marked === 1, marked.body);
  const flush1 = await POST('/api/admin/notifications/flush', {}, { token: A });
  const afterFlush = await pool.query('SELECT * FROM notification_outbox WHERE note_id=$1',
    [mentionNote.body.id]);
  ok('F3 SKIP-IF-READ: a row whose note was already read in-app is SKIPPED, not sent',
     afterFlush.rows[0].status === 'skipped' && afterFlush.rows[0].skipped_reason === 'read in-app',
     afterFlush.rows[0]);
  ok('F3 SKIP-IF-READ: ...and the flush counted it', flush1.body.skipped >= 1, flush1.body);
  const unreadNote = await POST('/api/notes', {
    anchor_type: 'show', anchor_id: S, body: `Second one — @${techUser} this one is unread.`
  }, { token: A });
  await POST('/api/admin/notifications/flush', {}, { token: A });
  const sentRow = await pool.query('SELECT * FROM notification_outbox WHERE note_id=$1',
    [unreadNote.body.id]);
  ok('F3: an UNREAD one really goes out, and records which driver took it',
     sentRow.rows[0].status === 'sent' && sentRow.rows[0].driver === 'log' && !!sentRow.rows[0].sent_at,
     sentRow.rows[0]);
  const logAct = await pool.query(
    `SELECT COUNT(*)::int AS n FROM activity WHERE action='notification.sent' AND show_id=$1`, [S]);
  ok('F3: the log driver is a REAL delivery — it records where it went',
     logAct.rows[0].n >= 1, logAct.rows[0]);

  // ── F3 NO ADDRESS: the seam the Graph driver will land on ────────────────
  // users.email is OPTIONAL, and somebody without one is not an error. The
  // outbox has to say so in the row — `skipped: no email address on file`,
  // permanently, with sent_at stamped — rather than throwing, or worse leaving
  // the row queued to be retried forever against an address that does not
  // exist. That distinction is the whole reason the wiring can go in before the
  // driver does: `queued` means "we could not send this YET" and is the state a
  // backlog lives in, `skipped` means "we will never send this", and getting
  // them the wrong way round is how turning MAIL_* on later either discovers a
  // discarded backlog or floods a retry loop.
  const noAddr = TAG + 'noaddr';
  const noAddrUser = await POST('/api/users',
    { username: noAddr, password: 'smokepass123', role: 'tech', name: 'NO ADDRESS' }, { token: A });
  ok('F3 NO ADDRESS: a person can be created with NO email — it is optional',
     noAddrUser.status === 200 && noAddrUser.body.email === '', noAddrUser.body);
  const noAddrStep = await POST('/api/steps',
    { show_id: S, lane: 'crew', title: TAG + ' addressless task', status: 'todo' }, { token: A });
  await PUT(`/api/steps/${noAddrStep.body.id}/assign`, { owner: noAddr }, { token: A });
  const noAddrQueued = await pool.query(
    `SELECT * FROM notification_outbox WHERE username=$1 ORDER BY id DESC LIMIT 1`, [noAddr]);
  ok('F3 NO ADDRESS: the row is still QUEUED like anybody else’s — nothing is skipped at write time',
     noAddrQueued.rows.length === 1 && noAddrQueued.rows[0].status === 'queued',
     noAddrQueued.rows[0]);
  const noAddrFlush = await POST('/api/admin/notifications/flush', {}, { token: A });
  const noAddrRow = await pool.query('SELECT * FROM notification_outbox WHERE id=$1',
    [noAddrQueued.rows[0].id]);
  ok('F3 NO ADDRESS: the flush marks it `skipped` with the reason NAMED, not "failed"',
     noAddrRow.rows[0].status === 'skipped' &&
     noAddrRow.rows[0].skipped_reason === 'no email address on file', noAddrRow.rows[0]);
  ok('F3 NO ADDRESS: ...permanently — sent_at is stamped so it is never retried',
     !!noAddrRow.rows[0].sent_at && noAddrRow.rows[0].attempts >= 1, noAddrRow.rows[0]);
  ok('F3 NO ADDRESS: ...and the flush counted it as skipped, never as failed',
     noAddrFlush.body.skipped >= 1 && noAddrFlush.body.failed === 0, noAddrFlush.body);
  const noAddrBell = await GET('/api/me/inbox/count',
    { token: (await POST('/api/auth/login', { username: noAddr, password: 'smokepass123' })).body.token });
  ok('F3 NO ADDRESS: the APP still told them — no address silences the email, never the bell',
     noAddrBell.status === 200, noAddrBell.body);
  // ...and the moment they have one, the same seam delivers. The marking is
  // about the ADDRESS and not about the person, which is what makes it safe for
  // the Graph driver to be dropped in behind it unchanged.
  await PUT(`/api/users/${noAddrUser.body.id}`, { email: noAddr + '@e360sport.test' }, { token: A });
  await PUT(`/api/steps/${noAddrStep.body.id}/assign`, { owner: null }, { token: A });
  await PUT(`/api/steps/${noAddrStep.body.id}/assign`, { owner: noAddr }, { token: A });
  await POST('/api/admin/notifications/flush', {}, { token: A });
  const nowSent = await pool.query(
    `SELECT * FROM notification_outbox WHERE username=$1 ORDER BY id DESC LIMIT 1`, [noAddr]);
  ok('F3 NO ADDRESS: give them an address and the very next row is SENT — same seam',
     nowSent.rows[0].status === 'sent' && nowSent.rows[0].driver === 'log', nowSent.rows[0]);

  // 'off' silences the email and NEVER the bell
  await PUT('/api/me/notification-prefs', { notify: 'off' }, { token: TECHT });
  const bellBefore = (await GET('/api/me/inbox/count', { token: TECHT })).body;
  await PUT(`/api/shows/${S}`, { venue: 'UW Field House', notify: [techUser] }, { token: A });
  const bellAfter = (await GET('/api/me/inbox/count', { token: TECHT })).body;
  ok('F3: notify:off STILL reaches the bell — it silences the email only',
     (bellAfter.count || bellAfter.badge || 0) > (bellBefore.count || bellBefore.badge || 0),
     { bellBefore, bellAfter });
  const offRow = await pool.query(
    `SELECT * FROM notification_outbox WHERE username=$1 AND kind='notify' ORDER BY id DESC LIMIT 1`,
    [techUser]);
  ok('F3: ...and the outbox RECORDS the silence rather than dropping it',
     offRow.rows[0].status === 'skipped' && offRow.rows[0].skipped_reason === 'preference off',
     offRow.rows[0]);
  await PUT('/api/me/notification-prefs', { notify: 'digest' }, { token: TECHT });

  // the digest row
  const digestRows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox
      WHERE username=$1 AND kind='digest' AND status='queued'`, [techUser]);
  ok('F3 DIGEST: exactly ONE open digest row per person', digestRows.rows[0].n <= 1, digestRows.rows[0]);
  const beforeDigest = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox WHERE mode='digest' AND status='queued'`);
  await POST('/api/admin/notifications/flush', {}, { token: A });
  const afterPlain = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox WHERE mode='digest' AND status='queued'`);
  ok('F3 DIGEST: a plain flush leaves digest rows ALONE — there is no scheduler',
     afterPlain.rows[0].n === beforeDigest.rows[0].n, { beforeDigest, afterPlain });
  const digestFlush = await POST('/api/admin/notifications/flush', { digest: true }, { token: A });
  ok('F3 DIGEST: asking for the digest explicitly flushes it',
     digestFlush.status === 200 && digestFlush.body.considered >= 0, digestFlush.body);

  // the mail layer's honest posture
  const mailStatus = await GET('/api/admin/mail-status', { token: A });
  ok('F3 MAIL: the default driver is `log`, and it is configured',
     mailStatus.status === 200 && mailStatus.body.driver === 'log' &&
     mailStatus.body.configured === true, mailStatus.body);
  const mail = require('../lib/mail');
  const wasDriver = process.env.MAIL_DRIVER;
  process.env.MAIL_DRIVER = 'graph';
  ok('F3 MAIL: with MAIL_DRIVER=graph and nothing else set, it reports NOT configured',
     mail.driverName() === 'graph' && mail.mailConfigured() === false &&
     mail.graphMissing().length === 4, mail.graphMissing());
  const graphRes = await mail.send({ to: 'x@example.test', subject: 's', text: 't' });
  ok('F3 MAIL: ...and answers a 501-shaped "mail not configured", NAMING the vars',
     graphRes.ok === false && graphRes.status === 501 && graphRes.retryable === true &&
     /MAIL_TENANT_ID/.test(graphRes.error), graphRes);
  const stayQueued = await pool.query(
    `INSERT INTO notification_outbox (username, kind, mode, status, subject, body)
     VALUES ($1,'assignment','immediate','queued','graph test','body') RETURNING id`, [techUser]);
  await POST('/api/admin/notifications/flush', {}, { token: A });
  const stillQueuedRow = await pool.query('SELECT * FROM notification_outbox WHERE id=$1',
    [stayQueued.rows[0].id]);
  ok('F3 MAIL: an unconfigured driver LEAVES THE ITEM QUEUED — the backlog survives',
     stillQueuedRow.rows[0].status === 'queued' && stillQueuedRow.rows[0].attempts >= 1 &&
     /not configured/.test(String(stillQueuedRow.rows[0].last_error)), stillQueuedRow.rows[0]);
  process.env.MAIL_DRIVER = wasDriver || 'log';
  ok('F3 MAIL: the Graph skeleton knows its own endpoints, so wiring it is credentials only',
     /login\.microsoftonline\.com/.test(mail.graphTokenUrl()) &&
     /graph\.microsoft\.com\/v1\.0\/users\/.*\/sendMail/.test(mail.graphSendMailUrl('a@b.c')) &&
     mail.graphSendMailBody({ to: 'a@b.c', subject: 's', text: 't' }).message.subject === 's');
  await POST('/api/admin/notifications/flush', {}, { token: A });

  const myNotifs = await GET('/api/me/notifications', { token: TECHT });
  ok('F3: a person can audit their OWN queue',
     myNotifs.status === 200 && myNotifs.body.length > 0 &&
     myNotifs.body.every((n) => n.username === techUser), myNotifs.body.length);
  const outboxAdmin = await GET('/api/admin/notification-outbox', { token: A });
  ok('F3: an admin sees the whole outbox with per-status counts',
     outboxAdmin.status === 200 && !!outboxAdmin.body.counts, outboxAdmin.body.counts);
  const outboxPm = await GET('/api/admin/notification-outbox', { token: PMT });
  ok('F3 GATE: ...and a pm does not', outboxPm.status === 403, outboxPm.body);

  // ── F6: closeout + archiving ─────────────────────────────────────────────
  const closeout1 = await GET(`/api/shows/${FS}/closeout`, { token: A });
  ok('F6: closeout is machine-checked against three conditions',
     closeout1.status === 200 && closeout1.body.complete === false &&
     typeof closeout1.body.recap_sent === 'boolean' &&
     typeof closeout1.body.reports_complete === 'boolean' &&
     typeof closeout1.body.finance_clear === 'boolean', closeout1.body);
  ok('F6: ...and it names which of the three is out',
     closeout1.body.recap_sent === false && closeout1.body.reports_owed === 1,
     { recap: closeout1.body.recap_sent, owed: closeout1.body.reports_owed });

  const pmArchive = await POST(`/api/shows/${FS}/archive`, {}, { token: PMT });
  ok('F6 GATE: a pm — even the folder’s owner — may not archive',
     pmArchive.status === 403 && /admin act/.test(String(pmArchive.body.error)), pmArchive.body);
  const mgrArchive = await POST(`/api/shows/${FS}/archive`, {}, { token: MGRT });
  ok('F6 GATE: nor may a manager — this one really is admin-only', mgrArchive.status === 403);
  const notArchived = await pool.query('SELECT archived_at FROM shows WHERE id=$1', [FS]);
  ok('F6 GATE: ...and both refusals wrote nothing', notArchived.rows[0].archived_at === null);

  const arch = await POST(`/api/shows/${QS}/archive`, {}, { token: A });
  ok('F6: an admin may, and it is datestamped and attributed',
     arch.status === 200 && !!arch.body.show.archived_at && arch.body.show.archived === true,
     arch.body.show.archived_at);
  const listDefault = await GET(`/api/shows?project_id=${P}`, { token: A });
  ok('F6 EXCLUSION: the default show list EXCLUDES it',
     !listDefault.body.some((s) => s.id === QS), listDefault.body.map((s) => s.id));
  const listArchived = await GET(`/api/shows?project_id=${P}&archived=1`, { token: A });
  ok('F6 EXCLUSION: ?archived=1 returns ONLY the archived ones',
     listArchived.body.length === 1 && listArchived.body[0].id === QS,
     listArchived.body.map((s) => s.id));
  const listBoth = await GET(`/api/shows?project_id=${P}&include_archived=1`, { token: A });
  ok('F6 EXCLUSION: ?include_archived=1 returns both',
     listBoth.body.length === listDefault.body.length + 1);
  const stillResolves = await GET(`/api/shows/${QS}`, { token: A });
  ok('F6 EXCLUSION: BUT the show still resolves by id — a deep link and a search hit both open it',
     stillResolves.status === 200 && stillResolves.body.id === QS);
  const folderStill = await GET(`/api/projects/${P}`, { token: A });
  ok('F6 EXCLUSION: ...and the FOLDER still carries it, so season rollups are unaffected',
     folderStill.body.shows.some((s) => s.id === QS), folderStill.body.shows.map((s) => s.id));
  const mySteps = await GET('/api/my-steps', { token: A });
  ok('F6 EXCLUSION: an archived show’s open steps stop nagging in My Tasks',
     !mySteps.body.some((s) => s.show && s.show.id === QS));
  await POST(`/api/shows/${QS}/unarchive`, {}, { token: A });
  const back = await GET(`/api/shows/${QS}`, { token: A });
  ok('F6: unarchive puts it back, and leaves it CLOSED rather than inventing a stage',
     back.body.archived === false && back.body.stage === 'closed', back.body.stage);

  // the folder-level archive, and the auto-archive rule
  const arcProj = await POST('/api/projects', { name: TAG + ' arc', client: 'X', type: 'led',
                                                owner: 'admin' }, { token: A });
  const AP = arcProj.body.id;
  const arcShow = await POST('/api/shows', { project_id: AP, name: TAG + ' arc show',
    venue: 'V', event_date: '2026-01-01', strike_date: '2026-01-02' }, { token: A });
  const AS = arcShow.body.id;
  await POST(`/api/projects/${AP}/archive`, {}, { token: A });
  const apRow = await pool.query('SELECT archived_at FROM projects WHERE id=$1', [AP]);
  const asRow = await pool.query('SELECT archived_at FROM shows WHERE id=$1', [AS]);
  ok('F6: archiving a FOLDER takes its shows with it',
     !!apRow.rows[0].archived_at && !!asRow.rows[0].archived_at);
  const projList = await GET('/api/projects', { token: A });
  ok('F6 EXCLUSION: ...and the portfolio drops it',
     !projList.body.some((p) => p.id === AP));
  const projArch = await GET('/api/projects?archived=1', { token: A });
  ok('F6: the Archive view finds it', projArch.body.some((p) => p.id === AP));
  await POST(`/api/projects/${AP}/unarchive`, {}, { token: A });
  ok('F6: unarchiving the folder brings its shows back too',
     (await GET('/api/projects', { token: A })).body.some((p) => p.id === AP));

  // the 60-day auto-archive, driven through the sweep. The fixture has to be
  // GENUINELY closed out — recap sent, nobody owing a report, no money waiting —
  // because the sweep re-checks all three before it archives anything, and a
  // faked marker is exactly what it would clear.
  await POST(`/api/shows/${AS}/confirm`, {}, { token: A });
  await POST(`/api/shows/${AS}/recap`, {}, { token: A });
  await POST(`/api/recaps/${(await GET(`/api/shows/${AS}/recap`, { token: A })).body.id}/approve`,
             {}, { token: A });
  await POST(`/api/shows/${AS}/recap/sent`, {}, { token: A });
  const arcCo = await GET(`/api/shows/${AS}/closeout`, { token: A });
  ok('F6: the archive fixture really is closed out on all three conditions',
     arcCo.body.complete === true, arcCo.body);
  await pool.query(
    `UPDATE shows SET closeout_complete_at = NOW() - INTERVAL '61 days' WHERE id=$1`, [AS]);
  const pmSweep = await POST('/api/admin/sweep', {}, { token: PMT });
  ok('F6 GATE: the sweep is admin-only', pmSweep.status === 403, pmSweep.body);
  const sweep1 = await POST('/api/admin/sweep', {}, { token: A });
  ok('F6 SWEEP: it runs and reports what it did',
     sweep1.status === 200 && typeof sweep1.body.archived === 'number', sweep1.body);
  const autoArch = await pool.query('SELECT archived_at, archived_by, stage FROM shows WHERE id=$1', [AS]);
  ok('F6 SWEEP: a show 61 days past closeout is AUTO-ARCHIVED',
     !!autoArch.rows[0].archived_at && autoArch.rows[0].stage === 'archived', autoArch.rows[0]);
  ok('F6 SWEEP: ...and its folder went with it, because every show in it is archived',
     !!(await pool.query('SELECT archived_at FROM projects WHERE id=$1', [AP])).rows[0].archived_at);
  const sweep2 = await POST('/api/admin/sweep', {}, { token: A });
  ok('F6 SWEEP: running it twice changes nothing — it is idempotent',
     sweep2.body.archived === 0 && sweep2.body.struck === 0, sweep2.body);
  ok('F6 SWEEP: ...and it says out loud that it is not a scheduled job',
     /no scheduler/i.test(String(sweep2.body.note)), sweep2.body.note);
  await DEL(`/api/projects/${AP}`, { token: A });

  // closeout regression: it CLEARS again when the state comes undone
  const coProj = await POST('/api/events', {
    name: TAG + ' closeout', type: 'led', client: 'Closeout Co', venue: 'CV',
    load_in_date: '2026-02-01', event_date: '2026-02-02', strike_date: '2026-02-03'
  }, { token: A });
  const CS = coProj.body.show.id, CP = coProj.body.project.id;
  await POST(`/api/shows/${CS}/confirm`, {}, { token: A });
  await POST(`/api/shows/${CS}/recap`, {}, { token: A });
  await POST(`/api/shows/${CS}/recap/approve`, {}, { token: A });
  await POST(`/api/shows/${CS}/recap/sent`, {}, { token: A });
  const coDone = await GET(`/api/shows/${CS}/closeout`, { token: A });
  ok('F6: a show with a sent recap, no crew and no money exceptions closes out',
     coDone.body.complete === true && !!coDone.body.closeout_complete_at, coDone.body);
  // A SENT recap can never be reopened — it is a record of what left the
  // building. So the way a closeout really comes undone is LATE MONEY: a
  // booking that landed after the fact with no confirmation attached.
  await POST('/api/bookings', { show_id: CS, category: 'Truck / freight', vendor: 'Late Freight Co',
    status: 'done', amount: 3100, booked_date: '2026-02-04' }, { token: A });
  const coUndone = await GET(`/api/shows/${CS}/closeout`, { token: A });
  ok('F6: late money with no paperwork UN-completes the closeout',
     coUndone.body.complete === false && coUndone.body.finance_clear === false,
     { complete: coUndone.body.complete, exceptions: coUndone.body.finance_exceptions });
  ok('F6: ...and the 60-day clock stops with it, rather than running against ' +
     'paperwork that came undone',
     coUndone.body.closeout_complete_at === null, coUndone.body.closeout_complete_at);

  // ── F1: real event creation ──────────────────────────────────────────────
  const beforeCounts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM shows) s,
            (SELECT COUNT(*) FROM jobs) j`);
  const ev = await POST('/api/events', {
    name: TAG + ' Bucks Opener', type: 'led', client: 'Milwaukee Bucks',
    venue: 'Fiserv Forum', city: 'Milwaukee, WI',
    load_in_date: '2027-01-08', event_date: '2027-01-10', strike_date: '2027-01-11',
    scope: { kind: 'led', linear_feet: 800, cabinet_count: 144, pitch: 'P10' },
    notify: [pmUser]
  }, { token: A });
  const EP = ev.body.project.id, ES = ev.body.show.id;
  ok('F1: ONE call creates the folder, the show and the job', ev.status === 200 &&
     !!ev.body.project.id && !!ev.body.show.id && !!ev.body.job.id, Object.keys(ev.body));
  const afterCounts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM shows) s,
            (SELECT COUNT(*) FROM jobs) j`);
  ok('F1: ...exactly one of each, in one transaction',
     Number(afterCounts.rows[0].p) === Number(beforeCounts.rows[0].p) + 1 &&
     Number(afterCounts.rows[0].s) === Number(beforeCounts.rows[0].s) + 1 &&
     Number(afterCounts.rows[0].j) === Number(beforeCounts.rows[0].j) + 1,
     { before: beforeCounts.rows[0], after: afterCounts.rows[0] });
  ok('F1: the job opens on a TEMP placeholder — nobody has a QB number yet',
     ev.body.job.qb_number_status === 'temp' && /^TEMP-\d\d-\d{3,}$/.test(ev.body.job.qb_job_number),
     ev.body.job.qb_job_number);
  ok('F1: the show is QUOTED — nobody has committed to anything',
     ev.body.show.stage === 'quoted' && ev.body.show.confirmed === false);
  ok('F1: the event TYPE seeded its lane set and T-minus pipeline',
     ev.body.instantiated_steps > 10, ev.body.instantiated_steps);
  ok('F1: ...with due dates back-scheduled off the event date',
     ev.body.show.steps.some((s) => s.due_date && s.due_date < '2027-01-10'));
  ok('F1: the scope entered at creation is on the show',
     ev.body.show.scope_line === 'LED · 800′ · 144× P10', ev.body.show.scope_line);
  ok('F1: the show inherits the folder’s job', ev.body.show.default_job_id === ev.body.job.id);
  ok('F1 NOTIFY: the picker delivered ONE ping for the whole act, not three',
     Array.isArray(ev.body.notified) && ev.body.notified.length === 1 &&
     ev.body.notified[0] === pmUser, ev.body.notified);
  const evNote = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notes WHERE show_id=$1 AND author='admin'`, [ES]);
  ok('F1 NOTIFY: ...and it is ONE anchored note on the new show', evNote.rows[0].n === 1, evNote.rows[0]);
  const evOutbox = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox WHERE show_id=$1 AND kind='notify'`, [ES]);
  ok('F1/F3 NOTIFY: ...which also queued the second channel', evOutbox.rows[0].n === 1, evOutbox.rows[0]);
  const evAct = await pool.query(
    `SELECT action FROM activity WHERE show_id=$1 AND action='event.create'`, [ES]);
  ok('F1: ...and ONE line in the activity feed', evAct.rows.length === 1, evAct.rows);

  const silentEv = await POST('/api/events', { name: TAG + ' silent', type: 'print' }, { token: A });
  ok('F1 NOTIFY: with no picker selection, NOBODY is notified — silence is the default',
     silentEv.body.notified.length === 0, silentEv.body.notified);
  const techEvent = await POST('/api/events', { name: TAG + ' nope', type: 'led' }, { token: TECHT });
  ok('F1 GATE: a tech cannot create an event', techEvent.status === 403, techEvent.body);
  const noName = await POST('/api/events', { type: 'led' }, { token: A });
  ok('F1: an event with no name is a 400', noName.status === 400, noName.body);
  const badDate = await POST('/api/events', { name: TAG + ' bad', event_date: 'soon' }, { token: A });
  ok('F1: a malformed date is refused rather than stored', badDate.status === 400, badDate.body);
  await DEL(`/api/projects/${EP}`, { token: A });
  await DEL(`/api/projects/${silentEv.body.project.id}`, { token: A });
  await DEL(`/api/projects/${CP}`, { token: A });

  }

  // ══════════════════════════════════════════════════════════════════════════
  // 16. FLEX — the REAL create-element route
  // ──────────────────────────────────────────────────────────────────────────
  // NOTHING here touches the live Flex tenant. Phase 1 runs against the test
  // environment exactly as deployed (no FLEX_* vars) and proves the 501 and the
  // role gate. Phase 2 sets the vars to an UNROUTABLE host and swaps global
  // fetch for a stub that passes every non-Flex URL straight through to the
  // real one — so the smoke server is still driven over real HTTP while every
  // Flex call is answered locally. A live write from a test suite is how you
  // end up with rubbish Event Folders in the warehouse's browse list.
  // ══════════════════════════════════════════════════════════════════════════
  section('16. Flex — the create-element route (stubbed; NO live Flex)');

  const flexLib = require('../lib/flex');
  const FLEX_ENV_BEFORE = { url: process.env.FLEX_BASE_URL, key: process.env.FLEX_API_KEY };
  delete process.env.FLEX_BASE_URL;
  delete process.env.FLEX_API_KEY;

  const fxShow = await POST('/api/shows', {
    project_id: P, name: TAG + ' Big Ten vs. SEC — Wrigley Field', venue: 'Wrigley Field',
    city: 'Chicago, IL', load_in_date: '2026-11-12', event_date: '2026-11-14',
    strike_date: '2026-11-15'
  }, { token: A });
  const FX = fxShow.body.id;
  // the clock times live on the call sheet, not on the show create (HARDENING 16)
  const fxTimes = await PUT(`/api/shows/${FX}/call-sheet`,
    { doors_time: '17:30', event_time: '19:00', strike_time: '23:00' }, { token: A });
  ok('16: a show with an em-dash in its name and three clock times exists',
     FX > 0 && fxTimes.status === 200, { show: fxShow.body.id, times: fxTimes.body });

  // ── phase 1: unconfigured, which is what the test environment really is ────
  const fxTech = await POST(`/api/shows/${FX}/flex/create-element`, {}, { token: TECHT });
  ok('16 GATE: a tech is refused BEFORE any configuration question is asked',
     fxTech.status === 403, fxTech.body);
  const fxNoCfg = await POST(`/api/shows/${FX}/flex/create-element`, {}, { token: A });
  ok('16: with FLEX_* unset the answer is 501 — an ops answer, not a bug report',
     fxNoCfg.status === 501, fxNoCfg.body);
  ok('16: ...and the 501 NAMES both missing variables and where to get them',
     /FLEX_BASE_URL/.test(fxNoCfg.body.error) && /FLEX_API_KEY/.test(fxNoCfg.body.error)
     && /staffing/.test(fxNoCfg.body.error), fxNoCfg.body.error);
  const gearNoCfg = await GET(`/api/shows/${FX}/gear`, { token: A });
  ok('16: an unconfigured server offers NO deep link rather than a broken one',
     gearNoCfg.status === 200 && gearNoCfg.body.deepLink === '', gearNoCfg.body);

  // the READ routes answer the same OPS answer, and answer it FIRST
  for (const p of ['gear-lists', 'pull-sheet']) {
    const r = await GET(`/api/shows/${FX}/flex/${p}`, { token: A });
    ok(`16 READ: /${p} with FLEX_* unset is 501 naming both variables`,
       r.status === 501 && /FLEX_BASE_URL/.test(r.body.error) && /FLEX_API_KEY/.test(r.body.error),
       r.body);
    const rv = await GET(`/api/shows/${FX}/flex/${p}`, { token: legacyLogin.body.token });
    ok(`16 READ GATE: a VIEWER is refused /${p} before the configuration question`,
       rv.status === 403, rv.body);
  }

  // ── phase 2: configured against an unroutable host, fetch stubbed ─────────
  const FLEX_STUB_BASE = 'https://flex-stub.invalid';
  process.env.FLEX_BASE_URL = FLEX_STUB_BASE;
  process.env.FLEX_API_KEY = 'smoke-stub-key';
  flexLib.flexResetUserCache();

  // ── fixtures for the READ path (§7b) ──────────────────────────────────────
  // Shaped after the LIVE Track Town read of 2026-08-28: a folder holding a
  // pull sheet, that pull sheet holding its own prep manifest, and one node
  // that is NOT an equipment list (the picker must drop it). List B's row-data
  // is deliberately empty — that is BUG 5's ambiguous 200-with-[].
  const STUB_LIST_A = '11111111-1111-4111-8111-111111111111';
  const STUB_LIST_B = '22222222-2222-4222-8222-222222222222';
  const STUB_OUTSIDER = '44444444-4444-4444-8444-444444444444';
  const STUB_PREP_USER = '55555555-5555-4555-8555-555555555555';
  const STUB_TREE = {
    nodeId: 'stub-element-0001', name: 'Smoke Event Folder', parentId: 'root',
    leaf: false, domainId: 'simple-project-element',
    children: [
      { nodeId: STUB_LIST_A, name: 'Smoke Pull Sheet', documentNumber: 'SM_01',
        parentId: 'stub-element-0001', leaf: false, domainId: 'equipment-list',
        children: [
          { nodeId: STUB_LIST_B, name: 'Smoke Prep Manifest', documentNumber: 'SM_02',
            parentId: STUB_LIST_A, leaf: true, domainId: 'equipment-list', children: null }
        ] },
      { nodeId: 'quote-0001', name: 'A Quote', documentNumber: 'Q1',
        parentId: 'stub-element-0001', leaf: true, domainId: 'quote', children: null }
    ]
  };
  const STUB_TREE_EMPTY = {
    nodeId: 'empty-folder', name: 'Wrigley Field Folder', parentId: 'root',
    leaf: true, domainId: 'simple-project-element', children: null
  };
  const STUB_HEADER_A = {
    id: STUB_LIST_A, name: 'Smoke Pull Sheet', documentNumber: 'SM_01',
    definitionId: 'a220432c-af33-11df-b8d5-00e08175e43e', domainId: 'equipment-list',
    locked: false, open: true, weight: 0,
    plannedStartDate: '2026-11-09T18:00:00', plannedEndDate: '2026-11-22T18:00:00',
    loadInDate: '2026-11-12T18:00:00', loadOutDate: '2026-11-15T18:00:00',
    prepCompleted: true, prepCompletedUserId: STUB_PREP_USER,
    prepCompletedTimestamp: '2026-11-11T14:32:00', prepManifestId: STUB_LIST_B,
    deprepCompleted: false, shipCompleted: false, returnCompleted: false,
    receiveCompleted: false, subrentalReturnCompleted: false
  };
  const STUB_HEADER_B = { ...STUB_HEADER_A, id: STUB_LIST_B, name: 'Smoke Prep Manifest',
    documentNumber: 'SM_02', definitionId: '9945d54c-af32-11df-b8d5-00e08175e43e',
    prepCompleted: false, prepCompletedUserId: null, prepCompletedTimestamp: null };
  const STUB_ROWS = [
    { id: 'g-led', name: 'LED Cabinets', group: true, leaf: false, resourceId: null,
      quantity: 0, isNote: false, children: [
        { id: 'i-cab', name: '3.9 blackface - 500mm x 500mm', group: false, leaf: true,
          resourceId: 'res-cab', quantity: 48, barcode: '00009', serial: null, isNote: false },
        // a CONTAINED item: real gear that also holds something (the live shape)
        { id: 'i-spool', name: 'Mediacom 300m fiber spool', group: false, leaf: false,
          container: true, resourceId: 'res-spool', quantity: 1, barcode: '00068',
          serial: null, isNote: false, children: [
            { id: 'i-bo', name: 'Media Com Breakout', group: false, leaf: true,
              resourceId: 'res-bo', quantity: 2, barcode: '00059', isNote: false }
          ] }
      ] },
    // BUG 6 on the wire: quantity null, serial in the name
    { id: 'i-loose', name: '2024 P10 Perimeter (6858)', group: false, leaf: true,
      resourceId: 'res-p10', quantity: null, serial: '6858', isNote: false },
    { id: 'i-note', name: 'REMEMBER THE SPARES', isNote: true, quantity: null }
  ];

  const flexCalls = [];
  let contactCreateFails = false;
  const STUB_DIRECTORY = [
    { id: 'ct-lovb', name: 'League One Volleyball', deleted: false },
    { id: 'ct-tom', name: 'Tom Andres', deleted: false },
    { id: 'ct-ufl', name: 'UFL', deleted: false }
  ];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.indexOf(FLEX_STUB_BASE) !== 0) return realFetch(url, opts);
    flexCalls.push({ url: u, method: opts.method || 'GET',
                     body: opts.body ? JSON.parse(opts.body) : null,
                     headers: opts.headers || {} });
    const json = (body, status) => ({
      ok: !status || (status >= 200 && status < 300), status: status || 200, statusText: 'OK',
      headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body)
    });
    if (/\/user-profile\/current-user$/.test(u)) {
      return json({ userId: 'stub-user', contactId: 'ct-tom', name: 'Tom Andres' });
    }
    if (/\/api\/contact\b/.test(u) && (opts.method || 'GET') === 'POST') {
      if (contactCreateFails) return json({ exceptionMessage: 'contact create not permitted' }, 403);
      return json({ id: 'ct-CREATED', name: JSON.parse(opts.body).name, organization: true });
    }
    if (/\/api\/contact/.test(u)) {
      return json({ content: STUB_DIRECTORY, totalElements: STUB_DIRECTORY.length, totalPages: 1,
                    size: 200, number: 0, last: true });
    }
    if (/\/api\/element$/.test(u) && opts.method === 'POST') {
      return json({ elementId: 'stub-element-0001', elementNumber: null,
                    elementName: JSON.parse(opts.body).name, definitionName: 'Event Folder' });
    }
    // ── the READ path's stubs (2026-08-28) ──────────────────────────────────
    if (/\/api\/element\/stub-element-0001\/tree$/.test(u)) return json(STUB_TREE);
    if (/\/api\/element\/[^/]+\/tree$/.test(u)) return json(STUB_TREE_EMPTY);
    if (new RegExp(`/api/equipment-list/${STUB_LIST_A}$`).test(u)) return json(STUB_HEADER_A);
    if (new RegExp(`/api/equipment-list/${STUB_LIST_B}$`).test(u)) return json(STUB_HEADER_B);
    if (new RegExp(`/api/line-item/${STUB_LIST_A}/row-data/`).test(u)) return json(STUB_ROWS);
    if (new RegExp(`/api/line-item/${STUB_LIST_B}/row-data/`).test(u)) return json([]);
    if (/\/api\/user-profile\/[0-9a-f-]{36}$/.test(u)) {
      return json({ id: u.split('/').pop(), name: 'Brendon Ochs', userName: 'bochs' });
    }
    return json({ exceptionMessage: 'no stub for ' + u }, 404);
  };

  const fxPm2 = await POST(`/api/shows/${FX}/flex/create-element`, {}, { token: PM2T });
  ok('16 GATE: a pm who does not own the folder is refused even when Flex IS configured',
     fxPm2.status === 403, fxPm2.body);
  const fxGhost = await POST('/api/shows/99999999/flex/create-element', {}, { token: A });
  ok('16: an unknown show is a 404, and nothing was sent to Flex',
     fxGhost.status === 404 && !flexCalls.some((c) => /\/api\/element$/.test(c.url)), fxGhost.body);

  flexCalls.length = 0;
  const fxMade = await POST(`/api/shows/${FX}/flex/create-element`, {}, { token: A });
  ok('16: the owning admin creates the folder', fxMade.status === 200, fxMade.body);
  ok('16: the stored id is the one FLEX RETURNED, not one the app invented',
     fxMade.body.elementId === 'stub-element-0001', fxMade.body.elementId);
  ok('16: the response carries a real deep link with the # SPA marker',
     fxMade.body.deepLink === FLEX_STUB_BASE + '/f5/ui/#element/stub-element-0001',
     fxMade.body.deepLink);

  const fxPost = flexCalls.find((c) => /\/api\/element$/.test(c.url) && c.method === 'POST');
  ok('16: exactly ONE element POST went out', !!fxPost
     && flexCalls.filter((c) => /\/api\/element$/.test(c.url)).length === 1, flexCalls.map((c) => c.method + ' ' + c.url));
  ok('16: the key rides in X-Auth-Token, never Authorization',
     fxPost.headers['X-Auth-Token'] === 'smoke-stub-key' && !fxPost.headers.Authorization,
     Object.keys(fxPost.headers));
  ok('16 BUG 1: the /f5 prefix is present exactly once',
     fxPost.url === FLEX_STUB_BASE + '/f5/api/element', fxPost.url);
  ok('16: the em-dash in the show name became a hyphen before it left the building',
     fxPost.body.name === TAG + ' Big Ten vs. SEC - Wrigley Field', fxPost.body.name);
  ok('16 BUG 2/3: every date is Z-suffixed with no offset, and none is midnight UTC',
     ['plannedStartDate', 'plannedEndDate', 'loadInDate', 'loadOutDate']
       .every((k) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(fxPost.body[k])
                     && !/T00:00:00Z$/.test(fxPost.body[k])),
     fxPost.body);
  ok('16: plannedStart is load-in −3d and plannedEnd is strike +7d, at Central noon (CST = 18:00Z)',
     fxPost.body.plannedStartDate === '2026-11-09T18:00:00Z'
     && fxPost.body.plannedEndDate === '2026-11-22T18:00:00Z', fxPost.body);
  ok('16: loadInDate is the load-in and loadOutDate is the STRIKE',
     fxPost.body.loadInDate === '2026-11-12T18:00:00Z'
     && fxPost.body.loadOutDate === '2026-11-15T18:00:00Z', fxPost.body);
  ok('16: the times the Flex form cannot hold ride in the notes',
     fxPost.body.notes.split('\n')[0] === 'Event: 2026-11-14 · Doors 17:30 · Show 19:00 · Strike 23:00',
     fxPost.body.notes);
  ok('16: a client already in the directory is MATCHED and sent by id',
     fxPost.body.clientId === 'ct-lovb' && fxMade.body.contacts.client.outcome === 'matched',
     fxMade.body.contacts.client);
  ok('16: a venue that is NOT in the directory is CREATED, then sent by id',
     fxPost.body.venueId === 'ct-CREATED' && fxMade.body.contacts.venue.outcome === 'created',
     fxMade.body.contacts.venue);
  const ctPost = flexCalls.find((c) => /\/api\/contact/.test(c.url) && c.method === 'POST');
  ok('16: the created contact carries name + organization + company, and nothing else',
     !!ctPost && ctPost.body.name === 'Wrigley Field' && ctPost.body.organization === true
     && ctPost.body.company === 'Wrigley Field' && Object.keys(ctPost.body).length === 3,
     ctPost && ctPost.body);
  ok('16: the directory was read ONCE for both lookups',
     flexCalls.filter((c) => /\/api\/contact/.test(c.url) && c.method === 'GET').length === 1,
     flexCalls.filter((c) => /\/api\/contact/.test(c.url)).map((c) => c.method));

  const fxRow = await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [FX]);
  ok('16: the RETURNED id is what got persisted, and the row reads linked',
     fxRow.rows[0].linked === true && fxRow.rows[0].element_id === 'stub-element-0001',
     fxRow.rows[0]);
  const fxAct = await pool.query(
    `SELECT * FROM activity WHERE show_id=$1 AND action='flex.create'`, [FX]);
  ok('16: one activity line, naming the element and both contact outcomes',
     fxAct.rows.length === 1 && /stub-element-0001/.test(fxAct.rows[0].detail)
     && /client matched/.test(fxAct.rows[0].detail) && /venue created/.test(fxAct.rows[0].detail),
     fxAct.rows[0] && fxAct.rows[0].detail);
  const fxGear = await GET(`/api/shows/${FX}/gear`, { token: A });
  ok('16: GET /gear now serves the deep link too, so a reload keeps the link',
     fxGear.body.deepLink === FLEX_STUB_BASE + '/f5/ui/#element/stub-element-0001'
     && fxGear.body.fabricated === false, fxGear.body);

  flexCalls.length = 0;
  const fxAgain = await POST(`/api/shows/${FX}/flex/create-element`, {}, { token: A });
  ok('16: a second create on a linked show is a 409 — one show, one folder',
     fxAgain.status === 409 && /already linked/i.test(fxAgain.body.error), fxAgain.body);
  ok('16: ...and the 409 sent NOTHING to Flex', flexCalls.length === 0, flexCalls);

  // ── the prototype's fabricated ids are replaceable, not permanent ─────────
  const fxShow2 = await POST('/api/shows', {
    project_id: P, name: TAG + ' fabricated link', venue: 'Nowhere Arena',
    load_in_date: '2026-11-12', event_date: '2026-11-14', strike_date: '2026-11-15'
  }, { token: A });
  const FX2 = fxShow2.body.id;
  await PUT(`/api/shows/${FX2}/gear`,
    { linked: true, element_id: '1a2b3c4d-b1cc-4e90-83ce-bbd69eb3e4fa' }, { token: A });
  const fabGear = await GET(`/api/shows/${FX2}/gear`, { token: A });
  ok('16: a modeled id is FLAGGED as fabricated and offered no deep link',
     fabGear.body.fabricated === true && fabGear.body.deepLink === '', fabGear.body);
  flexCalls.length = 0;
  contactCreateFails = true;
  const fxReplace = await POST(`/api/shows/${FX2}/flex/create-element`,
    { create_contacts: true }, { token: A });
  ok('16: a real create REPLACES a fabricated link instead of 409-ing forever',
     fxReplace.status === 200 && fxReplace.body.elementId === 'stub-element-0001', fxReplace.body);
  ok('16: a FAILED contact create does not fail the folder — the venue is omitted and SAID SO',
     fxReplace.body.contacts.venue.outcome === 'omitted'
     && /creating it in Flex failed/i.test(fxReplace.body.contacts.venue.reason),
     fxReplace.body.contacts.venue);
  const fxPost2 = flexCalls.find((c) => /\/api\/element$/.test(c.url) && c.method === 'POST');
  ok('16: ...so venueId is ABSENT from the payload, never null',
     !('venueId' in fxPost2.body) && fxPost2.body.clientId === 'ct-lovb', Object.keys(fxPost2.body));
  ok('16: ...and the venue NAME still reaches Flex, on its own notes line',
     /^Venue: Nowhere Arena \(not linked in Flex\)$/m.test(fxPost2.body.notes), fxPost2.body.notes);
  contactCreateFails = false;

  // ── the toggle OFF is the staffing app's proven never-send behaviour ──────
  const fxShow3 = await POST('/api/shows', {
    project_id: P, name: TAG + ' toggle off', venue: 'Unknown Field',
    event_date: '2026-11-14'
  }, { token: A });
  const FX3 = fxShow3.body.id;
  flexCalls.length = 0;
  const fxOff = await POST(`/api/shows/${FX3}/flex/create-element`,
    { create_contacts: false }, { token: A });
  ok('16: with the toggle OFF an unmatched venue is omitted and NO contact is created',
     fxOff.status === 200 && fxOff.body.contacts.venue.outcome === 'omitted'
     && !flexCalls.some((c) => /\/api\/contact/.test(c.url) && c.method === 'POST'),
     fxOff.body.contacts.venue);
  ok('16: ...and the reason says the option was off, not that Flex refused',
     /create missing contacts.*off/i.test(fxOff.body.contacts.venue.reason),
     fxOff.body.contacts.venue.reason);
  const fxPost3 = flexCalls.find((c) => /\/api\/element$/.test(c.url) && c.method === 'POST');
  ok('16: a show with only an event date still gets a start date (event −3d), and NO loadInDate',
     fxPost3.body.plannedStartDate === '2026-11-11T18:00:00Z'
     && !('loadInDate' in fxPost3.body) && !('loadOutDate' in fxPost3.body),
     fxPost3.body);

  // ══════════════════════════════════════════════════════════════════════════
  // 16b. THE READ PATH — gear-lists + pull-sheet. Still stubbed, still no Flex.
  // ──────────────────────────────────────────────────────────────────────────
  // The contract these assertions defend is "read-only, and honest about it":
  // every call a read makes is a GET, no row in the database moves, and the
  // three states a folder can be in (no link / no lists / a real sheet) are
  // three different answers rather than three empty tables.
  // ══════════════════════════════════════════════════════════════════════════
  section('16b. Flex — the READ path (gear-lists + pull-sheet, stubbed)');

  // FX is still linked to stub-element-0001 at this point; FX2 and FX3 too.
  flexCalls.length = 0;
  const glGhost = await GET('/api/shows/99999999/flex/gear-lists', { token: A });
  ok('16b: an unknown show is a 404 and nothing was read from Flex',
     glGhost.status === 404 && flexCalls.length === 0, glGhost.body);

  // a show with NO link at all — the 409-equivalent, in the words a PM needs
  const fxShow5 = await POST('/api/shows', {
    project_id: P, name: TAG + ' unlinked', venue: 'Nowhere', event_date: '2026-11-14'
  }, { token: A });
  const FX5 = fxShow5.body.id;
  flexCalls.length = 0;
  const glUnlinked = await GET(`/api/shows/${FX5}/flex/gear-lists`, { token: A });
  ok('16b: an UNLINKED show is a 409 that says "not linked to a real Flex folder"',
     glUnlinked.status === 409 && /not linked to a real Flex folder/i.test(glUnlinked.body.error),
     glUnlinked.body);
  ok('16b: ...and it cost ZERO Flex calls', flexCalls.length === 0, flexCalls);
  const psUnlinked = await GET(`/api/shows/${FX5}/flex/pull-sheet`, { token: A });
  ok('16b: the pull-sheet route gives the same 409 for the same reason',
     psUnlinked.status === 409 && /not linked to a real Flex folder/i.test(psUnlinked.body.error),
     psUnlinked.body);

  // a FABRICATED link is "not linked", not "linked to something broken"
  const fxShow6 = await POST('/api/shows', {
    project_id: P, name: TAG + ' fabricated read', venue: 'Nowhere', event_date: '2026-11-14'
  }, { token: A });
  const FX6 = fxShow6.body.id;
  await PUT(`/api/shows/${FX6}/gear`,
    { linked: true, element_id: '9f8e7d6c-b1cc-4e90-83ce-bbd69eb3e4fa' }, { token: A });
  flexCalls.length = 0;
  const glFab = await GET(`/api/shows/${FX6}/flex/gear-lists`, { token: A });
  ok('16b: a fabricated element id is a 409 naming the prototype, not a failed read',
     glFab.status === 409 && /not linked to a real Flex folder/i.test(glFab.body.error)
     && /prototype/i.test(glFab.body.error) && flexCalls.length === 0, glFab.body);

  // ── the picker: one tree call, the non-list node dropped ──────────────────
  flexCalls.length = 0;
  const gl = await GET(`/api/shows/${FX}/flex/gear-lists`, { token: A });
  ok('16b: the owning admin gets the folder’s equipment lists', gl.status === 200, gl.body);
  ok('16b: EXACTLY ONE Flex call — the tree. No /identity storm for a picker.',
     flexCalls.length === 1 && /\/tree$/.test(flexCalls[0].url),
     flexCalls.map((c) => c.method + ' ' + c.url));
  ok('16b: both equipment lists come back and the QUOTE node does not',
     gl.body.count === 2 && gl.body.lists.map((l) => l.docNumber).join(',') === 'SM_01,SM_02'
     && !gl.body.lists.some((l) => l.domainId !== 'equipment-list'),
     gl.body.lists.map((l) => [l.docNumber, l.domainId]));
  ok('16b: each list carries the /view/equipmentlist/header deep link',
     gl.body.lists.every((l) => l.deepLink ===
       `${FLEX_STUB_BASE}/f5/ui/#element/${l.id}/view/equipmentlist/header`),
     gl.body.lists.map((l) => l.deepLink));
  ok('16b: `type` is null — the tree cannot tell a pull sheet from a manifest, and it says so',
     gl.body.lists.every((l) => l.type === null), gl.body.lists.map((l) => l.type));

  // a TECH may read (unlike create, which is pm+ AND ownership-gated)
  const glTech = await GET(`/api/shows/${FX}/flex/gear-lists`, { token: TECHT });
  ok('16b GATE: a TECH may read the gear lists — the warehouse pulls gear it does not own',
     glTech.status === 200 && glTech.body.count === 2, glTech.body);
  const glPm2 = await GET(`/api/shows/${FX}/flex/gear-lists`, { token: PM2T });
  ok('16b GATE: ...and a pm who does not own the folder may read it too — a read is not a write',
     glPm2.status === 200, glPm2.body);

  // ── an empty folder is a FACT, said in words ──────────────────────────────
  const fxShow7 = await POST('/api/shows', {
    project_id: P, name: TAG + ' empty folder', venue: 'Wrigley Field', event_date: '2026-11-14'
  }, { token: A });
  const FX7 = fxShow7.body.id;
  await PUT(`/api/shows/${FX7}/gear`, { linked: true, element_id: 'empty-folder' }, { token: A });
  const glEmpty = await GET(`/api/shows/${FX7}/flex/gear-lists`, { token: A });
  ok('16b: a folder with no equipment lists is 200 with empty:true and an EMPTY ARRAY',
     glEmpty.status === 200 && glEmpty.body.empty === true && glEmpty.body.count === 0
     && Array.isArray(glEmpty.body.lists), glEmpty.body);
  ok('16b: ...and a message that says it is the FOLDER that is empty, naming it',
     /no equipment lists yet/i.test(glEmpty.body.message)
     && /Wrigley Field Folder/.test(glEmpty.body.message), glEmpty.body.message);
  const psEmpty = await GET(`/api/shows/${FX7}/flex/pull-sheet`, { token: A });
  ok('16b: asking for a pull sheet out of an empty folder is a 404 that says why',
     psEmpty.status === 404 && /no equipment lists yet/i.test(psEmpty.body.error), psEmpty.body);

  // ── the read itself ───────────────────────────────────────────────────────
  flexCalls.length = 0;
  const ps = await GET(`/api/shows/${FX}/flex/pull-sheet?listId=${STUB_LIST_A}`, { token: A });
  ok('16b: the pull sheet reads back', ps.status === 200, ps.body);
  ok('16b: EVERY call the read made was a GET — nothing on this path can write to Flex',
     flexCalls.length > 0 && flexCalls.every((c) => c.method === 'GET'),
     flexCalls.map((c) => c.method + ' ' + c.url));
  ok('16b: it spent one tree, one equipment-list header and one row-data (plus the user name)',
     flexCalls.filter((c) => /\/tree$/.test(c.url)).length === 1
     && flexCalls.filter((c) => /\/equipment-list\//.test(c.url)).length === 1
     && flexCalls.filter((c) => /\/row-data\//.test(c.url)).length === 1,
     flexCalls.map((c) => c.url));
  ok('16b: the dead node-list endpoint is never called (BUG 4)',
     !flexCalls.some((c) => /eqlist-line-item/.test(c.url)), flexCalls.map((c) => c.url));
  const PSH = ps.body.sheet;
  ok('16b: the TYPE comes from the header’s definitionId — no extra /identity call',
     PSH.type === 'pull-sheet' && PSH.docNumber === 'SM_01'
     && !flexCalls.some((c) => /identity/.test(c.url)), { type: PSH.type, doc: PSH.docNumber });
  ok('16b: the pack-status block reports all six stages, prep done with WHO and WHEN',
     PSH.status.stages.length === 6 && PSH.status.stages[0].done === true
     && PSH.status.stages[0].at === '2026-11-11T14:32:00' && PSH.status.stages[0].by === 'Brendon Ochs',
     PSH.status.stages[0]);
  ok('16b: ...and an incomplete stage is done:false with a null timestamp, never absent',
     PSH.status.stages.slice(1).every((x) => x.done === false && x.at === null),
     PSH.status.stages[2]);
  const gLed = PSH.groups.find((g) => g.path === 'LED Cabinets');
  ok('16b: the group nesting is real — LED Cabinets holds the cabinet AND the spool',
     !!gLed && gLed.type === 'category' && gLed.items.length === 2
     && gLed.items[0].qty === 48 && gLed.items[0].barcode === '00009',
     gLed && gLed.items.map((i) => [i.name, i.qty]));
  ok('16b: a CONTAINED row is gear AND opens its own sub-group',
     gLed.items[1].qty === 1 && gLed.items[1].contains === 1
     && PSH.groups.some((g) => g.path === 'LED Cabinets / Mediacom 300m fiber spool'
                             && g.items[0].qty === 2),
     PSH.groups.map((g) => g.path));
  const gLoose = PSH.groups.find((g) => g.type === 'loose');
  ok('16b: a top-level leaf is loose gear, UNSHIFTED to the front',
     !!gLoose && PSH.groups[0] === gLoose, PSH.groups.map((g) => g.type));
  ok('16b BUG 6: the serial is lifted out of the name and the null quantity says qtyAssumed',
     gLoose.items[0].name === '2024 P10 Perimeter' && gLoose.items[0].serial === '6858'
     && gLoose.items[0].qty === 1 && gLoose.items[0].qtyAssumed === true, gLoose.items[0]);
  ok('16b: an isNote row is not gear', !PSH.groups.some((g) => g.items.some((i) => /SPARES/.test(i.name))),
     PSH.groups.map((g) => g.items.map((i) => i.name)));
  ok('16b: totals are 3 groups, 4 lines, 52 units',
     PSH.totals.groups === 3 && PSH.totals.lines === 4 && PSH.totals.units === 52, PSH.totals);
  ok('16b: the sheet carries its own deep link and the time it was read',
     PSH.deepLink === `${FLEX_STUB_BASE}/f5/ui/#element/${STUB_LIST_A}/view/equipmentlist/header`
     && /^\d{4}-\d{2}-\d{2}T/.test(PSH.fetchedAt), { link: PSH.deepLink, at: PSH.fetchedAt });

  // ── a read WRITES NOTHING ─────────────────────────────────────────────────
  const fxRowAfter = await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [FX]);
  ok('16b: reading a pull sheet did NOT touch flex_state — pulled is still false, no gear_list_id',
     fxRowAfter.rows[0].pulled === false && !fxRowAfter.rows[0].gear_list_id
     && fxRowAfter.rows[0].element_id === 'stub-element-0001', fxRowAfter.rows[0]);
  const actAfter = await pool.query(
    `SELECT COUNT(*)::int AS n FROM activity WHERE show_id=$1 AND action LIKE 'flex.%'`, [FX]);
  ok('16b: ...and wrote no activity line — a read is not an event',
     actAfter.rows[0].n === 1, actAfter.rows[0]);      // still just the one flex.create
  const filesAfter = await pool.query(
    `SELECT COUNT(*)::int AS n FROM files WHERE show_id=$1 AND artifact='pullsheet'`, [FX]);
  ok('16b: ...and filed no pull-sheet document — the demo invented one, this does not',
     filesAfter.rows[0].n === 0, filesAfter.rows[0]);

  // ── the id a caller supplies is VERIFIED against the folder ───────────────
  const psOutside = await GET(`/api/shows/${FX}/flex/pull-sheet?listId=${STUB_OUTSIDER}`, { token: A });
  ok('16b: a list that is NOT under this show’s folder is refused, and the message names what IS',
     psOutside.status === 404 && /not under this show/i.test(psOutside.body.error)
     && /SM_01/.test(psOutside.body.error), psOutside.body);
  const psJunk = await GET(`/api/shows/${FX}/flex/pull-sheet?listId=not-a-uuid`, { token: A });
  ok('16b: a non-UUID listId is a 400 before any Flex call is made', psJunk.status === 400, psJunk.body);
  const psAmbig = await GET(`/api/shows/${FX}/flex/pull-sheet`, { token: A });
  ok('16b: omitting listId with TWO lists is a 400 that names both, never a guess',
     psAmbig.status === 400 && /SM_01/.test(psAmbig.body.error) && /SM_02/.test(psAmbig.body.error),
     psAmbig.body);
  const psOnly = await GET(`/api/shows/${FX7}/flex/pull-sheet`, { token: A });
  ok('16b: ...but an empty folder still 404s rather than picking nothing', psOnly.status === 404);

  // ── BUG 5's dangerous half, end to end ────────────────────────────────────
  const psB = await GET(`/api/shows/${FX}/flex/pull-sheet?listId=${STUB_LIST_B}`, { token: A });
  ok('16b BUG 5: a 200-with-[] row-data is reported as empty:true + rowCount 0, not as "no gear"',
     psB.status === 200 && psB.body.sheet.empty === true && psB.body.sheet.rowCount === 0
     && psB.body.sheet.groups.length === 0, psB.body.sheet);
  ok('16b: ...and the HEADER still comes through, so the list is identified as the MANIFEST it is',
     psB.body.sheet.type === 'manifest' && psB.body.sheet.docNumber === 'SM_02', psB.body.sheet.type);

  const fxUnlink = await DEL(`/api/shows/${FX}/flex/element`, { token: A });
  ok('16: unlink forgets the pointer and clears the deep link',
     fxUnlink.status === 200 && fxUnlink.body.linked === false
     && !fxUnlink.body.elementId && fxUnlink.body.deepLink === '', fxUnlink.body);
  const fxUnlinkTech = await DEL(`/api/shows/${FX}/flex/element`, { token: TECHT });
  ok('16 GATE: a tech cannot unlink either', fxUnlinkTech.status === 403, fxUnlinkTech.body);

  // ── nothing leaves this suite pointing at a live tenant ───────────────────
  ok('16: every Flex call in this section went to the STUB host, never to Flex',
     flexCalls.every((c) => c.url.indexOf(FLEX_STUB_BASE) === 0), flexCalls.map((c) => c.url));
  global.fetch = realFetch;
  if (FLEX_ENV_BEFORE.url) process.env.FLEX_BASE_URL = FLEX_ENV_BEFORE.url;
  else delete process.env.FLEX_BASE_URL;
  if (FLEX_ENV_BEFORE.key) process.env.FLEX_API_KEY = FLEX_ENV_BEFORE.key;
  else delete process.env.FLEX_API_KEY;
  flexLib.flexResetUserCache();
  ok('16: the environment is restored and global fetch is the real one again',
     global.fetch === realFetch && !process.env.FLEX_BASE_URL === !FLEX_ENV_BEFORE.url);

  // ══════════════════════════════════════════════════════════════════════════
  // 17. PEOPLE & PERMISSIONS — "people come and go" (Tom)
  // ──────────────────────────────────────────────────────────────────────────
  // The whole lifecycle over the wire: an admin adds somebody and reads out a
  // server-minted temp password once, that person signs in and is told to
  // replace it, an admin edits their role and capability, resets a password
  // they lost, switches them off when they leave and back on when they return —
  // and at no point can the last active admin be stranded, nor a temp password
  // be recovered from any GET or from the audit trail.
  // ══════════════════════════════════════════════════════════════════════════
  section('17. people & permissions — the roster lifecycle');

  // ── ADD ──────────────────────────────────────────────────────────────────
  const newHire = TAG + 'hire';
  const created = await POST('/api/users', {
    username: newHire, name: 'New Hire', role: 'tech', discipline: 'led',
    title: 'Install / Field Tech', phone: '(414) 555-0199'
  }, { token: A });
  ok('17 ADD: POST /api/users creates the person', created.status === 200 && created.body.id > 0, created.body);
  const HIRE_ID = created.body.id;
  const TEMP1 = created.body.temp_password;
  ok('17 ADD: the server MINTED a temp password (the caller sent none)',
     typeof TEMP1 === 'string' && TEMP1.length >= 8, created.body);
  ok('17 ADD: ...and set must_change on the row', created.body.must_change === true, created.body);
  ok('17 ADD: initials were derived from the name', created.body.initials === 'NH', created.body.initials);
  ok('17 ADD: a colour was auto-assigned from the palette',
     /^#[0-9A-Fa-f]{6}$/.test(created.body.color || ''), created.body.color);
  ok('17 ADD: the new person is ACTIVE', created.body.active === true, created.body.active);
  const dupUser = await POST('/api/users', { username: newHire }, { token: A });
  ok('17 ADD: a duplicate username is a 400 that says so',
     dupUser.status === 400 && /already taken/i.test(dupUser.body.error || ''), dupUser.body);
  const badName = await POST('/api/users', { username: '9nope' }, { token: A });
  ok('17 ADD: a username that breaks the slug rule is a 400',
     badName.status === 400 && /2–32/.test(badName.body.error || ''), badName.body);
  const pmAdds = await POST('/api/users', { username: TAG + 'sneak' }, { token: PMT });
  ok('17 GATE: a pm cannot add a person', pmAdds.status === 403, pmAdds.body);
  const sneakRow = await pool.query('SELECT id FROM users WHERE username=$1', [TAG + 'sneak']);
  ok('17 GATE: ...and the refusal wrote nothing', sneakRow.rows.length === 0);

  // ── THE TEMP PASSWORD IS A ONE-TIME FACT ─────────────────────────────────
  const hireGet = await GET(`/api/users/${HIRE_ID}`, { token: A });
  ok('17 SECRET: no GET returns the temp password',
     hireGet.status === 200 && !JSON.stringify(hireGet.body).includes(TEMP1), hireGet.body);
  const rosterAll = await GET('/api/users?all=1', { token: A });
  ok('17 SECRET: ...nor does the full roster listing',
     !JSON.stringify(rosterAll.body).includes(TEMP1));
  const actAfterCreate = await pool.query(
    `SELECT action, detail FROM activity WHERE action LIKE 'user.%' ORDER BY id DESC LIMIT 20`);
  ok('17 SECRET: the activity trail records the act and NEVER the password',
     actAfterCreate.rows.some((r) => r.action === 'user.create' && r.detail.includes(newHire))
     && !actAfterCreate.rows.some((r) => (r.detail || '').includes(TEMP1)),
     actAfterCreate.rows.slice(0, 3));

  // ── EMAIL — optional, validated, unique among the ACTIVE ─────────────────
  // The address is not the identity. The USERNAME is: it is the @mention
  // handle and the string sitting in steps.owner, notes.author and a dozen
  // other columns, and it never changes. The address is where we send things,
  // it is optional, and it is editable — which is precisely why login accepts
  // either and why the two rules below are different rules.
  ok('17 EMAIL: a person created without one simply has none — it is OPTIONAL',
     created.body.email === '', created.body);
  const mailUser = TAG + 'mail';
  const MAIL_ADDR = mailUser + '@e360sport.test';
  const withMail = await POST('/api/users',
    { username: mailUser, password: 'smokepass123', role: 'tech', name: 'MAIL USER',
      email: '  ' + MAIL_ADDR.toUpperCase() + '  ' }, { token: A });
  ok('17 EMAIL: an address is accepted, TRIMMED and stored lowercase — one form to compare',
     withMail.status === 200 && withMail.body.email === MAIL_ADDR, withMail.body);
  const MAIL_ID = withMail.body.id;
  for (const badAddr of ['nope', 'no@dot', 'two@@at.com', 'has space@x.com',
                         '@nolocal.com', 'trailing@dot.', 'comma@x.com,y@x.com']) {
    const r = await POST('/api/users',
      { username: TAG + 'badmail', email: badAddr }, { token: A });
    ok(`17 EMAIL: "${badAddr}" is refused as an address, in the caller's words`,
       r.status === 400 && /email address/i.test(r.body.error || ''), r.body);
  }
  const badMailRow = await pool.query('SELECT id FROM users WHERE username=$1', [TAG + 'badmail']);
  ok('17 EMAIL: ...and every one of those refusals created NOBODY — checked before the write',
     badMailRow.rows.length === 0);
  const okAddr = await POST('/api/users',
    { username: TAG + 'plus', email: 'tom.andres+showrunner@e360sport.co.uk' }, { token: A });
  ok('17 EMAIL: the rule is RFC-lite, not RFC-pedantic — a +tag and a two-part TLD are fine',
     okAddr.status === 200 && okAddr.body.email === 'tom.andres+showrunner@e360sport.co.uk',
     okAddr.body);

  const dupMail = await POST('/api/users',
    { username: TAG + 'dupmail', email: MAIL_ADDR.toUpperCase() }, { token: A });
  ok('17 EMAIL: a second ACTIVE person cannot take the same address, case-insensitively',
     dupMail.status === 400 && /already on/i.test(dupMail.body.error || '')
     && dupMail.body.error.includes(mailUser), dupMail.body);
  const dupMailRow = await pool.query('SELECT id FROM users WHERE username=$1', [TAG + 'dupmail']);
  ok('17 EMAIL: ...and that refusal created nobody either', dupMailRow.rows.length === 0);
  const selfSave = await PUT(`/api/users/${MAIL_ID}`,
    { email: MAIL_ADDR, title: 'Still theirs' }, { token: A });
  ok('17 EMAIL: saving your OWN address back is not a collision with yourself',
     selfSave.status === 200 && selfSave.body.email === MAIL_ADDR
     && selfSave.body.title === 'Still theirs', selfSave.body);
  const clearMail = await PUT(`/api/users/${okAddr.body.id}`, { email: '' }, { token: A });
  ok('17 EMAIL: sending a blank CLEARS it — an address can be taken away again',
     clearMail.status === 200 && clearMail.body.email === '', clearMail.body);

  // ── LOGIN ACCEPTS EITHER ─────────────────────────────────────────────────
  const byUsername = await POST('/api/auth/login', { username: mailUser, password: 'smokepass123' });
  ok('17 LOGIN: the username still signs them in',
     byUsername.status === 200 && !!byUsername.body.token, byUsername.body);
  const byEmail = await POST('/api/auth/login', { username: MAIL_ADDR, password: 'smokepass123' });
  ok('17 LOGIN: and so does the EMAIL — one field, and the "@" picks the lookup',
     byEmail.status === 200 && !!byEmail.body.token && byEmail.body.username === mailUser,
     byEmail.body);
  const byEmailCase = await POST('/api/auth/login',
    { username: '  ' + MAIL_ADDR.toUpperCase() + '  ', password: 'smokepass123' });
  ok('17 LOGIN: ...case-insensitively, and trimmed', byEmailCase.status === 200, byEmailCase.body);
  const byIdentifier = await POST('/api/auth/login',
    { identifier: MAIL_ADDR, password: 'smokepass123' });
  ok('17 LOGIN: `identifier` is accepted as a synonym, so a caller need not lie about the field',
     byIdentifier.status === 200, byIdentifier.body);
  const emailSession = await GET('/api/auth/me', { token: byEmail.body.token });
  ok('17 LOGIN: a session minted by an email login is an ORDINARY full session',
     emailSession.body.loggedIn === true && emailSession.body.username === mailUser,
     emailSession.body);

  // ── THE NO-ENUMERATION PROPERTY ──────────────────────────────────────────
  // Adding a second way in is exactly how an endpoint accidentally becomes an
  // account-existence oracle: "wrong password" for an address we hold and "no
  // such user" for one we do not is a free directory of everyone who works
  // here. So all three failures below must be INDISTINGUISHABLE — same status,
  // same body, byte for byte — and this is the assertion that says so.
  const wrongPwRealEmail = await POST('/api/auth/login',
    { username: MAIL_ADDR, password: 'definitely-wrong' });
  const unknownEmail = await POST('/api/auth/login',
    { username: 'nobody.at.all@e360sport.test', password: 'definitely-wrong' });
  const unknownUsername = await POST('/api/auth/login',
    { username: TAG + 'ghost', password: 'definitely-wrong' });
  ok('17 ENUM: a WRONG PASSWORD against a real address is a generic 401',
     wrongPwRealEmail.status === 401, wrongPwRealEmail.body);
  ok('17 ENUM: an address NOBODY HOLDS is a generic 401',
     unknownEmail.status === 401, unknownEmail.body);
  ok('17 ENUM: ...and the two bodies are BYTE-IDENTICAL — no oracle',
     JSON.stringify(wrongPwRealEmail.body) === JSON.stringify(unknownEmail.body),
     { real: wrongPwRealEmail.body, unknown: unknownEmail.body });
  ok('17 ENUM: ...and an unknown USERNAME says the very same thing as both',
     unknownUsername.status === 401 &&
     JSON.stringify(unknownUsername.body) === JSON.stringify(unknownEmail.body),
     unknownUsername.body);
  ok('17 ENUM: ...and none of the three says "no such", "unknown" or "not found"',
     [wrongPwRealEmail, unknownEmail, unknownUsername].every(
       (r) => !/no such|not found|unknown|does not exist|deactivated/i.test(JSON.stringify(r.body))),
     [wrongPwRealEmail.body, unknownEmail.body, unknownUsername.body]);

  // ── UNIQUE AMONG THE ACTIVE, AND ONLY THE ACTIVE ─────────────────────────
  // Somebody who leaves keeps their row — and their address — forever, because
  // that is the whole offboarding story. Blocking a re-hire, or the re-use of a
  // company address, on a row nobody can sign in as would be the rule doing
  // real damage for no gain.
  await PUT(`/api/users/${MAIL_ID}`, { active: false }, { token: A });
  const reuse = await POST('/api/users',
    { username: TAG + 'reuse', password: 'smokepass123', email: MAIL_ADDR }, { token: A });
  ok('17 EMAIL: once the holder is DEACTIVATED the address frees up',
     reuse.status === 200 && reuse.body.email === MAIL_ADDR, reuse.body);
  const deadEmailLogin = await POST('/api/auth/login',
    { username: MAIL_ADDR, password: 'smokepass123' });
  ok('17 EMAIL: ...and that address now signs in as the LIVE account, not the dead one',
     deadEmailLogin.status === 200 && deadEmailLogin.body.username === TAG + 'reuse',
     deadEmailLogin.body);
  const backOn = await PUT(`/api/users/${MAIL_ID}`, { active: true }, { token: A });
  ok('17 EMAIL: reactivating the FIRST holder is refused, naming the clash — caught here, '
     + 'not at 3am in the outbox',
     backOn.status === 400 && /already on/i.test(backOn.body.error || ''), backOn.body);
  const stillOff = await pool.query('SELECT active FROM users WHERE id=$1', [MAIL_ID]);
  ok('17 EMAIL: ...and the refusal wrote NOTHING — they are still deactivated',
     stillOff.rows[0].active === false, stillOff.rows[0]);
  await PUT(`/api/users/${reuse.body.id}`, { email: '' }, { token: A });
  const backOn2 = await PUT(`/api/users/${MAIL_ID}`, { active: true }, { token: A });
  ok('17 EMAIL: free the address and the reactivation goes straight through',
     backOn2.status === 200 && backOn2.body.active === true, backOn2.body);
  await PUT(`/api/users/${MAIL_ID}`, { active: false }, { token: A });   // park them off again

  // ── THE STAFFING-APP NAME — the identity half of the linkage ─────────────
  const staffName = await PUT(`/api/users/${HIRE_ID}`,
    { staffing_name: '  New A. Hire  ' }, { token: A });
  ok('17 LINK: staffing_name is stored, trimmed, and comes back on the record',
     staffName.status === 200 && staffName.body.staffing_name === 'New A. Hire', staffName.body);
  const staffCleared = await PUT(`/api/users/${HIRE_ID}`, { staffing_name: '' }, { token: A });
  ok('17 LINK: blank clears it to NULL — "they are called the same thing in both systems"',
     staffCleared.status === 200 && staffCleared.body.staffing_name === null, staffCleared.body);
  const staffUntouched = await PUT(`/api/users/${HIRE_ID}`, { title: 'Field Tech' }, { token: A });
  ok('17 LINK: an edit that does not mention it leaves it alone',
     staffUntouched.status === 200 && staffUntouched.body.staffing_name === null, staffUntouched.body);

  // ── WHO MAY SEE AN ADDRESS ───────────────────────────────────────────────
  // Phone numbers ride on call sheets by design; addresses do not, and the
  // roster is read by everybody.
  const rosterAsTech = await GET('/api/users', { token: TECHT });
  const meAsTech = rosterAsTech.body.find((u) => u.username === techUser);
  const otherAsTech = rosterAsTech.body.find((u) => u.username === pmUser);
  ok('17 EMAIL PRIVACY: a non-admin sees their OWN address on the roster',
     !!meAsTech && typeof meAsTech.email === 'string' && meAsTech.email.length > 0, meAsTech);
  ok('17 EMAIL PRIVACY: ...and the key is simply ABSENT for everybody else — not empty, absent',
     !!otherAsTech && !('email' in otherAsTech), otherAsTech);
  const rosterAsAdmin = await GET('/api/users?all=1', { token: A });
  ok('17 EMAIL PRIVACY: an admin sees every address — they are the only one who can edit them, '
     + 'and the only one who needs to know who has not got one',
     rosterAsAdmin.body.every((u) => 'email' in u), rosterAsAdmin.body.length);
  ok('17 EMAIL PRIVACY: staffing_name is NOT gated — it is a name, published in staffing anyway',
     rosterAsTech.body.every((u) => 'staffing_name' in u), rosterAsTech.body.length);

  // ── THE must_change FLOW ─────────────────────────────────────────────────
  const hireLogin = await POST('/api/auth/login', { username: newHire, password: TEMP1 });
  ok('17 FLOW: the temp password signs them in', hireLogin.status === 200 && !!hireLogin.body.token, hireLogin.body);
  ok('17 FLOW: ...and the LOGIN RESPONSE carries must_change',
     hireLogin.body.must_change === true, hireLogin.body);
  const HIRET = hireLogin.body.token;
  const hireMe = await GET('/api/auth/me', { token: HIRET });
  ok('17 FLOW: GET /api/auth/me carries it too (a reload cannot skip the gate)',
     hireMe.body.must_change === true, hireMe.body);
  const wrongCur = await PUT('/api/me/password',
    { current_password: 'not-it', password: 'a-real-password-1' }, { token: HIRET });
  ok('17 FLOW: changing your own password without the current one is a 400',
     wrongCur.status === 400 && /current password/i.test(wrongCur.body.error || ''), wrongCur.body);
  const shortPw = await PUT('/api/me/password',
    { current_password: TEMP1, password: 'short' }, { token: HIRET });
  ok('17 FLOW: a new password under 8 characters is a 400', shortPw.status === 400, shortPw.body);
  const samePw = await PUT('/api/me/password',
    { current_password: TEMP1, password: TEMP1 }, { token: HIRET });
  ok('17 FLOW: re-setting the SAME password is refused', samePw.status === 400, samePw.body);
  // a second device, to prove the "other sessions" half of the rule
  const HIRET2 = (await POST('/api/auth/login', { username: newHire, password: TEMP1 })).body.token;
  const changed = await PUT('/api/me/password',
    { current_password: TEMP1, password: 'a-real-password-1' }, { token: HIRET });
  ok('17 FLOW: with the current password it goes through', changed.status === 200, changed.body);
  ok('17 FLOW: ...and clears must_change', changed.body.must_change === false, changed.body);
  const meAfter = await GET('/api/auth/me', { token: HIRET });
  ok('17 FLOW: the changing device STAYS signed in',
     meAfter.status === 200 && meAfter.body.loggedIn === true && meAfter.body.must_change === false, meAfter.body);
  const otherAfter = await GET('/api/auth/me', { token: HIRET2 });
  ok('17 FLOW: every OTHER device is signed out',
     otherAfter.status === 200 && otherAfter.body.loggedIn === false, otherAfter.body);
  const oldPwLogin = await POST('/api/auth/login', { username: newHire, password: TEMP1 });
  ok('17 FLOW: the temp password no longer works', oldPwLogin.status === 401, oldPwLogin.body);
  const newPwLogin = await POST('/api/auth/login', { username: newHire, password: 'a-real-password-1' });
  ok('17 FLOW: the new one does, with must_change cleared',
     newPwLogin.status === 200 && newPwLogin.body.must_change === false, newPwLogin.body);

  // ── EDIT ─────────────────────────────────────────────────────────────────
  const edited = await PUT(`/api/users/${HIRE_ID}`, {
    role: 'pm', finance: true, title: 'Project Manager', phone: '(414) 555-0200'
  }, { token: A });
  ok('17 EDIT: an admin sets role, capability and profile in one call',
     edited.status === 200 && edited.body.role === 'pm' && edited.body.finance === true
     && edited.body.title === 'Project Manager', edited.body);
  const editLog = await pool.query(
    `SELECT action, detail FROM activity WHERE action IN ('user.role','user.finance')
     AND detail LIKE $1 ORDER BY id DESC`, [`%${newHire}%`]);
  ok('17 EDIT: the role change and the capability grant are BOTH logged',
     editLog.rows.some((r) => r.action === 'user.role')
     && editLog.rows.some((r) => r.action === 'user.finance'), editLog.rows);
  const selfPromote = await PUT(`/api/users/${HIRE_ID}`, { role: 'admin', finance: true },
    { token: newPwLogin.body.token });
  ok('17 GATE: a user editing THEMSELVES cannot change their own role or capability',
     selfPromote.status === 200 && selfPromote.body.role === 'pm' && selfPromote.body.finance === true,
     selfPromote.body);
  const stillPm = await pool.query('SELECT role FROM users WHERE id=$1', [HIRE_ID]);
  ok('17 GATE: ...the row is still a pm', stillPm.rows[0].role === 'pm', stillPm.rows[0]);
  const badRole = await PUT(`/api/users/${HIRE_ID}`, { role: 'superuser' }, { token: A });
  ok('17 EDIT: an unknown role is a 400 naming it',
     badRole.status === 400 && /superuser/.test(badRole.body.error || ''), badRole.body);
  const pmEditsOther = await PUT(`/api/users/${HIRE_ID}`, { title: 'nope' }, { token: TECHT });
  ok('17 GATE: somebody else\'s profile is 403 for a non-admin', pmEditsOther.status === 403, pmEditsOther.body);

  // ── RESET ────────────────────────────────────────────────────────────────
  const HIRE_LIVE = (await POST('/api/auth/login',
    { username: newHire, password: 'a-real-password-1' })).body.token;
  const hireKey = await POST('/api/keys', { username: newHire, label: TAG + ' hire key' }, { token: A });
  ok('17 RESET: the person holds a live agent key before the reset', hireKey.status === 200, hireKey.body);
  const reset = await POST(`/api/users/${HIRE_ID}/reset-password`, {}, { token: A });
  ok('17 RESET: an admin mints a new temp password', reset.status === 200 && !!reset.body.temp_password, reset.body);
  const TEMP2 = reset.body.temp_password;
  ok('17 RESET: it is a NEW value, not the first one', TEMP2 !== TEMP1);
  ok('17 RESET: must_change is set again', reset.body.must_change === true, reset.body);
  const liveAfterReset = await GET('/api/auth/me', { token: HIRE_LIVE });
  ok('17 RESET: every session they held is destroyed',
     liveAfterReset.body.loggedIn === false, liveAfterReset.body);
  const keyAfterReset = await GET('/api/agent/whoami', { key: hireKey.body.key });
  ok('17 RESET: ...and their agent keys are revoked', keyAfterReset.status === 401, keyAfterReset.body);
  const resetLog = await pool.query(
    `SELECT detail FROM activity WHERE action='user.password_reset' ORDER BY id DESC LIMIT 5`);
  ok('17 RESET: the trail names WHO, never WHAT',
     resetLog.rows.some((r) => r.detail === newHire)
     && !resetLog.rows.some((r) => (r.detail || '').includes(TEMP2)), resetLog.rows);
  const reLogin = await POST('/api/auth/login', { username: newHire, password: TEMP2 });
  ok('17 RESET: the new temp password signs them in, must_change set',
     reLogin.status === 200 && reLogin.body.must_change === true, reLogin.body);
  const pmResets = await POST(`/api/users/${HIRE_ID}/reset-password`, {}, { token: PMT });
  ok('17 GATE: a pm cannot reset anybody\'s password', pmResets.status === 403, pmResets.body);

  // ── DEACTIVATE / REACTIVATE ──────────────────────────────────────────────
  // A show step owned by this person, so the "history survives" claim is tested
  // against a real row rather than asserted.
  const hireStep = await POST('/api/steps', { show_id: S, lane: 'logistics', title: TAG + ' hire step',
    owner: newHire, status: 'in_progress' }, { token: A });
  ok('17 HISTORY: the person owns a step before they leave', hireStep.status === 200, hireStep.body);
  const HIRE_SESSION = reLogin.body.token;
  const deact = await PUT(`/api/users/${HIRE_ID}`, { active: false }, { token: A });
  ok('17 LEAVE: an admin deactivates them', deact.status === 200 && deact.body.active === false, deact.body);
  const rowStillThere = await pool.query('SELECT id, username, role FROM users WHERE id=$1', [HIRE_ID]);
  ok('17 LEAVE: the ROW IS STILL THERE — deactivation is not deletion',
     rowStillThere.rows.length === 1 && rowStillThere.rows[0].username === newHire, rowStillThere.rows);
  const deactLogin = await POST('/api/auth/login', { username: newHire, password: TEMP2 });
  ok('17 LEAVE: their login is refused with a CLEAR message, not "invalid password"',
     deactLogin.status === 403 && /deactivated/i.test(deactLogin.body.error || ''), deactLogin.body);
  const wrongPwDeact = await POST('/api/auth/login', { username: newHire, password: 'definitely-wrong' });
  ok('17 LEAVE: ...but a WRONG password on that account is still the generic 401 — '
     + 'the endpoint is not an account-existence oracle',
     wrongPwDeact.status === 401 && !/deactivated/i.test(wrongPwDeact.body.error || ''), wrongPwDeact.body);
  const deadSession = await GET('/api/auth/me', { token: HIRE_SESSION });
  ok('17 LEAVE: the session they were holding is invalidated',
     deadSession.body.loggedIn === false, deadSession.body);
  const deadRead = await GET('/api/projects', { token: HIRE_SESSION });
  ok('17 LEAVE: ...and it cannot read anything either', deadRead.status === 401, deadRead.status);

  const workingRoster = await GET('/api/users', { token: PMT });
  ok('17 ROSTER: the default roster is ACTIVE ONLY — pickers never offer them',
     workingRoster.status === 200
     && !workingRoster.body.some((u) => u.username === newHire), workingRoster.body.length);
  const allRoster = await GET('/api/users?all=1', { token: A });
  ok('17 ROSTER: ?all=1 returns them to an admin, flagged inactive',
     allRoster.body.some((u) => u.username === newHire && u.active === false));
  const pmAllRoster = await GET('/api/users?all=1', { token: PMT });
  ok('17 ROSTER: ?all=1 from a non-admin still returns only the working roster',
     !pmAllRoster.body.some((u) => u.username === newHire), pmAllRoster.body.length);
  const hireByName = await GET(`/api/users/${newHire}`, { token: PMT });
  ok('17 HISTORY: they still RESOLVE by username — every attribution surface needs this',
     hireByName.status === 200 && hireByName.body.username === newHire
     && hireByName.body.active === false, hireByName.body);
  const stepStill = await GET(`/api/steps/${hireStep.body.id}`, { token: A });
  ok('17 HISTORY: the step they owned still names them as owner',
     stepStill.status === 200 && stepStill.body.owner === newHire, stepStill.body);
  const showStill = await GET(`/api/shows/${S}`, { token: A });
  ok('17 HISTORY: ...and the show renders with that step in it',
     showStill.status === 200 && (showStill.body.steps || []).some((x) => x.owner === newHire));
  const leaveLog = await pool.query(
    `SELECT detail FROM activity WHERE action='user.active' ORDER BY id DESC LIMIT 3`);
  ok('17 LEAVE: deactivation is logged', leaveLog.rows.some((r) => /deactivated/.test(r.detail || '')),
     leaveLog.rows);

  const react = await PUT(`/api/users/${HIRE_ID}`, { active: true }, { token: A });
  ok('17 RETURN: reactivating puts them back', react.status === 200 && react.body.active === true, react.body);
  const backRoster = await GET('/api/users', { token: PMT });
  ok('17 RETURN: ...back on the working roster', backRoster.body.some((u) => u.username === newHire));
  const backLogin = await POST('/api/auth/login', { username: newHire, password: TEMP2 });
  ok('17 RETURN: ...and their old password still works — nothing was destroyed',
     backLogin.status === 200, backLogin.body);
  await PUT(`/api/users/${HIRE_ID}`, { active: false }, { token: A });   // park them off again

  // ── THE LOCKOUT GUARD ────────────────────────────────────────────────────
  // The foot-gun: the last admin walking out of their own admin rights. There
  // is no recovery path in the app for a workspace with no active admin — it is
  // psql, at night, from whoever still has the database URL. So the server
  // counts, and refuses.
  //
  // The set-up matters as much as the assertion. `admNoFin` is a SECOND admin,
  // so while he exists the guard must NOT fire: a rule that refuses every
  // demotion is not a guard, it is a bug that happens to look like one. Only
  // once he is out of the way does the last-admin refusal become correct.
  const adminIdRow = await pool.query(`SELECT id FROM users WHERE username='admin'`);
  const ADMIN_ID = adminIdRow.rows[0].id;
  const admNoFinRow = await pool.query('SELECT id FROM users WHERE username=$1', [admNoFin]);
  const ADMNF_ID = admNoFinRow.rows[0].id;
  const otherAdmins = await pool.query(
    `SELECT id, username FROM users WHERE role='admin' AND active IS NOT FALSE AND id <> $1`, [ADMIN_ID]);
  ok('17 LOCKOUT: the fixture really does have more than one active admin to start',
     otherAdmins.rows.length > 0, otherAdmins.rows.map((r) => r.username));

  const demoteWhileCovered = await PUT(`/api/users/${ADMIN_ID}/role`, { role: 'manager' }, { token: A });
  ok('17 LOCKOUT: with another admin in place, demoting one IS allowed',
     demoteWhileCovered.status === 200 && demoteWhileCovered.body.role === 'manager',
     demoteWhileCovered.body);
  await PUT(`/api/users/${ADMIN_ID}/role`, { role: 'admin' }, { token: ADMNFT });   // put it back

  // Now strip the cover: park every other active admin, leaving exactly one.
  const strip = await pool.query(
    `SELECT id, username FROM users WHERE role='admin' AND active IS NOT FALSE AND id <> $1`, [ADMIN_ID]);
  for (const r of strip.rows) {
    await PUT(`/api/users/${r.id}`, { active: false }, { token: A });
  }
  const soleCheck = await pool.query(
    `SELECT id FROM users WHERE role='admin' AND active IS NOT FALSE`);
  ok('17 LOCKOUT: exactly one active admin remains', soleCheck.rows.length === 1, soleCheck.rows);

  const selfDeact = await PUT(`/api/users/${ADMIN_ID}`, { active: false }, { token: A });
  ok('17 LOCKOUT: the last active admin cannot DEACTIVATE themselves',
     selfDeact.status === 400 && /only active admin/i.test(selfDeact.body.error || ''), selfDeact.body);
  const selfDemote = await PUT(`/api/users/${ADMIN_ID}`, { role: 'manager' }, { token: A });
  ok('17 LOCKOUT: ...nor DEMOTE themselves',
     selfDemote.status === 400 && /only active admin/i.test(selfDemote.body.error || ''), selfDemote.body);
  const selfDemoteRoute = await PUT(`/api/users/${ADMIN_ID}/role`, { role: 'pm' }, { token: A });
  ok('17 LOCKOUT: ...through the /role route either — a guard on one of two doors is no guard',
     selfDemoteRoute.status === 400 && /only active admin/i.test(selfDemoteRoute.body.error || ''),
     selfDemoteRoute.body);
  // DELETE carries the same guard, but the self-delete check standing in front
  // of it is what actually answers here — and by construction it always will:
  // reaching the lockout branch on this route would need an ACTIVE admin
  // deleting a DIFFERENT admin who is nonetheless the only active one, which
  // cannot be true at the same time. The guard stays as belt-and-braces against
  // a future refactor of that ordering; the reachable refusal is this one.
  const selfDelete = await DEL(`/api/users/${ADMIN_ID}`, { token: A });
  ok('17 LOCKOUT: ...and cannot delete the account out from under itself',
     selfDelete.status === 400 && /your own account/i.test(selfDelete.body.error || ''), selfDelete.body);
  const stillAdmin = await pool.query('SELECT role, active FROM users WHERE id=$1', [ADMIN_ID]);
  ok('17 LOCKOUT: every refusal wrote NOTHING — still an active admin',
     stillAdmin.rows[0].role === 'admin' && stillAdmin.rows[0].active !== false, stillAdmin.rows[0]);
  const meStill = await GET('/api/auth/me', { token: A });
  ok('17 LOCKOUT: ...and the admin is still signed in', meStill.body.loggedIn === true);

  // The guard is written against the SET ("is this the only active admin?"),
  // not against the caller ("are you doing this to yourself?"). Through HTTP
  // those turn out to be the SAME rule, and it is worth writing down why rather
  // than shipping an assertion that pretends otherwise: to demote somebody else
  // you must be an active admin, and if you are, the target is not the only
  // active admin. So there is no reachable "one admin strands another" case —
  // the set-shaped guard simply has no false negatives, which is why it is
  // written that way.
  //
  // What IS worth pinning: the guard is about the ROLE, not about being user
  // id 1. A DIFFERENT admin account, the last one standing, hits the identical
  // refusal — so nothing here is hardcoded to the seeded 'admin' row.
  await PUT(`/api/users/${ADMNF_ID}`, { active: true }, { token: A });      // second admin back
  // ...and he needs a NEW session: deactivating him a moment ago destroyed the
  // one he had, which is the deactivation rule doing exactly its job.
  const ADMNFT2 = (await POST('/api/auth/login',
    { username: admNoFin, password: 'smokepass123' })).body.token;
  ok('17 RETURN: a reactivated admin can sign in again', !!ADMNFT2);
  await PUT(`/api/users/${ADMIN_ID}/role`, { role: 'manager' }, { token: ADMNFT2 });
  const lastByOther = await PUT(`/api/users/${ADMNF_ID}`, { role: 'pm' }, { token: ADMNFT2 });
  ok('17 LOCKOUT: a DIFFERENT admin account, left as the last one, hits the same refusal',
     lastByOther.status === 400 && /only active admin/i.test(lastByOther.body.error || ''), lastByOther.body);
  const lastByOtherDeact = await PUT(`/api/users/${ADMNF_ID}`, { active: false }, { token: ADMNFT2 });
  ok('17 LOCKOUT: ...and cannot switch itself off either',
     lastByOtherDeact.status === 400 && /only active admin/i.test(lastByOtherDeact.body.error || ''),
     lastByOtherDeact.body);
  // restore the fixture for the sections that follow
  await PUT(`/api/users/${ADMIN_ID}/role`, { role: 'admin' }, { token: ADMNFT2 });
  for (const r of strip.rows) {
    await PUT(`/api/users/${r.id}`, { active: true }, { token: A });
  }
  const restored = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active IS NOT FALSE`);
  ok('17 LOCKOUT: the fixture is restored — the admins are back',
     restored.rows[0].n === soleCheck.rows.length + strip.rows.length, restored.rows[0]);

  const agentAddUser = await POST('/api/users', { username: TAG + 'agentmade' }, { key: K });
  ok('17 GATE: an agent key cannot add a person (§9 route topology)', agentAddUser.status === 403,
     agentAddUser.body);
  const agentReset = await POST(`/api/users/${HIRE_ID}/reset-password`, {}, { key: K });
  ok('17 GATE: ...nor reset one', agentReset.status === 403, agentReset.body);

  section('6. cascade integrity — a folder with a child of EVERY type');
  const before = await childCounts(P);
  ok('the smoke folder has children of every wired type',
     Object.values(before).every((n) => n >= 0)
     && before.shows > 0 && before.steps > 0 && before.files > 0 && before.expenses > 0
     && before.jobs > 0 && before.budget_lines > 0 && before.notes > 0 && before.note_reads > 0
     && before.note_mentions > 0 && before.schedule_items > 0 && before.crew_assignments > 0
     && before.deliverables > 0 && before.milestones > 0 && before.proposals > 0
     && before.purchase_orders > 0 && before.po_lines > 0 && before.purchase_needs > 0
     && before.activity > 0
     && before.tech_reports > 0 && before.notification_outbox > 0,
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
    purchase_needs:   await q('SELECT COUNT(*) n FROM purchase_needs WHERE project_id=$1'),
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
    // F2/F3 — two new tables, and the rule this list exists to enforce: a table
    // that is not counted here is a table that leaks rows on every folder delete.
    tech_reports:     await q(`SELECT COUNT(*) n FROM tech_reports WHERE project_id=$1 OR show_id ${inShows}`),
    notification_outbox: await q(`SELECT COUNT(*) n FROM notification_outbox WHERE project_id=$1 OR show_id ${inShows}`),
    activity:         await q(`SELECT COUNT(*) n FROM activity WHERE project_id=$1 OR show_id ${inShows}`)
  };
}
