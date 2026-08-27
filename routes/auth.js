// ════════════════════════════════════════════════════════════════════════════
// routes/auth.js — login, the roster, and agent API keys
// ────────────────────────────────────────────────────────────────────────────
// Punch coverage: E (durable sessions), F (bcrypt, with transparent upgrade of
// the legacy sha256 rows on next login), 13 (roster display columns + the
// finance capability), AGENT_API §1 (key management is HUMAN-ONLY — session
// auth, never reachable with an agent key; `requireAuth` rejects x-agent-key
// outright, so this whole module is closed to agents by construction).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool } = require('../lib/db');
const {
  hashPassword, verifyPassword, createSession, destroySession, destroyUserSessions,
  getSession, generateApiKey, requireAuth, requireRole, loginRateLimit, clientIp, roleRank
} = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam } = require('../lib/http');
const { dbToUser, dbToApiKey, pick } = require('../lib/mappers');
const { oneOf, ALL_ROLES, AGENT_SCOPES } = require('../lib/enums');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// ── AUTH ────────────────────────────────────────────────────────────────────
router.post('/auth/login', loginRateLimit, asyncH(async (req, res) => {
  const username = String(pick(req.body, 'username') || '').toLowerCase().trim();
  const password = pick(req.body, 'password');
  if (!username || !password) throw badRequest('Username and password required');

  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  // Same response for "no such user" and "wrong password" — never leak which.
  if (!r.rows.length) return res.status(401).json({ error: 'Invalid username or password' });
  const user = r.rows[0];
  if (user.active === false) return res.status(401).json({ error: 'Invalid username or password' });

  const { ok, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  // F. legacy sha256 row -> bcrypt, in place, on the next successful login.
  if (needsRehash) {
    const fresh = await hashPassword(password);
    await pool.query('UPDATE users SET password_hash=$1, pw_algo=$2 WHERE id=$3',
      [fresh, 'bcrypt', user.id]);
  }

  const token = await createSession(user.id, user.username, clientIp(req));
  res.json({ token, username: user.username, role: user.role, user: dbToUser(user, { self: true }) });
}));

router.post('/auth/logout', asyncH(async (req, res) => {
  await destroySession(req.headers['x-auth-token']);
  res.json({ ok: true });
}));

// The front-end's api.currentUser(). Returns the FULL user record (initials,
// color, title, discipline, phone, finance) — public/data.js CURRENT_USER shape.
router.get('/auth/me', asyncH(async (req, res) => {
  const session = await getSession(req.headers['x-auth-token']);
  if (!session) return res.json({ loggedIn: false });
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [session.userId]);
  res.json({
    loggedIn: true, username: session.username, role: session.role,
    finance: session.finance, user: dbToUser(r.rows[0], { self: true })
  });
}));

// ── USERS / ROSTER ──────────────────────────────────────────────────────────
// READ is open to every authenticated user: the roster drives owner pickers,
// @mentions, call sheets and initials chips. WRITE is admin-only.
router.get('/users', requireAuth, asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM users ORDER BY id');
  res.json(r.rows.map((row) => dbToUser(row)));
}));

// api.getUser(username) — accepts a numeric id or a username.
router.get('/users/:key', requireAuth, asyncH(async (req, res) => {
  const key = String(req.params.key);
  const r = /^\d+$/.test(key)
    ? await pool.query('SELECT * FROM users WHERE id=$1', [parseInt(key, 10)])
    : await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [key]);
  if (!r.rows.length) throw notFound();
  const self = req.session.userId === r.rows[0].id;
  res.json(dbToUser(r.rows[0], { self }));
}));

router.post('/users', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const b = req.body || {};
  const username = String(pick(b, 'username') || '').toLowerCase().trim();
  const password = pick(b, 'password');
  if (!username || !password) throw badRequest('Username and password required');
  if (!/^[a-z][a-z0-9_.-]{1,31}$/.test(username)) {
    throw badRequest('Username must be 2–32 chars: a letter, then letters/digits/_.-');
  }
  const role = oneOf(pick(b, 'role'), ALL_ROLES, 'viewer');
  try {
    const r = await pool.query(
      `INSERT INTO users (username, password_hash, role, name, initials, color, title,
                          discipline, phone, email, finance, pw_algo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'bcrypt') RETURNING *`,
      [username, await hashPassword(password), role,
       pick(b, 'name') || '', pick(b, 'initials') || '', pick(b, 'color') || '',
       pick(b, 'title') || '', pick(b, 'discipline') || '', pick(b, 'phone') || '',
       pick(b, 'email') || '', !!pick(b, 'finance')]
    );
    await logActivity(pool, { actor: req.session.username, action: 'user.create', detail: username });
    res.json(dbToUser(r.rows[0]));
  } catch (e) {
    if (e.code === '23505') throw badRequest('Username already exists');
    throw e;
  }
}));

// Display columns (13) + the finance capability. Admin for anyone; a user may
// edit their own display fields but NEVER their own role or finance flag.
router.put('/users/:id', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  const isAdmin = req.session.role === 'admin';
  if (!isAdmin && req.session.userId !== id) throw forbidden('Not allowed');
  const cur = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  const b = req.body || {};
  const val = (k) => (pick(b, k) !== undefined ? pick(b, k) : cur[k]);
  const r = await pool.query(
    `UPDATE users SET name=$1, initials=$2, color=$3, title=$4, discipline=$5,
       phone=$6, email=$7, finance=$8, active=$9 WHERE id=$10 RETURNING *`,
    [val('name') || '', val('initials') || '', val('color') || '', val('title') || '',
     val('discipline') || '', val('phone') || '', val('email') || '',
     // capability + active are admin-only, whoever is asking
     isAdmin ? !!val('finance') : cur.finance,
     isAdmin ? (pick(b, 'active') !== undefined ? !!pick(b, 'active') : cur.active !== false) : cur.active !== false,
     id]
  );
  res.json(dbToUser(r.rows[0], { self: req.session.userId === id }));
}));

router.put('/users/:id/role', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const id = idParam(req);
  const role = oneOf(pick(req.body, 'role'), ALL_ROLES, null);
  if (!role) throw badRequest('Invalid role');
  const r = await pool.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING *', [role, id]);
  if (!r.rows.length) throw notFound();
  await logActivity(pool, { actor: req.session.username, action: 'user.role',
    detail: `${r.rows[0].username} → ${role}` });
  res.json(dbToUser(r.rows[0]));
}));

// The finance CAPABILITY (Candice). Admin-only, and deliberately its own route
// so granting it is a visible, audited act rather than a field on a form.
router.put('/users/:id/finance', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const id = idParam(req);
  const on = !!pick(req.body, 'finance', pick(req.body, 'on'));
  const r = await pool.query('UPDATE users SET finance=$1 WHERE id=$2 RETURNING *', [on, id]);
  if (!r.rows.length) throw notFound();
  await logActivity(pool, { actor: req.session.username, action: 'user.finance',
    detail: `${r.rows[0].username} → ${on ? 'granted' : 'revoked'}` });
  res.json(dbToUser(r.rows[0]));
}));

// Password change: admin for anyone, or a user for themselves. Changing a
// password kills that user's other sessions.
router.put('/users/:id/password', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  if (req.session.role !== 'admin' && req.session.userId !== id) throw forbidden('Not allowed');
  const password = pick(req.body, 'password');
  if (!password || String(password).length < 8) {
    throw badRequest('Password must be at least 8 characters');
  }
  await pool.query('UPDATE users SET password_hash=$1, pw_algo=$2 WHERE id=$3',
    [await hashPassword(password), 'bcrypt', id]);
  await destroyUserSessions(id);
  res.json({ ok: true });
}));

router.delete('/users/:id', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const id = idParam(req);
  if (id === req.session.userId) throw badRequest('You cannot delete your own account');
  await destroyUserSessions(id);
  await pool.query('UPDATE api_keys SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
  await pool.query('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// AGENT API KEYS — AGENT_API §1. Human-only by route topology.
// ════════════════════════════════════════════════════════════════════════════
// A key ACTS AS its user and inherits that user's role. Role is read live from
// `users` on every agent request — never copied onto the key — so changing a
// role changes the key's powers immediately, and a key can never escalate
// itself. Keys are REVOKED, never deleted.

router.get('/keys', requireAuth, asyncH(async (req, res) => {
  const admin = req.session.role === 'admin';
  const wanted = pick(req.query, 'username');
  const r = admin && wanted
    ? await pool.query('SELECT * FROM api_keys WHERE username=$1 ORDER BY id DESC', [wanted])
    : admin && String(req.query.all) === '1'
      ? await pool.query('SELECT * FROM api_keys ORDER BY id DESC')
      : await pool.query('SELECT * FROM api_keys WHERE user_id=$1 ORDER BY id DESC', [req.session.userId]);
  res.json(r.rows.map(dbToApiKey));   // never the key, never the hash
}));

// The ONLY response that ever contains the key itself.
router.post('/keys', requireAuth, asyncH(async (req, res) => {
  const b = req.body || {};
  const label = String(pick(b, 'label') || '').slice(0, 120);
  let scopes = pick(b, 'scopes');
  if (!Array.isArray(scopes) || !scopes.length) scopes = ['agent:read'];
  const bad = scopes.filter((s) => !AGENT_SCOPES.includes(s));
  if (bad.length) throw badRequest(`Unknown scope '${bad[0]}'`);

  // self, or an admin minting a key for someone else
  let targetId = req.session.userId;
  let targetName = req.session.username;
  const forUser = pick(b, 'username');
  if (forUser && forUser !== req.session.username) {
    if (req.session.role !== 'admin') throw forbidden('Only an admin may mint a key for another user');
    const u = await pool.query('SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)', [forUser]);
    if (!u.rows.length) throw notFound('User not found');
    targetId = u.rows[0].id; targetName = u.rows[0].username;
  }

  const { key, prefix, hash } = generateApiKey();
  const r = await pool.query(
    `INSERT INTO api_keys (user_id, username, label, key_prefix, key_hash, scopes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [targetId, targetName, label, prefix, hash, scopes, req.session.username]
  );
  await logActivity(pool, { actor: req.session.username, action: 'key.create',
    detail: `${targetName}: ${label || prefix}` });
  res.json({ ...dbToApiKey(r.rows[0]), key });   // shown once, never again
}));

router.delete('/keys/:id', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  const cur = (await pool.query('SELECT * FROM api_keys WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  if (req.session.role !== 'admin' && cur.user_id !== req.session.userId) {
    throw forbidden('Not allowed');
  }
  await pool.query('UPDATE api_keys SET revoked_at=NOW() WHERE id=$1 AND revoked_at IS NULL', [id]);
  await logActivity(pool, { actor: req.session.username, action: 'key.revoke',
    detail: `${cur.username}: ${cur.label || cur.key_prefix}` });
  res.json({ ok: true });
}));

module.exports = router;
