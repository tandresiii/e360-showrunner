// ════════════════════════════════════════════════════════════════════════════
// lib/notify.js — F3. THE NOTIFICATION OUTBOX
// ────────────────────────────────────────────────────────────────────────────
// Tony's rule (TEAM_FEEDBACK "Notification control") says the ACTOR chooses who
// hears about a significant action. This module answers the NEXT question:
// having been chosen, HOW does that person hear about it?
//
//   the bell           — unchanged, primary, and never suppressed by anything
//                        here. lib/mentions.js still writes the anchored note
//                        and the mention rows; that IS the in-app notification.
//   the outbox         — a SECOND channel that mirrors the same event, subject
//                        to the recipient's own preference.
//
// The two are deliberately not coupled in the other direction: a queued email
// that fails cannot remove a bell item, and a preference of 'off' silences the
// email only. You always see it in the app.
//
// ── the four real deliveries that enqueue ───────────────────────────────────
//   assignment  a step assigned to you            (routes/core.js)
//   mention     an @mention of you in a note      (routes/notes.js createNote)
//   notify      a notify-picker pick              (lib/mentions.js notifyTargets)
//   report_nag  a tech show report you still owe  (lib/reports.js)
//
// ── preference ──────────────────────────────────────────────────────────────
//   immediate → queued, flushed by the next flush
//   digest    → queued with mode='digest' AND the user's single open digest row
//               is refreshed. A future scheduler flushes digest rows on a timer;
//               there is no timer in this app and none is pretended (see TODO).
//   off       → recorded as 'skipped' with a reason, not dropped. A silenced
//               notification that leaves no trace is indistinguishable from a
//               bug, and this table is how you tell them apart.
//
// ── skip-if-read-in-app ─────────────────────────────────────────────────────
// A row carrying note_id is checked against note_reads at FLUSH time. If the
// person already read it in the app, the row is marked skipped instead of
// mailed. That is the whole rule, and it lives in exactly one place.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool } = require('./db');
const { logActivity } = require('./activity');
const {
  NOTIFY_KINDS, NOTIFY_MODES, NOTIFY_DEFAULT_MODE, NOTIFY_STATUSES
} = require('./enums');
const mail = require('./mail');

// ── PREFERENCES ─────────────────────────────────────────────────────────────
// The table stores DEVIATIONS only; the default map is the answer for everyone
// else. Reading is therefore never a "missing row" problem.
async function prefsFor(username, q = pool) {
  const out = {};
  for (const k of NOTIFY_KINDS) out[k] = NOTIFY_DEFAULT_MODE[k] || 'digest';
  if (!username) return out;
  const r = await q.query(
    'SELECT kind, mode FROM notification_prefs WHERE LOWER(username)=LOWER($1)', [username]);
  for (const row of r.rows) {
    if (NOTIFY_KINDS.includes(row.kind) && NOTIFY_MODES.includes(row.mode)) out[row.kind] = row.mode;
  }
  return out;
}
async function modeFor(username, kind, q = pool) {
  const p = await prefsFor(username, q);
  return p[kind] || NOTIFY_DEFAULT_MODE[kind] || 'digest';
}
// Upsert one (user, kind) preference. Writing the house default REMOVES the
// row rather than storing it, so the table stays a deviation list and a later
// change to the defaults reaches everyone who never expressed an opinion.
async function setPref(username, kind, mode, q = pool) {
  if (!NOTIFY_KINDS.includes(kind)) { const e = new Error(`unknown notification kind "${kind}"`); e.status = 400; throw e; }
  if (!NOTIFY_MODES.includes(mode)) { const e = new Error(`mode must be one of: ${NOTIFY_MODES.join(', ')}`); e.status = 400; throw e; }
  if (mode === (NOTIFY_DEFAULT_MODE[kind] || 'digest')) {
    await q.query('DELETE FROM notification_prefs WHERE LOWER(username)=LOWER($1) AND kind=$2',
      [username, kind]);
    return mode;
  }
  await q.query(
    `INSERT INTO notification_prefs (username, kind, mode, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (username, kind) DO UPDATE SET mode=EXCLUDED.mode, updated_at=NOW()`,
    [username, kind, mode]);
  return mode;
}

// ── ENQUEUE ─────────────────────────────────────────────────────────────────
// Called from inside the SAME transaction as the change it announces, so a
// rolled-back assignment cannot leave a queued email about it.
//
// Returns the row (or null when there was nothing to enqueue). NEVER throws for
// an ordinary reason: a notification is a side effect of the real work, and a
// mail-layer hiccup must not roll back the assignment that caused it.
async function enqueue(q, {
  username, kind, subject, body = '', link = '', noteId = null,
  projectId = null, showId = null, actor = ''
}) {
  const to = String(username || '').replace(/^agent:/, '').trim();
  if (!to) return null;
  if (!NOTIFY_KINDS.includes(kind)) return null;
  // You are never mailed about your own action — the same rule notifyTargets()
  // applies to the bell, applied to the second channel.
  if (String(actor || '').replace(/^agent:/, '').toLowerCase() === to.toLowerCase()) return null;

  const mode = await modeFor(to, kind, q);
  const status = mode === 'off' ? 'skipped' : 'queued';
  const skipped = mode === 'off' ? 'preference off' : null;

  const r = await q.query(
    `INSERT INTO notification_outbox
       (username, kind, mode, status, subject, body, link, note_id, project_id, show_id,
        actor, skipped_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [to, kind, mode === 'off' ? 'immediate' : mode, status,
     String(subject || '').slice(0, 240), String(body || '').slice(0, 4000),
     String(link || '').slice(0, 500), noteId, projectId, showId,
     String(actor || '').slice(0, 120), skipped]);

  if (mode === 'digest') await refreshDigest(q, to);
  return r.rows[0];
}

// Enqueue for several people at once; returns the rows that were written.
async function enqueueMany(q, usernames, spec) {
  const out = [];
  for (const u of usernames || []) {
    const row = await enqueue(q, { ...spec, username: u });
    if (row) out.push(row);
  }
  return out;
}

// ── THE DIGEST ROW ──────────────────────────────────────────────────────────
// "a queued digest row per user that a future scheduler flushes" — literally
// that. ONE open row per person, kind='digest', whose subject counts the items
// waiting behind it. It is not a copy of them; flushing it flushes them.
//
// TODO (honest): NOTHING IN THIS APP RUNS ON A TIMER. Immediate rows flush on
// the boot sweep and on POST /api/admin/sweep; digest rows flush only when a
// caller asks for them explicitly (POST /api/admin/notifications/flush with
// {digest:true}). A real daily digest needs a scheduler — Railway cron, or the
// per-user agents of ARCHITECTURE.md — and until one exists this app will not
// pretend it has one.
async function refreshDigest(q, username) {
  const c = await q.query(
    `SELECT COUNT(*)::int AS n FROM notification_outbox
      WHERE LOWER(username)=LOWER($1) AND mode='digest' AND status='queued' AND kind <> 'digest'`,
    [username]);
  const n = c.rows[0].n || 0;
  const subject = `Showrunner digest — ${n} update${n === 1 ? '' : 's'} waiting`;
  const existing = await q.query(
    `SELECT id FROM notification_outbox
      WHERE LOWER(username)=LOWER($1) AND kind='digest' AND status='queued'
      ORDER BY id ASC LIMIT 1`, [username]);
  if (existing.rows.length) {
    await q.query('UPDATE notification_outbox SET subject=$2, queued_at=queued_at WHERE id=$1',
      [existing.rows[0].id, subject]);
    return existing.rows[0].id;
  }
  const ins = await q.query(
    `INSERT INTO notification_outbox (username, kind, mode, status, subject, body)
     VALUES ($1,'digest','digest','queued',$2,$3) RETURNING id`,
    [username, subject,
     'The updates you asked to receive as a digest rather than one at a time.']);
  return ins.rows[0].id;
}

// ── FLUSH ───────────────────────────────────────────────────────────────────
// The one place a driver is called. Handles, in order:
//   1. skip-if-read-in-app   (note_id present and note_reads has the pair)
//   2. the driver            (log by default; graph when configured)
//   3. the outcome           sent · skipped · queued-still (retryable) · failed
//
// A retryable refusal — the unconfigured/unwired graph driver — LEAVES THE ROW
// QUEUED. That is the difference between "we could not send this yet" and "we
// will never send this", and it is why turning MAIL_* on later delivers the
// backlog instead of discovering it was discarded.
async function emailFor(username, q = pool) {
  const r = await q.query(
    'SELECT email, name FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  return r.rows[0] || null;
}

async function flushOne(q, row) {
  // 1. skip-if-read-in-app
  if (row.note_id) {
    const read = await q.query(
      'SELECT 1 FROM note_reads WHERE note_id=$1 AND LOWER(username)=LOWER($2)',
      [row.note_id, row.username]);
    if (read.rows.length) {
      await q.query(
        `UPDATE notification_outbox SET status='skipped', skipped_reason='read in-app',
           sent_at=NOW() WHERE id=$1`, [row.id]);
      return { id: row.id, outcome: 'skipped', reason: 'read in-app' };
    }
  }
  const who = await emailFor(row.username, q);
  if (!who || !String(who.email || '').trim()) {
    // No address is a PERMANENT problem for this row, not a transient one.
    await q.query(
      `UPDATE notification_outbox SET status='skipped', skipped_reason='no email address on file',
         sent_at=NOW(), attempts=attempts+1 WHERE id=$1`, [row.id]);
    return { id: row.id, outcome: 'skipped', reason: 'no email address on file' };
  }

  let res;
  try {
    res = await mail.send({
      to: who.email, toName: who.name || row.username,
      subject: row.subject, text: row.body, link: row.link
    });
  } catch (e) {
    res = { ok: false, retryable: true, driver: mail.driverName(), error: e.message };
  }

  if (res.ok) {
    await q.query(
      `UPDATE notification_outbox SET status='sent', driver=$2, sent_at=NOW(),
         attempts=attempts+1, last_error=NULL WHERE id=$1`, [row.id, res.driver]);
    // The 'log' driver's whole delivery IS this activity row.
    if (res.driver === 'log') {
      await logActivity(q, {
        projectId: row.project_id, showId: row.show_id,
        actor: 'system', action: 'notification.sent',
        detail: `${row.kind} → ${row.username} · ${row.subject}`
      });
    }
    return { id: row.id, outcome: 'sent', driver: res.driver };
  }
  if (res.retryable) {
    await q.query(
      `UPDATE notification_outbox SET attempts=attempts+1, driver=$2, last_error=$3 WHERE id=$1`,
      [row.id, res.driver, String(res.error || '').slice(0, 500)]);
    return { id: row.id, outcome: 'queued', error: res.error, status: res.status || 501 };
  }
  await q.query(
    `UPDATE notification_outbox SET status='failed', attempts=attempts+1, driver=$2,
       last_error=$3 WHERE id=$1`, [row.id, res.driver, String(res.error || '').slice(0, 500)]);
  return { id: row.id, outcome: 'failed', error: res.error };
}

// flush({ digest, username, limit }) — immediate rows by default.
async function flush({ digest = false, username = null, limit = 200 } = {}, q = pool) {
  const params = [];
  const where = [`status='queued'`];
  if (!digest) { where.push(`mode='immediate'`); }
  if (username) { params.push(username); where.push(`LOWER(username)=LOWER($${params.length})`); }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
  const r = await q.query(
    `SELECT * FROM notification_outbox WHERE ${where.join(' AND ')}
     ORDER BY id ASC LIMIT $${params.length}`, params);

  const counts = { considered: r.rows.length, sent: 0, skipped: 0, queued: 0, failed: 0 };
  const results = [];
  for (const row of r.rows) {
    const out = await flushOne(q, row);
    counts[out.outcome] = (counts[out.outcome] || 0) + 1;
    results.push(out);
  }
  // A digest row whose members all went is no longer a digest of anything.
  if (digest) {
    await q.query(
      `UPDATE notification_outbox SET status='skipped', skipped_reason='digest empty', sent_at=NOW()
        WHERE kind='digest' AND status='queued'
          AND NOT EXISTS (SELECT 1 FROM notification_outbox o2
                          WHERE o2.username = notification_outbox.username
                            AND o2.kind <> 'digest' AND o2.status='queued')`);
  }
  return { ...counts, driver: mail.driverName(), configured: mail.mailConfigured(), results };
}

// ── reads ───────────────────────────────────────────────────────────────────
async function listFor(username, { limit = 100, status = null } = {}, q = pool) {
  const params = [username];
  let sql = 'SELECT * FROM notification_outbox WHERE LOWER(username)=LOWER($1)';
  if (status && NOTIFY_STATUSES.includes(status)) { params.push(status); sql += ` AND status=$${params.length}`; }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  sql += ` ORDER BY id DESC LIMIT $${params.length}`;
  const r = await q.query(sql, params);
  return r.rows;
}

module.exports = {
  prefsFor, modeFor, setPref,
  enqueue, enqueueMany, refreshDigest,
  flush, flushOne, listFor, emailFor
};
