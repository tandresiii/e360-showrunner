// ════════════════════════════════════════════════════════════════════════════
// E360 Showrunner — server.js  (entry point)
// Version: 2026.08.27-a
// Last change: the wiring pass. The 1,351-line scaffold is now a spine
//              (lib/*) plus one router per feature family (routes/*), with the
//              agent-facing API of AGENT_API.md implemented end to end.
// ════════════════════════════════════════════════════════════════════════════
//
// Showrunner is the PROJECT-MANAGEMENT app for E360 Sport live-event
// production. It is a SEPARATE service from the staffing/scheduler app
// (e360-staffing3) and talks to it over HTTP ("push to scheduler").
// Conventions deliberately mirror the staffing app so the two feel like family:
//   · Node/Express, PostgreSQL via `pg` Pool on DATABASE_URL, no ORM, no build
//   · ONE additive initDB(): CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF
//     NOT EXISTS. Never DROP. An existing database upgrades in place.
//   · No SQL foreign keys; cascade deletes are manual, in code, in a
//     transaction (lib/db.js).
// Improvements over the staffing app:
//   · Multi-row writes run in real transactions (withTx).
//   · Roles are gated SERVER-SIDE for real.
//   · Sessions are DURABLE (a table, not a Map) and passwords are bcrypt.
//   · An agent surface with server-enforced confidence bands and an
//     append-only route topology.
//
// MODULE MAP
//   lib/enums.js      vocabularies + pure helpers        lib/db.js     pool, initDB, cascades
//   lib/auth.js       bcrypt, sessions, keys, gates      lib/http.js   route plumbing
//   lib/mappers.js    row -> API record                  lib/seed.js   boot seeds + templates.json
//   lib/activity.js   the audit trail                    lib/agent.js  match, bands, idempotency
//   lib/storage.js    the NAS abstraction                lib/firewall.js  the recap content firewall
//   lib/mentions.js   @mention parsing
//   routes/auth  core  files  finance  purchasing  notes  schedule  photos
//   routes/deliverables  proposals  agent
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const APP_VERSION = '2026.08.27-a';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { pool, initDB } = require('./lib/db');
const { seedAll } = require('./lib/seed');
const { apiRateLimit, purgeExpiredSessions } = require('./lib/auth');
const { purgeIdempotency, expireStaleProposals } = require('./lib/agent');
const { STORAGE_ROOT, NAS_ROOT, storage } = require('./lib/storage');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── F. CORS: an env-var origin allowlist, not `*` ───────────────────────────
// CORS_ORIGINS is a comma-separated list. Unset = same-origin only, which is
// the correct posture for a Railway app that serves its own SPA. Set it only
// when a different host genuinely needs to call the API.
const ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // same-origin / curl
    if (ORIGINS.includes('*')) return cb(null, true);
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);                             // no CORS headers -> browser blocks
  },
  credentials: false,
  allowedHeaders: ['Content-Type', 'x-auth-token', 'x-agent-key', 'x-idempotency-key',
                   'x-thumbnailer-token'],
  exposedHeaders: ['x-idempotent-replay', 'Retry-After'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

// ── F. body caps ────────────────────────────────────────────────────────────
// JSON bodies are metadata, never bytes: 1 MB is generous. Raw byte uploads go
// through express.raw() on their own two routes, capped at MAX_UPLOAD_BYTES.
//
// D3 — ONE exception, scoped to ONE route. The spec-bind payload is
// json + svg + pageHtml + png, where the png alone is a base64 data URL of a
// 2×-scaled canvas and the pageHtml inlines every stylesheet the tool uses:
// realistically 2–10 MB. The staffing app allows 20 MB globally for exactly
// this; scoping it here is cleaner, because the 1 MB default keeps protecting
// every other endpoint. body-parser sets req._body, so the global parser below
// sees the body is already read and skips it.
const SPEC_BIND_BODY_LIMIT = process.env.SPEC_BIND_BODY_LIMIT || '25mb';
app.use('/api/shows/:id/spec-bind', express.json({ limit: SPEC_BIND_BODY_LIMIT }));
app.use('/api', express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use('/api', express.urlencoded({ extended: false, limit: '64kb' }));
// A malformed JSON body is a 400, not an unhandled 500.
app.use('/api', (err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  return next(err);
});

// ── F. a generous per-IP ceiling that only a loop can hit ───────────────────
app.use('/api', apiRateLimit);

// ── D4. TOOLS_ORIGINS — who may postMessage a spec bundle into our popup ────
// The three spec tools live on ONE static origin (all four tools share a Caddy
// file-server), so this is effectively one entry plus a localhost entry for dev.
// The staffing app's equivalent handler checks NO origin at all (defect T1) and
// posts its ready message with target '*'; ours checks both directions. The
// value is served to the SPA from here and is NEVER hardcoded in public/.
const TOOLS_ORIGINS = String(process.env.TOOLS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── meta (no auth) ──────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

// D4. The public bootstrap the front end reads before it can trust anything a
// popup receives. PUBLIC and MINIMAL by design: an origin allowlist and a few
// vocabularies the UI would otherwise duplicate. No secrets, no counts, no
// hostnames of internal services — anyone who can load the SPA can read this.
app.get('/api/config', (req, res) => {
  res.json({
    app: 'e360-showrunner',
    version: APP_VERSION,
    // the allowlist the ?bind-spec=1 popup checks e.origin against
    toolsOrigins: TOOLS_ORIGINS,
    specTypes: ['e360', 'nsf', 'pcfg'],
    // T2: the extension comes from a MAP, never a ternary — that is the bug
    // that makes a PowerSpec bind claim it attached a .nsf.
    specExt: { e360: '.e360', nsf: '.nsf', pcfg: '.pcfg' },
    specNode: { e360: 'content', nsf: 'cabling', pcfg: 'power' },
    chainNodes: ['content', 'cabling', 'power', 'pull'],
    specBindBodyLimit: SPEC_BIND_BODY_LIMIT,
    features: {
      // so the UI can grey out a button instead of offering a 501
      schedulerPush: !!process.env.SCHEDULER_BASE_URL,
      flex: !!(process.env.FLEX_BASE_URL && process.env.FLEX_API_KEY),
      // HARDENING 13. With TOOLS_ORIGINS unset the allowlist is empty, so the
      // popup refuses EVERY inbound bundle — correctly, but mutely: the person
      // saw a window that waited 30 seconds and then blamed the tool. This flag
      // lets it say "not configured on this server" the moment it opens, which
      // is a different problem with a different fix (an env var, not a retry).
      // Fail closed, but say so. TOOLS_ORIGINS is REQUIRED in prod — SCHEMA.md.
      specBind: TOOLS_ORIGINS.length > 0,
      // F3. Same argument as specBind above: the Settings card must be able to
      // say "your preference is recorded, but nothing can leave the building
      // yet" instead of implying mail that will never arrive. Public and
      // secret-free — a driver NAME and a boolean, never a credential.
      mail: require('./lib/mail').mailConfigured(),
      mailDriver: require('./lib/mail').driverName()
    },
    // F5. The stage vocabulary, published so the SPA never hardcodes it.
    stages: {
      lifecycle: require('./lib/enums').LIFECYCLE_STAGES,
      labels: require('./lib/enums').STAGE_LABELS,
      alias: require('./lib/enums').STAGE_ALIAS
    },
    archiveAfterDays: require('./lib/lifecycle').ARCHIVE_AFTER_DAYS
  });
});
app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: r.rows[0].ok === 1, app: 'e360-showrunner', version: APP_VERSION,
               storage: storage.name, nasRoot: NAS_ROOT });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE MOUNTING — the ORDER IS LOad-BEARING
// ────────────────────────────────────────────────────────────────────────────
// Several routers share the /api mount and several apply requireAuth at the
// router level, which means an unauthenticated request would be refused while
// merely PASSING THROUGH one of them. So:
//   1. routes/auth first — it holds the only endpoints that must work without
//      a session (login, /auth/me).
//   2. routes/agent at its own /api/agent prefix, BEFORE any router that would
//      reject an x-agent-key. It ends in a terminal 404 so nothing under
//      /api/agent/* can ever fall through onto the human surface. That route
//      topology IS the §9 guardrail.
//   3. routes/photos, which authenticates PER ROUTE because one of its routes
//      is not session-authenticated at all: the NAS thumbnailer daemon PATCHes
//      /photos/:id/thumb carrying x-thumbnailer-token and no session. Six
//      routers ahead of it applied requireAuth at the router level, so that
//      PATCH was answered 401 by routes/proposals before it ever reached
//      photos.js — the route was unreachable in production (hardening 5).
//      A router that accepts a non-session credential MUST be mounted above
//      every router that calls router.use(requireAuth).
//   4. everything else, all of which requires a session anyway.
//   5. a terminal /api 404, so an unknown API path never reaches the SPA
//      fallback and comes back as index.html.
// ════════════════════════════════════════════════════════════════════════════
app.use('/api', require('./routes/auth'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api', require('./routes/photos'));
app.use('/api', require('./routes/proposals'));
app.use('/api', require('./routes/core'));
app.use('/api', require('./routes/files'));
app.use('/api', require('./routes/finance'));
app.use('/api', require('./routes/purchasing'));
app.use('/api', require('./routes/notes'));
app.use('/api', require('./routes/schedule'));
app.use('/api', require('./routes/deliverables'));
// F2 tech show reports · F3 the notification outbox + F6 the admin sweep. Both
// are session-only (router-level requireAuth, which 403s an x-agent-key), so
// they belong in the fourth group with everything else that needs a person.
app.use('/api', require('./routes/reports'));
app.use('/api', require('./routes/notifications'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route ${req.method} /api${req.path}` });
});

// The last line of defence: an error that escaped asyncH still answers JSON.
app.use('/api', (err, req, res, next) => {          // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(status).json({ error: (err && err.message) || 'Server error' });
});

// ── G. serve the SPA + deep-link fallback ───────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true
}));
// Every non-/api GET that is not a real file returns index.html, so a deep
// link like /folder/12/show/41 survives a refresh.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(index)) {
    return res.json({ app: 'e360-showrunner', version: APP_VERSION, api: '/api',
                      note: 'public/index.html not found — API only' });
  }
  res.sendFile(index);
});

// ── HOUSEKEEPING ────────────────────────────────────────────────────────────
// Small, boring, and in-process. Expired sessions, the 90-day idempotency
// retention (§8) and the 30-day proposal expiry (§6).
async function housekeeping() {
  try {
    const s = await purgeExpiredSessions();
    const i = await purgeIdempotency();
    const p = await expireStaleProposals();
    if (s || i || p) console.log(`[housekeeping] sessions:${s} idempotency:${i} proposals-expired:${p}`);
  } catch (e) {
    console.error('[housekeeping]', e.message);
  }
}

// ── F2/F6. THE SWEEP, on boot ───────────────────────────────────────────────
// Strike overdue shows, create the tech reports their crews owe, re-nag whoever
// is still out, re-check every closeout, auto-archive what is ripe, then flush
// the immediate notification queue.
//
// HONEST TODO, and the reason this is here at all: THIS APP HAS NO SCHEDULER.
// There is no cron, no worker and no timer pretending to be one. The sweep runs
// (a) once on boot — which on Railway means every redeploy and every restart —
// and (b) on POST /api/admin/sweep, which is what a future scheduler would
// call. It is fully idempotent, so both paths are safe to repeat. Making it a
// real daily job needs Railway cron or the per-user agents of ARCHITECTURE.md;
// until one of those exists this app will not fake it with setInterval and
// hope the dyno stays up.
async function bootSweep() {
  if (process.env.SWEEP_ON_BOOT === '0') return;
  try {
    const { sweep } = require('./lib/lifecycle');
    const r = await sweep({ actor: 'system' });
    if (r.struck || r.reports_created || r.nagged || r.archived || r.closeout_complete) {
      console.log(`[sweep] struck:${r.struck} reports:${r.reports_created} nagged:${r.nagged} ` +
        `closeout:${r.closeout_complete} archived:${r.archived} folders:${r.projects_archived}`);
    }
    if (r.notifications && r.notifications.considered) {
      console.log(`[sweep] notifications considered:${r.notifications.considered} ` +
        `sent:${r.notifications.sent || 0} skipped:${r.notifications.skipped || 0} ` +
        `queued:${r.notifications.queued || 0} driver:${r.notifications.driver}`);
    }
  } catch (e) {
    // A sweep failure must never stop the app booting — it is housekeeping.
    console.error('[sweep]', e.message);
  }
}

// ── BOOT ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;

async function boot() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — Showrunner needs a PostgreSQL connection string.');
    process.exit(1);
  }
  await initDB();
  console.log('Showrunner DB tables ready');
  await seedAll();
  await housekeeping();
  setInterval(housekeeping, 6 * 60 * 60 * 1000).unref();
  await bootSweep();

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`E360 Showrunner ${APP_VERSION} running on port ${PORT}`);
      console.log(`  storage driver : ${storage.name}  (root ${STORAGE_ROOT})`);
      console.log(`  NAS path root  : ${NAS_ROOT}`);
      console.log(`  CORS origins   : ${ORIGINS.length ? ORIGINS.join(', ') : '(same-origin only)'}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  boot().catch((err) => { console.error('Boot failed:', err); process.exit(1); });
}

module.exports = { app, boot, APP_VERSION };
