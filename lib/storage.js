// ════════════════════════════════════════════════════════════════════════════
// lib/storage.js — the NAS abstraction
// ────────────────────────────────────────────────────────────────────────────
// Two-tier by design: metadata in Postgres, BYTES on the E360 NAS. Nothing in
// the app opens a UNC path directly — every byte goes through a driver, so the
// day the NAS becomes reachable is a driver swap and an env var, not a rewrite.
//
// Drivers
//   local  (default) — writes under STORAGE_ROOT, mapping the UNC-shaped
//                      nas_path onto a directory tree. This is what dev and CI
//                      run against; it is also correct in production when the
//                      NAS is mounted on the host.
//   webdav (REAL)    — Synology WebDAV over HTTPS (port 5006 by default),
//                      optionally through the Tailscale userspace SOCKS5 proxy
//                      so a Railway container can reach a NAS that is on the
//                      tailnet and nowhere else. See WIRING_DAY.md.
//   smb              — still stubbed. WebDAV won; SMB would need a second
//                      protocol implementation for no additional capability.
//
// Punch coverage: 45 (photos live under the mechanical {kind} folder \photo\),
// 46 (proposed bytes quarantine under _agent-inbox and MOVE to the canonical
// path on confirm — a rejected proposal must leave no trace in a show folder).
//
// ── WHY THERE IS NO npm WEBDAV CLIENT HERE ─────────────────────────────────
// The whole app runs on five dependencies (express, pg, bcryptjs, cors, luxon).
// A WebDAV client is six verbs over HTTP and one XML field, and the SOCKS5
// CONNECT handshake is forty lines of `net`. Adding `webdav` + `socks-proxy-
// agent` + `undici` to reach a single host would triple the dependency surface
// of the deployment that has to be audited before it touches Tom's NAS. Both
// are implemented here against node's own `http`/`https`/`tls`/`net`.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { slug } = require('./enums');

// The logical root every nas_path is expressed against. Kept UNC-shaped
// because operators read these strings out of the UI and paste them into
// Explorer.
const NAS_ROOT = process.env.SHOWRUNNER_NAS_ROOT || '\\\\E360-NAS\\Showrunner';
// Where the local driver actually puts bytes.
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, '..', '.storage');
const DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const MAX_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(100 * 1024 * 1024), 10);

// ── PATH CONVENTION ─────────────────────────────────────────────────────────
//   {ROOT}\P{projectId}-{slug}\{ S{showId}-{slug} | _project }\{kind}\{filename}
// 45. photos land under \photo\ (singular) — the mechanical {kind} folder, so
//     the folder name is always literally the file's `kind` with no special
//     casing anywhere. Flipping to \photos\ is a one-line change here.
function fileName(file) {
  const ext = file.ext ? (String(file.ext).startsWith('.') ? file.ext : '.' + file.ext) : '';
  const base = String(file.name || 'untitled');
  return base.endsWith(ext) || !ext ? base : base + ext;
}
function buildNasPath(project, show, file) {
  const projPart = `P${project.id}-${project.slug || slug(project.name)}`;
  const showPart = show ? `S${show.id}-${show.slug || slug(show.name || show.venue)}` : '_project';
  const kind = String(file.kind || 'other');
  return [NAS_ROOT, projPart, showPart, kind, fileName(file)].join('\\');
}
// 46/§3. Proposals NEVER write bytes into a real show folder — a rejected
// proposal must leave nothing behind for someone to find later.
function buildQuarantinePath(username, file) {
  return [NAS_ROOT, '_agent-inbox', String(username || 'unknown'),
          String(file.kind || 'other'), fileName(file)].join('\\');
}
// The NAS-side thumbnailer writes {name}_t320.jpg beside the original (46).
function thumbPathFor(nasPath) {
  if (!nasPath) return null;
  const i = nasPath.lastIndexOf('.');
  return i > nasPath.lastIndexOf('\\') ? nasPath.slice(0, i) + '_t320.jpg' : nasPath + '_t320.jpg';
}

// What GET /api/files/:id/content sends as Content-Type. Deliberately a short
// EXPLICIT map rather than a mime database: this app files a dozen kinds of
// thing and three of them (.e360 / .nsf / .pcfg) are e360's own formats that no
// database has ever heard of. Anything unrecognised is application/octet-stream
// — which downloads correctly — and is served with X-Content-Type-Options:
// nosniff so a browser never decides for itself that an upload is HTML.
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json', xml: 'application/xml',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav',
  dwg: 'image/vnd.dwg', dxf: 'image/vnd.dxf'
};
function contentTypeFor(ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return CONTENT_TYPES[e] || 'application/octet-stream';
}

// ── one place that turns a nas_path into safe segments ──────────────────────
// Every driver goes through this. A traversal segment, a drive letter, or a
// Windows-reserved character is refused here and nowhere else, so a new driver
// cannot forget the check.
function nasSegments(nasPath) {
  let rel = String(nasPath || '');
  if (rel.startsWith(NAS_ROOT)) rel = rel.slice(NAS_ROOT.length);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new Error('Empty NAS path');
  for (const p of parts) {
    if (p === '.' || p === '..' || /[:*?"<>|]/.test(p)) {
      throw new Error('Unsafe path segment: ' + p);
    }
  }
  return parts;
}

// UNC path -> a path under STORAGE_ROOT.
function toLocalPath(nasPath) {
  return path.join(STORAGE_ROOT, ...nasSegments(nasPath));
}

// ── the error every driver throws ───────────────────────────────────────────
// A byte operation that fails must say WHICH LAYER failed, because the fixes
// are completely different: 404 = the row outlived its bytes; 502 = the NAS or
// the tailnet is down and nobody's data is lost; 507 = the share is full.
// `status` is carried straight through by routes/*'s asyncH error handler.
class StorageError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'StorageError';
    this.status = status || 502;
    this.code = code || 'storage-error';
    this.storage = true;
  }
}
const notFoundErr = (p) =>
  new StorageError(`No bytes at ${p} — the metadata row exists but nothing was ever uploaded ` +
                   `(or the file was moved on the NAS outside Showrunner).`, 404, 'no-bytes');

// ── LOCAL DRIVER ────────────────────────────────────────────────────────────
const localDriver = {
  name: 'local',
  configured: () => true,
  info: () => ({ driver: 'local', ready: true, target: STORAGE_ROOT, via: 'filesystem' }),
  async mkdirs(nasPath) {
    await fsp.mkdir(path.dirname(toLocalPath(nasPath)), { recursive: true });
    return { ok: true };
  },
  async put(nasPath, buffer) {
    if (Buffer.isBuffer(buffer) && buffer.length > MAX_BYTES) {
      throw new StorageError(`Body exceeds ${MAX_BYTES} bytes`, 413, 'too-large');
    }
    const target = toLocalPath(nasPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (Buffer.isBuffer(buffer)) {
      await fsp.writeFile(target, buffer);
      return { ok: true, size: buffer.length, path: nasPath };
    }
    // a Readable — used by nothing today, but the contract is shared with webdav
    const written = await new Promise((resolve, reject) => {
      let n = 0;
      const out = fs.createWriteStream(target);
      buffer.on('data', (c) => { n += c.length; });
      buffer.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve(n));
      buffer.pipe(out);
    });
    return { ok: true, size: written, path: nasPath };
  },
  async get(nasPath) {
    try { return await fsp.readFile(toLocalPath(nasPath)); }
    catch (e) {
      if (e && e.code === 'ENOENT') throw notFoundErr(nasPath);
      throw new StorageError(`Cannot read ${nasPath}: ${e.message}`, 502, 'read-failed');
    }
  },
  // Streamed read — what GET /api/files/:id/content wants, so a 400 MB show
  // file never lands in the server's heap on its way to a browser.
  async getStream(nasPath) {
    const target = toLocalPath(nasPath);
    let st;
    try { st = await fsp.stat(target); }
    catch (e) {
      if (e && e.code === 'ENOENT') throw notFoundErr(nasPath);
      throw new StorageError(`Cannot read ${nasPath}: ${e.message}`, 502, 'read-failed');
    }
    return { stream: fs.createReadStream(target), size: st.size, mtime: st.mtime };
  },
  async exists(nasPath) {
    try { await fsp.access(toLocalPath(nasPath), fs.constants.F_OK); return true; }
    catch { return false; }
  },
  async move(fromPath, toPath) {
    const from = toLocalPath(fromPath);
    const to = toLocalPath(toPath);
    if (!(await localDriver.exists(fromPath))) return { ok: false, reason: 'source-missing' };
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return { ok: true, from: fromPath, to: toPath };
  },
  async remove(nasPath) {
    try { await fsp.unlink(toLocalPath(nasPath)); return { ok: true }; }
    catch { return { ok: false }; }
  },
  async stat(nasPath) {
    try { const s = await fsp.stat(toLocalPath(nasPath)); return { size: s.size, mtime: s.mtime }; }
    catch { return null; }
  }
};

// ════════════════════════════════════════════════════════════════════════════
// SOCKS5 — the Tailscale hop
// ────────────────────────────────────────────────────────────────────────────
// Railway containers are not on the tailnet. `tailscaled --tun=userspace-
// networking --socks5-server=localhost:1055` puts the tailnet behind a local
// SOCKS5 port instead of a network interface, which is the only shape that
// works without CAP_NET_ADMIN and /dev/net/tun.
//
// The proxy is used for the NAS HOST AND NOTHING ELSE. Sending the app's other
// outbound traffic (Flex, Microsoft Graph, the staffing app) through a tailnet
// proxy would be a silent, hard-to-debug outage the first time tailscaled is
// slow to come up — so `proxyForHost()` below is a whitelist of exactly one
// hostname, and it is a pure function so it can be tested without a tailnet.
// ════════════════════════════════════════════════════════════════════════════

// Accepts `host:port`, `socks5://host:port`, `socks5://user:pass@host:port`.
function parseSocks(spec) {
  if (!spec) return null;
  const s = String(spec).trim();
  if (!s) return null;
  const withScheme = /^socks5h?:\/\//i.test(s) ? s : 'socks5://' + s;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (!u.hostname) return null;
  return {
    host: u.hostname,
    port: parseInt(u.port, 10) || 1055,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null
  };
}

// The whole SOCKS decision, as one pure function of (host, env).
//   · TAILSCALE_SOCKS_DISABLE=1 -> never, whatever else is set (the escape
//     hatch for "tailscaled is broken, the NAS is reachable directly today").
//   · TAILSCALE_SOCKS set       -> that proxy.
//   · TAILSCALE_AUTHKEY set     -> localhost:1055, the port the entrypoint
//                                  script starts tailscaled on. This is what
//                                  makes the feature inert when the key is
//                                  absent: no key, no proxy, normal sockets.
//   · nasHost must match `host` -> a proxy is never applied to a third party.
function proxyForHost(host, env = process.env) {
  if (!host) return null;
  if (String(env.TAILSCALE_SOCKS_DISABLE || '') === '1') return null;
  const nasHost = webdavHostFromEnv(env);
  if (!nasHost) return null;
  if (String(host).toLowerCase() !== nasHost.toLowerCase()) return null;
  const explicit = parseSocks(env.TAILSCALE_SOCKS);
  if (explicit) {
    if (env.TAILSCALE_SOCKS_USER) explicit.user = env.TAILSCALE_SOCKS_USER;
    if (env.TAILSCALE_SOCKS_PASS) explicit.pass = env.TAILSCALE_SOCKS_PASS;
    return explicit;
  }
  if (env.TAILSCALE_AUTHKEY) return { host: '127.0.0.1', port: 1055, user: null, pass: null };
  return null;
}
function webdavHostFromEnv(env = process.env) {
  const raw = env.NAS_WEBDAV_URL;
  if (!raw) return null;
  try { return new URL(String(raw)).hostname; } catch { return null; }
}

// Read exactly n bytes off a socket, in PAUSED mode.
// Paused mode is load-bearing, not a style choice: the socket is handed to
// tls.connect() the instant the handshake ends, and anything a 'data' listener
// had already pulled out of the kernel buffer would be lost to TLS. `read(n)`
// consumes exactly n bytes and leaves the rest where the next reader (us, then
// TLS) will find it.
function readN(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(
      () => finish(new Error('SOCKS proxy did not answer in time')), timeoutMs);
    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener('readable', attempt);
      sock.removeListener('error', onErr);
      sock.removeListener('end', onEnd);
      sock.removeListener('close', onEnd);
      if (err) reject(err); else resolve(val);
    }
    function attempt() {
      const b = sock.read(n);
      if (b) finish(null, b);
    }
    const onErr = (e) => finish(e);
    const onEnd = () => finish(new Error('SOCKS proxy closed the connection mid-handshake'));
    sock.on('readable', attempt);
    sock.on('error', onErr);
    sock.on('end', onEnd);
    sock.on('close', onEnd);
    attempt();
  });
}

const SOCKS_REPLY = {
  1: 'general SOCKS server failure', 2: 'connection not allowed by ruleset',
  3: 'network unreachable', 4: 'host unreachable — is the NAS up and on the tailnet?',
  5: 'connection refused — is WebDAV listening on that port?', 6: 'TTL expired',
  7: 'command not supported', 8: 'address type not supported'
};

// CONNECT through a SOCKS5 proxy, returning a live TCP socket to (host, port).
async function socksConnect(proxy, host, port, timeoutMs) {
  const sock = net.connect({ host: proxy.host, port: proxy.port });
  sock.setNoDelay(true);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SOCKS proxy ${proxy.host}:${proxy.port} did not accept a connection in ${timeoutMs}ms`)),
        timeoutMs);
      sock.once('connect', () => { clearTimeout(timer); resolve(); });
      sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    });

    // greeting
    const methods = proxy.user ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const greet = await readN(sock, 2, timeoutMs);
    if (greet[0] !== 0x05) throw new Error('Not a SOCKS5 proxy');
    if (greet[1] === 0xff) throw new Error('SOCKS proxy rejected every auth method offered');
    if (greet[1] === 0x02) {
      if (!proxy.user) throw new Error('SOCKS proxy demands a username/password and none is configured');
      const u = Buffer.from(proxy.user, 'utf8');
      const p = Buffer.from(proxy.pass || '', 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const auth = await readN(sock, 2, timeoutMs);
      if (auth[1] !== 0x00) throw new Error('SOCKS proxy rejected the username/password');
    } else if (greet[1] !== 0x00) {
      throw new Error(`SOCKS proxy chose an unsupported auth method (0x${greet[1].toString(16)})`);
    }

    // CONNECT, always by DOMAIN NAME — the tailnet name must be resolved by
    // tailscaled (MagicDNS), never by the container's resolver.
    const hostBuf = Buffer.from(String(host), 'utf8');
    if (hostBuf.length > 255) throw new Error('Hostname too long for SOCKS5');
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
      Buffer.from([(port >> 8) & 0xff, port & 0xff])
    ]);
    sock.write(req);
    const head = await readN(sock, 4, timeoutMs);
    if (head[0] !== 0x05) throw new Error('Malformed SOCKS5 reply');
    if (head[1] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT to ${host}:${port} failed — ` +
                      (SOCKS_REPLY[head[1]] || `reply code ${head[1]}`));
    }
    // consume the bound address so the stream starts clean
    const atyp = head[3];
    if (atyp === 0x01) await readN(sock, 4 + 2, timeoutMs);
    else if (atyp === 0x04) await readN(sock, 16 + 2, timeoutMs);
    else if (atyp === 0x03) {
      const len = await readN(sock, 1, timeoutMs);
      await readN(sock, len[0] + 2, timeoutMs);
    } else throw new Error('SOCKS5 reply used an unknown address type');
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

// http/https Agents whose only difference from the stock ones is where the
// socket comes from. Subclassing keeps keep-alive, pooling and the whole
// agent contract intact — reimplementing `request()` would not.
function makeSocksAgent(secure, proxy, tlsOpts, timeoutMs) {
  const Base = secure ? https.Agent : http.Agent;
  class SocksAgent extends Base {
    createConnection(options, cb) {
      socksConnect(proxy, options.host, options.port, timeoutMs).then((raw) => {
        if (!secure) return cb(null, raw);
        const secured = tls.connect({
          socket: raw,
          servername: options.servername || options.host,
          ...tlsOpts
        });
        secured.once('error', () => { try { raw.destroy(); } catch (_) {} });
        cb(null, secured);
      }, (err) => cb(err));
    }
  }
  return new SocksAgent({ keepAlive: true, maxSockets: 8 });
}

// ════════════════════════════════════════════════════════════════════════════
// WEBDAV DRIVER — real
// ════════════════════════════════════════════════════════════════════════════
// Verbs used, and why each one:
//   PROPFIND (Depth: 0)  exists / stat — the only read that does not transfer
//   MKCOL                one collection per call; `mkdirs` walks the path
//   PUT                  bytes; retried once after MKCOL on a 409
//   GET                  bytes, returned as a live stream
//   MOVE                 the quarantine -> canonical promotion (punch 46)
//   DELETE               reject-purge
// Synology's WebDAV Server package answers all six on the share root.
function makeWebdavDriver(env = process.env) {
  const rawUrl = env.NAS_WEBDAV_URL || '';
  const user = env.NAS_WEBDAV_USER || '';
  const pass = env.NAS_WEBDAV_PASS || '';
  const timeoutMs = parseInt(env.NAS_WEBDAV_TIMEOUT_MS || '30000', 10);
  const maxBytes = parseInt(env.MAX_UPLOAD_BYTES || String(MAX_BYTES), 10);

  let base = null;
  let parseError = null;
  if (rawUrl) {
    try { base = new URL(String(rawUrl)); }
    catch (e) { parseError = `NAS_WEBDAV_URL is not a URL: ${e.message}`; }
  }
  const secure = base ? base.protocol === 'https:' : true;
  const basePath = base ? base.pathname.replace(/\/+$/, '') : '';
  const port = base ? (base.port ? parseInt(base.port, 10) : (secure ? 443 : 80)) : 0;

  // Self-signed is the NORMAL case for a Synology reached by its tailnet name:
  // the box's certificate is issued for `nas.local`/the DDNS name, not for
  // `nas.tail1234.ts.net`. Two honest ways to accept it, and a loud default.
  //   NAS_WEBDAV_CA            — a PEM (or a path to one). Verification stays ON.
  //   NAS_WEBDAV_ALLOW_SELF_SIGNED=1 — verification OFF for this ONE host.
  // The second is acceptable here and nowhere else: the transport is already
  // an authenticated WireGuard tunnel, so TLS is belt over braces. It is NOT a
  // global NODE_TLS_REJECT_UNAUTHORIZED — that would disarm every other client
  // in the process (Flex, Graph, the staffing app).
  const tlsOpts = {};
  const allowSelfSigned = String(env.NAS_WEBDAV_ALLOW_SELF_SIGNED || '') === '1';
  if (allowSelfSigned) tlsOpts.rejectUnauthorized = false;
  const caSpec = env.NAS_WEBDAV_CA;
  if (caSpec) {
    try {
      tlsOpts.ca = String(caSpec).includes('BEGIN CERTIFICATE')
        ? String(caSpec).replace(/\\n/g, '\n')
        : fs.readFileSync(String(caSpec));
    } catch (e) {
      parseError = parseError || `NAS_WEBDAV_CA could not be read: ${e.message}`;
    }
  }

  let agent = null;
  function agentFor() {
    if (agent) return agent;
    const proxy = proxyForHost(base.hostname, env);
    agent = proxy
      ? makeSocksAgent(secure, proxy, tlsOpts, timeoutMs)
      : new (secure ? https.Agent : http.Agent)({ keepAlive: true, maxSockets: 8 });
    agent._srProxy = proxy || null;
    return agent;
  }

  function configured() { return !!(base && user && pass && !parseError); }
  function requireConfig() {
    if (parseError) throw new StorageError(parseError, 501, 'misconfigured');
    if (!base) {
      throw new StorageError(
        'STORAGE_DRIVER=webdav but NAS_WEBDAV_URL is not set — nothing knows where the NAS is. ' +
        'See WIRING_DAY.md, or set STORAGE_DRIVER=local to fall back to disk.', 501, 'not-configured');
    }
    if (!user || !pass) {
      throw new StorageError(
        'STORAGE_DRIVER=webdav but NAS_WEBDAV_USER / NAS_WEBDAV_PASS are not both set — ' +
        'the Synology will answer 401. See WIRING_DAY.md.', 501, 'not-configured');
    }
  }

  const encodeSeg = (s) => encodeURIComponent(s).replace(/%2F/gi, '/');
  function remotePath(nasPath) {
    return basePath + '/' + nasSegments(nasPath).map(encodeSeg).join('/');
  }
  function absUrl(p) { return `${base.protocol}//${base.host}${p}`; }

  // One request. Returns { status, headers, res } with the body NOT consumed
  // when `stream` is true, otherwise { status, headers, body }.
  function request(method, urlPath, opts = {}) {
    requireConfig();
    return new Promise((resolve, reject) => {
      const mod = secure ? https : http;
      const headers = {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
        'User-Agent': 'e360-showrunner/storage',
        ...(opts.headers || {})
      };
      const hasBuffer = Buffer.isBuffer(opts.body);
      if (hasBuffer) headers['Content-Length'] = opts.body.length;

      const req = mod.request({
        method, host: base.hostname, port, path: urlPath, headers,
        agent: agentFor(), ...(secure ? tlsOpts : {})
      });

      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(() => {
        req.destroy();
        done(reject, new StorageError(
          `The NAS did not answer ${method} ${decodeURI(urlPath)} within ${timeoutMs}ms. ` +
          `The record is intact; the bytes did not move.`, 504, 'timeout'));
      }, timeoutMs);

      req.on('error', (e) => done(reject, wrapNetError(e, method, urlPath)));
      req.on('response', (res) => {
        if (opts.stream) return done(resolve, { status: res.statusCode, headers: res.headers, res });
        const chunks = [];
        let n = 0;
        res.on('data', (c) => { n += c.length; if (n <= 2 * 1024 * 1024) chunks.push(c); });
        res.on('error', (e) => done(reject, wrapNetError(e, method, urlPath)));
        res.on('end', () => done(resolve, {
          status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
        }));
      });

      if (hasBuffer) req.end(opts.body);
      else if (opts.body && typeof opts.body.pipe === 'function') {
        let n = 0;
        opts.body.on('data', (c) => {
          n += c.length;
          if (n > maxBytes) {
            opts.body.destroy();
            req.destroy();
            done(reject, new StorageError(`Body exceeds ${maxBytes} bytes`, 413, 'too-large'));
          }
        });
        opts.body.on('error', (e) => { req.destroy(); done(reject, wrapNetError(e, method, urlPath)); });
        opts.body.pipe(req);
      } else req.end();
    });
  }

  // A socket-level failure is never the caller's fault and never data loss:
  // say so, name the host, and hand back a 502 so the UI shows "the NAS is
  // unreachable" and not "your upload was rejected".
  function wrapNetError(e, method, urlPath) {
    if (e instanceof StorageError) return e;
    const where = `${base ? base.host : '(unset)'}`;
    const via = agent && agent._srProxy
      ? ` via the Tailscale SOCKS proxy at ${agent._srProxy.host}:${agent._srProxy.port}` : '';
    const hints = {
      ENOTFOUND: 'the hostname did not resolve — on a tailnet that usually means MagicDNS is off or tailscaled is not up yet',
      ECONNREFUSED: 'nothing is listening — check the WebDAV Server package is running and the port is right',
      ECONNRESET: 'the connection was reset mid-transfer',
      ETIMEDOUT: 'the connection timed out',
      EHOSTUNREACH: 'no route to the host — is the NAS still on the tailnet?',
      CERT_HAS_EXPIRED: 'the NAS certificate has expired — set NAS_WEBDAV_CA or NAS_WEBDAV_ALLOW_SELF_SIGNED=1',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'the NAS uses a self-signed certificate — set NAS_WEBDAV_CA or NAS_WEBDAV_ALLOW_SELF_SIGNED=1',
      ERR_TLS_CERT_ALTNAME_INVALID: 'the NAS certificate does not name this hostname — set NAS_WEBDAV_CA or NAS_WEBDAV_ALLOW_SELF_SIGNED=1'
    };
    const hint = hints[e.code] || e.message;
    return new StorageError(
      `Cannot reach the E360 NAS (${where}${via}) for ${method} ${decodeURI(urlPath)} — ${hint}. ` +
      `No data was lost; the Showrunner record is intact and the bytes can be re-sent.`,
      502, e.code || 'unreachable');
  }

  function statusError(status, method, nasPath, extra) {
    if (status === 401 || status === 403) {
      return new StorageError(
        `The NAS refused the svc-showrunner credentials (${status}) on ${method}. ` +
        `Check NAS_WEBDAV_USER / NAS_WEBDAV_PASS and that the account has read/write on the ` +
        `'showrunner' share.`, 502, 'auth-failed');
    }
    if (status === 404) return notFoundErr(nasPath);
    if (status === 507) {
      return new StorageError(`The NAS share is out of space (507) — ${method} ${nasPath} was refused.`,
        507, 'insufficient-storage');
    }
    if (status === 423) {
      return new StorageError(`${nasPath} is locked on the NAS (423) — another client holds it.`,
        409, 'locked');
    }
    return new StorageError(
      `The NAS answered ${status} to ${method} ${nasPath}${extra ? ' — ' + extra : ''}.`,
      502, 'dav-' + status);
  }

  // MKCOL creates ONE collection. A show folder is four levels deep and none of
  // them may exist yet, so walk down creating each, treating "already there"
  // (405, and 301 on some servers) as success.
  async function mkdirs(nasPath) {
    const segs = nasSegments(nasPath);
    segs.pop();                       // the last segment is the file
    let acc = basePath;
    const made = [];
    for (const s of segs) {
      acc += '/' + encodeSeg(s);
      const r = await request('MKCOL', acc);
      if (r.status === 201) made.push(s);
      else if (r.status === 405 || r.status === 301) continue;   // exists
      else if (r.status === 409) {
        throw new StorageError(
          `The NAS refused to create ${decodeURI(acc)} (409) — a parent is missing or is a file, ` +
          `not a folder.`, 502, 'mkcol-conflict');
      } else if (r.status >= 400) throw statusError(r.status, 'MKCOL', decodeURI(acc));
    }
    return { ok: true, created: made };
  }

  async function put(nasPath, body) {
    if (Buffer.isBuffer(body) && body.length > maxBytes) {
      throw new StorageError(`Body exceeds ${maxBytes} bytes`, 413, 'too-large');
    }
    const p = remotePath(nasPath);
    const send = () => request('PUT', p, {
      body, headers: { 'Content-Type': 'application/octet-stream' }
    });
    let r = await send();
    // 409 = the collection does not exist. Create it and retry ONCE. Doing it
    // this way round means the common case (folder already there) costs one
    // round trip instead of four MKCOLs on every single upload.
    if (r.status === 409 || r.status === 404) {
      await mkdirs(nasPath);
      if (!Buffer.isBuffer(body)) {
        throw new StorageError(
          'The NAS folder did not exist and the upload was a stream, which cannot be replayed — ' +
          'retry the upload now that the folder has been created.', 409, 'retry-needed');
      }
      r = await send();
    }
    // A 404 on a PUT is never "the file is missing" — it is "the NAS will not
    // create it there". Saying notFound would send whoever reads the log
    // looking for the wrong thing.
    if (r.status === 404) {
      throw new StorageError(
        `The NAS refused to create ${nasPath} (404) — the '${basePath.replace(/^\//, '') || 'root'}' ` +
        `share may not exist, or svc-showrunner may not have write permission on it.`,
        502, 'put-refused');
    }
    if (r.status >= 400) throw statusError(r.status, 'PUT', nasPath);
    const size = Buffer.isBuffer(body) ? body.length : (await stat(nasPath) || {}).size || 0;
    return { ok: true, size, path: nasPath };
  }

  async function getStream(nasPath) {
    const r = await request('GET', remotePath(nasPath), { stream: true });
    if (r.status === 404) { r.res.resume(); throw notFoundErr(nasPath); }
    if (r.status >= 400) { r.res.resume(); throw statusError(r.status, 'GET', nasPath); }
    const len = parseInt(r.headers['content-length'], 10);
    return {
      stream: r.res,
      size: Number.isFinite(len) ? len : null,
      mtime: r.headers['last-modified'] ? new Date(r.headers['last-modified']) : null
    };
  }

  async function get(nasPath) {
    const { stream } = await getStream(nasPath);
    const chunks = [];
    let n = 0;
    return new Promise((resolve, reject) => {
      stream.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) {
          stream.destroy();
          reject(new StorageError(`${nasPath} is larger than ${maxBytes} bytes — stream it instead.`,
            413, 'too-large'));
          return;
        }
        chunks.push(c);
      });
      stream.on('error', (e) => reject(e instanceof StorageError ? e
        : new StorageError(`Transfer of ${nasPath} failed: ${e.message}`, 502, 'transfer-failed')));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  const PROPFIND_BODY = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propfind xmlns:D="DAV:"><D:prop>' +
    '<D:getcontentlength/><D:getlastmodified/><D:resourcetype/>' +
    '</D:prop></D:propfind>', 'utf8');

  async function stat(nasPath) {
    const r = await request('PROPFIND', remotePath(nasPath), {
      body: PROPFIND_BODY, headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }
    });
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) throw statusError(r.status, 'PROPFIND', nasPath);
    if (r.status >= 400) return null;
    const xml = r.body.toString('utf8');
    // Namespace-agnostic on purpose: Synology answers `<D:...>`, other servers
    // `<lp1:...>` or bare. Matching the LOCAL NAME is the only portable read.
    const len = /<[^>]*getcontentlength[^>]*>\s*(\d+)\s*</i.exec(xml);
    const mod = /<[^>]*getlastmodified[^>]*>\s*([^<]+?)\s*</i.exec(xml);
    const dir = /<[^>]*resourcetype[^>]*>[\s\S]*?<[^>]*collection/i.test(xml);
    return {
      size: len ? parseInt(len[1], 10) : 0,
      mtime: mod ? new Date(mod[1]) : null,
      directory: dir
    };
  }

  async function exists(nasPath) {
    try { return (await stat(nasPath)) !== null; }
    catch (e) {
      // exists() is called on paths that may legitimately be absent; only a
      // real transport/auth failure is worth propagating.
      if (e instanceof StorageError && (e.code === 'auth-failed' || e.status === 501)) throw e;
      if (e instanceof StorageError && e.status === 404) return false;
      throw e;
    }
  }

  // The punch-46 promotion. Same contract as the local driver, including the
  // `{ ok:false, reason:'source-missing' }` shape routes/proposals.js branches on.
  async function move(fromPath, toPath) {
    const from = remotePath(fromPath);
    const to = remotePath(toPath);
    const send = () => request('MOVE', from, {
      headers: { Destination: absUrl(to), Overwrite: 'T' }
    });
    let r = await send();
    if (r.status === 409 || r.status === 412) {
      await mkdirs(toPath);
      r = await send();
    }
    if (r.status === 404) return { ok: false, reason: 'source-missing' };
    if (r.status >= 400) throw statusError(r.status, 'MOVE', fromPath, `destination ${toPath}`);
    return { ok: true, from: fromPath, to: toPath };
  }

  async function remove(nasPath) {
    const r = await request('DELETE', remotePath(nasPath));
    if (r.status === 404) return { ok: false, reason: 'source-missing' };
    if (r.status >= 400) throw statusError(r.status, 'DELETE', nasPath);
    return { ok: true };
  }

  return {
    name: 'webdav',
    configured,
    info() {
      const proxy = base ? proxyForHost(base.hostname, env) : null;
      return {
        driver: 'webdav',
        ready: configured(),
        // host + share only. NEVER the credentials — /api/health is read by
        // anything that can reach the app.
        target: base ? `${base.protocol}//${base.host}${basePath}` : null,
        via: proxy ? `tailscale-socks:${proxy.host}:${proxy.port}` : 'direct',
        tls: secure ? (allowSelfSigned ? 'self-signed-allowed' : (tlsOpts.ca ? 'pinned-ca' : 'verified')) : 'none',
        timeoutMs,
        error: parseError || null
      };
    },
    mkdirs, put, get, getStream, exists, move, remove, stat,
    // exposed for the suite; not used by the app
    _remotePath: remotePath, _request: request
  };
}

// ── SMB — still a stub, deliberately ────────────────────────────────────────
// WebDAV covers every operation Showrunner performs and needs no kernel mount.
// SMB would buy nothing and cost a second protocol implementation.
function makeRemoteStub(name) {
  const fail = () => {
    const e = new StorageError(
      `Storage driver '${name}' is not implemented — Showrunner reaches the E360 NAS over ` +
      `WebDAV. Set STORAGE_DRIVER=webdav (see WIRING_DAY.md) or STORAGE_DRIVER=local.`, 501, 'not-implemented');
    throw e;
  };
  return {
    name, configured: () => false,
    info: () => ({ driver: name, ready: false, target: null, via: null }),
    mkdirs: fail, put: fail, get: fail, getStream: fail,
    exists: async () => false, move: fail, remove: fail, stat: async () => null
  };
}

const drivers = {
  local: localDriver,
  smb: makeRemoteStub('smb'),
  get webdav() {
    // lazily built so a process that never selects webdav never parses its env
    if (!drivers._webdav) drivers._webdav = makeWebdavDriver(process.env);
    return drivers._webdav;
  }
};

const storage = drivers[DRIVER] || localDriver;

// What /api/health and /api/config report. A NAME and a BOOLEAN, never a
// credential — the same rule lib/mail.js follows.
function storageInfo() {
  try { return storage.info ? storage.info() : { driver: storage.name, ready: true }; }
  catch (e) { return { driver: storage.name, ready: false, error: e.message }; }
}
function storageReady() {
  try { return storage.configured ? !!storage.configured() : true; }
  catch { return false; }
}

module.exports = {
  storage, drivers, NAS_ROOT, STORAGE_ROOT, MAX_BYTES,
  buildNasPath, buildQuarantinePath, thumbPathFor, fileName, toLocalPath, nasSegments,
  StorageError, storageInfo, storageReady, contentTypeFor,
  // testable seams
  makeWebdavDriver, proxyForHost, parseSocks, socksConnect, webdavHostFromEnv
};
