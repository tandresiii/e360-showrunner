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
//
// ── WHY AN UNSET STORAGE_ROOT MEANS "NOT CONFIGURED" ────────────────────────
// The default used to be `<app>/.storage`, and the local driver used to report
// `configured: true` unconditionally. In a container that is a SILENT DATA-LOSS
// TRAP of exactly the family HARDENING_TODO 21 closed for fabricated numbers:
// /api/health says "storage ready", an upload returns 200, the bytes land on
// the container's ephemeral layer, and the next redeploy destroys them while the
// metadata row survives and points at nothing. The user is told the opposite of
// the truth twice — once when they upload, once when they later get a 404.
//
// So the local driver is now configured ONLY when an operator explicitly set
// STORAGE_ROOT. Setting it is the statement "I know where these bytes go and
// that path survives a restart." With it unset the app takes the honest path it
// already had for an unconfigured webdav driver: features.fileUpload false and a
// 501 'not-configured' from every byte operation. Dev and CI set it (see
// scripts/smoke.js and scripts/storage-test.js) and are unaffected.
const STORAGE_ROOT_SET = !!String(process.env.STORAGE_ROOT || '').trim();
const STORAGE_ROOT = STORAGE_ROOT_SET
  ? String(process.env.STORAGE_ROOT).trim()
  : path.join(__dirname, '..', '.storage');
const DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const MAX_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(100 * 1024 * 1024), 10);

// Is this process running inside a container / PaaS dyno? Used for ONE purpose:
// telling the truth in /api/health when a local disk is being used somewhere a
// local disk does not survive a deploy. It never changes behaviour — an operator
// who mounts a volume at STORAGE_ROOT is doing the right thing and the risk flag
// is how they confirm the mount, not a refusal.
function inContainer(env = process.env) {
  if (env.SHOWRUNNER_CONTAINER === '1') return true;
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_SERVICE_ID || env.DYNO ||
      env.KUBERNETES_SERVICE_HOST || env.FLY_APP_NAME || env.RENDER) return true;
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

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
const LOCAL_UNSET_MSG =
  'STORAGE_DRIVER=local but STORAGE_ROOT is not set, so there is nowhere durable to put bytes. ' +
  'On a container an unset root means the app-local disk, which is destroyed on every redeploy — ' +
  'the upload would appear to work and the file would vanish. Set STORAGE_ROOT to a path that ' +
  'survives a restart (a mounted volume, or the NAS mount on the host), or set STORAGE_DRIVER=webdav ' +
  'to reach the Synology directly. See WIRING_DAY.md.';

function requireLocalConfig() {
  if (!STORAGE_ROOT_SET) throw new StorageError(LOCAL_UNSET_MSG, 501, 'not-configured');
}

const localDriver = {
  name: 'local',
  configured: () => STORAGE_ROOT_SET,
  info: () => ({
    driver: 'local',
    ready: STORAGE_ROOT_SET,
    target: STORAGE_ROOT_SET ? STORAGE_ROOT : null,
    via: 'filesystem',
    // TRUE means: these bytes are on a disk that a redeploy destroys. It is only
    // ever true when an operator deliberately pointed the local driver at a
    // container path — the unset case is refused outright above.
    ephemeralRisk: STORAGE_ROOT_SET && inContainer(),
    error: STORAGE_ROOT_SET ? null : LOCAL_UNSET_MSG
  }),
  async mkdirs(nasPath) {
    requireLocalConfig();
    await fsp.mkdir(path.dirname(toLocalPath(nasPath)), { recursive: true });
    return { ok: true };
  },
  async put(nasPath, buffer) {
    requireLocalConfig();
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
    requireLocalConfig();
    try { return await fsp.readFile(toLocalPath(nasPath)); }
    catch (e) {
      if (e && e.code === 'ENOENT') throw notFoundErr(nasPath);
      throw new StorageError(`Cannot read ${nasPath}: ${e.message}`, 502, 'read-failed');
    }
  },
  // Streamed read — what GET /api/files/:id/content wants, so a 400 MB show
  // file never lands in the server's heap on its way to a browser.
  async getStream(nasPath) {
    requireLocalConfig();
    const target = toLocalPath(nasPath);
    let st;
    try { st = await fsp.stat(target); }
    catch (e) {
      if (e && e.code === 'ENOENT') throw notFoundErr(nasPath);
      throw new StorageError(`Cannot read ${nasPath}: ${e.message}`, 502, 'read-failed');
    }
    return { stream: fs.createReadStream(target), size: st.size, mtime: st.mtime };
  },
  // The four non-throwing operations stay non-throwing when unconfigured: an
  // unconfigured store genuinely holds nothing, and a cascade delete must not
  // 501 because the byte layer was never wired.
  async exists(nasPath) {
    if (!STORAGE_ROOT_SET) return false;
    try { await fsp.access(toLocalPath(nasPath), fs.constants.F_OK); return true; }
    catch { return false; }
  },
  async move(fromPath, toPath) {
    if (!STORAGE_ROOT_SET) return { ok: false, reason: 'storage-not-configured' };
    const from = toLocalPath(fromPath);
    const to = toLocalPath(toPath);
    if (!(await localDriver.exists(fromPath))) return { ok: false, reason: 'source-missing' };
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return { ok: true, from: fromPath, to: toPath };
  },
  async remove(nasPath) {
    if (!STORAGE_ROOT_SET) return { ok: false, reason: 'storage-not-configured' };
    try { await fsp.unlink(toLocalPath(nasPath)); return { ok: true }; }
    catch { return { ok: false }; }
  },
  async stat(nasPath) {
    if (!STORAGE_ROOT_SET) return null;
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

  // ── THE ONLY EVIDENCE OF LIVENESS THAT COSTS NOTHING ──────────────────────
  // `configured()` is a statement about environment variables and has never
  // opened a socket. For a year /api/health printed `storageReady:true` and
  // `storageTls:"verified"` at a NAS that had never once answered, which is
  // how a wiring fault survived a full day of debugging (2026-08-28).
  //
  // Making /api/health dial the NAS is the wrong fix — it is polled, and a
  // 30-second NAS timeout would take the health check down with it. So the
  // driver REMEMBERS instead: every real request records whether the NAS
  // answered. Health then reports a measurement it actually took, on traffic
  // it was already sending, and says plainly when there has never been any.
  // The deliberate, on-demand measurement is POST /api/admin/storage-probe.
  let lastContact = null;   // { at, ok, method, status, error }
  function note(ok, method, status, error) {
    lastContact = { at: new Date().toISOString(), ok, method, status: status || null,
                    error: error ? String(error).slice(0, 300) : null };
  }

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
        note(false, method, null, `no answer within ${timeoutMs}ms`);
        done(reject, new StorageError(
          `The NAS did not answer ${method} ${decodeURI(urlPath)} within ${timeoutMs}ms. ` +
          `The record is intact; the bytes did not move. ` +
          `POST /api/admin/storage-probe walks the chain step by step and names the layer that hung.`,
          504, 'timeout'));
      }, timeoutMs);

      req.on('error', (e) => { note(false, method, null, e.code || e.message); done(reject, wrapNetError(e, method, urlPath)); });
      req.on('response', (res) => {
        note(true, method, res.statusCode, null);
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
        // CONFIGURED, not CONNECTED. The name stays for compatibility; the
        // sibling field below says out loud what it does and does not mean,
        // because a boolean called `ready` next to a host name reads as "I
        // checked" to every human who has ever looked at this endpoint.
        ready: configured(),
        readyMeans: 'configured — URL, user and password are set and parse. This is NOT a connection test.',
        // host + share only. NEVER the credentials — /api/health is read by
        // anything that can reach the app.
        target: base ? `${base.protocol}//${base.host}${basePath}` : null,
        via: proxy ? `tailscale-socks:${proxy.host}:${proxy.port}` : 'direct',
        // `verified` used to be the value here when no self-signed allowance
        // was configured. It was a CONFIG LABEL that read like a handshake
        // result, and it cost a day. `system-trust` describes the setting, and
        // tlsMeasured below carries the only real answer there is.
        tls: secure ? (allowSelfSigned ? 'self-signed-allowed' : (tlsOpts.ca ? 'pinned-ca' : 'system-trust')) : 'none',
        tlsMeans: 'the configured verification policy. No certificate has been inspected to produce it.',
        // The measurement, taken on traffic the app was already sending.
        lastContact,
        liveness: lastContact
          ? `${lastContact.ok ? 'the NAS answered' : 'the NAS did NOT answer'} at ${lastContact.at} (${lastContact.method}${lastContact.status ? ' ' + lastContact.status : ''}${lastContact.error ? ': ' + lastContact.error : ''})`
          : 'never contacted since this process started — run POST /api/admin/storage-probe to measure the chain',
        timeoutMs,
        // Bytes live on the NAS, not on this container's disk. Never at risk.
        ephemeralRisk: false,
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
    info: () => ({ driver: name, ready: false, target: null, via: null, ephemeralRisk: false }),
    mkdirs: fail, put: fail, get: fail, getStream: fail,
    exists: async () => false, move: fail, remove: fail, stat: async () => null
  };
}

// ════════════════════════════════════════════════════════════════════════════
// THE STORAGE PROBE — a live walk of the whole chain, reported step by step
// ────────────────────────────────────────────────────────────────────────────
// /api/health answers a CONFIG question: "is a driver selected, and are its
// variables parseable?" It has never opened a socket. On 2026-08-28 that gap
// cost a day of debugging: health said storageReady:true and
// storageTls:"verified" while EVERY byte operation timed out at 30s with one
// undifferentiated message. `verified` was never a handshake result — it is
// the string this file prints when NAS_WEBDAV_ALLOW_SELF_SIGNED is unset.
// Config labels that read like measurements are worse than no labels at all.
//
// This function is the instrument that was missing. It walks the chain one
// layer at a time and returns per-step outcome + milliseconds + error IN THE
// RESPONSE BODY, because a Railway container has no log an operator can read
// from a laptop: the response IS the instrument.
//
//   1  socks-port      is anything accepting TCP on the tailscaled proxy port
//   2  socks-greeting  does it speak SOCKS5, and on which auth method
//   3  socks-connect   does CONNECT to the NAS succeed, and how fast
//   4  tls             handshake; cert subject/issuer; and whether the cert
//                      WOULD verify — reported honestly whichever way the
//                      config is set, so "verified" can never again be a label
//   5  propfind        WebDAV alive + credentials accepted (Depth: 0)
//   6  mkcol           write permission on the share
//   7  put             16 bytes up
//   8  get             the same 16 bytes back, compared
//   9  delete          cleanup, and proof DELETE works
//
// Two cross-checks run alongside, and they are the ones that ASSIGN BLAME:
//   · http-connect — tailscaled serves SOCKS5 and HTTP CONNECT on the SAME
//     port (net/proxymux sniffs the first byte). Tunnelling the identical
//     bytes both ways discriminates "our hand-rolled SOCKS5 client is wrong"
//     from "the data plane is dead". Our SOCKS5 code has only ever been
//     tested against our own in-process SOCKS server, which is self-consistent
//     and proves nothing about real tailscaled.
//   · tailscale status/ping — run through the same binary the entrypoint
//     started. A ping that succeeds while step 3 hangs proves the fault is
//     ours; a ping that fails while the coordination server says "Connected"
//     proves the control plane is lying and the fault is the tailnet's.
// ════════════════════════════════════════════════════════════════════════════

const TS_SOCK = '/var/run/tailscale/tailscaled.sock';
const TS_BIN = '/usr/local/bin/tailscale';

// execFile with a hard timeout, never rejecting — a probe step that cannot run
// reports why and lets the walk continue.
function runCmd(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let cp;
    try { cp = require('child_process'); }
    catch (e) { return resolve({ ok: false, ms: 0, error: e.message, stdout: '', stderr: '' }); }
    try {
      cp.execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({
          ok: !err,
          ms: Date.now() - t0,
          error: err ? (err.killed ? `timed out after ${timeoutMs}ms` : err.message) : null,
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        }));
    } catch (e) {
      resolve({ ok: false, ms: Date.now() - t0, error: e.message, stdout: '', stderr: '' });
    }
  });
}

// Plain TCP connect with its own clock.
function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`no answer from ${host}:${port} in ${timeoutMs}ms`), { ms: Date.now() - t0 }));
    }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock._probeMs = Date.now() - t0; resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); e.ms = Date.now() - t0; reject(e); });
  });
}

// The SOCKS5 handshake again — but instrumented, and with the address type as
// a PARAMETER. The driver always sends ATYP=domain (so tailscaled resolves
// MagicDNS names inside the tailnet); when the target is a bare tailnet IP
// that means shipping "100.73.203.27" as a DOMAIN NAME, which not every SOCKS5
// server forgives. Being able to run the same CONNECT both ways is the whole
// point of having a probe rather than a theory.
async function socksTrace(proxy, host, port, timeoutMs, atypMode) {
  const trace = { proxyConnectMs: null, greeting: null, method: null, atyp: atypMode,
                  connectMs: null, boundAddr: null, reply: null };
  const sock = await tcpConnect(proxy.host, proxy.port, timeoutMs);
  trace.proxyConnectMs = sock._probeMs;
  try {
    const methods = proxy.user ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
    const greet = await readN(sock, 2, timeoutMs);
    trace.greeting = greet.toString('hex');
    if (greet[0] !== 0x05) throw new Error(`not SOCKS5 — first reply byte 0x${greet[0].toString(16)}`);
    if (greet[1] === 0xff) throw new Error('proxy rejected every auth method offered');
    trace.method = `0x${greet[1].toString(16).padStart(2, '0')}`;
    if (greet[1] === 0x02) {
      if (!proxy.user) throw new Error('proxy demands username/password and none is configured');
      const u = Buffer.from(proxy.user, 'utf8');
      const p = Buffer.from(proxy.pass || '', 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const auth = await readN(sock, 2, timeoutMs);
      if (auth[1] !== 0x00) throw new Error('proxy rejected the username/password');
    } else if (greet[1] !== 0x00) {
      throw new Error(`proxy chose an unsupported auth method (${trace.method})`);
    }

    const t1 = Date.now();
    let req;
    if (atypMode === 'ipv4' && net.isIPv4(String(host))) {
      const octets = String(host).split('.').map((n) => parseInt(n, 10));
      req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets]),
                           Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
    } else {
      const hostBuf = Buffer.from(String(host), 'utf8');
      if (hostBuf.length > 255) throw new Error('hostname too long for SOCKS5');
      req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
                           Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
    }
    sock.write(req);
    const head = await readN(sock, 4, timeoutMs);
    trace.connectMs = Date.now() - t1;
    trace.reply = `0x${head[1].toString(16).padStart(2, '0')}`;
    if (head[0] !== 0x05) throw new Error('malformed SOCKS5 reply');
    if (head[1] !== 0x00) {
      throw new Error(`CONNECT refused — ${SOCKS_REPLY[head[1]] || `reply code ${head[1]}`}`);
    }
    const a = head[3];
    if (a === 0x01) { const b = await readN(sock, 6, timeoutMs); trace.boundAddr = `${b[0]}.${b[1]}.${b[2]}.${b[3]}:${b.readUInt16BE(4)}`; }
    else if (a === 0x04) { const b = await readN(sock, 18, timeoutMs); trace.boundAddr = `[v6]:${b.readUInt16BE(16)}`; }
    else if (a === 0x03) { const l = await readN(sock, 1, timeoutMs); const b = await readN(sock, l[0] + 2, timeoutMs); trace.boundAddr = `${b.slice(0, l[0]).toString()}:${b.readUInt16BE(l[0])}`; }
    else throw new Error(`unknown reply address type 0x${a.toString(16)}`);
    return { sock, trace };
  } catch (e) {
    sock.destroy();
    e.trace = trace;
    throw e;
  }
}

// The OTHER tunnel on the same port. tailscaled's proxymux hands anything that
// does not start with 0x05 to its HTTP CONNECT proxy, so this reaches the
// identical dialer through code that is not ours.
async function httpConnectTunnel(proxy, host, port, timeoutMs) {
  const trace = { proxyConnectMs: null, statusLine: null, connectMs: null };
  const sock = await tcpConnect(proxy.host, proxy.port, timeoutMs);
  trace.proxyConnectMs = sock._probeMs;
  try {
    const t1 = Date.now();
    const hp = `${host}:${port}`;
    sock.write(`CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\n\r\n`);
    // Read to the end of the response head, byte at a time so nothing that
    // belongs to the tunnelled stream is swallowed.
    let head = Buffer.alloc(0);
    while (!head.includes('\r\n\r\n')) {
      const b = await readN(sock, 1, timeoutMs);
      head = Buffer.concat([head, b]);
      if (head.length > 8192) throw new Error('CONNECT response head is absurdly long');
    }
    trace.connectMs = Date.now() - t1;
    trace.statusLine = head.toString('utf8').split('\r\n')[0];
    if (!/^HTTP\/1\.[01] 2\d\d/.test(trace.statusLine)) {
      throw new Error(`CONNECT refused — ${trace.statusLine}`);
    }
    return { sock, trace };
  } catch (e) {
    sock.destroy();
    e.trace = trace;
    throw e;
  }
}

// ── THE BYTE-FLOW TEST ──────────────────────────────────────────────────────
// The question step 4 leaves open when it fails. A SOCKS5 CONNECT that answers
// 0x00 is not a courtesy: tailscaled only sends it AFTER its dial returns, so
// the TCP three-way handshake to the NAS really completed. If TLS then hangs,
// exactly one thing is unknown — does a single byte ever come BACK up that
// connection? Write something small and unambiguous, and time the first byte.
//
// The plaintext probe is chosen because an HTTPS port answers it in a way you
// cannot misread: nginx (which is what fronts Synology's WebDAV) replies "400
// The plain HTTP request was sent to HTTPS port". Getting that back proves the
// path carries data in both directions and moves the fault up to TLS. Getting
// NOTHING back, on a connection the far end agreed to open, is the signature
// of a half-open tunnel — and it is a different bug in a different building.
// `reacted` is the field that matters and the one that is easy to leave out.
// A far end that RESETS or CLOSES the connection has ANSWERED — a TLS-only
// port hanging up on a plaintext request is a healthy, talkative server, and
// scoring that as "no data came back" would send the next reader after the
// wrong bug. Only running out the clock in total silence is silence.
async function byteFlow(dial, label, payload, timeoutMs) {
  const out = { label, sent: payload.length, connectMs: null, firstByteMs: null,
                bytesBack: 0, endedBy: null, reacted: false, preview: null, error: null };
  let sock = null;
  try {
    const t0 = Date.now();
    sock = await dial();
    out.connectMs = Date.now() - t0;
    const t1 = Date.now();
    const got = await new Promise((resolve) => {
      const chunks = [];
      const finish = (how) => { if (!out.endedBy) { out.endedBy = how; clearTimeout(timer); resolve(chunks); } };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      sock.on('data', (c) => {
        if (out.firstByteMs === null) out.firstByteMs = Date.now() - t1;
        chunks.push(c);
        // 2 KB is plenty to tell an nginx error page from a TLS ServerHello.
        if (chunks.reduce((n, x) => n + x.length, 0) >= 2048) finish('data');
      });
      sock.on('error', (e) => { out.error = `${e.code || 'error'}: ${e.message}`; finish('error'); });
      sock.on('close', () => finish('close'));
      sock.on('end', () => finish('close'));
      sock.write(payload);
    });
    const buf = Buffer.concat(got);
    out.bytesBack = buf.length;
    out.reacted = buf.length > 0 || out.endedBy === 'close' || out.endedBy === 'error';
    out.preview = buf.length
      ? buf.slice(0, 160).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
      : (out.reacted
        ? `no bytes, but the far end ${out.endedBy === 'error' ? 'reset' : 'closed'} the connection — it DID react`
        : `NOTHING at all in ${timeoutMs}ms on a connection the far end agreed to open`);
  } catch (e) {
    out.error = e.message;
  } finally {
    if (sock) { try { sock.destroy(); } catch (_) {} }
  }
  return out;
}

// An https/http Agent whose sockets come from an arbitrary dialer. Same shape
// as makeSocksAgent, but the transport is a parameter so one WebDAV sequence
// can be run over SOCKS, over HTTP CONNECT, or direct, unchanged.
function makeProbeAgent(dial, secure, tlsOpts, servername) {
  const Base = secure ? https.Agent : http.Agent;
  class ProbeAgent extends Base {
    createConnection(options, cb) {
      dial().then((raw) => {
        if (!secure) return cb(null, raw);
        const opts = { socket: raw, ...tlsOpts };
        // SNI is illegal for an IP literal (RFC 6066). Sending one makes node
        // emit a warning and drop it anyway; not sending it is the honest form.
        if (servername && !net.isIP(servername)) opts.servername = servername;
        const secured = tls.connect(opts);
        secured.once('error', () => { try { raw.destroy(); } catch (_) {} });
        cb(null, secured);
      }, (err) => cb(err));
    }
  }
  return new ProbeAgent({ keepAlive: false, maxSockets: 4 });
}

// One WebDAV request on a probe agent. Never throws for a status — a 401 is a
// RESULT, and the whole point is to report which layer said no.
function probeRequest(agent, opts, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...v, ms: Date.now() - t0 }); } };
    const req = (opts.secure ? https : http).request({
      method: opts.method, host: opts.host, port: opts.port, path: opts.path,
      headers: opts.headers, agent
    });
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, error: `no answer in ${timeoutMs}ms` });
    }, timeoutMs);
    req.on('error', (e) => done({ ok: false, error: `${e.code || 'error'}: ${e.message}` }));
    req.on('response', (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n <= 256 * 1024) chunks.push(c); });
      res.on('error', (e) => done({ ok: false, error: `${e.code || 'error'}: ${e.message}` }));
      res.on('end', () => done({ ok: true, status: res.statusCode, bytes: n, body: Buffer.concat(chunks) }));
    });
    if (opts.body) req.end(opts.body); else req.end();
  });
}

// Which env vars an operator MEANT to set. Setting ALLOW_SELF_SIGNED=1 instead
// of NAS_WEBDAV_ALLOW_SELF_SIGNED=1 is silent today: nothing reads it, nothing
// complains, and /api/health prints "verified" as if a certificate had been
// checked. Naming the near-miss out loud is most of the value of a probe.
const ENV_NEAR_MISSES = {
  ALLOW_SELF_SIGNED: 'NAS_WEBDAV_ALLOW_SELF_SIGNED',
  WEBDAV_ALLOW_SELF_SIGNED: 'NAS_WEBDAV_ALLOW_SELF_SIGNED',
  NAS_ALLOW_SELF_SIGNED: 'NAS_WEBDAV_ALLOW_SELF_SIGNED',
  NAS_WEBDAV_SELF_SIGNED: 'NAS_WEBDAV_ALLOW_SELF_SIGNED',
  WEBDAV_URL: 'NAS_WEBDAV_URL',
  NAS_URL: 'NAS_WEBDAV_URL',
  WEBDAV_USER: 'NAS_WEBDAV_USER',
  WEBDAV_PASS: 'NAS_WEBDAV_PASS',
  NAS_WEBDAV_PASSWORD: 'NAS_WEBDAV_PASS',
  NAS_WEBDAV_USERNAME: 'NAS_WEBDAV_USER',
  TAILSCALE_AUTH_KEY: 'TAILSCALE_AUTHKEY',
  TS_AUTHKEY: 'TAILSCALE_AUTHKEY'
};
function envMisspellings(env = process.env) {
  const out = [];
  for (const [wrong, right] of Object.entries(ENV_NEAR_MISSES)) {
    if (env[wrong] !== undefined && env[right] === undefined) {
      out.push({ set: wrong, ignored: true, meant: right });
    }
  }
  return out;
}

// ── the walk ────────────────────────────────────────────────────────────────
// `opts.timeoutMs` budgets EACH step (default 8s), so the whole probe answers
// inside an HTTP request even when every layer hangs. `opts.write` false stops
// after step 5 — read-only, for a nervous first run against a live share.
async function storageProbe(opts = {}, env = process.env) {
  const t0 = Date.now();
  const stepMs = Math.min(60000, Math.max(1000, parseInt(opts.timeoutMs, 10) || 8000));
  const doWrite = opts.write !== false;
  const runId = require('crypto').randomBytes(4).toString('hex');

  // The nine steps are NUMBERED, not indexed — `3b` is the HTTP CONNECT
  // cross-check and deliberately does not consume a number, so "step 7 failed"
  // means the same thing in every report and in WIRING_DAY.md's symptom table
  // whether or not the cross-check ran.
  const STEP_N = { 'socks-port': 1, 'socks-greeting': 2, 'socks-connect': 3, 'http-connect': '3b',
                   tls: 4, propfind: 5, mkcol: 6, put: 7, get: 8, delete: 9 };
  const steps = [];
  let stopped = null;
  const step = (id, title) => {
    const rec = { n: STEP_N[id], id, title, ok: null, ms: null, detail: null, error: null };
    steps.push(rec);
    return rec;
  };
  const skip = (rec, why) => { rec.ok = null; rec.detail = `skipped — ${why}`; };

  // ── config, as read by the code that actually runs ────────────────────────
  const rawUrl = env.NAS_WEBDAV_URL || '';
  let base = null, parseError = null;
  if (rawUrl) { try { base = new URL(String(rawUrl)); } catch (e) { parseError = e.message; } }
  const secure = base ? base.protocol === 'https:' : true;
  const host = base ? base.hostname : null;
  const port = base ? (base.port ? parseInt(base.port, 10) : (secure ? 443 : 80)) : 0;
  const basePath = base ? base.pathname.replace(/\/+$/, '') : '';
  const user = env.NAS_WEBDAV_USER || '';
  const pass = env.NAS_WEBDAV_PASS || '';
  const allowSelfSigned = String(env.NAS_WEBDAV_ALLOW_SELF_SIGNED || '') === '1';

  const tlsOpts = {};
  if (allowSelfSigned) tlsOpts.rejectUnauthorized = false;
  let caError = null;
  if (env.NAS_WEBDAV_CA) {
    try {
      tlsOpts.ca = String(env.NAS_WEBDAV_CA).includes('BEGIN CERTIFICATE')
        ? String(env.NAS_WEBDAV_CA).replace(/\\n/g, '\n')
        : fs.readFileSync(String(env.NAS_WEBDAV_CA));
    } catch (e) { caError = e.message; }
  }

  const config = {
    driver: (env.STORAGE_DRIVER || 'local').toLowerCase(),
    url: base ? `${base.protocol}//${base.host}${basePath}` : null,
    urlParseError: parseError,
    userSet: !!user, passSet: !!pass,
    allowSelfSigned,
    caSet: !!tlsOpts.ca, caError,
    // The label /api/health prints, repeated here next to the measurement in
    // step 4 so the two can be compared at a glance. It is a policy name, not
    // a result: until this probe ran, nothing had inspected a certificate.
    healthTlsLabel: secure ? (allowSelfSigned ? 'self-signed-allowed' : (tlsOpts.ca ? 'pinned-ca' : 'system-trust')) : 'none',
    healthTlsLabelIsAProbe: false,
    tailscaleAuthkeySet: !!env.TAILSCALE_AUTHKEY,
    tailscaleSocks: env.TAILSCALE_SOCKS || null,
    tailscaleSocksDisable: String(env.TAILSCALE_SOCKS_DISABLE || '') === '1',
    ignoredEnvVars: envMisspellings(env)
  };

  const proxy = host ? proxyForHost(host, env) : null;
  const transport = { via: proxy ? `socks5://${proxy.host}:${proxy.port}` : 'direct' };

  // ── tailscale facts, gathered first: they are the alibi for everything else
  const tailscale = { binary: null, status: null, ping: null, error: null };
  if (proxy || config.tailscaleAuthkeySet) {
    const st = await runCmd(TS_BIN, ['--socket=' + TS_SOCK, 'status', '--json'], Math.min(stepMs, 10000));
    tailscale.binary = st.error && /ENOENT/.test(st.error) ? false : true;
    if (st.ok) {
      try {
        const j = JSON.parse(st.stdout);
        const peers = Object.values(j.Peer || {});
        const target = peers.find((p) => (p.TailscaleIPs || []).includes(host)) ||
                       peers.find((p) => String(p.DNSName || '').toLowerCase().startsWith(String(host).toLowerCase() + '.'));
        tailscale.status = {
          backendState: j.BackendState,
          self: j.Self ? { hostName: j.Self.HostName, online: j.Self.Online, ips: j.Self.TailscaleIPs } : null,
          version: j.Version,
          peerCount: peers.length,
          targetPeer: target ? {
            hostName: target.HostName, dnsName: target.DNSName, os: target.OS,
            online: target.Online, active: target.Active,
            relay: target.Relay || null, curAddr: target.CurAddr || null,
            direct: !!target.CurAddr,
            rxBytes: target.RxBytes, txBytes: target.TxBytes,
            lastHandshake: target.LastHandshake, lastSeen: target.LastSeen,
            clientVersion: target.ClientVersion || null
          } : null,
          // A peer we cannot even find in the peer list is a different problem
          // from a peer that is offline.
          targetFound: !!target
        };
      } catch (e) { tailscale.error = `status --json did not parse: ${e.message}`; }
    } else {
      tailscale.error = st.error || st.stderr.slice(0, 400);
    }
    if (host) {
      const pg = await runCmd(TS_BIN, ['--socket=' + TS_SOCK, 'ping', '-c', '3', '--timeout=4s', host],
        Math.min(stepMs * 2, 20000));
      tailscale.ping = {
        ok: pg.ok, ms: pg.ms,
        output: (pg.stdout || pg.stderr || pg.error || '').trim().split('\n').slice(0, 6)
      };
    }
  } else {
    tailscale.error = 'no tailscale proxy in play for this host — not consulted';
  }

  // ── steps 1-3: the tunnel ─────────────────────────────────────────────────
  const s1 = step('socks-port', `TCP to the tailscaled proxy port`);
  const s2 = step('socks-greeting', 'SOCKS5 greeting / auth-method negotiation');
  const s3 = step('socks-connect', `SOCKS5 CONNECT to ${host}:${port}`);
  const s3b = step('http-connect', 'HTTP CONNECT through the same port (cross-check)');

  let dial = null;                      // the transport the WebDAV steps will use
  let dialName = 'direct';

  if (!base) {
    stopped = 'NAS_WEBDAV_URL is not set or did not parse';
    for (const r of [s1, s2, s3, s3b]) skip(r, stopped);
  } else if (!proxy) {
    for (const r of [s1, s2, s3, s3b]) skip(r, 'no SOCKS proxy configured for this host — dialling direct');
    dial = () => tcpConnect(host, port, stepMs);
    dialName = 'direct';
  } else {
    // 1 — is anything listening at all
    const a = Date.now();
    try {
      const sock = await tcpConnect(proxy.host, proxy.port, stepMs);
      s1.ok = true; s1.ms = Date.now() - a;
      s1.detail = `${proxy.host}:${proxy.port} accepted a connection`;
      sock.destroy();
    } catch (e) {
      s1.ok = false; s1.ms = Date.now() - a;
      s1.error = `${e.code || 'error'}: ${e.message}`;
      s1.detail = e.code === 'ECONNREFUSED'
        ? 'nothing is listening — tailscaled is not up, or it bound ::1 only'
        : 'the proxy port did not answer';
    }

    // 2 + 3 — one connection, two reported outcomes
    const b = Date.now();
    let socksSock = null, socksTraceOut = null, socksErr = null;
    if (s1.ok) {
      try {
        const r = await socksTrace(proxy, host, port, stepMs, 'domain');
        socksSock = r.sock; socksTraceOut = r.trace;
      } catch (e) { socksErr = e; socksTraceOut = e.trace || null; }
    }
    if (!s1.ok) { skip(s2, 'the proxy port did not answer'); skip(s3, 'the proxy port did not answer'); }
    else if (socksTraceOut && socksTraceOut.greeting) {
      s2.ok = true; s2.ms = Date.now() - b;
      s2.detail = `greeting ${socksTraceOut.greeting} — method ${socksTraceOut.method} (0x00 = no auth)`;
      if (socksErr) {
        s3.ok = false; s3.ms = Date.now() - b; s3.error = socksErr.message;
        s3.detail = `ATYP=domain "${host}" — reply ${socksTraceOut.reply || '(none)'}`;
      } else {
        s3.ok = true; s3.ms = socksTraceOut.connectMs;
        s3.detail = `ATYP=domain "${host}" — reply 0x00, bound ${socksTraceOut.boundAddr}, ` +
                    `proxy TCP ${socksTraceOut.proxyConnectMs}ms + CONNECT ${socksTraceOut.connectMs}ms`;
      }
    } else {
      s2.ok = false; s2.ms = Date.now() - b;
      s2.error = socksErr ? socksErr.message : 'no greeting';
      skip(s3, 'the SOCKS5 greeting failed');
    }
    if (socksSock) socksSock.destroy();

    // 3b — the same tunnel through code that is not ours
    const c = Date.now();
    try {
      const r = await httpConnectTunnel(proxy, host, port, stepMs);
      s3b.ok = true; s3b.ms = r.trace.connectMs;
      s3b.detail = `${r.trace.statusLine} — proxy TCP ${r.trace.proxyConnectMs}ms + CONNECT ${r.trace.connectMs}ms`;
      r.sock.destroy();
    } catch (e) {
      s3b.ok = false; s3b.ms = Date.now() - c; s3b.error = e.message;
      s3b.detail = 'HTTP CONNECT on the same port also failed — the fault is below our SOCKS client';
    }

    // The WebDAV steps take whichever tunnel actually opened. SOCKS first
    // (it is what the driver uses); HTTP CONNECT as the fallback, and if THAT
    // is the one that works, the report says so and the driver is the bug.
    if (s3.ok) { dial = async () => (await socksTrace(proxy, host, port, stepMs, 'domain')).sock; dialName = 'socks5'; }
    else if (s3b.ok) { dial = async () => (await httpConnectTunnel(proxy, host, port, stepMs)).sock; dialName = 'http-connect'; }
  }
  transport.used = dial ? dialName : null;

  // ── step 4: TLS ───────────────────────────────────────────────────────────
  const s4 = step('tls', 'TLS handshake with the NAS');
  if (!dial) skip(s4, stopped || 'no transport reached the NAS');
  else if (!secure) { s4.ok = true; s4.ms = 0; s4.detail = 'plain http — no TLS in this configuration'; }
  else {
    const d = Date.now();
    try {
      const raw = await dial();
      const sock = await new Promise((resolve, reject) => {
        // rejectUnauthorized:false HERE ON PURPOSE — the probe must be able to
        // SEE the certificate in order to report what verification would say.
        // The verdict below is computed from socket.authorized, which node
        // fills in either way, so this is more honest than the config label,
        // not less.
        const t = tls.connect({
          socket: raw, rejectUnauthorized: false, handshakeTimeout: stepMs,
          ...(tlsOpts.ca ? { ca: tlsOpts.ca } : {}),
          ...(net.isIP(host) ? {} : { servername: host })
        });
        const timer = setTimeout(() => { t.destroy(); reject(new Error(`TLS handshake did not complete in ${stepMs}ms`)); }, stepMs);
        t.once('secureConnect', () => { clearTimeout(timer); resolve(t); });
        t.once('error', (e) => { clearTimeout(timer); reject(e); });
      });
      const cert = sock.getPeerCertificate() || {};
      const cipher = sock.getCipher() || {};
      s4.ok = true; s4.ms = Date.now() - d;
      s4.detail = {
        protocol: sock.getProtocol(), cipher: cipher.name || null,
        subject: cert.subject ? Object.entries(cert.subject).map(([k, v]) => `${k}=${v}`).join(', ') : null,
        issuer: cert.issuer ? Object.entries(cert.issuer).map(([k, v]) => `${k}=${v}`).join(', ') : null,
        subjectAltName: cert.subjectaltname || null,
        validFrom: cert.valid_from || null, validTo: cert.valid_to || null,
        fingerprint256: cert.fingerprint256 || null,
        selfSigned: !!(cert.subject && cert.issuer &&
                       JSON.stringify(cert.subject) === JSON.stringify(cert.issuer)),
        // THE ANSWER /api/health has been guessing at:
        wouldVerify: sock.authorized,
        verifyError: sock.authorized ? null : String(sock.authorizationError || ''),
        driverWouldAccept: sock.authorized || allowSelfSigned || !!tlsOpts.ca,
        note: sock.authorized
          ? 'this certificate verifies against the system trust store'
          : (allowSelfSigned
            ? 'does not verify, but NAS_WEBDAV_ALLOW_SELF_SIGNED=1 is set, so the driver accepts it'
            : 'does NOT verify and NAS_WEBDAV_ALLOW_SELF_SIGNED is NOT set — the driver will refuse this connection')
      };
      sock.destroy();
    } catch (e) {
      s4.ok = false; s4.ms = Date.now() - d;
      s4.error = `${e.code || 'error'}: ${e.message}`;
    }
  }

  // ── steps 5-9: WebDAV, over exactly the transport that worked ─────────────
  const s5 = step('propfind', 'PROPFIND Depth:0 on the share root');
  const s6 = step('mkcol', 'MKCOL a probe collection');
  const s7 = step('put', 'PUT 16 bytes');
  const s8 = step('get', 'GET the same 16 bytes back');
  const s9 = step('delete', 'DELETE the probe file');
  const rest = [s5, s6, s7, s8, s9];

  const probeDir = `${basePath}/_showrunner-probe`;
  const runDir = `${probeDir}/${runId}`;
  const probeFile = `${runDir}/probe.txt`;
  const payload = Buffer.from(`showrunner-probe-${runId}\n`.slice(0, 16).padEnd(16, '.'), 'utf8');

  const cleanup = { attempted: false, runDir: null, probeDir: null };

  if (!dial) { for (const r of rest) skip(r, stopped || 'no transport reached the NAS'); }
  else if (!user || !pass) { for (const r of rest) skip(r, 'NAS_WEBDAV_USER / NAS_WEBDAV_PASS are not both set'); }
  else if (secure && s4.ok === false) { for (const r of rest) skip(r, 'the TLS handshake never completed'); }
  else {
    const agent = makeProbeAgent(dial, secure, tlsOpts, host);
    const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const call = (method, p, extra = {}) => probeRequest(agent, {
      method, host, port, path: p, secure,
      headers: { Authorization: auth, 'User-Agent': 'e360-showrunner/storage-probe', ...(extra.headers || {}) },
      body: extra.body
    }, stepMs);
    const say = (rec, r, okStatuses, what) => {
      rec.ms = r.ms;
      if (!r.ok) { rec.ok = false; rec.error = r.error; rec.detail = what; return false; }
      rec.ok = okStatuses.includes(r.status);
      rec.detail = `${what} -> ${r.status}`;
      if (!rec.ok) {
        rec.error = r.status === 401 || r.status === 403
          ? `the NAS refused the credentials (${r.status}) — check NAS_WEBDAV_USER/PASS and the account's rights on the share`
          : `unexpected status ${r.status}`;
        const snippet = (r.body || Buffer.alloc(0)).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (snippet) rec.detail += ` — ${snippet}`;
      }
      return rec.ok;
    };

    // 5 — PROPFIND. The only read that transfers nothing.
    const r5 = await call('PROPFIND', basePath || '/', { headers: { Depth: '0', 'Content-Length': '0' } });
    const ok5 = say(s5, r5, [207, 200], `PROPFIND ${basePath || '/'}`);

    if (!ok5) { for (const r of [s6, s7, s8, s9]) skip(r, 'PROPFIND did not succeed'); }
    else if (!doWrite) { for (const r of [s6, s7, s8, s9]) skip(r, 'write:false — read-only probe'); }
    else {
      // 6 — MKCOL. 405 means "already there", which is success for a parent.
      const r6a = await call('MKCOL', probeDir);
      const r6 = await call('MKCOL', runDir);
      s6.ms = (r6a.ms || 0) + (r6.ms || 0);
      const ok6 = say(s6, r6, [201, 405, 301], `MKCOL ${probeDir} (${r6a.status || r6a.error}) then MKCOL ${runDir}`);
      if (ok6) cleanup.runDir = runDir;

      if (!ok6) { for (const r of [s7, s8, s9]) skip(r, 'MKCOL did not succeed'); }
      else {
        const r7 = await call('PUT', probeFile, {
          body: payload, headers: { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) }
        });
        const ok7 = say(s7, r7, [200, 201, 204], `PUT ${probeFile} (${payload.length} bytes)`);

        if (!ok7) { for (const r of [s8, s9]) skip(r, 'PUT did not succeed'); }
        else {
          const r8 = await call('GET', probeFile);
          const ok8 = say(s8, r8, [200], `GET ${probeFile}`);
          if (ok8) {
            const same = Buffer.compare(r8.body || Buffer.alloc(0), payload) === 0;
            s8.ok = same;
            s8.detail += same ? ` — ${r8.bytes} bytes, byte-identical` : ` — ${r8.bytes} bytes, CONTENT DID NOT MATCH`;
            if (!same) s8.error = 'the bytes that came back are not the bytes that went up';
          }
          const r9 = await call('DELETE', probeFile);
          say(s9, r9, [200, 202, 204, 404], `DELETE ${probeFile}`);
        }
      }
    }

    // Housekeeping: a probe that leaves litter on the operator's share is a
    // probe nobody runs twice. Failures here are reported, never fatal.
    if (cleanup.runDir) {
      cleanup.attempted = true;
      const d1 = await call('DELETE', runDir);
      cleanup.runDir = d1.ok ? `deleted (${d1.status})` : `NOT deleted — ${d1.error}`;
      const d2 = await call('DELETE', probeDir);
      cleanup.probeDir = d2.ok ? `deleted (${d2.status})` : `left in place (${d2.status || d2.error})`;
    }
    agent.destroy();
  }

  // ── DEEP: the follow-up questions, asked only when someone asks for them ──
  // { deep: true } adds three measurements that are too slow and too specific
  // to run on every probe, and that are the only way past "TLS hung":
  //   ports  — is it THIS service or the whole host? A CONNECT that succeeds
  //            on 5006 and 5000 and 22 alike says the tunnel opens anything.
  //   wire   — does a byte ever come BACK, and does the answer depend on how
  //            many bytes we send? A short plaintext request answered and a
  //            long one ignored is an MTU fault wearing a TLS costume, because
  //            a TLS ClientHello is the first packet in this app big enough to
  //            hit it.
  //   after  — the peer's rx/tx counters read AGAIN, after all of the above.
  //            Counters that are still zero mean nothing we sent ever entered
  //            the tunnel at all.
  let deep = null;
  if (opts.deep && base && dial) {
    const dialTo = (p) => {
      if (!proxy) return () => tcpConnect(host, p, stepMs);
      if (dialName === 'http-connect') return async () => (await httpConnectTunnel(proxy, host, p, stepMs)).sock;
      return async () => (await socksTrace(proxy, host, p, stepMs, 'domain')).sock;
    };
    const wantPorts = Array.isArray(opts.ports) && opts.ports.length
      ? opts.ports.map((p) => parseInt(p, 10)).filter((p) => p > 0 && p < 65536).slice(0, 12)
      : [port, 5000, 5001, 5005, 22, 445];
    deep = { ports: [], wire: [], peerAfter: null, note: null };

    for (const p of wantPorts) {
      const t = Date.now();
      try {
        const s = await dialTo(p)();
        deep.ports.push({ port: p, open: true, ms: Date.now() - t });
        s.destroy();
      } catch (e) {
        deep.ports.push({ port: p, open: false, ms: Date.now() - t, error: e.message });
      }
    }

    // The size ladder. Same request, same port, four lengths. nginx answers a
    // plaintext request on an HTTPS port with a 400 that names the mistake, so
    // "did anything come back" has an unambiguous yes.
    const pad = (n) => (n <= 0 ? '' : `X-Pad: ${'a'.repeat(n)}\r\n`);
    const plain = (n) => Buffer.from(
      `GET / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: e360-probe\r\n${pad(n)}\r\n`, 'utf8');
    for (const n of [0, 600, 1300, 4000]) {
      const body = plain(n);
      deep.wire.push(await byteFlow(dialTo(port), `plaintext ${body.length}B -> :${port}`, body, stepMs));
    }
    // A different service on the same host, in case 5006 alone is deaf.
    const dsm = deep.ports.find((x) => x.port === 5000 && x.open);
    if (dsm) {
      const body = plain(0);
      deep.wire.push(await byteFlow(dialTo(5000), `plaintext ${body.length}B -> :5000 (DSM http)`, body, stepMs));
    }

    const st2 = await runCmd(TS_BIN, ['--socket=' + TS_SOCK, 'status', '--json'], Math.min(stepMs, 10000));
    if (st2.ok) {
      try {
        const j = JSON.parse(st2.stdout);
        const t = Object.values(j.Peer || {}).find((p) => (p.TailscaleIPs || []).includes(host));
        if (t) deep.peerAfter = { rxBytes: t.RxBytes, txBytes: t.TxBytes, relay: t.Relay,
                                  curAddr: t.CurAddr || null, active: t.Active,
                                  lastHandshake: t.LastHandshake };
      } catch (_) { /* reported by the shallow read above */ }
    }
    const anyReact = deep.wire.some((w) => w.reacted);
    const smallReact = deep.wire.filter((w) => w.sent < 200).some((w) => w.reacted);
    const bigReact = deep.wire.filter((w) => w.sent > 1200).some((w) => w.reacted);
    deep.note = !anyReact
      ? 'NOTHING came back on any connection the far end agreed to open — no bytes, no close, ' +
        'no reset. The tunnel completes TCP handshakes and then carries nothing: the fault is at ' +
        'the far end of the tunnel, not in this app.'
      : (smallReact && !bigReact
        ? 'SMALL writes are answered and LARGE ones are not. That is a path-MTU fault, and a TLS ' +
          'ClientHello is the first thing this app sends that is big enough to hit it.'
        : 'the far end reacts at every size tried — data crosses the tunnel in both directions, ' +
          'so the fault is above the transport.');
  }

  // `ok` is the verdict on THE NINE. The HTTP CONNECT cross-check is evidence,
  // not a gate: a proxy that speaks only SOCKS5 is a perfectly good proxy, and
  // failing the whole probe over it would train the operator to ignore the
  // field that exists to assign blame.
  const failed = steps.filter((s) => s.ok === false && s.id !== 'http-connect');
  return {
    ok: failed.length === 0 && steps.some((s) => s.id === 'delete' && s.ok === true),
    runId,
    startedAt: new Date(t0).toISOString(),
    totalMs: Date.now() - t0,
    stepTimeoutMs: stepMs,
    target: base ? { host, port, basePath, tls: secure } : null,
    config,
    transport,
    tailscale,
    steps,
    cleanup,
    ...(deep ? { deep } : {}),
    firstFailure: failed.length ? { n: failed[0].n, id: failed[0].id, error: failed[0].error } : null,
    verdict: verdictFor(steps, config, tailscale, transport, deep)
  };
}

// The one sentence an operator should read first. Ordered by how far down the
// stack the fault is, because the lowest failing layer is the only one worth
// fixing first.
function verdictFor(steps, config, tailscale, transport, deep) {
  const by = (id) => steps.find((s) => s.id === id) || {};
  const notes = [];
  if (config.ignoredEnvVars.length) {
    notes.push('IGNORED ENV: ' + config.ignoredEnvVars
      .map((v) => `${v.set} is set but nothing reads it — did you mean ${v.meant}?`).join('; '));
  }
  if (by('socks-port').ok === false) {
    notes.push('tailscaled is not accepting connections on its proxy port — the daemon is down, ' +
               'never started, or bound an address the app is not dialling.');
  } else if (by('socks-greeting').ok === false) {
    notes.push('something answers the proxy port but does not speak SOCKS5.');
  } else if (by('socks-connect').ok === false && by('http-connect').ok === true) {
    notes.push('OUR SOCKS5 CLIENT IS THE FAULT: HTTP CONNECT reached the NAS through the same ' +
               'port and the same tailscaled dialer, and SOCKS5 did not.');
  } else if (by('socks-connect').ok === false && by('http-connect').ok === false) {
    notes.push('BOTH tunnels failed at the same place: the fault is below our proxy code — ' +
               'the tailnet data plane to this peer, not the client.');
  }
  if (tailscale && tailscale.status && tailscale.status.targetFound === false) {
    notes.push('the NAS is not in this node\'s peer list at all — check the tailnet, the ACLs, and that the IP is right.');
  } else if (tailscale && tailscale.status && tailscale.status.targetPeer &&
             tailscale.status.targetPeer.online === false) {
    notes.push('the coordination server reports the NAS peer OFFLINE.');
  }
  if (by('tls').ok === false) {
    notes.push('the transport opened but TLS never completed — see the tls step error. ' +
               'Re-run with {"deep":true} to find out whether ANY byte comes back.');
  } else if (by('tls').detail && by('tls').detail.driverWouldAccept === false) {
    notes.push('THE CERTIFICATE IS THE FAULT: ' + by('tls').detail.note);
  }
  if (by('propfind').ok === false) notes.push('WebDAV answered, but not the way the driver needs — see the propfind step.');
  if (by('mkcol').ok === false) notes.push('read works and write does not — the share account is missing write permission.');
  if (!notes.length) {
    const done = by('delete').ok === true;
    notes.push(done
      ? 'every layer answered: the tunnel, TLS, and all six WebDAV verbs. Storage is genuinely live.'
      : 'no layer reported a failure, but the walk did not finish — read the steps.');
  }
  if (transport && transport.used === 'http-connect') {
    notes.push('NOTE: the WebDAV steps above ran over HTTP CONNECT, not the SOCKS5 path the driver uses.');
  }
  if (deep && deep.note) notes.push('DEEP: ' + deep.note);
  return notes;
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
// "These bytes are on a disk a redeploy destroys." Reported, never enforced —
// an operator with a mounted volume wants to see this go false as their proof
// the mount took.
function storageEphemeralRisk() {
  try { return !!storageInfo().ephemeralRisk; } catch { return false; }
}

module.exports = {
  storage, drivers, NAS_ROOT, STORAGE_ROOT, STORAGE_ROOT_SET, MAX_BYTES,
  buildNasPath, buildQuarantinePath, thumbPathFor, fileName, toLocalPath, nasSegments,
  StorageError, storageInfo, storageReady, storageEphemeralRisk, contentTypeFor,
  // the instrument (POST /api/admin/storage-probe)
  storageProbe,
  // testable seams
  makeWebdavDriver, proxyForHost, parseSocks, socksConnect, webdavHostFromEnv, inContainer,
  socksTrace, httpConnectTunnel, envMisspellings, verdictFor
};
