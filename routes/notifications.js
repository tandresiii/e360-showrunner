// ════════════════════════════════════════════════════════════════════════════
// routes/notifications.js — F3 the outbox + F6 the admin sweep
// ────────────────────────────────────────────────────────────────────────────
// Two surfaces:
//
//   /api/me/…      a person's own preferences and their own queue. Nobody can
//                  read or write anyone else's — a notification queue is a list
//                  of what someone is being told, and that is theirs.
//   /api/admin/…   the operator's view: the whole outbox, the mail driver's
//                  status, a manual flush, and the sweep.
//
// THE SWEEP IS THE HONEST ANSWER TO "no cron". It runs once on boot and
// whenever an admin asks. It is idempotent, so asking twice costs nothing and
// changes nothing. What it is NOT is a daily scheduled job — see lib/lifecycle
// sweep() for the TODO that says so out loud rather than pretending.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');

const { pool, withTx } = require('../lib/db');
const { asyncH, badRequest, forbidden, idParam, limitOf } = require('../lib/http');
const { requireAuth, requireRole } = require('../lib/auth');
const { pick, dbToNotification } = require('../lib/mappers');
const { NOTIFY_KINDS, NOTIFY_MODES, NOTIFY_DEFAULT_MODE, NOTIFY_STATUSES } = require('../lib/enums');
const notify = require('../lib/notify');
const mail = require('../lib/mail');
const lifecycle = require('../lib/lifecycle');

const router = express.Router();
router.use(requireAuth);

// ── the vocabulary, published so the Settings card never hardcodes it ───────
router.get('/notification-kinds', asyncH(async (req, res) => {
  res.json({
    kinds: NOTIFY_KINDS.filter((k) => k !== 'digest'),
    modes: NOTIFY_MODES,
    defaults: NOTIFY_DEFAULT_MODE,
    labels: {
      assignment: 'Work assigned to me',
      mention: '@mentions of me',
      notify: 'Someone chose to notify me',
      report_nag: 'Show reports I still owe'
    },
    // A person deciding how much mail to get deserves to know whether any of it
    // can actually leave the building.
    delivery: { driver: mail.driverName(), configured: mail.mailConfigured() }
  });
}));

// ── MY PREFERENCES ──────────────────────────────────────────────────────────
router.get('/me/notification-prefs', asyncH(async (req, res) => {
  res.json({
    username: req.session.username,
    prefs: await notify.prefsFor(req.session.username),
    defaults: NOTIFY_DEFAULT_MODE,
    driver: mail.driverName(),
    configured: mail.mailConfigured()
  });
}));

// PUT { assignment:'immediate', mention:'off', … } — partial is fine.
router.put('/me/notification-prefs', asyncH(async (req, res) => {
  const b = req.body || {};
  const src = (b.prefs && typeof b.prefs === 'object') ? b.prefs : b;
  const keys = Object.keys(src).filter((k) => NOTIFY_KINDS.includes(k) && k !== 'digest');
  if (!keys.length) {
    throw badRequest(`send at least one of: ${NOTIFY_KINDS.filter((k) => k !== 'digest').join(', ')}`);
  }
  for (const k of keys) {
    if (!NOTIFY_MODES.includes(src[k])) {
      throw badRequest(`"${src[k]}" is not a delivery mode — use ${NOTIFY_MODES.join(', ')}`);
    }
  }
  await withTx(async (c) => {
    for (const k of keys) await notify.setPref(req.session.username, k, src[k], c);
  });
  res.json({
    username: req.session.username,
    prefs: await notify.prefsFor(req.session.username),
    defaults: NOTIFY_DEFAULT_MODE
  });
}));

// ── MY QUEUE ────────────────────────────────────────────────────────────────
router.get('/me/notifications', asyncH(async (req, res) => {
  const status = pick(req.query, 'status');
  if (status && !NOTIFY_STATUSES.includes(String(status))) {
    throw badRequest(`"${status}" is not a notification status`);
  }
  const rows = await notify.listFor(req.session.username,
    { limit: limitOf(req, 50, 200), status: status ? String(status) : null });
  res.json(rows.map(dbToNotification));
}));

// ── ADMIN: the whole outbox ─────────────────────────────────────────────────
router.get('/admin/notification-outbox', requireRole('admin'), asyncH(async (req, res) => {
  const params = [];
  const where = [];
  const status = pick(req.query, 'status');
  if (status) {
    if (!NOTIFY_STATUSES.includes(String(status))) throw badRequest(`"${status}" is not a notification status`);
    params.push(String(status)); where.push(`status=$${params.length}`);
  }
  const kind = pick(req.query, 'kind');
  if (kind) {
    if (!NOTIFY_KINDS.includes(String(kind))) throw badRequest(`"${kind}" is not a notification kind`);
    params.push(String(kind)); where.push(`kind=$${params.length}`);
  }
  const username = pick(req.query, 'username');
  if (username) { params.push(String(username)); where.push(`LOWER(username)=LOWER($${params.length})`); }
  params.push(limitOf(req, 100, 500));
  const r = await pool.query(
    `SELECT * FROM notification_outbox${where.length ? ' WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT $${params.length}`, params);
  const counts = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM notification_outbox GROUP BY status');
  res.json({
    rows: r.rows.map(dbToNotification),
    counts: counts.rows.reduce((a, x) => { a[x.status] = x.n; return a; }, {}),
    driver: mail.driverName(),
    configured: mail.mailConfigured(),
    missing: mail.driverName() === 'graph' ? mail.graphMissing() : []
  });
}));

// ── ADMIN: mail status ──────────────────────────────────────────────────────
// What an operator needs to know before wondering why nothing arrived.
router.get('/admin/mail-status', requireRole('admin'), asyncH(async (req, res) => {
  const missing = mail.driverName() === 'graph' ? mail.graphMissing() : [];
  const q = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox WHERE status='queued'`);
  res.json({
    driver: mail.driverName(),
    configured: mail.mailConfigured(),
    missing,
    queued: q.rows[0].n,
    env: mail.GRAPH_VARS,
    note: mail.driverName() === 'log'
      ? 'The log driver records every delivery in the activity trail. Nothing leaves the building.'
      : (missing.length
        ? 'Graph is selected but not configured — items stay queued and deliver once the vars are set.'
        : 'Graph is configured; the wire call is pending the mailbox + app registration (SCHEMA.md).')
  });
}));

// ── ADMIN: flush ────────────────────────────────────────────────────────────
// POST { digest:true } also flushes the digest queue. A future scheduler calls
// exactly this endpoint; there is no scheduler in this app.
router.post('/admin/notifications/flush', requireRole('admin'), asyncH(async (req, res) => {
  const b = req.body || {};
  const out = await notify.flush({
    digest: !!pick(b, 'digest'),
    username: pick(b, 'username') || null,
    limit: parseInt(pick(b, 'limit'), 10) || 200
  });
  res.json(out);
}));

// ── ADMIN: THE SWEEP ────────────────────────────────────────────────────────
// F2 + F6 in one idempotent pass: strike overdue shows, create and re-nag the
// tech reports they owe, re-check every closeout, auto-archive what is ripe,
// then flush the immediate notification queue.
router.post('/admin/sweep', requireRole('admin'), asyncH(async (req, res) => {
  const b = req.body || {};
  const out = await lifecycle.sweep({
    actor: req.actor,
    flush: pick(b, 'flush', true) !== false
  });
  res.json({
    ok: true,
    ...out,
    note: 'This app has no scheduler. The sweep runs on boot and whenever an admin asks. ' +
          'A real daily job needs Railway cron or the per-user agents (ARCHITECTURE.md).'
  });
}));

module.exports = router;
