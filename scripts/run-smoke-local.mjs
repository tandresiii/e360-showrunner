// Run scripts/smoke.js against a throwaway embedded-postgres — the same
// bring-up persona-walk.mjs uses, so `npm run smoke` needs no external scratch
// database. Exit code is smoke's own (0 pass / 1 fail / 3 abort).
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');

const PGPORT = parseInt(process.env.SMOKE_PG_PORT || '54332', 10);
const dataDir = path.join(os.tmpdir(), 'sr-smoke-' + Date.now().toString(36));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PGPORT,
  persistent: false,
  // SMOKE.md: the database MUST be UTF-8 — activity details carry → and —
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {}, onError: () => {}
});

let code = 3;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('smoke');
  console.log(`postgres up on ${PGPORT} — throwaway, UTF-8`);
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP, 'scripts', 'smoke.js')], {
      cwd: APP, stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PGPORT}/smoke?sslmode=disable`
      }
    });
    child.on('exit', (c) => resolve(c == null ? 3 : c));
  });
} finally {
  // pg.stop() has reported success while the server lived on — stop the
  // SCOPED instance by data dir, then let pg clean up its files.
  try {
    const pgctl = path.join(APP, 'node_modules', '@embedded-postgres',
      process.platform === 'win32' ? 'windows-x64' : 'linux-x64', 'native', 'bin',
      process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    execFileSync(pgctl, ['-D', dataDir, 'stop', '-m', 'fast', '-w'], { stdio: 'ignore' });
  } catch { /* already down, or pg.stop() below gets it */ }
  try { await pg.stop(); } catch {}
}
process.exit(code);
