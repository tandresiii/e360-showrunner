// ════════════════════════════════════════════════════════════════════════════
// lib/auth.js — passwords, durable sessions, agent API keys, gates, limits
// ────────────────────────────────────────────────────────────────────────────
// Punch coverage:
//   E. sessions live in Postgres, not a Map — they survive a redeploy.
//   F. sha256+salt -> bcryptjs (pure JS, no native build on Railway). Legacy
//      sha256 hashes still verify and are transparently re-hashed on next login.
//   AGENT_API §1. durable, hashed api_keys in x-agent-key; a key ACTS AS its
//      user and inherits that user's role, read LIVE from `users` every request.
//   AGENT_API §9. route topology: the agent middleware refuses to run on any
//      path outside /api/agent/*, so a new human endpoint is never accidentally
//      agent-reachable.
//   Roles. Tom/Tony/Jim = admin. Candice = manager + `finance` CAPABILITY
//      (sees margins, approves POs). Capability, not a rank.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { ROLE_RANK, ALL_ROLES, roleRank, sameUser, AGENT_SCOPES } = require('./enums');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || '12', 10);
const KEY_PEPPER = process.env.AGENT_KEY_PEPPER || 'e360salt';
const LEGACY_SALT = 'e360salt';

// ── PASSWORDS ───────────────────────────────────────────────────────────────
function legacyHash(password) {
  return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}
async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}
// Verifies against bcrypt OR the legacy sha256 hash. Returns
// {ok, needsRehash} so the login route can upgrade the row in place.
async function verifyPassword(password, storedHash) {
  const s = String(storedHash || '');
  if (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$')) {
    return { ok: await bcrypt.compare(String(password), s), needsRehash: false };
  }
  // legacy sha256 hex — constant-time compare
  const candidate = legacyHash(password);
  const a = Buffer.from(candidate);
  const b = Buffer.from(s);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, needsRehash: ok };
}

// ── SESSIONS (durable) ──────────────────────────────────────────────────────
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function createSession(userId, username, ip = '') {
  const token = generateToken();
  await pool.query(
    `INSERT INTO sessions (token, user_id, username, expires_at, ip)
     VALUES ($1,$2,$3, NOW() + ($4 || ' hours')::interval, $5)`,
    [token, userId, username, String(SESSION_HOURS), ip || '']
  );
  return token;
}
async function destroySession(token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
}
async function destroyUserSessions(userId) {
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
}
async function purgeExpiredSessions() {
  const r = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  return r.rowCount;
}
// Resolves a session token to a LIVE user row — role and capabilities are read
// from `users` on every request, never copied onto the session, so a role
// change takes effect immediately (AGENT_API §9, last row).
async function getSession(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const r = await pool.query(
    `SELECT s.token, s.user_id, s.expires_at, u.username, u.role, u.finance, u.active, u.name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token=$1 AND s.expires_at > NOW()`,
    [token]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (row.active === false) return null;
  // best-effort touch; never blocks the request
  pool.query('UPDATE sessions SET last_seen_at=NOW() WHERE token=$1', [token]).catch(() => {});
  return {
    userId: row.user_id, username: row.username, role: row.role,
    finance: !!row.finance, name: row.name || '', actor: row.username, isAgent: false
  };
}

// ── AGENT API KEYS (AGENT_API §1) ───────────────────────────────────────────
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key) + KEY_PEPPER).digest('hex');
}
// sk_sr_live_<40 hex>. Shown once at creation, never again.
function generateApiKey() {
  const raw = 'sk_sr_live_' + crypto.randomBytes(20).toString('hex');
  return { key: raw, prefix: raw.slice(0, 12), hash: hashKey(raw) };
}
async function resolveApiKey(rawKey, ip = '') {
  if (!rawKey || typeof rawKey !== 'string' || rawKey.length > 200) return null;
  const r = await pool.query(
    `SELECT k.id, k.user_id, k.scopes, k.revoked_at, u.username, u.role, u.finance, u.active, u.name
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash=$1`,
    [hashKey(rawKey)]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (row.revoked_at) return null;
  if (row.active === false) return null;
  pool.query('UPDATE api_keys SET last_used_at=NOW(), last_used_ip=$2 WHERE id=$1',
    [row.id, String(ip || '').slice(0, 64)]).catch(() => {});
  return {
    keyId: row.id, userId: row.user_id, username: row.username,
    role: row.role, finance: !!row.finance, name: row.name || '',
    scopes: row.scopes || [], actor: 'agent:' + row.username, isAgent: true
  };
}

// ── MIDDLEWARE ──────────────────────────────────────────────────────────────
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
}

// Session auth. Rejects an agent key outright: /api/* outside /api/agent/* is
// human-only by route topology (AGENT_API §9).
function requireAuth(req, res, next) {
  if (req.headers['x-agent-key']) {
    return res.status(403).json({ error: 'Agent keys may only be used on /api/agent/* endpoints' });
  }
  const token = req.headers['x-auth-token'];
  getSession(token).then((session) => {
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    req.session = session;
    req.actor = session.username;
    next();
  }).catch(next);
}

// Optional session — used by the few routes that accept a key OR a session
// (AGENT_API §6: GET /api/agent/proposals).
function optionalAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return next();
  getSession(token).then((s) => { if (s) { req.session = s; req.actor = s.username; } next(); })
    .catch(next);
}

// Agent-key auth. Mounted ONLY under /api/agent — the guard below is belt and
// braces so a future refactor cannot widen its reach by accident.
function requireAgentKey(req, res, next) {
  if (!req.baseUrl.startsWith('/api/agent') && !req.originalUrl.startsWith('/api/agent')) {
    return res.status(403).json({ error: 'Agent keys may only be used on /api/agent/* endpoints' });
  }
  const raw = req.headers['x-agent-key'];
  if (!raw) return res.status(401).json({ error: 'Invalid or revoked agent key' });
  resolveApiKey(raw, clientIp(req)).then((identity) => {
    if (!identity) return res.status(401).json({ error: 'Invalid or revoked agent key' });
    req.agent = identity;
    req.session = identity;      // role gates read the same shape
    req.actor = identity.actor;  // 'agent:<username>' (AGENT_API §1 attribution)
    next();
  }).catch(next);
}

// Global (project-agnostic) minimum-role gate.
function requireRole(min) {
  return (req, res, next) => {
    if (roleRank(req.session && req.session.role) < roleRank(min)) {
      return res.status(403).json({ error: `Requires '${min}' role or higher` });
    }
    next();
  };
}
// AGENT_API §1: 403 {"error":"Key lacks scope 'agent:file'"}
function requireScope(scope) {
  return (req, res, next) => {
    const scopes = (req.agent && req.agent.scopes) || [];
    if (!scopes.includes(scope)) {
      return res.status(403).json({ error: `Key lacks scope '${scope}'` });
    }
    next();
  };
}
// 28 / Roles: the finance CAPABILITY. Admins always have it; Candice has it by
// flag without being an admin.
function hasFinance(session) {
  return !!session && (session.role === 'admin' || session.finance === true);
}
function requireFinance(req, res, next) {
  if (!hasFinance(req.session)) {
    return res.status(403).json({ error: 'Requires the finance capability (accounting) or admin' });
  }
  next();
}
// 28 (Tom's decision 2026-08-21, supersedes manager+): PO approval = the
// admins (Tom/Tony/Jim) + Candice's finance capability.
//
// This DELEGATES to hasFinance rather than repeating it. The two were byte-
// identical copies, which is the setup for silent divergence: a future decision
// updates one and leaves the other quietly enforcing the old rule. They are
// still separate FUNCTIONS because they are separate decisions — if approving a
// PO and seeing a margin ever come apart, give this one its own body then, on
// purpose, rather than discovering the split in production.
function canApprovePO(session) {
  return hasFinance(session);
}

// ── PROJECT-SCOPED GATES ────────────────────────────────────────────────────
// manager+ edits anything; a pm edits only projects they own.
function canEditProject(session, project) {
  if (!session) return false;
  if (roleRank(session.role) >= ROLE_RANK.manager) return true;
  if (session.role === 'pm' && project && sameUser(project.owner, session.username)) return true;
  return false;
}
// Anyone who can edit the project, OR a tech who owns the step.
function canUpdateStepStatus(session, step, project) {
  if (canEditProject(session, project)) return true;
  if (session && session.role === 'tech' && step && sameUser(step.owner, session.username)) return true;
  return false;
}
// 52/recap: manager+ OR the show's own owner. Settled 2026-08-27 (Tom): a
// closeout belongs to the SHOW's owner, and the same set both drafts and
// approves it. This is THE recap owner predicate — the bell, the Approve
// button and routes/deliverables.js assertCanDraft all call this one function,
// so the draft and approve gates cannot drift apart again.
// THE closeout predicate — drafting, editing, approving, reopening and
// recording a send all ask this one question, and the bell badge asks it too.
//
// Tom (2026-08-27): a closeout belongs to the SHOW's owner, with manager+ as
// cover. HARDENING 14 adds the rank floor that makes that literal:
//
//   The DRAFT path already carried a pm+ floor; the APPROVE path did not. They
//   agreed for every pm+ owner and disagreed BELOW pm, so a tech who owned a
//   show could APPROVE a recap he was forbidden to DRAFT — approving being the
//   higher-privilege act, the ordering was backwards. Both readings were
//   defensible (drop the floor, or add it), and Tom's call was to ADD it: a
//   tech-owned show is unusual, and manager/admin cover means nothing is
//   stranded. Reversible in one line — delete the floor below and both gates
//   agree again the other way.
//
// The floor applies ONLY to the owner branch. manager+ still passes on rank
// alone, which is what keeps it a floor rather than a wall.
function canApproveRecap(session, show) {
  if (!session) return false;
  if (roleRank(session.role) >= ROLE_RANK.manager) return true;
  if (roleRank(session.role) < ROLE_RANK.pm) return false;
  return !!(show && sameUser(show.owner, session.username));
}

// ── RATE LIMITING (in-memory token bucket) ──────────────────────────────────
// Deliberately in-process: one Railway dyno, and a limiter that needs Redis to
// boot is a limiter that gets switched off. AGENT_API §9: 120 writes/hour and
// 600 reads/hour per key.
const buckets = new Map();
function takeToken(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (b.count > limit) return { ok: false, retryAfter: Math.ceil((b.reset - now) / 1000) };
  return { ok: true, remaining: limit - b.count };
}
// keep the map from growing without bound on a long-lived process
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now >= v.reset) buckets.delete(k);
}, 60_000).unref?.();

function rateLimit({ limit, windowMs, keyFn, name = 'rate' }) {
  return (req, res, next) => {
    const id = `${name}:${keyFn(req)}`;
    const r = takeToken(id, limit, windowMs);
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: 'Rate limited', retryAfter: r.retryAfter });
    }
    next();
  };
}
const isWrite = (req) => req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';

// AGENT_API §9 verbatim: 120 writes/hour, 600 reads/hour, per key.
function agentRateLimit(req, res, next) {
  const who = (req.agent && req.agent.keyId) || clientIp(req);
  const write = isWrite(req);
  const r = takeToken(`agent:${write ? 'w' : 'r'}:${who}`, write ? 120 : 600, 3600_000);
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: 'Rate limited', retryAfter: r.retryAfter });
  }
  next();
}
// Login is the one endpoint worth throttling hard by IP.
const loginRateLimit = rateLimit({
  name: 'login', limit: parseInt(process.env.LOGIN_RATE_LIMIT || '20', 10),
  windowMs: 15 * 60_000, keyFn: clientIp
});
// Everything else: a generous per-IP ceiling that only a loop can hit.
const apiRateLimit = rateLimit({
  name: 'api', limit: parseInt(process.env.API_RATE_LIMIT || '1200', 10),
  windowMs: 5 * 60_000, keyFn: clientIp
});

module.exports = {
  hashPassword, verifyPassword, legacyHash,
  createSession, destroySession, destroyUserSessions, getSession, purgeExpiredSessions,
  generateApiKey, hashKey, resolveApiKey,
  requireAuth, optionalAuth, requireAgentKey, requireRole, requireScope, requireFinance,
  hasFinance, canApprovePO, canEditProject, canUpdateStepStatus, canApproveRecap,
  rateLimit, agentRateLimit, loginRateLimit, apiRateLimit, clientIp,
  ROLE_RANK, ALL_ROLES, roleRank, AGENT_SCOPES, BCRYPT_ROUNDS, SESSION_HOURS
};
