#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/byte-timing.js — how long does opening a file ACTUALLY take?
// ────────────────────────────────────────────────────────────────────────────
//   BASE=https://…  USER=tandres  PASS=…  FILE_ID=2  node scripts/byte-timing.js
//   BASE=…  TOKEN=…  FILE_ID=2  node scripts/byte-timing.js
//
// Tom opened a 364 KB PDF and waited about twenty seconds. This measures the
// thing he was waiting for, on whichever deployment you point it at, and it
// separates the two numbers that were previously one:
//
//   COLD — the cache is empty, so the bytes come out of Railway, across the
//          WireGuard tailnet, into the Synology and back. This is the relay
//          cost and it is what it is.
//   WARM — the same file again, served from this container's own disk.
//
// It clears the cache through POST /api/admin/byte-cache/clear before each cold
// read, so the two numbers are reproducible rather than a one-off you have to
// take on faith. Requires an ADMIN login for that one call; everything else
// works with any signed-in user.
//
// TTFB is reported separately from total, because they answer different
// questions: time-to-first-byte is the NAS round trip, and total-minus-TTFB is
// the transfer. A slow first byte and a fast body means the tunnel; the reverse
// means bandwidth.
// ════════════════════════════════════════════════════════════════════════════
'use strict';

const BASE = String(process.env.BASE || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const FILE_ID = parseInt(process.env.FILE_ID || '2', 10);
const ROUNDS = parseInt(process.env.ROUNDS || '3', 10);

function ms(t) { return Math.round(t * 10) / 10; }
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One timed GET. Reads the body to completion — a document is not "open" until
// the last byte lands, and stopping the clock at the headers would flatter us.
async function timedGet(token) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/files/${FILE_ID}/content`, {
    headers: { 'x-auth-token': token }
  });
  const reader = res.body.getReader();
  let ttfb = null, bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb === null) ttfb = performance.now() - t0;
    bytes += value.length;
  }
  return {
    status: res.status,
    source: res.headers.get('x-byte-source'),
    ttfb: ttfb == null ? 0 : ttfb,
    total: performance.now() - t0,
    bytes
  };
}

async function main() {
  let token = process.env.TOKEN || '';
  if (!token) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.USER || 'admin', password: process.env.PASS || '' })
    });
    const j = await r.json();
    if (!j.token) { console.error('login failed:', JSON.stringify(j)); process.exit(2); }
    token = j.token;
  }

  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`\ntarget    : ${BASE}`);
  console.log(`storage   : ${health.storage} -> ${health.storageTarget || '(unset)'}` +
              `${health.storageVia && health.storageVia !== 'filesystem' ? ' via ' + health.storageVia : ''}`);
  const fc = health.fileCache || {};
  console.log(`byte cache: ${fc.enabled ? `on (cap ${Math.round((fc.maxBytes || 0) / 1048576)} MB)` : 'OFF — ' + fc.reason}`);
  console.log(`file      : #${FILE_ID}\n`);

  const cold = [], warm = [];
  let size = 0, coldSrc = '', warmSrc = '';
  for (let i = 0; i < ROUNDS; i += 1) {
    const cl = await fetch(`${BASE}/api/admin/byte-cache/clear`, {
      method: 'POST', headers: { 'x-auth-token': token }
    });
    if (cl.status === 403) {
      console.log('  ! not an admin — cannot clear the cache, so "cold" below is');
      console.log('    only cold on the first round. Re-run with an admin login.\n');
    }
    const c = await timedGet(token);
    if (c.status !== 200) { console.error(`GET failed: ${c.status}`); process.exit(3); }
    const w = await timedGet(token);
    cold.push(c.total); warm.push(w.total);
    size = c.bytes; coldSrc = c.source; warmSrc = w.source;
    console.log(`  round ${i + 1}  cold ${String(ms(c.total)).padStart(8)} ms ` +
                `(ttfb ${String(ms(c.ttfb)).padStart(7)} ms, ${c.source})` +
                `   warm ${String(ms(w.total)).padStart(7)} ms ` +
                `(ttfb ${String(ms(w.ttfb)).padStart(6)} ms, ${w.source})`);
  }

  console.log(`\n  bytes     : ${size.toLocaleString()}`);
  console.log(`  COLD      : median ${ms(median(cold))} ms   (served: ${coldSrc})`);
  console.log(`  WARM      : median ${ms(median(warm))} ms   (served: ${warmSrc})`);
  const factor = median(cold) / Math.max(median(warm), 0.001);
  console.log(`  speedup   : ${Math.round(factor * 10) / 10}x`);
  if (warmSrc !== 'hit') {
    console.log('\n  ! the second read did not come from the cache. Check ' +
                'GET /api/admin/byte-cache — it names the reason.');
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
