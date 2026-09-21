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
//   immediate → queued, and flushed BY THE ACTION ITSELF — a kick registered on
//               the after-commit hook of the transaction that enqueued it (see
//               THE IMMEDIATE KICK below). Nobody has to sweep. A slow safety
//               net meets whatever a crash left behind.
//   digest    → queued with mode='digest' AND the user's single open digest row
//               is refreshed. Digest rows ride the morning digest timer — the
//               daily sweep (lib/digest.js runDigestSweep) flushes them — and
//               an admin can drain them any moment from Settings (see below).
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
  // "Immediate" has to MEAN immediate — kickImmediate() carries the whole
  // argument, including why this cannot simply call flush() right here.
  if (r.rows[0].status === 'queued' && r.rows[0].mode === 'immediate') {
    kickImmediate(q, to);
  }
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
// "a queued digest row per user that a scheduler flushes" — literally that.
// ONE open row per person, kind='digest', whose subject counts the items
// waiting behind it. It is not a copy of them; flushing it flushes them.
//
// The drain (9/16 — this used to be an honest TODO): the morning digest timer
// (lib/digest.js armDigestTimer → runDigestSweep) now flushes the digest
// queue on its daily pass, so batched rows ride the morning digest instead of
// queuing forever. The human doors stay: POST /api/admin/notifications/flush
// with {digest:true} (Settings → Notifications → "Flush digest queue"), and
// POST /api/admin/digest runs the whole sweep — Tom's law, 9/16: "there
// shouldnt be anything that cant also be done manually".
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

// flush({ digest, username, limit, trigger }) — immediate rows by default.
// `trigger` never changes what is sent; it is the label the health block carries
// so "the automatic half is alive" and "an admin pressed the button" are
// distinguishable from outside.
async function flush({ digest = false, username = null, limit = 200,
                       trigger = 'manual' } = {}, q = pool) {
  const params = [];
  const where = [`status='queued'`];
  if (!digest) { where.push(`mode='immediate'`); }
  if (username) { params.push(username); where.push(`LOWER(username)=LOWER($${params.length})`); }

  // ── STALE DIGEST COLLAPSE (2026-09-21) ────────────────────────────────────
  // A 'daily_digest' row is written once per person per UTC day and is the
  // MORNING'S PLATE — a snapshot of what needed them that day. While the mail
  // driver was a skeleton these accumulated: production carried three queued
  // daily_digest rows for some people, one per silent day. Flushing them all at
  // first light would deliver three stale mornings at once, two of them wrong.
  //
  // So the NEWEST queued daily_digest per person wins and the older ones are
  // marked skipped with the reason NAMED — the same doctrine as every other
  // non-delivery here: a silenced notification that leaves no trace is
  // indistinguishable from a bug. Only 'daily_digest' collapses; nothing else
  // in this table is a snapshot that a later row supersedes.
  const collapse = await q.query(
    `UPDATE notification_outbox SET status='skipped',
        skipped_reason='superseded by newer digest', sent_at=NOW()
      WHERE ${[...where, `kind='daily_digest'`].join(' AND ')}
        AND id < (SELECT MAX(o2.id) FROM notification_outbox o2
                   WHERE o2.kind='daily_digest' AND o2.status='queued'
                     AND LOWER(o2.username)=LOWER(notification_outbox.username))`,
    params.slice());

  params.push(Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000));
  const r = await q.query(
    `SELECT * FROM notification_outbox WHERE ${where.join(' AND ')}
     ORDER BY id ASC LIMIT $${params.length}`, params);

  const counts = { considered: r.rows.length, sent: 0, skipped: 0, queued: 0, failed: 0,
                   superseded: collapse.rowCount || 0 };
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
  const out = { ...counts, driver: mail.driverName(), configured: mail.mailConfigured(), results };
  // What /api/health reads, and the only durable record that the automatic
  // half is alive. Recorded for every IMMEDIATE pass whoever asked for it —
  // the kick, the safety net, the boot sweep, the admin button — because the
  // question an operator has at 2am is "when did immediate mail last move",
  // not "which door moved it". `trigger` answers the second one anyway.
  if (!digest) {
    try {
      const left = await q.query(
        `SELECT COUNT(*)::int AS n FROM notification_outbox
          WHERE status='queued' AND mode='immediate'`);
      out.queuedLeft = left.rows[0].n;
    } catch (_) { /* the counts above are still the truth; this is a garnish */ }
    lastImmediate = {
      at: new Date().toISOString(), trigger,
      considered: out.considered, sent: out.sent,
      queuedLeft: out.queuedLeft == null ? null : out.queuedLeft
    };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// THE IMMEDIATE KICK — what makes 'immediate' mean immediate
// ────────────────────────────────────────────────────────────────────────────
// Until 2026-09-21 nothing flushed an immediate row at ACTION time. flush() was
// called from server boot, the admin sweep and the admin endpoint, and that was
// all — invisible for as long as the 'log' driver was the only one, because a
// queued row and a logged row read the same to everybody. The day the real
// Graph driver went live in production a person's @mention email sat in the
// outbox until an admin happened to press Sweep. That is the defect this fixes.
//
// ── THE TRANSACTION-VISIBILITY CONSTRAINT (why this is not just a flush call) ─
// enqueue() runs INSIDE the caller's transaction — that is its contract (see
// its header: a rolled-back assignment must not leave a queued email about it).
// The row it writes lives on that one connection until COMMIT returns. flush()
// reads through the POOL, a different connection, so a flush fired from inside
// enqueue() would select ZERO rows: the notification would stay queued and we
// would have shipped a fix that does nothing. Firing it just before the COMMIT
// is worse again — it can mail about work that then rolls back.
//
// So the kick is REGISTERED on the transaction's after-commit hook (lib/db.js
// withTx) and runs only once the row is really there. When `q` is the pool —
// no transaction, the write already committed — it arms directly.
//
// It arms a short COALESCING timer rather than flushing on the spot: one
// request can enqueue for six people (a notify pick, a crew nag round), and
// six flushes in the same tick would be six passes over the same table. The
// window is small enough that "immediate" is still immediate to a human.
const PENDING = new Set();
let kickTimer = null;
let lastImmediate = null;

function flushDelayMs() {
  const v = parseInt(process.env.NOTIFY_FLUSH_DELAY_MS || '', 10);
  return Number.isFinite(v) && v >= 0 && v <= 60000 ? v : 2000;
}

// Registered on the after-commit hook when there is one; armed directly when
// the caller handed us the pool and the write is therefore already visible.
function kickImmediate(q, username) {
  if (q && typeof q.afterCommit === 'function') q.afterCommit(() => armKick(username));
  else armKick(username);
}

function armKick(username) {
  if (username) PENDING.add(String(username));
  if (kickTimer) return;                          // already armed — coalesce into it
  kickTimer = setTimeout(runKick, flushDelayMs());
  if (kickTimer.unref) kickTimer.unref();         // never hold a test boot open
}

// NEVER throws and never rejects: a mail failure must not become an unhandled
// rejection in a process whose real work already succeeded. A row that cannot
// be delivered keeps its queued state and its last_error exactly as the manual
// flush would leave it, and the safety net below meets it again.
async function runKick() {
  kickTimer = null;
  const who = [...PENDING];
  PENDING.clear();
  for (const username of who) {
    try {
      await flush({ digest: false, username, trigger: 'kick' });
    } catch (e) {
      console.error('[notify] immediate kick:', e.message);
    }
  }
}

// ── THE SAFETY NET ──────────────────────────────────────────────────────────
// A self-rearming setTimeout chain — lib/backup.js / lib/digest.js doctrine
// verbatim: no cron, no new dependency, always re-arms, unref()'d, and gated at
// FIRE TIME so turning it off is an env change and not a redeploy. It exists
// because the kick is in-process state: a crash, a redeploy mid-request, or a
// row written by something that never went through enqueue() (a backfill, a
// hand-written INSERT) leaves immediate rows that no hook is holding. Cheap
// no-op when the queue is empty — one COUNT-shaped SELECT every few minutes.
const FLUSH_MINUTES_DEFAULT = 5;
function flushMinutes() {
  const v = parseInt(process.env.NOTIFY_FLUSH_MINUTES || '', 10);
  return Number.isFinite(v) && v >= 1 && v <= 1440 ? v : FLUSH_MINUTES_DEFAULT;
}
const flushEnabledByEnv = () => String(process.env.NOTIFY_FLUSH_ENABLED || '') !== '0';

// What the timer does when it fires — exported so a suite proves the DRAIN by
// running it, never by waiting five minutes for it.
async function runSafetyNetFlush() {
  return flush({ digest: false, trigger: 'safety-net' });
}

let netTimer = null;
let netArmedFor = null;
function armImmediateFlushTimer() {
  const arm = () => {
    const at = new Date(Date.now() + flushMinutes() * 60 * 1000);
    netArmedFor = at;
    netTimer = setTimeout(async () => {
      try {
        if (!flushEnabledByEnv()) {
          // quiet on purpose: this fires every few minutes, and a disabled
          // net that shouted would drown the log it shares with everything else
        } else if (!process.env.DATABASE_URL) {
          console.log('[notify] safety-net flush skipped — DATABASE_URL not set');
        } else {
          const r = await runSafetyNetFlush();
          if (r.considered) {
            console.log(`[notify] safety-net flush: considered:${r.considered} sent:${r.sent} ` +
                        `skipped:${r.skipped} queued:${r.queued} failed:${r.failed} driver:${r.driver}`);
          }
        }
      } catch (e) {
        console.error('[notify] safety-net flush:', e.message);
      }
      arm();                                              // re-arm REGARDLESS
    }, at.getTime() - Date.now());
    if (netTimer.unref) netTimer.unref();
    return at;
  };
  return arm();
}
function immediateFlushArmedFor() { return netArmedFor; }
function lastImmediateFlush() { return lastImmediate; }

// ── the health block (/api/health "notifications") ──────────────────────────
// Booleans, counts and timestamps — never an address and never a credential.
// `configuredMeans` keeps the house habit of saying what a green word is
// actually claiming: this block reads env vars and one COUNT, it has never
// opened a socket to Graph, and lastImmediateFlush is the only measurement on
// it. A stuck queue is visible here without a login to the admin outbox.
async function healthBlock() {
  const out = {
    driver: mail.driverName(),
    configured: mail.mailConfigured(),
    configuredMeans: 'the selected mail driver has the env vars it needs in this process. ' +
      'It is NOT a send test — lastImmediateFlush is the measurement, and an unconfigured ' +
      'driver leaves rows queued rather than discarding them.',
    immediateOnAction: true,
    immediateOnActionMeans: 'an immediate-mode row is flushed by a kick registered on the ' +
      'after-commit hook of the transaction that enqueued it (lib/db.js withTx), coalesced ' +
      `${flushDelayMs()}ms. No sweep, no admin, no timer is needed for the normal path.`,
    coalesceMs: flushDelayMs(),
    safetyNet: {
      enabled: flushEnabledByEnv(),
      everyMinutes: flushMinutes(),
      envVar: 'NOTIFY_FLUSH_MINUTES',
      nextRunAt: flushEnabledByEnv() && netArmedFor ? netArmedFor.toISOString() : null
    },
    queuedImmediate: null,
    lastImmediateFlush: lastImmediate
  };
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notification_outbox
        WHERE status='queued' AND mode='immediate'`);
    out.queuedImmediate = r.rows[0].n;
  } catch (e) {
    // health must answer even when the table cannot — say why, never 500
    out.error = e.message;
  }
  return out;
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
  flush, flushOne, listFor, emailFor,
  // the automatic half + what reports on it
  armImmediateFlushTimer, runSafetyNetFlush, immediateFlushArmedFor,
  lastImmediateFlush, healthBlock,
  // pure seams, exported for the suites
  flushMinutes, flushDelayMs
};
