// ════════════════════════════════════════════════════════════════════════════
// routes/reports.js — F2. TECH SHOW REPORTS, the human surface
// ────────────────────────────────────────────────────────────────────────────
// THE HUMAN SURFACE ONLY, and deliberately so — the same argument
// routes/deliverables.js makes for the recap. A show report is one person's
// unvarnished account of what went wrong on site; an agent has no business
// writing one in somebody's name, and nothing here is mountable under
// /api/agent/* because this module exports one express.Router() and nothing
// else. requireAuth (router level) 403s an x-agent-key outright.
//
// ── THE TWO GATES, and what they are NOT ────────────────────────────────────
//   VIEW-ALL   pm+ (lib/reports.js canViewAllReports). A tech sees their own
//              row and nobody else's — not the bodies, not the names of who
//              else still owes. Report prose is candid by design and is not
//              team-wide reading.
//   REVIEW     pm+ (canReviewReports). "Techs CAN write/submit their own
//              report; they can NEVER approve/sign off" (Tom, 8/27).
//
//   NOT A GATE: filing. A report is COMPLETE at 'filed'. Review is optional
//   bookkeeping, and closeout counts filed rows, not reviewed ones — because
//   requiring a signature would let an inattentive pm block a tech's obligation
//   from ever clearing, which is the opposite of the adoption lever this is
//   meant to be.
//
// ── WHO MAY WRITE ONE ───────────────────────────────────────────────────────
// Only the person it belongs to. A pm cannot write, edit or overwrite somebody
// else's report at all — a report attributed to a person who did not write it
// is worse than a missing one. A pm's levers are: nag, review, and read.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');

const { pool, withTx, loadShow, loadProject, loadRow } = require('../lib/db');
const { asyncH, badRequest, forbidden, notFound, conflict, idParam, limitOf } = require('../lib/http');
const { requireAuth, canEditProject } = require('../lib/auth');
const { pick, has, dbToTechReport, dbToFile } = require('../lib/mappers');
const { TECH_REPORT_STATUSES, sameUser, todayISO } = require('../lib/enums');
const { logActivity } = require('../lib/activity');
const { storage } = require('../lib/storage');
const reports = require('../lib/reports');
const lifecycle = require('../lib/lifecycle');

const router = express.Router();
router.use(requireAuth);

const MAX_REPORT = 20000;

// A caller may READ a report when it is theirs, or when they may view all.
function assertCanRead(session, report) {
  if (reports.canViewAllReports(session)) return;
  if (reports.ownsReport(session, report)) return;
  throw forbidden('a show report is readable by the tech who wrote it, and by pms and admins');
}

// ════════════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/tech-reports — the show owner's "waiting on" list.
//   pm+   every row, bodies included, plus the names still out
//   else  ONLY the caller's own row, and a headcount with NO names
router.get('/shows/:id/tech-reports', asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('show ' + showId + ' not found');

  const all = await reports.reportsForShow(showId);
  const summary = await reports.owedSummary(showId);
  const viewAll = reports.canViewAllReports(req.session);

  const rows = viewAll
    ? all
    : all.filter((r) => sameUser(r.username, req.session.username));

  res.json({
    show_id: showId,
    can_view_all: viewAll,
    can_review: reports.canReviewReports(req.session),
    reports: rows.map((r) => dbToTechReport(r)),
    summary: viewAll ? summary : {
      total: summary.total, filed: summary.filed, owed: summary.owed,
      complete: summary.complete
      // waiting_on is withheld: it is a list of colleagues who are late, and
      // that is a management view, not a team-wide one.
    }
  });
}));

router.get('/tech-reports/:id', asyncH(async (req, res) => {
  const rep = await loadRow('tech_reports', idParam(req));
  if (!rep) throw notFound('report not found');
  assertCanRead(req.session, rep);
  const show = await loadShow(rep.show_id);
  res.json({
    ...dbToTechReport(rep),
    show: show ? { id: show.id, name: show.name, venue: show.venue,
                   project_id: show.project_id, event_date: show.event_date,
                   strike_date: show.strike_date } : null
  });
}));

// GET /api/me/reports — the tech's own nag list, across every show. This is
// what My Tasks renders beside the open steps.
router.get('/me/reports', asyncH(async (req, res) => {
  const includeFiled = String(pick(req.query, 'all') || '') === '1';
  const rows = await reports.owedFor(req.session.username, pool, { includeFiled });
  res.json(rows.slice(0, limitOf(req, 100, 500)).map((row) => ({
    ...dbToTechReport(row),
    show: { id: row.show_id, name: row.show_name, venue: row.show_venue,
            project_id: row.show_project_id, event_date: row.event_date,
            strike_date: row.strike_date }
  })));
}));

// ════════════════════════════════════════════════════════════════════════════
// FILE ONE — the tech writes it, or attaches the doc they already have
// ════════════════════════════════════════════════════════════════════════════
// Two forms, one obligation:
//   { body: "…" }      written in-app. The text is stored on the row AND
//                      lands in the event folder as a `files` row of kind
//                      'report', so it shows up where every other document on
//                      the show does. Bytes go through lib/storage like
//                      everything else — the DB holds the path, not the file.
//   { file_id: 42 }    a doc uploaded through the normal files route. It must
//                      already belong to this show; a report cannot smuggle in
//                      a file from somewhere else.
// Both may be sent together (a written summary plus the PDF).
async function fileReport(req, res, rep, show) {
  const b = req.body || {};
  const body = has(b, 'body') ? String(pick(b, 'body') || '').trim() : null;
  const fileId = has(b, 'file_id') ? (parseInt(pick(b, 'file_id'), 10) || null) : undefined;

  if (body != null && body.length > MAX_REPORT) {
    throw badRequest(`a show report is capped at ${MAX_REPORT} characters`);
  }
  const nextBody = body != null ? body : (rep.body || '');
  const nextFile = fileId !== undefined ? fileId : (rep.file_id || null);
  if (!nextBody && !nextFile) {
    throw badRequest('write the report or attach the document — an empty report is not filed');
  }
  if (nextFile) {
    const f = await loadRow('files', nextFile);
    if (!f || f.show_id !== show.id) {
      throw badRequest('that file is not on this show');
    }
  }

  const out = await withTx(async (c) => {
    let docId = nextFile;
    // The written form ALSO becomes a real document in the folder. One file per
    // report, revised in place — a tech who fixes a typo does not leave two.
    //
    // ── THE MIRROR IS BEST-EFFORT, AND THE REPORT IS NOT ─────────────────────
    // `tech_reports.body` is the record. The .txt in the event folder is a
    // convenience so the report reads like every other document. When there is
    // no byte store configured, storage.put() answers 501 — and letting that
    // roll the transaction back would mean a tech CANNOT FILE AT ALL, their
    // obligation stays owed forever, and the show's closeout can never
    // complete. An unwired NAS must not be able to hold a show open.
    //
    // So the mirror is attempted and its failure is recorded, never raised. The
    // file row is written ONLY if the bytes really landed: a `files` row whose
    // nas_path points at nothing is the "the metadata row outlived its bytes"
    // 404 that lib/storage exists to make impossible.
    let mirrorNote = '';
    if (body != null && body) {
      const project = await loadProject(show.project_id, c);
      const { buildNasPath } = require('./files');
      const name = `Show report — ${req.session.username}`;
      const nasPath = buildNasPath(project || { id: show.project_id, slug: '', name: 'project' },
        show, { kind: 'report', name, ext: 'txt' });
      const bytes = Buffer.from(body, 'utf8');
      let stored = true;
      try {
        await storage.put(nasPath, bytes);
        require('../lib/filecache').invalidatePath(nasPath);   // same derived path each time
      } catch (e) {
        stored = false;
        mirrorNote = e && e.status === 501
          ? ' · no copy in the folder (storage is not configured on this server)'
          : ' · no copy in the folder (the store could not be written)';
        console.warn(`[tech-report ${rep.id}] folder copy skipped: ${e.message}`);
      }
      if (stored) {
        const existing = rep.file_id ? await loadRow('files', rep.file_id, c) : null;
        if (existing && existing.kind === 'report') {
          await c.query(
            `UPDATE files SET size=$2, nas_path=$3, created_at=created_at WHERE id=$1`,
            [existing.id, bytes.length, nasPath]);
          docId = existing.id;
        } else {
          const ins = await c.query(
            `INSERT INTO files (project_id, show_id, name, ext, kind, artifact, ver, meta,
               nas_path, size, uploaded_by, status)
             VALUES (NULL,$1,$2,'txt','report','document','v1',$3,$4,$5,$6,'filed') RETURNING id`,
            [show.id, name, 'tech show report', nasPath, bytes.length, req.session.username]);
          docId = ins.rows[0].id;
        }
      }
    }
    const r = await c.query(
      `UPDATE tech_reports SET body=$2, file_id=$3, status='filed', filed_at=NOW(),
         updated_at=NOW() WHERE id=$1 RETURNING *`,
      [rep.id, nextBody, docId || null]);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'report.filed',
      detail: `${req.session.username} filed their show report` +
              (docId ? ' · document in the folder' : mirrorNote),
      accent: true });
    // Filing may be the last thing a closeout was waiting on.
    const closeout = await lifecycle.syncCloseout(c, show.id, { actor: req.actor });
    const summary = await reports.owedSummary(show.id, c);
    return { row: r.rows[0], docId, closeout, summary };
  });

  const doc = out.docId ? await loadRow('files', out.docId) : null;
  res.json({
    ok: true,
    report: dbToTechReport(out.row),
    file: doc ? dbToFile(doc) : null,
    summary: out.summary,
    closeout: out.closeout
  });
}

// POST /api/shows/:id/tech-report — file MINE on this show.
router.post('/shows/:id/tech-report', asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('show ' + showId + ' not found');

  let rep = await reports.reportFor(showId, req.session.username);
  if (!rep) {
    // A crew member may file BEFORE the sweep gets to the show — being early is
    // not an error. Anyone NOT on the crew has nothing to report and is told so
    // rather than silently creating an obligation that was never asked for.
    const crew = await pool.query(
      `SELECT id, role_on_site FROM crew_assignments
        WHERE show_id=$1 AND LOWER(username)=LOWER($2)`, [showId, req.session.username]);
    if (!crew.rows.length) {
      throw forbidden('you are not on this show’s crew, so no show report is owed from you');
    }
    const ins = await pool.query(
      `INSERT INTO tech_reports (show_id, project_id, username, crew_assignment_id, role_on_site,
         status, due_date, requested_at)
       VALUES ($1,$2,$3,$4,$5,'owed',$6,NOW())
       ON CONFLICT (show_id, username) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [showId, show.project_id, req.session.username, crew.rows[0].id,
       crew.rows[0].role_on_site || '', todayISO()]);
    rep = ins.rows[0];
  }
  if (!reports.ownsReport(req.session, rep)) {
    throw forbidden('a show report is written by the person it belongs to');
  }
  if (rep.status === 'reviewed') {
    throw conflict('this report has been reviewed — ask a pm to reopen it before rewriting');
  }
  return fileReport(req, res, rep, show);
}));

// PUT /api/tech-reports/:id — revise MINE. Same rule: only the author, and
// never after review.
router.put('/tech-reports/:id', asyncH(async (req, res) => {
  const rep = await loadRow('tech_reports', idParam(req));
  if (!rep) throw notFound('report not found');
  if (!reports.ownsReport(req.session, rep)) {
    throw forbidden('a show report is written by the person it belongs to — ' +
      'a pm may read it, nag for it and review it, but never write it');
  }
  if (rep.status === 'reviewed') {
    throw conflict('this report has been reviewed — ask a pm to reopen it before rewriting');
  }
  const show = await loadShow(rep.show_id);
  if (!show) throw notFound('show not found');
  return fileReport(req, res, rep, show);
}));

// ════════════════════════════════════════════════════════════════════════════
// REVIEW / REOPEN / NAG — the pm's three levers
// ════════════════════════════════════════════════════════════════════════════
router.post('/tech-reports/:id/review', asyncH(async (req, res) => {
  const rep = await loadRow('tech_reports', idParam(req));
  if (!rep) throw notFound('report not found');
  if (!reports.canReviewReports(req.session)) {
    throw forbidden('marking a show report reviewed requires pm, manager or admin — ' +
      'techs file their own reports but never sign one off');
  }
  if (rep.status === 'owed') throw conflict('nothing to review — this report has not been filed yet');
  const show = await loadShow(rep.show_id);
  const row = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE tech_reports SET status='reviewed', reviewed_by=$2, reviewed_at=NOW(),
         updated_at=NOW() WHERE id=$1 RETURNING *`, [rep.id, req.session.username]);
    await logActivity(c, {
      projectId: show ? show.project_id : null, showId: rep.show_id, actor: req.actor,
      action: 'report.reviewed', detail: `${rep.username}’s show report reviewed` });
    return r.rows[0];
  });
  res.json(dbToTechReport(row));
}));

router.post('/tech-reports/:id/reopen', asyncH(async (req, res) => {
  const rep = await loadRow('tech_reports', idParam(req));
  if (!rep) throw notFound('report not found');
  if (!reports.canReviewReports(req.session)) {
    throw forbidden('reopening a show report requires pm, manager or admin');
  }
  if (rep.status !== 'reviewed') throw conflict('this report is not marked reviewed');
  const row = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE tech_reports SET status='filed', reviewed_by=NULL, reviewed_at=NULL,
         updated_at=NOW() WHERE id=$1 RETURNING *`, [rep.id]);
    await logActivity(c, { projectId: rep.project_id, showId: rep.show_id, actor: req.actor,
      action: 'report.reopened', detail: `${rep.username}’s show report reopened for edits` });
    return r.rows[0];
  });
  res.json(dbToTechReport(row));
}));

// Re-nag one person, or everyone still out on the show.
router.post('/shows/:id/tech-reports/nag', asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('show ' + showId + ' not found');
  const project = await loadProject(show.project_id);
  if (!reports.canReviewReports(req.session) || !canEditProject(req.session, project)) {
    throw forbidden('nagging for show reports is the pm’s job on their own folder');
  }
  const who = pick(req.body, 'username');
  const out = await withTx(async (c) => {
    if (who) {
      const rep = await reports.reportFor(showId, who, c);
      if (!rep) throw notFound(`${who} has no show report on this show`);
      if (rep.status !== 'owed') throw conflict(`${who} has already filed`);
      await reports.nagOne(c, show, rep, { actor: req.actor });
      return 1;
    }
    // minHours 0 — a person asking for this now means now.
    return reports.nagOwed(c, show, { actor: req.actor, minHours: 0 });
  });
  res.json({ ok: true, nagged: out, summary: await reports.owedSummary(showId) });
}));

module.exports = router;
