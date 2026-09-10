// ════════════════════════════════════════════════════════════════════════════
// lib/dropbox.js — the Dropbox client
// ────────────────────────────────────────────────────────────────────────────
// Tom (2026-09-10): "Will need the deliverables to be able to connect file
// request folders to shows, as well as regular ones. … we have incoming files
// from clients, deliverables to clients, and lastly deliverables to person
// running the show." Dropbox is where the content BYTES live; Showrunner
// tracks them. This module is the ONLY place that speaks to Dropbox — the
// lib/scheduler.js rule, applied to the second external service.
//
// AUTH — server-side app credentials, the offline refresh-token flow:
//   DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN. The refresh
//   token is exchanged at POST /oauth2/token for a short-lived (~4 h) access
//   token, cached here for its own reported lifetime minus a 5-minute margin
//   and refreshed once on a 401 — the same cache-and-retry shape as the
//   scheduler's login token, because it is the same problem.
//
//   Any of the three unset ⇒ every call is the honest 501 naming them.
//
// SCOPES ARE DYNAMIC, NEVER ASSUMED. The authorization the token carries is
// the team admin's decision, not ours, and it can change under a running
// deploy (it did: read-only on 9/10 morning, full by evening). So nothing
// here hardcodes "we can/can't" — when Dropbox answers `missing_scope`, the
// call degrades to a NAMED 501 saying which capability the authorization
// lacks and that a re-authorize fixes it; when the scope exists, the same
// call simply works. Self-healing by construction.
//
// ERROR BODIES ARE OFTEN PLAIN TEXT. Dropbox answers some faults (bad API-Arg
// headers, malformed requests) as text/plain, not JSON — .json()ing a
// response blind is the exact bug that bit the first integration attempt
// tonight. Every response here is read as TEXT first and parsed only if it
// parses; the raw text survives into the error message either way.
//
// TESTS: DROPBOX_API_BASE / DROPBOX_CONTENT_BASE override the two hosts and
// exist ONLY so the suites can point this module at scripts/fake-dropbox.js.
// Production never sets them; every env var here is read at CALL time so the
// suites can wire and unwire the fake mid-run.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const DROPBOX_TIMEOUT_MS = () => parseInt(process.env.DROPBOX_TIMEOUT_MS || '20000', 10);
// content ops move real bytes; they get a longer leash
const DROPBOX_CONTENT_TIMEOUT_MS = () => parseInt(process.env.DROPBOX_CONTENT_TIMEOUT_MS || '120000', 10);

const apiBase = () => String(process.env.DROPBOX_API_BASE || 'https://api.dropboxapi.com').replace(/\/+$/, '');
const contentBase = () => String(process.env.DROPBOX_CONTENT_BASE || 'https://content.dropboxapi.com').replace(/\/+$/, '');

// ── configuration ───────────────────────────────────────────────────────────
function dropboxConfigured() {
  return !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET &&
            process.env.DROPBOX_REFRESH_TOKEN);
}
function notConfigured() {
  const e = new Error(
    'Dropbox is not configured on this server: set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and ' +
    'DROPBOX_REFRESH_TOKEN (the server-side app credentials + offline refresh token). ' +
    'Until then every Dropbox affordance answers this instead of pretending.');
  e.status = 501;
  e.code = 'DROPBOX_NOT_CONFIGURED';
  return e;
}
// The dynamic-scope refusal — raised ONLY when Dropbox itself answered
// missing_scope, never from a local assumption about what the token carries.
function missingScope(scope) {
  const e = new Error(
    `The connected Dropbox authorization doesn't include ${scope} — ` +
    're-authorize with the added permissions once the team admin approves the app.');
  e.status = 501;
  e.code = 'DROPBOX_MISSING_SCOPE';
  e.scope = scope;
  return e;
}

// ── transport ───────────────────────────────────────────────────────────────
// One fetch with a timeout that NEVER .json()s blind: text first, parse if it
// parses, keep both. `wantBytes` is for the download path, where a 2xx body is
// octets and an error body is still text-or-JSON.
async function rawFetch(url, options = {}, { timeoutMs, wantBytes = false } = {}) {
  const budget = timeoutMs || DROPBOX_TIMEOUT_MS();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(err && err.name === 'AbortError'
      ? `Dropbox request timed out after ${budget}ms: ${url}`
      : `Dropbox unreachable: ${err && err.message ? err.message : err}`);
    e.status = 502;
    e.code = 'DROPBOX_UNREACHABLE';
    throw e;
  }
  clearTimeout(timer);
  if (wantBytes && res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, bytes: buf,
             resultHeader: res.headers.get('dropbox-api-result') || '' };
  }
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { ok: res.ok, status: res.status, body, text };
}

// ── the token cache ─────────────────────────────────────────────────────────
let _tok = null;
let _exp = 0;
async function dropboxToken(force) {
  if (!force && _tok && Date.now() < _exp) return _tok;
  if (!dropboxConfigured()) throw notConfigured();
  const r = await rawFetch(apiBase() + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(process.env.DROPBOX_REFRESH_TOKEN).trim(),
      client_id: String(process.env.DROPBOX_APP_KEY).trim(),
      client_secret: String(process.env.DROPBOX_APP_SECRET).trim()
    }).toString()
  });
  if (!r.ok || !r.body || !r.body.access_token) {
    const detail = r.body && r.body.error_description ? r.body.error_description
      : typeof r.body === 'string' ? r.body.slice(0, 200)
      : r.body ? JSON.stringify(r.body).slice(0, 200) : '';
    const e = new Error(`Dropbox token refresh failed: ${r.status}${detail ? ' — ' + detail : ''}` +
      (r.status === 400 || r.status === 401 ? ' (check DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN)' : ''));
    e.status = 502;
    throw e;
  }
  _tok = r.body.access_token;
  const ttlS = Number(r.body.expires_in) || 4 * 3600;
  _exp = Date.now() + Math.max(60, ttlS - 300) * 1000;    // 5-min margin inside their TTL
  return _tok;
}
function dropboxResetToken() { _tok = null; _exp = 0; }

// Dropbox requires non-ASCII in the Dropbox-API-Arg header to be \u-escaped
// (HTTP headers are latin-1); real client/venue folder names carry em dashes
// and accents, so this is not theoretical.
function headerSafeJson(obj) {
  const s = JSON.stringify(obj);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out += c > 126 ? '\\u' + ('0000' + c.toString(16)).slice(-4) : s[i];
  }
  return out;
}

// Turn a finished response into a value or a typed error. One place, so the
// RPC and content doors cannot classify the same fault two ways.
//   · 401 missing_scope  -> the named 501 above (dynamic, self-healing)
//   · 401 anything else  -> the access token aged out; refresh + retry ONCE
//   · other non-2xx      -> 502 carrying Dropbox's own words (JSON or text)
async function finish(label, res, retry, retried) {
  if (res.status === 401) {
    const err = res.body && typeof res.body === 'object' ? res.body.error : null;
    if (err && err['.tag'] === 'missing_scope') {
      throw missingScope(err.required_scope || 'the required scope');
    }
    if (!retried) {
      dropboxResetToken();
      await dropboxToken(true);
      return retry();
    }
  }
  if (!res.ok) {
    const summary = (res.body && typeof res.body === 'object' &&
                     (res.body.error_summary || res.body.error_description)) ||
                    (typeof res.body === 'string' ? res.body.slice(0, 200) : '') ||
                    (res.body ? JSON.stringify(res.body).slice(0, 200) : 'unknown error');
    const e = new Error(`Dropbox ${label} → ${res.status}: ${summary}`);
    e.status = 502;
    e.upstreamStatus = res.status;
    e.body = res.body;
    e.summary = String(summary);
    throw e;
  }
  return res.body;
}

// The RPC door (api.dropboxapi.com): JSON in, JSON out.
async function dropboxRpc(path, arg, _retried) {
  const token = await dropboxToken(false);
  const res = await rawFetch(apiBase() + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(arg)
  });
  return finish(`POST ${path}`, res, () => dropboxRpc(path, arg, true), _retried);
}

// The content door (content.dropboxapi.com): the arg rides the Dropbox-API-Arg
// header, the body is bytes (up on upload, down on download).
async function dropboxContent(path, arg, { body = null, headers = {}, wantBytes = false } = {}, _retried) {
  const token = await dropboxToken(false);
  const res = await rawFetch(contentBase() + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': headerSafeJson(arg),
      ...(body != null ? { 'Content-Type': 'application/octet-stream' } : {}),
      ...headers
    },
    body
  }, { timeoutMs: DROPBOX_CONTENT_TIMEOUT_MS(), wantBytes });
  if (wantBytes && res.ok) {
    let meta = null;
    if (res.resultHeader) { try { meta = JSON.parse(res.resultHeader); } catch { meta = null; } }
    return { bytes: res.bytes, meta };
  }
  return finish(`POST ${path}`, res,
    () => dropboxContent(path, arg, { body, headers, wantBytes }, true), _retried);
}

// ── paths ───────────────────────────────────────────────────────────────────
// Dropbox spells the root '' (never '/'); everything else is /-prefixed.
function normPath(p) {
  const s = String(p || '').trim().replace(/\/+$/, '');
  if (s === '' || s === '/') return '';
  return s.startsWith('/') ? s : '/' + s;
}
// Is this Dropbox error a path/not_found? The routes turn that into honest
// English ("moved or deleted in Dropbox") instead of a generic 502.
function isPathNotFound(e) {
  return !!(e && (e.summary && /path\/not_found|path_lookup\/not_found/.test(e.summary)));
}

// ── files ───────────────────────────────────────────────────────────────────
// include_media_info is the FREE spec layer: Dropbox computes photo/video
// dimensions and duration on its own time. Asynchronously — 'pending' is a
// real state, and callers render nothing rather than a placeholder for it.
async function listFolder(path) {
  const arg = { path: normPath(path), recursive: false, include_media_info: true, limit: 500 };
  let r = await dropboxRpc('/2/files/list_folder', arg);
  const entries = [...(r.entries || [])];
  while (r.has_more) {
    r = await dropboxRpc('/2/files/list_folder/continue', { cursor: r.cursor });
    entries.push(...(r.entries || []));
  }
  return entries;
}
async function getMetadata(path) {
  return dropboxRpc('/2/files/get_metadata', { path: normPath(path), include_media_info: true });
}
// Whole-file download — the INGEST-A-COPY path only. Buffered: everything it
// feeds goes to storage.put, which takes a Buffer and reports the real count.
async function download(path) {
  return dropboxContent('/2/files/download', { path: normPath(path) }, { wantBytes: true });
}
// Streamed download — the remote-preview proxy. The bytes go browser-ward
// chunk by chunk; a 400 MB Dropbox render must not sit in this heap.
async function downloadStream(path, _retried) {
  const token = await dropboxToken(false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DROPBOX_CONTENT_TIMEOUT_MS());
  let res;
  try {
    res = await fetch(contentBase() + '/2/files/download', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`,
                 'Dropbox-API-Arg': headerSafeJson({ path: normPath(path) }) },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(`Dropbox unreachable: ${err && err.message ? err.message : err}`);
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    return finish('POST /2/files/download', { ok: false, status: res.status, body },
      () => downloadStream(path, true), _retried);
  }
  let meta = null;
  const rh = res.headers.get('dropbox-api-result');
  if (rh) { try { meta = JSON.parse(rh); } catch { meta = null; } }
  const { Readable } = require('stream');
  const stream = Readable.fromWeb(res.body);
  stream.on('close', () => clearTimeout(timer));
  stream.on('error', () => clearTimeout(timer));
  return { stream, size: meta && Number.isFinite(Number(meta.size)) ? Number(meta.size) : null, meta };
}
// Ranged download — the media probe's only door. Dropbox honours HTTP Range
// on /2/files/download; the probe uses it to read container HEADERS, never
// whole files (lib/mediaprobe.js owns the byte budget).
async function downloadRange(path, start, end) {
  const r = await dropboxContent('/2/files/download', { path: normPath(path) },
    { wantBytes: true, headers: { Range: `bytes=${start}-${end}` } });
  return r.bytes;
}
// Deposit: write bytes INTO the linked folder. autorename, never overwrite —
// a deposit that would collide gets ' (1)' from Dropbox rather than eating
// somebody's file. mute keeps the client's own Dropbox from ping-spamming.
async function upload(path, bytes) {
  return dropboxContent('/2/files/upload',
    { path: normPath(path), mode: 'add', autorename: true, mute: true },
    { body: bytes });
}

// ── file requests ───────────────────────────────────────────────────────────
async function fileRequestsList() {
  let r = await dropboxRpc('/2/file_requests/list_v2', { limit: 1000 });
  const out = [...(r.file_requests || [])];
  while (r.has_more) {
    r = await dropboxRpc('/2/file_requests/list/continue', { cursor: r.cursor });
    out.push(...(r.file_requests || []));
  }
  return out;
}
async function fileRequestGet(id) {
  return dropboxRpc('/2/file_requests/get', { id: String(id) });
}
async function fileRequestCreate({ title, destination }) {
  return dropboxRpc('/2/file_requests/create',
    { title: String(title), destination: normPath(destination), open: true });
}

module.exports = {
  // config
  dropboxConfigured, notConfigured, missingScope,
  // transport (the token pair is exported for the suites' cache assertions)
  dropboxToken, dropboxResetToken,
  // files
  normPath, isPathNotFound, listFolder, getMetadata, download, downloadStream,
  downloadRange, upload,
  // file requests
  fileRequestsList, fileRequestGet, fileRequestCreate
};
