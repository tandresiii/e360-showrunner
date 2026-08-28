#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/storage-test.js — the NAS byte layer, proved without a NAS
// ────────────────────────────────────────────────────────────────────────────
//   node scripts/storage-test.js                      driver only, no database
//   DATABASE_URL=... node scripts/storage-test.js     + the real byte routes
//
// The wiring session cannot be rehearsed against Tom's Synology from here, so
// this suite builds the other end of every wire IN PROCESS and drives the real
// driver at it:
//
//   · a real WebDAV server   (node http, backed by a temp directory) speaking
//                            PROPFIND / MKCOL / PUT / GET / MOVE / DELETE with
//                            Basic auth, and able to misbehave on demand —
//                            401, stall past the timeout, refuse a collection.
//   · the same server on TLS with a self-signed certificate, because that is
//                            exactly what a Synology reached by its tailnet
//                            name presents.
//   · a real SOCKS5 server   (node net) standing in for `tailscaled
//                            --socks5-server=localhost:1055`, counting the
//                            connections it proxies so "the proxy was actually
//                            used" is an assertion and not a hope.
//   · the REAL staged PDF    nas-staging/P1-…/S1-…/spec/00_e360_BigTen_SEC_…pdf
//                            — 364,739 bytes, the first file that will really
//                            go up on wiring day — round-tripped and compared
//                            by SHA-256, buffered AND streamed.
//
// With DATABASE_URL set it goes further and boots the actual Showrunner server
// with STORAGE_DRIVER=webdav pointed at the in-process WebDAV server, then
// pushes that same PDF through PUT /api/files/:id/content and pulls it back
// through GET /api/files/:id/content over HTTP, byte-comparing at the far end.
//
// WHAT THIS SUITE CANNOT PROVE — and nothing on this machine can:
//   · that Tom's Synology's WebDAV implementation agrees with this one,
//   · that a Railway container can join the tailnet and resolve the NAS,
//   · that svc-showrunner has write permission on the `showrunner` share.
// Those three are wiring day's smoke sequence — WIRING_DAY.md §6.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else {
    fail += 1; failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? '  ->  ' + String(
      typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : ''}`);
  }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
async function throws(fn) {
  try { const v = await fn(); return { threw: false, value: v }; }
  catch (e) { return { threw: true, error: e, message: e.message, status: e.status, code: e.code }; }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── a throwaway self-signed cert for CN=localhost ───────────────────────────
// Stored base64-of-PEM so no `BEGIN PRIVATE KEY` armour appears in the repo for
// a secret scanner to trip over. It IS a private key and it IS public: it was
// generated for this file, it is valid for `localhost` only, and it exists so
// the suite can prove the self-signed path a Synology will actually present.
const TEST_CERT_B64 =
  'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tDQpNSUlESnpDQ0FnK2dBd0lCQWdJVVVnMGY0U1FmVDM1c0pDVWNia0ZLM1dU' +
  'LzhyOHdEUVlKS29aSWh2Y05BUUVMDQpCUUF3RkRFU01CQUdBMVVFQXd3SmJHOWpZV3hvYjNOME1DQVhEVEkyTURneU9ERTJO' +
  'RGd3T0ZvWUR6SXhNall3DQpPREEwTVRZME9EQTRXakFVTVJJd0VBWURWUVFEREFsc2IyTmhiR2h2YzNRd2dnRWlNQTBHQ1Nx' +
  'R1NJYjNEUUVCDQpBUVVBQTRJQkR3QXdnZ0VLQW9JQkFRQ1g0VGFuckEyWERheG9uQlpFaFk1d2tFYWxqWFVlMVQrR1lqZ0Y2' +
  'UkxmDQo0TGkxQ0JLcW1sVlhkeFUvOUZGdTd2Z280OFc0RDVOV3prb0E1eXN4RHJRQmVxd0t0c2NPNWU1clJuOFpYaXBiDQpN' +
  'dFVIKzkyTHRqZ0pZdnhKZHRiL215Z0E3WjVSWklLa0E2MlF2b0FLNmNsWXF1Z3R1Y0drTDhWOFVMQytPMTVBDQpKZ2doeTVz' +
  'S0VLQnZCVmhKSU1IU2NuTFlVelRqWjRybFZFZ09TVndDUitnSW5OOTM3QXJRcmcxZDNzWDlnWmd5DQo0TkNRdkNyYmIxN2w5' +
  'QUprYWQyZ0pHSksvK09WUE1BUjlRd2VsTGZnL0FOWlRGS2Z4bmVNUDF4b0xIa0Q4bHhnDQpCVUNmSk5xc1Bic1hlZjVOcUVB' +
  'Z2E4VjlrUDNsT0VtcjRkZGxpbWwzdHhXWEFnTUJBQUdqYnpCdE1CMEdBMVVkDQpEZ1FXQkJRa0EyVUxjZGY0Q1dMSm9wdVVr' +
  'SjI3TVB2ckJqQWZCZ05WSFNNRUdEQVdnQlFrQTJVTGNkZjRDV0xKDQpvcHVVa0oyN01QdnJCakFQQmdOVkhSTUJBZjhFQlRB' +
  'REFRSC9NQm9HQTFVZEVRUVRNQkdDQ1d4dlkyRnNhRzl6DQpkSWNFZndBQUFUQU5CZ2txaGtpRzl3MEJBUXNGQUFPQ0FRRUFF' +
  'cGxNNlYyR1oxdms3MXExRkU1QTBmZ3M2bHd4DQo3NDNrcUVuNWN5dFF5OVVzQUhaNUs2RERmTnIwN2FOYUpqZkhxMFByUDNQ' +
  'S0YrOStRNHFPUkc2N2lFMmN3RThLDQp4eG90bmNwNkJybmpqaEs0WjR1TTJUcWd0TGlhL1VyNFRYaDdHTHJKTzMxMm9DR0Jh' +
  'Wjd4RkpUSTZMdjAvaUQ2DQpjbDRkdzRGbVpMd2xja1U3WHlNNVVWWnQ5elprclBPQ0ZTSFY0RTNhUUZQbThtQUN5ZW9NdkdN' +
  'ZDdrMzZTSERwDQp4dU95b3MvVGFWU3BWS25nNkx4N0dGNHJKdUpVRFRkL1lCUWh0eXJMMm5Od3RTOU1BU0xrRWVzTi9wbUQx' +
  'U1p2DQpnenpYaE0rRTd3dTBCaWtCdGJRQVYyL1JFaWVRUXhDMmZvdXNIeVltdXdvL2h2a0M3UURoLytFa3BnPT0NCi0tLS0t' +
  'RU5EIENFUlRJRklDQVRFLS0tLS0=';
const TEST_KEY_B64 =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUlFdmdJQkFEQU5CZ2txaGtpRzl3MEJBUUVGQUFTQ0JLZ3dnZ1NrQWdF' +
  'QUFvSUJBUUNYNFRhbnJBMlhEYXhvDQpuQlpFaFk1d2tFYWxqWFVlMVQrR1lqZ0Y2UkxmNExpMUNCS3FtbFZYZHhVLzlGRnU3' +
  'dmdvNDhXNEQ1Tld6a29BDQo1eXN4RHJRQmVxd0t0c2NPNWU1clJuOFpYaXBiTXRVSCs5Mkx0amdKWXZ4SmR0Yi9teWdBN1o1' +
  'UlpJS2tBNjJRDQp2b0FLNmNsWXF1Z3R1Y0drTDhWOFVMQytPMTVBSmdnaHk1c0tFS0J2QlZoSklNSFNjbkxZVXpUalo0cmxW' +
  'RWdPDQpTVndDUitnSW5OOTM3QXJRcmcxZDNzWDlnWmd5NE5DUXZDcmJiMTdsOUFKa2FkMmdKR0pLLytPVlBNQVI5UXdlDQps' +
  'TGZnL0FOWlRGS2Z4bmVNUDF4b0xIa0Q4bHhnQlVDZkpOcXNQYnNYZWY1TnFFQWdhOFY5a1AzbE9FbXI0ZGRsDQppbWwzdHhX' +
  'WEFnTUJBQUVDZ2dFQUdoZFg5czBCVnFwRUxJSm45dVNFdUVTb3hrYjdVRTB0Q1E1MWRscDRZaHB1DQpVTGN1MGIwS25TaDVi' +
  'NCt1cjZLQTRqRmk1WUJUZk8yYVcvWmFmcVo2ZU9pVWhwQ291Si82YWRabC9qc2xocDVBDQpaNHMybjRveHJUY2loUkpUMC94' +
  'WkRuUERwMUxmZUlLalBnTGo1endMV1Y2ZTNVQVVpbnFrYi90Q3FhTjBTUXViDQp1bWttVVhQTEEwQXo0cjVMOXUrM0VwWnd0' +
  'cVg3UUV5M1RlNGQ0WXlibFFmWk5WdTZaaXMvaW5icWcrZkh5Szh5DQo3WXgvVk5lL3lrc3ZWcU1rck1mZ2I4OEIwQnlkY0Uv' +
  'N2pmaU5ocnphcytMUGN0amh3WGdsUGppTlBCNGxHbFlQDQpvTkJ3YlkrMjBFWDJzNXNKcjhDRVFHNzI0SzRBRDJqcXFyQ3FD' +
  'b1I5RFFLQmdRRE5pL1pIOThNQ2k3REZvNGFPDQpyTldxZUEzcFN2d0ZES3NsdmVhZTQ3YUZPcEZhMFNoVzR6VHZIS2pwQXRK' +
  'MXJpWXd6UG9xUzNwT2lHRnZXdU8yDQpyWjJPRFdMbUpMdkFHQzFPTmNEaGxrMEVwbFE5S3M0bzFFakNJOEN0YU1yQUNMRC9a' +
  'UFRRalRIeG4xZTZSa2o4DQpDckpZZ3NsRkloWk11MEJrYmpiZkg4SmVYUUtCZ1FDOUtQUVB3M3Bqc0NvRHpqNDM1TmwxdWY3' +
  'N1BHZWROd2w4DQpURHpjWkd1akk5TzhTWnRXSEliZXdNTW1COE5weFJ6MElUbkJydGgwdmp2a2hqTHZGNStIaEdZcVBpUFoy' +
  'MEY1DQppVWRFdkozdVhoTTI1c2VGSExnaXJZWERlU2I0RVhOTElmaEJ2VVNPWWthbDBFaHcvSTlIc0pkZmREalZyRDdhDQpq' +
  'MHB0clg4OGd3S0JnUUNzVUdKbDBOb2wzeStSY0ZaVWM2WW40NzlkeldQYlk5UnlybkdRMER0cUUwQlp6ekF2DQpMd2hvVURG' +
  'MkxjeDdwVVFVOHpIaGxTYnlnVGlWbnE5NXJMQ0JyczB6UEtZOUVzZWdZa1hSbUN2Mjh1MTUzZEc0DQp2c1pFSXE3YmNSZFB4' +
  'N21DVVlNKzlxOWc3UUVoZ3R5YWx1a09kSTRBcStQZjdiYTh1dnk3THFmR2JRS0JnUUNFDQo2NVkwellQZk1SY1UvWVF5K3Bq' +
  'a1pRS0x3SEord3dIaldoOGFMMmFEaU5Wc1piekYwZDNrQVVnZ0hTeHYwcGI1DQo1YThVTHF6anZCbVNCOHNhdjFyV2UyN2ZH' +
  'RE5SRHdUL1JqdlNUVWdkQy9Zc2loYUJyeUNsSFpIMVBkam9VRHJYDQovTkxhUHdsQmxFVllsdmVRamFpUkU4SUt6VHh5eVVx' +
  'UmdrY21zdGZKeVFLQmdHY3ZkMkk4bW1SOHpQeTY1d2pvDQpDNmRnZm5Qci9mYUczVk9PakQ1U3Z2WFc0dkw3NTZxRThFL0NP' +
  'RDJycjBFZG5YcHNqbWdDYXFXcmZ1V0pRNlFUDQptWDFKZ2JBVHJEeE16YWJqNExGVFpxYmxpbzFtd3IyN1B6SXI0RkNNajVQ' +
  'b0wvOS80QkkxNWUrWXdLVUVlOE1uDQoyU1YzWEFHc2ZKOUdKSHBscGtEWGRxb1MNCi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0t' +
  'LS0=';
const TEST_CERT = Buffer.from(TEST_CERT_B64, 'base64').toString('utf8');
const TEST_KEY = Buffer.from(TEST_KEY_B64, 'base64').toString('utf8');

// ════════════════════════════════════════════════════════════════════════════
// A REAL WebDAV SERVER, backed by a temp directory
// ────────────────────────────────────────────────────────────────────────────
// Deliberately literal: it does what RFC 4918 says and nothing else, so a
// driver bug cannot hide behind a permissive fake. Every knob below exists
// because a Synology can do the same thing on a bad day.
// ════════════════════════════════════════════════════════════════════════════
function makeDavServer({ root, base = '/showrunner', user, pass: password, tls: useTls = false }) {
  const state = {
    requests: [],            // every {method, path} the driver sent
    rejectAuth: false,       // answer 401 to everything (bad credentials)
    stallMs: 0,              // hold the response open (timeout path)
    failMkcol: false,        // refuse MKCOL with 409 (no permission to create)
    outOfSpace: false        // answer 507 to PUT (share full)
  };

  function decodePath(urlPath) {
    const p = decodeURIComponent(urlPath.split('?')[0]);
    if (!p.startsWith(base)) return null;
    const rel = p.slice(base.length).replace(/^\/+/, '');
    const segs = rel.split('/').filter(Boolean);
    if (segs.some((s) => s === '..' || s === '.')) return null;
    return { segs, disk: path.join(root, ...segs) };
  }
  function authOk(req) {
    if (state.rejectAuth) return false;
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Basic ')) return false;
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    return u === user && p === password;
  }
  function propfindXml(href, st) {
    const isDir = st.isDirectory();
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:multistatus xmlns:D="DAV:"><D:response>' +
      `<D:href>${href}</D:href><D:propstat><D:prop>` +
      `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
      (isDir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`) +
      `<D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified>` +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '</D:response></D:multistatus>';
  }

  const handler = async (req, res) => {
    state.requests.push({ method: req.method, path: req.url });
    const send = (code, body, headers) => {
      const finish = () => {
        res.writeHead(code, headers || {});
        res.end(body || '');
      };
      if (state.stallMs) setTimeout(finish, state.stallMs);
      else finish();
    };
    if (!authOk(req)) {
      return send(401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="webdav"' });
    }
    const t = decodePath(req.url);
    if (!t) return send(400, 'outside the share');
    const parent = path.dirname(t.disk);

    try {
      switch (req.method) {
        case 'PROPFIND': {
          await drain(req);
          let st;
          try { st = await fsp.stat(t.disk); } catch { return send(404, 'not found'); }
          return send(207, propfindXml(req.url, st),
            { 'Content-Type': 'application/xml; charset=utf-8' });
        }
        case 'MKCOL': {
          await drain(req);
          if (state.failMkcol) return send(409, 'refused');
          if (fs.existsSync(t.disk)) return send(405, 'exists');
          if (!fs.existsSync(parent)) return send(409, 'parent missing');
          await fsp.mkdir(t.disk);
          return send(201, '');
        }
        case 'PUT': {
          const body = await readBody(req);
          if (state.outOfSpace) return send(507, 'insufficient storage');
          // RFC 4918 §9.7.1 — a PUT to a path whose collection does not exist
          // is 409, which is what makes the driver's "PUT, then MKCOL, then
          // PUT again" retry the right shape.
          if (!fs.existsSync(parent)) return send(409, 'no collection');
          const existed = fs.existsSync(t.disk);
          await fsp.writeFile(t.disk, body);
          return send(existed ? 204 : 201, '');
        }
        case 'GET': case 'HEAD': {
          await drain(req);
          let st;
          try { st = await fsp.stat(t.disk); } catch { return send(404, 'not found'); }
          if (st.isDirectory()) return send(405, 'is a collection');
          const buf = await fsp.readFile(t.disk);
          if (req.method === 'HEAD') {
            return send(200, '', { 'Content-Length': String(st.size) });
          }
          return send(200, buf, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(st.size),
            'Last-Modified': st.mtime.toUTCString()
          });
        }
        case 'MOVE': {
          await drain(req);
          const dest = decodePath(new URL(String(req.headers.destination)).pathname);
          if (!dest) return send(400, 'bad destination');
          if (!fs.existsSync(t.disk)) return send(404, 'source missing');
          if (!fs.existsSync(path.dirname(dest.disk))) return send(409, 'destination collection missing');
          const existed = fs.existsSync(dest.disk);
          if (existed && String(req.headers.overwrite || 'T').toUpperCase() === 'F') {
            return send(412, 'precondition failed');
          }
          await fsp.rename(t.disk, dest.disk);
          return send(existed ? 204 : 201, '');
        }
        case 'DELETE': {
          await drain(req);
          if (!fs.existsSync(t.disk)) return send(404, 'not found');
          await fsp.rm(t.disk, { recursive: true, force: true });
          return send(204, '');
        }
        default:
          await drain(req);
          return send(405, 'method not allowed');
      }
    } catch (e) {
      return send(500, String(e.message));
    }
  };

  const server = useTls
    ? https.createServer({ cert: TEST_CERT, key: TEST_KEY }, handler)
    : http.createServer(handler);
  server.on('clientError', (e, sock) => { try { sock.destroy(); } catch (_) {} });
  return { server, state };
}
function drain(req) {
  return new Promise((r) => { req.on('data', () => {}); req.on('end', r); req.on('error', r); });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => resolve(Buffer.concat(c)));
    req.on('error', reject);
  });
}
function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((r) => server.close(() => r()));
}

// ════════════════════════════════════════════════════════════════════════════
// A REAL SOCKS5 SERVER — the stand-in for `tailscaled --socks5-server`
// ────────────────────────────────────────────────────────────────────────────
// It counts what it proxies, which turns "the request went through the tailnet
// proxy" from an inference into an assertion.
// ════════════════════════════════════════════════════════════════════════════
function makeSocksServer({ requireAuth = false, user = 'ts', pass: password = 'ts' } = {}) {
  const state = { connections: 0, targets: [], authAttempts: 0, rejected: 0 };
  const server = net.createServer((sock) => {
    sock.once('readable', function greet() {
      const head = sock.read(2);
      if (!head) return sock.once('readable', greet);
      if (head[0] !== 0x05) return sock.destroy();
      const methods = sock.read(head[1]);
      const want = requireAuth ? 0x02 : 0x00;
      const offered = methods ? Array.from(methods) : [];
      if (!offered.includes(want)) { sock.end(Buffer.from([0x05, 0xff])); state.rejected += 1; return; }
      sock.write(Buffer.from([0x05, want]));
      if (want === 0x02) readAuth(); else readConnect();
    });

    function readAuth() {
      sock.once('readable', function step() {
        const v = sock.read(2);
        if (!v) return sock.once('readable', step);
        const u = sock.read(v[1]);
        const pl = sock.read(1);
        const p = pl && pl[0] ? sock.read(pl[0]) : Buffer.alloc(0);
        state.authAttempts += 1;
        const okAuth = u && u.toString() === user && p.toString() === password;
        sock.write(Buffer.from([0x01, okAuth ? 0x00 : 0x01]));
        if (!okAuth) { state.rejected += 1; return sock.end(); }
        readConnect();
      });
    }

    function readConnect() {
      sock.once('readable', function step() {
        const head = sock.read(4);
        if (!head) return sock.once('readable', step);
        let host;
        if (head[3] === 0x03) {
          const l = sock.read(1);
          host = sock.read(l[0]).toString('utf8');
        } else if (head[3] === 0x01) {
          host = Array.from(sock.read(4)).join('.');
        } else { return sock.destroy(); }
        const port = sock.read(2).readUInt16BE(0);
        state.connections += 1;
        state.targets.push(`${host}:${port}`);
        const up = net.connect({ host, port }, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.pipe(up);
          up.pipe(sock);
        });
        up.on('error', () => {
          try { sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (_) {}
        });
        sock.on('error', () => up.destroy());
      });
    }
  });
  return { server, state };
}

// ── HTTP helper for the route section ───────────────────────────────────────
let BASE = '';
async function call(method, p, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['x-auth-token'] = token;
  let payload;
  if (raw) { h['Content-Type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  const ct = String(res.headers.get('content-type') || '');
  if (ct.includes('json')) {
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = text; } }
    return { status: res.status, body: json, headers: res.headers };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf, headers: res.headers };
}

// ════════════════════════════════════════════════════════════════════════════
(async function main() {
  console.log('E360 Showrunner — storage / WebDAV / Tailscale suite');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sr-dav-'));
  const davRoot = path.join(tmp, 'showrunner');
  await fsp.mkdir(davRoot, { recursive: true });

  const USER = 'svc-showrunner';
  const PASS = 'test-pass-éü';        // non-ASCII on purpose: Basic auth is base64 of UTF-8
  const dav = makeDavServer({ root: davRoot, base: '/showrunner', user: USER, pass: PASS });
  const davPort = await listen(dav.server);

  // Env FIRST, then the first require of lib/storage — so `storage` (the module
  // default the whole app uses) IS the webdav driver, pointed at the server
  // above. Testing a hand-built driver would leave the app's own selection
  // untested, which is the one line that decides what production does.
  process.env.STORAGE_DRIVER = 'webdav';
  process.env.SHOWRUNNER_NAS_ROOT = '\\\\E360-NAS\\Showrunner';
  process.env.NAS_WEBDAV_URL = `http://127.0.0.1:${davPort}/showrunner`;
  process.env.NAS_WEBDAV_USER = USER;
  process.env.NAS_WEBDAV_PASS = PASS;
  process.env.NAS_WEBDAV_TIMEOUT_MS = '3000';
  delete process.env.TAILSCALE_AUTHKEY;
  delete process.env.TAILSCALE_SOCKS;

  const S = require('../lib/storage');
  const { storage, makeWebdavDriver, proxyForHost, parseSocks, StorageError } = S;

  const NAS = S.NAS_ROOT;
  const P = (...seg) => [NAS, ...seg].join('\\');

  // ══════════════════════════════════════════════════════════════════════════
  section('1. selection — the app really chose webdav');
  ok('STORAGE_DRIVER=webdav selects the webdav driver', storage.name === 'webdav', storage.name);
  ok('the driver reports itself configured', storage.configured() === true);
  const info0 = storage.info();
  ok('info() names the target host + share', info0.target === `http://127.0.0.1:${davPort}/showrunner`, info0);
  ok('info() says ready', info0.ready === true, info0);
  ok('info() leaks NO credential',
     !JSON.stringify(info0).includes(PASS) && !JSON.stringify(info0).includes(USER), info0);
  ok('info() reports the transport as direct with no proxy configured', info0.via === 'direct', info0);
  ok('storageInfo()/storageReady() agree', S.storageReady() === true && S.storageInfo().driver === 'webdav');

  // ══════════════════════════════════════════════════════════════════════════
  section('2. path safety — one gate, shared by every driver');
  ok('nasSegments strips the UNC root',
     JSON.stringify(S.nasSegments(P('P1-x', 'S1-y', 'spec', 'a.pdf'))) ===
     JSON.stringify(['P1-x', 'S1-y', 'spec', 'a.pdf']));
  ok('a .. segment is refused', (await throws(() => S.nasSegments(P('P1-x', '..', 'etc')))).threw);
  ok('a drive-letter segment is refused', (await throws(() => S.nasSegments(P('C:', 'x')))).threw);
  ok('an empty path is refused', (await throws(() => S.nasSegments(NAS))).threw);
  ok('a traversal never reaches the wire',
     (await throws(() => storage.put(P('P1-x', '..', '..', 'evil.txt'), Buffer.from('x')))).threw);
  ok('buildNasPath still follows P{id}-{slug}\\S{id}-{slug}\\{kind}\\{file}',
     S.buildNasPath({ id: 1, slug: 'big-ten' }, { id: 1, slug: 'wrigley' },
                    { kind: 'spec', name: 'a', ext: 'pdf' }) ===
     P('P1-big-ten', 'S1-wrigley', 'spec', 'a.pdf'));
  ok('buildQuarantinePath still lands under _agent-inbox',
     S.buildQuarantinePath('tom', { kind: 'invoice', name: 'i', ext: 'pdf' }) ===
     P('_agent-inbox', 'tom', 'invoice', 'i.pdf'));

  // ══════════════════════════════════════════════════════════════════════════
  section('3. MKCOL — deep, from nothing');
  const deep = P('P9-deep', 'S9-nest', 'spec', 'deep.txt');
  dav.state.requests.length = 0;
  const putDeep = await storage.put(deep, Buffer.from('hello nas'));
  ok('a PUT four levels deep succeeds with no folder pre-created', putDeep.ok === true, putDeep);
  ok('...and it did it by PUT -> 409 -> MKCOL xN -> PUT',
     dav.state.requests.filter((r) => r.method === 'MKCOL').length === 3 &&
     dav.state.requests.filter((r) => r.method === 'PUT').length === 2,
     dav.state.requests.map((r) => r.method).join(','));
  ok('the bytes are really on the far side',
     fs.readFileSync(path.join(davRoot, 'P9-deep', 'S9-nest', 'spec', 'deep.txt'), 'utf8') === 'hello nas');
  dav.state.requests.length = 0;
  await storage.put(P('P9-deep', 'S9-nest', 'spec', 'second.txt'), Buffer.from('again'));
  ok('a second PUT into an existing folder costs ONE request (no blind MKCOL storm)',
     dav.state.requests.length === 1 && dav.state.requests[0].method === 'PUT',
     dav.state.requests.map((r) => r.method).join(','));
  const mk = await storage.mkdirs(P('P9-deep', 'S9-other', 'photo', 'x.jpg'));
  ok('mkdirs() creates only what is missing', mk.ok && mk.created.join(',') === 'S9-other,photo', mk);

  // ══════════════════════════════════════════════════════════════════════════
  section('4. PUT / GET / stream / exists / stat');
  const textPath = P('P9-deep', 'S9-nest', 'spec', 'round.txt');
  const textBody = Buffer.from('the quick brown fox — éüñ — 0123456789\n'.repeat(50), 'utf8');
  const putR = await storage.put(textPath, textBody);
  ok('put() reports the real size', putR.size === textBody.length, putR);
  const got = await storage.get(textPath);
  ok('get() round-trips byte-for-byte', Buffer.compare(got, textBody) === 0);
  const gs = await storage.getStream(textPath);
  const streamed = await new Promise((res, rej) => {
    const c = []; gs.stream.on('data', (x) => c.push(x));
    gs.stream.on('end', () => res(Buffer.concat(c))); gs.stream.on('error', rej);
  });
  ok('getStream() round-trips byte-for-byte', Buffer.compare(streamed, textBody) === 0);
  ok('getStream() reports Content-Length', gs.size === textBody.length, gs.size);
  ok('getStream() reports a Last-Modified date', gs.mtime instanceof Date && !isNaN(gs.mtime));
  ok('exists() is true for a file that is there', (await storage.exists(textPath)) === true);
  ok('exists() is false for one that is not',
     (await storage.exists(P('P9-deep', 'S9-nest', 'spec', 'ghost.txt'))) === false);
  const st = await storage.stat(textPath);
  ok('stat() parses getcontentlength out of the PROPFIND', st && st.size === textBody.length, st);
  ok('stat() parses getlastmodified', st.mtime instanceof Date && !isNaN(st.mtime));
  ok('stat() flags a collection as a directory',
     (await storage.stat(P('P9-deep', 'S9-nest'))).directory === true);
  ok('stat() of nothing is null', (await storage.stat(P('nope', 'nope.txt'))) === null);
  // A name with a space, a comma and a non-ASCII character — every real e360
  // filename has at least one of the three.
  const oddName = P('P9-deep', 'S9-nest', 'spec', 'E360 — Big Ten, v1 (final).pdf');
  await storage.put(oddName, Buffer.from('odd'));
  ok('a filename with spaces, an em dash, a comma and brackets round-trips',
     (await storage.get(oddName)).toString() === 'odd');

  // ══════════════════════════════════════════════════════════════════════════
  section('5. MOVE — the punch-46 quarantine promotion');
  const qPath = S.buildQuarantinePath('kelsey', { kind: 'invoice', name: 'Rental invoice', ext: 'pdf' });
  const canon = P('P9-deep', 'S9-nest', 'invoice', 'Rental invoice.pdf');
  await storage.put(qPath, Buffer.from('invoice bytes'));
  ok('bytes land in _agent-inbox, NOT in a show folder',
     fs.existsSync(path.join(davRoot, '_agent-inbox', 'kelsey', 'invoice', 'Rental invoice.pdf')) &&
     !fs.existsSync(path.join(davRoot, 'P9-deep', 'S9-nest', 'invoice')));
  const mv = await storage.move(qPath, canon);
  ok('move() promotes it, creating the destination collection on the way',
     mv.ok === true && mv.to === canon, mv);
  ok('...the bytes are at the canonical path', (await storage.get(canon)).toString() === 'invoice bytes');
  ok('...and nothing is left in quarantine', (await storage.exists(qPath)) === false);
  const mvMissing = await storage.move(P('gone', 'gone.txt'), canon);
  ok('move() of a missing source returns {ok:false, reason:"source-missing"} — the shape ' +
     'routes/proposals.js branches on',
     mvMissing.ok === false && mvMissing.reason === 'source-missing', mvMissing);

  // ══════════════════════════════════════════════════════════════════════════
  section('6. DELETE — the reject purge');
  const delPath = P('P9-deep', 'S9-nest', 'other', 'purge.txt');
  await storage.put(delPath, Buffer.from('purge me'));
  ok('remove() reports ok', (await storage.remove(delPath)).ok === true);
  ok('...and the bytes are gone', (await storage.exists(delPath)) === false);
  const rmGhost = await storage.remove(P('P9-deep', 'S9-nest', 'other', 'never.txt'));
  ok('remove() of nothing is a soft no, never a throw', rmGhost.ok === false, rmGhost);

  // ══════════════════════════════════════════════════════════════════════════
  section('7. honest failures — a 404 is not a 502 is not a 501');
  const miss = await throws(() => storage.get(P('P9-deep', 'S9-nest', 'spec', 'absent.pdf')));
  ok('GET of a missing file is 404, not 500', miss.threw && miss.status === 404, miss.status);
  ok('...and the message says the row outlived its bytes',
     /No bytes at/.test(miss.message) && /never uploaded|moved on the NAS/.test(miss.message), miss.message);

  dav.state.rejectAuth = true;
  const authFail = await throws(() => storage.get(textPath));
  ok('a rejected credential is a 502-class storage error',
     authFail.threw && authFail.status === 502 && authFail.code === 'auth-failed', authFail);
  ok('...naming svc-showrunner and the env vars to check',
     /svc-showrunner/.test(authFail.message) && /NAS_WEBDAV_USER/.test(authFail.message),
     authFail.message);
  const authPut = await throws(() => storage.put(textPath, Buffer.from('x')));
  ok('a rejected credential on PUT is also 502, never a silent success', authPut.threw && authPut.status === 502);
  dav.state.rejectAuth = false;
  ok('...and the driver recovers the moment the credential works again',
     (await storage.get(textPath)).length === textBody.length);

  dav.state.stallMs = 5000;                     // > NAS_WEBDAV_TIMEOUT_MS (3000)
  const t0 = Date.now();
  const stall = await throws(() => storage.get(textPath));
  const elapsed = Date.now() - t0;
  ok('a NAS that stalls past the timeout gives up', stall.threw && stall.code === 'timeout', stall);
  ok('...at the configured deadline, not the OS default', elapsed < 4500, elapsed + 'ms');
  ok('...saying the record is intact and the bytes did not move',
     /record is intact/.test(stall.message), stall.message);
  dav.state.stallMs = 0;

  dav.state.outOfSpace = true;
  const full = await throws(() => storage.put(textPath, Buffer.from('x')));
  ok('a full share is 507 with its own message', full.threw && full.status === 507, full);
  dav.state.outOfSpace = false;

  dav.state.failMkcol = true;
  const noMk = await throws(() => storage.put(P('P-new', 'S-new', 'spec', 'x.txt'), Buffer.from('x')));
  ok('a NAS that refuses MKCOL says so, and does not report a successful upload',
     noMk.threw && /refused to create/.test(noMk.message), noMk.message);
  dav.state.failMkcol = false;

  const dead = makeWebdavDriver({
    NAS_WEBDAV_URL: 'http://127.0.0.1:9/showrunner',   // discard port: nothing listens
    NAS_WEBDAV_USER: 'u', NAS_WEBDAV_PASS: 'p', NAS_WEBDAV_TIMEOUT_MS: '2000'
  });
  const unreachable = await throws(() => dead.get(P('a', 'b.txt')));
  ok('an unreachable NAS is a 502 that names the host', unreachable.threw && unreachable.status === 502,
     unreachable);
  ok('...and promises no data loss', /No data was lost/.test(unreachable.message), unreachable.message);

  const unset = makeWebdavDriver({});
  const notConf = await throws(() => unset.get(P('a', 'b.txt')));
  ok('webdav with no NAS_WEBDAV_URL is a 501 naming the var, not a crash',
     notConf.threw && notConf.status === 501 && /NAS_WEBDAV_URL/.test(notConf.message), notConf);
  ok('...and points at WIRING_DAY.md', /WIRING_DAY\.md/.test(notConf.message));
  ok('...and configured() is false', unset.configured() === false);
  const noCreds = makeWebdavDriver({ NAS_WEBDAV_URL: 'https://nas:5006/showrunner' });
  const credErr = await throws(() => noCreds.put(P('a', 'b.txt'), Buffer.from('x')));
  ok('webdav with a URL but no credentials is a 501 naming USER/PASS',
     credErr.threw && credErr.status === 501 && /NAS_WEBDAV_USER/.test(credErr.message), credErr);
  const badUrl = makeWebdavDriver({ NAS_WEBDAV_URL: 'not a url', NAS_WEBDAV_USER: 'u', NAS_WEBDAV_PASS: 'p' });
  ok('a malformed NAS_WEBDAV_URL is caught at construction, not on the first upload',
     badUrl.info().ready === false && /not a URL/.test(badUrl.info().error || ''), badUrl.info());

  const tiny = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, MAX_UPLOAD_BYTES: '10'
  });
  const tooBig = await throws(() => tiny.put(P('P9-deep', 'S9-nest', 'spec', 'big.bin'), Buffer.alloc(11)));
  ok('MAX_UPLOAD_BYTES is enforced before a byte leaves the process',
     tooBig.threw && tooBig.status === 413, tooBig);

  ok('smb is still an honest 501 that points at webdav',
     (await throws(() => S.drivers.smb.put('x', Buffer.alloc(0)))).status === 501);

  // ══════════════════════════════════════════════════════════════════════════
  section('8. the REAL staged Big Ten PDF, end to end');
  const staged = path.join(__dirname, '..', 'nas-staging',
    'P1-big-ten-vs-sec-volleyball-challenge', 'S1-wrigley-field', 'spec',
    '00_e360_BigTen_SEC_v01_080726_100pm.pdf');
  ok('the staged PDF is where WIRING_DAY.md says it is', fs.existsSync(staged), staged);
  const pdf = fs.readFileSync(staged);
  const pdfSha = sha(pdf);
  ok('it is the 364,739-byte file from the brief', pdf.length === 364739, pdf.length);
  ok('it really is a PDF', pdf.slice(0, 5).toString() === '%PDF-');

  const pdfNas = P('P1-big-ten-vs-sec-volleyball-challenge', 'S1-wrigley-field', 'spec',
                   '00_e360_BigTen_SEC_v01_080726_100pm.pdf');
  const pdfPut = await storage.put(pdfNas, pdf);
  ok('the PDF uploads through the WebDAV driver', pdfPut.ok && pdfPut.size === 364739, pdfPut);
  ok('the NAS-side file is byte-identical (independent read off disk)',
     sha(fs.readFileSync(path.join(davRoot, 'P1-big-ten-vs-sec-volleyball-challenge',
       'S1-wrigley-field', 'spec', '00_e360_BigTen_SEC_v01_080726_100pm.pdf'))) === pdfSha);
  ok('get() brings it back with the same SHA-256', sha(await storage.get(pdfNas)) === pdfSha);
  const pdfStream = await storage.getStream(pdfNas);
  const pdfStreamed = await new Promise((res, rej) => {
    const c = []; pdfStream.stream.on('data', (x) => c.push(x));
    pdfStream.stream.on('end', () => res(Buffer.concat(c))); pdfStream.stream.on('error', rej);
  });
  ok('getStream() brings it back with the same SHA-256', sha(pdfStreamed) === pdfSha);
  ok('...and declares the right Content-Length', pdfStream.size === 364739, pdfStream.size);
  ok('stat() agrees on the size', (await storage.stat(pdfNas)).size === 364739);
  // move it, read it back, move it home — a real 364 KB file through the
  // promotion path, not a 9-byte token.
  const pdfQ = S.buildQuarantinePath('agent', { kind: 'spec', name: 'BigTen', ext: 'pdf' });
  await storage.put(pdfQ, pdf);
  const pdfMoved = await storage.move(pdfQ, P('P1-big-ten-vs-sec-volleyball-challenge',
    'S1-wrigley-field', 'spec', 'promoted.pdf'));
  ok('a 364 KB file survives the quarantine MOVE with its SHA intact',
     pdfMoved.ok && sha(await storage.get(P('P1-big-ten-vs-sec-volleyball-challenge',
       'S1-wrigley-field', 'spec', 'promoted.pdf'))) === pdfSha);

  // ══════════════════════════════════════════════════════════════════════════
  section('9. TLS — the self-signed certificate a Synology actually presents');
  const tlsDav = makeDavServer({ root: davRoot, base: '/showrunner', user: USER, pass: PASS, tls: true });
  const tlsPort = await listen(tlsDav.server);
  const tlsEnv = {
    NAS_WEBDAV_URL: `https://localhost:${tlsPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, NAS_WEBDAV_TIMEOUT_MS: '5000'
  };
  const strict = makeWebdavDriver(tlsEnv);
  const certFail = await throws(() => strict.get(pdfNas));
  ok('by DEFAULT a self-signed NAS certificate is REFUSED', certFail.threw && certFail.status === 502,
     certFail);
  ok('...with a message that names the two env vars that fix it',
     /NAS_WEBDAV_CA/.test(certFail.message) && /ALLOW_SELF_SIGNED/.test(certFail.message),
     certFail.message);
  // This assertion used to read `tls === 'verified'`, and that one word cost a
  // day on 2026-08-28: /api/health printed it beside a NAS the container could
  // not reach, and it reads as "a certificate was checked and passed" when it
  // only ever meant "no allowance is configured". The label now names the
  // POLICY. The RESULT comes from the probe (section 11b) and nowhere else.
  ok('...and the default driver reports the tls POLICY, never a verdict it did not reach',
     strict.info().tls === 'system-trust' && strict.info().tls !== 'verified', strict.info());
  ok('...and the payload itself says the label is not a handshake result',
     /No certificate has been inspected/i.test(strict.info().tlsMeans || ''), strict.info().tlsMeans);

  const lax = makeWebdavDriver({ ...tlsEnv, NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' });
  ok('NAS_WEBDAV_ALLOW_SELF_SIGNED=1 gets the PDF over TLS with its SHA intact',
     sha(await lax.get(pdfNas)) === pdfSha);
  ok('...and says so in info(), so health does not imply full verification',
     lax.info().tls === 'self-signed-allowed', lax.info());
  ok('...and the relaxation is scoped to this driver — the process-wide switch is untouched',
     process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined);

  const pinned = makeWebdavDriver({ ...tlsEnv, NAS_WEBDAV_CA: TEST_CERT });
  ok('NAS_WEBDAV_CA pins the NAS certificate and verification STAYS ON',
     sha(await pinned.get(pdfNas)) === pdfSha);
  ok('...and info() distinguishes a pinned CA from a disabled check',
     pinned.info().tls === 'pinned-ca', pinned.info());
  const caFile = path.join(tmp, 'nas-ca.pem');
  fs.writeFileSync(caFile, TEST_CERT);
  const pinnedFile = makeWebdavDriver({ ...tlsEnv, NAS_WEBDAV_CA: caFile });
  ok('NAS_WEBDAV_CA also accepts a PATH to a PEM', sha(await pinnedFile.get(pdfNas)) === pdfSha);
  await close(tlsDav.server);

  // ══════════════════════════════════════════════════════════════════════════
  section('10. SOCKS routing — selection logic (pure, no tailnet needed)');
  const nasEnv = { NAS_WEBDAV_URL: 'https://e360-nas.tail9f2c.ts.net:5006/showrunner' };
  ok('no key, no proxy setting -> no proxy at all',
     proxyForHost('e360-nas.tail9f2c.ts.net', nasEnv) === null);
  const auto = proxyForHost('e360-nas.tail9f2c.ts.net', { ...nasEnv, TAILSCALE_AUTHKEY: 'tskey-auth-x' });
  ok('TAILSCALE_AUTHKEY alone implies localhost:1055 — the port the entrypoint opens',
     auto && auto.host === '127.0.0.1' && auto.port === 1055, auto);
  ok('a THIRD-PARTY host is never proxied, even with the key set',
     proxyForHost('e360sport.flexrentalsolutions.com', { ...nasEnv, TAILSCALE_AUTHKEY: 'tskey-auth-x' }) === null);
  ok('graph.microsoft.com is never proxied either',
     proxyForHost('graph.microsoft.com', { ...nasEnv, TAILSCALE_AUTHKEY: 'k' }) === null);
  ok('the match is case-insensitive on hostname',
     proxyForHost('E360-NAS.TAIL9F2C.TS.NET', { ...nasEnv, TAILSCALE_AUTHKEY: 'k' }) !== null);
  const explicit = proxyForHost('e360-nas.tail9f2c.ts.net',
    { ...nasEnv, TAILSCALE_AUTHKEY: 'k', TAILSCALE_SOCKS: '10.0.0.5:1080' });
  ok('an explicit TAILSCALE_SOCKS overrides the implied default',
     explicit.host === '10.0.0.5' && explicit.port === 1080, explicit);
  ok('TAILSCALE_SOCKS_DISABLE=1 wins over everything — the escape hatch',
     proxyForHost('e360-nas.tail9f2c.ts.net',
       { ...nasEnv, TAILSCALE_AUTHKEY: 'k', TAILSCALE_SOCKS: '10.0.0.5:1080',
         TAILSCALE_SOCKS_DISABLE: '1' }) === null);
  ok('with NAS_WEBDAV_URL unset nothing is proxied (nothing to whitelist)',
     proxyForHost('anything', { TAILSCALE_AUTHKEY: 'k' }) === null);
  ok('parseSocks accepts host:port', JSON.stringify(parseSocks('127.0.0.1:1055')) ===
     JSON.stringify({ host: '127.0.0.1', port: 1055, user: null, pass: null }));
  ok('parseSocks accepts a socks5:// URL with credentials',
     (() => { const p = parseSocks('socks5://u:p@h:9'); return p.host === 'h' && p.port === 9 && p.user === 'u' && p.pass === 'p'; })());
  ok('parseSocks defaults the port to 1055', parseSocks('somehost').port === 1055);
  ok('parseSocks rejects junk', parseSocks('') === null && parseSocks(null) === null);

  section('11. SOCKS routing — a real proxy, really used');
  const socks = makeSocksServer();
  const socksPort = await listen(socks.server);
  const viaSocks = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, NAS_WEBDAV_TIMEOUT_MS: '8000',
    TAILSCALE_SOCKS: `127.0.0.1:${socksPort}`
  });
  ok('info() advertises the tailscale hop',
     viaSocks.info().via === `tailscale-socks:127.0.0.1:${socksPort}`, viaSocks.info());
  const beforeCount = socks.state.connections;
  ok('the Big Ten PDF round-trips THROUGH the SOCKS5 proxy with its SHA intact',
     sha(await viaSocks.get(pdfNas)) === pdfSha);
  ok('...and the proxy actually carried it (connection count went up)',
     socks.state.connections > beforeCount, socks.state);
  ok('...to the NAS host and port, nowhere else',
     socks.state.targets.every((t) => t === `127.0.0.1:${davPort}`), socks.state.targets);
  const socksPutPath = P('P9-deep', 'S9-nest', 'spec', 'through-the-tailnet.pdf');
  await viaSocks.put(socksPutPath, pdf);
  ok('a PUT through the proxy lands byte-identical on the far side',
     sha(fs.readFileSync(path.join(davRoot, 'P9-deep', 'S9-nest', 'spec', 'through-the-tailnet.pdf'))) === pdfSha);
  ok('MOVE works through the proxy too',
     (await viaSocks.move(socksPutPath, P('P9-deep', 'S9-nest', 'spec', 'moved-via-tailnet.pdf'))).ok === true);

  const direct = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS
  });
  const beforeDirect = socks.state.connections;
  await direct.get(pdfNas);
  ok('with no proxy configured the driver does NOT touch the SOCKS port',
     socks.state.connections === beforeDirect, socks.state);

  const socksAuth = makeSocksServer({ requireAuth: true, user: 'ts', pass: 'sekrit' });
  const socksAuthPort = await listen(socksAuth.server);
  const viaAuth = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, NAS_WEBDAV_TIMEOUT_MS: '8000',
    TAILSCALE_SOCKS: `socks5://ts:sekrit@127.0.0.1:${socksAuthPort}`
  });
  ok('a username/password SOCKS proxy authenticates and carries the bytes',
     sha(await viaAuth.get(pdfNas)) === pdfSha);
  ok('...and the proxy saw exactly one auth exchange', socksAuth.state.authAttempts === 1,
     socksAuth.state);
  const viaBadAuth = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, NAS_WEBDAV_TIMEOUT_MS: '5000',
    TAILSCALE_SOCKS: `socks5://ts:wrong@127.0.0.1:${socksAuthPort}`
  });
  const badAuth = await throws(() => viaBadAuth.get(pdfNas));
  ok('a WRONG SOCKS password is a clear 502, not a hang',
     badAuth.threw && badAuth.status === 502 && /rejected the username\/password/.test(badAuth.message),
     badAuth.message);
  const noProxyThere = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, NAS_WEBDAV_TIMEOUT_MS: '4000',
    TAILSCALE_SOCKS: '127.0.0.1:9'
  });
  const noTailscaled = await throws(() => noProxyThere.get(pdfNas));
  ok('tailscaled not running (nothing on the SOCKS port) is a 502 naming the proxy',
     noTailscaled.threw && noTailscaled.status === 502 &&
     /Tailscale SOCKS proxy at 127\.0\.0\.1:9/.test(noTailscaled.message), noTailscaled.message);
  await close(socks.server);
  await close(socksAuth.server);

  // ══════════════════════════════════════════════════════════════════════════
  // THE PROBE. This is the section that exists because of 2026-08-28: a NAS
  // that was perfect on the LAN, a production container that could not move a
  // byte, and an app whose entire diagnostic vocabulary was one sentence. The
  // probe's job is to make the LAYER identifiable, so what is asserted here is
  // not "storage works" — it is "when storage is broken IN THIS PARTICULAR
  // WAY, the report names that way and no other".
  // ══════════════════════════════════════════════════════════════════════════
  section('11b. the storage probe — every layer named, including the liars');
  const { storageProbe } = require('../lib/storage');
  const pSocks = makeSocksServer();
  const pSocksPort = await listen(pSocks.server);
  const pDav = makeDavServer({ root: davRoot, base: '/showrunner', user: USER, pass: PASS, tls: true });
  const pDavPort = await listen(pDav.server);
  const probeEnv = (over = {}) => ({
    STORAGE_DRIVER: 'webdav',
    NAS_WEBDAV_URL: `https://localhost:${pDavPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS,
    TAILSCALE_SOCKS: `127.0.0.1:${pSocksPort}`,
    ...over
  });
  const stepOf = (r, id) => r.steps.find((s) => s.id === id) || {};

  // ── the fault that actually happened ──────────────────────────────────────
  const pMisspelled = await storageProbe({ timeoutMs: 4000, write: false },
    probeEnv({ ALLOW_SELF_SIGNED: '1' }));
  ok('an env var nobody reads (ALLOW_SELF_SIGNED) is reported as IGNORED, by name',
     pMisspelled.config.ignoredEnvVars.some(
       (v) => v.set === 'ALLOW_SELF_SIGNED' && v.meant === 'NAS_WEBDAV_ALLOW_SELF_SIGNED'),
     pMisspelled.config.ignoredEnvVars);
  ok('...and the verdict says it out loud rather than burying it in a field',
     pMisspelled.verdict.some((v) => /IGNORED ENV/.test(v) && /ALLOW_SELF_SIGNED/.test(v)),
     pMisspelled.verdict);
  ok('...and the same var spelled RIGHT is not reported as ignored',
     storageProbe.length >= 0 &&
     (await storageProbe({ timeoutMs: 4000, write: false },
       probeEnv({ NAS_WEBDAV_ALLOW_SELF_SIGNED: '1', ALLOW_SELF_SIGNED: '1' })
     )).config.ignoredEnvVars.length === 0);

  // ── the certificate, measured instead of labelled ─────────────────────────
  const pStrict = await storageProbe({ timeoutMs: 4000, write: false }, probeEnv());
  ok('step 4 completes a TLS handshake and reads the real certificate',
     stepOf(pStrict, 'tls').ok === true && /CN=localhost/.test(stepOf(pStrict, 'tls').detail.subject || ''),
     stepOf(pStrict, 'tls'));
  ok('...and reports wouldVerify:false for a self-signed cert, whatever the config says',
     stepOf(pStrict, 'tls').detail.wouldVerify === false &&
     stepOf(pStrict, 'tls').detail.selfSigned === true, stepOf(pStrict, 'tls').detail);
  ok('...and says the DRIVER will refuse it, because the allowance is not set',
     stepOf(pStrict, 'tls').detail.driverWouldAccept === false);
  ok('...so the verdict blames the certificate and nothing else',
     pStrict.verdict.some((v) => /THE CERTIFICATE IS THE FAULT/.test(v)), pStrict.verdict);
  ok('...and PROPFIND then really fails, with the cert error and not a mystery timeout',
     stepOf(pStrict, 'propfind').ok === false &&
     /SELF_SIGNED|self.signed|UNABLE_TO_VERIFY/i.test(stepOf(pStrict, 'propfind').error || ''),
     stepOf(pStrict, 'propfind').error);
  ok('health\'s old label is quoted next to the measurement that contradicts it',
     pStrict.config.healthTlsLabel === 'system-trust' && pStrict.config.healthTlsLabelIsAProbe === false);

  // ── the whole chain, green ────────────────────────────────────────────────
  const pGood = await storageProbe({ timeoutMs: 6000 },
    probeEnv({ NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' }));
  ok('with the allowance set, all nine steps pass and ok is true',
     pGood.ok === true && ['socks-port', 'socks-greeting', 'socks-connect', 'tls',
       'propfind', 'mkcol', 'put', 'get', 'delete'].every((id) => stepOf(pGood, id).ok === true),
     pGood.steps.map((s) => `${s.n} ${s.id}=${s.ok}`).join(' '));
  ok('...the nine steps keep their numbers, and the cross-check is 3b, not 4',
     stepOf(pGood, 'socks-connect').n === 3 && stepOf(pGood, 'http-connect').n === '3b' &&
     stepOf(pGood, 'tls').n === 4 && stepOf(pGood, 'delete').n === 9);
  ok('...every passing step carries a millisecond figure, because the fast ones ' +
     'are what make the slow one legible',
     ['socks-port', 'socks-connect', 'tls', 'propfind', 'put', 'get', 'delete']
       .every((id) => Number.isFinite(stepOf(pGood, id).ms)),
     pGood.steps.map((s) => `${s.id}=${s.ms}`).join(' '));
  ok('...GET is byte-compared against what PUT sent, not merely counted',
     /byte-identical/.test(stepOf(pGood, 'get').detail || ''), stepOf(pGood, 'get').detail);
  ok('...the SOCKS proxy really carried it (the driver\'s own path, not a shortcut)',
     pGood.transport.used === 'socks5' && pSocks.state.connections > 0);
  ok('...and the verdict is a plain sentence a tired operator can act on',
     pGood.verdict.some((v) => /genuinely live/.test(v)), pGood.verdict);
  ok('the probe leaves NO litter on the share', !fs.existsSync(path.join(davRoot, '_showrunner-probe')),
     fs.readdirSync(davRoot));
  ok('...and says so in the response instead of leaving the operator to check',
     /deleted/.test(String(pGood.cleanup.runDir)), pGood.cleanup);
  ok('the probe response NEVER contains the share password',
     !JSON.stringify(pGood).includes(PASS));

  // ── a pinned CA verifies for real ─────────────────────────────────────────
  const pPinned = await storageProbe({ timeoutMs: 6000 },
    probeEnv({ NAS_WEBDAV_CA: TEST_CERT.toString() }));
  ok('a pinned CA makes wouldVerify TRUE — the probe is measuring, not echoing',
     stepOf(pPinned, 'tls').detail.wouldVerify === true &&
     stepOf(pPinned, 'tls').detail.driverWouldAccept === true, stepOf(pPinned, 'tls').detail);
  ok('...and the nine steps go green through a genuinely verified connection',
     pPinned.ok === true, pPinned.firstFailure);

  // ── each layer breaks alone, and is named alone ───────────────────────────
  const pNoDaemon = await storageProbe({ timeoutMs: 2000 },
    probeEnv({ TAILSCALE_SOCKS: '127.0.0.1:9', NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' }));
  ok('tailscaled down: step 1 fails and steps 2-9 are SKIPPED, not failed',
     stepOf(pNoDaemon, 'socks-port').ok === false &&
     stepOf(pNoDaemon, 'socks-greeting').ok === null && stepOf(pNoDaemon, 'put').ok === null,
     pNoDaemon.steps.map((s) => `${s.id}=${s.ok}`).join(' '));
  ok('...and the verdict names the daemon, not the NAS',
     pNoDaemon.verdict.some((v) => /tailscaled is not accepting/.test(v)), pNoDaemon.verdict);
  ok('...and firstFailure points at step 1',
     pNoDaemon.firstFailure && pNoDaemon.firstFailure.n === 1, pNoDaemon.firstFailure);

  pDav.state.rejectAuth = true;
  const pBadCreds = await storageProbe({ timeoutMs: 4000 },
    probeEnv({ NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' }));
  pDav.state.rejectAuth = false;
  ok('bad credentials: the tunnel and TLS still pass, and PROPFIND is the one that fails',
     stepOf(pBadCreds, 'socks-connect').ok === true && stepOf(pBadCreds, 'tls').ok === true &&
     stepOf(pBadCreds, 'propfind').ok === false && /401/.test(stepOf(pBadCreds, 'propfind').detail || ''),
     stepOf(pBadCreds, 'propfind'));
  ok('...and the error says CREDENTIALS, which is the one thing a 401 means',
     /credentials/i.test(stepOf(pBadCreds, 'propfind').error || ''), stepOf(pBadCreds, 'propfind').error);

  pDav.state.failMkcol = true;
  const pNoWrite = await storageProbe({ timeoutMs: 4000 },
    probeEnv({ NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' }));
  pDav.state.failMkcol = false;
  ok('read-yes/write-no: PROPFIND passes, MKCOL fails, and the verdict says permissions',
     stepOf(pNoWrite, 'propfind').ok === true && stepOf(pNoWrite, 'mkcol').ok === false &&
     pNoWrite.verdict.some((v) => /write permission/.test(v)), pNoWrite.verdict);

  const pReadOnly = await storageProbe({ timeoutMs: 4000, write: false },
    probeEnv({ NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' }));
  ok('write:false stops after PROPFIND and touches nothing',
     stepOf(pReadOnly, 'propfind').ok === true &&
     [ 'mkcol', 'put', 'get', 'delete' ].every((id) => stepOf(pReadOnly, id).ok === null &&
       /read-only/.test(stepOf(pReadOnly, id).detail || '')),
     pReadOnly.steps.map((s) => `${s.id}=${s.ok}`).join(' '));

  // The cross-check that assigns blame. Our test proxy speaks SOCKS5 and
  // nothing else, so HTTP CONNECT must fail HERE and must not derail anything.
  ok('the HTTP CONNECT cross-check fails against a SOCKS-only proxy...',
     stepOf(pGood, 'http-connect').ok === false, stepOf(pGood, 'http-connect'));
  ok('...without stopping the walk, because it is evidence and not a gate',
     stepOf(pGood, 'delete').ok === true && pGood.ok === true);
  ok('a stalled NAS is reported as a per-step timeout with the budget named, ' +
     'not as a 30-second silence',
     await (async () => {
       pDav.state.stallMs = 4000;
       const r = await storageProbe({ timeoutMs: 1200 }, probeEnv({ NAS_WEBDAV_ALLOW_SELF_SIGNED: '1' }));
       pDav.state.stallMs = 0;
       return stepOf(r, 'propfind').ok === false && /1200ms/.test(stepOf(r, 'propfind').error || '');
     })());

  await close(pSocks.server);
  await close(pDav.server);

  // ── and the honesty fix the probe exists to enforce ───────────────────────
  const honest = makeWebdavDriver({
    NAS_WEBDAV_URL: `http://127.0.0.1:${davPort}/showrunner`,
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS
  });
  ok('info().tls no longer says "verified" for a connection nobody made',
     honest.info().tls !== 'verified', honest.info().tls);
  ok('info().ready is labelled as CONFIGURATION, in the payload, next to itself',
     /NOT a connection test/i.test(honest.info().readyMeans || ''), honest.info().readyMeans);
  ok('before any traffic, liveness says "never contacted" instead of implying health',
     honest.info().lastContact === null && /never contacted/.test(honest.info().liveness || ''),
     honest.info().liveness);
  await honest.exists(P('P1-x', 'S1-x', 'spec', 'nope.pdf'));
  ok('...and after one real request it reports a MEASURED contact with a timestamp',
     honest.info().lastContact && honest.info().lastContact.ok === true &&
     /the NAS answered/.test(honest.info().liveness || ''), honest.info().lastContact);
  const deadNas = makeWebdavDriver({
    NAS_WEBDAV_URL: 'http://127.0.0.1:9/showrunner',
    NAS_WEBDAV_USER: USER, NAS_WEBDAV_PASS: PASS, NAS_WEBDAV_TIMEOUT_MS: '2000'
  });
  await throws(() => deadNas.exists(P('P1-x', 'S1-x', 'spec', 'nope.pdf')));
  ok('a NAS that did NOT answer is recorded as such — health can no longer print ready:true ' +
     'over a dead link without the contradiction being visible',
     deadNas.info().lastContact && deadNas.info().lastContact.ok === false &&
     /did NOT answer/.test(deadNas.info().liveness || ''), deadNas.info().lastContact);

  // ══════════════════════════════════════════════════════════════════════════
  section('12. the local driver still honours the same contract');
  const localRoot = path.join(tmp, 'localdriver');
  process.env.STORAGE_ROOT = localRoot;
  // a fresh module instance so STORAGE_ROOT is picked up
  delete require.cache[require.resolve('../lib/storage')];
  const L = require('../lib/storage');
  const local = L.drivers.local;
  const lp = P('P2-local', 'S2-local', 'spec', 'local.pdf');
  ok('local put() writes real bytes', (await local.put(lp, pdf)).size === 364739);
  ok('local get() round-trips the PDF', sha(await local.get(lp)) === pdfSha);
  const lgs = await local.getStream(lp);
  const lstreamed = await new Promise((res, rej) => {
    const c = []; lgs.stream.on('data', (x) => c.push(x));
    lgs.stream.on('end', () => res(Buffer.concat(c))); lgs.stream.on('error', rej);
  });
  ok('local getStream() round-trips the PDF (same method the download route calls)',
     sha(lstreamed) === pdfSha && lgs.size === 364739);
  const lmiss = await throws(() => local.get(P('P2-local', 'nope.pdf')));
  ok('local get() of a missing file is the SAME 404 shape as webdav',
     lmiss.threw && lmiss.status === 404 && /No bytes at/.test(lmiss.message), lmiss);
  const lmissStream = await throws(() => local.getStream(P('P2-local', 'nope.pdf')));
  ok('local getStream() of a missing file is 404 too', lmissStream.status === 404);
  ok('local move() keeps the source-missing shape',
     (await local.move(P('P2-local', 'ghost.pdf'), lp)).reason === 'source-missing');
  ok('local mkdirs() exists so both drivers answer the same calls',
     (await local.mkdirs(P('P2-local', 'S2-local', 'photo', 'x.jpg'))).ok === true);
  // restore the webdav module instance for the route section
  delete require.cache[require.resolve('../lib/storage')];
  process.env.STORAGE_ROOT = localRoot;
  require('../lib/storage');

  // ══════════════════════════════════════════════════════════════════════════
  // 13. THE REAL ROUTES — needs a database
  // ══════════════════════════════════════════════════════════════════════════
  if (!process.env.DATABASE_URL) {
    section('13. byte routes — SKIPPED (no DATABASE_URL)');
    console.log('  ! set DATABASE_URL to a scratch database to run PUT/GET /api/files/:id/content');
    console.log('  ! against the real server with STORAGE_DRIVER=webdav. See SMOKE.md.');
  } else {
    section('13. byte routes — the real server, STORAGE_DRIVER=webdav');
    // PORT is read at server.js module scope, so it has to be set BEFORE the
    // require — and it defaults to an EPHEMERAL port so this suite can never
    // collide with a Showrunner someone has running on 3100.
    process.env.PORT = process.env.STORAGE_TEST_PORT || '0';
    const { pool } = require('../lib/db');
    const { boot } = require('../server');
    const server = await boot();
    BASE = `http://127.0.0.1:${server.address().port}`;
    const TAG = 'stor' + Date.now().toString(36);

    const health = await call('GET', '/api/health');
    ok('GET /api/health reports the webdav driver',
       health.body.storage === 'webdav', health.body);
    ok('...and reports it READY, with the target host and share',
       health.body.storageReady === true &&
       String(health.body.storageTarget).includes(String(davPort)), health.body);
    ok('...and never the credentials',
       !JSON.stringify(health.body).includes(PASS), health.body);
    const cfg = await call('GET', '/api/config');
    ok('GET /api/config tells the SPA uploads are available',
       cfg.body.features && cfg.body.features.fileUpload === true, cfg.body.features);

    const A = (await call('POST', '/api/auth/login',
      { body: { username: 'admin', password: process.env.ADMIN_PASSWORD || 'e360admin' } })).body.token;
    ok('admin login', !!A);
    const pmUser = TAG + 'pm', otherUser = TAG + 'other';
    await call('POST', '/api/users', { token: A, body: { username: pmUser, password: 'storpass123', role: 'pm', name: 'PM' } });
    await call('POST', '/api/users', { token: A, body: { username: otherUser, password: 'storpass123', role: 'tech', name: 'OTHER' } });
    const PMT = (await call('POST', '/api/auth/login', { body: { username: pmUser, password: 'storpass123' } })).body.token;
    const OTH = (await call('POST', '/api/auth/login', { body: { username: otherUser, password: 'storpass123' } })).body.token;

    const proj = (await call('POST', '/api/projects', { token: A,
      body: { name: TAG + ' Big Ten vs SEC Volleyball Challenge', type: 'led', owner: pmUser } })).body;
    const show = (await call('POST', '/api/shows', { token: A,
      body: { project_id: proj.id, name: TAG + ' Wrigley Field', venue: 'Wrigley Field',
              date: '2026-09-12' } })).body;
    ok('fixture project + show created', !!proj.id && !!show.id, { proj: proj.id, show: show.id });

    const fileRow = (await call('POST', '/api/files', { token: A, body: {
      show_id: show.id, name: '00_e360_BigTen_SEC_v01_080726_100pm', ext: 'pdf',
      kind: 'spec', spec_type: 'e360',
      // deliberately WRONG, the way commitAddFile used to stamp them (HARDENING 21)
      size: 421888, dim: 'content layout'
    } })).body;
    ok('POST /api/files returns an upload_url',
       fileRow.upload_url === `/api/files/${fileRow.id}/content`, fileRow.upload_url);
    ok('the server derived nas_path — the client never supplied one',
       /P\d+-.*\\S\d+-.*\\spec\\00_e360_BigTen_SEC_v01_080726_100pm\.pdf$/.test(fileRow.nas_path),
       fileRow.nas_path);

    // ── PUT ────────────────────────────────────────────────────────────────
    const noAuthPut = await call('PUT', `/api/files/${fileRow.id}/content`, { raw: pdf });
    ok('PUT /content without a session is 401', noAuthPut.status === 401);
    const wrongUser = await call('PUT', `/api/files/${fileRow.id}/content`, { token: OTH, raw: pdf });
    ok('PUT /content by someone who is neither pm on the folder nor the uploader is 403',
       wrongUser.status === 403, wrongUser.body);
    const emptyPut = await call('PUT', `/api/files/${fileRow.id}/content`, { token: A, raw: Buffer.alloc(0) });
    ok('an empty body is 400, not a zero-byte file on the NAS', emptyPut.status === 400, emptyPut.body);

    const up = await call('PUT', `/api/files/${fileRow.id}/content`, { token: A, raw: pdf });
    ok('PUT /api/files/:id/content uploads the real Big Ten PDF',
       up.status === 200 && up.body.ok === true && up.body.size === 364739, up.body);
    ok('...reporting the nas_path it wrote to', up.body.nas_path === fileRow.nas_path, up.body);
    ok('...and the sha it stored, so the caller can verify without a second GET',
       up.body.sha256 === pdfSha, up.body);

    const davDisk = path.join(davRoot, ...fileRow.nas_path
      .replace(S.NAS_ROOT, '').split('\\').filter(Boolean));
    ok('the bytes really reached the WebDAV server (read straight off its disk)',
       fs.existsSync(davDisk) && sha(fs.readFileSync(davDisk)) === pdfSha, davDisk);

    const after = (await call('GET', `/api/files/${fileRow.id}`, { token: A })).body;
    ok('HARDENING 21: the fabricated size is REPLACED by the real byte count',
       Number(after.size) === 364739, after.size);
    ok('HARDENING 21: the fabricated dim is cleared, not left as fiction',
       after.dim === null || after.dim === '' || after.dim === undefined, after.dim);
    const actRow = await pool.query(
      `SELECT action, detail FROM activity WHERE show_id=$1 AND action='file.upload'`, [show.id]);
    ok('the upload is on the activity trail', actRow.rows.length === 1, actRow.rows);

    // ── GET ────────────────────────────────────────────────────────────────
    const noAuthGet = await call('GET', `/api/files/${fileRow.id}/content`);
    ok('GET /content without a session is 401', noAuthGet.status === 401);
    const dl = await call('GET', `/api/files/${fileRow.id}/content`, { token: OTH });
    ok('GET /content is readable by any signed-in user (this is how a remote ' +
       'user gets the file THROUGH the app)', dl.status === 200, dl.status);
    ok('...and it is byte-identical to the file on Tom\'s disk', sha(dl.bytes) === pdfSha);
    ok('...with the right content-type', String(dl.headers.get('content-type')).includes('application/pdf'),
       dl.headers.get('content-type'));
    ok('...with a Content-Length', Number(dl.headers.get('content-length')) === 364739,
       dl.headers.get('content-length'));
    ok('...and an attachment filename a browser will save correctly',
       /attachment/.test(String(dl.headers.get('content-disposition'))) &&
       /00_e360_BigTen_SEC_v01_080726_100pm\.pdf/.test(String(dl.headers.get('content-disposition'))),
       dl.headers.get('content-disposition'));
    const inline = await call('GET', `/api/files/${fileRow.id}/content?inline=1`, { token: A });
    ok('?inline=1 switches to inline so the viewer can embed a PDF',
       /inline/.test(String(inline.headers.get('content-disposition'))),
       inline.headers.get('content-disposition'));

    const ghost = (await call('POST', '/api/files', { token: A,
      body: { show_id: show.id, name: 'never uploaded', ext: 'pdf', kind: 'other' } })).body;
    const ghostGet = await call('GET', `/api/files/${ghost.id}/content`, { token: A });
    ok('a metadata row with no bytes is a 404 that says so, not a 500',
       ghostGet.status === 404 && /No bytes at/.test(JSON.stringify(ghostGet.body)), ghostGet.body);
    const noRow = await call('GET', '/api/files/99999999/content', { token: A });
    ok('an unknown file id is 404', noRow.status === 404);

    // ── the NAS going away mid-session ─────────────────────────────────────
    dav.state.rejectAuth = true;
    const nasDown = await call('GET', `/api/files/${fileRow.id}/content`, { token: A });
    ok('a NAS that refuses the credential surfaces as a 502 to the browser, ' +
       'never a 200 with an empty body', nasDown.status === 502, nasDown);
    const nasDownPut = await call('PUT', `/api/files/${fileRow.id}/content`, { token: A, raw: pdf });
    ok('...and an upload against it is a 502 too', nasDownPut.status === 502, nasDownPut.body);
    const sizeStill = (await call('GET', `/api/files/${fileRow.id}`, { token: A })).body;
    ok('...and the FAILED upload did not corrupt the size the successful one recorded',
       Number(sizeStill.size) === 364739, sizeStill.size);
    dav.state.rejectAuth = false;
    const recovered = await call('GET', `/api/files/${fileRow.id}/content`, { token: A });
    ok('...and the download works again the moment the NAS comes back',
       recovered.status === 200 && sha(recovered.bytes) === pdfSha);

    // ── cleanup ────────────────────────────────────────────────────────────
    await pool.query('DELETE FROM projects WHERE id=$1', [proj.id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [TAG + '%']).catch(() => {});
    await new Promise((r) => server.close(r));
    await pool.end().catch(() => {});
  }

  await close(dav.server);
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:'); failures.forEach((f) => console.log('    - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nstorage-test aborted:', e);
  process.exit(3);
});
