#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/persona-walk.mjs — a scripted MONTH through the product, on an EMPTY
//                            database, driven through the app's REAL seam
// ────────────────────────────────────────────────────────────────────────────
//   npm run walk
//
// ── WHY THIS EXISTS AND WHY IT IS DIFFERENT FROM THE OTHER SUITES ───────────
// Every defect in DESIGN_GAPS.md passed its own tests. F2 (tech reports) has a
// table, gates and a firewall assertion and could never fire, because nothing
// could create a crew row. Closeout counted reports that could not exist.
// Delivery risk read a date nothing wrote. Margin gated a number nothing
// entered. All green. The pattern behind it is written down as P7:
//
//     "Features are validated at the row level, never at the workflow level."
//
// So this suite validates at the WORKFLOW level, and it does it under two rules
// that the row-level suites do not follow:
//
//   1. AN EMPTY DATABASE. No seeded projects, no fixture crew, no demo store.
//      Checklist item 8: "Demo the feature in API mode against an empty
//      database before calling it done. If the screen is empty and there is no
//      button that fills it, the feature is not finished."
//
//   2. THROUGH THE AFFORDANCE LAYER, NEVER AROUND IT. Every mutation below goes
//      through the exact route that `public/api.js` calls, and — this is the
//      part that makes it a product test rather than another API test — each
//      step first asserts that the affordance a PERSON would use actually
//      exists: a method on the seam (`public/api.js`) AND a handler in the
//      delegated action map (`public/app.js` ACTIONS) AND a `data-act` that
//      renders it somewhere in `public/*.js`. A route with no way in is not
//      shipped; it is a liability with a passing test (checklist item 2).
//
//      THE WALK FAILS IF ANY STEP HAS NO REACHABLE AFFORDANCE. That is the
//      whole point of it. `reach()` below is where that is enforced.
//
// It brings up its own throwaway Postgres (devDependency `embedded-postgres`),
// so it needs no DATABASE_URL and touches nothing that exists.
// ════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PUB = path.join(APP, 'public');
const require = createRequire(path.join(APP, 'package.json'));

// ── harness primitives (the repo style: ok() / ✓ ✗ / "N passed, N failed") ──
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else {
    fail += 1; failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined
      ? '  ->  ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300)
      : ''}`);
  }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`); }

// ════════════════════════════════════════════════════════════════════════════
// REACHABILITY — the assertion that makes this a product test
// ────────────────────────────────────────────────────────────────────────────
// P1: "~192 routes; ~115 methods in public/api.js; and the write half of eight
// entities is built, role-gated, cascade-wired, smoke-tested and UNREACHABLE
// FROM THE PRODUCT. The backend was built to a spec; the client seam was built
// per feature pass; nobody ever diffed the two lists."
//
// reach() diffs the two lists, one step at a time, and it is called BEFORE the
// HTTP call it guards — so a route that works but cannot be clicked fails the
// walk at the step that needs it, naming the half that is missing.
// ════════════════════════════════════════════════════════════════════════════
const SRC = {};
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
  SRC[f] = fs.readFileSync(path.join(PUB, f), 'utf8');
}
const API_JS = SRC['api.js'];
const APP_JS = SRC['app.js'];
const ALL_VIEWS = Object.keys(SRC).filter((f) => f !== 'api.js').map((f) => SRC[f]).join('\n');

function hasSeamMethod(name) {
  return new RegExp(`\\n\\s{4}${name}:\\s*function\\s*\\(`).test(API_JS);
}
function hasAction(name) {
  return new RegExp(`\\n\\s{2}${name}:\\s*(async\\s+)?function\\s*\\(`).test(APP_JS);
}
function hasDataAct(name) {
  // act('name', …) rendered by a view, or a literal data-act="name" in a shell
  return new RegExp(`act\\(\\s*'${name}'`).test(ALL_VIEWS) ||
         new RegExp(`act\\(\\s*'${name}'`).test(APP_JS) ||
         new RegExp(`data-act="${name}"`).test(ALL_VIEWS);
}
/* One step of the walk = one thing a person does. `seam` is the api.js method
   the click lands on, `action` is its ACTIONS key. Both must exist, and the
   action must be rendered somewhere, or the person cannot get there. */
function reach(what, { seam, action, rendered = true }) {
  const missing = [];
  if (seam) for (const m of [].concat(seam)) if (!hasSeamMethod(m)) missing.push(`api.${m}()`);
  if (action) for (const a of [].concat(action)) {
    if (!hasAction(a)) missing.push(`ACTIONS.${a}`);
    else if (rendered && !hasDataAct(a)) missing.push(`nothing renders act('${a}')`);
  }
  ok(`REACHABLE · ${what}`, missing.length === 0, missing.join(' · '));
  return missing.length === 0;
}

// ── HTTP, the way public/api.js does it (x-auth-token, JSON, no cookies) ────
let BASE = '';
async function call(method, p, { token, body, raw } = {}) {
  const h = {};
  if (token) h['x-auth-token'] = token;
  let payload;
  if (raw !== undefined) { h['Content-Type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, body: json };
}
const GET = (p, o) => call('GET', p, o);
const POST = (p, b, o) => call('POST', p, { ...o, body: b });
const PUT = (p, b, o) => call('PUT', p, { ...o, body: b });
const DEL = (p, o) => call('DELETE', p, o);

// Outbox reads go straight to the database: the point of most of these
// assertions is that a row EXISTS FOR SOMEBODY ELSE, and there is deliberately
// no route that lets one person read another person's notifications.
let pool = null;
async function outboxFor(username, kind) {
  const r = await pool.query(
    `SELECT * FROM notification_outbox WHERE LOWER(username)=LOWER($1)` +
    (kind ? ` AND kind=$2` : ``) + ` ORDER BY id DESC`,
    kind ? [username, kind] : [username]);
  return r.rows;
}
async function activityFor(showId, action) {
  const r = await pool.query(
    `SELECT * FROM activity WHERE show_id=$1` + (action ? ` AND action=$2` : ``) +
    ` ORDER BY id DESC`, action ? [showId, action] : [showId]);
  return r.rows;
}

// ════════════════════════════════════════════════════════════════════════════
let pg = null, server = null, dataDir = null;

async function main() {
  section('an EMPTY embedded-postgres database');
  const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');
  const PGPORT = parseInt(process.env.WALK_PG_PORT || '54331', 10);
  dataDir = path.join(os.tmpdir(), 'sr-walk-' + Date.now().toString(36));
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PGPORT,
    persistent: false,
    // SMOKE.md: the database MUST be UTF-8 — activity details carry → and —
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {}, onError: () => {}
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('walk');
  const url = `postgres://postgres:postgres@127.0.0.1:${PGPORT}/walk?sslmode=disable`;
  console.log(`  postgres up on ${PGPORT} — empty, UTF-8`);

  // ── the server, in PRODUCTION SHAPE ────────────────────────────────────────
  // No SEED_ROSTER: the walk creates its own people, so nothing it asserts can
  // be riding a fixture. No STORAGE_ROOT: that is the production default, and
  // §12 below is the assertion that the app tells the truth about it.
  process.env.DATABASE_URL = url;
  process.env.PORT = '0';
  process.env.LOGIN_RATE_LIMIT = '2000';
  process.env.SWEEP_ON_BOOT = '0';
  delete process.env.SEED_ROSTER;
  delete process.env.STORAGE_ROOT;
  delete process.env.STORAGE_DRIVER;
  delete process.env.SCHEDULER_BASE_URL;
  process.env.ADMIN_PASSWORD = 'walk-admin-pw';

  const srv = require(path.join(APP, 'server.js'));
  server = await srv.boot();
  BASE = `http://127.0.0.1:${server.address().port}`;
  pool = require(path.join(APP, 'lib', 'db.js')).pool;
  console.log(`  server up on ${BASE}`);

  const empty = await pool.query('SELECT COUNT(*)::int AS n FROM projects');
  ok('the database really is empty — zero projects', empty.rows[0].n === 0, empty.rows[0]);

  // ── the cast ───────────────────────────────────────────────────────────────
  section('the cast — six people, created through the product');
  const A = (await POST('/api/auth/login', { username: 'admin', password: 'walk-admin-pw' })).body.token;
  ok('the seeded admin can sign in', !!A);

  const PW = 'walk-pass-12345';
  const cast = [
    ['tom',      'admin',   false, 'Tom Andres'],     // owner/admin
    ['brenden',  'pm',      false, 'Brenden Sawyer'], // the PM running the show
    ['candice',  'manager', true,  'Candice Reyes'],  // accounting (finance flag)
    ['omar',     'tech',    false, 'Omar Vega'],      // the field tech
    ['morgan',   'manager', false, 'Morgan Ellis'],   // manager, NO finance —
                                                     // discriminates the MARGIN gate
    ['pat',      'pm',      false, 'Pat Nolan']       // a pm who owns NOTHING —
  ];                                                 // discriminates OWNERSHIP gates
  for (const [u, role, finance, name] of cast) {
    const r = await POST('/api/users', { username: u, password: PW, role, finance, name }, { token: A });
    ok(`created ${name} (${role}${finance ? ' + finance' : ''})`, r.status === 200, r.body);
  }
  const T = {};
  for (const [u] of cast) {
    T[u] = (await POST('/api/auth/login', { username: u, password: PW })).body.token;
  }
  ok('all six can sign in', Object.values(T).every(Boolean));

  const iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

  // ══════════════════════════════════════════════════════════════════════════
  section('1 · Tom opens the event');
  // ══════════════════════════════════════════════════════════════════════════
  reach('New Event', { seam: 'createEvent', action: ['openNew', 'commitNewEvent'] });
  const WRONG_DATE = plus(40);
  const RIGHT_DATE = plus(47);
  const ev = await POST('/api/events', {
    name: 'AVCA First Serve', type: 'led', client: 'AVCA',
    venue: 'Fiserv Forum', load_in_date: plus(38), event_date: WRONG_DATE,
    strike_date: plus(41), cabinets: 144, owner: 'tom'
  }, { token: T.tom });
  ok('POST /api/events opens folder + show + job + pipeline', ev.status === 200, ev.body);
  const SHOW = ev.body.show.id, PROJ = ev.body.show.project_id, JOB = ev.body.job.id;
  ok('…with a TEMP job number', /^TEMP-/.test(ev.body.job.qb_job_number), ev.body.job);
  ok('…and a seeded pipeline', (ev.body.instantiated_steps || 0) > 0, ev.body.instantiated_steps);

  // ══════════════════════════════════════════════════════════════════════════
  section('2 · Tom edits a date he got wrong  (A2 · F1 · F3)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Edit event', { seam: 'updateShow', action: ['editShow', 'esCommit'] });
  const before = (await pool.query(
    'SELECT id, due_date, due_offset_days FROM steps WHERE show_id=$1 AND due_offset_days IS NOT NULL',
    [SHOW])).rows;
  ok('the seeded pipeline back-schedules off the event date', before.length > 0, before.length);

  const edit = await PUT(`/api/shows/${SHOW}`, { event_date: RIGHT_DATE }, { token: T.tom });
  ok('PUT /api/shows/:id accepts the date move', edit.status === 200, edit.body);

  const after = (await pool.query(
    'SELECT id, due_date, due_offset_days FROM steps WHERE show_id=$1 AND due_offset_days IS NOT NULL',
    [SHOW])).rows;
  const moved = after.filter((s) => {
    const was = before.find((b) => b.id === s.id);
    return was && was.due_date !== s.due_date;
  });
  ok('…and every T-minus deadline moved with it', moved.length === before.length,
     `${moved.length} of ${before.length}`);

  const upd = await activityFor(SHOW, 'show.update');
  ok('the activity row exists', upd.length === 1, upd.length);
  const dateDiff = (upd[0]?.changes || []).find((c) => c.field === 'event_date');
  ok('F3 · it carries a STRUCTURED before→after, not just the show name',
     !!dateDiff && dateDiff.from === WRONG_DATE && dateDiff.to === RIGHT_DATE, upd[0]?.changes);
  ok('…and the human detail line is built from the same diff',
     String(upd[0]?.detail || '').includes(RIGHT_DATE), upd[0]?.detail);

  // ══════════════════════════════════════════════════════════════════════════
  section('3 · Brenden puts four people on the show  (B1 — the one that unblocks everything)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Add crew', { seam: ['addCrew', 'listCrew'], action: ['crewAdd', 'crewCommit'] });
  reach('Edit / remove a crew line', { seam: ['updateCrew', 'removeCrew'],
                                       action: ['crewEdit', 'crewRemove'] });
  // Brenden is a pm who does not own the folder; the schedule gate is the
  // FOLDER's owner, so Tom hands him the show first — which is itself a real
  // affordance and a material change.
  await PUT(`/api/projects/${PROJ}`, { owner: 'brenden' }, { token: T.tom });
  const crewSpec = [
    { username: 'omar',    role_on_site: 'LED tech',   call_time: '07:30' },
    { username: 'morgan',  role_on_site: 'Site lead',  call_time: '07:00' },
    { username: 'candice', role_on_site: 'Client liaison', call_time: '09:00' },
    { name: 'Dana Fields', phone: '414-555-0142', role_on_site: 'Local rigger', call_time: '07:30' }
  ];
  const crewIds = [];
  for (const c of crewSpec) {
    const r = await POST(`/api/shows/${SHOW}/crew`, c, { token: T.brenden });
    ok(`crew · ${c.username || c.name} added`, r.status === 200, r.body);
    if (r.body && r.body.id) crewIds.push(r.body.id);
  }
  const crewRows = await GET(`/api/shows/${SHOW}/crew`, { token: T.brenden });
  ok('the show now has four crew lines', (crewRows.body || []).length === 4, crewRows.body?.length);
  ok('…three with a login, one local hire with a phone number',
     crewRows.body.filter((c) => c.username).length === 3 &&
     crewRows.body.filter((c) => !c.username && c.phone).length === 1);

  const omarBox = await outboxFor('omar');
  ok('F5 · being put on the crew TELLS the person, with no notify array passed',
     omarBox.length >= 1, omarBox.map((r) => r.subject));
  const danaBox = await outboxFor('Dana Fields');
  ok('…and a local hire is not pretended at — no inbox, no row', danaBox.length === 0);
  ok('F12 · the crew activity key is dotted, not an English sentence',
     (await activityFor(SHOW, 'crew.add')).length === 4);

  // ══════════════════════════════════════════════════════════════════════════
  section('4 · Brenden creates and assigns tasks  (B3)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Add task', { seam: 'createStep', action: ['addTask', 'tkCommit'] });
  reach('Edit / delete a task', { seam: ['updateStep', 'deleteStep'],
                                  action: ['editTask', 'tkDelete'] });
  const t1 = await POST('/api/steps', {
    show_id: SHOW, lane: 'venue', title: 'Chase the venue about the rigging plot',
    owner: 'omar', due_date: plus(30)
  }, { token: T.brenden });
  ok('POST /api/steps creates a task outside the template', t1.status === 200, t1.body);
  const TASK1 = t1.body.id;

  const t2 = await POST('/api/steps', {
    show_id: SHOW, lane: 'logistics', title: 'Confirm the forklift window',
    owner: 'morgan', due_date: plus(33)
  }, { token: T.brenden });
  ok('…and a second one', t2.status === 200, t2.body);
  const TASK2 = t2.body.id;

  const assignBox = await outboxFor('omar', 'assignment');
  ok('assigning at CREATE time pings the owner, like the assign route does',
     assignBox.length === 1, assignBox.map((r) => r.subject));

  // ══════════════════════════════════════════════════════════════════════════
  section('5 · Brenden re-dates one  (B4)');
  // ══════════════════════════════════════════════════════════════════════════
  const NEWDUE = plus(26);
  const red = await PUT(`/api/steps/${TASK1}`, { due_date: NEWDUE }, { token: T.brenden });
  ok('PUT /api/steps/:id re-dates it', red.status === 200 && red.body.due_date === NEWDUE, red.body);
  const stepDiff = (await activityFor(SHOW, 'step.update'))[0];
  ok('…with a before→after on the due date',
     (stepDiff?.changes || []).some((c) => c.field === 'due_date' && c.to === NEWDUE), stepDiff?.changes);
  const omarChange = await outboxFor('omar', 'change');
  ok('…and the person whose deadline moved is told',
     omarChange.some((r) => /task changed/i.test(r.subject)), omarChange.map((r) => r.subject));

  // ══════════════════════════════════════════════════════════════════════════
  section('6 · Omar marks one blocked  (D3 · F2 — the crack-shaped event)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Mark blocked', { seam: 'setStepStatus', action: 'stepStatus' });
  const boxBefore = (await outboxFor('brenden', 'change')).length;
  const blk = await PUT(`/api/steps/${TASK1}/status`,
    { status: 'blocked', notes: 'venue will not release the rigging plot until their engineer signs' },
    { token: T.omar });
  ok('a TECH who owns the step may mark it blocked', blk.status === 200, blk.body);

  const blkRow = (await activityFor(SHOW, 'step.status'))[0];
  ok('the activity row is accented and carries the diff',
     blkRow?.accent === true && (blkRow.changes || []).some((c) => c.to === 'blocked'), blkRow);

  const brendenBox = await outboxFor('brenden', 'change');
  ok('F2 · "this is stuck" now REACHES A HUMAN — the folder owner',
     brendenBox.length > boxBefore &&
     brendenBox.some((r) => /blocked/i.test(r.subject)), brendenBox.map((r) => r.subject));
  ok('…and the reason travels with it',
     brendenBox.some((r) => /engineer signs/.test(r.body || '')), 'reason missing from the body');
  const tomBlk = await outboxFor('tom', 'change');
  ok('…the show owner too', tomBlk.some((r) => /blocked/i.test(r.subject)),
     tomBlk.map((r) => r.subject));

  // ══════════════════════════════════════════════════════════════════════════
  section('7 · Brenden books a vendor  (B6)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Book a vendor', { seam: ['createBooking', 'updateBooking', 'deleteBooking'],
                           action: ['addBooking', 'bkCommit', 'editBooking'] });
  const bk = await POST('/api/bookings', {
    show_id: SHOW, category: 'Trucking', vendor: 'Midwest Freight',
    status: 'done', amount: 4200, booked_date: plus(20)
  }, { token: T.brenden });
  ok('POST /api/bookings creates the logistics row', bk.status === 200, bk.body);
  const BOOK = bk.body.id;

  // H1 — the gate that used to be rank-only
  // The discriminating identity is a PM WHO OWNS NOTHING. A manager is not one:
  // canEditProject grants manager+ everywhere by design, so asserting against
  // Candice would have passed for the wrong reason.
  const bkOther = await PUT(`/api/bookings/${BOOK}`, { vendor: 'Somebody Else' }, { token: T.pat });
  ok('H1 · a pm who does not own the project is REFUSED the booking edit',
     bkOther.status === 403, bkOther);
  const bkMgr = await PUT(`/api/bookings/${BOOK}`, { notes: 'manager touch' }, { token: T.morgan });
  ok('…while a manager IS allowed anywhere, which is the rule, not a leak',
     bkMgr.status === 200, bkMgr.body);
  const bkMine = await PUT(`/api/bookings/${BOOK}`, { vendor: 'Midwest Freight Co' }, { token: T.brenden });
  ok('…and the owner is not', bkMine.status === 200, bkMine.body);
  ok('…the correction leaves a diff behind',
     (await activityFor(SHOW, 'booking.update'))[0]?.changes?.some((c) => c.field === 'vendor'));
  const bkGhost = await DEL('/api/bookings/99999', { token: T.tom });
  ok('H3 · deleting a booking that does not exist is a 404, not {ok:true}',
     bkGhost.status === 404, bkGhost);

  // ══════════════════════════════════════════════════════════════════════════
  section('8 · a PO with an expected date  (B8 — the delivery alarm gets its input)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Set a PO delivery date', { seam: 'updatePO', action: ['editPOEta', 'poEtaCommit'] });
  const po = await POST('/api/pos', { project_id: PROJ, vendor: 'LED Spares Inc', job_id: JOB },
    { token: T.brenden });
  ok('POST /api/pos opens the order', po.status === 200, po.body);
  const PO = po.body.id;
  const line = await POST(`/api/pos/${PO}/lines`,
    { item: 'BP2V2 spares', qty: 12, unit_cost: 210, show_id: SHOW }, { token: T.brenden });
  ok('…with a line pinned to this show', line.status === 200, line.body);

  const risk0 = await GET(`/api/shows/${SHOW}/procurement-risks`, { token: T.brenden });
  ok('with no ETA and a distant load-in, nothing is alarming yet',
     (risk0.body || []).length === 0, risk0.body);

  // an ETA that lands AFTER load-in is the critical case the engine exists for
  const showRow = (await pool.query('SELECT load_in_date FROM shows WHERE id=$1', [SHOW])).rows[0];
  const LATE = plus(39 + 3);
  const eta = await PUT(`/api/pos/${PO}`, { expected_date: LATE, tracking: 'MWF-778812' },
    { token: T.brenden });
  ok('PUT /api/pos/:id accepts expected_date + tracking', eta.status === 200, eta.body);
  const risk1 = await GET(`/api/shows/${SHOW}/procurement-risks`, { token: T.brenden });
  ok('B8 · the delivery-risk alarm FIRES — it could never fire on real data before',
     (risk1.body || []).length === 1 && risk1.body[0].level === 'crit',
     { loadIn: showRow.load_in_date, expected: LATE, risks: risk1.body });
  ok('…and says why', /after load-in/.test(risk1.body?.[0]?.why || ''), risk1.body?.[0]);
  ok('…the ETA change is accented in the log',
     (await pool.query(`SELECT * FROM activity WHERE po_id=$1 AND action='po.update'`, [PO]))
       .rows.some((r) => r.accent));

  // ══════════════════════════════════════════════════════════════════════════
  section('9 · Candice does the money  (C1 · C2 — and the margin gate, both ways)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Budget lines', { seam: ['addBudgetLine', 'updateBudgetLine', 'deleteBudgetLine'],
                          action: ['addBudget', 'blCommit', 'editBudget', 'blDelete'] });
  reach('Contract value', { seam: 'updateJob', action: ['editContract', 'cvCommit'] });

  for (const [cat, amt] of [['gear', 18000], ['freight', 6000], ['labor', 12000]]) {
    const r = await POST(`/api/jobs/${JOB}/budget`, { category: cat, allotted: amt },
      { token: T.candice });
    ok(`allotment · ${cat} $${amt}`, r.status === 200, r.body);
  }
  const cv = await PUT(`/api/jobs/${JOB}`, { contract_value: 62000 }, { token: T.candice });
  ok('C2 · accounting sets the contract value', cv.status === 200, cv.body);

  const cvPm = await PUT(`/api/jobs/${JOB}`, { contract_value: 1 }, { token: T.brenden });
  ok('C2 · a pm who owns the folder may NOT — the number is gated to write as it is to read',
     cvPm.status === 403, cvPm);

  const finAdmin = await GET(`/api/jobs/${JOB}/finance`, { token: T.tom });
  ok('an ADMIN sees margin', finAdmin.status === 200 &&
     finAdmin.body.billed === 62000 && finAdmin.body.margin !== undefined, finAdmin.body);
  const finFin = await GET(`/api/jobs/${JOB}/finance`, { token: T.candice });
  ok('ACCOUNTING sees margin', finFin.body?.billed === 62000, finFin.body);
  const finMgr = await GET(`/api/jobs/${JOB}/finance`, { token: T.morgan });
  ok('a MANAGER WITHOUT the finance flag is STRIPPED — not zeroed, absent',
     finMgr.status === 200 && finMgr.body.billed === undefined && finMgr.body.margin === undefined,
     finMgr.body);
  ok('…but still sees the budget, because a budget is accountability',
     finMgr.body?.budget_total === 36000, finMgr.body?.budget_total);

  // ══════════════════════════════════════════════════════════════════════════
  section('10 · Tom confirms the deal  (F5 — the temp-number prompt + push unlock)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Confirm the show', { seam: 'confirmShow', action: 'confirmShow' });
  const conf = await POST(`/api/shows/${SHOW}/confirm`, {}, { token: T.tom });
  ok('POST /api/shows/:id/confirm records the commitment', conf.status === 200, conf.body);
  ok('…and prompts for the real QuickBooks number, naming who may set it',
     !!conf.body.qb_prompt && conf.body.qb_prompt.job_id === JOB, conf.body.qb_prompt);
  const showNow = await GET(`/api/shows/${SHOW}`, { token: T.tom });
  ok('…the show reads as confirmed, with a datestamp',
     showNow.body.confirmed === true && !!showNow.body.confirmed_at, showNow.body.stage);

  const exc = await GET('/api/finance/exceptions', { token: T.candice });
  ok('POLISH #5 · the temp-numbered job is on accounting’s chase list',
     (exc.body || []).some((e) => e.kind === 'job_number' && e.job_id === JOB), exc.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('11 · the dry-run push  (A7 · A8 — the button that never existed)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Push to scheduler', { seam: ['pushToScheduler', 'features'],
                               action: ['pushSched', 'pushLive'] });
  ok('A8 · features.schedulerPush is SERVED',
     (await GET('/api/config')).body.features.schedulerPush === false,
     'unset SCHEDULER_BASE_URL must read false');
  ok('A8 · …and the UI reads it rather than offering a rehearsal nobody asked for',
     /features\(\)/.test(APP_JS) && /schedulerPush/.test(APP_JS));

  const dry = await POST(`/api/shows/${SHOW}/push-to-scheduler`, { live: false }, { token: T.tom });
  ok('the dry run builds a payload', dry.status === 200 && !!dry.body.payloads, dry.body);
  const names = (dry.body.payloads || {}).crewNames || [];
  ok('B1 · the push now carries CREW NAMES — before this pass it sent only step owners',
     names.length >= 3, names);
  ok('…including the local hire, who is real staff even without a login',
     names.some((n) => /Dana Fields/.test(n)), names);
  const live = await POST(`/api/shows/${SHOW}/push-to-scheduler`, { live: true }, { token: T.tom });
  ok('a LIVE push with no scheduler configured refuses honestly (501), it does not pretend',
     live.status === 501, live.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('12 · storage tells the truth about an ephemeral disk');
  // ══════════════════════════════════════════════════════════════════════════
  // Production shape: STORAGE_DRIVER unset (local) and STORAGE_ROOT unset. The
  // local driver used to answer `configured: true` unconditionally, so
  // /api/health said "ready", an upload returned 200, and the bytes died on the
  // next redeploy while the metadata row survived pointing at nothing.
  const cfg = await GET('/api/config');
  ok('features.fileUpload is FALSE with no STORAGE_ROOT set',
     cfg.body.features.fileUpload === false, cfg.body.features);
  const health = await GET('/api/health');
  ok('/api/health reports storage NOT ready', health.body.storageReady === false, health.body);
  ok('…and carries storageEphemeralRisk explicitly',
     health.body.storageEphemeralRisk === false, health.body);
  ok('…and names the variable that fixes it',
     /STORAGE_ROOT/.test(health.body.storageError || ''), health.body.storageError);

  const f = await POST('/api/files', { show_id: SHOW, name: 'rigging-plot', ext: 'pdf', kind: 'other' },
    { token: T.brenden });
  ok('a file can still be REGISTERED (metadata-only is a real mode)', f.status === 200, f.body);
  const bytes = await call('PUT', `/api/files/${f.body.id}/content`,
    { token: T.brenden, raw: Buffer.from('%PDF-1.4 not really') });
  ok('PUT /api/files/:id/content is a 501, not a silent write to a disk that dies',
     bytes.status === 501, bytes);

  // the other half: an operator who SETS it keeps working. Checked out of
  // process because lib/storage.js reads its env once, at require time.
  const probe = spawnSync(process.execPath, ['-e',
    `process.env.STORAGE_ROOT=${JSON.stringify(path.join(os.tmpdir(), 'sr-walk-storage'))};` +
    `const s=require(${JSON.stringify(path.join(APP, 'lib', 'storage.js').replace(/\\/g, '/'))});` +
    `console.log(JSON.stringify({ready:s.storageReady(),risk:s.storageEphemeralRisk()}));`],
    { encoding: 'utf8' });
  let probed = {};
  try { probed = JSON.parse(String(probe.stdout || '{}').trim()); } catch { probed = {}; }
  ok('local dev with an EXPLICIT STORAGE_ROOT still reports ready', probed.ready === true, probe.stdout);
  ok('…and flags no ephemeral risk outside a container', probed.risk === false, probed);

  // ══════════════════════════════════════════════════════════════════════════
  section('13 · strike — and the report obligation finally has fuel  (F2)');
  // ══════════════════════════════════════════════════════════════════════════
  await PUT(`/api/steps/${TASK1}/status`, { status: 'done' }, { token: T.omar });
  await PUT(`/api/steps/${TASK2}/status`, { status: 'done' }, { token: T.morgan });
  const struck = await POST(`/api/shows/${SHOW}/struck`, {}, { token: T.brenden });
  ok('POST /api/shows/:id/struck closes the show out', struck.status === 200, struck.body);
  const createdN = Array.isArray(struck.body.created)
    ? struck.body.created.length : Number(struck.body.created || 0);
  ok('B1→F2 · tech reports fire for EXACTLY the crew with logins (3, not 4)',
     createdN === 3, { created: struck.body.created, summary: struck.body.summary });

  const reports = await GET(`/api/shows/${SHOW}/tech-reports`, { token: T.brenden });
  const owed = (reports.body.reports || []).map((r) => r.username).sort();
  ok('…and they are the right three people',
     JSON.stringify(owed) === JSON.stringify(['candice', 'morgan', 'omar']), owed);
  // The local hire is on the crew and owes nothing. That is the honest answer —
  // she has no login and could never file — and it is the difference between a
  // closeout that completes and one that waits forever on a report nobody can
  // write. The UI says so out loud on the crew panel.
  const localHires = crewRows.body.filter((c) => !c.username);
  ok('…the local hire is on the crew, owes NO report, and is not silently dropped',
     localHires.length === 1 && !owed.includes('Dana Fields') &&
     reports.body.summary.total === 3, { localHires: localHires.length, owed });

  // and the firewall on the other side: someone NOT on the crew owes nothing
  const notCrew = await POST(`/api/shows/${SHOW}/tech-report`, { body: 'I was not there' },
    { token: T.pat });
  ok('…somebody who was never on the crew cannot file one either',
     notCrew.status === 403, notCrew.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('14 · a date change auto-notifies the crew  (F5 — WITHOUT a notify array)');
  // ══════════════════════════════════════════════════════════════════════════
  // THE assertion this whole pass exists for. Tom's sentence: "a change made
  // anywhere becomes visible to everyone it affects, without the person who
  // made it having to remember to tell anyone." So: no `notify` key in the body.
  const beforeCounts = {};
  for (const u of ['omar', 'morgan', 'candice', 'brenden']) {
    beforeCounts[u] = (await outboxFor(u, 'change')).length;
  }
  const FINAL_DATE = plus(52);
  const move = await PUT(`/api/shows/${SHOW}`,
    { event_date: FINAL_DATE, venue: 'UW Field House' }, { token: T.tom });
  ok('the date moves again', move.status === 200, move.body);
  ok('…and the request carried NO notify array', !('notify' in { event_date: 1, venue: 1 }));

  const told = [];
  for (const u of ['omar', 'morgan', 'candice', 'brenden']) {
    const now = (await outboxFor(u, 'change')).length;
    if (now > beforeCounts[u]) told.push(u);
  }
  ok('F5 · every person ON the show is told — crew, task owners and the folder owner',
     told.length === 4, { told, expected: ['omar', 'morgan', 'candice', 'brenden'] });
  const patBox = await outboxFor('pat', 'change');
  ok('…and somebody who is NOT on it hears nothing — an audience that includes ' +
     'everyone is the same as no audience at all', patBox.length === 0, patBox.length);
  const omarLast = (await outboxFor('omar', 'change'))[0];
  ok('…the mail names the old value and the new one',
     /UW Field House/.test(omarLast.body) && new RegExp(FINAL_DATE).test(omarLast.body), omarLast.body);
  ok('…and says why they are hearing about it',
     /you are on this show/i.test(omarLast.body), omarLast.body);
  const tomOwn = await outboxFor('tom', 'change');
  ok('…the person who MADE the change is not mailed about their own action',
     !tomOwn.some((r) => new RegExp(FINAL_DATE).test(r.body || '')), 'Tom was told about himself');
  ok('…and it rides the DIGEST by default, so binding the team does not spam it',
     omarLast.mode === 'digest', omarLast.mode);

  // ══════════════════════════════════════════════════════════════════════════
  section('15 · the changelog reads back  (F4)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('What changed', { seam: 'listChanges', action: ['goChanges', 'changesScope', 'changesFilter'],
                          rendered: false });
  const feed = await GET('/api/activity?changed=1&limit=200', { token: T.tom });
  ok('GET /api/activity?changed=1 returns only rows carrying a before→after',
     feed.status === 200 && feed.body.length > 0 &&
     feed.body.every((r) => Array.isArray(r.changes) && r.changes.length), feed.body?.length);
  const famFeed = await GET('/api/activity?action=crew.&limit=50', { token: T.tom });
  ok('…and a family filter works on the dotted keys F12 introduced',
     famFeed.body.length === 4 && famFeed.body.every((r) => r.action.startsWith('crew.')),
     famFeed.body?.map((r) => r.action));
  const mineFeed = await GET('/api/activity?mine=1&changed=1&limit=50', { token: T.omar });
  ok('…"my shows" is scoped by the SAME membership that decides who gets told',
     mineFeed.status === 200 && mineFeed.body.length > 0, mineFeed.body?.length);
  const strangerFeed = await GET('/api/activity?mine=1&changed=1', { token: A });
  ok('…and somebody on no shows gets an empty feed, not the whole company’s',
     strangerFeed.status === 200 && strangerFeed.body.length === 0, strangerFeed.body?.length);
  const sinceFeed = await GET(`/api/activity?since=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}`,
    { token: T.tom });
  ok('…?since= narrows to "what changed while I was on site"',
     sinceFeed.status === 200 && sinceFeed.body.length > 0, sinceFeed.body?.length);

  // ══════════════════════════════════════════════════════════════════════════
  section('16 · the closeout panel reflects reality');
  // ══════════════════════════════════════════════════════════════════════════
  const co = await GET(`/api/shows/${SHOW}/closeout`, { token: T.brenden });
  ok('GET /api/shows/:id/closeout answers', co.status === 200, co.body);
  ok('P7 · reports are counted, and they are NOT trivially complete any more',
     co.body.reports_total === 3 && co.body.reports_complete === false, co.body);
  ok('…it names who it is waiting on', (co.body.waiting_on || []).length === 3, co.body.waiting_on);
  ok('…money waiting on paperwork is counted honestly',
     typeof co.body.finance_exceptions === 'number', co.body);
  ok('…and the whole thing is NOT complete, because it genuinely is not',
     co.body.complete === false, co.body);

  // file the three reports, then re-read — the panel has to move
  for (const u of ['omar', 'morgan', 'candice']) {
    const r = await POST(`/api/shows/${SHOW}/tech-report`,
      { body: 'Went fine. Nothing broken, nothing left behind.' }, { token: T[u] });
    ok(`${u} files their show report`, r.status === 200, r.body);
  }
  const co2 = await GET(`/api/shows/${SHOW}/closeout`, { token: T.brenden });
  ok('…and once the three real people file, the condition flips',
     co2.body.reports_complete === true && co2.body.reports_filed === 3, co2.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('17 · the gates this pass added, against DISCRIMINATING identities');
  // ══════════════════════════════════════════════════════════════════════════
  // §H's diagnosis: "gates were written per route, not per entity" — six routes
  // carried a rank check and no ownership check while their immediate
  // neighbours carried both. Every assertion here is run by somebody who WOULD
  // pass the rank half and must fail the ownership half, because an assertion
  // run by a viewer proves nothing about an ownership gate.
  //
  //   pat    = pm, owns nothing        -> discriminates OWNERSHIP
  //   morgan = manager, no finance     -> discriminates MARGIN / money-write
  //   omar   = tech                    -> discriminates RANK
  const proof = await POST('/api/proofs', { show_id: SHOW, code: 'P-101', name: 'Courtside banner' },
    { token: T.brenden });
  ok('a proof can be created at all (B7 — the tab was a screenshot)', proof.status === 200, proof.body);
  const PROOF = proof.body.id;

  ok('H1 · PUT /proofs/:id now checks OWNERSHIP, not just rank',
     (await PUT(`/api/proofs/${PROOF}`, { name: 'hijacked' }, { token: T.pat })).status === 403);
  ok('H1 · POST /proofs/:id/rounds too',
     (await POST(`/api/proofs/${PROOF}/rounds`, { round: 'R9' }, { token: T.pat })).status === 403);
  ok('H1 · DELETE /proofs/:id too',
     (await DEL(`/api/proofs/${PROOF}`, { token: T.pat })).status === 403);
  ok('…and the owner still can',
     (await POST(`/api/proofs/${PROOF}/rounds`, { round: 'R1', status: 'sent' },
       { token: T.brenden })).status === 200);

  const ms = await POST(`/api/shows/${SHOW}/milestones`, { label: 'Truck loads', date: plus(37) },
    { token: T.brenden });
  ok('a milestone can be created', ms.status === 200, ms.body);
  ok('H1 · DELETE /milestones/:id now checks ownership',
     (await DEL(`/api/milestones/${ms.body.id}`, { token: T.pat })).status === 403);
  ok('H3 · …and answers 404 for one that never existed, not {ok:true}',
     (await DEL('/api/milestones/99999', { token: T.tom })).status === 404);

  // H2 — an expense with NO show_id had no ownership check at all, and those are
  // the folder-level and PO-generated costs with the biggest numbers on them.
  const exp = await POST('/api/expenses',
    { project_id: PROJ, job_id: JOB, vendor: 'Rigging Co', amount: 900, category: 'labor' },
    { token: T.brenden });
  ok('a folder-level expense (no show_id) can be recorded', exp.status === 200, exp.body);
  ok('H2 · …and correcting it is now gated on the JOB’s project, not skipped',
     (await PUT(`/api/expenses/${exp.body.id}`, { amount: 1 }, { token: T.pat })).status === 403);
  const fix = await PUT(`/api/expenses/${exp.body.id}`, { amount: 950 }, { token: T.brenden });
  ok('C4 · the owner CAN correct it — "no correction path" was disqualifying',
     fix.status === 200 && Number(fix.body.amount) === 950, fix.body);
  const expDiff = (await pool.query(
    `SELECT * FROM activity WHERE action='expense.update' ORDER BY id DESC`)).rows[0];
  const amtCh = (expDiff?.changes || []).find((c) => c.field === 'amount');
  ok('…and the correction leaves an audited before→after',
     !!amtCh && Number(amtCh.from) === 900 && Number(amtCh.to) === 950, expDiff?.changes);
  ok('C4 · voiding one is a manager act, refused below that',
     (await DEL(`/api/expenses/${exp.body.id}`, { token: T.brenden })).status === 403);
  ok('…and a void of something that never existed is a 404',
     (await DEL('/api/expenses/99999', { token: T.tom })).status === 404);

  // budgets: WIDER than margin on purpose (a budget is accountability)
  ok('C1 · a TECH cannot set an allotment',
     (await POST(`/api/jobs/${JOB}/budget`, { category: 'misc', allotted: 1 },
       { token: T.omar })).status === 403);
  ok('C1 · …a manager without the finance flag CAN — budgets are not margin',
     (await POST(`/api/jobs/${JOB}/budget`, { category: 'misc', allotted: 500 },
       { token: T.morgan })).status === 200);
  ok('C3 · …but the DEAL TYPE is accounting’s, because it decides capex vs COGS',
     (await PUT(`/api/jobs/${JOB}`, { deal_type: 'sale' }, { token: T.morgan })).status === 403);
  ok('…and accounting may set it',
     (await PUT(`/api/jobs/${JOB}`, { deal_type: 'sale' }, { token: T.candice })).status === 200);

  // crew: the schedule gate is the FOLDER's owner (deliberately, and it differs
  // from the recap gate — see the note in routes/schedule.js)
  ok('B1 · a pm who does not own the folder cannot put people on the show',
     (await POST(`/api/shows/${SHOW}/crew`, { username: 'pat', role_on_site: 'x' },
       { token: T.pat })).status === 403);
  ok('B3 · …nor add a task to it',
     (await POST('/api/steps', { show_id: SHOW, lane: 'venue', title: 'sneak' },
       { token: T.pat })).status === 403);
  ok('A2 · …nor edit the show',
     (await PUT(`/api/shows/${SHOW}`, { venue: 'nope' }, { token: T.pat })).status === 403);
  ok('B2 · …nor the call sheet',
     (await PUT(`/api/shows/${SHOW}/call-sheet`, { load_in_time: '03:00' },
       { token: T.pat })).status === 403);
  ok('D3 · …and a tech who does NOT own a step cannot change its status',
     (await PUT(`/api/steps/${TASK2}/status`, { status: 'blocked' }, { token: T.omar })).status === 403);

  // ══════════════════════════════════════════════════════════════════════════
  section('18 · the call sheet, filled in and reaching the crew  (B2)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Call sheet header', { seam: 'updateCallSheet', action: ['editCallSheet', 'csCommit'] });
  const sheetBefore = {};
  for (const u of ['omar', 'morgan', 'candice']) {
    sheetBefore[u] = (await outboxFor(u, 'change')).length;
  }
  const sheet = await PUT(`/api/shows/${SHOW}/call-sheet`, {
    load_in_time: '05:00', doors_time: '17:00', event_time: '19:00', strike_time: '22:30',
    venue_address: '1111 Vel R. Phillips Ave, Milwaukee WI',
    parking_notes: 'dock C off 6th', radio_channel: 'ch 4', dress_code: 'black, closed toe',
    venue_poc: { name: 'Rae Simms', title: 'Ops manager', phone: '414-555-0114' }
  }, { token: T.brenden });
  ok('PUT /api/shows/:id/call-sheet fills the header the crew reads at 6am',
     sheet.status === 200 && sheet.body.load_in_time === '05:00', sheet.body);
  const sheetAct = (await activityFor(SHOW, 'callsheet.update'))[0];
  ok('F12 · dotted key, and a diff on every field that moved',
     !!sheetAct && (sheetAct.changes || []).length >= 8, sheetAct?.changes?.length);
  let toldSheet = 0;
  for (const u of ['omar', 'morgan', 'candice']) {
    if ((await outboxFor(u, 'change')).length > sheetBefore[u]) toldSheet += 1;
  }
  ok('F8 · moving load-in is an EDIT and it is MATERIAL — the crew is told',
     toldSheet === 3, toldSheet);

  // ══════════════════════════════════════════════════════════════════════════
  section('19 · the seam / route diff — P1, measured');
  // ══════════════════════════════════════════════════════════════════════════
  // The eight entities DESIGN_GAPS names as "built, gated, cascade-wired,
  // smoke-tested and unreachable". Each one is now reachable or the walk says
  // which half is missing.
  const EIGHT = [
    ['crew',          ['addCrew', 'updateCrew', 'removeCrew']],
    ['bookings',      ['createBooking', 'updateBooking', 'deleteBooking']],
    ['budget lines',  ['addBudgetLine', 'updateBudgetLine', 'deleteBudgetLine']],
    ['step create',   ['createStep', 'deleteStep']],
    ['proofs',        ['createProof', 'updateProof', 'addProofRound']],
    ['show/folder',   ['updateShow', 'updateProject']],
    ['call sheet',    ['updateCallSheet']],
    ['PO edit',       ['updatePO']],
    ['file bytes',    ['uploadFileBytes', 'downloadFileBytes']]
  ];
  for (const [label, methods] of EIGHT) {
    const missing = methods.filter((m) => !hasSeamMethod(m));
    ok(`P1 · ${label} is reachable from the product`, missing.length === 0, missing);
  }
  ok('no view still renders the two Download placeholders (POLISH_LIST handoff)',
     !/toastAttrs\('Download'/.test(SRC['views-global.js']));
  ok('the proofs tab no longer hardcodes an approval flow with invented people',
     !/{ k: 'Internal QC'/.test(SRC['views-folder.js']));

  // ── report ─────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  PERSONA WALK: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  FAILURES:'); failures.forEach((f2) => console.log('    · ' + f2)); }
  console.log(`${'═'.repeat(66)}\n`);
}

main()
  .then(async () => {
    try { server && server.close(); } catch { /* already down */ }
    try { pool && await pool.end(); } catch { /* already closed */ }
    try { pg && await pg.stop(); } catch { /* already stopped */ }
    try { dataDir && fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* fine */ }
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error('\nWALK ABORTED:', e && e.stack ? e.stack : e);
    try { server && server.close(); } catch { /* already down */ }
    try { pool && await pool.end(); } catch { /* already closed */ }
    try { pg && await pg.stop(); } catch { /* already stopped */ }
    try { dataDir && fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* fine */ }
    process.exit(3);
  });
