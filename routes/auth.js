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
  destroyUserSessionsExcept, generateTempPassword, isLastActiveAdmin,
  getSession, generateApiKey, requireAuth, requireRole, loginRateLimit, clientIp, roleRank
} = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam } = require('../lib/http');
const { dbToUser, dbToApiKey, pick } = require('../lib/mappers');
const { oneOf, ALL_ROLES, AGENT_SCOPES, USER_COLORS, initialsFrom } = require('../lib/enums');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// ════════════════════════════════════════════════════════════════════════════
// PEOPLE — the shared helpers the user-admin routes lean on
// ════════════════════════════════════════════════════════════════════════════

// 2–32 chars, a letter first. The same rule POST has always enforced, lifted
// out so the error text is authored once.
const USERNAME_RE = /^[a-z][a-z0-9_.-]{1,31}$/;
const USERNAME_RULE = 'Username must be 2–32 characters: a letter, then letters, digits, _ . or -';

// The first palette colour nobody is wearing; once all ten are taken it wraps
// on the row count so the choice is at least stable and spread out.
async function nextColor(q = pool) {
  const r = await q.query(`SELECT color FROM users`);
  const taken = new Set(r.rows.map((x) => String(x.color || '').toUpperCase()).filter(Boolean));
  const free = USER_COLORS.find((c) => !taken.has(c.toUpperCase()));
  return free || USER_COLORS[r.rows.length % USER_COLORS.length];
}

// The lockout guard, as a throwing assertion — see lib/auth.js isLastActiveAdmin
// for WHY. Called on every path that could empty the active-admin set:
// deactivation, demotion, and deletion. The message names the fix, because a
// refusal that does not is just a wall.
async function assertNotLastAdmin(userId, what) {
  if (await isLastActiveAdmin(userId)) {
    throw badRequest(
      `This is the only active admin — ${what} would leave nobody able to manage ` +
      'people or reset a password. Make somebody else an admin first.');
  }
}

// A user row, or a 404. Never filtered by `active`: an inactive person is still
// a person, and every history surface has to be able to look them up.
async function loadUser(id, q = pool) {
  const r = await q.query('SELECT * FROM users WHERE id=$1', [id]);
  if (!r.rows.length) throw notFound('User not found');
  return r.rows[0];
}

// ── AUTH ────────────────────────────────────────────────────────────────────
router.post('/auth/login', loginRateLimit, asyncH(async (req, res) => {
  const username = String(pick(req.body, 'username') || '').toLowerCase().trim();
  const password = pick(req.body, 'password');
  if (!username || !password) throw badRequest('Username and password required');

  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  // Same response for "no such user" and "wrong password" — never leak which.
  if (!r.rows.length) return res.status(401).json({ error: 'Invalid username or password' });
  const user = r.rows[0];

  const { ok, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  // A DEACTIVATED account is told so, plainly — but only AFTER the password has
  // verified. That ordering is the whole trick: somebody who cannot produce the
  // password learns nothing (they get the same generic 401 as a typo, so the
  // endpoint is still not an account-existence oracle), while the person who
  // actually owns the account is not left staring at "invalid password",
  // retyping a password they know is right. 403, not 401: the credentials were
  // correct and the client must not treat this as "your session expired".
  if (user.active === false) {
    return res.status(403).json({
      error: 'That account has been deactivated. Ask an admin to turn it back on.',
      deactivated: true
    });
  }

  // F. legacy sha256 row -> bcrypt, in place, on the next successful login.
  if (needsRehash) {
    const fresh = await hashPassword(password);
    await pool.query('UPDATE users SET password_hash=$1, pw_algo=$2 WHERE id=$3',
      [fresh, 'bcrypt', user.id]);
  }

  const token = await createSession(user.id, user.username, clientIp(req));
  // `must_change` rides the login response so the client can put the
  // change-password overlay up BEFORE the app renders. It is not a server-side
  // gate and is not pretending to be one — the session is a full session, and
  // an API client that ignores the flag works exactly as before. What it buys
  // is that nobody keeps living on a password an admin read off their screen.
  res.json({
    token, username: user.username, role: user.role,
    must_change: user.must_change_password === true,
    user: dbToUser(user, { self: true })
  });
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
    finance: session.finance,
    // A returning visit with a valid token never passes through /auth/login, so
    // the flag has to be here too or the forced change is skippable by simply
    // reloading the page.
    must_change: r.rows[0] && r.rows[0].must_change_password === true,
    user: dbToUser(r.rows[0], { self: true })
  });
}));

// ── USERS / ROSTER ──────────────────────────────────────────────────────────
// READ is open to every authenticated user: the roster drives owner pickers,
// @mentions, call sheets and initials chips. WRITE is admin-only.
//
// THE DEFAULT IS THE WORKING ROSTER — active people only. Every consumer of
// this endpoint is a place you are about to hand somebody WORK: an owner
// picker, a crew list, a notify picker, the @mention lookup. Offering a person
// who left the company in any of those is not a small cosmetic wrong; it puts
// their name on a call sheet. The people who left are still in the table, still
// resolve by id or username through GET /users/:key, and still render on every
// history surface — they are simply not on the list of who you can pick.
//
// `?all=1` returns everyone, including the inactive, and is for the ONE screen
// that manages people. It is admin-only, and a non-admin who asks for it just
// gets the working roster rather than a 403: the parameter is a view option on
// a read they were always allowed to make, not a privilege boundary being
// probed. Nothing they could see changes.
router.get('/users', requireAuth, asyncH(async (req, res) => {
  const wantsAll = String(req.query.all || '') === '1' && req.session.role === 'admin';
  const r = wantsAll
    ? await pool.query('SELECT * FROM users ORDER BY id')
    : await pool.query('SELECT * FROM users WHERE active IS NOT FALSE ORDER BY id');
  res.json(r.rows.map((row) => dbToUser(row)));
}));

// api.getUser(username) — accepts a numeric id or a username. Deliberately NOT
// filtered by `active`: this is the lookup every attribution surface uses to
// turn an owner/actor/author string into a name and an avatar, and a former
// teammate's old work has to keep rendering with their name on it.
router.get('/users/:key', requireAuth, asyncH(async (req, res) => {
  const key = String(req.params.key);
  const r = /^\d+$/.test(key)
    ? await pool.query('SELECT * FROM users WHERE id=$1', [parseInt(key, 10)])
    : await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [key]);
  if (!r.rows.length) throw notFound();
  const self = req.session.userId === r.rows[0].id;
  res.json(dbToUser(r.rows[0], { self }));
}));

// ── ADD A PERSON ────────────────────────────────────────────────────────────
// The SERVER mints the password. An admin adding a teammate should never have
// to invent one, and more to the point should never be able to CHOOSE one —
// "welcome123" for everybody is how a workspace ends up with nine accounts
// sharing a password. The minted value is returned in THIS response and in no
// other, is never written to the activity trail, and `must_change` means the
// person cannot keep using it past their first sign-in.
//
// An explicit `password` is still accepted, because scripted setup and the
// smoke suite create users that way and that is a legitimate admin act; when
// one is supplied the server does not echo it back — it already has it.
router.post('/users', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const b = req.body || {};
  const username = String(pick(b, 'username') || '').toLowerCase().trim();
  if (!username) throw badRequest('A username is required');
  if (!USERNAME_RE.test(username)) throw badRequest(USERNAME_RULE);

  const supplied = pick(b, 'password');
  if (supplied !== undefined && String(supplied).length < 8) {
    throw badRequest('Password must be at least 8 characters');
  }
  const generated = supplied === undefined ? generateTempPassword() : null;
  const password = generated || String(supplied);

  const role = oneOf(pick(b, 'role'), ALL_ROLES, 'viewer');
  const name = String(pick(b, 'name') || '').trim();
  const initials = String(pick(b, 'initials') || '').trim().slice(0, 4)
                   || initialsFrom(name, username);
  const color = String(pick(b, 'color') || '').trim() || await nextColor();

  try {
    const r = await pool.query(
      `INSERT INTO users (username, password_hash, role, name, initials, color, title,
                          discipline, phone, email, finance, active,
                          must_change_password, pw_algo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,TRUE,'bcrypt') RETURNING *`,
      [username, await hashPassword(password), role,
       name, initials, color,
       pick(b, 'title') || '', pick(b, 'discipline') || '', pick(b, 'phone') || '',
       pick(b, 'email') || '', !!pick(b, 'finance')]
    );
    // The detail names the person and the role and STOPS. Whatever else is
    // tempting to record here, the password is not a candidate — the audit
    // trail is readable by every authenticated user.
    await logActivity(pool, { actor: req.session.username, action: 'user.create',
      detail: `${username} · ${role}${pick(b, 'finance') ? ' · finance' : ''}` });
    // Shown once. There is no second endpoint that returns it, and no row that
    // holds it — losing it means running a reset, which is one click away.
    res.json({ ...dbToUser(r.rows[0]), ...(generated ? { temp_password: generated } : {}) });
  } catch (e) {
    if (e.code === '23505') throw badRequest('That username is already taken');
    throw e;
  }
}));

// ── EDIT A PERSON ───────────────────────────────────────────────────────────
// Display columns (13) + the finance capability + the role + the active
// toggle, in ONE call, because that is how the Team view's edit form works —
// one dialog, one save. Admin for anyone; a user may edit their own display
// fields but NEVER their own role, finance flag or active state.
//
// Deactivation is the OFFBOARDING act, and it does not delete anything. The
// row stays, every foreign reference to the username stays, and the person's
// history keeps rendering. What it does is: refuse their login, drop their live
// sessions on the floor, and take them off every picker.
router.put('/users/:id', requireAuth, asyncH(async (req, res) => {
  const id = idParam(req);
  const isAdmin = req.session.role === 'admin';
  if (!isAdmin && req.session.userId !== id) throw forbidden('Not allowed');
  const cur = await loadUser(id);
  const b = req.body || {};
  const val = (k) => (pick(b, k) !== undefined ? pick(b, k) : cur[k]);

  const wasActive = cur.active !== false;
  const nextActive = isAdmin && pick(b, 'active') !== undefined ? !!pick(b, 'active') : wasActive;

  let nextRole = cur.role;
  if (isAdmin && pick(b, 'role') !== undefined) {
    nextRole = oneOf(pick(b, 'role'), ALL_ROLES, null);
    if (!nextRole) throw badRequest(`'${pick(b, 'role')}' is not a role`);
  }

  // The two acts that can empty the active-admin set, refused BEFORE anything
  // is written. Order matters: check, then write, so a refusal changes nothing.
  if (wasActive && !nextActive) await assertNotLastAdmin(id, 'deactivating them');
  if (cur.role === 'admin' && nextRole !== 'admin') await assertNotLastAdmin(id, 'changing their role');

  const r = await pool.query(
    `UPDATE users SET name=$1, initials=$2, color=$3, title=$4, discipline=$5,
       phone=$6, email=$7, finance=$8, active=$9, role=$10 WHERE id=$11 RETURNING *`,
    [val('name') || '', val('initials') || '', val('color') || '', val('title') || '',
     val('discipline') || '', val('phone') || '', val('email') || '',
     // capability, active and role are admin-only, whoever is asking
     isAdmin ? !!val('finance') : cur.finance,
     nextActive, nextRole, id]
  );

  // A deactivated person must not keep browsing on the session they already
  // hold. getSession() re-reads `active` every request and would refuse them
  // anyway, so this is belt AND braces — but it is the half that does not
  // depend on a future refactor keeping that check in place.
  if (wasActive && !nextActive) await destroyUserSessions(id);

  if (isAdmin && nextRole !== cur.role) {
    await logActivity(pool, { actor: req.session.username, action: 'user.role',
      detail: `${cur.username} → ${nextRole}` });
  }
  if (isAdmin && !!val('finance') !== !!cur.finance) {
    await logActivity(pool, { actor: req.session.username, action: 'user.finance',
      detail: `${cur.username} → ${val('finance') ? 'granted' : 'revoked'}` });
  }
  if (wasActive !== nextActive) {
    await logActivity(pool, { actor: req.session.username, action: 'user.active',
      detail: `${cur.username} → ${nextActive ? 'reactivated' : 'deactivated'}` });
  } else if (isAdmin && nextRole === cur.role && !!val('finance') === !!cur.finance) {
    await logActivity(pool, { actor: req.session.username, action: 'user.update',
      detail: cur.username });
  }
  res.json(dbToUser(r.rows[0], { self: req.session.userId === id }));
}));

// The role on its own. Kept as its own route (the Team view's quick role
// change, and every existing caller) and carrying the SAME lockout guard —
// a guard that only exists on one of two doors is not a guard.
router.put('/users/:id/role', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const id = idParam(req);
  const role = oneOf(pick(req.body, 'role'), ALL_ROLES, null);
  if (!role) throw badRequest('Invalid role');
  const cur = await loadUser(id);
  if (cur.role === 'admin' && role !== 'admin') await assertNotLastAdmin(id, 'changing their role');
  const r = await pool.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING *', [role, id]);
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
  const cur = await loadUser(id);
  const password = pick(req.body, 'password');
  if (!password || String(password).length < 8) {
    throw badRequest('Password must be at least 8 characters');
  }
  await pool.query(
    `UPDATE users SET password_hash=$1, pw_algo=$2, must_change_password=FALSE WHERE id=$3`,
    [await hashPassword(password), 'bcrypt', id]);
  await destroyUserSessions(id);
  await logActivity(pool, { actor: req.session.username, action: 'user.password',
    detail: `${cur.username} · password set` });
  res.json({ ok: true });
}));

// ── RESET SOMEBODY'S PASSWORD ───────────────────────────────────────────────
// "I'm locked out." The admin does not need to know, invent, or ever see the
// person's real password — they mint a new temp one, read it out once, and the
// person replaces it the moment they sign in. Every session the account had is
// destroyed, because a reset is also what you do when you think an account is
// compromised, and a reset that leaves the intruder's session alive is theatre.
router.post('/users/:id/reset-password', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const id = idParam(req);
  const cur = await loadUser(id);
  const temp = generateTempPassword();
  await pool.query(
    `UPDATE users SET password_hash=$1, pw_algo='bcrypt', must_change_password=TRUE WHERE id=$2`,
    [await hashPassword(temp), id]);
  await destroyUserSessions(id);
  await pool.query('UPDATE api_keys SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
  // Names WHO, never WHAT.
  await logActivity(pool, { actor: req.session.username, action: 'user.password_reset',
    detail: cur.username });
  res.json({ ok: true, username: cur.username, temp_password: temp,
             must_change: true, sessions_ended: true });
}));

// ── CHANGE YOUR OWN PASSWORD ────────────────────────────────────────────────
// Any signed-in user, and the ONE password route that demands the current
// password: this is the endpoint an attacker sitting at an unlocked laptop
// would reach for. Clearing `must_change` is what ends the forced flow, so this
// route is also the exit from the temp password an admin read aloud.
router.put('/me/password', requireAuth, asyncH(async (req, res) => {
  const b = req.body || {};
  const current = pick(b, 'current_password', pick(b, 'current'));
  const next = pick(b, 'password', pick(b, 'new_password'));
  if (!current) throw badRequest('Your current password is required');
  if (!next || String(next).length < 8) throw badRequest('The new password must be at least 8 characters');
  if (String(next) === String(current)) throw badRequest('The new password must be different from the current one');

  const cur = await loadUser(req.session.userId);
  const { ok } = await verifyPassword(current, cur.password_hash);
  if (!ok) throw badRequest('That is not your current password');

  await pool.query(
    `UPDATE users SET password_hash=$1, pw_algo='bcrypt', must_change_password=FALSE WHERE id=$2`,
    [await hashPassword(next), cur.id]);
  // Every OTHER device is signed out; the one doing the changing stays in.
  // Bouncing somebody to the login screen for successfully doing what the app
  // just insisted they do would be an unforced insult.
  await destroyUserSessionsExcept(cur.id, req.headers['x-auth-token']);
  await logActivity(pool, { actor: cur.username, action: 'user.password',
    detail: `${cur.username} · changed their own password` });
  res.json({ ok: true, must_change: false, other_sessions_ended: true });
}));

// Deletion still exists for a mistake — a username typed wrong, an account
// created twice — but it is NOT how somebody leaves. Offboarding is the active
// toggle above, precisely so nothing they touched loses its author. The lockout
// guard applies here too: deleting the last admin is the same hole as demoting
// them, and the self-check alone never covered one admin deleting another.
router.delete('/users/:id', requireAuth, requireRole('admin'), asyncH(async (req, res) => {
  const id = idParam(req);
  if (id === req.session.userId) throw badRequest('You cannot delete your own account');
  const cur = await loadUser(id);
  if (cur.role === 'admin') await assertNotLastAdmin(id, 'deleting them');
  await destroyUserSessions(id);
  await pool.query('UPDATE api_keys SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
  await pool.query('DELETE FROM users WHERE id=$1', [id]);
  await logActivity(pool, { actor: req.session.username, action: 'user.delete', detail: cur.username });
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
