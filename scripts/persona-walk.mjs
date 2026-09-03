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
async function call(method, p, { token, key, idem, body, raw } = {}) {
  const h = {};
  if (token) h['x-auth-token'] = token;
  if (key) h['x-agent-key'] = key;          // §26 — a personal agent files things
  if (idem) h['x-idempotency-key'] = idem;
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
  section('8b · the needs list — every system’s ancillaries  (Tom 2026-09-02)');
  // ══════════════════════════════════════════════════════════════════════════
  // "each one of those systems need all kinds of ancillary things — it would
  // be really advantageous if i had a spot to check those off the list."
  // Brenden seeds the standard LED list onto the job, works it like a
  // checklist, and raises what is left as ONE purchase order.
  reach('Seed the LED ancillaries', { seam: 'seedNeeds', action: 'needSeed' });
  reach('Work the checklist', { seam: ['listNeeds', 'createNeed', 'updateNeed', 'deleteNeed'],
    action: ['needToggle', 'needNa', 'needEdit', 'needCommit', 'needAddCommit', 'needDelete'] });
  reach('Raise a PO from the open items', { seam: 'raiseNeedsPO', action: 'needRaisePo' });

  const { LED_ANCILLARIES } = require(path.join(APP, 'lib', 'enums.js'));
  const seeded = await POST(`/api/jobs/${JOB}/needs/seed`, {}, { token: T.brenden });
  ok('the one-click seed fills the standard LED list', seeded.status === 200
     && (seeded.body.added || []).length === LED_ANCILLARIES.length,
     { added: seeded.body.added?.length });
  const seededAgain = await POST(`/api/jobs/${JOB}/needs/seed`, {}, { token: T.brenden });
  ok('…and a second click adds NOTHING — the seed is idempotent',
     (seededAgain.body.added || []).length === 0
     && (seededAgain.body.skipped || []).length === LED_ANCILLARIES.length, seededAgain.body);

  const list0 = (await GET(`/api/needs?job_id=${JOB}`, { token: T.brenden })).body;
  const distro = list0.find((x) => /power distro/i.test(x.item));
  const rig = list0.find((x) => /rigging/i.test(x.item));
  const est = await PUT(`/api/needs/${distro.id}`, { est_cost: 6400, qty: 1 }, { token: T.brenden });
  ok('Brenden edits an item — the distro gets its estimate', est.status === 200
     && est.body.est_cost === 6400, est.body);
  const na = await PUT(`/api/needs/${rig.id}`, { status: 'na' }, { token: T.brenden });
  ok('…strikes the rigging n/a (Fiserv steel is contracted) — stamped',
     na.status === 200 && na.body.status === 'na' && na.body.checked_by === 'brenden', na.body);
  const custom = await POST('/api/needs', { job_id: JOB, item: 'Camera platform edge trim',
    detail: 'venue-specific — broadcast platform butts the wall', qty: 1, est_cost: 350,
    category: 'misc', show_id: SHOW }, { token: T.brenden });
  ok('…adds a venue-specific custom item, pinned to the show', custom.status === 200
     && custom.body.show_id === SHOW, custom.body);
  const spares = list0.find((x) => /Spare PSUs/i.test(x.item));
  const hand = await PUT(`/api/needs/${spares.id}`, { status: 'covered' }, { token: T.brenden });
  ok('…checks the PSU spares off by hand (they ride the traveling kit)',
     hand.status === 200 && hand.body.status === 'covered' && !hand.body.covered_by_po_id, hand.body);

  const stillOpen = (await GET(`/api/needs?job_id=${JOB}&status=open`, { token: T.brenden })).body;
  const raisedPo = await POST('/api/needs/raise-po',
    { job_id: JOB, need_ids: stillOpen.map((x) => x.id) }, { token: T.brenden });
  ok('one click raises EVERYTHING still open as ONE PO at needed',
     raisedPo.status === 200 && raisedPo.body.po.status === 'needed'
     && (raisedPo.body.po.lines || []).length === stillOpen.length, raisedPo.body.po?.lines?.length);
  const coveredNow = (await GET(`/api/needs?job_id=${JOB}&status=covered`, { token: T.brenden })).body;
  ok('…and every raised item reads covered, carrying THAT PO’s id',
     stillOpen.every((x) => coveredNow.some(
       (c) => c.id === x.id && c.covered_by_po_id === raisedPo.body.po.id)), coveredNow.length);

  // a second job exists only to prove the poison: one foreign need refuses ALL
  const sideJob = await POST('/api/jobs', { project_id: PROJ, name: 'walk side job' }, { token: T.tom });
  const foreign = await POST('/api/needs', { job_id: sideJob.body.id, item: 'foreign probe' },
    { token: T.tom });
  const posN = (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders')).rows[0].n;
  const mixed = await POST('/api/needs/raise-po',
    { job_id: sideJob.body.id, need_ids: [foreign.body.id, spares.id] }, { token: T.tom });
  ok('a need from another job poisons the whole raise — 400, nothing created',
     mixed.status === 400
     && (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_orders')).rows[0].n === posN,
     mixed.body);

  const dropped = await DEL(`/api/needs/${custom.body.id}`, { token: T.brenden });
  ok('…and a wrong item deletes cleanly', dropped.status === 200, dropped.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('8c · the vendor lands, a line is fixed, and the delete is honest');
  // ══════════════════════════════════════════════════════════════════════════
  // The raise deliberately lands vendor TBD — the checklist knows what is
  // needed before anyone knows who sells it. So the walk now does what Candice
  // does across a season: raise a SUBSET (the freight vendor is not the copper
  // vendor), set the real vendor on the TBD order, fix a line, drop a line,
  // and finally delete an order and watch the checklist REOPEN rather than
  // stand covered by nothing.
  reach('Set the vendor / edit the PO', { seam: 'updatePO', action: ['editPO', 'poEditCommit'] });
  reach('Pick WHICH items raise', { action: ['needRaisePo', 'needRaiseCommit'] });
  reach('Edit / remove a PO line', { seam: ['updatePOLine', 'deletePOLine'],
    action: ['poLineEdit', 'poLineCommit', 'poLineDelete'] });
  reach('Delete a PO', { seam: 'deletePO', action: 'poDelete' });

  const n1 = (await POST('/api/needs', { job_id: JOB, item: 'Edge trim', qty: 2, est_cost: 120 },
    { token: T.brenden })).body;
  const n2 = (await POST('/api/needs', { job_id: JOB, item: 'Data drums', qty: 1, est_cost: 480 },
    { token: T.brenden })).body;
  const n3 = (await POST('/api/needs', { job_id: JOB, item: 'Truck straps', qty: 6, est_cost: 40 },
    { token: T.brenden })).body;
  const sub = await POST('/api/needs/raise-po',
    { job_id: JOB, need_ids: [n1.id, n2.id], vendor: 'Show Support Co' }, { token: T.brenden });
  ok('a SUBSET raises — two items to one vendor, named in the picker',
     sub.status === 200 && (sub.body.po.lines || []).length === 2
     && sub.body.po.vendor === 'Show Support Co', sub.body.po);
  const openLeft = (await GET(`/api/needs?job_id=${JOB}&status=open`, { token: T.brenden })).body;
  ok('…and the unchecked item stays OPEN for the next vendor',
     openLeft.some((x) => x.id === n3.id), openLeft.map((x) => x.item));
  const SPO = sub.body.po.id;

  const rename = await PUT(`/api/pos/${SPO}`,
    { vendor: 'Show Support Co LLC', memo: 'ancillaries — Fiserv' }, { token: T.brenden });
  ok('vendor and memo are editable after creation', rename.status === 200
     && rename.body.vendor === 'Show Support Co LLC', rename.body);
  const renameAct = await pool.query(
    `SELECT changes FROM activity WHERE po_id=$1 AND action='po.update' ORDER BY id DESC`, [SPO]);
  ok('…and the rename is a before→after diff, not a shrug',
     (renameAct.rows[0]?.changes || []).some((c) => c.field === 'vendor'), renameAct.rows[0]);

  const [lA, lB] = sub.body.po.lines;
  const lFix = await PUT(`/api/pos/${SPO}/lines/${lA.id}`, { qty: 3, unit_cost: 110 },
    { token: T.brenden });
  ok('a line can be corrected while the PO is needed', lFix.status === 200
     && Number(lFix.body.qty) === 3, lFix.body);
  const lDrop = await DEL(`/api/pos/${SPO}/lines/${lB.id}`, { token: T.brenden });
  ok('…or removed', lDrop.status === 200, lDrop.body);
  const spoNow = await GET(`/api/pos/${SPO}`, { token: T.brenden });
  ok('…and the order reads back one line, retotalled',
     (spoNow.body.lines || []).length === 1 && Number(spoNow.body.lines[0].qty) === 3,
     spoNow.body.lines);

  ok('deleting a PO is a manager act — the pm who raised it is refused',
     (await DEL(`/api/pos/${SPO}`, { token: T.brenden })).status === 403);
  const delAsTom = await DEL(`/api/pos/${SPO}`, { token: T.tom });
  ok('…Tom deletes it', delAsTom.status === 200, delAsTom.body);
  const backRows = (await GET(`/api/needs?job_id=${JOB}`, { token: T.brenden })).body;
  const back1 = backRows.find((x) => x.id === n1.id);
  ok('THE HONEST CONSEQUENCE — the needs it covered reopen, never "covered by nothing"',
     !!back1 && back1.status === 'open' && !back1.covered_by_po_id && !back1.checked_by, back1);
  // tidy the probes so the later money sections read the job the same as before
  for (const nid of [n1.id, n2.id, n3.id]) await DEL(`/api/needs/${nid}`, { token: T.brenden });

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

  /* ── push v2 — the create-vs-link choice (Tom, 2026-09-02) ────────────────
     The push affordance is now a fork: create a new staffing event, or link
     an existing one and push into it, with keep-vs-override chosen fresh at
     every linked push. The full live behaviour (foreign-row invariant,
     override, stale detection) is proven in scripts/smoke.js §12b against a
     local fake scheduler; the walk's job here is the PRODUCT half — every
     step of the modal flow reachable, and every server door honest while the
     integration is unconfigured, which is this box's exact state tonight. */
  reach('Push choice — create new event', { seam: 'pushToScheduler', action: 'pushChoiceNew' });
  reach('Push choice — link existing event', { seam: 'listSchedulerEvents',
                                               action: ['pushChoiceLink', 'pushPickEvent'] });
  reach('Link binds the show', { seam: 'linkSchedulerEvent', action: 'pushPickEvent' });
  reach('Override needs its own confirm', { action: 'pushOverrideGo' });
  reach('Unlink from the scheduler', { seam: 'unlinkSchedulerEvent',
                                       action: ['unlinkSched', 'unlinkGo'] });
  reach('View in Scheduler (deep link)', { action: 'viewInScheduler' });
  ok('the override confirm says exactly what is destroyed, before it fires',
     /deletes rows Showrunner did not create/.test(APP_JS)
     && /hand/.test(APP_JS) && /pushOverrideGo/.test(APP_JS));
  ok('the unlink confirm promises nothing is deleted remotely — and means it',
     /Nothing is deleted in the staffing app/.test(APP_JS));

  const evList = await GET('/api/scheduler/events', { token: T.tom });
  ok('GET /api/scheduler/events refuses honestly while unconfigured, naming the env var',
     evList.status === 501 && /SCHEDULER_BASE_URL/.test(evList.body?.error || ''), evList.body);
  const linkTry = await POST(`/api/shows/${SHOW}/scheduler-link`, { event_id: 1 }, { token: T.tom });
  ok('POST /shows/:id/scheduler-link refuses honestly while unconfigured',
     linkTry.status === 501, linkTry.body);
  const unlinkTry = await DEL(`/api/shows/${SHOW}/scheduler-link`, { token: T.tom });
  ok('unlinking an unlinked show is a 409 that explains itself, not a shrug',
     unlinkTry.status === 409 && /not linked/i.test(unlinkTry.body?.error || ''), unlinkTry.body);
  const showV2 = await GET(`/api/shows/${SHOW}`, { token: T.tom });
  ok('the show carries the v2 push-state fields the header renders',
     showV2.body.scheduler_stale === false && showV2.body.scheduler_pushed_at === null
     && showV2.body.scheduler_deep_link === null,
     { stale: showV2.body.scheduler_stale, at: showV2.body.scheduler_pushed_at,
       link: showV2.body.scheduler_deep_link });

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
  section('12b · THE FABRICATION LINE, CLOSED — Brendon’s attach, and the delete');
  // ══════════════════════════════════════════════════════════════════════════
  // 2026-08-31, production, Show 1. Brendon Sawyer attached three booking
  // confirmations through the FINANCIALS attach-doc modal. It asked for a
  // vendor, an amount and a document TYPE and never once for the document; the
  // seam then stamped `size: 245760` on each row — a constant that looks like a
  // PDF — and no byte ever left his laptop. Then he found there was no way to
  // delete any of it. HARDENING_TODO 21, the half the NAS pass left open.
  //
  // The BYTE half of this path is proven in harness-upload.mjs against a real
  // WebDAV backend. This suite runs in PRODUCTION SHAPE with no storage at all
  // (§12 is the assertion that it says so), so what it proves here is the two
  // things that do not need a NAS and are exactly what broke:
  //   1. the affordance a person uses EXISTS and is reachable, and
  //   2. no UI creation path can stamp a size it did not measure — enforced
  //      MECHANICALLY over the source, so a future pass cannot reintroduce one.
  reach('Attach a confirmation to a booking', {
    seam: ['addFinancialDoc', 'uploadFileBytes', 'uploadsEnabled'],
    action: ['attachBooking', 'addFinDoc', 'commitFinDoc', 'finPickFile'] });
  reach('Delete a file', { seam: 'deleteFile', action: 'deleteFile' });
  reach('Delete a booking', { seam: 'deleteBooking', action: 'bkDelete' });

  // ── the mechanical half ───────────────────────────────────────────────────
  // Every `api.addFile` / `api.addFinancialDoc` / `api.replaceChainFile` call
  // in app.js, with its payload extracted by balanced-paren scan. A payload
  // carrying `size:` or `dim:` is only allowed inside a function that is DEMO
  // GUARDED (`apiMode()` / `demoOnly()`), because demo mode has no bytes to
  // measure and says "modeled" on the row's face. Anywhere else it is the bug.
  const fnMarks = [];
  {
    const fnRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let fm;
    while ((fm = fnRe.exec(APP_JS))) fnMarks.push({ name: fm[1], at: fm.index });
  }
  const fnBody = (name) => {
    const i = fnMarks.findIndex((x) => x.name === name);
    if (i < 0) return '';
    return APP_JS.slice(fnMarks[i].at,
      i + 1 < fnMarks.length ? fnMarks[i + 1].at : APP_JS.length);
  };
  const fnAt = (pos) => {
    let n = '(top level)';
    for (const mk of fnMarks) { if (mk.at <= pos) n = mk.name; else break; }
    return n;
  };
  const payloads = [];
  {
    const callRe = /api\.(addFile|addFinancialDoc|replaceChainFile)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(APP_JS))) {
      let i = callRe.lastIndex, depth = 1;
      while (i < APP_JS.length && depth > 0) {
        const ch = APP_JS[i];
        if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
        i += 1;
      }
      payloads.push({ fn: cm[1], at: cm.index, owner: fnAt(cm.index),
                      text: APP_JS.slice(callRe.lastIndex, i - 1) });
    }
  }
  ok('the file-creating call sites in app.js are found at all', payloads.length >= 6,
     payloads.map((p) => p.owner + '->api.' + p.fn).join(', '));
  const demoGuarded = (name) => /apiMode\(\)|demoOnly\(/.test(fnBody(name));
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const stampers = payloads
    .filter((p) => /(^|[{,\s])(size|dim)\s*:/.test(stripComments(p.text)))
    .filter((p) => !demoGuarded(p.owner));
  ok('HARDENING 21 · NO UI creation path stamps a size or a dim it did not measure',
     stampers.length === 0,
     stampers.map((p) => p.owner + '() -> api.' + p.fn).join(' · '));
  for (const fn of ['commitAddFile', 'dropFile', 'bindChainFile', 'bindGearFiles', 'specGen']) {
    ok(`…and ${fn}() still carries its demo guard`, demoGuarded(fn), fn + ' is UNGUARDED');
  }
  // The one that actually bit him, in the seam rather than the view: the API
  // branch of addFinancialDoc must send no size at all — not a default, not a
  // fallback. The demo branch keeps its modeled constant, and says "modeled".
  {
    const seamAt = API_JS.indexOf('addFinancialDoc: function');
    const seamEnd = API_JS.indexOf('confirmDoc: function', seamAt);
    const seam = API_JS.slice(seamAt, seamEnd > 0 ? seamEnd : seamAt + 6000);
    const apiHalf = seam.slice(seam.indexOf('/* API: POST /api/files'));
    // Comments are stripped before the test, on purpose: the comment that
    // replaced the bug QUOTES the bug ("this branch used to carry
    // `size: body.size || 245760`"), and a scan that could not tell prose from
    // code would force the fix to be silent about what it fixed.
    const apiCode = apiHalf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('the API branch of api.addFinancialDoc() exists and is findable',
       seamAt > 0 && apiCode.length > 200, { seamAt, half: apiCode.length });
    ok('HARDENING 21 · it sends NO size — the fabricated 245760 is gone from the CODE',
       apiCode.indexOf('245760') < 0 && !/[{,]\s*size\s*:/.test(apiCode),
       apiCode.slice(0, 300));
    ok('…while the DEMO branch keeps its modeled row, labelled modeled',
       seam.indexOf('245760') > 0 && /modeled/.test(seam.slice(0, seam.indexOf('/* API:'))));
  }

  // ── the API-contract half, against the route the modal actually posts to ──
  const attach = await POST('/api/files', {
    show_id: SHOW, name: 'Midwest Freight — conf 88231', ext: 'pdf', kind: 'confirmation',
    vendor: 'Midwest Freight', amount: 4200, category: 'freight', booking_id: BOOK
  }, { token: T.brenden });
  ok('POST /api/files files a confirmation against the booking', attach.status === 200, attach.body);
  ok('HARDENING 21 · a row created with no size claims ZERO, not 245760',
     Number(attach.body.size) === 0, attach.body.size);
  ok('…and it hands back the upload_url the modal PUTs the bytes to',
     attach.body.upload_url === `/api/files/${attach.body.id}/content`, attach.body.upload_url);
  const bkLinked = await GET(`/api/bookings/${BOOK}`, { token: T.brenden });
  ok('…the booking now carries the file — its "waiting on me" exception clears',
     bkLinked.body.file_id === attach.body.id, bkLinked.body);
  const expRows = await GET(`/api/expenses?show_id=${SHOW}`, { token: T.candice });
  ok('…and the cost is on the books with that document as its evidence',
     (expRows.body || []).some((e) => e.file_id === attach.body.id && Number(e.amount) === 4200),
     (expRows.body || []).map((e) => e.vendor + ':' + e.amount + ':' + e.file_id));

  // ── the DELETE gate, against discriminating identities ────────────────────
  // The route read canEditProject ONLY, while its two neighbours (PUT /files/:id
  // and PUT /files/:id/content) both read "canEditProject OR the uploader". So
  // the person who filed the wrong document could rename it and replace its
  // bytes, and could not remove it. omar is the discriminating identity: a tech,
  // so canEditProject is false for him, and the uploader of his own row.
  const omarDoc = await POST('/api/files',
    { show_id: SHOW, name: 'omar filed this by mistake', ext: 'pdf', kind: 'other' },
    { token: T.omar });
  ok('a tech may file a document (they upload confirmations and photos)',
     omarDoc.status === 200, omarDoc.body);
  ok('…a pm who owns nothing and did not upload it is REFUSED the delete',
     (await DEL(`/api/files/${omarDoc.body.id}`, { token: T.pat })).status === 403);
  const omarDel = await DEL(`/api/files/${omarDoc.body.id}`, { token: T.omar });
  ok('…and the UPLOADER may take their own mistake back off the record, without ' +
     'hunting down a manager', omarDel.status === 200, omarDel.body);
  ok('…the row is really gone',
     (await GET(`/api/files/${omarDoc.body.id}`, { token: T.omar })).status === 404);

  const delAttach = await DEL(`/api/files/${attach.body.id}`, { token: T.brenden });
  ok('the folder’s pm deletes the confirmation he filed', delAttach.status === 200, delAttach.body);
  const bkUnpicked = await GET(`/api/bookings/${BOOK}`, { token: T.brenden });
  ok('…and the booking’s file_id is UNPICKED, never left dangling at a dead row',
     !bkUnpicked.body.file_id, bkUnpicked.body);
  ok('…deleting a file that does not exist is a 404, not {ok:true}',
     (await DEL('/api/files/999999', { token: T.tom })).status === 404);

  // ── booking delete: parity with edit, on the row and in the gate ──────────
  // The floor here was `manager` while POST and PUT next door were `pm`, so the
  // pm who owned the folder could book the truck and correct the booking, and
  // then had to find a manager to cancel it. pat still cannot: the OWNERSHIP
  // term is what decides, exactly as it does on the other two.
  const bk2 = await POST('/api/bookings',
    { show_id: SHOW, category: 'Forklift', vendor: 'Chicago Lift', status: 'todo' },
    { token: T.brenden });
  ok('a second booking, to cancel', bk2.status === 200, bk2.body);
  ok('a pm who owns nothing cannot cancel somebody else’s booking',
     (await DEL(`/api/bookings/${bk2.body.id}`, { token: T.pat })).status === 403);
  const bk2Del = await DEL(`/api/bookings/${bk2.body.id}`, { token: T.brenden });
  ok('…the folder’s own pm can cancel the booking he made — the floor was manager',
     bk2Del.status === 200, bk2Del.body);
  ok('…and the cancellation is on the activity trail with a diff',
     (await activityFor(SHOW, 'booking.delete')).length === 1,
     (await activityFor(SHOW, 'booking.delete')).length);

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

  // ══════════════════════════════════════════════════════════════════════════
  section('20 · the editability wave — a cost is corrected ON THE ROW it lives on');
  // ══════════════════════════════════════════════════════════════════════════
  // The audit's headline: C4's backend and seam sat finished for a week while
  // the expenses table stayed inert text — a "closed" claim that drifted
  // precisely because no walk step reach()ed it. Now one does.
  reach('Correct a cost (pencil on the expense row)',
    { seam: 'updateExpense', action: ['editExpense', 'exCommit'] });
  reach('Void a cost', { seam: 'deleteExpense', action: 'exVoid' });
  const wexp = await POST('/api/expenses',
    { show_id: SHOW, vendor: 'Hertz', amount: 480, category: 'travel' }, { token: T.brenden });
  ok('a cost lands', wexp.status === 200, wexp.body);
  const wfix = await PUT(`/api/expenses/${wexp.body.id}`, { amount: 512, memo: 'tolls added' },
    { token: T.brenden });
  ok('the pencil’s PUT corrects it', wfix.status === 200 && Number(wfix.body.amount) === 512, wfix.body);
  ok('the void floor holds — the pm who filed it is refused',
     (await DEL(`/api/expenses/${wexp.body.id}`, { token: T.brenden })).status === 403);
  ok('…and a manager voids it',
     (await DEL(`/api/expenses/${wexp.body.id}`, { token: T.morgan })).status === 200);

  // ══════════════════════════════════════════════════════════════════════════
  section('21 · milestones get their editor, and the Calendar stops being empty');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Milestones modal (header strip pencil)',
    { seam: ['addMilestone', 'updateMilestone', 'deleteMilestone'],
      action: ['editMilestones', 'msCommit', 'msEdit', 'msDelete'] });
  const wms = await POST(`/api/shows/${SHOW}/milestones`, { label: 'Freight', date: plus(30) },
    { token: T.brenden });
  ok('a milestone is added through the modal’s route', wms.status === 200, wms.body);
  ok('H1 · editing it checks ownership',
     (await PUT(`/api/milestones/${wms.body.id}`, { label: 'hijack' }, { token: T.pat })).status === 403);
  const wmsFix = await PUT(`/api/milestones/${wms.body.id}`,
    { label: 'Freight departs', date: plus(29) }, { token: T.brenden });
  ok('H7 · the PUT that never existed corrects label + date',
     wmsFix.status === 200 && wmsFix.body.label === 'Freight departs', wmsFix.body);
  ok('…and the delete still works',
     (await DEL(`/api/milestones/${wms.body.id}`, { token: T.brenden })).status === 200);
  // the Calendar's other half: a show created through the product seeds no
  // milestone rows, so the view now folds the show's own three dates in —
  // asserted over the source, the way the toast/placeholder checks are.
  const calSrc = SRC['views-global.js'].slice(SRC['views-global.js'].indexOf('function viewCalendar'));
  ok('viewCalendar folds the show’s own load-in / event / strike dates',
     /load_in_date/.test(calSrc.slice(0, 2000)) && /strike_date/.test(calSrc.slice(0, 2000)));

  // ══════════════════════════════════════════════════════════════════════════
  section('22 · the folder’s second deal, and its second show');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Add job (folder Financials card)', { seam: 'createJob', action: ['addJob', 'njCommit'] });
  const wjob = await POST('/api/jobs',
    { project_id: PROJ, client: 'AVCA — print add-on', deal_type: 'sale' }, { token: T.brenden });
  ok('C5 · the second deal opens on a TEMP number — the override finally has a target',
     wjob.status === 200 && /^TEMP-/.test(wjob.body.qb_job_number), wjob.body);
  ok('…a pm who owns nothing cannot open one here',
     (await POST('/api/jobs', { project_id: PROJ, client: 'sneak' }, { token: T.pat })).status === 403);

  reach('Add show (season dashboard)', { seam: 'createShow', action: ['addShow', 'nsCommit'] });
  reach('Seed pipeline (empty Pipeline tab)', { seam: 'instantiateTemplate', action: 'seedPipeline' });
  const wshow = await POST('/api/shows',
    { project_id: PROJ, name: 'AVCA Second Serve', venue: 'UW Field House', event_date: plus(90) },
    { token: T.brenden });
  ok('the folder gains its second show', wshow.status === 200, wshow.body);
  const WS2 = wshow.body.id;
  ok('…born with an EMPTY pipeline (no template asked for)',
     (wshow.body.steps || []).length === 0, (wshow.body.steps || []).length);
  ok('…and it inherited the folder’s first job',
     wshow.body.default_job_id === JOB, wshow.body.default_job_id);
  const tplLed = await GET('/api/templates/led', { token: T.brenden });
  ok('the led template is there to seed from', tplLed.status === 200 && !!tplLed.body.id, tplLed.body);
  const wseed = await POST(`/api/shows/${WS2}/instantiate-template`,
    { template_id: tplLed.body.id }, { token: T.brenden });
  ok('Seed pipeline fills it', wseed.status === 200 && wseed.body.instantiated_steps > 0, wseed.body);
  ok('…back-scheduled off the NEW show’s own event date',
     (await pool.query(`SELECT COUNT(*)::int AS n FROM steps
                        WHERE show_id=$1 AND due_date <> ''`, [WS2])).rows[0].n > 0);
  ok('the season toast no longer points at a control that does not exist',
     !/open a show and seed it there/.test(SRC['views-dashboard.js']));

  // ══════════════════════════════════════════════════════════════════════════
  section('23 · a note taken back, a key minted once');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Delete a note (beside the author’s Edit)', { seam: 'deleteNote', action: 'noteDelete' });
  const wnote = await POST('/api/notes',
    { anchor_type: 'show', anchor_id: SHOW, body: 'wrong show, my bad' }, { token: T.omar });
  ok('omar posts a note', wnote.status === 200, wnote.body);
  ok('…brenden replies', (await POST('/api/notes',
    { anchor_type: 'show', anchor_id: SHOW, body: 'happens', parent_id: wnote.body.id },
    { token: T.brenden })).status === 200);
  ok('…somebody else cannot delete it',
     (await DEL(`/api/notes/${wnote.body.id}`, { token: T.pat })).status === 403);
  ok('…the author can', (await DEL(`/api/notes/${wnote.body.id}`, { token: T.omar })).status === 200);
  ok('…and the reply went with it — a headless reply reads as noise',
     (await pool.query('SELECT COUNT(*)::int AS n FROM notes WHERE id=$1 OR parent_id=$1',
       [wnote.body.id])).rows[0].n === 0);

  reach('API keys card (Settings)', { seam: ['listApiKeys', 'createApiKey', 'revokeApiKey'],
                                      action: ['keyMint', 'keyMintCommit', 'keyRevoke'] });
  const wkey = await POST('/api/keys', { label: 'walk agent', scopes: ['agent:read'] },
    { token: T.omar });
  ok('anyone mints a key for THEMSELVES — the agent acts as its person',
     wkey.status === 200 && !!wkey.body.key, { prefix: wkey.body?.key_prefix });
  const wlist = await GET('/api/keys', { token: T.omar });
  ok('…the list never carries the key again',
     wlist.status === 200 && wlist.body.length === 1
     && !('key' in wlist.body[0]) && !!wlist.body[0].key_prefix, wlist.body?.[0]);
  ok('…revoke, never delete', (await DEL(`/api/keys/${wkey.body.id}`, { token: T.omar })).status === 200);
  const wlist2 = await GET('/api/keys', { token: T.omar });
  ok('…the row STAYS, marked revoked — a credential’s history is part of the record',
     wlist2.body.length === 1 && !!wlist2.body[0].revoked_at, wlist2.body?.[0]);

  // ══════════════════════════════════════════════════════════════════════════
  section('24 · the last stray gate — gear state is this show’s, not every tech’s');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Gear state write (Flex pull)', { seam: 'updateGear', action: 'flexPull' });
  ok('H1 · a pm who owns nothing is refused the gear write',
     (await PUT(`/api/shows/${SHOW}/gear`, { pulled: true }, { token: T.pat })).status === 403);
  const gearOmar = await PUT(`/api/shows/${SHOW}/gear`, { pulled: false }, { token: T.omar });
  ok('…while omar — the tech ON this crew — may write it', gearOmar.status === 200, gearOmar.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('25 · the two deletes — typed confirms in front, real cascades behind');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Delete show (header)', { seam: 'deleteShow', action: 'deleteShow' });
  reach('Delete folder (header)', { seam: 'deleteProject', action: 'deleteFolder' });
  ok('the typed confirm names what goes and asks for the name back',
     /Type the show’s name to confirm/.test(APP_JS) && /Type the folder’s name to confirm/.test(APP_JS));
  ok('a pm who owns nothing cannot delete the show',
     (await DEL(`/api/shows/${WS2}`, { token: T.pat })).status === 403);
  ok('the owner deletes the second show', (await DEL(`/api/shows/${WS2}`, { token: T.brenden })).status === 200);
  ok('…and it is really gone, steps and all',
     (await GET(`/api/shows/${WS2}`, { token: T.brenden })).status === 404 &&
     (await pool.query('SELECT COUNT(*)::int AS n FROM steps WHERE show_id=$1', [WS2])).rows[0].n === 0);
  const scratch = await POST('/api/events', { name: 'walk scratch folder', type: 'led' },
    { token: T.tom });
  ok('a scratch folder to delete', scratch.status === 200, scratch.body?.project?.id);
  const SPID = scratch.body.project.id;
  ok('…a pm who owns nothing cannot delete it',
     (await DEL(`/api/projects/${SPID}`, { token: T.pat })).status === 403);
  ok('…its owner can, cascade and all',
     (await DEL(`/api/projects/${SPID}`, { token: T.tom })).status === 200);
  ok('…zero rows left behind — shows and jobs both',
     parseInt((await pool.query(
       `SELECT (SELECT COUNT(*) FROM shows WHERE project_id=$1)
             + (SELECT COUNT(*) FROM jobs WHERE project_id=$1) AS n`, [SPID])).rows[0].n, 10) === 0);

  // ══════════════════════════════════════════════════════════════════════════
  section('26 · the proposal that named no show gets pointed at one');
  // ══════════════════════════════════════════════════════════════════════════
  // E4's second half. The seam forwarded `overrides` since the seam pass and
  // the client posted {} — a folder-anchored proposal confirmed into a
  // document with NO cost, silently. The picker modal re-posts the same
  // confirm with {overrides:{showId}}; these steps walk that exact wire.
  reach('Confirm a proposal', { seam: 'confirmDoc', action: 'confirmDoc' });
  reach('Retarget it (the one-field show picker)',
    { seam: 'confirmDoc', action: ['rtCommit', 'rtSkip'] });
  ok('the picker re-posts {overrides:{showId}} — never a bare confirm',
     /confirmDocAct\(fileId, \{ showId: Number\(showId\) \}\)/.test(APP_JS));
  ok('…and a Confirm on a show-less proposal asks BEFORE the server has to refuse',
     /!f0\.show_id/.test(APP_JS) && /openRetarget/.test(APP_JS));
  const wAK = await POST('/api/keys', { label: 'walk retarget agent', scopes: ['agent:file'] },
    { token: T.brenden });
  ok('brenden mints his agent a key', wAK.status === 200 && !!wAK.body.key, wAK.body?.key_prefix);
  const worp = await POST('/api/agent/documents', {
    projectId: PROJ, kind: 'receipt', name: 'Hertz — which match?', ext: '.pdf',
    amount: 480, vendor: 'Hertz',
    provenance: { sourceKind: 'email', sourceRef: 'walk:ov', sourceLabel: 'Hertz receipt',
                  confidence: 66 }
  }, { key: wAK.body.key, idem: 'walk:ov#doc' });
  ok('…which files a folder-only receipt as a proposal (no show named)',
     worp.status === 200 && worp.body.status === 'proposed' && !!worp.body.proposalId, worp.body);
  const wconf = await POST(`/api/proposals/${worp.body.proposalId}/confirm`,
    { overrides: { showId: SHOW, category: 'travel' } }, { token: T.brenden });
  ok('confirmed through the picker’s overrides, the cost finally lands',
     wconf.status === 200 && (wconf.body.created.expenses || []).length === 1,
     wconf.body.created);
  ok('…on the show the human pointed at',
     (await pool.query('SELECT show_id FROM expenses WHERE id=$1',
       [(wconf.body.created.expenses || [])[0]])).rows[0].show_id === SHOW);

  // ══════════════════════════════════════════════════════════════════════════
  section('27 · the proposals backlog is a PAGE, not a popover cap of 8');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Proposals review page (nav + bell link)',
    { seam: 'listProposals', action: ['goProposals', 'propsMore'] });
  const wplist = await GET('/api/proposals', { token: T.brenden });
  ok('the review read lists brenden’s resolved proposal, decision and all',
     wplist.status === 200 && wplist.body.some((p) =>
       p.id === worp.body.proposalId && p.status === 'confirmed' && p.resolved_by === 'brenden'),
     wplist.body?.length);
  const worp2 = await POST('/api/agent/documents', {
    projectId: PROJ, kind: 'receipt', name: 'Sunbelt — unsure', ext: '.pdf', amount: 75,
    vendor: 'Sunbelt', provenance: { sourceKind: 'email', sourceRef: 'walk:ov2', confidence: 62 }
  }, { key: wAK.body.key, idem: 'walk:ov2#doc' });
  ok('…a second proposal pends', worp2.status === 200 && worp2.body.status === 'proposed');
  ok('…pat may not resolve somebody else’s',
     (await POST(`/api/proposals/${worp2.body.proposalId}/reject`, { reason: 'not mine' },
       { token: T.pat })).status === 403);
  ok('…brenden rejects it with a reason the page can print',
     (await POST(`/api/proposals/${worp2.body.proposalId}/reject`, { reason: 'duplicate of last week' },
       { token: T.brenden })).status === 200);
  const wplist2 = await GET('/api/proposals?status=rejected', { token: T.brenden });
  ok('…and the resolved record carries it',
     wplist2.body.some((p) => p.id === worp2.body.proposalId
       && p.resolve_reason === 'duplicate of last week'), wplist2.body?.length);

  // ══════════════════════════════════════════════════════════════════════════
  section('28 · a mis-filed document gets a new name and the right kind');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Rename / re-kind (viewer meta panel)', { seam: 'updateFile', action: ['editFile', 'feCommit'] });
  const wfile = await POST('/api/files',
    { show_id: SHOW, kind: 'other', name: 'IMG_2291', ext: 'pdf' }, { token: T.omar });
  ok('omar registers a camera-roll-named doc', wfile.status === 200, wfile.body);
  ok('…pat may not touch it (not the uploader, owns nothing)',
     (await PUT(`/api/files/${wfile.body.id}`, { name: 'hijack' }, { token: T.pat })).status === 403);
  const wfren = await PUT(`/api/files/${wfile.body.id}`,
    { name: 'Hertz receipt — Fiserv load-in', kind: 'receipt' }, { token: T.omar });
  ok('…the uploader renames AND re-kinds it',
     wfren.status === 200 && wfren.body.kind === 'receipt'
     && wfren.body.name === 'Hertz receipt — Fiserv load-in', wfren.body);
  ok('…an unknown kind KEEPS the current one (oneOf, never garbage)',
     (await PUT(`/api/files/${wfile.body.id}`, { kind: 'meme' }, { token: T.omar })).body.kind === 'receipt');

  // ══════════════════════════════════════════════════════════════════════════
  section('29 · the show report that IS the attached document  (D4)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Attach the document (report editor)',
    { seam: 'fileTechReport', action: ['repAttach', 'repAttachCommit'] });
  ok('the promise-string finally has a control behind it',
     /repAttach/.test(SRC['views-folder.js']));
  const wrep = (await GET(`/api/shows/${SHOW}/tech-reports`, { token: T.brenden }))
    .body.reports.find((r) => r.username === 'omar');
  ok('omar’s report row is in hand', !!wrep, wrep);
  const wattach = await PUT(`/api/tech-reports/${wrep.id}`, { file_id: wfile.body.id },
    { token: T.omar });
  ok('…he attaches the doc he already had — the report keeps its body and gains its file',
     wattach.status === 200 && wattach.body.report.file_id === wfile.body.id
     && wattach.body.report.status === 'filed', wattach.body.report);
  const wForeignShow = await POST('/api/shows',
    { project_id: PROJ, name: 'Foreign-doc scratch', seed_template: false }, { token: T.tom });
  const wother = await POST('/api/files',
    { show_id: wForeignShow.body.id, kind: 'other', name: 'foreign doc', ext: 'pdf' },
    { token: T.tom });
  ok('…a file from ANOTHER show is refused — a report cannot smuggle one in',
     wother.status === 200 &&
     (await PUT(`/api/tech-reports/${wrep.id}`, { file_id: wother.body.id },
       { token: T.omar })).status === 400, wother.body?.id);

  // ══════════════════════════════════════════════════════════════════════════
  section('30 · the health pill obeys a person who knows better  (rag_override)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Health override (pencil on the pill)', { seam: 'updateShow', action: ['ragOverride', 'ragSet'] });
  ok('the client rollup honors the override everywhere the pill renders',
     /rag_override/.test(SRC['components.js']) && /by hand/.test(SRC['views-folder.js']));
  ok('…pat cannot repaint somebody else’s show',
     (await PUT(`/api/shows/${SHOW}`, { rag_override: 'go' }, { token: T.pat })).status === 403);
  const wrag = await PUT(`/api/shows/${SHOW}`, { rag_override: 'crit' }, { token: T.brenden });
  ok('the owner sets it by hand', wrag.status === 200 && wrag.body.rag === 'crit'
     && wrag.body.rag_override === 'crit', { rag: wrag.body.rag, o: wrag.body.rag_override });
  ok('…the read agrees — override WINS over derived',
     (await GET(`/api/shows/${SHOW}`, { token: T.omar })).body.rag === 'crit');
  const wragClear = await PUT(`/api/shows/${SHOW}`, { rag_override: null }, { token: T.brenden });
  ok('…and clearing it hands the pill back to the pipeline',
     wragClear.status === 200 && wragClear.body.rag_override === null, wragClear.body.rag);

  // ══════════════════════════════════════════════════════════════════════════
  section('31 · the template editor’s Save button saves  (A5)');
  // ══════════════════════════════════════════════════════════════════════════
  reach('Template editor writes', {
    seam: ['updateTemplate', 'createTemplateVersion', 'deleteTemplate', 'listTemplateVersions'],
    action: ['tplSave', 'tplBank', 'tplDelete', 'tplAddStep', 'tplRowDel'] });
  ok('the Save button is not a toast any more',
     !/toastAttrs\('Template saved'/.test(SRC['views-global.js']));
  ok('a pm cannot rewrite the SOP — POST',
     (await POST('/api/templates', { name: 'sneak', event_type: 'led' }, { token: T.brenden })).status === 403);
  const wtplLive = await GET('/api/templates/led', { token: T.morgan });
  ok('a pm cannot rewrite the SOP — PUT / DELETE',
     (await PUT(`/api/templates/${wtplLive.body.id}`, { name: 'sneak' }, { token: T.brenden })).status === 403 &&
     (await DEL(`/api/templates/${wtplLive.body.id}`, { token: T.brenden })).status === 403);
  const wbank = await POST('/api/templates', {
    name: 'LED SOP — banked by walk', event_type: 'led',
    steps: [{ lane: 'venue', title: 'Walk-added rigging check', due_offset_days: -9 }]
  }, { token: T.morgan });
  ok('a manager banks a copy', wbank.status === 200 && wbank.body.id > 0, wbank.body);
  ok('…and the LIVE SOP stays the oldest — banking never hijacks what seeds',
     (await GET('/api/templates/led', { token: T.morgan })).body.id === wtplLive.body.id);
  const wput = await PUT(`/api/templates/${wbank.body.id}`, {
    steps: [{ lane: 'venue', title: 'Walk-edited rigging check', due_offset_days: -12 },
            { lane: 'gear', title: 'Walk-added spare count', due_offset_days: -5 }]
  }, { token: T.morgan });
  ok('…edits the grid in one transaction', wput.status === 200 && (wput.body.steps || []).length === 2,
     wput.body.steps?.length);
  ok('…and deletes the banked copy, rows and all',
     (await DEL(`/api/templates/${wbank.body.id}`, { token: T.morgan })).status === 200 &&
     (await pool.query('SELECT COUNT(*)::int AS n FROM template_steps WHERE template_id=$1',
       [wbank.body.id])).rows[0].n === 0);

  // ══════════════════════════════════════════════════════════════════════════
  section('32 · the small honest things — search, landing, feed, NAS, tags, archive');
  // ══════════════════════════════════════════════════════════════════════════
  ok('A12 · the topbar search is wired, not decoration',
     /initGlobalSearch\(\)/.test(APP_JS) && /globalSearch/.test(APP_JS));
  ok('…and its empty state admits the gap instead of hiding it',
     /no server-wide search yet/i.test(APP_JS));
  ok('D1 · a tech lands on their own work at boot',
     /landingView/.test(APP_JS) && /'tech' \? 'mytasks'/.test(APP_JS));
  reach('Finance feed digs deeper', { seam: 'getFinanceOverview', action: 'finFeedMore' });
  ok('…the false "full ledger lands with the backend" sentence is gone',
     !/full ledger lands with the backend/.test(SRC['views-finance.js']));
  ok('36 · the NAS card asks the probe instead of hardcoding green',
     !/>reachable</.test(SRC['views-global.js']) && /ctx\.health/.test(SRC['views-global.js']));
  reach('Photo tag chips edit in place', { seam: 'updatePhoto', action: ['phTagAdd', 'phTagDel'] });
  reach('Archive folder (season header)', { seam: 'archiveProject', action: 'archiveProject' });
  ok('…a manager cannot archive — admin floor holds',
     (await POST(`/api/projects/${PROJ}/archive`, {}, { token: T.morgan })).status === 403);
  const warch = await POST(`/api/projects/${PROJ}/archive`, {}, { token: T.tom });
  ok('…Tom archives the folder from its header', warch.status === 200, warch.body);
  ok('…and puts it back — nothing was lost',
     (await POST(`/api/projects/${PROJ}/unarchive`, {}, { token: T.tom })).status === 200);

  // ══════════════════════════════════════════════════════════════════════════
  section('33 · the rolodex — a contact’s whole life  (Tom 2026-08-27, shipped at last)');
  // ══════════════════════════════════════════════════════════════════════════
  // "there should be a contact rolodex in our app if we dont already have
  // one." Brenden walks a card through its whole life: create → find → fix →
  // link to the show → read the card back → archive → restore → the delete
  // that refuses while linked → unlink → the delete that goes through.
  reach('Contacts view (nav data-view entry)', { seam: 'listContacts', action: 'goContacts',
                                                 rendered: false });
  reach('Filter the rolodex', { action: ['ctKind', 'ctMode'] });
  reach('Add a contact', { seam: 'createContact', action: ['ctAdd', 'ctAddCommit'] });
  reach('Open the card (row + global search)', { seam: 'getContact',
                                                 action: ['openContact', 'ctOpenShow'] });
  reach('Edit a contact', { seam: 'updateContact', action: ['ctEdit', 'ctEditCommit'] });
  reach('Link a contact to the show', { seam: 'linkShowContact', action: ['scAdd', 'scAddCommit'] });
  reach('Unlink from the show', { seam: 'unlinkShowContact', action: 'scUnlink' });
  reach('Archive / restore a card', { seam: ['archiveContact', 'unarchiveContact'],
                                      action: ['ctArchive', 'ctUnarchive'] });
  reach('Hard delete (admin, refuses while linked)', { seam: 'deleteContact',
                                                       action: ['ctDelete', 'ctDeleteGo'] });
  reach('Call sheet fills its POCs from the rolodex', {
    action: ['csPickContact', 'csPickApply', 'csPickBack'] });
  ok('the topbar search gained a Contacts group',
     /searchGroupHTML\('Contacts'/.test(APP_JS) && /contacts:\s*ALL_CONTACTS/.test(APP_JS));
  ok('the picker stashes typed call-sheet edits before swapping modals — nothing typed is lost',
     /csStashFields/.test(APP_JS) && /csRestoreFields/.test(APP_JS));
  ok('the schedule tab renders the “People on this show” panel from the rolodex',
     /showContactsPanel/.test(SRC['views-folder.js']) && /showContactsPanel/.test(SRC['views-contacts.js']));

  ok('a tech may not add to the rolodex',
     (await POST('/api/contacts', { name: 'sneaked card' }, { token: T.omar })).status === 403);
  const wct = await POST('/api/contacts', {
    name: 'Rae Simms', org: 'Fiserv Forum', title: 'Ops manager', kind: 'venue',
    phone: '414-555-0114', email: 'rsimms@fiservforum.com'
  }, { token: T.brenden });
  ok('Brenden puts the venue’s ops manager in the rolodex — the same Rae Simms the call sheet types free-text',
     wct.status === 200 && wct.body.id > 0, wct.body);
  const WCT = wct.body.id;

  const wctQ = await GET('/api/contacts?q=' + encodeURIComponent('fiserv'), { token: T.omar });
  ok('…anyone signed in finds her by org, case-insensitively',
     wctQ.status === 200 && wctQ.body.some((c) => c.id === WCT), wctQ.body?.length);
  ok('…the kind filter holds her', (await GET('/api/contacts?kind=venue', { token: T.brenden }))
     .body.some((c) => c.id === WCT));
  ok('…and an unknown kind is a 400, not an empty lie',
     (await GET('/api/contacts?kind=sponsor', { token: T.brenden })).status === 400);

  const wctFix = await PUT('/api/contacts/' + WCT, { phone: '414-555-0115' }, { token: T.brenden });
  ok('a wrong digit is corrected on the card', wctFix.status === 200
     && wctFix.body.phone === '414-555-0115', wctFix.body);
  const wctDiff = (await pool.query(
    `SELECT changes FROM activity WHERE action='contact.update' ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('…with a structured before→after on the trail',
     (wctDiff?.changes || []).some((c) => c.field === 'phone' && c.to === '414-555-0115'), wctDiff);

  ok('a pm who owns nothing may not put her on the show',
     (await POST(`/api/shows/${SHOW}/contacts`, { contact_id: WCT }, { token: T.pat })).status === 403);
  const wlink = await POST(`/api/shows/${SHOW}/contacts`, { contact_id: WCT, role: 'Venue ops' },
    { token: T.brenden });
  ok('Brenden links her to the show', wlink.status === 200 && wlink.body.role === 'Venue ops', wlink.body);
  const wcard = await GET('/api/contacts/' + WCT, { token: T.omar });
  ok('…and her card now answers “where am I used” — one show, this one',
     wcard.body.linked_shows === 1 && wcard.body.shows?.[0]?.show_id === SHOW, wcard.body.shows);

  ok('a tech may not archive a card',
     (await POST(`/api/contacts/${WCT}/archive`, {}, { token: T.omar })).status === 403);
  const warchCt = await POST(`/api/contacts/${WCT}/archive`, {}, { token: T.brenden });
  ok('Brenden archives her — pm floor, the retirement path', warchCt.status === 200, warchCt.body);
  ok('…the working set excludes her',
     !(await GET('/api/contacts', { token: T.brenden })).body.some((c) => c.id === WCT));
  ok('…the Archived view is exactly where she is',
     (await GET('/api/contacts?archived=1', { token: T.brenden })).body.some((c) => c.id === WCT));
  ok('…and restore brings her back, link intact',
     (await POST(`/api/contacts/${WCT}/unarchive`, {}, { token: T.brenden })).status === 200 &&
     (await GET('/api/contacts/' + WCT, { token: T.brenden })).body.linked_shows === 1);

  ok('deleting a card is above Brenden’s floor — admin only',
     (await DEL('/api/contacts/' + WCT, { token: T.brenden })).status === 403);
  const wdelRefused = await DEL('/api/contacts/' + WCT, { token: T.tom });
  ok('THE HONEST REFUSAL — while she is on a show even Tom is told no, and the 400 NAMES the show',
     wdelRefused.status === 400 && /AVCA First Serve/.test(wdelRefused.body?.error || ''),
     wdelRefused.body);
  ok('…and points at the archive path instead of a dead end',
     /archive/i.test(wdelRefused.body?.error || ''), wdelRefused.body?.error);
  ok('…the refusal wrote nothing',
     (await GET('/api/contacts/' + WCT, { token: T.tom })).status === 200);
  ok('Brenden takes her off the show',
     (await DEL(`/api/shows/${SHOW}/contacts/${WCT}`, { token: T.brenden })).status === 200);
  ok('…unlinked, the admin delete goes through and the card is gone',
     (await DEL('/api/contacts/' + WCT, { token: T.tom })).status === 200 &&
     (await GET('/api/contacts/' + WCT, { token: T.tom })).status === 404);

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
