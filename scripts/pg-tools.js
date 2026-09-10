// ════════════════════════════════════════════════════════════════════════════
// scripts/pg-tools.js — where the suites find a REAL pg_dump / pg_restore
// ────────────────────────────────────────────────────────────────────────────
// The smoke suite proves the backup end to end: pg_dump the throwaway
// database through lib/backup.js, land it in storage, pg_restore it into a
// SECOND database and compare row counts. That needs the real binaries, and
// the embedded-postgres npm distribution is TRIMMED — its native/bin carries
// initdb/pg_ctl/postgres only, on every platform (checked 18.4.0-beta.17,
// linux and windows both). So resolution walks, in order:
//
//   1. PG_DUMP_PATH / PG_RESTORE_PATH        — explicit wins, always
//   2. node_modules/@embedded-postgres/*/native/bin
//                                            — in case a future version ships
//                                              them; would be version-matched
//   3. node_modules/.sr-pg-tools/bin         — the local cache that
//                                              scripts/fetch-pg-tools.mjs
//                                              fills (survives until a
//                                              node_modules wipe)
//   4. PATH                                  — a machine with postgresql-client
//
// Version rule: the client must be ≥ the embedded server's major (18) — a
// newer pg_dump dumps an older server, never the reverse — so a PATH hit is
// version-checked before it is accepted.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const MIN_MAJOR = 18;                     // the embedded server's major

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
    const m = /\)\s+(\d+)(?:\.\d+)?/.exec(out);
    return m ? parseInt(m[1], 10) : null;
  } catch (_) { return null; }
}

function firstExisting(candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function embeddedBinDir() {
  const base = path.join(APP, 'node_modules', '@embedded-postgres');
  try {
    for (const d of fs.readdirSync(base)) {
      const bin = path.join(base, d, 'native', 'bin');
      if (fs.existsSync(bin)) return bin;
    }
  } catch (_) { /* not installed */ }
  return null;
}

// Returns { pgDump, pgRestore, source } or null with `why` explaining.
function resolvePgTools() {
  // 1 · explicit
  if (process.env.PG_DUMP_PATH && process.env.PG_RESTORE_PATH) {
    return { pgDump: process.env.PG_DUMP_PATH, pgRestore: process.env.PG_RESTORE_PATH,
             source: 'PG_DUMP_PATH/PG_RESTORE_PATH env' };
  }
  // 2 · a future embedded-postgres that ships them
  const emb = embeddedBinDir();
  if (emb) {
    const d = firstExisting([path.join(emb, 'pg_dump' + EXE)]);
    const r = firstExisting([path.join(emb, 'pg_restore' + EXE)]);
    if (d && r) return { pgDump: d, pgRestore: r, source: 'embedded-postgres native/bin' };
  }
  // 3 · the fetched cache
  const cache = path.join(APP, 'node_modules', '.sr-pg-tools', 'bin');
  const cd = firstExisting([path.join(cache, 'pg_dump' + EXE)]);
  const cr = firstExisting([path.join(cache, 'pg_restore' + EXE)]);
  if (cd && cr && versionOf(cd) >= MIN_MAJOR) {
    return { pgDump: cd, pgRestore: cr, source: 'node_modules/.sr-pg-tools (fetch-pg-tools.mjs)' };
  }
  // 4 · PATH, version-gated
  if (versionOf('pg_dump' + (process.platform === 'win32' ? '.exe' : '')) >= MIN_MAJOR ||
      versionOf('pg_dump') >= MIN_MAJOR) {
    return { pgDump: 'pg_dump', pgRestore: 'pg_restore', source: 'PATH' };
  }
  return null;
}

const HOW_TO_GET_THEM =
  `pg_dump/pg_restore (major >= ${MIN_MAJOR}) were not found. The embedded-postgres package ` +
  `does not ship them. Fix: run \`node scripts/fetch-pg-tools.mjs\` (Windows: downloads the ` +
  `matching EDB client tools into node_modules/.sr-pg-tools; Linux/macOS: prints the one ` +
  `package-manager command), or set PG_DUMP_PATH and PG_RESTORE_PATH.`;

module.exports = { resolvePgTools, versionOf, HOW_TO_GET_THEM, MIN_MAJOR };
