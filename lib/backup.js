// ════════════════════════════════════════════════════════════════════════════
// lib/backup.js — the nightly pg_dump, shipped to the NAS
// ────────────────────────────────────────────────────────────────────────────
// The promise this file makes true: "a nightly pg_dump shipped to the NAS so
// there's an off-platform copy on hardware we own." Railway hosts the only
// Postgres this app has; if that service evaporated, every project, job,
// ledger row and audit line would go with it. The NAS pile under _backups/ is
// the recovery story, and RESTORE.md is the bad-day script that reads it.
//
// Design decisions, and why:
//
//   · pg_dump -Fc (custom format, compressed). One file, restorable with
//     pg_restore into ANY same-or-newer server, table-selectable on the bad
//     day. The Dockerfile installs the NEWEST postgresql-client major for the
//     same reason: a newer pg_dump dumps any older server; the reverse fails.
//
//   · The bytes ship through the EXISTING storage driver (lib/storage.js) —
//     local or WebDAV-over-Tailscale, whichever production runs. No second
//     byte path to audit, and every hard lesson that driver already carries
//     (timeouts, honest 502s, the SOCKS whitelist) covers backups for free.
//
//   · _backups/ is a RESERVED prefix. No file row ever points into it, no
//     cascade ever deletes under it, the UI file browser never lists it. The
//     only writer is runBackup() and the only deleter is pruneBackups() —
//     and the deleter is double-scoped (prefix + exact filename pattern),
//     because a retention sweep with a loose glob is how a backup system
//     eats the show files it was built to outlive.
//
//   · VERIFIED, never assumed. After the PUT, the stored object is read back
//     through the driver (stat) and its size compared to the local dump.
//     A backup that did not land reports 'failed' — the storage layer's
//     honest-verification doctrine (2026-08-28: /api/health said "ready" at
//     a NAS that had never answered; that class of lie stops here too).
//
//   · The LEDGER (backup_runs) lives in the database being backed up. That is
//     fine and deliberate: it is operational telemetry — "what did the last
//     run do" — and it is inside every dump, so a restore carries its own
//     history. The NAS LISTING is the recovery-time source of truth; the
//     ledger is the health check's memory. GET /api/admin/backups returns
//     both precisely so a human can eyeball one against the other.
//
//   · No secrets, anywhere. pg_dump receives the connection pieces via child
//     ENV (PGHOST/PGUSER/PGPASSWORD…), never argv — argv is world-readable
//     process state and lands in error strings. The ledger and the health
//     block carry sizes, timestamps and statuses; error text is scrubbed of
//     anything URL-shaped before it is stored.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { pool } = require('./db');
const { storage, storageReady, NAS_ROOT } = require('./storage');

// The reserved prefix, and the ONLY filename shape this module will ever
// create or delete. YYYY-MM-DDTHHmm is UTC — sortable as text, readable off a
// Synology listing, and parseable back into a date for retention math.
const BACKUP_PREFIX = '_backups';
const BACKUP_NAME_RE = /^showrunner-\d{4}-\d{2}-\d{2}T\d{4}\.dump$/;

// ── knobs (env, read at call time so the suites can steer them) ─────────────
const keepDaily = () => Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10) || 14);
const keepMonthly = () => Math.max(0, parseInt(process.env.BACKUP_KEEP_MONTHLY || '6', 10) || 6);
// 08:00 UTC ≈ 3am Central (2am when CST). DST HONESTY: this is a UTC hour, so
// the wall-clock run time in Chicago shifts by one hour twice a year. That is
// fine — the point is "once a day while nobody is working", not "03:00:00
// sharp" — and a UTC anchor means the 26h staleness window never double-fires
// or skips across the change the way a local-time cron can.
const hourUtc = () => {
  const h = parseInt(process.env.BACKUP_HOUR_UTC || '8', 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 8;
};
const enabledByEnv = () => String(process.env.BACKUP_ENABLED || '') !== '0';

// ── the overlap latch ───────────────────────────────────────────────────────
// SET SYNCHRONOUSLY at the top of runBackup, before its first await — so two
// calls in the same tick (a manual trigger racing the nightly timer) resolve
// deterministically: one runs, the other is refused with a 409. In-process is
// the right scope: there is exactly one server process, and a DB lock would
// add a failure mode (a crashed run holding the lock) for no added safety.
let running = false;
function isRunning() { return running; }

// ── filenames ↔ dates (pure, so retention math is testable without a NAS) ──
function backupFileName(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `showrunner-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}.dump`;
}
function parseBackupName(name) {
  const m = /^showrunner-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.dump$/.exec(String(name || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return isNaN(d) ? null : d;
}

// ── the connection, as child env — never argv, never logged ─────────────────
// DATABASE_URL is decomposed into libpq's own variables. Why not hand pg_dump
// the URL on its command line: argv is visible to every process in the
// container and gets quoted into error messages; PGPASSWORD in a child env
// dies with the child. Why not PGDATABASE=<url>: libpq only expands a URL
// found in the dbname PARAMETER, not in the environment fallback — an env-var
// URL would be treated as a literal database name and fail confusingly.
function pgEnvFromUrl(raw) {
  const u = new URL(String(raw));
  const env = {};
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = (u.pathname || '').replace(/^\/+/, '');
  if (db) env.PGDATABASE = decodeURIComponent(db);
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

// Anything URL-shaped or password-looking is stripped before an error string
// is stored or served. Belt and braces: nothing in this module puts the URL
// into a message in the first place, but pg_dump's stderr is not ours to vet.
function scrubSecrets(s) {
  return String(s || '')
    .replace(/postgres(ql)?:\/\/\S+/gi, '<connection-url>')
    .replace(/PGPASSWORD=\S+/gi, 'PGPASSWORD=<redacted>')
    .slice(0, 600);
}

// pg_dump lives on PATH in the production image (Dockerfile: pgdg
// postgresql-client). PG_DUMP_PATH exists for the suites — embedded-postgres
// does not ship pg_dump, so scripts/pg-tools.js points this at a real one —
// and doubles as the operator escape hatch if the image layout ever changes.
function pgDumpBin() { return process.env.PG_DUMP_PATH || 'pg_dump'; }

function runPgDump(outFile, dbUrl, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    const t0 = Date.now();
    try {
      child = spawn(pgDumpBin(), ['--format=custom', '--file', outFile], {
        env: { ...process.env, ...pgEnvFromUrl(dbUrl) },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      return resolve({ ok: false, error: `pg_dump could not be started: ${e.message}` });
    }
    let stderr = '';
    let done = false;
    const finish = (out) => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      finish({ ok: false, error: `pg_dump did not finish within ${timeoutMs}ms — killed` });
    }, timeoutMs);
    child.stderr.on('data', (c) => { if (stderr.length < 8192) stderr += c.toString('utf8'); });
    child.on('error', (e) => finish({
      ok: false,
      error: e.code === 'ENOENT'
        ? `pg_dump is not installed here (${pgDumpBin()}). The production image installs ` +
          `postgresql-client via the pgdg repo (Dockerfile); locally, run ` +
          `\`node scripts/fetch-pg-tools.mjs\` or set PG_DUMP_PATH.`
        : `pg_dump failed to run: ${e.message}`
    }));
    child.on('close', (code) => {
      if (code === 0) return finish({ ok: true, ms: Date.now() - t0 });
      finish({ ok: false, error: `pg_dump exited ${code}: ${scrubSecrets(stderr.trim() || '(no stderr)')}` });
    });
  });
}

// ── retention (pure) ────────────────────────────────────────────────────────
// Policy: the newest KEEP dumps (the daily working set), PLUS the earliest
// dump of each of the last KEEP_MONTHLY calendar months (the long tail — "what
// did the world look like in June"). Everything else that MATCHES THE BACKUP
// NAME PATTERN is eligible to drop. A name that does not parse is NOT ours to
// judge and never appears in `drop` — that, plus the prefix scoping in
// pruneBackups(), is the two-lock safety on the only deleting code path.
function planRetention(names, { keep = 14, keepMonthly = 6, now = new Date() } = {}) {
  const entries = [];
  for (const name of names || []) {
    const at = parseBackupName(name);
    if (at) entries.push({ name, at });
  }
  entries.sort((a, b) => b.at - a.at);                    // newest first
  const hold = new Set(entries.slice(0, Math.max(0, keep)).map((e) => e.name));

  // the last keepMonthly calendar months, current month included
  const monthKeys = new Set();
  for (let i = 0; i < Math.max(0, keepMonthly); i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    monthKeys.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  for (const key of monthKeys) {
    let first = null;
    for (const e of entries) {
      const k = `${e.at.getUTCFullYear()}-${String(e.at.getUTCMonth() + 1).padStart(2, '0')}`;
      if (k === key && (!first || e.at < first.at)) first = e;
    }
    if (first) hold.add(first.name);
  }
  return {
    keep: entries.filter((e) => hold.has(e.name)).map((e) => e.name),
    drop: entries.filter((e) => !hold.has(e.name)).map((e) => e.name)
  };
}

// The deleter. Runs ONLY after a successful landing (a failing backup system
// must never be thinning the pile — the old dumps are most precious exactly
// when new ones stop arriving), and every remove is re-gated on the pattern
// AND the _backups/ prefix even though planRetention already filtered: the
// smoke suite's mutation test seeds decoys in and around the pile and goes
// red if either lock is loosened.
async function pruneBackups() {
  const listing = await storage.list([NAS_ROOT, BACKUP_PREFIX].join('\\'));
  const names = (listing || []).filter((o) => !o.directory).map((o) => o.name);
  const plan = planRetention(names, { keep: keepDaily(), keepMonthly: keepMonthly(), now: new Date() });
  const removed = [];
  for (const name of plan.drop) {
    if (!BACKUP_NAME_RE.test(name)) continue;             // never anything but our own
    const nasPath = [NAS_ROOT, BACKUP_PREFIX, name].join('\\');
    try {
      const r = await storage.remove(nasPath);
      if (r && r.ok) removed.push(name);
    } catch (e) {
      console.error(`[backup] retention could not remove ${name}: ${e.message}`);
    }
  }
  return { kept: plan.keep.length, removed };
}

// ── the ledger ──────────────────────────────────────────────────────────────
function rowToApi(r) {
  if (!r) return null;
  return {
    id: r.id,
    started_at: r.started_at, finished_at: r.finished_at,
    status: r.status,
    bytes: r.bytes == null ? null : Number(r.bytes),
    path: r.path, error: r.error, trigger: r.trigger
  };
}
async function recordRun({ startedAt, status, bytes, nasPath, error, trigger }) {
  try {
    const r = await pool.query(
      `INSERT INTO backup_runs (started_at, finished_at, status, bytes, path, error, trigger)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6) RETURNING *`,
      [startedAt, status, bytes == null ? null : bytes, nasPath || null,
       error ? scrubSecrets(error) : null, trigger]);
    // keep the ledger bounded — a year of nightlies plus manual runs; the
    // dumps themselves carry the deeper history
    await pool.query(
      `DELETE FROM backup_runs WHERE id NOT IN (SELECT id FROM backup_runs ORDER BY id DESC LIMIT 500)`);
    return rowToApi(r.rows[0]);
  } catch (e) {
    // the ledger failing must not mask what the RUN did — synthesize the row
    console.error('[backup] could not record the run:', e.message);
    return { id: null, started_at: startedAt, finished_at: new Date().toISOString(),
             status, bytes: bytes == null ? null : bytes, path: nasPath || null,
             error: error ? scrubSecrets(error) : null, trigger,
             ledger_error: e.message };
  }
}
async function listRuns(limit = 50) {
  const r = await pool.query(
    `SELECT * FROM backup_runs ORDER BY id DESC LIMIT $1`, [Math.min(500, Math.max(1, limit))]);
  return r.rows.map(rowToApi);
}

// ── the run ─────────────────────────────────────────────────────────────────
// Every exit writes a ledger row and returns it; only the overlap refusal
// throws (409 — there is a row coming from the run that IS in flight, and two
// rows for one moment would make the ledger lie).
async function runBackup({ trigger = 'manual' } = {}) {
  if (running) {
    const e = new Error('A backup is already running — one at a time, by design. ' +
                        'Watch GET /api/admin/backups for the row it lands.');
    e.status = 409;
    throw e;
  }
  running = true;
  const startedAt = new Date();
  const tmpFile = path.join(os.tmpdir(),
    `sr-backup-${crypto.randomBytes(4).toString('hex')}.dump`);
  const fail = (error) => recordRun({ startedAt, status: 'failed', bytes: null, nasPath: null, error, trigger });

  try {
    if (!process.env.DATABASE_URL) {
      return await fail('DATABASE_URL is not set — there is no database to dump.');
    }
    if (!storageReady()) {
      // the whole point is an OFF-PLATFORM copy; a dump parked on the
      // container's own disk dies with the next deploy and is not a backup
      return await fail('storage is not configured — a dump has nowhere durable to land. ' +
                        'Set STORAGE_ROOT or the webdav driver (WIRING_DAY.md); until then this ' +
                        'app has NO off-platform copy.');
    }

    // 1 · dump locally (the container tmpdir is scratch space, fine for a
    // moment — durability comes from the NAS landing, verified below)
    const dumped = await runPgDump(tmpFile, process.env.DATABASE_URL,
      parseInt(process.env.BACKUP_DUMP_TIMEOUT_MS || '600000', 10));
    if (!dumped.ok) return await fail(dumped.error);
    let localSize = 0;
    try { localSize = (await fsp.stat(tmpFile)).size; } catch (_) { /* handled below */ }
    if (!localSize) return await fail('pg_dump exited 0 but produced no bytes — refusing to ship an empty file.');

    // 2 · ship through the storage driver. mkdirs first because a stream
    // cannot be replayed after the driver's PUT→409→MKCOL retry. Names have
    // minute resolution, so two manual runs in one minute target the same
    // object — the second simply overwrites with a fresher dump, and
    // `preExisted` is remembered so a FAILED verification never tears out an
    // object this run did not create (it may be the earlier, good dump).
    const name = backupFileName(startedAt);
    const nasPath = [NAS_ROOT, BACKUP_PREFIX, name].join('\\');
    const preExisted = await storage.exists(nasPath);
    await storage.mkdirs(nasPath);
    await storage.put(nasPath, fs.createReadStream(tmpFile));

    // 3 · READ BACK. put() returning is the driver's claim; stat() is the
    // store's answer. Only the second one is allowed to say 'ok'.
    const st = await storage.stat(nasPath);
    if (!st || Number(st.size) !== localSize) {
      if (!preExisted) {
        // best effort — a bad object this run created must not sit in the
        // pile looking like a backup
        try { await storage.remove(nasPath); } catch (_) { /* the failure is already the story */ }
      }
      return await fail(`read-back verification failed — the store reports ` +
        `${st ? st.size + ' bytes' : 'nothing at all'} where ${localSize} were sent. ` +
        `The dump did NOT land as sent; this run kept nothing.`);
    }

    const row = await recordRun({ startedAt, status: 'ok', bytes: Number(st.size), nasPath, error: null, trigger });

    // 4 · retention — only after a verified landing, never on failure
    try {
      const pruned = await pruneBackups();
      if (pruned.removed.length) {
        console.log(`[backup] retention: kept ${pruned.kept}, removed ${pruned.removed.length} ` +
                    `(${pruned.removed.slice(0, 3).join(', ')}${pruned.removed.length > 3 ? ', …' : ''})`);
      }
    } catch (e) {
      console.error('[backup] retention pass failed (the new dump is safe):', e.message);
    }
    return row;
  } catch (e) {
    return await fail(e.message);
  } finally {
    running = false;
    try { await fsp.unlink(tmpFile); } catch (_) { /* never landed, or already gone */ }
  }
}

// ── scheduling ──────────────────────────────────────────────────────────────
// A self-rearming setTimeout chain, because this app deliberately has no
// scheduler dependency and no cron (see server.js's HONEST TODO on the sweep).
// A backup is the one job that CANNOT wait for "a real scheduler someday":
// setInterval drift and dyno restarts are both survivable here because every
// boot re-arms and the 26h staleness flag in /api/health catches a chain that
// silently stopped. unref() so a test boot never hangs on us.
function nextRunAt(now = new Date(), hour = hourUtc()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

let timer = null;
let armedFor = null;
function armBackupTimer() {
  const arm = () => {
    const at = nextRunAt(new Date(), hourUtc());
    armedFor = at;
    timer = setTimeout(async () => {
      try {
        if (!enabledByEnv()) {
          console.log('[backup] BACKUP_ENABLED=0 — scheduled run skipped');
        } else if (!process.env.DATABASE_URL || !storageReady()) {
          console.log('[backup] scheduled run skipped — DATABASE_URL/storage not ready ' +
                      '(the health block is saying this out loud too)');
        } else {
          const row = await runBackup({ trigger: 'schedule' });
          console.log(row.status === 'ok'
            ? `[backup] nightly landed: ${row.path} (${row.bytes} bytes)`
            : `[backup] nightly FAILED: ${row.error}`);
        }
      } catch (e) {
        // overlap (a manual run in flight at 08:00) or a surprise — log it;
        // the ledger and health carry the record either way
        console.error('[backup] scheduled run:', e.message);
      }
      arm();                                              // re-arm REGARDLESS
    }, at.getTime() - Date.now());
    if (timer.unref) timer.unref();
    return at;
  };
  return arm();
}

// ── the health block (/api/health "backup") ─────────────────────────────────
// Booleans, timestamps and sizes — never a URL, never a credential. `stale`
// is the silently-rotting detector: enabled + no verified landing inside 26h
// (24h cadence + 2h of grace) = someone should look TODAY, not on the bad day.
async function healthBlock() {
  const enabled = enabledByEnv() && !!process.env.DATABASE_URL && storageReady();
  const out = {
    enabled,
    enabledMeans: 'BACKUP_ENABLED is not 0, DATABASE_URL is set and storage is configured. ' +
                  'Like storageReady, this is config — lastRun is the measurement.',
    running,
    hourUtc: hourUtc(),
    keep: keepDaily(), keepMonthly: keepMonthly(),
    lastRun: null,
    lastSuccessAt: null,
    nextRunAt: enabled && armedFor ? armedFor.toISOString()
             : enabled ? nextRunAt().toISOString() : null,
    stale: false,
    staleMeans: 'true when backups are enabled and no dump has VERIFIABLY landed in the last 26h ' +
                '(24h cadence + 2h grace) — the nightly failed, stopped, or never started. ' +
                'BACKUP_HOUR_UTC anchors to UTC, so the Central wall-clock hour drifts across DST; ' +
                'the 26h window does not care.'
  };
  try {
    const last = await pool.query(`SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1`);
    const lastOk = await pool.query(
      `SELECT * FROM backup_runs WHERE status='ok' ORDER BY id DESC LIMIT 1`);
    const l = last.rows[0] || null;
    const lo = lastOk.rows[0] || null;
    out.lastRun = l ? { at: l.finished_at, status: l.status,
                        bytes: l.bytes == null ? null : Number(l.bytes) } : null;
    out.lastSuccessAt = lo ? lo.finished_at : null;
    if (enabled) {
      // never succeeded but HAS been trying → that is rot, say so; a fresh
      // install with zero runs is merely young (first run is <24h away)
      out.stale = lo
        ? (Date.now() - new Date(lo.finished_at).getTime()) > 26 * 3600 * 1000
        : !!l;
    }
  } catch (e) {
    // health must answer even if the ledger cannot — say why instead of 500ing
    out.error = scrubSecrets(e.message);
  }
  return out;
}

module.exports = {
  BACKUP_PREFIX, BACKUP_NAME_RE,
  runBackup, pruneBackups, listRuns, healthBlock, armBackupTimer, isRunning,
  // pure seams, exported for the suites
  backupFileName, parseBackupName, planRetention, nextRunAt, pgEnvFromUrl, scrubSecrets
};
