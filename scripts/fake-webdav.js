// ════════════════════════════════════════════════════════════════════════════
// scripts/fake-webdav.js — the fake NAS: a real WebDAV server with bad days
// ────────────────────────────────────────────────────────────────────────────
// Lifted out of scripts/storage-test.js on 2026-09-17, unchanged, because the
// smoke suite needs the same fake: lib/backup.js's nightly dump is the write a
// poisoned Synology worker killed on 9/15 and 9/17, and proving that it now
// rides past one takes a NAS that can wedge on demand. Two fakes would drift
// apart; this is the one, and storage-test.js drives it exactly as before.
//
// Test infrastructure: never mounted by server.js, never imported by
// production code.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

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
    dsmMkcol500: false,      // DSM dialect: 500 (not 405) for MKCOL on an existing collection (live, 9/11)
    dsmPut500: false,        // DSM dialect: 500 (not 409) for PUT into a missing collection (live, 9/11, act three)
    outOfSpace: false,       // answer 507 to PUT (share full)
    // ── THE POISONED WORKER (live, 9/17) ──────────────────────────────────
    // A DSM Apache worker whose setuid failed answers everything it is handed
    // with 424 "Set uid or gid error" (or 500 carrying the same text on a
    // write verb), having done NO work. Modelled PER PATH: a path listed here
    // wedges on its FIRST hit and is then healthy, which is what the LAN
    // forensics showed — the next request on a new connection gets a fresh
    // worker. `wedgeAlways` is the NAS that is wedged everywhere, the case the
    // one-retry cap has to survive.
    wedgePaths: new Set(),   // decoded paths that wedge once
    wedgeAlways: false,      // every request wedges
    wedgeStatus: 424,        // 424 is the live signature; 500 + body is the other dialect
    wedgeHits: 0,            // how many wedge answers this server has given
    wedgeSeen: new Map(),    // method+path -> attempts, the runaway guard below
    wedgeRunaway: false,     // set when one request is attempted a THIRD time
    // A caller that cannot know the path in advance — the nightly dump carries
    // a minute-resolution timestamp in its name — arms by PREDICATE instead: a
    // request the predicate accepts is turned into a wedgePaths entry just
    // below, so the hit count, the runaway guard and the heal-on-retry behave
    // exactly as if the path had been listed by hand. Count inside the
    // predicate to wedge one attempt; match every time to wedge them all.
    wedgeWhen: null,         // (method, decodedPath) => true
    // The ambiguous one: a poisoned worker whose lock-database failure carried
    // no signature at all — a bare 500 that reads exactly like DSM's
    // exists-dialect. First hit of the path only.
    bare500Paths: new Set(),
    connections: 0           // TCP connections accepted — "the retry rode a FRESH one"
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
  function responseXml(href, st) {
    const isDir = st.isDirectory();
    return '<D:response>' +
      `<D:href>${href}</D:href><D:propstat><D:prop>` +
      `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
      (isDir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength>`) +
      `<D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified>` +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '</D:response>';
  }
  function propfindXml(href, st) {
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:multistatus xmlns:D="DAV:">' + responseXml(href, st) + '</D:multistatus>';
  }

  const handler = async (req, res) => {
    // `conn` is the identity of the TCP connection the request arrived on —
    // the only way to assert "the retry rode a FRESH connection" from here,
    // because a keep-alive socket carries many requests.
    state.requests.push({ method: req.method, path: req.url,
                          conn: req.socket ? req.socket._connId : null });
    const send = (code, body, headers) => {
      const finish = () => {
        res.writeHead(code, headers || {});
        res.end(body || '');
      };
      if (state.stallMs) setTimeout(finish, state.stallMs);
      else finish();
    };
    // The wedge answers BEFORE anything else, credentials included: a worker
    // that cannot become the share's owner never gets as far as the request.
    const wedgePath = decodeURIComponent(req.url.split('?')[0]);
    if (state.wedgeWhen && state.wedgeWhen(req.method, wedgePath)) state.wedgePaths.add(wedgePath);
    if (state.wedgeAlways || state.wedgePaths.has(wedgePath)) {
      const seenKey = req.method + ' ' + wedgePath;
      const n = (state.wedgeSeen.get(seenKey) || 0) + 1;
      state.wedgeSeen.set(seenKey, n);
      // A THIRD attempt at the same request is the runaway the driver's
      // one-retry cap exists to prevent. The fake refuses to sustain it, so a
      // driver that retried forever fails this suite with a line rather than
      // hanging it.
      if (n > 2) state.wedgeRunaway = true;
      else {
        state.wedgePaths.delete(wedgePath);
        state.wedgeHits += 1;
        await drain(req);
        return send(state.wedgeStatus, 'Set uid or gid error\n');
      }
    }
    if (state.bare500Paths.has(wedgePath)) {
      state.bare500Paths.delete(wedgePath);
      await drain(req);
      return send(500, 'Internal Server Error');
    }
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
          // Depth:1 on a collection answers self + children, per RFC 4918 —
          // the shape Synology sends and the driver's list() parses. Depth:0
          // (and Depth:1 on a plain file) keeps the single-response answer.
          const depth = String(req.headers.depth || '0');
          if (depth === '1' && st.isDirectory()) {
            const kids = await fsp.readdir(t.disk);
            let body = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' +
              responseXml(req.url, st);
            for (const k of kids) {
              const kst = await fsp.stat(path.join(t.disk, k));
              body += responseXml(req.url.split('?')[0].replace(/\/+$/, '') + '/' + encodeURIComponent(k), kst);
            }
            body += '</D:multistatus>';
            return send(207, body, { 'Content-Type': 'application/xml; charset=utf-8' });
          }
          return send(207, propfindXml(req.url, st),
            { 'Content-Type': 'application/xml; charset=utf-8' });
        }
        case 'MKCOL': {
          await drain(req);
          if (state.failMkcol) return send(409, 'refused');
          if (fs.existsSync(t.disk)) return send(state.dsmMkcol500 ? 500 : 405, 'exists');
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
          if (!fs.existsSync(parent)) return send(state.dsmPut500 ? 500 : 409, 'no collection');
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
  // Counted and STAMPED here and nowhere else: a keep-alive socket carries
  // many requests, so "a NEW connection" is only observable at the TCP level.
  let connSeq = 0;
  server.on('connection', (sock) => { state.connections += 1; sock._connId = ++connSeq; });
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

module.exports = { makeDavServer, drain, readBody, listen, close, TEST_CERT, TEST_KEY };
