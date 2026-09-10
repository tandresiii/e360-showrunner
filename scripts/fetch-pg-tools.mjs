#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/fetch-pg-tools.mjs — fetch a real pg_dump/pg_restore for the suites
// ────────────────────────────────────────────────────────────────────────────
//   node scripts/fetch-pg-tools.mjs [path-to-already-downloaded-edb-zip]
//
// The smoke suite's backup section (SMOKE.md) needs genuine pg_dump/pg_restore
// binaries of major >= 18, and the embedded-postgres npm distribution is
// trimmed to initdb/pg_ctl/postgres on every platform. This script fills the
// gap ONCE per node_modules:
//
//   · Windows — downloads EDB's official postgresql-18.4-1 windows-x64
//     binaries zip (~338 MB, the same build family embedded-postgres uses),
//     extracts ONLY pg_dump.exe, pg_restore.exe and the eleven DLLs they
//     load, into node_modules/.sr-pg-tools/bin (~11 MB kept), and deletes
//     the rest. Re-run after any `npm ci`/node_modules wipe.
//   · Linux/macOS — package managers do this better than a downloader script
//     ever will; the exact command is printed and the script exits 1.
//
// The version is PINNED (18.4-1) to match the embedded server so the proof in
// smoke is dump-and-restore at equal majors — the production image instead
// tracks pgdg's postgresql-client-18 (Dockerfile), where NEWER-than-server is
// the property that matters.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(APP, 'node_modules', '.sr-pg-tools', 'bin');
const EDB_URL = 'https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip';
// pg_dump/pg_restore plus exactly what they link (verified by running them
// against an empty PATH — see the backup build notes, 2026-09-10)
const KEEP = [
  'pg_dump.exe', 'pg_restore.exe',
  'libpq.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll',
  'libiconv-2.dll', 'libintl-9.dll', 'liblz4.dll', 'libzstd.dll',
  'zlib1.dll', 'libwinpthread-1.dll'
];

if (process.platform !== 'win32') {
  console.error('This machine is not Windows — use the package manager instead:');
  console.error('  Debian/Ubuntu : sudo apt install postgresql-client-18   (pgdg repo)');
  console.error('  macOS         : brew install libpq   (then PG_DUMP_PATH=$(brew --prefix libpq)/bin/pg_dump …)');
  console.error('Or set PG_DUMP_PATH / PG_RESTORE_PATH at any >= 18 client.');
  process.exit(1);
}

const already = KEEP.every((f) => fs.existsSync(path.join(DEST, f)));
if (already && !process.argv[2]) {
  const v = spawnSync(path.join(DEST, 'pg_dump.exe'), ['--version'], { encoding: 'utf8' });
  console.log(`already fetched: ${DEST}`);
  console.log(`  ${String(v.stdout || '').trim()}`);
  process.exit(0);
}

async function main() {
  let zip = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-pgtools-'));
  try {
    if (!zip) {
      zip = path.join(tmp, 'edb.zip');
      console.log(`downloading ${EDB_URL} (~338 MB, once per node_modules) …`);
      const res = await fetch(EDB_URL);
      if (!res.ok) throw new Error(`EDB answered ${res.status} — the pinned version may have been ` +
        `retired; check https://www.enterprisedb.com/download-postgresql-binaries and update EDB_URL.`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
    console.log('extracting the client tools …');
    const unpack = path.join(tmp, 'unpacked');
    // PowerShell's Expand-Archive: on the one platform this branch runs, it is
    // always present, and it beats hand-rolling a zip reader for a dev tool.
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-Command',
       `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpack}' -Force`],
      { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Expand-Archive failed');
    fs.mkdirSync(DEST, { recursive: true });
    for (const f of KEEP) {
      fs.copyFileSync(path.join(unpack, 'pgsql', 'bin', f), path.join(DEST, f));
    }
    const v = spawnSync(path.join(DEST, 'pg_dump.exe'), ['--version'], { encoding: 'utf8' });
    if (!/pg_dump \(PostgreSQL\) 18/.test(String(v.stdout))) {
      throw new Error(`the fetched pg_dump did not answer as major 18: ${v.stdout || v.stderr}`);
    }
    console.log(`done: ${DEST}`);
    console.log(`  ${String(v.stdout).trim()}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}
main().catch((e) => { console.error('fetch-pg-tools failed:', e.message); process.exit(1); });
