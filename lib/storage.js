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
//   smb / webdav     — STUBBED. The Synology share (`showrunner`, svc account
//                      `svc-showrunner`) is not reachable from dev, and WebDAV
//                      is not enabled on it yet. See the TODO block below.
//
// Punch coverage: 45 (photos live under the mechanical {kind} folder \photo\),
// 46 (proposed bytes quarantine under _agent-inbox and MOVE to the canonical
// path on confirm — a rejected proposal must leave no trace in a show folder).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
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

// UNC path -> a path under STORAGE_ROOT. Strips the configured root, splits on
// backslashes, and rejects any traversal segment.
function toLocalPath(nasPath) {
  let rel = String(nasPath || '');
  if (rel.startsWith(NAS_ROOT)) rel = rel.slice(NAS_ROOT.length);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || /[:*?"<>|]/.test(p)) {
      throw new Error('Unsafe path segment: ' + p);
    }
  }
  return path.join(STORAGE_ROOT, ...parts);
}

// ── LOCAL DRIVER ────────────────────────────────────────────────────────────
const localDriver = {
  name: 'local',
  async put(nasPath, buffer) {
    if (buffer.length > MAX_BYTES) throw new Error(`Body exceeds ${MAX_BYTES} bytes`);
    const target = toLocalPath(nasPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buffer);
    return { ok: true, size: buffer.length, path: nasPath };
  },
  async get(nasPath) {
    return fsp.readFile(toLocalPath(nasPath));
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

// ── SMB / WEBDAV DRIVER — STUB ──────────────────────────────────────────────
// TODO(NAS): the Synology is behind Tom's office gateway and is not reachable
// from dev or from Railway yet. When it is:
//   1. Enable WebDAV (HTTPS, port 5006) on the `showrunner` share, or expose
//      SMB over the Tailscale tailnet.
//   2. Give Railway the tailnet (TS_AUTHKEY) or the WebDAV URL.
//   3. Set STORAGE_DRIVER=webdav plus NAS_WEBDAV_URL / NAS_USER / NAS_PASSWORD
//      (the svc-showrunner credentials live in Tom's password manager).
//   4. Implement the five methods below against `webdav` (npm) or `@marsaud/
//      smb2`. The method contract is exactly the local driver's, so nothing
//      upstream changes.
// Until then every call throws a clear, actionable error rather than silently
// dropping bytes.
function makeRemoteStub(name) {
  const fail = () => {
    const e = new Error(
      `Storage driver '${name}' is not implemented yet — the E360 NAS is not reachable from this ` +
      `environment. Set STORAGE_DRIVER=local (with STORAGE_ROOT) or finish the ${name} driver in lib/storage.js.`
    );
    e.status = 501;
    throw e;
  };
  return {
    name,
    put: fail, get: fail, exists: async () => false, move: fail, remove: fail, stat: async () => null
  };
}

const drivers = {
  local: localDriver,
  smb: makeRemoteStub('smb'),
  webdav: makeRemoteStub('webdav')
};

const storage = drivers[DRIVER] || localDriver;

module.exports = {
  storage, drivers, NAS_ROOT, STORAGE_ROOT, MAX_BYTES,
  buildNasPath, buildQuarantinePath, thumbPathFor, fileName, toLocalPath
};
