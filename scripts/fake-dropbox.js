// ════════════════════════════════════════════════════════════════════════════
// scripts/fake-dropbox.js — a local stand-in for the Dropbox API
// ────────────────────────────────────────────────────────────────────────────
// The suites must prove the integration against SOMETHING, and the real
// Dropbox API is off the table by hard rule (no credentialed production
// calls). This is a minimal in-memory express app implementing exactly the
// endpoint surface lib/dropbox.js drives — RPC + content endpoints + file
// requests — with the behaviours that shaped the client:
//
//   · /oauth2/token issues short-lived access tokens from the refresh token
//     (state.tokenGrants counts them — the cache assertion reads it);
//   · error bodies can be PLAIN TEXT (seed.failOnce) — the never-.json()-
//     blind rule exists because of exactly that;
//   · missing_scope is a 401 with Dropbox's own error shape, per-scope
//     (seed.missingScopes) — how the dynamic-degradation path is proven;
//   · /2/files/download honours HTTP Range and LOGS every byte served
//     (state.downloads) — the probe's byte budget is asserted off that log;
//   · /2/files/delete_v2 exists ONLY to count: state.deletes is the
//     unlink-touches-nothing invariant's witness. A buggy unlink is counted,
//     never 404-hidden.
//
// FIXTURES: the two MP4s are REAL ffmpeg output committed under
// scripts/fixtures/ (a faststart one and one with moov at the tail, mdat
// bigger than the probe's head window, so the ranged mdat-hop is exercised
// against genuine encoder bytes, not a hand-built atom the parser's own
// author invented). The PNG is constructed here — IHDR is a fixed format and
// the dims are the test's point.
//
// This file is test infrastructure: never mounted by server.js, never
// imported by production code.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURES = path.join(__dirname, 'fixtures');
const SCOPE_FOR = {
  '/2/files/list_folder': 'files.metadata.read',
  '/2/files/list_folder/continue': 'files.metadata.read',
  '/2/files/get_metadata': 'files.metadata.read',
  '/2/files/download': 'files.content.read',
  '/2/files/upload': 'files.content.write',
  '/2/files/delete_v2': 'files.content.write',
  '/2/file_requests/list_v2': 'file_requests.read',
  '/2/file_requests/get': 'file_requests.read',
  '/2/file_requests/create': 'file_requests.write'
};

// a real PNG: signature + IHDR (the dims under test) + a token IDAT + IEND
function pngFixture(w, h) {
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolor
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function startFakeDropbox({ appKey = 'fake-key', appSecret = 'fake-secret',
                            refreshToken = 'fake-refresh' } = {}) {
  const state = {
    tokenGrants: 0,
    deletes: 0,                    // the unlink invariant's witness
    uploads: [],                   // { path, size }
    downloads: [],                 // { path, start, end, bytes, ranged }
    inflightDownloads: 0,          // content requests currently being served
    maxInflightDownloads: 0,       // …and the high-water mark: the auto-probe
                                   // pass's two-lane cap is asserted off this
    downloadDelayMs: 0,            // seed.downloadDelay() — overlap is only
                                   // observable while a response is held open
    entries: new Map(),            // path_lower -> entry
    fileRequests: [],
    missingScopes: new Set(),
    failures: [],                  // one-shot canned faults, FIFO
    pageSize: 1000,
    cursors: new Map(),
    nextId: 1
  };
  const sessions = new Set();
  const lower = (p) => String(p || '').toLowerCase();

  function putEntry(p, e) { state.entries.set(lower(p), e); }
  function ensureFolders(p) {
    const segs = String(p).split('/').filter(Boolean);
    let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      if (!state.entries.has(lower(cur))) {
        putEntry(cur, { tag: 'folder', name: s, path_display: cur });
      }
    }
  }
  function entryJson(e, withMedia) {
    const out = { '.tag': e.tag, name: e.name, path_display: e.path_display,
                  path_lower: lower(e.path_display) };
    if (e.tag === 'file') {
      out.size = e.size;
      out.server_modified = e.server_modified;
      out.rev = e.rev;
      if (withMedia && e.mediaPending) out.media_info = { '.tag': 'pending' };
      else if (withMedia && e.media) {
        out.media_info = { '.tag': 'metadata', metadata: {
          '.tag': e.media.kind || 'video',
          dimensions: e.media.w ? { width: e.media.w, height: e.media.h } : undefined,
          ...(e.media.durMs ? { duration: e.media.durMs } : {})
        } };
      }
    }
    return out;
  }

  const app = express();
  // Dropbox RPC takes JSON; the content endpoints take raw octets with the
  // arg in a header; the token endpoint is urlencoded. All three, scoped.
  app.use('/oauth2', express.urlencoded({ extended: false }));
  app.use('/2/files/upload', express.raw({ type: () => true, limit: '200mb' }));
  app.use('/2', express.json({ limit: '2mb' }));

  // ── auth ──────────────────────────────────────────────────────────────────
  app.post('/oauth2/token', (req, res) => {
    const b = req.body || {};
    state.tokenGrants += 1;
    if (b.grant_type !== 'refresh_token' || b.refresh_token !== refreshToken ||
        b.client_id !== appKey || b.client_secret !== appSecret) {
      return res.status(400).json({ error: 'invalid_grant',
        error_description: 'refresh token or app credentials are wrong' });
    }
    const tok = 'fake-dbx-at-' + Math.random().toString(36).slice(2);
    sessions.add(tok);
    res.json({ access_token: tok, token_type: 'bearer', expires_in: 14400 });
  });

  // one gate for every /2/* route: bearer token, scope, canned faults.
  // NB: inside app.use('/2', …) express strips the mount from req.path, so
  // the full route is baseUrl + path — the scope map keys on the full form.
  app.use('/2', (req, res, next) => {
    const full = req.baseUrl + req.path;
    // canned one-shot faults first — how the plain-text error body is proven
    const fi = state.failures.findIndex((f) => full.startsWith(f.match));
    if (fi >= 0) {
      const f = state.failures.splice(fi, 1)[0];
      res.status(f.status || 500).type(f.contentType || 'text/plain').send(f.body);
      return;
    }
    const auth = String(req.headers.authorization || '');
    const tok = auth.replace(/^Bearer\s+/, '');
    if (!tok || !sessions.has(tok)) {
      return res.status(401).json({
        error_summary: 'expired_access_token/...',
        error: { '.tag': 'expired_access_token' }
      });
    }
    const scope = SCOPE_FOR[full];
    if (scope && state.missingScopes.has(scope)) {
      return res.status(401).json({
        error_summary: `missing_scope/${scope}/...`,
        error: { '.tag': 'missing_scope', required_scope: scope }
      });
    }
    next();
  });

  const pathNotFound = (res) => res.status(409).json({
    error_summary: 'path/not_found/...',
    error: { '.tag': 'path', path: { '.tag': 'not_found' } }
  });

  // ── files ─────────────────────────────────────────────────────────────────
  function childrenOf(p) {
    const parent = lower(p);
    const out = [];
    for (const e of state.entries.values()) {
      const el = lower(e.path_display);
      if (!parent) {
        if (el.lastIndexOf('/') === 0 && el.length > 1) out.push(e);
      } else if (el.startsWith(parent + '/') && !el.slice(parent.length + 1).includes('/')) {
        out.push(e);
      }
    }
    return out;
  }
  function page(list, withMedia) {
    const first = list.slice(0, state.pageSize).map((e) => entryJson(e, withMedia));
    const rest = list.slice(state.pageSize);
    if (!rest.length) return { entries: first, has_more: false, cursor: 'c-' + state.nextId++ };
    const cursor = 'c-' + state.nextId++;
    state.cursors.set(cursor, { rest, withMedia });
    return { entries: first, has_more: true, cursor };
  }
  app.post('/2/files/list_folder', (req, res) => {
    const b = req.body || {};
    const p = String(b.path || '');
    if (p && !state.entries.has(lower(p))) return pathNotFound(res);
    if (p && state.entries.get(lower(p)).tag !== 'folder') return pathNotFound(res);
    res.json(page(childrenOf(p), !!b.include_media_info));
  });
  app.post('/2/files/list_folder/continue', (req, res) => {
    const c = state.cursors.get((req.body || {}).cursor);
    if (!c) return res.status(409).json({ error_summary: 'reset/...', error: { '.tag': 'reset' } });
    state.cursors.delete((req.body || {}).cursor);
    res.json(page(c.rest, c.withMedia));
  });
  app.post('/2/files/get_metadata', (req, res) => {
    const b = req.body || {};
    const e = state.entries.get(lower(b.path));
    if (!e) return pathNotFound(res);
    res.json(entryJson(e, !!b.include_media_info));
  });

  const apiArg = (req) => {
    try { return JSON.parse(req.headers['dropbox-api-arg'] || '{}'); }
    catch { return {}; }
  };
  app.post('/2/files/download', (req, res) => {
    const arg = apiArg(req);
    const e = state.entries.get(lower(arg.path));
    if (!e || e.tag !== 'file') return pathNotFound(res);
    const bytes = e.bytes || Buffer.alloc(0);
    const range = String(req.headers.range || '');
    const m = range.match(/^bytes=(\d+)-(\d+)?$/);
    let start = 0;
    let end = e.size - 1;
    if (m) {
      start = parseInt(m[1], 10);
      end = m[2] !== undefined ? parseInt(m[2], 10) : e.size - 1;
    }
    // serve what actually exists (a fixture may DECLARE more than it holds —
    // the huge-moov budget case); the log records what was ASKED and served
    const slice = bytes.subarray(Math.min(start, bytes.length), Math.min(end + 1, bytes.length));
    state.downloads.push({ path: e.path_display, start, end, bytes: end - start + 1,
                           served: slice.length, ranged: !!m });
    // in-flight accounting: with a seeded delay the response stays open long
    // enough for genuinely concurrent requests to OVERLAP here, and the
    // high-water mark becomes the witness for the client's two-lane cap
    state.inflightDownloads += 1;
    if (state.inflightDownloads > state.maxInflightDownloads) {
      state.maxInflightDownloads = state.inflightDownloads;
    }
    const answer = () => {
      state.inflightDownloads -= 1;
      res.status(m ? 206 : 200)
        .set('Dropbox-API-Result', JSON.stringify(entryJson(e, false)))
        .set('Content-Type', 'application/octet-stream');
      if (m) res.set('Content-Range', `bytes ${start}-${end}/${e.size}`);
      res.send(slice);
    };
    if (state.downloadDelayMs > 0) setTimeout(answer, state.downloadDelayMs);
    else answer();
  });
  app.post('/2/files/upload', (req, res) => {
    const arg = apiArg(req);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let p = String(arg.path || '');
    if (!p) return res.status(400).type('text/plain')
      .send('Error in call to API function "files/upload": missing path');
    // autorename, like the real thing — a deposit never eats a file
    if (state.entries.has(lower(p)) && arg.autorename) {
      const dot = p.lastIndexOf('.');
      p = dot > 0 ? `${p.slice(0, dot)} (1)${p.slice(dot)}` : `${p} (1)`;
    }
    ensureFolders(p.split('/').slice(0, -1).join('/'));
    const entry = { tag: 'file', name: p.split('/').pop(), path_display: p,
                    size: body.length, bytes: body,
                    server_modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
                    rev: 'r' + state.nextId++ };
    putEntry(p, entry);
    state.uploads.push({ path: p, size: body.length });
    res.json(entryJson(entry, false));
  });
  // exists ONLY to count — the unlink invariant's witness
  app.post('/2/files/delete_v2', (req, res) => {
    const b = req.body || {};
    state.deletes += 1;
    const e = state.entries.get(lower(b.path));
    if (!e) return pathNotFound(res);
    state.entries.delete(lower(b.path));
    res.json({ metadata: entryJson(e, false) });
  });

  // ── file requests ─────────────────────────────────────────────────────────
  app.post('/2/file_requests/list_v2', (req, res) => {
    res.json({ file_requests: state.fileRequests.slice(), has_more: false, cursor: '' });
  });
  app.post('/2/file_requests/get', (req, res) => {
    const fr = state.fileRequests.find((r) => r.id === (req.body || {}).id);
    if (!fr) return res.status(409).json({ error_summary: 'not_found/..', error: { '.tag': 'not_found' } });
    res.json(fr);
  });
  app.post('/2/file_requests/create', (req, res) => {
    const b = req.body || {};
    const fr = { id: 'FR' + state.nextId++, url: 'https://www.dropbox.com/request/FAKE' + state.nextId,
                 title: b.title || '', destination: b.destination || '', is_open: true, file_count: 0 };
    state.fileRequests.push(fr);
    // faithfully: Dropbox does NOT create the destination folder until the
    // first upload lands — which is why the listing route's "not created
    // yet" note exists
    res.json(fr);
  });

  // ── seed helpers ──────────────────────────────────────────────────────────
  const seed = {
    folder(p) { ensureFolders(p); return state.entries.get(lower(p)); },
    // `bytes` a Buffer, or a number to declare a size with no real bytes
    // (the huge-moov budget case declares 50 MB and holds 24 B)
    file(p, bytes, opts = {}) {
      ensureFolders(p.split('/').slice(0, -1).join('/'));
      const buf = Buffer.isBuffer(bytes) ? bytes : null;
      const e = { tag: 'file', name: p.split('/').pop(), path_display: p,
                  size: opts.size != null ? opts.size : (buf ? buf.length : Number(bytes) || 0),
                  bytes: buf,
                  server_modified: opts.server_modified || '2026-09-10T12:00:00Z',
                  rev: opts.rev || 'r' + state.nextId++,
                  media: opts.media || null, mediaPending: !!opts.mediaPending };
      putEntry(p, e);
      return e;
    },
    remove(p) { state.entries.delete(lower(p)); },
    fileRequest(fields = {}) {
      const fr = { id: 'FR' + state.nextId++, url: 'https://www.dropbox.com/request/SEED' + state.nextId,
                   title: 'seeded request', destination: '/File requests/seeded', is_open: true,
                   file_count: 0, ...fields };
      state.fileRequests.push(fr);
      return fr;
    },
    missingScopes(list) { state.missingScopes = new Set(list || []); },
    failOnce(match, { status = 500, contentType = 'text/plain', body = 'Dropbox is on fire' } = {}) {
      state.failures.push({ match, status, contentType, body });
    },
    expireTokens() { sessions.clear(); },
    pageSize(n) { state.pageSize = n; },
    // hold each content response open for `ms` — concurrency only shows
    // itself while a response is in flight (handlers here are otherwise
    // same-tick, and same-tick concurrency reads as 1 forever)
    downloadDelay(ms) { state.downloadDelayMs = Math.max(0, Number(ms) || 0); },
    // fixtures — real encoder output for the MP4s (see header)
    png: pngFixture,
    faststartMp4: () => fs.readFileSync(path.join(FIXTURES, 'faststart.mp4')),
    tailmoovMp4: () => fs.readFileSync(path.join(FIXTURES, 'tailmoov.mp4')),
    garbage: (n = 4096) => Buffer.alloc(n, 0x55),
    hugeMoovHeader: () => Buffer.concat([
      (() => { const b = Buffer.alloc(16); b.writeUInt32BE(16, 0); b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1'); return b; })(),
      (() => { const b = Buffer.alloc(8); b.writeUInt32BE(50 * 1024 * 1024, 0); b.write('moov', 4, 'latin1'); return b; })()
    ])
  };

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        seed,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { startFakeDropbox };
