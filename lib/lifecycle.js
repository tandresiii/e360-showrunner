// ════════════════════════════════════════════════════════════════════════════
// lib/lifecycle.js — F5 confirm · F6 closeout, archiving, and the sweep
// ────────────────────────────────────────────────────────────────────────────
// TEAM_FEEDBACK, Tom 2026-08-27 (CONFIRMED spec):
//   "quoted → confirmed → in progress → delivered → closed → archived. Confirm
//    = explicit action, admin/PM only, means the client committed (signed/PO'd)
//    — datestamped + logged. Auto-archive 60 days after closeout complete
//    (closeout = recap sent + all tech show reports filed + financials
//    reconciled — machine-checkable); manual archive/unarchive for admins."
//
// ── WHAT IS MACHINE-CHECKED ─────────────────────────────────────────────────
// closeoutStatus(showId) answers three questions with SQL, never with a flag
// somebody remembered to tick:
//   1. recap    — a deliverable of kind 'recap' on this show with status 'sent'
//   2. reports  — every tech_reports row for the show is out of 'owed'
//                 (a show with no crew owes nothing and passes trivially)
//   3. finance  — no OPEN money exception ATTRIBUTABLE TO THIS SHOW
// The third is deliberately the SHOW-SCOPED subset of routes/finance.js's
// financeExceptions(): that scan also reports show-less rows (a PO with no
// show, a job still on a TEMP number), and a folder-wide accounting problem
// must not hold one city's show hostage. Same three predicates, one show.
//
// ── THE CLOCK ───────────────────────────────────────────────────────────────
// `closeout_complete_at` is stamped the FIRST time all three hold. The 60-day
// archive clock runs from that stamp, not from the strike date, so a show whose
// paperwork lands late gets its full sixty days of being easy to find.
//
// ── NO CRON. ────────────────────────────────────────────────────────────────
// Honest TODO: this app has no scheduler. sweep() runs (a) once on boot and
// (b) on POST /api/admin/sweep. That is enough for a Railway box that redeploys
// regularly and for an admin who wants it now, and it is NOT a daily job. A
// real one needs Railway cron or the per-user agents of ARCHITECTURE.md; until
// one exists this app will not pretend it has one.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool, withTx } = require('./db');
const { logActivity } = require('./activity');
const { roleRank, ROLE_RANK, sameUser, canonicalStage, stageAtLeast, isConfirmed,
        todayISO, addDays } = require('./enums');
const reports = require('./reports');

const ARCHIVE_AFTER_DAYS = parseInt(process.env.ARCHIVE_AFTER_DAYS || '60', 10);
// How far back the sweep will reach to STRIKE a show it has never seen.
//
// This exists because the sweep runs on boot, and the first boot after this
// release meets a database full of shows that already happened. Without a bound
// it would strike all of them at once and ask every crew member for a report on
// a job from last year — technically correct, operationally a stampede, and the
// fastest way to teach a team to ignore the nag. Anything older than this window
// is HISTORY: a pm can still strike it by hand (POST /shows/:id/struck) if a
// report really is wanted. A show already struck is unaffected, and closeout and
// archiving have no lookback at all — they are pure re-checks of the record.
const SWEEP_LOOKBACK_DAYS = parseInt(process.env.SWEEP_LOOKBACK_DAYS || '45', 10);

// ── F5. THE CONFIRM GATE ────────────────────────────────────────────────────
// "admin/PM only" — and, for a pm, only on a show they are responsible for.
// manager+ clears it on rank (the same cover pattern canApproveRecap uses); a
// pm must own the SHOW or its FOLDER. A tech or viewer never clears it.
//
// This is a SEPARATE decision from canEditProject: confirming records that a
// client committed money, which is not the same act as editing a venue string,
// and the two should be able to diverge later without surprising anyone.
function canConfirm(session, show, project) {
  if (!session) return false;
  if (roleRank(session.role) >= ROLE_RANK.manager) return true;
  if (roleRank(session.role) < ROLE_RANK.pm) return false;
  return !!((show && sameUser(show.owner, session.username)) ||
            (project && sameUser(project.owner, session.username)));
}
// Archiving by hand is an ADMIN act (Tom: "manual archive/unarchive for
// admins"). The automatic path has no session at all.
function canArchive(session) {
  return !!session && roleRank(session.role) >= ROLE_RANK.admin;
}

// ── F6. the show-scoped money check ─────────────────────────────────────────
// The three exception families that can be pinned to ONE show.
async function showFinanceExceptions(showId, q = pool) {
  const out = [];
  const bk = await q.query(
    `SELECT id, category, vendor FROM bookings
      WHERE show_id=$1 AND file_id IS NULL AND status IN ('done','in_progress')
        AND (amount IS NOT NULL OR booked_date IS NOT NULL)`, [showId]);
  for (const b of bk.rows) out.push({ kind: 'booking', id: b.id, label: b.category || b.vendor, missing: 'confirmation' });

  const ex = await q.query(
    `SELECT id, vendor FROM expenses
      WHERE show_id=$1 AND file_id IS NULL AND status <> 'proposed' AND po_id IS NULL`, [showId]);
  for (const e of ex.rows) out.push({ kind: 'expense', id: e.id, label: e.vendor, missing: 'receipt' });

  // A PO counts against this show when one of its LINES is allocated here.
  const po = await q.query(
    `SELECT DISTINCT p.id, p.po_number, p.vendor FROM purchase_orders p
       JOIN po_lines l ON l.po_id = p.id
      WHERE l.show_id=$1 AND p.invoice_file_id IS NULL
        AND p.status IN ('ordered','shipped','received')`, [showId]);
  for (const p of po.rows) out.push({ kind: 'po', id: p.id, label: p.po_number + ' · ' + p.vendor, missing: 'invoice' });
  return out;
}

// ── F6. THE CLOSEOUT CHECK ──────────────────────────────────────────────────
async function closeoutStatus(showId, q = pool) {
  const rec = await q.query(
    `SELECT status, sent_at FROM deliverables
      WHERE show_id=$1 AND kind='recap' ORDER BY id DESC LIMIT 1`, [showId]);
  const recap = rec.rows[0] || null;
  const recapSent = !!(recap && recap.status === 'sent');

  const rep = await reports.owedSummary(showId, q);
  const fin = await showFinanceExceptions(showId, q);

  const show = (await q.query(
    'SELECT id, closeout_complete_at, archived_at, strike_date, event_date FROM shows WHERE id=$1',
    [showId])).rows[0] || null;

  return {
    show_id: showId,
    recap_sent: recapSent,
    recap_status: recap ? recap.status : null,
    // A show with NO crew assignments owes no reports and passes trivially —
    // `complete` is "nobody is still out", not "somebody filed something".
    reports_total: rep.total, reports_filed: rep.filed, reports_owed: rep.owed,
    reports_complete: rep.owed === 0,
    waiting_on: rep.waiting_on,
    finance_exceptions: fin.length,
    finance_clear: fin.length === 0,
    exceptions: fin,
    complete: recapSent && rep.owed === 0 && fin.length === 0,
    closeout_complete_at: show ? show.closeout_complete_at : null,
    archived_at: show ? show.archived_at : null,
    archive_after_days: ARCHIVE_AFTER_DAYS
  };
}

// Stamp (or clear) the closeout marker. Idempotent, and it CLEARS again if the
// state regresses — reopening a recap or adding a late expense un-completes a
// closeout, which is exactly right: the 60-day clock should not keep running
// against paperwork that came undone.
async function syncCloseout(c, showId, { actor = 'system' } = {}) {
  const st = await closeoutStatus(showId, c);
  const cur = (await c.query('SELECT closeout_complete_at FROM shows WHERE id=$1', [showId])).rows[0];
  if (!cur) return st;
  if (st.complete && !cur.closeout_complete_at) {
    await c.query('UPDATE shows SET closeout_complete_at=NOW(), updated_at=NOW() WHERE id=$1', [showId]);
    const s = (await c.query('SELECT project_id, name FROM shows WHERE id=$1', [showId])).rows[0];
    await logActivity(c, {
      projectId: s ? s.project_id : null, showId, actor, action: 'closeout.complete',
      detail: `recap sent · ${st.reports_filed}/${st.reports_total} reports filed · finance clear ` +
              `— auto-archives in ${ARCHIVE_AFTER_DAYS} days`,
      accent: true
    });
    st.closeout_complete_at = new Date().toISOString();
  } else if (!st.complete && cur.closeout_complete_at) {
    await c.query('UPDATE shows SET closeout_complete_at=NULL, updated_at=NOW() WHERE id=$1', [showId]);
    st.closeout_complete_at = null;
  }
  return st;
}

// ── ARCHIVE / UNARCHIVE ─────────────────────────────────────────────────────
async function archiveShow(c, show, { actor = 'system', reason = 'manual' } = {}) {
  if (show.archived_at) return { ok: true, already: true };
  await c.query(
    `UPDATE shows SET archived_at=NOW(), archived_by=$2,
       stage = CASE WHEN stage='archived' THEN stage ELSE 'archived' END, updated_at=NOW()
     WHERE id=$1`, [show.id, actor]);
  await logActivity(c, {
    projectId: show.project_id, showId: show.id, actor, action: 'show.archive',
    detail: reason === 'auto'
      ? `auto-archived — closeout completed more than ${ARCHIVE_AFTER_DAYS} days ago`
      : 'archived by hand',
    accent: true
  });
  await maybeArchiveProject(c, show.project_id, { actor });
  return { ok: true, already: false };
}
// Unarchive restores the show to 'closed' when its stage was pushed to
// 'archived' by the archive itself. A show archived from some other stage keeps
// that stage — we never invent history on the way back out.
async function unarchiveShow(c, show, { actor = 'system' } = {}) {
  if (!show.archived_at) return { ok: true, already: true };
  await c.query(
    `UPDATE shows SET archived_at=NULL, archived_by=NULL,
       stage = CASE WHEN stage='archived' THEN 'closed' ELSE stage END, updated_at=NOW()
     WHERE id=$1`, [show.id]);
  // A folder cannot stay archived while one of its shows is live again.
  await c.query(
    'UPDATE projects SET archived_at=NULL, archived_by=NULL, updated_at=NOW() WHERE id=$1',
    [show.project_id]);
  await logActivity(c, {
    projectId: show.project_id, showId: show.id, actor, action: 'show.unarchive',
    detail: 'back in the working set', accent: true
  });
  return { ok: true, already: false };
}
// A FOLDER archives when every show inside it is archived. An EMPTY folder is
// never auto-archived — there is no evidence it is finished, only that it never
// started, and an admin can archive it by hand.
async function maybeArchiveProject(c, projectId, { actor = 'system' } = {}) {
  if (!projectId) return false;
  const r = await c.query(
    `SELECT COUNT(*)::int AS n, COUNT(archived_at)::int AS archived FROM shows WHERE project_id=$1`,
    [projectId]);
  const { n, archived } = r.rows[0];
  if (!n || archived < n) return false;
  const p = await c.query('SELECT archived_at FROM projects WHERE id=$1', [projectId]);
  if (!p.rows.length || p.rows[0].archived_at) return false;
  await c.query(
    'UPDATE projects SET archived_at=NOW(), archived_by=$2, updated_at=NOW() WHERE id=$1',
    [projectId, actor]);
  await logActivity(c, {
    projectId, actor, action: 'project.archive',
    detail: `every show in the folder is archived (${n})`, accent: true });
  return true;
}

// ── THE SWEEP ───────────────────────────────────────────────────────────────
// One pass, four jobs, all idempotent:
//   1. strike     — a show whose strike date has passed gets struck_at + the
//                   tech reports its crew owes.
//   2. nag        — anyone still owing gets re-nagged (at most once a day).
//   3. closeout   — every candidate show re-checks its three conditions.
//   4. archive    — a show past ARCHIVE_AFTER_DAYS since closeout is archived.
// Plus a notification flush of the IMMEDIATE queue, because a sweep that
// creates nags and leaves them queued has done half a job.
async function sweep({ actor = 'system', now = null, flush = true } = {}) {
  const today = now || todayISO();
  const out = { struck: 0, reports_created: 0, nagged: 0, closeout_complete: 0,
                archived: 0, projects_archived: 0, notifications: null, at: today };

  // 1 + 2 — strike + nag, bounded by SWEEP_LOOKBACK_DAYS (see above). A show
  // already struck stays in scope no matter how old, so its outstanding reports
  // keep being chased; only the FIRST strike is time-bounded.
  const floor = addDays(today, -SWEEP_LOOKBACK_DAYS);
  const due = await pool.query(
    `SELECT * FROM shows
      WHERE archived_at IS NULL
        AND COALESCE(NULLIF(strike_date,''), NULLIF(event_date,'')) <> ''
        AND COALESCE(NULLIF(strike_date,''), NULLIF(event_date,'')) <= $1
        AND (struck_at IS NOT NULL
             OR COALESCE(NULLIF(strike_date,''), NULLIF(event_date,'')) >= $2)`,
    [today, floor]);
  for (const show of due.rows) {
    await withTx(async (c) => {
      if (!show.struck_at) {
        await c.query('UPDATE shows SET struck_at=NOW(), struck_by=$2, updated_at=NOW() WHERE id=$1',
          [show.id, actor]);
        out.struck += 1;
      }
      const created = await reports.ensureTechReports(c, show, { actor });
      out.reports_created += created.length;
      // Only re-nag rows that were NOT just created (those were nagged once on
      // creation) — nagOwed's own 24h floor handles that.
      out.nagged += await reports.nagOwed(c, show, { actor });
    });
  }

  // 3 — closeout re-check for every non-archived show that has actually
  //     finished. A show still in the future has nothing to close out.
  const cand = await pool.query(
    `SELECT id FROM shows
      WHERE archived_at IS NULL
        AND COALESCE(NULLIF(strike_date,''), NULLIF(event_date,'')) <> ''
        AND COALESCE(NULLIF(strike_date,''), NULLIF(event_date,'')) <= $1`, [today]);
  for (const row of cand.rows) {
    const st = await withTx(async (c) => syncCloseout(c, row.id, { actor }));
    if (st.complete) out.closeout_complete += 1;
  }

  // 4 — archive
  const ripe = await pool.query(
    `SELECT * FROM shows
      WHERE archived_at IS NULL AND closeout_complete_at IS NOT NULL
        AND closeout_complete_at < NOW() - ($1 || ' days')::interval`,
    [String(ARCHIVE_AFTER_DAYS)]);
  for (const show of ripe.rows) {
    const before = await pool.query('SELECT archived_at FROM projects WHERE id=$1', [show.project_id]);
    await withTx(async (c) => archiveShow(c, show, { actor, reason: 'auto' }));
    out.archived += 1;
    const after = await pool.query('SELECT archived_at FROM projects WHERE id=$1', [show.project_id]);
    if (before.rows[0] && !before.rows[0].archived_at && after.rows[0] && after.rows[0].archived_at) {
      out.projects_archived += 1;
    }
  }

  if (flush) {
    const notify = require('./notify');
    out.notifications = await notify.flush({ digest: false, limit: 200 });
  }
  return out;
}

module.exports = {
  canConfirm, canArchive, SWEEP_LOOKBACK_DAYS,
  closeoutStatus, syncCloseout, showFinanceExceptions,
  archiveShow, unarchiveShow, maybeArchiveProject,
  sweep, ARCHIVE_AFTER_DAYS,
  canonicalStage, stageAtLeast, isConfirmed
};
