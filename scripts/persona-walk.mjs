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
import vm from 'node:vm';

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
  // §42 begins UNCONFIGURED on purpose, and a developer machine may carry
  // real Dropbox credentials this walk must never touch. The fake's land
  // mid-walk.
  delete process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_SECRET;
  delete process.env.DROPBOX_REFRESH_TOKEN;
  delete process.env.DROPBOX_API_BASE;
  delete process.env.DROPBOX_CONTENT_BASE;
  // §51 walks the UNATTENDED transcript reader in its shipped posture — DARK —
  // and the stakes make the same hygiene mandatory: these three are a
  // tenant-wide, app-only grant, and a developer machine that carries them must
  // never have this walk reach into the real tenant.
  delete process.env.GRAPH_TENANT_ID;
  delete process.env.GRAPH_CLIENT_ID;
  delete process.env.GRAPH_CLIENT_SECRET;
  delete process.env.GRAPH_LOGIN_BASE;
  delete process.env.GRAPH_API_BASE;
  // …and the MAIL_* registration, live in production since 9/21: the walk sends
  // real notifications through the real seam, and a developer machine carrying
  // the showrunner@ credentials must never turn that into actual email.
  delete process.env.MAIL_DRIVER;
  delete process.env.MAIL_FROM;
  delete process.env.MAIL_TENANT_ID;
  delete process.env.MAIL_CLIENT_ID;
  delete process.env.MAIL_CLIENT_SECRET;
  delete process.env.MAIL_REPLY_TO;
  delete process.env.MAIL_GRAPH_LOGIN_BASE;
  delete process.env.MAIL_GRAPH_API_BASE;
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
    // uploadPhoto joined the list with the Photos tab's human door (9/16):
    // it, too, creates a files row from a UI gesture. Its own caller shows
    // apiMode() (for the mode-specific toast wording), which would EXEMPT it
    // from the demo-guard rule below — so §47 holds its payload to the
    // no-size/no-dim line unconditionally, using this same extraction.
    const callRe = /api\.(addFile|addFinancialDoc|replaceChainFile|uploadPhoto)\s*\(/g;
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

  // ── the synth-sheet line, held MECHANICALLY ───────────────────────────────
  // sheetFor() draws convincing fabrications for demo mode: letterheads,
  // FILED/APPROVED stamps, grey placeholder body text. Each class got its
  // live-mode gate one incident at a time — specs (8/27), pull sheets,
  // proofs/artwork/docs ("the three sheets nobody had walked yet"), and
  // finally money (9/3: Tom asked whether a moneySheet was a real receipt
  // Brendon uploaded). This scan ends the one-at-a-time pattern: every class
  // sheetFor dispatches to a synth renderer must be intercepted by a
  // `live &&` guard EARLIER in the function, so a new sheet class cannot
  // ship without its production gate.
  {
    const m = SRC['components.js'].match(/function sheetHTML\([\s\S]*?\n\}/);
    ok('sheetHTML() is where the scan expects it', !!m, 'components.js');
    const body = m ? m[0] : '';
    const synthClasses = [...body.matchAll(/if \(c === '(\w+)'\) return [^;\n]*Sheet\(/g)]
      .map((x) => x[1]).filter((c2) => c2 !== 'photo'); /* photoSheet renders real thumbs */
    ok('the scan sees the synth dispatch table (>= 7 classes)', synthClasses.length >= 7, synthClasses);
    const unguarded = synthClasses.filter((c2) => {
      const guardIdx = body.search(new RegExp(`if \\(live && [^)]*'${c2}'`));
      const dispatchIdx = body.search(new RegExp(`if \\(c === '${c2}'\\) return [^;\\n]*Sheet\\(`));
      return guardIdx === -1 || guardIdx > dispatchIdx;
    });
    ok('EVERY synth sheet class is live-guarded before its dispatch — money included',
       unguarded.length === 0, unguarded);
  }

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

  // ── my phone — the self-serve field the sheet reads (Tom, 2026-09-16) ─────
  // SMS (Twilio, a later build) will key off the USER account, and the opt-in
  // story rides on people entering their OWN number — so Omar sets his from
  // Settings, on the narrow self-only route, and his call-sheet line gets a
  // number without anyone typing it per show (crew.phone || user.phone).
  reach('My phone (Settings · Your session)', { seam: 'setMyPhone',
                                                action: ['editMyPhone', 'myPhoneCommit'] });
  const omarPhone = await PUT('/api/me/phone', { phone: '(262) 555-0175' }, { token: T.omar });
  ok('Omar sets HIS OWN number through PUT /api/me/phone',
     omarPhone.status === 200 && omarPhone.body.phone === '(262) 555-0175', omarPhone.body);
  const morganId = (await GET('/api/users/morgan', { token: T.omar })).body.id;
  ok('…and cannot set Morgan\'s — the Team path refuses a non-admin aiming at anyone else',
     (await PUT(`/api/users/${morganId}`, { phone: '(999) 555-0000' },
       { token: T.omar })).status === 403);
  const sheetCrew = (await GET(`/api/shows/${SHOW}/call-sheet`, { token: T.omar })).body.crew || [];
  const omarLine = sheetCrew.find((c) => c.username === 'omar');
  const danaLine = sheetCrew.find((c) => c.name === 'Dana Fields');
  ok('the sheet\'s crew row borrows the account number — crew.phone || user.phone',
     !!omarLine && omarLine.phone === '(262) 555-0175', omarLine && omarLine.phone);
  ok('…while Dana the local hire keeps the number typed on her line',
     !!danaLine && danaLine.phone === '414-555-0142', danaLine && danaLine.phone);

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

  // 9/16, Tom, live on the Big Ten recap: "i generate a draft but am given no
  // chance to write anything" / "drafted by tonys agent. whatever the fuck
  // that means. i am the one who generated it." Two defects, four gates:
  // the writing surface must be discoverable, and attribution must be true.
  ok('recap draft rows are click-to-edit — the text is the affordance',
     /rcRow\('rc-row rc-para', editable, show, key\)/.test(SRC['views-folder.js']) &&
     /rcRow\('rc-stcell', editable, show, key\)/.test(SRC['views-folder.js']));
  ok('recap edit pens are visible at rest — never opacity:0 hover-secrets',
     !/\.rc-row \.rc-pen,\.rc-stcell \.rc-stctl\{opacity:0\}/.test(
       fs.readFileSync(path.join(PUB, 'app.css'), 'utf8')));
  ok('generating a recap lands in an OPEN editor, not a finished-looking card',
     /RECAP_UI\.edit = \(rb\.narrative/.test(APP_JS));
  ok('the demo twin no longer credits recap drafts to an invented owner-agent',
     !/'agent:' \+ s\.owner/.test(API_JS));
  // 9/16, Tom, live: the Archive door flapped — visible right after archiving,
  // gone on refresh, back after wandering through Settings — because it was
  // count-gated on whichever rows the CLIENT happened to hold. The door is
  // unconditional now; this holds it that way.
  ok('the Archive door is never gated on client-loaded rows',
     !/var archBtn = nArch/.test(SRC['views-dashboard.js']) &&
     /act\('goArchive'\)/.test(SRC['views-dashboard.js']));
  // ...and the archived-show banner sizes its icon: icon() emits UNSIZED
  // svgs, so a container without a width rule renders a viewport-filling
  // glyph (Tom's screenshot, the first archived show ever rendered).
  ok('the arch-banner sizes its svg — an unsized icon() fills the viewport',
     /\.arch-banner svg\{[^}]*width\s*:/.test(
       fs.readFileSync(path.join(PUB, 'app.css'), 'utf8')));

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
  reach('Seed pipeline (Pipeline tab — empty AND non-empty)',
    { seam: 'instantiateTemplate', action: 'seedPipeline' });
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

  // The seed door used to SLAM SHUT the moment somebody hand-added one task:
  // tabPipeline offered it only on a pipeline with ZERO steps, because the
  // route had no duplicate protection. The dedup moved to the server, so the
  // door stays open on a board with steps on it. Both halves are asserted —
  // the flow through the real route, and the affordance over the source.
  const wseed2 = await POST(`/api/shows/${WS2}/instantiate-template`,
    { template_id: tplLed.body.id }, { token: T.brenden });
  ok('seeding AGAIN lands nothing — idempotent by step title, not by a UI gate',
     wseed2.status === 200 && wseed2.body.instantiated_steps === 0
     && wseed2.body.skipped_steps > 0, wseed2.body);
  ok('…and no title on that board is doubled', (await pool.query(
     `SELECT COUNT(*)::int AS n FROM (SELECT lower(btrim(title)) t FROM steps
        WHERE show_id=$1 GROUP BY 1 HAVING COUNT(*) > 1) d`, [WS2])).rows[0].n === 0);
  // a hand-added task must not close the door OR be disturbed by a re-seed
  const wHand = await POST('/api/steps',
    { show_id: WS2, lane: 'logistics', title: 'chase the venue about the rigging plot' },
    { token: T.brenden });
  ok('a pm hand-adds their own task to the seeded board', wHand.status === 200, wHand.body);
  const wseed3 = await POST(`/api/shows/${WS2}/instantiate-template`,
    { template_id: tplLed.body.id }, { token: T.brenden });
  ok('…and re-seeding still lands nothing new',
     wseed3.status === 200 && wseed3.body.instantiated_steps === 0, wseed3.body);
  ok('…with the hand-added task untouched', (await pool.query(
     'SELECT title, lane FROM steps WHERE id=$1', [wHand.body.id])).rows[0].title
     === 'chase the venue about the rigging plot');

  const pipeSrc = SRC['views-folder.js'].slice(
    SRC['views-folder.js'].indexOf('function tabPipeline'),
    SRC['views-folder.js'].indexOf('function chainStrip'));
  ok('tabPipeline KEEPS the big empty-state seed block',
     /editable && !allSteps\(show\)\.length/.test(pipeSrc));
  ok('…and a NON-empty pipeline now carries a Seed pipeline button of its own',
     /editable && allSteps\(show\)\.length[\s\S]{0,180}seedPipeline/.test(pipeSrc));
  ok('…in the sched-bar, beside Add task',
     /sched-bar[\s\S]{0,500}seedPipeline[\s\S]{0,260}addTask/.test(pipeSrc));
  ok('…so the door exists on BOTH states — two seedPipeline sites in tabPipeline',
     (pipeSrc.match(/seedPipeline/g) || []).length === 2,
     (pipeSrc.match(/seedPipeline/g) || []).length);
  // The toast may not claim work it did not do. It lives in seedPipelineWith()
  // since the library wave — seedPipelineAct() now only RESOLVES which template
  // (direct when the type owns one, the picker when it owns several) and hands
  // off; the reporting half is the same code either way, which is the point.
  const seedActSrc = APP_JS.slice(APP_JS.indexOf('async function seedPipelineWith'),
    APP_JS.indexOf('async function seedPipelineWith') + 2400);
  ok('the seed toast reads skipped_steps — it can say what was ALREADY there',
     /skipped_steps/.test(seedActSrc));
  ok('…and an all-skipped seed does not report a fake success',
     /Nothing new to seed/.test(seedActSrc));
  // ── DEMO TWIN PARITY, EXECUTED — not scanned ───────────────────────────────
  // The file:// demo seeds from its own local store. A demo that duplicates
  // steps where the server dedupes is exactly the lie the twin exists to
  // prevent, and a regex over _seedLocalPipeline would not have caught it.
  // Same eight-global shim as section 37, one global changed: location
  // .protocol 'file:' is probe()'s demo trapdoor, so nothing reaches a server.
  // This harness carries the RENDER half too, so the files load in the same
  // order index.html gives them. Nothing is stubbed but the browser edges: a
  // demo that seeds correctly and never draws the button is still broken.
  const demoTab = (() => {
    const store = new Map();
    const ctx = {
      fetch: () => Promise.reject(new Error('demo mode must not reach the network')),
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
      },
      location: { protocol: 'file:' },
      setTimeout, clearTimeout, AbortController, console,
      document: { addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] },
      navigator: { userAgent: 'walk' }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['data.js', 'api.js', 'components.js', 'views-notes.js', 'views-folder.js']) {
      new vm.Script(SRC[f], { filename: 'public/' + f }).runInContext(ctx);
    }
    return ctx;
  })();
  ok('the REAL public/api.js loads headless with file:// as its trapdoor',
     (await demoTab.SR.probe()) === 'demo');
  const dEvt = await demoTab.api.createEvent({
    name: 'WALK demo seed parity', type: 'led', venue: 'Demo Hall', event_date: plus(60)
  });
  const dSeeded = dEvt.instantiated_steps || 0;
  ok('a demo event opens with a seeded pipeline', dSeeded > 0, dEvt.instantiated_steps);
  const dShowId = dEvt.show.id;
  // the hand-added task the old UI gate punished you for typing
  const dHand = await demoTab.api.createStep({
    show_id: dShowId, lane: 'logistics', title: 'chase the venue about the rigging plot'
  });
  ok('…a demo pm hand-adds their own task', !!dHand && !!dHand.id, dHand);
  const dSeed = await demoTab.api.instantiateTemplate(dShowId, null);
  ok('DEMO TWIN: re-seeding lands ZERO — the file:// demo dedupes by title too',
     dSeed.instantiated_steps === 0, dSeed);
  ok('…and skips exactly what the first seed had already laid down',
     dSeed.skipped_steps === dSeeded, { skipped: dSeed.skipped_steps, seeded: dSeeded });
  const dShow = await demoTab.api.getShow(dShowId);
  ok('…the demo board did not double', (dShow.steps || []).length === dSeeded + 1,
     (dShow.steps || []).length);
  ok('…and the hand-added task is still on it, untouched',
     (dShow.steps || []).filter((s) => s.title === 'chase the venue about the rigging plot')
       .length === 1);
  ok('…no title on the demo board is duplicated',
     new Set((dShow.steps || []).map((s) => String(s.title).trim().toLowerCase())).size
       === (dShow.steps || []).length);

  // THE AFFORDANCE, RENDERED — the defect was a door that vanished, so the
  // walk draws the tab from the file:// demo and looks for it. Both states:
  // the big empty-state block on a bare pipeline, the sched-bar button on a
  // board with steps. Exactly one door each — never zero, never two.
  const dFullHtml = demoTab.tabPipeline(dShow);
  ok('DEMO RENDER · a NON-EMPTY pipeline draws the Seed pipeline button',
     /seedPipeline/.test(dFullHtml));
  ok('…once, in the sched-bar, and NOT as the big empty-state block',
     (dFullHtml.match(/seedPipeline/g) || []).length === 1
     && /sched-bar/.test(dFullHtml) && !/No pipeline on this show yet/.test(dFullHtml));
  const dEmptyShow = await demoTab.api.getShow(
    (await demoTab.api.createShow(dShow.project_id,
      { name: 'WALK demo empty board', seed_template: false, event_date: plus(60) })).id);
  ok('…and an EMPTY pipeline still gets the original empty-state block, untouched',
     (dEmptyShow.steps || []).length === 0
     && /No pipeline on this show yet/.test(demoTab.tabPipeline(dEmptyShow))
     && (demoTab.tabPipeline(dEmptyShow).match(/seedPipeline/g) || []).length === 1);

  // THE THIN PROJECT — the absorb layer deliberately keeps a project embedded
  // without its shows list (live case: an ARCHIVED folder riding a finance
  // exception — boot loads active folders only). showLabel must answer a
  // name for that shape, never a TypeError: on 2026-09-21 it threw and took
  // the whole Projects view down in production while every suite sat green.
  {
    const thinId = 987654;
    demoTab.PROJECTS_BY_ID[thinId] = { id: thinId, name: 'WALK thin folder' }; // no .shows, on purpose
    let thinLabel = null, thinThrew = null;
    try { thinLabel = demoTab.showLabel({ id: 1, project_id: thinId, name: 'WALK thin show' }); }
    catch (e) { thinThrew = String(e); }
    ok('DEMO RENDER · showLabel answers a NAME for a THIN project (no shows list), never a TypeError',
       thinThrew === null && thinLabel === 'WALK thin show', thinThrew || thinLabel);
    delete demoTab.PROJECTS_BY_ID[thinId];
  }

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
  section('31 · the template LIBRARY — many named templates per type, a picker at every human seed door');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom, 2026-09-17: "When I create a template and save it — I don't name it,
  // and have no means to create a new different one. We should be able to have
  // many templates for many job types. And when we seed them — we can decide
  // which template we want."
  //
  // Every seed point hardcoded "the oldest row of this type wins", so a second
  // template could be created and never again reached, named or seeded. That
  // rule survives ONLY as the MACHINE answer (the STANDARD — agent proposal
  // confirms, and any caller that names no template). Every HUMAN door picks by
  // id, and these gates say the chosen id is what lands.
  reach('Template library — new / rename / duplicate / save / delete', {
    seam: ['listTemplates', 'listEventTypes', 'createTemplate', 'updateTemplate', 'deleteTemplate'],
    action: ['tplNew', 'tplNewCommit', 'tplRename', 'tplRenameCommit', 'tplDuplicate',
             'tplSave', 'tplDelete', 'tplAddStep', 'tplRowDel'] });
  reach('Seed pipeline picks WHICH template when the type owns several',
    { seam: 'instantiateTemplate', action: ['seedPipeline', 'seedTplPick'] });
  ok('the Save button is not a toast any more',
     !/toastAttrs\('Template saved'/.test(SRC['views-global.js']));
  ok('…and the old "versions of one live SOP" framing went with the rewrite',
     !/Bank a copy/.test(SRC['views-global.js']) &&
     !/live — seeds new shows/.test(SRC['views-global.js']) &&
     !/listTemplateVersions/.test(API_JS));
  ok('a pm cannot write a template — POST',
     (await POST('/api/templates', { name: 'sneak', event_type: 'led' }, { token: T.brenden })).status === 403);
  const wtplLive = await GET('/api/templates/led', { token: T.morgan });
  ok('a pm cannot write a template — PUT / DELETE',
     (await PUT(`/api/templates/${wtplLive.body.id}`, { name: 'sneak' }, { token: T.brenden })).status === 403 &&
     (await DEL(`/api/templates/${wtplLive.body.id}`, { token: T.brenden })).status === 403);

  // ── (a) a SECOND named template, and seeding WITH ITS id ──────────────────
  const wtpl2 = await POST('/api/templates', {
    name: 'LED — walk one-day turn', event_type: 'led',
    description: 'the second template of a type — the one the old screen could not reach',
    steps: [{ lane: 'gear', title: 'WALK2 one-day prep', due_offset_days: -2 },
            { lane: 'crew', title: 'WALK2 one-day crew call', due_offset_days: -1 }]
  }, { token: T.morgan });
  ok('morgan creates a SECOND named LED template', wtpl2.status === 200 && wtpl2.body.id > 0, wtpl2.body);
  ok('…and asking by TYPE still answers the standard — the machine contract holds',
     (await GET('/api/templates/led', { token: T.morgan })).body.id === wtplLive.body.id);
  const wlib = (await GET('/api/templates?event_type=led', { token: T.morgan })).body || [];
  ok('…while the library lists both, exactly the older one chipped `standard`',
     wlib.filter((t) => t.id === wtpl2.body.id || t.id === wtplLive.body.id).length === 2 &&
     wlib.filter((t) => t.standard).length === 1 &&
     wlib.find((t) => t.standard).id === wtplLive.body.id, wlib.map((t) => [t.id, t.standard]));
  const wpickShow = await POST('/api/shows',
    { project_id: PROJ, name: 'AVCA Template Pick', event_date: plus(45) }, { token: T.brenden });
  const WSP = wpickShow.body.id;
  const wtplSeed = await POST(`/api/shows/${WSP}/instantiate-template`,
    { template_id: wtpl2.body.id }, { token: T.brenden });
  ok('Seed pipeline with an EXPLICIT template_id lands that template',
     wtplSeed.status === 200 && wtplSeed.body.instantiated_steps === 2, wtplSeed.body);
  const wpickTitles = (await pool.query(
    'SELECT title FROM steps WHERE show_id=$1 ORDER BY sort_order', [WSP])).rows.map((r) => r.title);
  ok('…ITS OWN titles — not one row of the type’s standard came along',
     wpickTitles.length === 2 && wpickTitles.every((t) => /^WALK2 /.test(t)), wpickTitles);

  // ── (b) DUPLICATE copies the step ROWS; the copy is independent ───────────
  const wdup = await POST('/api/templates',
    { name: 'LED — walk duplicate', copy_from: wtpl2.body.id }, { token: T.morgan });
  ok('Duplicate creates a new template of the source’s type',
     wdup.status === 200 && wdup.body.id !== wtpl2.body.id && wdup.body.event_type === 'led', wdup.body);
  const wdupRows = (await pool.query(
    'SELECT id, template_id FROM template_steps WHERE template_id IN ($1,$2)',
    [wtpl2.body.id, wdup.body.id])).rows;
  ok('…carrying its OWN copies — four rows across the two, no row id shared',
     (wdup.body.steps || []).length === 2 && wdupRows.length === 4 &&
     new Set(wdupRows.map((r) => r.id)).size === 4, wdupRows.length);
  await PUT(`/api/templates/${wdup.body.id}`, {
    steps: [{ lane: 'gear', title: 'WALK-DUP edited only here', due_offset_days: -3 }]
  }, { token: T.morgan });
  const wsrcAfter = (await pool.query(
    'SELECT title FROM template_steps WHERE template_id=$1 ORDER BY sort_order',
    [wtpl2.body.id])).rows.map((r) => r.title);
  ok('…and editing the COPY never reaches back into the original',
     wsrcAfter.length === 2 && wsrcAfter.every((t) => /^WALK2 /.test(t)), wsrcAfter);

  // ── (c) the New Event composite honours the picker ────────────────────────
  const wevPick = await POST('/api/events',
    { name: 'WALK picked-template event', type: 'led', event_date: plus(50),
      template_id: wtpl2.body.id }, { token: T.morgan });
  const wevTitles = (await pool.query('SELECT title FROM steps WHERE show_id=$1',
    [wevPick.body.show.id])).rows.map((r) => r.title);
  ok('New Event with a chosen template_id seeds THAT template, by title',
     wevPick.body.instantiated_steps === 2 && wevTitles.every((t) => /^WALK2 /.test(t)), wevTitles);
  const wevNone = await POST('/api/events',
    { name: 'WALK no-template event', type: 'led', event_date: plus(51), seed_template: false },
    { token: T.morgan });
  ok('…"None — start empty" opens the event with ZERO steps',
     wevNone.body.instantiated_steps === 0, wevNone.body.instantiated_steps);
  const wevStd = await POST('/api/events',
    { name: 'WALK standard event', type: 'led', event_date: plus(52) }, { token: T.morgan });
  ok('…and naming no template at all still seeds the standard — agents untouched',
     wevStd.body.instantiated_steps > 2, wevStd.body.instantiated_steps);
  const PROPS_JS = fs.readFileSync(path.join(APP, 'routes', 'proposals.js'), 'utf8');
  ok('the agent path resolves the STANDARD on purpose, and says why at the site',
     /standardTemplateId\(proj\.type, c\)/.test(PROPS_JS) && /no human to ask/.test(PROPS_JS));

  // ── the doors, over the source ────────────────────────────────────────────
  const neSrc = APP_JS.slice(APP_JS.indexOf('function newEventForm'),
    APP_JS.indexOf('async function refreshFinanceUI'));
  ok('the New Event dialog carries a Template select',
     /id="neTpl"/.test(neSrc) && /tplPickerOptions\(NEW_EVENT\.tpls, type\)/.test(neSrc));
  ok('…whose answer rides the composite as template_id + seed_template',
     /template_id: tplId \? Number\(tplId\) : null, seed_template: !!tplId/.test(neSrc));
  ok('…and the picker offers "None" and preselects the type’s standard',
     /None — start empty/.test(APP_JS) && /t\.meta && t\.meta\.standard/.test(APP_JS));
  const nsSrc = APP_JS.slice(APP_JS.indexOf('async function openAddShow'),
    APP_JS.indexOf('async function seedPipelineAct'));
  ok('Add show on a season dashboard carries the same select — the yes/no checkbox is gone',
     /id="nsTpl"/.test(nsSrc) && !/nsSeed/.test(nsSrc));
  const seedSrc = APP_JS.slice(APP_JS.indexOf('async function seedPipelineAct'),
    APP_JS.indexOf('async function openAddJob'));
  ok('Seed pipeline seeds DIRECTLY when the type owns exactly one template',
     /seedPipelineWith\(showId, Number\(tpls\[0\]\.meta\.id\), show\)/.test(seedSrc));
  ok('…and opens a picker when it owns more than one',
     /tpls\.length > 1\) return openSeedPicker/.test(seedSrc));
  ok('…with the idempotent toast semantics kept verbatim',
     /skipped_steps/.test(seedSrc) && /Nothing new to seed/.test(seedSrc) &&
     /already on this show, skipped/.test(seedSrc));

  // ── THE LIBRARY, RENDERED from the file:// demo ───────────────────────────
  // A door asserted only over source is a door nobody has drawn. The demo twin
  // holds a REAL multi-template library now, so the whole screen renders
  // headless — the same eight-global shim as the seed-parity block above, with
  // one more file loaded into it.
  new vm.Script(SRC['views-global.js'], { filename: 'public/views-global.js' }).runInContext(demoTab);
  const dTpls = await demoTab.api.listTemplates();
  const dTypes = await demoTab.api.listEventTypes();
  const dLed = dTpls.filter((t) => t.event_type === 'led');
  ok('DEMO: the twin holds MORE THAN ONE led template — the pickers have something to pick',
     dLed.length > 1, dLed.length);
  ok('…exactly one chipped standard, and it is the lowest id',
     dLed.filter((t) => t.meta.standard).length === 1 &&
     Number(dLed.filter((t) => t.meta.standard)[0].meta.id) ===
       Math.min(...dLed.map((t) => Number(t.meta.id))));
  const dLedStd = dLed.filter((t) => t.meta.standard)[0];
  const dLedAlt = dLed.filter((t) => !t.meta.standard)[0];
  const libHtml = demoTab.viewTemplates(await demoTab.api.listProjects(), dTpls, dTypes);
  ok('DEMO RENDER · the library draws a New-template door',
     /data-act="tplNew"/.test(libHtml));
  ok('…a card per template, each wearing its own NAME',
     dTpls.every((t) => libHtml.indexOf(demoTab.esc(t.meta.name)) >= 0));
  ok('…each selectable by id, so the second template of a type is reachable',
     dTpls.every((t) => libHtml.indexOf('data-act="selectTpl" data-id="' + t.meta.id + '"') >= 0));
  ok('…the standard chip, and no "live SOP vs banked" split left on the page',
     /standard<\/span>/.test(libHtml) && !/banked/.test(libHtml) && !/Bank a copy/.test(libHtml));
  ok('DEMO RENDER · the editor offers rename, duplicate, delete and save',
     /data-act="tplRename"/.test(libHtml) && /data-act="tplDuplicate"/.test(libHtml) &&
     /data-act="tplDelete"/.test(libHtml) && /data-act="tplSave"/.test(libHtml));
  ok('…and the deliberately-honest disabled add-a-lane button survives the redesign',
     /addlane/.test(libHtml) && /Lanes are the event type/.test(libHtml));

  // the demo twin's own write half — duplicate by VALUE, and an explicit seed
  const dDup = await demoTab.api.createTemplate(
    { name: 'WALK demo duplicate', copy_from: dLedStd.meta.id });
  ok('DEMO: createTemplate duplicates, copying the source’s step count',
     demoTab.tplStepCount(dDup) === demoTab.tplStepCount(dLedStd),
     [demoTab.tplStepCount(dDup), demoTab.tplStepCount(dLedStd)]);
  await demoTab.api.updateTemplate(dDup.meta.id,
    { steps: [{ lane: 'gear', title: 'demo copy-only row', due_offset_days: -4 }] });
  ok('…and editing the demo copy never touches the demo original',
     demoTab.tplStepCount(await demoTab.api.getTemplate(dLedStd.meta.id))
       === demoTab.tplStepCount(dLedStd));
  const dPickShow = await demoTab.api.createShow(dShow.project_id,
    { name: 'WALK demo picked template', seed_template: false, event_date: plus(60) });
  const dPick = await demoTab.api.instantiateTemplate(dPickShow.id, dLedAlt.meta.id);
  ok('DEMO: seeding with an explicit template_id lands ITS steps, not the standard’s',
     dPick.instantiated_steps === demoTab.tplStepCount(dLedAlt) &&
     dPick.instantiated_steps !== demoTab.tplStepCount(dLedStd), dPick);
  const dRename = await demoTab.api.updateTemplate(dDup.meta.id, { name: 'WALK demo renamed' });
  ok('…and the demo closes the lifecycle from file:// — rename, then delete',
     dRename.meta.name === 'WALK demo renamed' &&
     (await demoTab.api.deleteTemplate(dDup.meta.id)).ok === true &&
     (await demoTab.api.listTemplates()).every((t) => Number(t.meta.id) !== Number(dDup.meta.id)));

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

  // ══════════════════════════════════════════════════════════════════════════
  section('34 · the spec\'s whole life — bind v2 over v1, flag it, unbind it, rebind  (Tom 2026-08-28)');
  // ══════════════════════════════════════════════════════════════════════════
  // "can i update these when changes are made?" The month's spec story, walked
  // end to end: Brenden binds the content spec, the tool re-binds a revision
  // (v1 auto-supersedes, KEPT), the client changes the design so he flags the
  // record outdated, then detaches it entirely, then binds the real
  // replacement — and at every step the history answers for every version.
  reach('Spec history (Specs tab)', { seam: 'listSpecHistory', action: ['specHistory', 'specViewRev'] });
  reach('Mark a spec outdated / un-flag it', { seam: 'outdateSpec',
                                               action: ['specOutdate', 'specOutdateClear'] });
  reach('Unbind a spec', { seam: 'unbindSpec', action: 'specUnbind' });
  ok('the scope chip gained the outdated warn state — the season row says it too',
     /sc-od/.test(SRC['components.js']) && /scope-chip\.od/.test(fs.readFileSync(path.join(PUB, 'app.css'), 'utf8')));

  // a minimal honest .e360: truthy `version`, no `_app` (lib/speccheck's sniff)
  const walkE360 = (label) => ({
    version: 1, layoutMode: 'complex', complexUnit: 'ft',
    fields: { clientName: 'AVCA', venueName: 'Fiserv Forum', cabinetType: 'BP2V2',
              fieldLength: '110', fieldWidth: '59', totalCabinets: '144' },
    complexSections: [], zones: [], clientLogoDataUrl: null, _walkLabel: label
  });

  // ── production shape FIRST: the atomic bind refuses cleanly with no NAS ───
  // This server runs with no storage on purpose (§12), and spec-bind writes
  // real bytes INSIDE its transaction by design — so here the honest answer is
  // a 501 that leaves NO half-bound show: no chain bump, no files row, no
  // render. That atomicity claim is exactly what a walk in this shape can
  // prove and the storage-backed suites cannot.
  const wbNoStore = await POST(`/api/shows/${SHOW}/spec-bind`,
    { specType: 'e360', json: walkE360('v0'), suggestedName: 'doomed' }, { token: T.brenden });
  ok('with no storage the bind is a 501 — not a half-write', wbNoStore.status === 501, wbNoStore.status);
  ok('…and NOTHING half-bound: no chain rev, no files row, no render row',
     (await pool.query(`SELECT COUNT(*)::int AS n FROM spec_chain WHERE show_id=$1 AND node='content' AND gen`, [SHOW])).rows[0].n === 0 &&
     (await pool.query(`SELECT COUNT(*)::int AS n FROM files WHERE show_id=$1 AND chain_key='content'`, [SHOW])).rows[0].n === 0 &&
     (await pool.query(`SELECT COUNT(*)::int AS n FROM spec_renders WHERE show_id=$1`, [SHOW])).rows[0].n === 0);

  // ── the binds themselves run in a CHILD server on the same database with a
  // throwaway STORAGE_ROOT — the same out-of-process trick §12's probe uses,
  // because lib/storage.js reads its env once at require time. Everything
  // else in the story (history, outdate, unbind) is storage-free and runs
  // against the main server like every other step.
  const bindViaStorageServer = (binds) => {
    const script =
      `(async () => {
        const srv = require(${JSON.stringify(path.join(APP, 'server.js').replace(/\\/g, '/'))});
        const server = await srv.boot();
        const base = 'http://127.0.0.1:' + server.address().port;
        const login = await fetch(base + '/api/auth/login', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'brenden', password: ${JSON.stringify(PW)} }) });
        const tok = (await login.json()).token;
        const out = [];
        for (const b of JSON.parse(process.env.WALK_BINDS)) {
          const r = await fetch(base + '/api/shows/' + ${Number(SHOW)} + '/spec-bind', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': tok },
            body: JSON.stringify(b) });
          out.push({ status: r.status, body: await r.json() });
        }
        console.log('WALKBIND ' + JSON.stringify(out));
        server.close();
        process.exit(0);
      })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PORT: '0', SWEEP_ON_BOOT: '0',
             WALK_BINDS: JSON.stringify(binds),
             STORAGE_ROOT: path.join(os.tmpdir(), 'sr-walk-bind-storage') }
    });
    const m = String(r.stdout || '').match(/WALKBIND (.*)/);
    if (!m) console.error('  (bind child failed)', String(r.stderr || '').slice(0, 400));
    return m ? JSON.parse(m[1]) : [];
  };

  const [wb1, wb2] = bindViaStorageServer([
    { specType: 'e360', json: walkE360('v1'), suggestedName: 'AVCA content v1' },
    { specType: 'e360', json: walkE360('v2'), suggestedName: 'AVCA content v2' }
  ]);
  ok('Brenden binds the content spec at v1 (child server with storage — see §12)',
     wb1 && wb1.status === 200 && wb1.body.rev === 1, wb1 && wb1.body);
  ok('the tool re-binds — v2 SUPERSEDES v1, never deletes it',
     wb2 && wb2.status === 200 && wb2.body.rev === 2
     && wb2.body.supersededFileIds.includes(wb1.body.fileId),
     wb2 && wb2.body.supersededFileIds);
  ok('…v1\'s file is still on the record, marked',
     (await GET(`/api/files/${wb1.body.fileId}`, { token: T.omar })).body?.status === 'superseded');

  const wh1 = await GET(`/api/shows/${SHOW}/spec-history`, { token: T.omar });
  ok('Spec history shows BOTH — v2 current, v1 superseded, and Omar may look',
     wh1.status === 200 &&
     wh1.body.versions.some((v) => v.rev === 2 && v.state === 'current') &&
     wh1.body.versions.some((v) => v.rev === 1 && v.state === 'superseded'),
     wh1.body.versions?.map((v) => [v.rev, v.state]));
  ok('…and v1 still OPENS — history means viewable',
     (await GET(`/api/shows/${SHOW}/spec-render/content?rev=1`, { token: T.omar })).status === 200);

  ok('a pm who owns nothing cannot flag the spec outdated',
     (await POST(`/api/shows/${SHOW}/spec-outdate`, { node: 'content' }, { token: T.pat })).status === 403);
  const wOd = await POST(`/api/shows/${SHOW}/spec-outdate`,
    { node: 'content', note: 'client added a second wall' }, { token: T.brenden });
  ok('Brenden flags it — the client changed the design, nothing new bound yet',
     wOd.status === 200 && wOd.body.chain.content.outdated === true, wOd.body.chain?.content);
  ok('…the show payload now carries spec_outdated for every season-row chip',
     (await GET(`/api/shows/${SHOW}`, { token: T.omar })).body.spec_outdated === true);
  ok('…and the flag is a statement on the record, not a deletion',
     (await activityFor(SHOW, 'spec.outdate')).some((r) => /second wall/.test(r.detail)));

  ok('a pm who owns nothing cannot unbind either',
     (await POST(`/api/shows/${SHOW}/spec-unbind`, { node: 'content' }, { token: T.pat })).status === 403);
  const wUb = await POST(`/api/shows/${SHOW}/spec-unbind`, { node: 'content' }, { token: T.brenden });
  ok('Brenden unbinds — the show carries no content spec now',
     wUb.status === 200 && wUb.body.chain.content.gen === false, wUb.body);
  const wDetached = (await pool.query('SELECT * FROM files WHERE id=$1', [wb2.body.fileId])).rows[0];
  ok('…the file SURVIVES as a plain document (filed, chain_key cleared)',
     !!wDetached && wDetached.status === 'filed' && wDetached.chain_key === null, wDetached);
  ok('…and the history keeps v2 as `unbound`, still openable',
     (await GET(`/api/shows/${SHOW}/spec-history`, { token: T.brenden }))
       .body.versions.some((v) => v.rev === 2 && v.state === 'unbound') &&
     (await GET(`/api/shows/${SHOW}/spec-render/content?rev=2`, { token: T.brenden })).status === 200);

  const [wb3] = bindViaStorageServer([
    { specType: 'e360', json: walkE360('v3'), suggestedName: 'AVCA content v3 — the real replacement' }
  ]);
  ok('the replacement binds at v3 — numbering continues, never a second v1',
     wb3 && wb3.status === 200 && wb3.body.rev === 3, wb3 && wb3.body.rev);
  ok('…outdated is gone and the node is live again',
     wb3 && wb3.body.chain.content.outdated === false &&
     (await GET(`/api/shows/${SHOW}/spec-render/content`, { token: T.omar })).status === 200);

  // ══════════════════════════════════════════════════════════════════════════
  section('35 · gear history — Omar banks the pull sheet, the folder remembers  (Tom 2026-08-28)');
  // ══════════════════════════════════════════════════════════════════════════
  // "would like to look back and see what gear was used on previous events."
  // The live Flex read stays live; what Omar banks here is the parsed sheet he
  // is looking at, saved as a dated record on the show — listed, opened
  // read-only, and deletable only by the pm who owns the folder.
  reach('Save snapshot (gear tab)', { seam: 'saveGearSnapshot', action: 'gearSnapSave' });
  reach('Gear history — list, open, back', { seam: ['listGearSnapshots', 'getGearSnapshot'],
                                             action: ['gearSnapOpen', 'gearSnapBack'] });
  reach('Delete a snapshot', { seam: 'deleteGearSnapshot', action: 'gearSnapDelete' });

  const wSheet = {
    listId: '9e8d7c6b-1111-4222-8333-444455556666', name: 'AVCA First Serve',
    docNumber: 'PS-2201', type: 'pull-sheet', fetchedAt: new Date().toISOString(),
    status: { stages: [] },
    groups: [
      { id: 'wg1', name: 'LED Cabinets', path: 'LED Cabinets', type: 'category', containerSerial: '',
        items: [{ name: 'BP2 V2 cabinet', qty: 144, barcode: '00500', serial: '', note: '',
                  resourceId: 'res-bp2', contains: 0, qtyAssumed: false }] }
    ],
    totals: { groups: 1, lines: 1, units: 144 }, empty: false, rowCount: 1
  };
  ok('a pm who owns nothing cannot bank a snapshot',
     (await POST(`/api/shows/${SHOW}/gear-snapshots`, { sheet: wSheet }, { token: T.pat })).status === 403);
  const wSnap = await POST(`/api/shows/${SHOW}/gear-snapshots`, { sheet: wSheet }, { token: T.omar });
  ok('Omar — the tech ON this crew — banks the sheet he read',
     wSnap.status === 200 && wSnap.body.kind === 'pull-sheet' && wSnap.body.units_count === 144,
     wSnap.body);
  const wHist = await GET(`/api/shows/${SHOW}/gear-snapshots`, { token: T.candice });
  ok('the history lists it for anyone signed in — label, counts, who, when — with no sheet body',
     wHist.status === 200 && wHist.body.length === 1 && wHist.body[0].doc_label === 'Pull Sheet'
     && wHist.body[0].saved_by === 'omar' && !('sheet' in wHist.body[0]), wHist.body[0]);
  const wOpen = await GET(`/api/gear-snapshots/${wSnap.body.id}`, { token: T.candice });
  ok('the detail renders the STORED lines — 144 cabinets, barcode intact',
     wOpen.status === 200 && wOpen.body.sheet.groups[0].items[0].qty === 144
     && wOpen.body.sheet.groups[0].items[0].barcode === '00500', wOpen.body.sheet?.totals);
  ok('the banked record leaves a trail',
     (await activityFor(SHOW, 'gear.snapshot')).some((r) => /144 units/.test(r.detail)));

  ok('Omar cannot delete what he banked — removing history is the pm\'s narrower act',
     (await DEL(`/api/gear-snapshots/${wSnap.body.id}`, { token: T.omar })).status === 403);
  ok('…nor can the pm who owns nothing',
     (await DEL(`/api/gear-snapshots/${wSnap.body.id}`, { token: T.pat })).status === 403);
  ok('Brenden deletes it — plain confirm in front, this gate behind',
     (await DEL(`/api/gear-snapshots/${wSnap.body.id}`, { token: T.brenden })).status === 200);
  ok('…and the history is honestly empty again',
     (await GET(`/api/shows/${SHOW}/gear-snapshots`, { token: T.brenden })).body.length === 0);

  // ══════════════════════════════════════════════════════════════════════════
  section('36 · the rooming list — one hotel block, everybody sleeps  (TEAM_FEEDBACK 2026-08-27)');
  // ══════════════════════════════════════════════════════════════════════════
  // The integration-testing finding: a hotel booking is ONE row for a block of
  // six, so five techs opened their packet to no lodging. The rooming list is
  // the per-person half, and Brenden fills it the way a PM actually would —
  // the whole crew in one click, then the stragglers by name.
  reach('Rooming — bulk-add the crew', { seam: 'seedRoomingFromCrew', action: 'roomSeedCrew' });
  reach('Rooming — add / edit / delete a row', {
    seam: ['listRooming', 'addRooming', 'updateRooming', 'deleteRooming'],
    action: ['roomAdd', 'roomEdit', 'roomCommit', 'roomDelete']
  });

  const wmCrew = await GET(`/api/shows/${SHOW}/crew`, { token: T.brenden });
  const wmSeed = await POST(`/api/shows/${SHOW}/rooming/from-crew`, {}, { token: T.brenden });
  ok('one click rooms the whole crew — a row per person, the local hire included',
     wmSeed.status === 200 && wmSeed.body.added.length === wmCrew.body.length
     && wmSeed.body.added.some((r) => !r.user_username),
     { crew: wmCrew.body.length, added: wmSeed.body?.added?.length });
  ok('…idempotently — the second click adds nobody',
     (await POST(`/api/shows/${SHOW}/rooming/from-crew`, {}, { token: T.brenden })).body.added.length === 0);

  const wmLocal = await POST(`/api/shows/${SHOW}/rooming`, {
    person: 'Reggie Beaumont', hotel: 'Best Western Ltd', room_type: 'Double',
    notes: 'client’s AV guy — rides our block'
  }, { token: T.brenden });
  ok('a free-text add — no login needed to have a bed',
     wmLocal.status === 200 && wmLocal.body.user_username === null, wmLocal.body);

  const wmRow = wmSeed.body.added.filter((r) => r.user_username === 'omar')[0];
  const wmConf = await PUT(`/api/rooming/${wmRow.id}`, {
    hotel: 'Drury Plaza', room_type: 'King', confirmation: 'DP-20443',
    check_in: plus(29), check_out: plus(32)
  }, { token: T.brenden });
  ok('the row takes its hotel, room and conf number',
     wmConf.status === 200 && wmConf.body.confirmation === 'DP-20443', wmConf.body);

  ok('Omar — a tech — SEES the list; his own bed is on it',
     ((await GET(`/api/shows/${SHOW}/rooming`, { token: T.omar })).body || [])
       .some((r) => r.user_username === 'omar'));
  ok('…but cannot edit it (rank)',
     (await PUT(`/api/rooming/${wmRow.id}`, { hotel: 'x' }, { token: T.omar })).status === 403);
  ok('…and Pat, the pm who owns nothing, cannot either (ownership)',
     (await PUT(`/api/rooming/${wmRow.id}`, { hotel: 'x' }, { token: T.pat })).status === 403);

  // link the bed to the booked block, then cancel the block — the link goes,
  // the bed stays. This is the exact null-not-delete rule smoke pins at the
  // table, walked here through the affordances a person clicks.
  const wmBk = await POST('/api/bookings', { show_id: SHOW, category: 'Lodging — crew block',
    vendor: 'Drury Plaza', status: 'done', amount: 2600 }, { token: T.brenden });
  const wmLink = await PUT(`/api/rooming/${wmRow.id}`, { booking_id: wmBk.body.id }, { token: T.brenden });
  ok('the row links to the booked hotel block',
     wmLink.status === 200 && wmLink.body.booking_id === wmBk.body.id, wmLink.body);
  await DEL(`/api/bookings/${wmBk.body.id}`, { token: T.brenden });
  const wmKept = ((await GET(`/api/shows/${SHOW}/rooming`, { token: T.brenden })).body || [])
    .filter((r) => r.id === wmRow.id)[0];
  ok('cancelling the booking clears the LINK and keeps the BED',
     wmKept && wmKept.booking_id === null && wmKept.confirmation === 'DP-20443', wmKept);

  const wmBad = await PUT(`/api/rooming/${wmRow.id}`,
    { check_in: plus(32), check_out: plus(29) }, { token: T.brenden });
  ok('a stay that ends before it starts is refused, naming check_out',
     wmBad.status === 400 && /check_out/.test(wmBad.body.error), wmBad.body);

  ok('a row comes off the list',
     (await DEL(`/api/rooming/${wmLocal.body.id}`, { token: T.brenden })).status === 200);
  ok('…and the trail carries the whole story — the bulk add, the straggler, the removal',
     (await activityFor(SHOW, 'rooming.add')).length >= 2
     && (await activityFor(SHOW, 'rooming.remove')).length === 1);

  const wmSheet = await GET(`/api/shows/${SHOW}/call-sheet`, { token: T.omar });
  ok('the assembled call sheet now answers "where do I sleep"',
     wmSheet.status === 200 && (wmSheet.body.rooming || []).some((r) => r.user_username === 'omar'),
     wmSheet.body.rooming?.length);

  // a scratch show's whole rooming list dies with the show — zero orphans
  const wmShow = await POST('/api/shows', { project_id: PROJ, name: 'Rooming scratch',
    venue: 'x', event_date: plus(60), seed_template: false }, { token: T.brenden });
  await POST(`/api/shows/${wmShow.body.id}/rooming`, { person: 'Ghost Guest' }, { token: T.brenden });
  await DEL(`/api/shows/${wmShow.body.id}`, { token: T.brenden });
  ok('a deleted show takes its rooming list with it — zero orphans',
     (await pool.query('SELECT COUNT(*)::int AS n FROM room_assignments WHERE show_id=$1',
       [wmShow.body.id])).rows[0].n === 0);

  // ══════════════════════════════════════════════════════════════════════════
  section('37 · the browser half — the REAL api.js, asked the way a CLICK asks');
  // ══════════════════════════════════════════════════════════════════════════
  // 2026-09-03. api.features() read `.features` off the UNAWAITED promise
  // SR.serverConfig() returns, so in API mode the flags were always {} and the
  // push button toasted "Scheduler not configured" against a fully configured
  // server. Every suite stayed green: smoke drives the ROUTES, the walk drives
  // the seam's REACHABILITY and the server — nobody ever EXECUTED the one
  // async line that joins them for a click. "The walk only protects what it
  // reach()es" extends to the browser half: reach() proves api.features
  // EXISTS; only running it proves it resolves to a VALUE. So this harness
  // loads the REAL public/api.js — the byte-for-byte file the walk already
  // read for reach(), never a copy — into a vm context and asserts through the
  // ASYNC public surface, against this walk's own live server.
  //
  // The shim is deliberately tiny — the eight globals below and nothing else.
  // If api.js ever grows a dependency this list cannot carry, the honest move
  // is to let this loudly break and reconsider, not to grow a fake browser.
  const tab = (() => {
    const store = new Map();
    const ctx = {
      // a browser resolves relative fetches against the page origin; the shim
      // resolves them against this walk's server, and nowhere else.
      fetch: (p, opts) => fetch(new URL(p, BASE), opts),
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
      },
      location: { protocol: 'http:' },  // file:// is probe()'s demo trapdoor — not here
      setTimeout, clearTimeout, AbortController, console
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    new vm.Script(API_JS, { filename: 'public/api.js' }).runInContext(ctx);
    return ctx;
  })();
  ok('the REAL public/api.js loads headless on the eight-global shim',
     !!tab.SR && typeof tab.api?.features === 'function',
     Object.keys(tab).filter((k) => k !== 'window'));
  ok('SR.probe() finds this walk’s server and lands in API mode',
     (await tab.SR.probe()) === 'api');

  // fail-closed first: this server booted with SCHEDULER_BASE_URL deleted.
  // Note what this assertion CANNOT catch: the unawaited-promise bug also
  // read as fail-closed here, which is exactly why it survived — so the next
  // assertion pins the SHAPE of the answer, not just its falsiness.
  const feat1 = await tab.api.features();
  ok('await api.features() fails CLOSED while the scheduler is unconfigured',
     !feat1.schedulerPush, feat1);
  ok('…and resolves to a VALUE carrying a boolean gate — not a promise-shaped read',
     typeof feat1.then !== 'function' && typeof feat1.schedulerPush === 'boolean', feat1);

  // the stale tab, replayed. /api/config reads process.env per REQUEST, so
  // setting the var here IS the deploy that picked up SCHEDULER_* while an
  // open tab — this vm context — kept answering from boot. Presence is the
  // flag; nothing dials the address, so a dead one is the safe fixture.
  process.env.SCHEDULER_BASE_URL = 'http://127.0.0.1:1';
  ok('the deploy lands — the ROUTE says schedulerPush the moment env changes',
     (await GET('/api/config')).body.features.schedulerPush === true);
  const feat2 = await tab.api.features();
  ok('THE STALE TAB · the SAME loaded api.js re-reads LIVE and the push button unlocks',
     typeof feat2.then !== 'function' && feat2.schedulerPush === true, feat2);
  delete process.env.SCHEDULER_BASE_URL;      // the walk's shape, restored
  const feat3 = await tab.api.features();
  ok('…and a revoked config closes the gate on the very next read — no reload needed',
     feat3.schedulerPush === false, feat3);

  // ══════════════════════════════════════════════════════════════════════════
  section('38 · the green checkmark tells the truth  (Tom 2026-09-03, live)');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom's screenshots from live testing: "Could not list staffing events",
  // "Could not download …", and "Filed, but the bytes did not land" — every
  // one wearing the SUCCESS check, because toast() had exactly one face.
  // Brendon read a failed upload as a done one off that check. The component
  // now takes an explicit kind, and this scan holds the CALL SITES to it,
  // mechanically, the way the size-stamp scan holds HARDENING 21: a toast
  // fired from a catch block, or titled like a failure ("Could not…",
  // "Not filed…", "Failed…", "…did not land", "…not configured"), must pass
  // 'err' — so a future catch-block toast cannot ship green-checked.
  ok('toast() takes an explicit kind and picks the alert face for it',
     /function toast\(b, s, kind\)[\s\S]{0,400}icon\(k === 'ok' \? 'check' : 'alert'\)/
       .test(SRC['components.js']));
  {
    const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
    ok('…and the err/warn faces wear the crit/warn accents, not the success one',
       /\.toast\.err\{border-left-color:var\(--crit\)\}/.test(css) &&
       /\.toast\.err svg\{color:var\(--crit\)\}/.test(css) &&
       /\.toast\.warn\{border-left-color:var\(--warn\)\}/.test(css));
  }
  {
    // string/comment-aware span matcher — a title like "(demo)" must not
    // derail the paren scan, and a commented-out toast must not count.
    const spanEnd = (src, open) => {
      const closer = src[open] === '(' ? ')' : '}';
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === "'" || ch === '"' || ch === '`') {
          const q = ch; i++;
          while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
          continue;
        }
        if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
        if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) i = src.length; continue; }
        if (ch === src[open]) depth++;
        else if (ch === closer) { depth--; if (depth === 0) return i + 1; }
      }
      return src.length;
    };
    // catch blocks, both statement form and .catch(function () { … })
    const catchRangesOf = (src) => {
      const out = [];
      const re = /catch\s*(\([^)]*\))?\s*\{/g;
      let m;
      while ((m = re.exec(src))) out.push([re.lastIndex - 1, spanEnd(src, re.lastIndex - 1)]);
      return out;
    };
    let checked = 0;
    const naked = [];
    for (const fname of Object.keys(SRC)) {
      const src = SRC[fname];
      const ranges = catchRangesOf(src);
      const re = /toast\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        const before = src.slice(Math.max(0, m.index - 10), m.index);
        if (/function\s*$/.test(before) || /[\w$.]$/.test(before)) continue;
        const open = src.indexOf('(', m.index);
        const args = src.slice(open + 1, spanEnd(src, open) - 1);
        const titleM = args.match(/^\s*'((?:[^'\\]|\\.)*)'/);
        const failTitle = titleM &&
          (/^(Could not|Not filed|Failed)/.test(titleM[1]) ||
           /did not land|not configured/.test(titleM[1]));
        const inCatch = ranges.some(([a, b]) => m.index > a && m.index < b);
        if (!inCatch && !failTitle) continue;
        checked += 1;
        const stripped = args.replace(/\/\*[\s\S]*?\*\//g, '').trimEnd();
        if (!/,\s*'err'$/.test(stripped)) {
          naked.push(`${fname}:${src.slice(0, m.index).split('\n').length}` +
                     ` "${titleM ? titleM[1] : '(dynamic)'}"`);
        }
      }
    }
    ok('the scan sees the failure toasts at all (>= 120 call sites)', checked >= 120, checked);
    ok('EVERY catch-block toast and every failure-titled toast passes the ERROR kind',
       naked.length === 0, naked.slice(0, 6).join(' · '));
  }
  // the three toasts from Tom's screenshots, pinned by name — the rule above
  // is general; these are the incidents it must never let regress.
  for (const t of ['Could not list staffing events', 'Could not download ',
                   'Filed, but the bytes did not land']) {
    const hits = [...APP_JS.matchAll(new RegExp(`toast\\('${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))];
    ok(`“${t.trim()}” exists and wears the error face`,
       hits.length > 0 && hits.every((h) => {
         const open = APP_JS.indexOf('(', h.index);
         let i = open, depth = 0;
         for (; i < APP_JS.length; i++) {
           const ch = APP_JS[i];
           if (ch === "'") { i++; while (i < APP_JS.length && APP_JS[i] !== "'") { if (APP_JS[i] === '\\') i++; i++; } continue; }
           if (ch === '(') depth++;
           else if (ch === ')') { depth--; if (!depth) break; }
         }
         return /,\s*'err'\s*$/.test(APP_JS.slice(open + 1, i));
       }), hits.length);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('39 · the byteless row is VISIBLE — and recoverable in one click');
  // ══════════════════════════════════════════════════════════════════════════
  // Brendon's Rhino booking doc, the other half: a metadata row with size 0
  // and no bytes on the NAS rendered exactly like a finished document on
  // every list and card, and Tom learned the truth from a download error.
  // The two-tier model DESIGNED this state to be visible and retryable; the
  // product never drew the state or offered the retry. Now every place a file
  // renders flags "no document — metadata only", and the flagged row carries
  // an Upload affordance that re-runs the byte half onto the existing record.
  reach('Upload the missing document', {
    seam: 'uploadFileBytes', action: 'uploadMissingBytes' });
  ok('fileIsByteless keys on the size the SERVER owns, API mode only',
     /function fileIsByteless\(f\)[\s\S]{0,250}SR\.isApi\(\)[\s\S]{0,150}Number\(f\.size\) > 0/
       .test(SRC['components.js']));
  ok('the flag says honest words on a warn accent',
     /no document — metadata only/.test(SRC['components.js']) &&
     /\.file-nobytes\{[^}]*color:var\(--warn\)/.test(fs.readFileSync(path.join(PUB, 'app.css'), 'utf8')));
  // every renderer, held mechanically — the bug was precisely a state one
  // screen knew about and four screens didn't.
  const FLAG_SITES = [
    ['files-tab card', SRC['views-folder.js'],
     /function fileCard\([\s\S]{0,900}fileBytelessFlag\(f\)[\s\S]{0,200}fileUploadChip\(f\)/],
    ['bookings row (the Rhino doc itself)', SRC['views-folder.js'],
     /fileBytelessFlag\(bkFile\)/],
    ['financial doc cards (job + show)', SRC['views-finance.js'],
     null],
    ['purchasing linked docs', SRC['views-purchasing.js'],
     /fileBytelessFlag\(f\)[\s\S]{0,200}fileUploadChip\(f\)/],
    ['viewer meta panel', SRC['views-global.js'],
     /fileIsByteless\(f\)[\s\S]{0,200}fileBytelessFlag\(f\)/]
  ];
  for (const [label, src, re2] of FLAG_SITES) {
    const pass2 = re2 ? re2.test(src)
      : (src.match(/fileBytelessFlag\(f\)/g) || []).length >= 2 &&
        (src.match(/fileUploadChip\(f\)/g) || []).length >= 2;
    ok(`the flag renders on the ${label}`, pass2);
  }
  ok('…and the viewer offers the recovery beside the flag',
     /act\('uploadMissingBytes', f\.id\)/.test(SRC['views-global.js']));

  // ── the live half: the row, the flag's predicate, and the recovery PUT ────
  const wGhost = await POST('/api/files',
    { show_id: SHOW, name: 'Rhino Staging — booking conf', ext: 'pdf', kind: 'confirmation' },
    { token: T.brenden });
  ok('a metadata-only row files honestly at size 0 — the state the flag draws',
     wGhost.status === 200 && Number(wGhost.body.size) === 0, wGhost.body.size);
  ok('…which is exactly the pair fileIsByteless() reads (id > 0, size not > 0)',
     Number(wGhost.body.id) > 0 && !(Number(wGhost.body.size) > 0));
  // the byte half runs in a CHILD server with a throwaway STORAGE_ROOT on the
  // same database — §34's out-of-process trick, because lib/storage.js reads
  // its env once at require time and THIS server is production-shaped (no NAS).
  const wRecover = (() => {
    const script =
      `(async () => {
        const srv = require(${JSON.stringify(path.join(APP, 'server.js').replace(/\\/g, '/'))});
        const server = await srv.boot();
        const base = 'http://127.0.0.1:' + server.address().port;
        const login = await fetch(base + '/api/auth/login', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'brenden', password: ${JSON.stringify(PW)} }) });
        const tok = (await login.json()).token;
        const r = await fetch(base + '/api/files/' + ${Number(wGhost.body.id)} + '/content', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'x-auth-token': tok },
          body: Buffer.from('the rhino confirmation, landing at last') });
        console.log('WALKBYTES ' + JSON.stringify({ status: r.status, body: await r.json() }));
        server.close();
        process.exit(0);
      })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PORT: '0', SWEEP_ON_BOOT: '0',
             STORAGE_ROOT: path.join(os.tmpdir(), 'sr-walk-bytes-storage') }
    });
    const m = String(r.stdout || '').match(/WALKBYTES (.*)/);
    if (!m) console.error('  (byte child failed)', String(r.stderr || '').slice(0, 400));
    return m ? JSON.parse(m[1]) : null;
  })();
  ok('the Upload affordance’s PUT lands bytes on the EXISTING row (child server with storage)',
     wRecover && wRecover.status === 200 && wRecover.body.size === 39,
     wRecover && wRecover.body);
  const wAfter = await GET(`/api/files/${wGhost.body.id}`, { token: T.brenden });
  ok('…the row now claims the TRUE byte count — the flag clears by arithmetic',
     Number(wAfter.body.size) === 39, wAfter.body.size);
  ok('…and nobody re-typed anything: same id, same name, same booking-facing record',
     wAfter.body.id === wGhost.body.id && wAfter.body.name === 'Rhino Staging — booking conf');
  const wCleanup = await DEL(`/api/files/${wGhost.body.id}`, { token: T.brenden });
  ok('…the probe row cleans up', wCleanup.status === 200, wCleanup.body);

  // ══════════════════════════════════════════════════════════════════════════
  section('40 · the staffing link — one roster, two apps  (Tom, 2026-09-03)');
  // ══════════════════════════════════════════════════════════════════════════
  // Live, the night the Big Ten show hit staffing event #118: pre-flight
  // refused on a crew name ("Devin Vlassis") and every remedy in the dialog
  // was manual detective work. Tom: "i need some sort of way to link techs.
  // or a single source of truth or something." The decision: SHOWRUNNER IS
  // THE SOURCE OF TRUTH FOR PEOPLE — the panel links spellings
  // (users.staffing_name), adds missing people to the staffing roster, and
  // claims free-text crew names. Every affordance below must be reachable,
  // every server door honest while unconfigured (this box's exact state), and
  // the MATCHER is executed — not scanned — through the browser-half vm.
  reach('Open the staffing link panel', {
    seam: ['listStaffingRoster', 'listCrewNames', 'staffingLinkBuckets'],
    action: ['openStaffingLink', 'goTeam'] });
  reach('Link a spelling (sets users.staffing_name)', { seam: 'updateUser', action: 'slLink' });
  reach('Add a person to the staffing roster', {
    seam: 'addToStaffingRoster', action: ['slAddRoster', 'slAddRosterGo'] });
  reach('Create a Showrunner user from a staffing row', { action: 'slCreateUser' });
  reach('Claim a crew name ("this is actually…")', { seam: 'updateCrew', action: 'slCrewFix' });
  ok('the push-confirm problems list carries the door to the panel',
     /crew names do not match the staffing roster/.test(APP_JS) &&
     /act\('openStaffingLink'\)/.test(APP_JS));
  ok('create-from-staffing reuses the ONE add-person dialog, prefilled — no second creation path',
     /openAddPerson\(\{ name: k, back: 'staffing' \}\)/.test(APP_JS) &&
     /ADD_PERSON_CTX/.test(APP_JS));
  ok('…and a rename before saving keeps the staffing spelling as the LINK',
     /body\.staffing_name = ADD_PERSON_CTX\.name/.test(APP_JS));
  ok('the add-to-roster confirm names the TARGET APP before anything crosses the wire',
     /Add to the staffing roster/.test(APP_JS) && /e360 staffing app/.test(APP_JS));
  ok('the panel says out loud that staffing names are FROZEN — no rename affordance exists',
     /Staffing names are frozen/.test(SRC['views-global.js']) &&
     !/slRename|renameRoster/.test(SRC['views-global.js']));
  ok('the exact-match state says a link is NOT needed, in words',
     /same name — nothing to set/.test(SRC['views-global.js']));

  // ── the honest doors, on this unconfigured box ────────────────────────────
  const slRoster501 = await GET('/api/scheduler/roster', { token: T.tom });
  ok('GET /api/scheduler/roster is the honest 501 while unconfigured, naming the env var',
     slRoster501.status === 501 && /SCHEDULER_BASE_URL/.test(slRoster501.body?.error || ''),
     slRoster501.body);
  ok('POST /api/scheduler/roster refuses honestly too',
     (await POST('/api/scheduler/roster', { user_id: 1 }, { token: T.tom })).status === 501);
  ok('…but a TECH is refused by RANK before configuration is even consulted (403, manager floor)',
     (await GET('/api/scheduler/roster', { token: T.omar })).status === 403);
  ok('…and /api/crew-names holds the same floor (tech 403, pm 403 — people admin sits above the push)',
     (await GET('/api/crew-names', { token: T.omar })).status === 403 &&
     (await GET('/api/crew-names', { token: T.pat })).status === 403);

  // ── Devin's case, end to end: free-text crew name → listed → claimed ──────
  const slGhostCrew = await POST(`/api/shows/${SHOW}/crew`,
    { name: 'Devin Vlassis', role_on_site: 'LED tech' }, { token: T.brenden });
  ok('a free-text crew line goes on the show (the state the panel exists for)',
     slGhostCrew.status === 200 && slGhostCrew.body.username == null, slGhostCrew.body);
  const slNames = await GET('/api/crew-names', { token: T.morgan });
  const slDevin = (slNames.body || []).find((g) => g.name === 'Devin Vlassis');
  ok('GET /api/crew-names lists it, grouped, with the crew-row id and the show',
     slNames.status === 200 && !!slDevin && slDevin.crew.length === 1
     && slDevin.crew[0].id === slGhostCrew.body.id, slNames.body);
  const slClaim = await PUT(`/api/crew/${slGhostCrew.body.id}`,
    { username: 'omar', name: null }, { token: T.tom });
  ok('the claim rewrites the crew line to the real person, through the normal crew route',
     slClaim.status === 200 && slClaim.body.username === 'omar', slClaim.body);
  const slNames2 = await GET('/api/crew-names', { token: T.tom });
  ok('…and the name leaves the unmatched list — it names somebody now',
     !(slNames2.body || []).some((g) => g.name === 'Devin Vlassis'), slNames2.body);

  // ── THE MATCHER, EXECUTED — the REAL api.js in the browser-half vm ────────
  // Fixtures shaped like Tom's actual roster: staffing rows that are first
  // names ("Devin"), case/whitespace-mangled full names, and a profile link.
  // Break staffingNorm's normalization and the linked bucket loses Marcus;
  // drop the ambiguity guard and the two Devins stop being a QUESTION.
  const SLB = tab.api.staffingLinkBuckets(
    [
      { id: 1, name: 'Devin Vlassis', username: 'dvlassis' },
      { id: 2, name: 'Devin Ortega', username: 'dortega' },
      { id: 3, name: 'Marcus Cole', username: 'mcole' },
      { id: 4, name: 'Bob Sawyer', username: 'bob', staffing_name: 'Robert Sawyer' },
      { id: 5, name: 'Priya Nair', username: 'pnair' }
    ],
    [
      { id: 11, name: '  MARCUS COLE ' },
      { id: 12, name: 'Robert Sawyer' },
      { id: 13, name: 'Devin' },
      { id: 14, name: 'Priya' },
      { id: 15, name: 'Dana Fields' }
    ],
    [
      { name: 'Priya Nair', crew: [{ id: 91 }] },
      { name: 'Robert Sawyer', crew: [{ id: 92 }] },
      { name: 'Total Stranger', crew: [{ id: 93 }] }
    ]);
  const slLinkedOf = (uname) => SLB.linked.find((l) => l.user.username === uname);
  ok('EXACT TIER · "  MARCUS COLE " links to Marcus Cole — staffing\'s own lowercase+trim join',
     !!slLinkedOf('mcole') && slLinkedOf('mcole').row.id === 11 && slLinkedOf('mcole').via === 'name',
     SLB.linked.map((l) => l.user.username));
  ok('EXACT TIER · …and an exact name match reports exact:true — no link needs setting',
     !!slLinkedOf('mcole') && slLinkedOf('mcole').exact === true);
  ok('LINK TIER · Bob Sawyer resolves through staffing_name to "Robert Sawyer", exact:false',
     !!slLinkedOf('bob') && slLinkedOf('bob').row.id === 12
     && slLinkedOf('bob').via === 'staffing_name' && slLinkedOf('bob').exact === false);
  const slHereOf = (uname) => SLB.here.find((h) => h.user.username === uname);
  ok('SUGGESTION TIER · first-name-only "Priya" suggests Priya Nair as SURE (one candidate)',
     !!slHereOf('pnair') && slHereOf('pnair').suggestions.some((s) => s.row.id === 14 && s.sure === true),
     slHereOf('pnair'));
  ok('AMBIGUITY GUARD · "Devin" reaches BOTH Devins and neither is "probably" — ask, don\'t accuse',
     ['dvlassis', 'dortega'].every((un) => {
       const h = slHereOf(un);
       const s = h && h.suggestions.find((x) => x.row.id === 13);
       return !!s && s.sure === false && s.alsoMatches.length === 1;
     }), SLB.here.map((h) => ({ u: h.user.username, s: h.suggestions })));
  ok('AMBIGUITY GUARD · …and each ambiguous suggestion NAMES the other candidate',
     (((slHereOf('dvlassis') || {}).suggestions || [{}])[0].alsoMatches || [])[0] === 'Devin Ortega' &&
     (((slHereOf('dortega') || {}).suggestions || [{}])[0].alsoMatches || [])[0] === 'Devin Vlassis');
  ok('THERE bucket · Dana Fields exists only in staffing (and suggestions claim nothing)',
     SLB.there.some((r) => r.id === 15) && SLB.there.some((r) => r.id === 13)
     && SLB.there.some((r) => r.id === 14), SLB.there.map((r) => r.name));
  ok('CREW bucket · a name matching a USER or a ROSTER row is not "unmatched" — only the stranger is',
     SLB.crew.length === 1 && SLB.crew[0].name === 'Total Stranger',
     SLB.crew.map((g) => g.name));

  // ══════════════════════════════════════════════════════════════════════════
  section('41 · content pieces — the graphic-design pipeline  (Tom, 2026-09-10)');
  // ══════════════════════════════════════════════════════════════════════════
  // "A graphic design deliverables feature." Every show owes content pieces —
  // "Sponsor loop — ribbon — 11520×90 — :30" — and nothing tracked them.
  // Three shapes, walked end to end: MIXED PRODUCERS (e360 pieces assigned
  // like tasks; client/third-party pieces OWED TO US and chased off the
  // rolodex), FULL PROOF ROUNDS (v1 sent → feedback → v2 → approved, every
  // version a real uploaded file, superseded and never deleted), and SPEC
  // INTEGRATION (zones seed stack-aware pixel sizes; measured files raise a
  // QUESTION on a mismatch — ask, don't accuse).

  // ── every affordance reachable: data-act → ACTIONS → seam ────────────────
  reach('Add / edit / delete a content piece', {
    seam: ['listContent', 'createPiece', 'updatePiece', 'deletePiece'],
    action: ['cpAdd', 'cpEdit', 'cpCommit', 'cpDelete'] });
  reach('Walk a piece\'s status (advance + n/a strike)', {
    seam: 'pieceStatus', action: ['cpAdvance', 'cpNa'] });
  reach('Upload a version · the ladder · send · feedback', {
    seam: ['addContentVersion', 'sendContentVersion', 'contentFeedback'],
    action: ['cpUpload', 'cpOpen', 'cpSend', 'cpFeedback', 'cpFeedbackCommit'] });
  reach('Seed pieces from the bound spec (the picker)', {
    seam: ['contentSeed', 'contentSeedApply'], action: ['cpSeed', 'cpSeedCommit'] });
  reach('Filter the tab by source', { action: 'cpFilter' });

  // ── the mechanical half: measurement is REAL or absent ───────────────────
  // measureVideo() is the browser's own answer — a <video> element's
  // loadedmetadata gives videoWidth/videoHeight/duration off the actual
  // bytes. The §12b size-stamp scan above already covers every api.addFile
  // call site, so the upload path CANNOT invent a size; these pin the video
  // half specifically.
  ok('measureVideo() exists and reads loadedmetadata — videoWidth, videoHeight, duration',
     /function measureVideo\([\s\S]{0,900}onloadedmetadata[\s\S]{0,400}videoWidth/.test(APP_JS) &&
     /vid\.duration/.test(APP_JS));
  ok('…and it revokes its object URL either way — no leaked blob pinning the file',
     /function measureVideo\([\s\S]{0,2000}revokeObjectURL/.test(APP_JS));
  ok('uploadRealFile() measures through measureMedia — image OR video, or nothing',
     /function uploadRealFile\([\s\S]{0,400}measureMedia\(file\)/.test(APP_JS));
  ok('the byte seam sends a duration ONLY when one was measured (dims.dur), never a default',
     /dims && dims\.dur > 0/.test(API_JS));
  ok('the version-upload action routes through uploadRealFile — the one honest byte path',
     /function cpUploadAct\([\s\S]{0,900}uploadRealFile\(/.test(APP_JS));

  // ── the QUESTION chip's face: ask, never accuse — and esc()ed ────────────
  const cvChip = SRC['views-folder.js'].match(/function cpVerdictChip\([\s\S]*?\n\}/);
  ok('the verdict chip renders the question with BOTH dims and a "?", escaped',
     !!cvChip && /measured_w/.test(cvChip[0]) && /spec_w/.test(cvChip[0]) &&
     /esc\(v\.question\.ask/.test(cvChip[0]) && /\?/.test(cvChip[0]), !!cvChip);
  ok('…and the ✓ face only ever claims REALLY measured pixels',
     !!cvChip && /really measured, never assumed/.test(cvChip[0]));
  ok('the chase panel is one glance — "Waiting on others", contact name + mailto off the rolodex',
     /Waiting on others/.test(SRC['views-folder.js']) &&
     /mailto:' \+ esc\(c\.email\)/.test(SRC['views-folder.js']));
  ok('the seed picker is checkboxes a human unchecks (the needs raise-PO shape)',
     /class="cpPick"/.test(APP_JS) && /Uncheck what already exists/.test(APP_JS));
  ok('superseded rounds say so on their face — kept, never deleted',
     /superseded — kept, never deleted/.test(SRC['views-folder.js']));

  // ── e360 piece: create → assign+due → rounds → approve → deliver ─────────
  ok('GATE: a tech may not create a piece',
     (await POST(`/api/shows/${SHOW}/content`, { name: 'sneak' }, { token: T.omar })).status === 403);
  ok('GATE: a pm who owns nothing may not either',
     (await POST(`/api/shows/${SHOW}/content`, { name: 'sneak' }, { token: T.pat })).status === 403);
  const wcp = await POST(`/api/shows/${SHOW}/content`, {
    name: 'Sponsor loop — ribbon', surface: 'Courtside ribbon', kind: 'video',
    spec_w: 3840, spec_h: 96, duration_spec: ':30', source: 'e360',
    owner: 'omar', due_date: plus(30)
  }, { token: T.brenden });
  ok('Brenden creates the e360 piece, assigned to Omar with a due date',
     wcp.status === 200 && wcp.body.owner === 'omar' && wcp.body.due_date === plus(30), wcp.body);
  const WCP = wcp.body.id;

  // v1: register the file the way the modal does, then stand in for the byte
  // route's measurement — this walk runs in production shape with NO storage
  // (§12 celebrates that), and the byte half is harness-upload.mjs's job.
  // The columns written here are exactly the ones PUT ?w=&h= writes.
  const wf1 = await POST('/api/files',
    { show_id: SHOW, name: 'sponsor-loop-v1', ext: 'mp4', kind: 'proof' }, { token: T.brenden });
  await pool.query(`UPDATE files SET width=3840, height=192 WHERE id=$1`, [wf1.body.id]);
  const wv1 = await POST(`/api/content/${WCP}/versions`, { file_id: wf1.body.id }, { token: T.omar });
  ok('Omar — the piece\'s OWNER, a tech — files v1 himself', wv1.status === 200
     && wv1.body.version_n === 1, wv1.body);
  const wq = await GET(`/api/shows/${SHOW}/content`, { token: T.omar });
  const wqp = (wq.body.pieces || []).find((p) => p.id === WCP);
  ok('THE WRONG-SIZE FIXTURE RAISES A QUESTION — naming 3840×96 asked and 3840×192 measured',
     !!wqp && wqp.measure_state === 'question'
     && /3840 × 96px/.test((wqp.question || {}).ask || '')
     && /3840 × 192px/.test((wqp.question || {}).ask || ''), wqp && wqp.question);
  ok('…and double-height asks the STACKING question — stacked zones change pixel maps',
     !!wqp && /double-stacked/.test((wqp.question || {}).ask || ''), wqp && (wqp.question || {}).ask);
  ok('…as a question, never a reject: the version stands, nothing was refused',
     !!wqp && wqp.versions.length === 1 && wqp.match === false);

  const wsend = await PUT(`/api/content/versions/${wv1.body.id}/send`, {}, { token: T.omar });
  ok('v1 goes to the client — a stamp with a name on it', wsend.status === 200 && !!wsend.body.sent_at);
  await PUT(`/api/content/versions/${wv1.body.id}/feedback`,
    { feedback: 'Wrong canvas — this zone is NOT stacked. Rebuild at 3840×96.' }, { token: T.brenden });
  const wf2 = await POST('/api/files',
    { show_id: SHOW, name: 'sponsor-loop-v2', ext: 'mp4', kind: 'proof' }, { token: T.brenden });
  await pool.query(`UPDATE files SET width=3840, height=96, duration_s=30 WHERE id=$1`, [wf2.body.id]);
  const wv2 = await POST(`/api/content/${WCP}/versions`, { file_id: wf2.body.id }, { token: T.omar });
  ok('v2 supersedes v1 — and v1 is KEPT, its feedback intact',
     wv2.status === 200 && (await pool.query(
       `SELECT status, feedback FROM content_versions WHERE piece_id=$1 ORDER BY version_n`, [WCP]))
       .rows.map((r) => r.status).join(',') === 'superseded,current');
  const wm = await GET(`/api/shows/${SHOW}/content`, { token: T.omar });
  const wmp = (wm.body.pieces || []).find((p) => p.id === WCP);
  ok('the right-size rebuild earns the ✓ — measured 3840×96 matches, question gone',
     !!wmp && wmp.match === true && wmp.question === null, wmp && wmp.measure_state);
  ok('GATE: Pat may not walk the status',
     (await PUT(`/api/content/${WCP}/status`, { status: 'approved' }, { token: T.pat })).status === 403);
  await PUT(`/api/content/${WCP}/status`, { status: 'approved' }, { token: T.brenden });
  const wdone = await PUT(`/api/content/${WCP}/status`, { status: 'delivered' }, { token: T.omar });
  ok('approve → deliver, the owner walking the last mile',
     wdone.status === 200 && wdone.body.status === 'delivered');

  // ── the client piece: owed to us, chased off the rolodex ─────────────────
  const wOwes = await POST('/api/contacts',
    { name: 'Walk Dana Fox', org: 'Fox & Co', kind: 'client', email: 'dana@foxandco.tv' },
    { token: T.brenden });
  const wClientPiece = await POST(`/api/shows/${SHOW}/content`, {
    name: 'Team intro sting — center hung', kind: 'video', spec_w: 1920, spec_h: 1080,
    source: 'client', contact_id: wOwes.body.id, due_date: plus(5)
  }, { token: T.brenden });
  ok('the client piece carries WHO OWES IT — the rolodex card, email and all',
     wClientPiece.status === 200 && wClientPiece.body.contact && wClientPiece.body.contact.email === 'dana@foxandco.tv', wClientPiece.body);
  ok('…and it is exactly what the chase panel lists: client-sourced, not yet in hand',
     wClientPiece.body.source === 'client' && ['approved', 'delivered', 'na'].indexOf(wClientPiece.body.status) < 0);
  // the file arrives; mark it received
  const wclF = await POST('/api/files',
    { show_id: SHOW, name: 'team-intro-sting', ext: 'mp4', kind: 'proof' }, { token: T.brenden });
  await POST(`/api/content/${wClientPiece.body.id}/versions`, { file_id: wclF.body.id }, { token: T.brenden });
  const wclDone = await PUT(`/api/content/${wClientPiece.body.id}/status`, { status: 'delivered' },
    { token: T.brenden });
  ok('their file lands as v1 and the piece is marked received — off the chase list',
     wclDone.status === 200 && wclDone.body.status === 'delivered');

  // ── the contact-delete refusal names the piece ───────────────────────────
  const wOwes2 = await POST(`/api/shows/${SHOW}/content`, {
    name: 'Season thank-you card', kind: 'still', source: 'client', contact_id: wOwes.body.id
  }, { token: T.brenden });
  const wctDel = await DEL('/api/contacts/' + wOwes.body.id, { token: T.tom });
  ok('deleting a contact who OWES a piece is refused, NAMING the piece and offering archive',
     wctDel.status === 400 && /Season thank-you card/.test(wctDel.body.error)
     && /archive/i.test(wctDel.body.error), wctDel.body);

  // ── the spec-seed picker, against a REAL bound spec ──────────────────────
  const walkZoned = {
    version: 1, layoutMode: 'complex', complexUnit: 'ft', compassBearing: 0,
    sideStates: { south: true, north: true, east: false, west: false },
    fields: { clientName: 'AVCA', venueName: 'Fiserv Forum', cabinetType: 'p391',
              fieldLength: '110', fieldWidth: '59', totalCabinets: '34', codecDuration: '30' },
    complexSections: [
      { name: 'South run', side: 'south', count: '30', offset: '0', fieldDist: '10', direction: 'ltr' },
      { name: 'North stack', side: 'north', count: '4', offset: '0', fieldDist: '10', direction: 'ltr' }
    ],
    zones: [
      { name: 'Ribbon A', color: '#59A9F0', first: 1, last: 30, doubleStacked: false },
      { name: 'North stack', color: '#F0616B', first: 31, last: 34, doubleStacked: true }
    ],
    clientLogoDataUrl: null
  };
  // the bind rides §34's child-server device: THIS server runs with no
  // storage on purpose, and spec-bind writes real bytes inside its
  // transaction — a 501 here is the honest answer, so the bind happens where
  // storage exists and everything downstream reads back on the main server.
  const [wbind] = bindViaStorageServer([
    { specType: 'e360', json: walkZoned, suggestedName: 'walk zoned spec' }
  ]);
  ok('a zoned .e360 binds (child server with storage — superseding §34\'s; history keeps every rev)',
     wbind && wbind.status === 200, wbind && wbind.body);
  const wZoneSeed = await GET(`/api/shows/${SHOW}/content-seed`, { token: T.omar });
  const wzA = (wZoneSeed.body.zones || []).find((z) => z.name === 'Ribbon A');
  const wzB = (wZoneSeed.body.zones || []).find((z) => z.name === 'North stack');
  ok('the seed proposes one piece per zone with the tool\'s own pixel math — 30×128 = 3840×128',
     wZoneSeed.body.available === true && !!wzA && wzA.spec_w === 3840 && wzA.spec_h === 128, wZoneSeed.body);
  ok('…STACK-AWARE: the double-stacked zone is twice the HEIGHT — 512×256',
     !!wzB && wzB.spec_w === 512 && wzB.spec_h === 256 && wzB.doubleStacked === true, wzB);
  const wpick = await POST(`/api/shows/${SHOW}/content-seed`, { picks: [1] }, { token: T.brenden });
  ok('a human PICKED one zone; only it became a piece, numbers server-derived',
     wpick.status === 200 && wpick.body.created.length === 1
     && wpick.body.created[0].name === 'North stack' && wpick.body.created[0].spec_h === 256
     && wpick.body.created[0].duration_spec === ':30', wpick.body.created);

  // ── delete: versions die, the FILES survive ──────────────────────────────
  const wdel = await DEL(`/api/content/${WCP}`, { token: T.brenden });
  ok('the pm deletes the delivered piece', wdel.status === 200);
  ok('…its versions went with it',
     (await pool.query(`SELECT COUNT(*)::int AS n FROM content_versions WHERE piece_id=$1`, [WCP]))
       .rows[0].n === 0);
  ok('…and the uploaded files SURVIVE — deleting a piece never eats a document',
     (await GET(`/api/files/${wf1.body.id}`, { token: T.brenden })).status === 200 &&
     (await GET(`/api/files/${wf2.body.id}`, { token: T.brenden })).status === 200);

  // ══════════════════════════════════════════════════════════════════════════
  section('41b · the sheet importer — a client\'s list becomes tracked pieces');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom (2026-09-10): "we need some means to upload a spreadsheet or
  // something and then track deliverables in any bucket from it." Clients
  // send content lists as Excel/CSV; until this pass somebody retyped them.
  // The walk drives the REAL parsing module (public/importer.js — pure and
  // DOM-free on purpose, loaded byte-for-byte into a bare vm) against the
  // COMMITTED fixture CSVs, then feeds the rows it built to the real route,
  // exactly the way the modal does: open → pick/paste → mapping guessed → a
  // human corrects one column → preview counts exact → import → pieces land
  // in their buckets → re-import skips everything → invalid rows echo back
  // by sheet row number.

  reach('Import a sheet of content pieces', {
    seam: 'importContent', action: ['cpImport', 'cpImportParse', 'cpImportCommit'] });

  const impCtx = { console };
  vm.createContext(impCtx);
  new vm.Script(SRC['importer.js'], { filename: 'public/importer.js' }).runInContext(impCtx);
  ok('public/importer.js is PURE — it loads on a bare vm with nothing but a console',
     typeof impCtx.csvParse === 'function' && typeof impCtx.cpBuildRows === 'function');

  // ── the modal's mechanics, held to the honest copy ───────────────────────
  ok('every mapping guess is a DROPDOWN a human can correct, re-rendered live',
     /class="cell-in impMap"/.test(APP_JS) && /impMap[\s\S]{0,600}addEventListener\('change'/.test(APP_JS));
  ok('the first-row-is-headers toggle and the bucket default both render (auto-detected, overridable)',
     /id="impHeader"/.test(APP_JS) && /id="impBucket"/.test(APP_JS) &&
     /First row is headers/.test(APP_JS));
  ok('XLSX is best-effort: SheetJS is PINNED to one exact cdnjs build',
     /cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js/.test(APP_JS));
  ok('…lazy-loaded ONLY in API mode — file:// and the demo never dial a CDN',
     /function cpImpReadFile[\s\S]{0,600}!SR\.isApi\(\)[\s\S]{0,600}cpLoadSheetJS/.test(APP_JS));
  ok('…and every failure path says the honest sentence, on a timeout too — never a silent hang',
     /save as CSV and import that/.test(APP_JS) && /}, 20000\)/.test(APP_JS));
  ok('spreadsheet cells are HOSTILE INPUT — grid cells, header labels and the file name render esc()ed',
     /esc\(String\(row\[c2\]/.test(APP_JS) && /esc\(String\(pi\.grid\[0\]\[c\]/.test(APP_JS) &&
     /esc\(pi\.fileName\)/.test(APP_JS));

  // ── the CLEAN fixture: the mapping guesses itself ────────────────────────
  const readFix = (n) => fs.readFileSync(path.join(APP, 'scripts', 'fixtures', n), 'utf8');
  const gClean = impCtx.csvParse(readFix('content-list-clean.csv'));
  ok('the clean fixture parses — a header row and four data rows, headers auto-detected',
     gClean.length === 5 && impCtx.cpDetectHeader(gClean) === true);
  ok('the mapping GUESSES itself — Name/Width/Height/Duration/Due date/Type/Notes, every column placed',
     JSON.stringify(impCtx.cpGuessMapping(gClean[0])) ===
     JSON.stringify(['name', 'spec_w', 'spec_h', 'duration_spec', 'due_date', 'kind', 'notes']),
     impCtx.cpGuessMapping(gClean[0]));

  // ── the TRICKY fixture: CRLF, quoted commas, ×-variants, a source column ─
  const tTricky = readFix('content-list-tricky.csv');
  ok('the tricky fixture still carries its REAL CRLF endings (.gitattributes holds the bytes)',
     tTricky.indexOf('\r\n') >= 0);
  const gTricky = impCtx.csvParse(tTricky);
  ok('CRLF + quoted fields parse: 5 rows, the comma-bearing name intact',
     gTricky.length === 5 && gTricky[1][0] === 'Sponsor loop, ribbon — north', gTricky.length);
  ok('doubled quotes and an embedded newline survive as CELLS, not row breaks',
     gTricky[2][0] === 'Halftime stack — "hero" spot'
     && gTricky[3][5] === 'two lines:\ncrowd prompt');
  const mTricky = impCtx.cpGuessMapping(gTricky[0]);
  ok('Piece/Resolution/Length/Source/Screen/Notes guess name/size/duration/source/surface/notes',
     JSON.stringify(mTricky) ===
     JSON.stringify(['name', 'size', 'duration_spec', 'source', 'surface', 'notes']), mTricky);
  const bTricky = impCtx.cpBuildRows(gTricky, mTricky, { headerRow: true, bucket: 'e360' });
  ok('THE ×-VARIANTS: "3840x96", "3840 × 96" and "3840X96" all parse to the same 3840×96',
     bTricky[0].spec_w === 3840 && bTricky[0].spec_h === 96
     && bTricky[1].spec_w === 3840 && bTricky[1].spec_h === 96
     && bTricky[2].spec_w === 3840 && bTricky[2].spec_h === 96,
     bTricky.map((r) => r.spec_w + 'x' + r.spec_h).join(' '));
  ok('…and "11,520x96" sheds its thousands comma — 11520×96',
     bTricky[3].spec_w === 11520 && bTricky[3].spec_h === 96);
  ok('SOURCE FUZZING: "us" → e360 · "Client" → client · an empty cell → the picker\'s default',
     bTricky[0].source === 'e360' && bTricky[1].source === 'client' && bTricky[3].source === 'e360');
  ok('…and "Acme Printing" → third_party with the RAW VALUE kept in notes — never a silent guess',
     bTricky[2].source === 'third_party' && /source: Acme Printing/.test(bTricky[2].notes));

  // ── a human corrects one column: unmap Length, durations drop everywhere ─
  const mFixed = mTricky.slice();
  mFixed[2] = null;
  const bFixed = impCtx.cpBuildRows(gTricky, mFixed, { headerRow: true, bucket: 'e360' });
  ok('REMAP: un-mapping the Length column drops durations from every built row',
     bTricky[0].duration_spec === ':30'
     && bFixed.every((r) => r.duration_spec === ''));

  // ── the INVALID fixture: the dry preview counts exactly right ────────────
  const gInv = impCtx.csvParse(readFix('content-list-invalid.csv'));
  const bInv = impCtx.cpBuildRows(gInv, impCtx.cpGuessMapping(gInv[0]),
    { headerRow: true, bucket: 'client' });
  const pInv = impCtx.cpPreviewCounts(bInv, []);
  ok('PREVIEW: creates 2 · skips 1 (an in-sheet twin) · 2 invalid — the dry summary is exact',
     pInv.creates.length === 2 && pInv.skips.length === 1 && pInv.invalids.length === 2,
     { c: pInv.creates.length, s: pInv.skips.length, i: pInv.invalids.length });
  ok('…invalids carry SHEET row numbers a person can go fix — row 3: no name · row 4: the size, named',
     pInv.invalids[0].row_n === 3 && pInv.invalids[0].reason === 'no name'
     && pInv.invalids[1].row_n === 4 && pInv.invalids[1].reason === "unparseable size 'big'",
     pInv.invalids);
  ok('…and the US-shaped date normalized on the way through — 11/20/2026 → 2026-11-20',
     (bInv.find((r) => r.name === 'Closing sting') || {}).due_date === '2026-11-20');

  // ── the WRITE: rows the real parser built, through the real route ────────
  ok('GATE: Omar (tech) may not import',
     (await POST(`/api/shows/${SHOW}/content-pieces/import`, { rows: bTricky },
       { token: T.omar })).status === 403);
  ok('GATE: Pat (owns nothing) may not either',
     (await POST(`/api/shows/${SHOW}/content-pieces/import`, { rows: bTricky },
       { token: T.pat })).status === 403);
  const wImp = await POST(`/api/shows/${SHOW}/content-pieces/import`,
    { rows: bTricky, file_name: 'content-list-tricky.csv' }, { token: T.brenden });
  ok('Brenden imports the parsed sheet — 4 created, per-row results echoed',
     wImp.status === 200 && wImp.body.summary.created === 4
     && (wImp.body.results || []).every((x) => x.outcome === 'created'), wImp.body.summary);
  const wImpList = await GET(`/api/shows/${SHOW}/content`, { token: T.omar });
  const wImpBy = {};
  for (const p of wImpList.body.pieces) wImpBy[p.name] = p;
  ok('the created rows are ORDINARY content_pieces — right buckets, right specs, on the tab with everything else',
     wImpBy['Sponsor loop, ribbon — north'].source === 'e360'
     && wImpBy['Sponsor loop, ribbon — north'].spec_w === 3840
     && wImpBy['Sponsor loop, ribbon — north'].spec_h === 96
     && wImpBy['Halftime stack — "hero" spot'].source === 'client'
     && wImpBy['Center hung sting'].source === 'third_party'
     && /Acme Printing/.test(wImpBy['Center hung sting'].notes));
  ok('…and the owed arrivals join the chase-list shape — client/third-party, not yet in hand',
     wImpBy['Halftime stack — "hero" spot'].status === 'needed'
     && wImpBy['Center hung sting'].status === 'needed');
  ok('ONE activity line for the whole import, naming the file',
     (await activityFor(SHOW, 'content.import')).some((a) =>
       /imported 4 pieces from content-list-tricky\.csv/.test(a.detail)));

  // ── re-import the SAME sheet: idempotent by (show, name) ─────────────────
  const wImp2 = await POST(`/api/shows/${SHOW}/content-pieces/import`,
    { rows: bTricky, file_name: 'content-list-tricky.csv' }, { token: T.brenden });
  ok('RE-IMPORT: zero created — all 4 skip as already-on-this-show, nothing duplicated',
     wImp2.status === 200 && wImp2.body.summary.created === 0
     && wImp2.body.summary.skipped === 4, wImp2.body.summary);

  // ── the invalid sheet end to end: bad rows echo by row number ────────────
  const wImp3 = await POST(`/api/shows/${SHOW}/content-pieces/import`,
    { rows: bInv, file_name: 'content-list-invalid.csv' }, { token: T.brenden });
  ok('the invalid fixture imports its GOOD rows — 2 created · 1 in-sheet twin skipped · 2 invalid by row number',
     wImp3.body.summary.created === 2 && wImp3.body.summary.skipped === 1
     && wImp3.body.summary.invalid === 2
     && (wImp3.body.results.find((x) => x.row_n === 3) || {}).reason === 'no name'
     && /unparseable size 'big'/.test((wImp3.body.results.find((x) => x.row_n === 4) || {}).reason || ''),
     wImp3.body.results);

  // ══════════════════════════════════════════════════════════════════════════
  section('42 · the nightly backup — honest when it cannot run, reachable when it can');
  // ══════════════════════════════════════════════════════════════════════════
  // THIS server runs with no storage ON PURPOSE (§12's production-default
  // shape), which makes it the perfect stage for the backup's honesty rules:
  // the health block must say "not enabled" and WHY, and a manual trigger
  // must land a FAILED ledger row that names the missing storage — never a
  // fake ok, never a dump parked on the ephemeral disk. The full landed-and-
  // restored proof lives in smoke, where a real STORAGE_ROOT exists.
  reach('Back up now (Settings → Backups card)',
    { seam: ['runBackup', 'listBackups'], action: 'backupNow' });

  const bkHealth = await GET('/api/health');
  const bkBlock = bkHealth.body.backup;
  ok('health carries the ADDITIVE backup block, booleans + timestamps, no URL',
     !!bkBlock && bkBlock.enabled === false && /26h/.test(bkBlock.staleMeans || '') &&
     !/postgres(ql)?:\/\//i.test(JSON.stringify(bkBlock)), bkBlock);
  ok('…and with storage unconfigured it does not pretend a next run is coming',
     bkBlock.nextRunAt === null && bkBlock.stale === false, bkBlock);

  const bkTom = await POST('/api/admin/backup', {}, { token: T.tom });
  ok('a manual backup with nowhere durable to land answers a FAILED ledger row, naming storage',
     bkTom.status === 200 && bkTom.body.status === 'failed' &&
     /storage/i.test(bkTom.body.error || '') && bkTom.body.trigger === 'manual', bkTom.body);
  const bkLedger = await GET('/api/admin/backups', { token: T.tom });
  ok('…and the refusal is IN the ledger beside an honest empty NAS answer',
     bkLedger.status === 200 && bkLedger.body.runs[0].status === 'failed' &&
     bkLedger.body.nas.configured === false, bkLedger.body);
  ok('the trigger holds the admin floor — a pm is 403',
     (await POST('/api/admin/backup', {}, { token: T.pat })).status === 403);
  ok('…and so does the ledger read',
     (await GET('/api/admin/backups', { token: T.pat })).status === 403);
  const bkStale = (await GET('/api/health')).body.backup;
  ok('a failing-only ledger while DISABLED stays stale:false — stale is an ENABLED-system alarm',
     bkStale.stale === false && bkStale.lastRun && bkStale.lastRun.status === 'failed', bkStale);

  // ══════════════════════════════════════════════════════════════════════════
  section('43 · dropbox folders — the content bytes\' real home  (Tom, 2026-09-10)');
  // ══════════════════════════════════════════════════════════════════════════
  // "Will need the deliverables to be able to connect file request folders to
  // shows, as well as regular ones … incoming files from clients,
  // deliverables to clients, and lastly deliverables to person running the
  // show — which might be one, the other, or both." And the correction that
  // shaped the whole build: "i dont necessarily want to upload all these
  // files to showrunner. just keep track of them."
  //
  // So the PRIMARY path walked here is TRACK IN PLACE: an arrival is seen in
  // the live listing, measured where it lies (Dropbox media info + the
  // bounded range probe), linked to an owed piece as a version BY REFERENCE,
  // walked to approved — and the whole flow runs on THIS server, which has
  // NO STORAGE AT ALL (§12): tracking needs none, which is exactly Tom's
  // point. The fake's download log is the other half of the proof: probe
  // RANGE reads only, never a full copy. Ingest-a-copy and deposit — the two
  // verbs that genuinely move bytes — ride §34's child-server device.

  // ── every affordance reachable: data-act → ACTIONS → seam ────────────────
  reach('The Folders strip (link a folder via the browse picker)', {
    seam: ['dropboxEnabled', 'dropboxBrowse', 'listDropboxLinks', 'addDropboxLink'],
    action: ['dbxLink', 'dbxBrowseTo', 'dbxLinkCommit', 'dbxRefresh'] });
  reach('Link / mint a file request · copy its URL', {
    seam: ['dropboxFileRequests', 'createDropboxFileRequest'],
    action: ['dbxLinkRequest', 'dbxRequestPick', 'dbxNewRequest', 'dbxNewRequestCommit', 'dbxCopyUrl'] });
  reach('The listing: expand, mark seen, probe specs', {
    seam: ['dropboxMarkSeen', 'dropboxProbe'],
    action: ['dbxOpen', 'dbxSeen', 'dbxProbe'] });
  reach('Track in place (primary) / ingest a copy (explicit)', {
    seam: ['dropboxTrack', 'dropboxIngest'],
    action: ['dbxTrack', 'dbxTrackCommit', 'dbxIngestCommit'] });
  reach('Deposit a file · unlink', {
    seam: ['dropboxDeposit', 'deleteDropboxLink'],
    action: ['dbxDeposit', 'dbxDepositCommit', 'dbxUnlink'] });

  // ── the mechanical half: the copy that keeps the promises ────────────────
  ok('the unlink confirm says LOCAL-ONLY in words — nothing in Dropbox is touched',
     /removes the LINK only — nothing in Dropbox is touched, deleted or moved/.test(APP_JS));
  ok('the track modal says the file STAYS in Dropbox — no copy made',
     /stays in Dropbox<\/b>/.test(APP_JS) && /no copy made/.test(APP_JS));
  ok('the strip is feature-flagged: the seam consumes features.dropbox and fails closed',
     /features\.dropbox/.test(API_JS));
  ok('role badges render per role — a folder wears every hat it holds',
     /function dbxRoleBadges/.test(SRC['views-folder.js']) &&
     /dbxRoleBadges\(link\)/.test(SRC['views-folder.js']));
  ok('the NEW badge and Copy-request-URL affordances render on the card',
     /NEW<\/span>/.test(SRC['views-folder.js']) && /Copy request URL/.test(SRC['views-folder.js']));
  ok('spec provenance is on the chip\'s face — measured-from-bytes vs reported-by-Dropbox',
     /Measured from the file’s own bytes/.test(SRC['views-folder.js']) &&
     /Reported by Dropbox’s media info/.test(SRC['views-folder.js']));
  // the THIRD byte-location state — remote-by-design must never read as
  // missing bytes, and the missing-bytes flag must never claim a remote row
  ok('components.js: fileIsByteless EXCLUDES remote rows — the two states cannot conflate',
     /function fileIsByteless\([\s\S]{0,200}!fileIsRemote\(f\)/.test(SRC['components.js']));
  ok('…and the flag speaks all three truths: in-Dropbox, was-in-Dropbox-now-gone, metadata-only',
     /in Dropbox · /.test(SRC['components.js']) &&
     /was in Dropbox — no longer found/.test(SRC['components.js']) &&
     /no document — metadata only/.test(SRC['components.js']));
  ok('the version ladder marks a tracked round and deep-links its real home',
     /Open in Dropbox/.test(SRC['views-folder.js']) &&
     /fileBytelessFlag\(f\)/.test(SRC['views-folder.js']));

  // ── production shape FIRST: unconfigured is a flag off + honest 501s ─────
  const wCfg0 = await GET('/api/config');
  ok('with no DROPBOX_* env the feature flag is OFF — the strip renders as nothing',
     wCfg0.body.features.dropbox === false);
  ok('…and the routes answer the honest 501 naming the env vars',
     (await GET('/api/dropbox/browse?path=/', { token: T.brenden })).status === 501 &&
     (await GET(`/api/shows/${SHOW}/dropbox-links`, { token: T.omar })).status === 501);

  // ── wire the fake — in-process, same trick as the fake scheduler ─────────
  const { startFakeDropbox } = require(path.join(APP, 'scripts', 'fake-dropbox.js'));
  const wDbx = await startFakeDropbox();
  process.env.DROPBOX_APP_KEY = 'fake-key';
  process.env.DROPBOX_APP_SECRET = 'fake-secret';
  process.env.DROPBOX_REFRESH_TOKEN = 'fake-refresh';
  process.env.DROPBOX_API_BASE = wDbx.url;
  process.env.DROPBOX_CONTENT_BASE = wDbx.url;
  require(path.join(APP, 'lib', 'dropbox.js')).dropboxResetToken();
  ok('the flag flips with the env — no restart, no cache lie',
     (await GET('/api/config')).body.features.dropbox === true);

  // the client's shared folder: two arrivals, one of them sized EXACTLY like
  // the North-stack piece the spec seeded in §41 (512×256)
  wDbx.seed.folder('/Clients/AVCA/Incoming');
  wDbx.seed.folder('/Clients/AVCA/Deliverables');
  const wPng = wDbx.seed.png(512, 256);
  wDbx.seed.file('/Clients/AVCA/Incoming/north_stack_v1.png', wPng);
  wDbx.seed.file('/Clients/AVCA/Incoming/notes.pdf', Buffer.alloc(2048, 7));

  // ── Brenden links the folders — one incoming, one dual-role delivery ─────
  ok('Pat (owns nothing) cannot link a folder',
     (await POST(`/api/shows/${SHOW}/dropbox-links`,
       { path: '/Clients/AVCA/Incoming', roles: ['incoming'] }, { token: T.pat })).status === 403);
  const wLkIn = await POST(`/api/shows/${SHOW}/dropbox-links`,
    { path: '/Clients/AVCA/Incoming', roles: ['incoming'], label: 'AVCA uploads' },
    { token: T.brenden });
  ok('Brenden links the incoming folder', wLkIn.status === 200, wLkIn.body);
  const wLkOut = await POST(`/api/shows/${SHOW}/dropbox-links`,
    { path: '/Clients/AVCA/Deliverables', roles: ['to_client', 'to_operator'] },
    { token: T.brenden });
  ok('…and the delivery folder wears BOTH hats — "one, the other, or both", literally',
     wLkOut.status === 200 && wLkOut.body.roles.join(',') === 'to_client,to_operator');

  // ── the listing renders, the diff flips after mark-seen ──────────────────
  const wLs1 = await GET(`/api/shows/${SHOW}/dropbox-links`, { token: T.omar });
  const wIn1 = wLs1.body.links.find((l) => l.id === wLkIn.body.id);
  ok('Omar sees the live listing — both arrivals NEW before any baseline',
     wLs1.status === 200 && wIn1.entries.length === 2 && wIn1.new_count === 2, wIn1 && wIn1.new_count);
  await POST(`/api/dropbox-links/${wLkIn.body.id}/seen`, {}, { token: T.brenden });
  wDbx.seed.file('/Clients/AVCA/Incoming/late.png', wDbx.seed.png(64, 64));
  const wLs2 = await GET(`/api/shows/${SHOW}/dropbox-links`, { token: T.omar });
  const wIn2 = wLs2.body.links.find((l) => l.id === wLkIn.body.id);
  ok('mark seen, a fresh drop lands — ONLY it is NEW: new-since-last-look, not unread-counts',
     wIn2.new_count === 1 && wIn2.entries.find((e) => e.name === 'late.png').is_new
     && !wIn2.entries.find((e) => e.name === 'notes.pdf').is_new, wIn2.new_count);

  // ── a file request, minted and linked, URL in hand ───────────────────────
  const wMint = await POST(`/api/shows/${SHOW}/dropbox-links/create-file-request`,
    { title: 'AVCA content drop' }, { token: T.brenden });
  ok('Brenden mints a file request — created over in Dropbox, linked as incoming, URL surfaced',
     wMint.status === 200 && /^https:/.test(wMint.body.url)
     && wMint.body.link.roles.join(',') === 'incoming'
     && wDbx.state.fileRequests.some((r) => r.title === 'AVCA content drop'), wMint.body);

  // ── the probe measures where the file LIES — range reads only ────────────
  const wProbe = await POST(`/api/dropbox-links/${wLkIn.body.id}/probe`,
    { entry_path: '/Clients/AVCA/Incoming/north_stack_v1.png' }, { token: T.omar });
  ok('the probe reads the PNG\'s own IHDR — 512×256, measured, never guessed',
     wProbe.status === 200 && wProbe.body.w === 512 && wProbe.body.h === 256, wProbe.body);
  ok('…by RANGE reads only — no full copy of anything has moved anywhere',
     wDbx.state.downloads.length > 0 && wDbx.state.downloads.every((d) => d.ranged),
     wDbx.state.downloads.map((d) => [d.path, d.ranged]));
  const wLs3 = await GET(`/api/shows/${SHOW}/dropbox-links`, { token: T.brenden });
  const wNs = wLs3.body.links.find((l) => l.id === wLkIn.body.id)
    .entries.find((e) => e.name === 'north_stack_v1.png');
  const northPiece = (await GET(`/api/shows/${SHOW}/content`, { token: T.brenden }))
    .body.pieces.find((p) => p.name === 'North stack');
  ok('the measured 512×256 MATCHES the spec-seeded North-stack piece — suggested by name, a human confirms',
     !!northPiece && wNs.match_piece && wNs.match_piece.id === northPiece.id, wNs.match_piece);

  // ── TRACK IN PLACE — the primary path, on a server with NO storage ───────
  const wTrk = await POST(`/api/dropbox-links/${wLkIn.body.id}/track`,
    { entry_path: '/Clients/AVCA/Incoming/north_stack_v1.png', content_piece_id: northPiece.id },
    { token: T.brenden });
  ok('the arrival becomes the piece\'s v1 BY REFERENCE — bytes stay in Dropbox',
     wTrk.status === 200 && wTrk.body.version.version_n === 1
     && wTrk.body.file.external_store === 'dropbox'
     && wTrk.body.file.external_path === '/Clients/AVCA/Incoming/north_stack_v1.png'
     && !wTrk.body.file.nas_path, wTrk.body.file);
  ok('…with the PROBED dims on the row — 512×256 really measured, and Dropbox\'s own size',
     wTrk.body.file.width === 512 && wTrk.body.file.height === 256
     && Number(wTrk.body.file.size) === wPng.length, wTrk.body.file);
  ok('…and it earns the ✓ against the piece\'s spec — measured agreement, no question',
     ((await GET(`/api/shows/${SHOW}/content`, { token: T.omar })).body.pieces
       .find((p) => p.id === northPiece.id) || {}).match === true);
  ok('ZERO NAS WRITES: this server has no storage AND the fake served only the probe\'s ranges',
     wDbx.state.downloads.every((d) => d.ranged) && wDbx.state.uploads.length === 0);
  const wApproved = await PUT(`/api/content/${northPiece.id}/status`,
    { status: 'approved' }, { token: T.brenden });
  ok('Brenden walks the tracked piece to approved — the pipeline closes over a file Showrunner never held',
     wApproved.status === 200 && wApproved.body.status === 'approved');

  // ── the AUTO-PROBE pass — specs appear WITHOUT clicks (Tom, live 9-10) ───
  // "do i have to probe all the files individually to see specs?" No: an
  // open listing probes its own un-probed media entries — two lanes, first
  // 25 per pass, cached and unreadable verdicts cost ZERO content requests
  // ever after. EXECUTED here — not scanned — through §37's browser-half vm
  // against this walk's live server, with the fake's request log as witness:
  // its per-response hold makes real overlap observable, and its high-water
  // mark is the lane cap's proof.
  reach('Specs appear without clicks — the auto-probe pass on the open listing',
    { seam: 'dropboxAutoProbe' });
  ok('the listing card KICKS the pass on render, and rows patch IN PLACE',
     /dbxAutoProbeKick\(link, editable\)/.test(SRC['views-folder.js'])
     && /function dbxAutoProbeKick/.test(APP_JS) && /function dbxPatchRow/.test(APP_JS));
  ok('a row whose probe is in flight reads as reading… — and its manual Probe button yields to the pass',
     /reading…/.test(SRC['views-folder.js'])
     && /!spec && !entry\.spec_unreadable && !reading/.test(SRC['views-folder.js']));

  // a 31-media-file drop: 1 garbage .mov (the newest, so the pass meets it
  // first) + 30 real PNGs — the pass must take the first 25 and STOP
  wDbx.seed.folder('/Clients/AVCA/Bulk');
  wDbx.seed.file('/Clients/AVCA/Bulk/broken_export.mov', wDbx.seed.garbage(),
    { server_modified: '2026-09-10T23:59:00Z' });
  for (let bi = 1; bi <= 30; bi += 1) {
    wDbx.seed.file(`/Clients/AVCA/Bulk/frame_${String(bi).padStart(2, '0')}.png`,
      wDbx.seed.png(640, 360),
      { server_modified: `2026-09-10T12:${String(bi).padStart(2, '0')}:00Z` });
  }
  const wLkBulk = await POST(`/api/shows/${SHOW}/dropbox-links`,
    { path: '/Clients/AVCA/Bulk', roles: ['incoming'], label: 'Bulk drop' }, { token: T.brenden });
  const wBulkEntries = async () =>
    (await GET(`/api/shows/${SHOW}/dropbox-links`, { token: T.omar }))
      .body.links.find((l) => l.id === wLkBulk.body.id).entries;

  tab.SR.setToken(T.omar);            // the vm tab signs in — probing is reading
  wDbx.seed.downloadDelay(25);        // hold responses open: overlap becomes visible
  wDbx.state.maxInflightDownloads = 0;
  const wDl0 = wDbx.state.downloads.length;
  let wStarts1 = 0;
  const wPass1 = await tab.api.dropboxAutoProbe(wLkBulk.body.id, await wBulkEntries(),
    { onStart: () => { wStarts1 += 1; } });
  ok('THE 25 CAP · the pass probes the first 25 un-probed media entries and STOPS — the rest keep the manual door',
     wPass1.probed === 25 && wStarts1 === 25 && wPass1.skipped === 6, wPass1);
  ok('…and the fake counted exactly 25 content requests — one bounded head read per file',
     wDbx.state.downloads.length - wDl0 === 25, wDbx.state.downloads.length - wDl0);
  ok('THE TWO LANES · never more than two probes in flight — and really two, not a polite serial crawl',
     wDbx.state.maxInflightDownloads === 2, wDbx.state.maxInflightDownloads);

  // second render: 25 verdicts are CACHED (24 specs + 1 honest unreadable) —
  // only the six past the first pass's cap cost anything now
  const wDl1 = wDbx.state.downloads.length;
  const wEnt2 = await wBulkEntries();
  ok('the cached verdicts RIDE THE LISTING — 24 measured specs and the one honest unreadable',
     wEnt2.filter((e) => e.spec && e.spec.source === 'probe' && e.spec.w === 640).length === 24
     && wEnt2.filter((e) => e.spec_unreadable).length === 1
     && wEnt2.find((e) => e.name === 'broken_export.mov').spec_unreadable === true,
     { probed: wEnt2.filter((e) => e.spec).length, unreadable: wEnt2.filter((e) => e.spec_unreadable).length });
  const wPass2 = await tab.api.dropboxAutoProbe(wLkBulk.body.id, wEnt2, {});
  ok('RE-RENDER · the pass touches ONLY the six past the cap — every cached entry cost zero content requests',
     wPass2.probed === 6 && wPass2.skipped === 0
     && wDbx.state.downloads.length - wDl1 === 6,
     { probed: wPass2.probed, requests: wDbx.state.downloads.length - wDl1 });

  // third render: everything measured or honestly unreadable — ZERO requests,
  // and the unreadable is NOT retried (its verdict is a cached result too)
  const wDl2 = wDbx.state.downloads.length;
  const wPass3 = await tab.api.dropboxAutoProbe(wLkBulk.body.id, await wBulkEntries(), {});
  ok('WARM FOLDER · a later visit costs ZERO content requests — cached renders instantly, unreadable is never re-probed',
     wPass3.probed === 0 && wPass3.skipped === 0 && wDbx.state.downloads.length === wDl2,
     { probed: wPass3.probed, extra: wDbx.state.downloads.length - wDl2 });
  wDbx.seed.downloadDelay(0);

  // ── ingest + deposit — the byte-moving verbs, on §34's child server ──────
  // ASYNC spawn, not spawnSync, and the difference is load-bearing: the fake
  // Dropbox lives in THIS process's event loop, and the child's ingest must
  // reach it — a spawnSync would block the loop and deadlock the child
  // against a fake that can never answer. §34's binds could stay sync
  // because that child needed nothing from its parent but the database.
  const wByteVerbs = await (() => {
    const script =
      `(async () => {
        const srv = require(${JSON.stringify(path.join(APP, 'server.js').replace(/\\/g, '/'))});
        const server = await srv.boot();
        const base = 'http://127.0.0.1:' + server.address().port;
        const login = await fetch(base + '/api/auth/login', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'brenden', password: ${JSON.stringify(PW)} }) });
        const tok = (await login.json()).token;
        const H = { 'Content-Type': 'application/json', 'x-auth-token': tok };
        const ingest = await (await fetch(base + '/api/dropbox-links/' + ${Number(wLkIn.body.id)} + '/ingest', {
          method: 'POST', headers: H,
          body: JSON.stringify({ entry_path: '/Clients/AVCA/Incoming/north_stack_v1.png' }) })).json();
        const deposit = await (await fetch(base + '/api/dropbox-links/' + ${Number(wLkOut.body.id)} + '/deposit', {
          method: 'POST', headers: H,
          body: JSON.stringify({ file_id: ingest.file && ingest.file.id }) })).json();
        console.log('WALKDBX ' + JSON.stringify({ ingest, deposit }));
        server.close();
        process.exit(0);
      })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
    return new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, PORT: '0', SWEEP_ON_BOOT: '0',
               STORAGE_ROOT: path.join(os.tmpdir(), 'sr-walk-dbx-storage') }
      });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { errOut += c; });
      child.on('exit', () => {
        const m = out.match(/WALKDBX (.*)/);
        if (!m) console.error('  (dbx child failed)', errOut.slice(0, 400));
        resolve(m ? JSON.parse(m[1]) : { ingest: {}, deposit: {} });
      });
    });
  })();
  ok('INGEST A COPY (child server with storage): real bytes land — size IS the stored byte count',
     wByteVerbs.ingest && wByteVerbs.ingest.file
     && Number(wByteVerbs.ingest.file.size) === wPng.length
     && !!wByteVerbs.ingest.file.nas_path, wByteVerbs.ingest && wByteVerbs.ingest.file);
  ok('DEPOSIT: the copy goes out to the dual-role delivery folder — the fake counted the bytes',
     wByteVerbs.deposit && wByteVerbs.deposit.ok === true
     && wByteVerbs.deposit.size === wPng.length
     && wDbx.state.uploads.some((u) => u.size === wPng.length), wByteVerbs.deposit);

  // ── unlink leaves Dropbox untouched — the invariant, witnessed ───────────
  ok('Pat cannot unlink either',
     (await DEL(`/api/shows/${SHOW}/dropbox-links/${wLkOut.body.id}`, { token: T.pat })).status === 403);
  const wUnl = await DEL(`/api/shows/${SHOW}/dropbox-links/${wLkOut.body.id}`, { token: T.brenden });
  ok('Brenden unlinks the delivery folder — the answer SAYS it touched nothing',
     wUnl.status === 200 && wUnl.body.touched_dropbox === false, wUnl.body);
  ok('THE INVARIANT: the fake counted ZERO remote deletes across the entire walk — ' +
     'the folder, the deposit and every arrival still exist in Dropbox',
     wDbx.state.deletes === 0 && wDbx.state.entries.has('/clients/avca/deliverables'),
     wDbx.state.deletes);

  await wDbx.close();
  delete process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_SECRET;
  delete process.env.DROPBOX_REFRESH_TOKEN;
  delete process.env.DROPBOX_API_BASE;
  delete process.env.DROPBOX_CONTENT_BASE;

  // ══════════════════════════════════════════════════════════════════════════
  section('44 · the morning digest — the founding ask gets its daily surface');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom, day one: "we have a big problem with people who talk to the client
  // not informing everyone of what needs to happen... it needs to keep things
  // from falling through the cracks." Every piece existed — tasks, approvals,
  // stale pushes, report obligations, chase lists, byteless files — and
  // nothing gathered what needs a PERSON into one place at the start of their
  // day. This section seeds one person with one of EVERY item kind and walks
  // the gathering, the once-a-day bell row, the silence rules and the panel.
  reach('Today panel', { seam: 'myDigest', action: 'goToday' });
  reach('Digest now (the admin trigger)', { seam: 'runDigest', action: 'digestNow' });

  // three more people: the loaded plate, the empty plate, the opted-out plate
  for (const [u, role, finance, name] of [
    ['dawn',  'pm',     true,  'Dawn Okafor'],    // pm + finance — one of each kind
    ['quinn', 'viewer', false, 'Quinn Marsh'],    // empty plate — the silence proof
    ['reed',  'tech',   false, 'Reed Calloway']   // opted out, WITH a plate
  ]) {
    const r = await POST('/api/users', { username: u, password: PW, role, finance, name }, { token: A });
    ok(`digest cast · ${name} (${role}${finance ? ' + finance' : ''})`, r.status === 200, r.body);
    T[u] = (await POST('/api/auth/login', { username: u, password: PW })).body.token;
  }

  // ── Dawn's plate, one item of every kind, through the product ────────────
  const dgEv = await POST('/api/events', {
    name: 'Great Lakes Invitational', type: 'led', client: 'GLI',
    venue: 'Van Andel Arena', load_in_date: plus(3), event_date: plus(5),
    strike_date: plus(6), cabinets: 60, owner: 'dawn'
  }, { token: T.tom });
  ok('Tom opens Dawn\'s event — load-in in 3 days, not one crew line yet', dgEv.status === 200, dgEv.body);
  const DGSHOW = dgEv.body.show.id, DGPROJ = dgEv.body.show.project_id, DGJOB = dgEv.body.job.id;

  // 1 · a task, overdue on her
  const dgStep = await POST('/api/steps', {
    show_id: DGSHOW, lane: 'venue', title: 'Confirm rigging plot with Van Andel',
    owner: 'dawn', due_date: plus(-1)
  }, { token: T.dawn });
  ok('an overdue task lands on Dawn', dgStep.status === 200, dgStep.body);

  // 2 · a PO over the threshold, quoted, unapproved — waits on canApprovePOs holders
  const dgPo = await POST('/api/pos', { project_id: DGPROJ, job_id: DGJOB, vendor: 'Upstage Rigging' },
    { token: T.dawn });
  ok('Dawn opens a PO', dgPo.status === 200, dgPo.body);
  await POST(`/api/pos/${dgPo.body.id}/lines`,
    { item: 'Ground support towers', qty: 1, unit_cost: 6200, category: 'gear' }, { token: T.dawn });
  const dgQuoted = await PUT(`/api/pos/${dgPo.body.id}/status`, { status: 'quoted' }, { token: T.dawn });
  ok('…quoted at $6,200 — over the $5,000 threshold, nobody has approved it',
     dgQuoted.status === 200, dgQuoted.body);

  // 3 · a stale push. The pushed-at stamp is the infrastructure state a real
  // push writes (§12b owns that wire, against the fake scheduler); the thing
  // under test here is the CHANGE AFTER the push, and that goes through the
  // product: Dawn edits the show, and the staffing copy is now behind.
  await pool.query(
    `UPDATE shows SET scheduler_event_id=90144,
            scheduler_pushed_at = NOW() - interval '1 hour', scheduler_pushed_by='dawn'
      WHERE id=$1`, [DGSHOW]);
  const dgEdit = await PUT(`/api/shows/${DGSHOW}`, { venue: 'Van Andel Arena — Hall B', owner: 'dawn' },
    { token: T.dawn });
  ok('Dawn edits the pushed show — the scheduler copy is now behind',
     dgEdit.status === 200 && dgEdit.body.scheduler_stale === true, dgEdit.body.scheduler_stale);

  // 4 · a struck second show she crewed — the report obligation
  const dgShow2 = await POST('/api/shows', {
    project_id: DGPROJ, name: 'GLI — media day', venue: 'Van Andel Arena',
    load_in_date: plus(10), event_date: plus(20), owner: 'dawn'
  }, { token: T.dawn });
  ok('a second show joins the folder', dgShow2.status === 200, dgShow2.body);
  const DGSHOW2 = dgShow2.body.id;
  await POST(`/api/shows/${DGSHOW2}/crew`, { username: 'dawn', role_on_site: 'LED lead' }, { token: T.dawn });
  const dgStruck = await POST(`/api/shows/${DGSHOW2}/struck`, {}, { token: T.tom });
  ok('Tom marks it struck — Dawn now owes her show report',
     dgStruck.status === 200 && dgStruck.body.created === 1, dgStruck.body);

  // 5 · a content piece due on her, and 6 · a client piece past due (the chase)
  const dgCp = await POST(`/api/shows/${DGSHOW}/content`, {
    name: 'Center-hung intro sting', source: 'e360', owner: 'dawn',
    due_date: plus(1), status: 'in_design'
  }, { token: T.dawn });
  ok('a content piece is due on Dawn tomorrow', dgCp.status === 200, dgCp.body);
  const dgChase = await POST(`/api/shows/${DGSHOW}/content`, {
    name: 'Sponsor logo pack', source: 'client', due_date: plus(-2), status: 'needed'
  }, { token: T.dawn });
  ok('…and the client\'s logo pack is two days late — her folder, her chase',
     dgChase.status === 200, dgChase.body);

  // 7 · a byteless file she filed (Brendon's Rhino doc, §39's shape)
  const dgFile = await POST('/api/files', {
    show_id: DGSHOW, name: 'GLI rigging waiver', ext: 'pdf', kind: 'contract'
  }, { token: T.dawn });
  ok('a metadata-only file row — filed, no bytes ever landed', dgFile.status === 200, dgFile.body);

  // Reed gets a plate too (an overdue task), then opts out where prefs live.
  await POST('/api/steps', { show_id: DGSHOW, lane: 'gear', title: 'Prep spare PSU caddy',
    owner: 'reed', due_date: plus(-1) }, { token: T.dawn });
  const dgOptOut = await PUT('/api/me/notification-prefs', { daily_digest: 'off' }, { token: T.reed });
  ok('Reed opts out of the morning digest — the toggle lives with the other prefs',
     dgOptOut.status === 200 && dgOptOut.body.prefs.daily_digest === 'off', dgOptOut.body.prefs);

  // ── GET /api/me/digest — exactly her items, grouped, in the fixed order ──
  const dgMine = await GET('/api/me/digest', { token: T.dawn });
  const dgKinds = (dgMine.body.groups || []).map((g) => g.kind);
  ok('Dawn\'s digest carries one group of EVERY personal kind, in the fixed order',
     dgMine.status === 200 &&
     dgKinds.join(',') === 'task,po_approval,push_stale,crewless,report,content,chase,byteless',
     dgKinds);
  const dgGroup = (k) => (dgMine.body.groups.find((g) => g.kind === k) || { items: [] }).items;
  ok('…the task group holds the rigging plot, a day late',
     dgGroup('task').some((i) => i.label === 'Confirm rigging plot with Van Andel' && i.age === 1
       && i.show_id === DGSHOW), dgGroup('task'));
  ok('…the approval group holds HER po (canApprovePOs — she carries finance)',
     dgGroup('po_approval').some((i) => i.po_id === dgPo.body.id && i.amount === 6200),
     dgGroup('po_approval'));
  ok('…the stale push names the show and anchors to it',
     dgGroup('push_stale').some((i) => i.show_id === DGSHOW), dgGroup('push_stale'));
  ok('…the crewless load-in is the 3-days-out show with nobody on it',
     dgGroup('crewless').some((i) => i.show_id === DGSHOW && i.due === plus(3)), dgGroup('crewless'));
  ok('…the report group is the struck media day', dgGroup('report').some((i) => i.show_id === DGSHOW2),
     dgGroup('report'));
  ok('…content due + the chase are both hers, separately grouped',
     dgGroup('content').some((i) => i.label === 'Center-hung intro sting') &&
     dgGroup('chase').some((i) => i.label === 'Sponsor logo pack' && i.age === 2),
     { content: dgGroup('content'), chase: dgGroup('chase') });
  ok('…the byteless row rides with its file id for the viewer anchor',
     dgGroup('byteless').some((i) => i.file_id === dgFile.body.id), dgGroup('byteless'));
  ok('…and the one-line summary reads like a morning, not a query plan',
     /1 overdue task/.test(dgMine.body.summary) && /POs? wait/.test(dgMine.body.summary) &&
     /push(es)? (is|are) stale/.test(dgMine.body.summary), dgMine.body.summary);

  // the discriminators: Morgan (manager, NO finance) never sees the approval
  // group; Tom (admin) additionally sees the operator's corner — this walk
  // server has no storage configured, and his digest says so.
  const dgMorgan = await GET('/api/me/digest', { token: T.morgan });
  ok('Morgan\'s digest has NO approval group — canApprovePOs holders only',
     dgMorgan.status === 200 && !dgMorgan.body.groups.some((g) => g.kind === 'po_approval'),
     dgMorgan.body.groups.map((g) => g.kind));
  const dgTom = await GET('/api/me/digest', { token: T.tom });
  ok('Tom (admin) additionally carries the health warning — storage unconfigured, config-read only',
     dgTom.status === 200 && dgTom.body.groups.some((g) => g.kind === 'health'),
     dgTom.body.groups.map((g) => g.kind));

  // ── the admin trigger: once delivers, twice is a no-op, silence holds ────
  const dgRun1 = await POST('/api/admin/digest', {}, { token: A });
  ok('the sweep runs — Dawn notified, Quinn silent (empty), Reed silent (opted out)',
     dgRun1.status === 200 &&
     dgRun1.body.users.dawn?.outcome === 'notified' &&
     dgRun1.body.users.quinn?.outcome === 'empty — silent' &&
     dgRun1.body.users.reed?.outcome === 'opted out',
     { dawn: dgRun1.body.users.dawn, quinn: dgRun1.body.users.quinn, reed: dgRun1.body.users.reed });
  const dawnRows1 = await outboxFor('dawn', 'daily_digest');
  ok('ONE bell row for Dawn — subject is the compact summary',
     dawnRows1.length === 1 && /^Today — /.test(dawnRows1[0].subject), dawnRows1.map((r) => r.subject));
  const dgRun2 = await POST('/api/admin/digest', {}, { token: A });
  ok('IDEMPOTENCY · a same-day re-trigger creates NOTHING — the ledger arbitrates',
     dgRun2.status === 200 && dgRun2.body.users.dawn?.outcome === 'already sent today' &&
     (await outboxFor('dawn', 'daily_digest')).length === 1, dgRun2.body.users.dawn);
  ok('SILENCE · Quinn\'s empty plate produced no notification at all',
     (await outboxFor('quinn', 'daily_digest')).length === 0);
  const reedDigest = await GET('/api/me/digest', { token: T.reed });
  ok('OPT-OUT · Reed HAS items yet got no row — the pref silenced the ping, not the panel',
     reedDigest.body.total >= 1 && (await outboxFor('reed', 'daily_digest')).length === 0,
     { items: reedDigest.body.total });

  // ── the panel front: every kind renders with a working navigate anchor ───
  const vg = SRC['views-global.js'];
  const todayFn = (vg.match(/function digestItemAct[\s\S]*?function viewToday[\s\S]*?\n}/) || [''])[0];
  ok('viewToday renders and digestItemAct doors every kind — PO, file viewer, show, folder, Settings',
     /act\('openPO', i\.po_id\)/.test(todayFn) && /act\('openViewer', i\.file_id\)/.test(todayFn) &&
     /act\('goSettings'\)/.test(todayFn) && /act\('openShow', i\.show_id\)/.test(todayFn) &&
     /act\('openFolder', i\.project_id\)/.test(todayFn));
  ok('…and the pill vocabulary names every digest kind the server can emit',
     ['task', 'po_approval', 'push_stale', 'crewless', 'report', 'content', 'chase', 'byteless',
      'backup_stale', 'health'].every((k) => new RegExp(`${k}: '`).test(vg)));
  ok('the bell popover carries the Today door — live digest, rendered ONLY when items exist',
     /bp-sec">Today</.test(SRC['views-notes.js']) &&
     /dig && dig\.total/.test(SRC['views-notes.js']) &&
     /act\('goToday'\)/.test(SRC['views-notes.js']));
  ok('the Settings card renders the digest opt-out beside the other prefs',
     SRC['views-global.js'].includes("'daily_digest:' + pair[0]"));
  ok('an empty Today panel celebrates silence instead of paging anyone',
     /silence is the success state/.test(vg));

  // ══════════════════════════════════════════════════════════════════════════
  section('45 · eager folders — the create is recorded, the warning renders, the backfill heals  (Tom, 9/11)');
  // ══════════════════════════════════════════════════════════════════════════
  // "the folder should get created the minute a show is created. i chose the
  // big ten because i knew it was the only one with a folder." This server
  // runs in PRODUCTION SHAPE — no storage — so what the walk proves here is
  // the TOLERANT path: every entity minted this month had its folder create
  // ATTEMPTED, the miss recorded (never thrown, never slowing the create),
  // the warning renders from that record, and the backfill sweep answers
  // honestly here and REALLY CREATES on §34's child-server device.
  reach('Backfill storage folders (Settings · NAS card)',
    { seam: 'storageFoldersSweep', action: 'storageFolderSweep' });

  // the attempt on §1's project was recorded — error, no stamp, activity line
  const fProjRow = (await pool.query(
    'SELECT storage_folder_at, storage_folder_error FROM projects WHERE id=$1', [PROJ])).rows[0];
  ok('the folder create was ATTEMPTED the minute the event was opened — and the miss recorded',
     !!fProjRow.storage_folder_error && !fProjRow.storage_folder_at, fProjRow);
  ok('…as an honest activity line, not a thrown create',
     (await pool.query(
       `SELECT COUNT(*)::int AS n FROM activity WHERE action='storage.folder_failed' AND project_id=$1`,
       [PROJ])).rows[0].n >= 1);
  const fPayload = await GET(`/api/projects/${PROJ}`, { token: T.omar });
  ok('the payload carries the record — what the warn chip reads',
     fPayload.status === 200 && !!fPayload.body.storage_folder_error, fPayload.body.storage_folder_error);

  // the warning state, EXECUTED: the real components.js, headless
  const comp = (() => {
    const ctx = { console };
    ctx.window = ctx;
    vm.createContext(ctx);
    new vm.Script(SRC['components.js'], { filename: 'public/components.js' }).runInContext(ctx);
    return ctx;
  })();
  comp.SR = { isApi: () => true };
  ok('the warn chip renders from a recorded miss — and says the honest sentence',
     /storage folder missing — will retry on next upload/.test(
       comp.storageFolderChip({ storage_folder_error: 'MKCOL answered 500' })));
  ok('…clears itself once the folder is confirmed, and never renders in demo',
     comp.storageFolderChip({ storage_folder_error: null, storage_folder_at: '2026-09-11' }) === ''
     && (() => { comp.SR = { isApi: () => false };
                 const r = comp.storageFolderChip({ storage_folder_error: 'x' });
                 comp.SR = { isApi: () => true }; return r === ''; })());
  ok('both headers render the chip — show and season',
     /storageFolderChip\(show\)/.test(SRC['views-folder.js'])
     && /storageFolderChip\(project\)/.test(SRC['views-dashboard.js']));

  // floors + the storage-less sweep answers honestly
  ok('a pm cannot run the backfill',
     (await POST('/api/admin/storage-folders/sweep', {}, { token: T.brenden })).status === 403);
  const fSweepNoStore = await POST('/api/admin/storage-folders/sweep', {}, { token: T.tom });
  ok('with no storage the sweep says so — configured:false, nothing invented',
     fSweepNoStore.status === 200 && fSweepNoStore.body.configured === false
     && /not configured/.test(fSweepNoStore.body.note || ''), fSweepNoStore.body);

  // the backfill FOR REAL — §34's child-server device, throwaway STORAGE_ROOT
  const fStoreRoot = path.join(os.tmpdir(), 'sr-walk-folders');
  const fChild = (() => {
    const script =
      `(async () => {
        const srv = require(${JSON.stringify(path.join(APP, 'server.js').replace(/\\/g, '/'))});
        const server = await srv.boot();
        const base = 'http://127.0.0.1:' + server.address().port;
        const login = await fetch(base + '/api/auth/login', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'tom', password: ${JSON.stringify(PW)} }) });
        const tok = (await login.json()).token;
        const r = await fetch(base + '/api/admin/storage-folders/sweep', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': tok } });
        console.log('WALKFOLDERS ' + JSON.stringify({ status: r.status, body: await r.json() }));
        server.close();
        process.exit(0);
      })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PORT: '0', SWEEP_ON_BOOT: '0', STORAGE_ROOT: fStoreRoot }
    });
    const m = String(r.stdout || '').match(/WALKFOLDERS (.*)/);
    if (!m) console.error('  (folders child failed)', String(r.stderr || '').slice(0, 400));
    return m ? JSON.parse(m[1]) : { status: 0, body: {} };
  })();
  ok('the sweep on a storage-backed twin answers per path',
     fChild.status === 200 && fChild.body.configured === true
     && Array.isArray(fChild.body.results) && fChild.body.results.length >= 1,
     { ok: fChild.body.ok, failed: fChild.body.failed });
  const fMine = (fChild.body.results || []).find((r) => r.kind === 'project' && r.id === PROJ);
  ok('…including §1\'s folder, created and named',
     !!fMine && fMine.ok === true && fMine.path.includes(`P${PROJ}-`), fMine);
  ok('…and the folder REALLY exists where every upload path starts',
     fs.existsSync(path.join(fStoreRoot, `P${PROJ}-${fPayload.body.slug}`, '_project')),
     path.join(fStoreRoot, `P${PROJ}-${fPayload.body.slug}`));
  const fProjAfter = (await pool.query(
    'SELECT storage_folder_at, storage_folder_error FROM projects WHERE id=$1', [PROJ])).rows[0];
  ok('…which heals the record: stamped, error gone — the chip retires itself',
     !!fProjAfter.storage_folder_at && fProjAfter.storage_folder_error === null, fProjAfter);
  ok('the SHOW was already stamped by §34\'s bind — real bytes are their own proof',
     !!(await pool.query('SELECT storage_folder_at FROM shows WHERE id=$1', [SHOW]))
       .rows[0].storage_folder_at);

  // ══════════════════════════════════════════════════════════════════════════
  section('46 · the bound spec IS the sheet — the viewer\'s lookup and embed, executed  (Tom, 9/11)');
  // ══════════════════════════════════════════════════════════════════════════
  // "if this doesnt bind the spec sheet as i see it or email it- its of no
  // use to me." The bind banks a render bundle per rev; the FILE VIEWER now
  // stages it above the honest card, with Download image and Print / PDF.
  // The lookup (api.specRenderForFile) is EXECUTED through §37's browser-half
  // vm against this walk's live server — break the bundle lookup and these
  // go red, not just a scan.
  reach('Download / print the banked spec render',
    { seam: ['specRenderForFile', 'getSpecRender'], action: ['specPrintRender'] });
  // 9/11 follow-up: the FILE DETAILS panel's own Print/Download speak the
  // SHEET when a render is staged — the smart download is reachable, and
  // printFile()'s render branch exists in source (the two-print-buttons trap).
  reach('Panel download hands the render for a bound spec', { action: 'downloadFileSmart' });
  ok('printFile() prints the staged render first — the panel print can never mean the card while a sheet is on stage',
     /function printFile\(\)[\s\S]{0,400}VIEWER\.specRender/.test(APP_JS), 'app.js printFile');
  ok('the viewer stages the render above the record card — and keeps the honest fallback',
     /drawSpecRender\(show, f, sheet\)/.test(SRC['views-global.js'])
     && /id="vSpecR"/.test(SRC['views-global.js'])
     && /No banked render for this bind/.test(SRC['views-global.js']));
  ok('the chain View modal shares the SAME embed — one implementation, two surfaces',
     /specRenderEmbedHTML\(r, \{ showId: Number\(showId\) \}\)/.test(APP_JS));
  ok('the seam\'s demo twin serves the locally-generated bundle',
     /specRenderForFile:[\s\S]{0,900}?demoSpecRenderFor/.test(API_JS));

  // the LOOKUP, executed: the current bind resolves on the fast path; a
  // superseded or unbound rev resolves through history AT ITS OWN REV; a row
  // no bundle answers for resolves NULL, honestly
  tab.SR.setToken(T.omar);
  const fCur = await GET(`/api/shows/${SHOW}/spec-render/content`, { token: T.omar });
  ok('(precondition) a live content render exists to look up', fCur.status === 200, fCur.status);
  const fLk0 = await tab.api.specRenderForFile(SHOW,
    { id: fCur.body.fileId, chain_key: 'content', spec_type: 'e360' });
  ok('THE LOOKUP · the CURRENT bind answers on the fast path, at its own rev',
     !!fLk0 && fLk0.fileId === fCur.body.fileId && fLk0.rev === fCur.body.rev,
     fLk0 && { rev: fLk0.rev, want: fCur.body.rev });
  const fLk1 = await tab.api.specRenderForFile(SHOW,
    { id: wb3.body.fileId, chain_key: 'content', spec_type: 'e360' });
  ok('…a SUPERSEDED row (§34\'s v3, retired by §41\'s zoned bind) is served at ITS rev',
     !!fLk1 && fLk1.fileId === wb3.body.fileId && fLk1.rev === 3, fLk1 && { rev: fLk1.rev });
  const fLk2 = await tab.api.specRenderForFile(SHOW,
    { id: wb2.body.fileId, chain_key: null, spec_type: 'e360' });
  ok('…an UNBOUND row is found through spec-history and served at ITS rev, marked retired',
     !!fLk2 && fLk2.fileId === wb2.body.fileId && fLk2.rev === 2 && fLk2.retired === true,
     fLk2 && { rev: fLk2.rev, retired: fLk2.retired });
  ok('…a row no bundle answers for resolves NULL — the card stands alone, honestly',
     (await tab.api.specRenderForFile(SHOW, { id: 99999999, spec_type: 'e360' })) === null
     && (await tab.api.specRenderForFile(SHOW, { id: wb3.body.fileId })) === null);

  // the EMBED, executed on the real components.js: preference order, the
  // sandbox, the print harness, and both download labels
  const fEmHtml = comp.specRenderEmbedHTML(
    { node: 'content', rev: 2, html: '<div>page</div>', png: 'data:image/png;base64,AAAA' },
    { showId: SHOW });
  // 9/11, Tom, final ruling: "i cant have people downloading shitty
  // unsanctioned diagrams." The bundle's only image is the top-down field
  // diagram — an internal drawing. The SHEET (via the print dialog's Save as
  // PDF) is the ONE artifact a bound spec offers; no image download exists.
  ok('THE EMBED · pageHtml wins the stage: sandboxed iframe + print harness, and the sheet is the ONLY artifact offered',
     /sandbox="allow-scripts allow-modals"/.test(fEmHtml) && /sr-print/.test(fEmHtml)
     && /Sheet → Print \/ Save as PDF/.test(fEmHtml)
     && !/Field diagram/.test(fEmHtml) && !/specDownloadRender/.test(fEmHtml));
  const fEmPng = comp.specRenderEmbedHTML({ node: 'content', rev: 1, png: 'data:image/png;base64,AAAA' },
    { showId: SHOW });
  ok('…the PNG stands in ON STAGE when pageHtml is absent — viewable, never downloadable',
     /specr-img/.test(fEmPng) && !/specDownloadRender/.test(fEmPng) && !/Sheet → Print/.test(fEmPng));
  ok('…an SVG-only bundle stages the drawing and offers no download either',
     (function (h) { return /specr-frame/.test(h) && !/specDownloadRender/.test(h); })(
       comp.specRenderEmbedHTML({ node: 'content', rev: 1, svg: '<svg/>' }, { showId: SHOW })));
  ok('…and a bundle with nothing drawable is NULL — the surfaces say so instead of drawing',
     comp.specRenderEmbedHTML({ node: 'content', rev: 1 }, { showId: SHOW }) === null);
  ok('the diagram-download machinery is GONE from the source, not just unmounted',
     !/specDownloadRenderAct/.test(APP_JS) && !/specRenderFileName/.test(APP_JS));

  // ══════════════════════════════════════════════════════════════════════════
  section('47 · the Photos tab gets its human door  (Tom, 9/16)');
  // ══════════════════════════════════════════════════════════════════════════
  // 2026-09-16, live, closing out a show. The Photos tab's empty state said
  // "Photos land here when your agent syncs them" and offered a person NOTHING
  // — the agent pipeline it described does not run yet, so the photo feature,
  // the recap picks it feeds and the client recap's images had zero human path
  // in production (DESIGN_GAPS D5). Tom: "so theres no manual way to attach
  // photos?" The house rule this broke: the UI must never promise fictional
  // actors, and every needed affordance must exist for a real human.
  reach('Add photos', { seam: 'uploadPhoto', action: 'photoAdd' });
  {
    const vf = SRC['views-folder.js'];
    const emptyAt = vf.indexOf('No photos on this show yet');
    ok('the empty state leads with the HUMAN door — Add photos is its primary button',
       emptyAt > 0 && vf.slice(emptyAt, emptyAt + 1200).includes("act('photoAdd'"),
       { emptyAt });
    ok('the fictional-actor promise is GONE — no line says photos only land when an agent syncs them',
       !/Photos land here when your agent syncs them/.test(vf));
    ok('the agent-sync story is framed as what will ALSO happen once agents run — not the only way',
       /agents run, they will <b>also<\/b> fill this gallery/.test(vf));
    ok('the NAS path line is kept on the empty state',
       vf.slice(Math.max(0, emptyAt), emptyAt + 2000).includes('phNasHint(show)'));
    ok('the populated gallery bar carries the same door — not only the empty state',
       (vf.match(/act\('photoAdd'/g) || []).length >= 2,
       (vf.match(/act\('photoAdd'/g) || []).length);
    ok('the button renders behind canAddPhotos() — the tech+ mirror of the route floor (server is the gate)',
       /canAddPhotos\(\)/.test(vf) && /PH_ADD_ROLES = \{ admin: 1, manager: 1, pm: 1, tech: 1 \}/.test(SRC['data.js']));
    // the failure toast wears the error face — §38's rule, pinned by name for
    // this incident's own toast the way Tom's three screenshots are
    ok('“Photo not added” exists in app.js and passes the ERROR kind',
       /toast\('Photo not added',[\s\S]{0,140}'err'\)/.test(APP_JS));
    // HARDENING 21, held UNCONDITIONALLY on this call site. §12b's scan
    // exempts demo-guarded functions, and photoAddAct references apiMode()
    // for its toast wording — so the generic scan alone would let a stamped
    // size/dim ride back in here. This uses §12b's own extraction, minus the
    // exemption: the payload carries measureImage's w/h or nothing, ever.
    const upl = payloads.filter((p) => p.fn === 'uploadPhoto');
    ok('the api.uploadPhoto call site is in the §12b extraction', upl.length >= 1,
       upl.map((p) => p.owner).join(', '));
    ok('HARDENING 21 · the uploadPhoto payload carries NO size and NO dim — measured w/h or nothing, no exemption',
       upl.every((p) => !/(^|[{,\s])(size|dim)\s*:/.test(stripComments(p.text))),
       upl.map((p) => p.owner + '()').join(' · '));
  }

  // the live half, in this walk's PRODUCTION SHAPE (no storage): the one-call
  // route is bytes-FIRST, so on a server with no byte layer it must refuse
  // honestly AND leave the gallery exactly as it was — a receipt row pointing
  // at bytes that never landed is the ghost-row bug this route exists to
  // never have.
  const phBefore = await GET(`/api/shows/${SHOW}/photos`, { token: T.omar });
  ok('(precondition) the show’s gallery reads', phBefore.status === 200, phBefore.status);
  const phTry = await call('POST',
    `/api/shows/${SHOW}/photos/upload?name=walk-frame&ext=jpg&w=4032&h=3024`,
    { token: T.omar, raw: Buffer.from('jpeg bytes a tech picked') });
  ok('a tech’s upload on a storage-less server is a 501 naming STORAGE_ROOT — never a silent write to a dying disk',
     phTry.status === 501 && /STORAGE_ROOT/.test(phTry.body?.error || ''), phTry);
  const phAfter = await GET(`/api/shows/${SHOW}/photos`, { token: T.omar });
  ok('…and it created NOTHING — no ghost row behind the failure toast',
     phAfter.status === 200 && phAfter.body.length === phBefore.body.length
     && !phAfter.body.some((f) => f.name === 'walk-frame'),
     { before: phBefore.body.length, after: phAfter.body.length });

  // §37's lesson, applied to the new seam: reach() proves api.uploadPhoto
  // EXISTS; only running it proves the browser half executes. The REAL
  // loaded api.js drives the same route and must surface the server's own
  // refusal verbatim — never swallow it into a green.
  tab.SR.setToken(T.omar);
  const seamErr = await tab.api.uploadPhoto(SHOW, Buffer.from('jpeg bytes'),
    { name: 'seam-frame', ext: 'jpg' }).then(() => null, (e) => e);
  ok('the REAL api.uploadPhoto executes and surfaces the storage refusal verbatim',
     !!seamErr && /STORAGE_ROOT/.test(String((seamErr && seamErr.message) || '')),
     String(seamErr).slice(0, 160));

  // the floor, against a DISCRIMINATING identity one rung below it: a viewer
  // must bounce off the ROLE gate (403) — not the storage 501 — proving the
  // gate sits in front of the byte layer, on the server, not in the button.
  const vic = await POST('/api/users',
    { username: 'vic', password: PW, role: 'viewer', name: 'Vic Viewer' }, { token: A });
  ok('a viewer exists to discriminate the floor', vic.status === 200, vic.body);
  const VICT = (await POST('/api/auth/login', { username: 'vic', password: PW })).body.token;
  const phViewer = await call('POST', `/api/shows/${SHOW}/photos/upload?name=vic-frame&ext=jpg`,
    { token: VICT, raw: Buffer.from('jpeg bytes') });
  ok('the floor is tech+: a viewer is 403 from the role gate, before storage is ever consulted',
     phViewer.status === 403, phViewer);

  // ══════════════════════════════════════════════════════════════════════════
  section('48 · every automated capability keeps a human door  (Tom, 9/16)');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom's law, decreed 9/16: "there shouldnt be anything that cant also be
  // done manually" — and its corollary, the UI must never claim actors that
  // do not exist. A read-only audit found five violations; this section is
  // their regression wall: the new doors reach(), the seams EXECUTE against
  // this walk's live server (§37's lesson), and the fictional-actor and
  // scheduler-overstating strings are held out of the source MECHANICALLY,
  // the way §38 holds the toast faces.

  // ── the doors exist and render ────────────────────────────────────────────
  reach('Reject an agent proposal (every kind, file row or none)',
    { seam: 'rejectDoc', action: 'rejectDoc' });
  reach('Flush the digest queue (Settings · Notifications)',
    { seam: 'flushNotifications', action: 'flushDigest' });
  reach('Add a folder-level file (season dashboard)',
    { seam: 'addFile', action: 'addProjectFile' });

  // ── 1 · REJECT is not a dead button on a file-less proposal ──────────────
  // A proposed tasks:batch materializes NO file row; the bell/review reshape
  // synthesizes a pseudo-file with a NEGATIVE id. rejectDocAct used to gate
  // on api.getFile(fileId) — a 404 for that id — and silently returned:
  // no toast, no rejection. MUTATION GATE: put the `if (!f) return;` gate
  // back in front of api.rejectDoc and both halves below go red.
  {
    const rdBody = (APP_JS.match(/async function rejectDocAct[\s\S]*?\n}/) || [''])[0];
    ok('rejectDocAct no longer gates on api.getFile — the dead-button gate is GONE',
       rdBody.length > 0 && !/api\.getFile/.test(rdBody) && /api\.rejectDoc/.test(rdBody),
       rdBody.slice(0, 120));
    ok('…and its failure toast wears the error face (“Not rejected”, kind err)',
       /toast\('Not rejected',[\s\S]{0,120}'err'\)/.test(rdBody), rdBody.slice(0, 200));

    // the live half: brenden's agent proposes a tasks batch (no file row),
    // and the REAL api.js — the loaded browser half — rejects it through the
    // pseudo-id the review page hands a click.
    //
    // These seams read the page's STORE CACHES — globals data.js defines
    // before api.js loads on the real page, empty in a fresh API-mode tab
    // and filled by the A.* normalizers. Provide exactly that slice here;
    // §37's eight-global shim stays untouched for the seams that need none.
    // (mkThumb is data.js's photo placeholder — a headless stub, never hit
    // for the document kinds this section files.)
    for (const g of ['FILES_BY_ID', 'SHOWS_BY_ID', 'PROJECTS_BY_ID',
                     'EXPENSES_BY_ID', 'BOOKINGS_BY_ID']) {
      if (!(g in tab)) tab[g] = {};
    }
    if (!('ALL_EXPENSES' in tab)) tab.ALL_EXPENSES = [];
    if (!('mkThumb' in tab)) tab.mkThumb = () => '';
    const wtbKey = await POST('/api/keys',
      { label: 'walk batch agent', scopes: ['agent:propose'] }, { token: T.brenden });
    ok('brenden mints his agent a propose-scoped key', wtbKey.status === 200 && !!wtbKey.body.key,
       wtbKey.body?.key_prefix);
    const wtb = await POST('/api/agent/tasks:batch', {
      showId: SHOW, status: 'proposed',
      provenance: { sourceKind: 'meeting', sourceRef: 'walk:48batch',
                    sourceLabel: 'Wrong client call', confidence: 68 },
      steps: [{ lane: 'venue', title: 'walk48 step that must never exist' }]
    }, { key: wtbKey.body.key, idem: 'walk:48batch#tasks' });
    ok('the agent proposes a tasks batch — a proposal with NO file row',
       wtb.status === 200 && wtb.body.status === 'proposed' && !!wtb.body.proposalId, wtb.body);
    const WPID = wtb.body.proposalId;
    tab.SR.setToken(T.brenden);
    const wtbRows = await tab.api.listProposals({ status: 'pending' });
    const wtbRow = (wtbRows || []).find((p) => p.id === WPID);
    ok('the REAL api.listProposals synthesizes the pseudo-file (negative id, proposal_id cached)',
       !!wtbRow && wtbRow.file && wtbRow.file.id === -WPID && wtbRow.file.proposal_id === WPID,
       wtbRow && wtbRow.file && { id: wtbRow.file.id, pid: wtbRow.file.proposal_id });
    const wtbRej = await tab.api.rejectDoc(-WPID).then((r) => r, (e) => ({ error: String(e) }));
    ok('the REAL api.rejectDoc EXECUTES on the pseudo-id — the click path, minus the finger',
       wtbRej && wtbRej.ok === true && !wtbRej.error, wtbRej);
    const wtbDb = await pool.query('SELECT status, resolved_by FROM proposals WHERE id=$1', [WPID]);
    ok('…and the rejection is RECORDED — resolved by the human, no step ever created',
       wtbDb.rows[0].status === 'rejected' && wtbDb.rows[0].resolved_by === 'brenden' &&
       (await pool.query(`SELECT COUNT(*)::int AS n FROM steps
          WHERE title='walk48 step that must never exist'`)).rows[0].n === 0,
       wtbDb.rows[0]);
  }

  // ── 2 · the digest queue drains — timer AND button ────────────────────────
  // Batched ('in a digest') rows queued forever: the lifecycle sweep flushes
  // immediate-only, the digest sweep passed {}, and the {digest:true} seam
  // hung unrendered. Now the morning digest sweep drains it (smoke's
  // mutation-gated F3 DRAIN) and Settings has the manual door; this executes
  // the exact seam the button fires, as the admin the button renders for.
  {
    await PUT('/api/me/notification-prefs', { notify: 'digest' }, { token: T.omar });
    const wfd = await PUT(`/api/shows/${SHOW}`,
      { venue: 'Fiserv Forum — dock B', notify: ['omar'] }, { token: T.brenden });
    ok('brenden notifies omar of a change — omar batches it (digest mode)', wfd.status === 200);
    const wfdBefore = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notification_outbox
        WHERE username='omar' AND mode='digest' AND status='queued'`);
    ok('…the batched row is queued and waiting', wfdBefore.rows[0].n >= 1, wfdBefore.rows[0]);
    tab.SR.setToken(T.tom);
    const wfdRes = await tab.api.flushNotifications({ digest: true })
      .then((r) => r, (e) => ({ error: String(e) }));
    ok('the REAL api.flushNotifications({digest:true}) executes — the Settings button\'s exact call',
       wfdRes && !wfdRes.error && typeof wfdRes.considered === 'number', wfdRes);
    const wfdAfter = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notification_outbox
        WHERE username='omar' AND mode='digest' AND status='queued'`);
    ok('…and omar\'s batched queue is DRAINED', wfdAfter.rows[0].n === 0, wfdAfter.rows[0]);
    const vg48 = SRC['views-global.js'];
    ok('the button renders beside “See what was sent”, admin-gated like the endpoint',
       /act\('openOutbox'\)[\s\S]{0,400}act\('flushDigest'\)/.test(vg48) &&
       /role === 'admin'[\s\S]{0,300}act\('flushDigest'\)/.test(vg48));
    ok('the card copy stopped claiming the queue only moves when someone asks',
       !/still flush only when someone asks/.test(vg48) &&
       /ride the <b>morning digest<\/b>/.test(vg48));
  }

  // ── 3 · a human files a FOLDER-LEVEL document, like agents always could ──
  // routes/agent.js takes projectId with no show; POST /api/files likewise;
  // api.addFile hard-set show_id so no person could reach the shape, and no
  // folder view rendered a door. MUTATION GATE: re-hard-set show_id in
  // api.addFile (or drop the season header button) and this goes red.
  {
    tab.SR.setToken(T.brenden);
    const wpf = await tab.api.addFile(null,
      { project_id: PROJ, name: 'walk48 season sponsor deck', ext: 'pdf', kind: 'contract' })
      .then((r) => r, (e) => ({ error: String(e) }));
    ok('the REAL api.addFile takes a folder target — show_id null, project_id kept',
       wpf && !wpf.error && wpf.show_id == null && wpf.project_id === PROJ, wpf);
    ok('…and the server derived the folder\'s _project NAS path — buildFolderPath, mirrored',
       /\\_project\\/.test(String(wpf && wpf.nas_path)), wpf && wpf.nas_path);
    ok('the season dashboard renders the door (Add file, beside Add show)',
       /act\('addProjectFile', project\.id\)/.test(SRC['views-dashboard.js']));
    ok('the add-file dialog names the folder target honestly (_project, folder level)',
       /_project/.test(APP_JS) && /folder level/.test(APP_JS));
  }

  // ── 4 · the fictional actors are GONE from the source ────────────────────
  // Nothing watches any inbox (lib/mail.js only sends). The mechanism —
  // agent API + confidence bands — is real; the actor is not yet. The copy
  // now says so in the API-keys card's conditional voice, and these scans
  // keep it that way.
  {
    for (const [fname, bad] of [
      ['views-finance.js', /watches your inbox/],
      ['app.js', /does this filing automatically/],
      ['views-folder.js', /automatically when the strike date passes/],
      ['views-dashboard.js', /Auto-archive runs/]
    ]) {
      ok(`“${String(bad).slice(1, -1)}” is GONE from ${fname}`, !bad.test(SRC[fname]));
    }
    ok('the finance copy speaks in the conditional — the agent WILL run, it does not yet',
       (SRC['views-finance.js'].match(/Once your M365 agent runs/g) || []).length === 2 &&
       /Once your M365 agent runs/.test(APP_JS));
    // the demo fixture PO-26-049 may be named only on the DEMO side of the
    // mode ternary — a live board must not promise a demo row
    const poHint = SRC['views-purchasing.js'];
    const poHits = poHint.match(/PO-26-049/g) || [];
    ok('PO-26-049 is name-dropped once, demo-gated — never promised on a live board',
       poHits.length === 1 && /SR\.isApi\(\)[\s\S]{0,220}PO-26-049/.test(poHint), poHits.length);
    // the sweep-honest phrasing replaced both scheduler overstatements
    ok('both reworded lines defer to the SWEEP — on boot, or when an admin presses Sweep',
       /the next time the sweep runs after the strike date passes/.test(SRC['views-folder.js']) &&
       /presses Sweep in Settings/.test(SRC['views-folder.js']) &&
       /the next time the sweep runs: on boot/.test(SRC['views-dashboard.js']) &&
       /presses Sweep in Settings/.test(SRC['views-dashboard.js']));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('49 · the browser is the thumbnailer  (Tom, 9/16, round two)');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom walked §47's upload live: bytes on the NAS, real dimensions — and
  // placeholder art forever. Root cause: the NAS watcher the thumb contract
  // promised WAS NEVER BUILT (no daemon in any repo, THUMBNAILER_TOKEN unset
  // in prod), so thumb_path stayed NULL for eternity — a fictional actor,
  // the exact class §47 and §48 closed. The browser that decodes every
  // picked image to measure it now downscales it too, and the thumb-less
  // backlog gets its own manual door.
  reach('Make thumbnails (the backfill door)', {
    seam: ['uploadPhotoThumb', 'downloadThumbBytes'], action: 'phThumbBackfill' });

  // ── THE DISCARD BUG, PINNED FUNCTIONALLY on the real loaded api.js ────────
  // A.file used to throw away a NAS-shaped thumb_path and substitute the
  // placeholder — honest while no byte route existed, a real-thumbnail eater
  // the moment one did. Run the actual adapter, not a regex over it. (The vm
  // has no data.js, so the placeholder-maker is stubbed to a RECOGNIZABLE
  // data URI — the adapter's branching is what is under test. §48 installed
  // its own inert ''-returning stub for its absorbs, which have all run;
  // overwrite it here on purpose, so "placeholder painted" is
  // distinguishable from "nothing painted".)
  tab.mkThumb = function () { return 'data:image/svg+xml;stub'; };
  const pinPath = '\\\\E360-NAS\\Showrunner\\P9-x\\S9-y\\photo\\a_t320.jpg';
  const pin1 = tab.SR.absorb.file({ id: 999001, kind: 'photo', name: 'pin',
    thumb_path: pinPath, width: 400, height: 300 });
  ok('a NAS-shaped thumb_path is NO LONGER DISCARDED — placeholder paints, and the row is marked for the session-authed fetch',
     pin1.thumb_pending === true && /^data:image\/svg/.test(String(pin1.thumb)),
     { pending: pin1.thumb_pending, thumb: String(pin1.thumb).slice(0, 28) });
  pin1.thumb = 'blob:resolved-thumb'; pin1.thumb_pending = false;
  const pin2 = tab.SR.absorb.file({ id: 999001, kind: 'photo', name: 'pin',
    thumb_path: pinPath, width: 400, height: 300 });
  ok('…a re-absorb CARRIES the resolved thumb forward instead of resetting to placeholder',
     pin2.thumb === 'blob:resolved-thumb' && pin2.thumb_pending === false, String(pin2.thumb));
  const pin3 = tab.SR.absorb.file({ id: 999002, kind: 'photo', name: 'bare' });
  ok('…and a thumb-less row keeps placeholder art as the honest fallback, unmarked',
     /^data:image\/svg/.test(String(pin3.thumb)) && !pin3.thumb_pending);

  // ── the wall fetches thumbs on the session, LAZILY ────────────────────────
  ok('the gallery kicks the thumb fetch and its imgs carry the swap hook',
     /phThumbKick\(photos\)/.test(SRC['views-folder.js']) &&
     /data-phid="' \+ Number\(f\.id\)/.test(SRC['views-folder.js']));
  ok('the wall stays lazy — phThumbKick moves THUMB bytes, never an original',
     /function phThumbKick[\s\S]{0,700}downloadThumbBytes/.test(APP_JS) &&
     !/function phThumbKick[\s\S]{0,700}downloadFileBytes/.test(APP_JS));
  ok('the backfill door renders only when thumb-less photos this person can fix exist',
     /var thumbless = photos\.filter[\s\S]{0,200}canEditPhoto\(f\)/.test(SRC['views-folder.js']) &&
     /id="phBackfillBtn"/.test(SRC['views-folder.js']));
  // the fictional actor is out of the COPY too — §48's device, applied here
  ok('no UI line promises the NAS watcher will render thumbnails',
     !/thumbnails fill in when the NAS watcher renders them/.test(APP_JS));
  ok('SCHEMA.md says out loud that the browser is the thumbnailer today',
     /The browser is the thumbnailer today/.test(
       fs.readFileSync(path.join(APP, 'SCHEMA.md'), 'utf8')));

  // ── the live half, in PRODUCTION SHAPE (no storage) ───────────────────────
  // bytes-first must hold for thumbs exactly as for originals: the refusal
  // is honest AND the row is never stamped — thumb_path pointing at bytes
  // that never landed would be the fictional actor reborn as a column.
  const thReg = await POST(`/api/shows/${SHOW}/photos`, { name: 'walk-thumb-target', ext: 'jpg' },
    { token: T.omar });
  ok('(fixture) a metadata photo registers', thReg.status === 200, thReg.body);
  const thTry = await call('PUT', `/api/photos/${thReg.body.id}/thumb/content`,
    { token: T.omar, raw: Buffer.from('320px jpeg stand-in') });
  ok('the thumb PUT on a storage-less server is a 501 naming STORAGE_ROOT',
     thTry.status === 501 && /STORAGE_ROOT/.test(thTry.body?.error || ''), thTry);
  const thRow = await GET(`/api/photos/${thReg.body.id}`, { token: T.omar });
  ok('…and thumb_path is STILL NULL — never stamped for bytes that did not land',
     thRow.body.thumb_path == null, thRow.body.thumb_path);
  ok('…a viewer may not thumb somebody else’s photo (pm+ OR the uploader)',
     (await call('PUT', `/api/photos/${thReg.body.id}/thumb/content`,
                 { token: VICT, raw: Buffer.from('x') })).status === 403);
  ok('…GET thumb for a thumb-less photo is an honest 404',
     (await GET(`/api/photos/${thReg.body.id}/thumb/content`, { token: T.omar })).status === 404);

  // ══════════════════════════════════════════════════════════════════════════
  section('50 · the Back button stays in the building  (Tom, 9/16, live)');
  // ══════════════════════════════════════════════════════════════════════════
  // "how come the back button takes me to a whole new website... it needs
  // fixed. its totally annoying." The app had ZERO history integration —
  // every screen at one URL, so Back exited the site. The fix is a hash
  // router whose PURE core (public/router.js) is EXECUTED here in a vm —
  // §37's lesson: the echo guard and the replace/push policy are proven by
  // RUNNING them, never by reading them — while the browser-half wiring in
  // app.js is held mechanically, the way §38 holds the toast kinds.
  const RTR = (() => {
    const ctx = {};
    vm.createContext(ctx);
    new vm.Script(SRC['router.js'], { filename: 'public/router.js' }).runInContext(ctx);
    return ctx;
  })();
  ok('the REAL public/router.js loads headless on a ZERO-global shim — pure by construction',
     typeof RTR.routeFor === 'function' && typeof RTR.routeParse === 'function' &&
     typeof RTR.makeRouterCore === 'function');

  // ── the route table, executed both ways ───────────────────────────────────
  ok('navigations write the expected hashes — the shipped route table',
     RTR.routeFor('show', 13, 'schedule') === '#/shows/13/schedule' &&
     RTR.routeFor('show', 13, 'overview') === '#/shows/13' &&
     RTR.routeFor('folder', 4) === '#/folders/4' &&
     RTR.routeFor('job', 2) === '#/jobs/2' &&
     RTR.routeFor('po', 5) === '#/pos/5' &&
     RTR.routeFor('viewer', 9) === '#/viewer/9' &&
     RTR.routeFor('finance') === '#/finance' &&
     RTR.routeFor('settings') === '#/settings' &&
     RTR.routeFor('archive') === '#/archive' &&
     RTR.routeFor('mytasks') === '#/mytasks');
  ok('every singleton view renderView() serves has a route, and each round-trips',
     Object.keys(RTR.ROUTE_VIEWS).every((v) => {
       const p = RTR.routeParse(RTR.routeFor(v));
       return p && p.view === v;
     }) && Object.keys(RTR.ROUTE_VIEWS).length === 16);
  ok('a view with no route answers null — never a crash, never an invented hash',
     RTR.routeFor('login') === null && RTR.routeFor('show', 'x') === null &&
     RTR.routeFor('show', -3) === null);
  ok('hashchange parses to the right view function — show + tab, folder, drill-ins',
     JSON.stringify(RTR.routeParse('#/shows/13/schedule')) === JSON.stringify({ view: 'show', arg: 13, tab: 'schedule' }) &&
     JSON.stringify(RTR.routeParse('#/folders/4')) === JSON.stringify({ view: 'folder', arg: 4 }) &&
     JSON.stringify(RTR.routeParse('#/jobs/2')) === JSON.stringify({ view: 'job', arg: 2 }) &&
     JSON.stringify(RTR.routeParse('#/viewer/9')) === JSON.stringify({ view: 'viewer', arg: 9 }));
  ok('the two legacy link shapes keep opening — mail bodies (/#show/41 · /#folder/7) and the spec tools (/#/shows/13)',
     RTR.routeParse('#show/41')?.view === 'show' && RTR.routeParse('#show/41')?.arg === 41 &&
     RTR.routeParse('#folder/7')?.view === 'folder' &&
     RTR.routeParse('#/shows/13')?.view === 'show');
  ok('an unknown hash parses to NULL (the dashboard+toast branch), never a guess',
     RTR.routeParse('#/nonsense') === null && RTR.routeParse('#/shows/abc') === null &&
     RTR.routeParse('#/shows/13/bogus') === null && RTR.routeParse('#/shows//3') === null &&
     RTR.routeParse('#/settings/9') === null);
  ok('a hostile hash cannot crash the parser — it reads as unknown, never throws',
     (() => { try { return RTR.routeParse({}) === null &&
                           RTR.routeParse('#/\u0000/\u0000') === null &&
                           RTR.routeParse(undefined)?.view === null; }
              catch { return false; } })());
  ok('the empty hash is the role landing, not an error',
     RTR.routeParse('')?.view === null && RTR.routeParse('#')?.view === null &&
     RTR.routeParse('#/')?.view === null);

  // ── the core, driven the way the browser drives it ────────────────────────
  {
    let hash = '';
    const writes = [], navs = [];
    const core = RTR.makeRouterCore({
      read: () => hash,
      write: (h, replace) => { writes.push([h, !!replace]); hash = h; },
      navigate: (route, raw) => navs.push([route, raw])
    });
    // boot deep link: the arrival entry is REUSED, never doubled
    core.routeBegin('#/finance'); core.sync('finance');
    ok('a boot deep link REPLACES the arrival entry — landing never doubles history',
       writes.length === 1 && writes[0][0] === '#/finance' && writes[0][1] === true,
       writes);
    // a user click: exactly ONE history write, and the echo NEVER re-navigates
    writes.length = 0;
    core.sync('show', 13);
    const echoRouted = core.onHashChange('#/shows/13');   // the browser echoing our own write
    ok('THE ECHO GUARD, executed — one navigation = exactly ONE history write, and the hashchange echo routes NOTHING',
       writes.length === 1 && writes[0][1] === false &&
       echoRouted === false && navs.length === 0,
       { writes, echoRouted, navs: navs.length });
    // a tab flick: rides the hash, REPLACES — Back leaves the screen
    writes.length = 0;
    core.sync('show', 13, 'schedule');
    ok('a tab flick writes the tab onto the hash with REPLACE — history holds screens, not flicks',
       writes.length === 1 && writes[0][0] === '#/shows/13/schedule' && writes[0][1] === true,
       writes);
    // a redundant re-render (filter repaint, feed "more"): ZERO writes
    writes.length = 0;
    core.sync('show', 13, 'schedule');
    ok('a redundant re-render writes NOTHING — duplicates never fill history',
       writes.length === 0, writes);
    // Back: a hash we did not write routes through navigate()
    core.onHashChange('#/finance');
    ok('Back/Forward (a hash we did not write) routes through the render path',
       navs.length === 1 && navs[0][0]?.view === 'finance', navs);
    // the viewer pages with REPLACE, like a tab
    core.routeBegin('#/viewer/3'); core.sync('viewer', 3);
    writes.length = 0;
    core.sync('viewer', 9);
    ok('viewer paging replaces too — Back exits the viewer once, not per file',
       writes.length === 1 && writes[0][0] === '#/viewer/9' && writes[0][1] === true, writes);
    // a routed navigation that never lands (deleted show) is DETECTED
    core.routeBegin('#/shows/99');
    ok('a routed navigation that never landed reports itself — the dashboard fallback’s trigger',
       core.routeEnd() === true && core.routeEnd() === false);
  }

  // ── the browser-half wiring, held mechanically over app.js ────────────────
  ok('index.html loads router.js, before app.js',
     /<script src="router\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/.test(
       fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')));
  ok('renderView() ends by recording the screen that LANDED — a failed render cannot leave a lying URL',
     /routeDidRender\(view\);\s*\}/.test(APP_JS));
  ok('the hashchange listener is wired inside routerStart(), window-guarded for headless, boot-gated',
     /function routerStart\(\)[\s\S]{0,200}typeof window === 'undefined'[\s\S]{0,1200}addEventListener\('hashchange'/.test(APP_JS) &&
     /addEventListener\('hashchange', function \(\) \{\s*\n\s*if \(!ROUTER \|\| bootGate\(\)\) return;/.test(APP_JS));
  ok('an unknown hash lands on the dashboard with an HONEST err toast, through landingView()',
     /if \(!route\) \{\s*\n\s*toast\('That link goes nowhere'[\s\S]{0,200}'err'\);\s*\n\s*await render\(landingView\(\)\);/.test(APP_JS));
  ok('a stale route (deleted show) falls back to the dashboard, toasts err, and REPLACES the lying hash',
     /if \(ROUTER\.routeEnd\(\) && !LOGIN\.open\) \{[\s\S]{0,400}'err'\);[\s\S]{0,200}ROUTER\.routeBegin\(rawHash\);[\s\S]{0,200}render\(landingView\(\)\)/.test(APP_JS));
  ok('Back/Forward re-enter through the SAME render paths a click uses — render/openFolder/openViewer/setFolderTab, no parallel renderer',
     /async function routeGo\(route, rawHash\)[\s\S]{0,1600}await openFolder\(route\.arg\)[\s\S]{0,900}await render\('show', route\.arg\)[\s\S]{0,900}setFolderTab\(route\.tab\)[\s\S]{0,600}await openViewer\(route\.arg\)/.test(APP_JS));
  ok('every "just arrived" path routes the hash — boot (both modes), login without a resume, the pw gate',
     [...APP_JS.matchAll(/routeBoot\(\)/g)].length >= 5 &&
     /else await routeBoot\(\);/.test(APP_JS) &&
     /return routeBoot\(\);/.test(APP_JS));
  ok('the tab click carries its key onto the hash (views-folder.js), typeof-guarded for headless',
     /typeof routeTabChanged === 'function'\) routeTabChanged\(show\.id, b\.dataset\.t\)/.test(SRC['views-folder.js']));
  ok('the bind-spec popup never starts the router — bindSpecBoot() exits BEFORE routerStart()',
     APP_JS.indexOf('return bindSpecBoot()') > 0 &&
     APP_JS.indexOf('return bindSpecBoot()') < APP_JS.indexOf('routerStart();') &&
     !/routerStart/.test(SRC['bind.js']));
  ok('the router sits UNDER the actions — no ACTIONS entry writes location.hash, only routerStart’s io does',
     [...APP_JS.matchAll(/location\.hash = /g)].length === 1 &&
     /write: function \(h, replace\)[\s\S]{0,400}location\.hash = h;/.test(APP_JS));
  ok('SCHEMA.md carries the frontend route table',
     /### Frontend routes \(the hash\)/.test(fs.readFileSync(path.join(APP, 'SCHEMA.md'), 'utf8')));

  // ══════════════════════════════════════════════════════════════════════════
  section('51 · unattended transcripts — the human door, and the dark card  (Tony Tran, 9/18)');
  // ══════════════════════════════════════════════════════════════════════════
  // E360's IT admin granted tenant API access for Teams transcripts and
  // approved UNATTENDED app-only pulls on one condition: "keep an audit log if
  // we could." Two things belong in a persona walk rather than in the smoke
  // suite, and this is them.
  //
  // FIRST, THE MANUAL-DOOR LAW (Tom, 9/16, standing): "there shouldnt be
  // anything that cant also be done manually." A reader that only a clock can
  // start is one nobody can demonstrate to the admin who granted it, test on
  // wiring day, or rescue at 4pm on a show day. So the GRAPH_SWEEP_MINUTES
  // timer's human twin is walked here the way §48 walks the digest drain: the
  // REAL public/api.js seam the button fires, executed against the real server.
  //
  // SECOND, THE DARK CARD. The feature ships with no credentials, and a card
  // that renders an empty table in that state teaches the wrong thing —
  // "nothing has happened" and "nothing is configured" are different answers.
  {
    reach('Sweep now — the timer\'s human twin (the manual-door law)',
      { seam: ['runTranscriptSweep', 'graphAudit'], action: 'transcriptSweepNow' });

    tab.SR.setToken(T.tom);                                  // admin, like the card
    const wgAudit = await tab.api.graphAudit({ limit: 5 })
      .then((r) => r, (e) => ({ error: String(e) }));
    ok('the REAL api.graphAudit() executes as admin — the audit log READS while dark, which is ' +
       'the whole point of an audit you can check after the fact',
       wgAudit && !wgAudit.error && Array.isArray(wgAudit.rows) && wgAudit.total === 0 &&
       wgAudit.config && wgAudit.config.configured === false, wgAudit);
    ok('…and it names WHICH variables are missing, so the card can say "not configured" instead ' +
       'of rendering an empty table that looks like "nothing happened"',
       (wgAudit.config.missing || []).length === 3, wgAudit.config);
    const wgSweep = await tab.api.runTranscriptSweep()
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, msg: String(e && e.message || e) }));
    ok('the REAL api.runTranscriptSweep() — the button\'s exact call — is REFUSED while dark, ' +
       'naming the three variables. Never a hollow green over a sweep that never happened',
       wgSweep.ok === false && /GRAPH_TENANT_ID/.test(wgSweep.msg) &&
       /GRAPH_CLIENT_SECRET/.test(wgSweep.msg), wgSweep);
    const wgHealth = await GET('/api/health');
    ok('…and /api/health\'s `graph` block agrees, in the house\'s config-presence wording',
       wgHealth.body.graph && wgHealth.body.graph.configured === false &&
       /NOT a login test/.test(wgHealth.body.graph.configuredMeans) &&
       wgHealth.body.graph.stale === false, wgHealth.body.graph);

    const vg51 = SRC['views-global.js'];
    ok('the Settings card is admin-gated like the two endpoints it drives',
       /role === 'admin' \? card\('lock', 'Unattended access — audit log'/.test(vg51));
    ok('…it carries TRAN\'S CONDITION on its face, not buried in a commit message',
       /keep an audit log if we could/.test(vg51) && /2026-09-18/.test(vg51));
    ok('…it says transcripts are INTERNAL, so nobody has to guess whether a meeting can reach a client',
       /client-recap firewall can never read one/.test(vg51));
    ok('…the Sweep-now button is DISABLED while dark and its tooltip names what to set — the ' +
       'house rule: grey out a button instead of offering a 501',
       /g\.configured \? '' : ' disabled'/.test(vg51) &&
       /The manual door is wired, but there is nothing to read/.test(vg51));
    ok('…and the demo twin answers a MODELED ledger that says so, rather than a fictional tenant',
       /modeled — demo ledger, no tenant was read/.test(vg51) &&
       /demo: true[\s\S]{0,900}sw-modeled/.test(API_JS));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('52 · MEETINGS on a season — and the markdown that arrives with them');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom, 2026-09-21: "we should definitely add a meeting summary feature to
  // projects... we can add these summaries."
  //
  // A meeting summary is the first thing this app renders that is neither a
  // field somebody typed into a labelled box nor a number it computed itself.
  // It is a PASTE — an entire document, arriving out of a chat window, written
  // by a person or by a model, in markdown. That is the whole reason this
  // section is in the persona walk rather than only in the smoke suite: the
  // smoke suite can prove the row stores and the gates hold, but only a render
  // can prove that what comes back out is TEXT and not MARKUP.
  //
  // components.js mdHTML() escapes the whole source FIRST and transforms
  // second, and this section walks a deliberately hostile digest through it:
  // a script tag, an onerror image, a quote that tries to close an attribute,
  // and — the one that matters in THIS app — a `data-act` that would become a
  // live button on the single delegated listener in app.js if it ever reached
  // the DOM as markup. Mutation target, named on the assertion: drop the esc()
  // from the first line of mdHTML and the inert-render lines go red.
  {
    reach('Add meeting (season dashboard)',
      { seam: ['listMeetings', 'addMeeting'], action: ['addMeeting', 'mtgCommit'] });
    reach('Read / edit / delete a meeting',
      { seam: ['updateMeeting', 'deleteMeeting'], action: ['openMeeting', 'editMeeting', 'deleteMeeting'] });

    // the season dashboard and the two panels beside it, so viewSeason renders
    // whole rather than as a fragment nobody would recognise
    for (const f of ['views-dashboard.js', 'views-finance.js', 'views-purchasing.js']) {
      new vm.Script(SRC[f], { filename: 'public/' + f }).runInContext(demoTab);
    }

    // ── the demo fixture ───────────────────────────────────────────────────
    const wmProj = await demoTab.api.getProject(3);           // the LOVB season
    const wmSeeded = await demoTab.api.listMeetings(3);
    ok('DEMO · the LOVB season carries modeled meetings from file://',
       wmSeeded.length >= 2 && wmSeeded.every((m) => m.title && m.summary_md), wmSeeded.length);
    ok('…newest first, which is the order the route\'s SQL produces too',
       wmSeeded[0].held_at >= wmSeeded[1].held_at, wmSeeded.map((m) => m.held_at));
    ok('…and one of them is linked to the transcript the unattended reader would have filed',
       wmSeeded.some((m) => m.transcript_file_id &&
         demoTab.FILES_BY_ID[m.transcript_file_id] &&
         demoTab.FILES_BY_ID[m.transcript_file_id].kind === 'transcript'),
       wmSeeded.map((m) => m.transcript_file_id));

    // ── the section, rendered inside the real season dashboard ─────────────
    const wmHtml = demoTab.viewSeason(wmProj);
    // THE ROLL-UP STAYS THE WHOLE SEASON. Two of the three seeded calls are
    // pinned to a show (Madison, Salt Lake) and one is season-wide; all three
    // render here, which is the point of the folder list. §52b proves the
    // other half — that each SHOW's tab carries only its own.
    ok('DEMO RENDER · the season dashboard grows a Meetings section, and it is the WHOLE ' +
       'season — the venue-specific calls stay in the roll-up beside the season-wide one',
       />Meetings · 3/.test(wmHtml) && wmSeeded.length === 3,
       [wmSeeded.length, wmHtml.indexOf('Meetings')]);
    ok('…with the Add meeting door on it (the manual door, shipped first)',
       /data-act="addMeeting" data-id="3"/.test(wmHtml));
    ok('…a row per meeting, each openable, each wearing its title, its day and who was on it',
       wmSeeded.every((m) => wmHtml.indexOf('data-act="openMeeting" data-id="' + m.id + '"') >= 0) &&
       wmHtml.indexOf(demoTab.esc('Tom Andres, Tony Vigon, Jim Eaton')) >= 0);
    ok('…a one-line PREVIEW of the digest with the markdown furniture stripped off it — not ' +
       '"# LOVB / MLV" with the hash still on the front',
       /class="mtg-prev"/.test(wmHtml) && !/mtg-prev">#/.test(wmHtml));
    ok('…Edit and Delete on every row, for somebody who could file one',
       wmSeeded.every((m) => wmHtml.indexOf('data-act="editMeeting" data-id="' + m.id + '"') >= 0 &&
         wmHtml.indexOf('data-act="deleteMeeting" data-id="' + m.id + '"') >= 0));
    ok('…and it says plainly that a digest is INTERNAL, so nobody has to guess whether a ' +
       'meeting can reach a client',
       /client-recap generator can never read one/.test(wmHtml));
    ok('the panel really is wired into viewSeason, not merely defined beside it',
       /meetingsPanel\(project\)/.test(SRC['views-dashboard.js']));

    // the same render as somebody who may READ but not write. The demo has no
    // login, so the gate's input is swapped directly — CURRENT_USER is what
    // canEditFolder() reads.
    const wmWas = demoTab.CURRENT_USER;
    demoTab.CURRENT_USER = demoTab.ROSTER.dvargas;            // Devin, role 'tech'
    const wmTechHtml = demoTab.viewSeason(wmProj);
    ok('DEMO RENDER · a TECH still sees the meetings — reads are open, which is the point of ' +
       'filing them where a person who missed the call can find them',
       wmSeeded.every((m) => wmTechHtml.indexOf('data-act="openMeeting" data-id="' + m.id + '"') >= 0));
    ok('…and is offered no Add, no Edit and no Delete, matching the pm+ floor on the routes',
       !/data-act="addMeeting"/.test(wmTechHtml) && !/data-act="editMeeting"/.test(wmTechHtml) &&
       !/data-act="deleteMeeting"/.test(wmTechHtml));
    demoTab.CURRENT_USER = wmWas;

    // ── the dialog the person actually fills in ────────────────────────────
    const wmDlg = APP_JS.slice(APP_JS.indexOf('async function openMeeting('),
      APP_JS.indexOf('async function meetingDeleteAct'));
    ok('the Add-meeting dialog asks for a title, a date, a time, attendees and the summary',
       ['mtTitle', 'mtDate', 'mtTime', 'mtWho', 'mtSummary'].every((k) => wmDlg.indexOf('id="' + k + '"') >= 0));
    ok('…the summary is a big TEXTAREA, because the workflow is paste — not a one-line input',
       /<textarea id="mtSummary"[^>]*rows="1\d"/.test(wmDlg));
    ok('…with an optional show picker and an optional link to an existing transcript',
       /id="mtShow"/.test(wmDlg) && /id="mtFile"/.test(wmDlg) &&
       /the whole season/.test(wmDlg) && /not linked to a document/.test(wmDlg));
    ok('…and the commit sends every one of those fields — a form that collects less than it ' +
       'claims to is the 8/31 lesson',
       ['title', 'held_at', 'held_time', 'attendees', 'summary_md', 'show_id', 'transcript_file_id']
         .every((k) => wmDlg.indexOf(k) >= 0 ||
           APP_JS.slice(APP_JS.indexOf('async function mtgCommit'),
             APP_JS.indexOf('async function meetingDeleteAct')).indexOf(k) >= 0));

    // ── THE MARKDOWN RENDERER, on its own ──────────────────────────────────
    const wmDoc = [
      '# Heading one', '## Heading two', '### Heading three', '',
      'A paragraph with **bold** and `code` in it.', '',
      '- first bullet', '- second bullet', '',
      '1. first numbered', '2. second numbered', '',
      '> a quoted receipt', '', '---', '', 'A closing line.'
    ].join('\n');
    const wmOut = demoTab.mdHTML(wmDoc);
    ok('mdHTML renders the shapes a digest is actually made of',
       /<h3 class="md-h1">Heading one<\/h3>/.test(wmOut) &&
       /<h4 class="md-h2">Heading two<\/h4>/.test(wmOut) &&
       /<h5 class="md-h3">Heading three<\/h5>/.test(wmOut) &&
       /<b>bold<\/b>/.test(wmOut) && /<code>code<\/code>/.test(wmOut) &&
       /<ul><li>first bullet<\/li><li>second bullet<\/li><\/ul>/.test(wmOut) &&
       /<ol><li>first numbered<\/li><li>second numbered<\/li><\/ol>/.test(wmOut) &&
       /<blockquote>a quoted receipt<\/blockquote>/.test(wmOut) && /<hr>/.test(wmOut), wmOut.slice(0, 200));
    ok('…and the blockquote rule matches `&gt;`, not `>` — which is the PROOF that esc() ran ' +
       'before the parse rather than after it',
       /&gt;/.test(SRC['components.js'].slice(SRC['components.js'].indexOf('function mdHTML'),
         SRC['components.js'].indexOf('function mdPreview'))));
    ok('…there is NO link syntax, deliberately — a [text](url) rule is an href a caller gets to fill',
       demoTab.mdHTML('[click me](javascript:alert(1))').indexOf('href') < 0 &&
       demoTab.mdHTML('[click me](javascript:alert(1))').indexOf('click me') >= 0);
    ok('…an empty summary renders nothing at all, rather than an empty document shell',
       demoTab.mdHTML('') === '' && demoTab.mdHTML(null) === '' && demoTab.mdHTML('   ') === '');

    // ── HOSTILE INPUT — the assertion this section exists for ──────────────
    const wmNasty = [
      '# <script>alert("pwned")</script>',
      '',
      '<img src=x onerror="alert(1)">',
      '',
      '- <b onclick="alert(2)">click me</b>',
      '- <div data-act="deleteFolder" data-id="3">delete the season</div>',
      '',
      '> he said "<iframe src=//evil.example></iframe>" and meant it',
      '',
      'closing " > \' & < tag'
    ].join('\n');
    const wmEvil = await demoTab.api.addMeeting(3, {
      title: '<script>alert("title")</script>', held_at: '2026-09-19',
      attendees: '<img src=x onerror=alert(3)>', summary_md: wmNasty });
    ok('a hostile digest is STORED verbatim — sanitising on the way in would silently corrupt a ' +
       'digest that legitimately quotes markup',
       wmEvil.summary_md === wmNasty, (wmEvil.summary_md || '').slice(0, 40));
    // The assertion has to look at TAGS, not at substrings. "onerror" and
    // "data-act=" both appear in correct output — as ESCAPED TEXT, which is
    // exactly what the reader is supposed to see. What must never appear is
    // either of them inside a real `<…>`. So: pull every tag out of the
    // rendered HTML and check what they are.
    const tagsIn = (html) => html.match(/<[^>]*>/g) || [];
    // the complete set mdHTML() emits — it has no other branch
    const MD_TAGS = new Set(['<div class="md">', '</div>', '<p>', '</p>',
      '<h3 class="md-h1">', '</h3>', '<h4 class="md-h2">', '</h4>',
      '<h5 class="md-h3">', '</h5>', '<ul>', '</ul>', '<ol>', '</ol>',
      '<li>', '</li>', '<b>', '</b>', '<code>', '</code>',
      '<blockquote>', '</blockquote>', '<hr>', '<br>']);
    const wmEvilHtml = demoTab.mdHTML(wmEvil.summary_md);
    const wmStray = tagsIn(wmEvilHtml).filter((t) => !MD_TAGS.has(t));
    ok('THE HOSTILE DIGEST RENDERS INERT — EVERY tag in the output is one mdHTML emitted itself, ' +
       'so nothing out of the paste became markup (drop the esc() from its first line and the ' +
       'script tag, the img and the iframe all appear here and this goes red)',
       wmStray.length === 0, wmStray.slice(0, 6));
    ok('…every one of them is ESCAPED TEXT instead, so the reader still sees what was pasted',
       /&lt;script&gt;/.test(wmEvilHtml) && /&lt;img src=x onerror=/.test(wmEvilHtml) &&
       /&lt;iframe/.test(wmEvilHtml));
    ok('…no tag carries a data-act or an inline handler — in this app that is not cosmetic: one ' +
       'delegated listener turns any data-act in the DOM into a live button',
       !tagsIn(wmEvilHtml).some((t) => /data-act\s*=/.test(t) || /\son\w+\s*=/i.test(t)) &&
       /&lt;div data-act=&quot;deleteFolder&quot;/.test(wmEvilHtml),
       tagsIn(wmEvilHtml).filter((t) => /data-act\s*=|\son\w+\s*=/i.test(t)));
    ok('…the markdown rules still ran ON the escaped text — a heading is still a heading, a ' +
       'bullet still a bullet, a quote still a quote',
       /<h3 class="md-h1">&lt;script&gt;/.test(wmEvilHtml) && /<li>&lt;b onclick=/.test(wmEvilHtml) &&
       /<blockquote>he said/.test(wmEvilHtml));

    // the same question of the two surfaces that carry a digest. These render
    // plenty of legitimate tags (icons, the row's own data-act), so the test is
    // "no tag that could execute", not "no unknown tag".
    const dangerous = (html) => tagsIn(html).filter((t) =>
      /^<\/?(?:script|img|iframe|object|embed|style|link|form|input)\b/i.test(t) ||
      /\son\w+\s*=/i.test(t));
    const wmEvilRow = demoTab.viewSeason(await demoTab.api.getProject(3));
    ok('…and the LIST row is inert too — the hostile title and attendees go through esc() like ' +
       'every other interpolated value in this app',
       dangerous(wmEvilRow).length === 0 &&
       /&lt;script&gt;alert\(&quot;title&quot;\)/.test(wmEvilRow) &&
       /&lt;img src=x onerror=alert\(3\)&gt;/.test(wmEvilRow), dangerous(wmEvilRow).slice(0, 6));
    const wmDetail = demoTab.meetingDetailHTML(wmEvil);
    ok('…as is the full digest as it opens in the reader',
       dangerous(wmDetail).length === 0 &&
       !tagsIn(wmDetail).some((t) => /data-act\s*=/.test(t)), dangerous(wmDetail).slice(0, 6));

    // ── the demo twins refuse what the routes refuse ───────────────────────
    const wmNoTitle = await demoTab.api.addMeeting(3, { title: '   ' })
      .then(() => null, (e) => String(e.message));
    ok('DEMO TWIN · a meeting with no title is refused in the SERVER\'S words',
       !!wmNoTitle && /needs a title/.test(wmNoTitle), wmNoTitle);
    const wmBadDate = await demoTab.api.addMeeting(3, { title: 'x', held_at: '19/09/2026' })
      .then(() => null, (e) => String(e.message));
    ok('…a date that is not ISO is refused, naming the field',
       !!wmBadDate && /held_at must be an ISO date/.test(wmBadDate), wmBadDate);
    const wmXShow = await demoTab.api.addMeeting(3, { title: 'x', show_id: 1 })
      .then(() => null, (e) => String(e.message));
    ok('…and a show from another folder is refused — the demo teaches the walls, not just the ' +
       'happy path',
       !!wmXShow && /belongs to another folder/.test(wmXShow), wmXShow);

    // ── edit, the file-delete rule, and delete ─────────────────────────────
    const wmEdited = await demoTab.api.updateMeeting(wmEvil.id, { title: 'WALK52 cleaned up' });
    ok('DEMO TWIN · a meeting edits in place', wmEdited.title === 'WALK52 cleaned up', wmEdited.title);
    const wmLinked = (await demoTab.api.listMeetings(3)).filter((m) => m.transcript_file_id)[0];
    const wmFileId = wmLinked.transcript_file_id;
    await demoTab.api.deleteFile(wmFileId);
    ok('DEMO TWIN · deleting the transcript NULLS the link and LEAVES the digest — the same rule ' +
       'routes/files.js holds, mirrored',
       wmLinked.transcript_file_id === null && wmLinked.summary_md.length > 0,
       { link: wmLinked.transcript_file_id, chars: wmLinked.summary_md.length });
    const wmBefore = (await demoTab.api.listMeetings(3)).length;
    await demoTab.api.deleteMeeting(wmEvil.id);
    ok('DEMO TWIN · a meeting deletes, and only that one',
       (await demoTab.api.listMeetings(3)).length === wmBefore - 1);
    const wmGone = await demoTab.api.deleteMeeting(wmEvil.id).then(() => null, (e) => String(e.message));
    ok('…and deleting it again is an honest "not found", never a hollow {ok:true}',
       !!wmGone && /not found/.test(wmGone), wmGone);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('52b · a venue-specific call belongs to the VENUE  (Tom, 9/21, live)');
  // ══════════════════════════════════════════════════════════════════════════
  // Tom, 2026-09-21, verbatim: "That was a Salt Lake–specific meeting, and it's
  // filed under the whole season. We'll have like 9 more of those. Shouldn't it
  // be attached to Salt Lake specifically?"
  //
  // `meetings.show_id` was right from the first commit and NOTHING READ IT. A
  // call pinned to a venue rendered in exactly one place — the folder's roll-up
  // — wearing a chip. With one such call that is a chip; with the ten this
  // season will produce it is a pile, and the show it was about is the last
  // place you can find it.
  //
  // The whole of this section is one question asked two ways: does each show's
  // tab carry ITS OWN calls and NOT ITS SIBLINGS'? Two shows, two pinned
  // meetings, one season-wide meeting, and every assertion below is written so
  // that swapping meetingsForShow(show.id) for meetingsForProject() — the
  // obvious "simplification" — turns it red rather than leaving it green.
  {
    reach('Add a meeting from the SHOW page, pinned to that show',
      { seam: ['listMeetings', 'addMeeting'], action: ['addMeeting', 'mtgCommit'] });
    reach('Jump from a roll-up row\'s show chip to that show\'s meetings',
      { seam: ['getShow'], action: ['showMeetings'] });

    // the three seeded calls, sorted into what each surface owes
    const mbAll = await demoTab.api.listMeetings(3);
    const mbMad = mbAll.filter((m) => m.show_id === 3);       // LOVB Madison — Match 1
    const mbSlc = mbAll.filter((m) => m.show_id === 6);       // LOVB Salt Lake — Match 4
    const mbSeason = mbAll.filter((m) => !m.show_id);
    ok('DEMO · the LOVB season carries calls pinned to TWO DIFFERENT shows, plus a season-wide ' +
       'one — which is the only fixture that can tell a real filter from a missing one',
       mbMad.length === 1 && mbSlc.length === 1 && mbSeason.length === 1,
       { madison: mbMad.length, saltLake: mbSlc.length, season: mbSeason.length });
    ok('…and the Salt Lake one is the call Tom was actually looking at',
       /Salt Lake/.test(mbSlc[0].title) && mbSlc[0].summary_md.length > 0, mbSlc[0].title);

    const showMad = await demoTab.api.getShow(3);
    const showSlc = await demoTab.api.getShow(6);
    const showAtl = await demoTab.api.getShow(4);             // LOVB Atlanta — nothing pinned

    // ── THE ASSERTION THIS SECTION EXISTS FOR ─────────────────────────────
    const tabMad = demoTab.tabMeetings(showMad);
    const tabSlc = demoTab.tabMeetings(showSlc);
    ok('SHOW TAB · Salt Lake\'s Meetings tab carries Salt Lake\'s call',
       tabSlc.indexOf('data-act="openMeeting" data-id="' + mbSlc[0].id + '"') >= 0 &&
       tabSlc.indexOf(demoTab.esc(mbSlc[0].title)) >= 0, mbSlc[0].id);
    ok('SHOW TAB · …and Madison\'s carries Madison\'s',
       tabMad.indexOf('data-act="openMeeting" data-id="' + mbMad[0].id + '"') >= 0 &&
       tabMad.indexOf(demoTab.esc(mbMad[0].title)) >= 0, mbMad[0].id);
    ok('SHOW TAB · NEITHER TAB CARRIES THE OTHER\'S — a season with ten team-specific calls on ' +
       'it is only navigable if the filter is real (swap meetingsForShow(show.id) for ' +
       'meetingsForProject(show.project_id) in tabMeetings and this goes red)',
       tabSlc.indexOf('data-act="openMeeting" data-id="' + mbMad[0].id + '"') < 0 &&
       tabMad.indexOf('data-act="openMeeting" data-id="' + mbSlc[0].id + '"') < 0,
       { slcHasMad: tabSlc.indexOf('data-id="' + mbMad[0].id + '"'),
         madHasSlc: tabMad.indexOf('data-id="' + mbSlc[0].id + '"') });
    ok('SHOW TAB · …and neither carries the SEASON-WIDE call either — that one is about the ' +
       'whole folder and belongs on the folder, which is the distinction Tom drew',
       tabSlc.indexOf('data-act="openMeeting" data-id="' + mbSeason[0].id + '"') < 0 &&
       tabMad.indexOf('data-act="openMeeting" data-id="' + mbSeason[0].id + '"') < 0 &&
       />Meetings · 1</.test(tabSlc) && />Meetings · 1</.test(tabMad));
    ok('SHOW TAB · the row is components.js meetingRow() — the SAME one the roll-up draws, not ' +
       'a second copy that has to be kept in step',
       /function meetingRow\(/.test(SRC['components.js']) &&
       !/function meetingRow\(/.test(SRC['views-folder.js']) &&
       !/function meetingRow\(/.test(SRC['views-dashboard.js']) &&
       /meetingRow\(m, editable, show\.id\)/.test(SRC['views-folder.js']) &&
       /meetingRow\(m, canEdit\)/.test(SRC['views-dashboard.js']));
    ok('SHOW TAB · …opening one opens the SAME reader, with the digest rendered as a document — ' +
       'headings, bold action leads, bullets and the quoted receipt under the decision',
       /class="mtg-body"/.test(demoTab.meetingDetailHTML(mbSlc[0])) &&
       /<h4 class="md-h2">Where the leg stands<\/h4>/.test(demoTab.meetingDetailHTML(mbSlc[0])) &&
       /<b>Accounting — the job is still on <code>TEMP-26-014<\/code>\.<\/b>/
         .test(demoTab.meetingDetailHTML(mbSlc[0])) &&
       /<blockquote>Tom: &quot;The work does not wait on the number/
         .test(demoTab.meetingDetailHTML(mbSlc[0])));
    ok('SHOW TAB · …and the row\'s one-line preview says something the title does not, with the ' +
       'markdown furniture stripped off it',
       /<span class="mtg-prev">Where the leg stands<\/span>/.test(tabSlc), tabSlc.indexOf('mtg-prev'));
    ok('SHOW TAB · …and the show chip is DROPPED on the show\'s own tab — it would print the ' +
       'name of the page you are standing on',
       tabSlc.indexOf('mtg-chip') < 0 && tabMad.indexOf('mtg-chip') < 0);

    // ── the tab itself, on the real show header ───────────────────────────
    const hdrSlc = demoTab.viewShow(showSlc);
    const hdrAtl = demoTab.viewShow(showAtl);
    ok('SHOW HEADER · the tab strip grows a Meetings tab, badged with THIS show\'s count',
       /<button data-t="meetings">Meetings <span class="n">1<\/span><\/button>/.test(hdrSlc), 'slc');
    ok('SHOW HEADER · …and it renders with no rows too, because the Add door lives inside it — ' +
       'the P3 rule: a tab that hides until its first row hides the only way to make one',
       /<button data-t="meetings">Meetings<\/button>/.test(hdrAtl) &&
       !/Meetings <span class="n">/.test(hdrAtl));
    ok('SHOW HEADER · the tab is wired into drawShowTab and into the router\'s tab whitelist, so ' +
       'a refresh and a copied link both come back to it',
       /t === 'meetings' \? tabMeetings\(show\)/.test(SRC['views-folder.js']) &&
       /meetings: 1/.test(SRC['router.js']));

    // ── THE EMPTY STATE, and the way out of it ────────────────────────────
    const tabAtl = demoTab.tabMeetings(showAtl);
    ok('EMPTY · a show with nothing pinned says so plainly, and says where the season\'s ' +
       'meetings actually are — one sentence read down the page, said once',
       /No meetings pinned to this show/.test(tabAtl) &&
       /The season’s meetings live on the <b>folder dashboard<\/b>/.test(tabAtl) &&
       (tabAtl.match(/No meetings pinned to this show/g) || []).length === 1,
       tabAtl.slice(0, 160));
    ok('EMPTY · …and that is a WORKING LINK to the folder dashboard, not a sentence about one',
       tabAtl.indexOf('data-act="openFolder" data-id="' + showAtl.project_id + '"') >= 0);
    ok('EMPTY · …with the Add door on it as well, so the empty state is where the first ' +
       'pinned call gets made',
       /data-act="addMeeting" data-id="3" data-k="4"/.test(tabAtl));

    // ── THE PRE-PINNED ADD DIALOG ─────────────────────────────────────────
    ok('ADD · the door on the show page carries the SHOW in the action\'s k slot — the same way ' +
       'editBooking and roomEdit carry theirs',
       /data-act="addMeeting" data-id="3" data-k="6"/.test(tabSlc));
    ok('ADD · …and ACTIONS hands that k to openMeeting as the show to preselect',
       /addMeeting:\s+function \(t, id, k\) \{ return openMeeting\(id, null, k\); \}/.test(APP_JS));
    // The preselect rule, EXECUTED rather than grepped: the exact source of the
    // dialog's <select> builder, lifted out of app.js and run against the real
    // season's shows.
    //
    // The anchor is asserted FIRST and the extractor falls back to a function
    // that returns nothing. A scan that quietly misses its anchor and takes the
    // rest of the file with it does not fail — it ABORTS, and an aborted walk
    // proves nothing about the three assertions underneath it. (Found the hard
    // way: the first version anchored on the whole `= m ? m.show_id : from;`
    // line, so the very mutation it existed to catch moved the anchor and the
    // run died instead of going red. The anchor now pins only the part no
    // mutation of this rule can move.)
    const mbAnchor = APP_JS.indexOf('var preselect =');
    const mbEnd = APP_JS.indexOf("}).join('');", mbAnchor);
    ok('ADD · the dialog\'s show-picker builder is where this scan expects it — the scan says so ' +
       'out loud, because a scan that misses its anchor silently pins nothing at all',
       mbAnchor > 0 && mbEnd > mbAnchor, [mbAnchor, mbEnd]);
    const mbSel = (mbAnchor > 0 && mbEnd > mbAnchor)
      ? new vm.Script('(function (m, from, project, esc) { ' +
          APP_JS.slice(mbAnchor, mbEnd + "}).join('');".length) + ' return showOpts; })',
          { filename: 'app.js:openMeeting showOpts' }).runInThisContext()
      : function () { return ''; };
    const mbShows = (await demoTab.api.getProject(3)).shows;
    const selectedIn = (html) => {
      const m = /<option value="(\d+)" selected>/.exec(html);
      return m ? Number(m[1]) : null;
    };
    ok('ADD · opened from Salt Lake\'s tab, the dialog opens with SALT LAKE already chosen',
       selectedIn(mbSel(null, 6, { shows: mbShows }, demoTab.esc)) === 6);
    ok('ADD · opened from the season dashboard, it opens on "the whole season" — the answer that ' +
       'is right for most planning calls, and still the default where it always was',
       selectedIn(mbSel(null, null, { shows: mbShows }, demoTab.esc)) === null &&
       /the whole season/.test(mbSel(null, null, { shows: mbShows }, demoTab.esc)));
    ok('ADD · …and EDITING a call shows where it is actually pinned, not where you are standing ' +
       '— opening Madison\'s call from Salt Lake\'s tab must not silently re-home it',
       selectedIn(mbSel({ show_id: 3 }, 6, { shows: mbShows }, demoTab.esc)) === 3);
    ok('ADD · the picker stays a SELECT, so a mis-pinned call can be moved — including back to ' +
       'the whole season',
       /id="mtShow"/.test(APP_JS) && /— the whole season —/.test(APP_JS));
    ok('ADD · and the commit comes back to the tab it was opened from rather than dumping the ' +
       'person on the season dashboard they were deliberately not looking at — with the tab\'s ' +
       'COUNT repainted, because refreshShowTab redraws the body only and a badge still reading ' +
       '"none" after you just filed one is a lie on the one number this surface exists to show',
       (APP_JS.match(/if \(!from\) return render\('folder', projectId\);/g) || []).length === 2 &&
       (APP_JS.match(/refreshMeetingsTabBadge\(fresh[MD]\);/g) || []).length === 2 &&
       /function refreshMeetingsTabBadge\(show\)/.test(SRC['views-folder.js']));
    ok('ADD · the show view WARMS the folder\'s meetings, so the tab and its badge have something ' +
       'to read — a surface that renders empty because nothing fetched is the worst kind of empty',
       /await api\.listMeetings\(show\.project_id\);/.test(APP_JS));

    // ── reads stay open; writes keep the pm+ floor, on BOTH surfaces ───────
    const mbWas = demoTab.CURRENT_USER;
    demoTab.CURRENT_USER = demoTab.ROSTER.dvargas;            // Devin, role 'tech'
    const tabSlcTech = demoTab.tabMeetings(await demoTab.api.getShow(6));
    ok('GATE · a TECH opens the show\'s Meetings tab and reads the call — which is the whole ' +
       'reason a digest gets filed where the venue is',
       tabSlcTech.indexOf('data-act="openMeeting" data-id="' + mbSlc[0].id + '"') >= 0);
    ok('GATE · …and is offered no Add, no Edit and no Delete here either, matching the pm+ floor ' +
       'on the routes',
       !/data-act="addMeeting"/.test(tabSlcTech) && !/data-act="editMeeting"/.test(tabSlcTech) &&
       !/data-act="deleteMeeting"/.test(tabSlcTech));
    const tabAtlTech = demoTab.tabMeetings(await demoTab.api.getShow(4));
    ok('GATE · …and the empty state still hands a tech the way to the season\'s list, because ' +
       'reading is not the thing being gated',
       tabAtlTech.indexOf('data-act="openFolder" data-id="3"') >= 0 &&
       !/data-act="addMeeting"/.test(tabAtlTech));
    demoTab.CURRENT_USER = mbWas;

    // ── the roll-up's chip is the way IN to all of this ───────────────────
    const mbSeasonHtml = demoTab.viewSeason(await demoTab.api.getProject(3));
    ok('ROLL-UP · a pinned row\'s show chip is a control, not a label — it opens that show\'s ' +
       'Meetings tab',
       mbSeasonHtml.indexOf('data-act="showMeetings" data-id="6"') >= 0 &&
       mbSeasonHtml.indexOf('data-act="showMeetings" data-id="3"') >= 0);
    ok('ROLL-UP · …and the season-wide call wears no chip at all, because it is about no one venue',
       (mbSeasonHtml.match(/mtg-chip/g) || []).length === 2);
    ok('ROLL-UP · the jump is openShow + setFolderTab, the same two-step the viewer uses to land ' +
       'on the photos tab — never a parallel navigation path',
       /async function openShowMeetings\(showId\) \{[\s\S]{0,120}await openShow\(showId\);[\s\S]{0,80}setFolderTab\('meetings'\)/.test(APP_JS));

    // ── the single-show folder: the roll-up it is told about must EXIST ───
    // openFolder() collapses a one-show folder straight into the show view, so
    // viewSeason never renders for it. Pointing somebody there would be a dead
    // link dressed as a way out — so that branch lists the FOLDER's meetings
    // and offers no season link at all.
    const mbOne = await demoTab.api.createEvent({
      name: 'WALK52b single-show folder', type: 'led', venue: 'Demo Hall', event_date: plus(45) });
    const mbOneShow = await demoTab.api.getShow(mbOne.show.id);
    ok('SINGLE · a one-show folder really does collapse — viewSeason is unreachable for it',
       mbOneShow.project.single === true, mbOneShow.project.single);
    await demoTab.api.addMeeting(mbOneShow.project_id,
      { title: 'WALK52b kickoff on a one-off', held_at: plus(-1), summary_md: 'Decided things.' });
    const tabOne = demoTab.tabMeetings(await demoTab.api.getShow(mbOne.show.id));
    ok('SINGLE · so its Meetings tab lists the FOLDER\'S calls — the show and the season are the ' +
       'same thing here, and this is the only surface either of them has',
       /WALK52b kickoff on a one-off/.test(tabOne) && />Meetings · 1</.test(tabOne));
    ok('SINGLE · …and offers NO "the season\'s meetings live on the folder dashboard" link, ' +
       'because that link would bounce straight back to this page',
       !/data-act="openFolder"/.test(tabOne) && !/folder dashboard/.test(tabOne));
    ok('SINGLE · …while the Add door is there, which it was not anywhere before this tab: a ' +
       'one-off folder could not file a meeting at all',
       tabOne.indexOf('data-act="addMeeting" data-id="' + mbOneShow.project_id + '" data-k="' +
         mbOneShow.id + '"') >= 0);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('53 · "immediate" means immediate — and the sweep says what it mailed  (Tom, 9/21, live)');
  // ══════════════════════════════════════════════════════════════════════════
  // The first day of REAL email, three faults in one family — all of them the
  // second channel failing to tell the truth:
  //
  //   1. an 'immediate' row waited for a HUMAN to press Sweep. enqueue() wrote
  //      it and only boot / the sweep / the admin endpoint ever moved it.
  //   2. the Sweep toast reported the lifecycle half and hid the mail half, so
  //      a sweep that mailed somebody and a sweep that found an empty queue
  //      read identically: "nothing was due — it is idempotent".
  //   3. GET /api/admin/notification-outbox shipped with F3 and had NO door in
  //      the product, so an admin could not look at anybody else's stuck mail.
  //
  // The server mechanism is proved in the smoke suite (F3 KICK · TX HAZARD ·
  // SAFETY NET, all mutation-gated). What belongs HERE is the workflow and the
  // three client surfaces: a person is @mentioned and the mail goes with
  // NOBODY pressing anything, and the toast and the door say what is true.
  {
    // Polls the outbox rather than sleeping a fixed amount: a red line here
    // must mean "it never happened", never "the machine was busy".
    const waitRow = async (id, done, ms = 15000) => {
      const until = Date.now() + ms;
      for (;;) {
        const r = await pool.query('SELECT * FROM notification_outbox WHERE note_id=$1', [id]);
        const row = r.rows[0] || null;
        if (done(row)) return row;
        if (Date.now() > until) return row;
        await new Promise((res) => setTimeout(res, 100));
      }
    };
    const roster53 = await GET('/api/users', { token: A });
    const omar53 = (roster53.body || []).find((u) => u.username === 'omar');
    const addr53 = await PUT(`/api/users/${omar53.id}`,
      { email: 'omar@e360sport.test' }, { token: A });
    ok('omar has an address to deliver to — entered through the roster, like a person would',
       addr53.status === 200 && addr53.body.email === 'omar@e360sport.test', addr53.body);

    const note53 = await POST('/api/notes', {
      anchor_type: 'show', anchor_id: SHOW,
      body: 'Dock B is confirmed for load-in — @omar you are on it.'
    }, { token: T.brenden });
    ok('brenden @mentions omar, and the action answers without waiting on mail',
       note53.status === 200, note53.body);
    const row53 = await waitRow(note53.body.id, (r) => !!r && r.status !== 'queued');
    ok('THE DEFECT, GONE · omar\'s email went out on its own — no sweep, no admin, nobody ' +
       'pressed anything between the @mention and the delivery',
       !!row53 && row53.status === 'sent' && row53.mode === 'immediate' && !!row53.sent_at,
       row53);

    // ── the Sweep toast's mail half, EXECUTED ────────────────────────────────
    // §37's lesson again: the copy is proved by RUNNING the function the button
    // renders, never by reading it. The pure half is lifted straight out of the
    // shipped app.js and driven with real flush shapes.
    const sweepFn = (() => {
      const m = /function sweepMailBit\(n\)\s*\{[\s\S]*?\n\}/.exec(APP_JS);
      if (!m) return null;
      const ctx = {};
      vm.createContext(ctx);
      new vm.Script(m[0], { filename: 'public/app.js#sweepMailBit' }).runInContext(ctx);
      return ctx.sweepMailBit;
    })();
    ok('the sweep toast\'s mail half is a PURE function, and it loads headless',
       typeof sweepFn === 'function');
    ok('…a sweep that MAILED somebody says so, in emails and not in jargon',
       sweepFn({ sent: 1, skipped: 0, queued: 0, failed: 0, configured: true }) === '1 email sent',
       sweepFn && sweepFn({ sent: 1, configured: true }));
    ok('…plural counts, and a row that stayed behind names why',
       sweepFn({ sent: 2, skipped: 0, queued: 1, failed: 0, configured: true }) ===
         '2 emails sent, 1 still queued (error on the row)',
       sweepFn && sweepFn({ sent: 2, queued: 1, configured: true }));
    ok('…an unconfigured driver is NAMED as the reason rather than left to be guessed at',
       /mail not configured/.test(sweepFn({ sent: 0, queued: 3, configured: false })),
       sweepFn && sweepFn({ queued: 3, configured: false }));
    ok('…and an empty queue says EMPTY — the silence is exactly what hid the defect',
       sweepFn({ considered: 0, sent: 0, skipped: 0, queued: 0, failed: 0, configured: true }) ===
         'mail queue empty');
    ok('…a sweep that was asked not to flush says that, instead of claiming empty',
       sweepFn(null) === 'mail queue not flushed');

    // MUTATION GATE: drop `sweepMailBit(r.notifications)` from runSweepAct and
    // this goes red — which is the exact toast Tom read while an email waited.
    const sweepBody = (/async function runSweepAct\(\)[\s\S]*?\n\}/.exec(APP_JS) || [''])[0];
    ok('MUTATION GATE · runSweepAct ALWAYS appends the mail half, beside the lifecycle half ' +
       'it already had',
       /sweepMailBit\(r\.notifications\)/.test(sweepBody) &&
       /idempotent, so that is the normal answer/.test(sweepBody),
       sweepBody.slice(0, 160));
    const sweep53 = await POST('/api/admin/sweep', {}, { token: A });
    ok('…and the server hands it real counts to say — the flush result rides the sweep answer',
       sweep53.status === 200 && !!sweep53.body.notifications &&
       typeof sweep53.body.notifications.sent === 'number' &&
       typeof sweep53.body.notifications.considered === 'number' &&
       typeof sweep53.body.notifications.configured === 'boolean',
       sweep53.body.notifications);

    // ── the admin door onto the whole outbox ────────────────────────────────
    reach('See everyone\'s notification outbox (admin)',
      { seam: 'adminOutbox', action: 'outboxScope' });
    tab.SR.setToken(T.tom);
    const box53 = await tab.api.adminOutbox({}).then((r) => r, (e) => ({ error: String(e) }));
    ok('the REAL api.adminOutbox executes — the toggle\'s exact call, as the admin',
       box53 && !box53.error && Array.isArray(box53.rows) && box53.rows.length >= 1,
       box53 && (box53.error || box53.rows.length));
    ok('…and it carries rows belonging to people OTHER than the admin reading it — which is ' +
       'the whole point of the door',
       box53.rows.some((r) => r.username !== 'tom'),
       box53.rows.slice(0, 4).map((r) => r.username));
    const box53Denied = await (async () => {
      tab.SR.setToken(T.omar);
      const r = await tab.api.adminOutbox({}).then(() => null, (e) => e);
      tab.SR.setToken(T.tom);
      return r;
    })();
    ok('…and a tech is refused by the SERVER, not by the missing button',
       !!box53Denied && box53Denied.status === 403, box53Denied && box53Denied.status);

    // the render, with hostile upstream text in the field that carries it
    const rows53 = [{
      id: 1, username: 'dana', kind: 'mention', mode: 'immediate', status: 'queued',
      subject: 'Dock B is confirmed', body: 'the sentence the mention lived in',
      queued_at: '2026-09-21T10:00:00Z',
      last_error: 'upstream said <img src=x onerror="alert(1)"> & "quoted"'
    }];
    const html53 = demoTab.viewOutbox(rows53,
      { all: true, counts: { queued: 1 }, driver: 'graph', configured: false });
    ok('ADMIN DOOR · the whole-outbox render names the PERSON each row belongs to',
       /<th>Person<\/th>/.test(html53) && /dana/.test(html53));
    ok('ADMIN DOOR · a stuck row shows its last_error — and it is INERT, because upstream ' +
       'mail-server text is escaped like every other value here',
       /&lt;img src=x onerror/.test(html53) && !/<img src=x/.test(html53));
    ok('ADMIN DOOR · an unconfigured driver is flagged on the card rather than guessed at',
       /mail not configured/.test(html53));
    const mine53 = demoTab.viewOutbox(rows53, { all: false });
    ok('…and MINE is untouched — no Person column, and the copy still says yours alone',
       !/<th>Person<\/th>/.test(mine53) && /Yours alone/.test(mine53));
    const vo53 = (/function viewOutbox\(rows, opt\)[\s\S]*?\n\}/.exec(SRC['views-global.js']) || [''])[0];
    ok('ADMIN DOOR · the toggle is drawn for admins only, and the server gate is the real one',
       /CURRENT_USER\.role === 'admin'/.test(vo53) && /act\('outboxScope'/.test(vo53));
  }

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
