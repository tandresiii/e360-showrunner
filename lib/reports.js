// ════════════════════════════════════════════════════════════════════════════
// lib/reports.js — F2. TECH SHOW REPORTS: the obligation, and the nagging
// ────────────────────────────────────────────────────────────────────────────
// TEAM_FEEDBACK, Tom 2026-08-27: "Every tech on a show's crew must file a
// post-show report. Required, not optional — auto-created as a task for each
// crew member when the show ends/strikes; nags in My Tasks + bell until
// submitted; the show owner sees who still owes theirs."
//
// WHO OWES ONE. Every row in `crew_assignments` that carries a `username`. A
// local hire recorded by name only has no login, so there is nobody to ask and
// no row is created — the show owner sees the crew list and the report list
// side by side and can tell the difference.
//
// WHEN. Either the strike date has passed (the boot / admin sweep notices), or
// a pm marks the show struck by hand (POST /api/shows/:id/struck). The two
// paths call the SAME function, so a hand-marked strike and a date-triggered
// one produce identical rows.
//
// THE NAG. One anchored note on the show, mentioning the tech — which is the
// bell machinery this app already has — plus an outbox row of kind
// 'report_nag'. Renagging updates the counter and writes a fresh note; it never
// duplicates the REPORT row, because (show_id, username) is unique.
//
// SIGN-OFF IS NOT REQUIRED. A report is complete at 'filed'. 'reviewed' is
// optional bookkeeping a pm/admin may add. A tech can always read their own and
// can never read anyone else's — see canViewAllReports / canReviewReports.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool } = require('./db');
const { logActivity } = require('./activity');
const { roleRank, ROLE_RANK, sameUser, todayISO, addDays } = require('./enums');
const { recordMentions, markRead } = require('./mentions');
const notify = require('./notify');

// ── GATES ───────────────────────────────────────────────────────────────────
// "only admins/PMs may VIEW-all / mark-reviewed; techs can always see their
// own" (Tom, 2026-08-27). pm is the floor, and manager/admin clear it on rank.
// ONE expression each, so the list gate and the review gate cannot drift.
function canViewAllReports(session) {
  return !!session && roleRank(session.role) >= ROLE_RANK.pm;
}
function canReviewReports(session) {
  return canViewAllReports(session);
}
// A person may always read, write and re-write their OWN report.
function ownsReport(session, report) {
  return !!session && !!report && sameUser(report.username, session.username);
}

// ── how long a tech has ─────────────────────────────────────────────────────
const REPORT_DUE_DAYS = parseInt(process.env.TECH_REPORT_DUE_DAYS || '3', 10);

// ── CREATE THE OBLIGATIONS ──────────────────────────────────────────────────
// Idempotent: ON CONFLICT DO NOTHING on (show_id, username), so a second sweep
// over the same show creates nothing and files nothing twice.
async function ensureTechReports(c, show, { actor = 'system', nag = true } = {}) {
  const crew = await c.query(
    `SELECT id, username, role_on_site FROM crew_assignments
      WHERE show_id=$1 AND username IS NOT NULL AND username <> ''`, [show.id]);
  const due = addDays(todayISO(), REPORT_DUE_DAYS);
  const created = [];
  for (const m of crew.rows) {
    const r = await c.query(
      `INSERT INTO tech_reports (show_id, project_id, username, crew_assignment_id,
         role_on_site, status, due_date, requested_at)
       VALUES ($1,$2,$3,$4,$5,'owed',$6,NOW())
       ON CONFLICT (show_id, username) DO NOTHING
       RETURNING *`,
      [show.id, show.project_id, m.username, m.id, m.role_on_site || '', due]);
    if (r.rows.length) created.push(r.rows[0]);
  }
  if (created.length) {
    await logActivity(c, {
      projectId: show.project_id, showId: show.id, actor, action: 'reports.required',
      detail: `${created.length} tech show report${created.length === 1 ? '' : 's'} owed · due ${due}`,
      accent: true
    });
  }
  if (nag) for (const rep of created) await nagOne(c, show, rep, { actor });
  return created;
}

// ── THE NAG ─────────────────────────────────────────────────────────────────
// Writes the bell item directly (an anchored note + its mention row) rather
// than going through routes/notes.js createNote(), for two reasons: the author
// is the SYSTEM, not a person, and the outbox row must carry kind 'report_nag'
// rather than 'mention' so the recipient's preference for nags is the one that
// applies.
async function nagOne(c, show, report, { actor = 'system' } = {}) {
  const label = show.name || show.venue || ('show ' + show.id);
  const text = `@${report.username} your show report for ${label} is required — ` +
    `write it in the app or upload a doc` + (report.due_date ? ` (due ${report.due_date})` : '');
  const ins = await c.query(
    `INSERT INTO notes (anchor_type, anchor_id, project_id, show_id, author, body, mentions)
     VALUES ('show',$1,$2,$1,'system',$3,$4) RETURNING id`,
    [show.id, show.project_id, text, [report.username]]);
  await recordMentions(c, ins.rows[0].id, [report.username]);
  await notify.enqueue(c, {
    username: report.username, kind: 'report_nag', actor: 'system',
    subject: `Show report required — ${label}`,
    body: `Your post-show report for ${label} has not been filed yet.` +
          (report.due_date ? ` It was due ${report.due_date}.` : '') +
          ' Write it in Showrunner or upload the document you already have.',
    noteId: ins.rows[0].id,
    projectId: show.project_id, showId: show.id,
    link: '/#show/' + show.id
  });
  await c.query(
    `UPDATE tech_reports SET last_nagged_at=NOW(), nag_count=nag_count+1, updated_at=NOW()
      WHERE id=$1`, [report.id]);
  return ins.rows[0].id;
}

// Re-nag everyone still owing on a show (the sweep's job). Never touches a
// report that is already filed.
async function nagOwed(c, show, { actor = 'system', minHours = 24 } = {}) {
  const r = await c.query(
    `SELECT * FROM tech_reports
      WHERE show_id=$1 AND status='owed'
        AND (last_nagged_at IS NULL OR last_nagged_at < NOW() - ($2 || ' hours')::interval)`,
    [show.id, String(minHours)]);
  for (const rep of r.rows) await nagOne(c, show, rep, { actor });
  return r.rows.length;
}

// ── READS ───────────────────────────────────────────────────────────────────
async function reportsForShow(showId, q = pool) {
  const r = await q.query(
    `SELECT t.*, u.name AS user_name, u.initials AS user_initials, u.role AS user_role
       FROM tech_reports t LEFT JOIN users u ON LOWER(u.username)=LOWER(t.username)
      WHERE t.show_id=$1 ORDER BY t.status DESC, LOWER(t.username) ASC`, [showId]);
  return r.rows;
}
async function reportFor(showId, username, q = pool) {
  const r = await q.query(
    'SELECT * FROM tech_reports WHERE show_id=$1 AND LOWER(username)=LOWER($2)',
    [showId, username]);
  return r.rows[0] || null;
}
// "what do I still owe" — the tech's My Tasks nag, across every show.
async function owedFor(username, q = pool, { includeFiled = false } = {}) {
  const r = await q.query(
    `SELECT t.*, s.name AS show_name, s.venue AS show_venue, s.event_date, s.strike_date,
            s.project_id AS show_project_id
       FROM tech_reports t JOIN shows s ON s.id = t.show_id
      WHERE LOWER(t.username)=LOWER($1) ${includeFiled ? '' : `AND t.status='owed'`}
      ORDER BY t.due_date ASC NULLS LAST, t.id ASC`, [username]);
  return r.rows;
}
// The "waiting on" line a show owner reads: who is still out.
async function owedSummary(showId, q = pool) {
  const rows = await reportsForShow(showId, q);
  const owed = rows.filter((r) => r.status === 'owed');
  return {
    total: rows.length,
    filed: rows.length - owed.length,
    owed: owed.length,
    waiting_on: owed.map((r) => r.username),
    complete: rows.length > 0 && owed.length === 0
  };
}

module.exports = {
  canViewAllReports, canReviewReports, ownsReport,
  ensureTechReports, nagOne, nagOwed,
  reportsForShow, reportFor, owedFor, owedSummary,
  REPORT_DUE_DAYS
};
