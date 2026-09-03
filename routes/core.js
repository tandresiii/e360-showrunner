// ════════════════════════════════════════════════════════════════════════════
// routes/core.js — projects (event folders), shows, steps, templates,
//                  milestones, the activity feed, push-to-scheduler
// ────────────────────────────────────────────────────────────────────────────
// Hierarchy: PROJECT (event folder) -> SHOWS -> STEPS, with JOBS (the
// commercial dimension) hanging off the project alongside the shows.
//
// Punch coverage: C (lanes come from event_types, per project type — a step's
// lane is validated against ITS project's lane set, not a fixed 6), 4 (steps.
// risk), 8 (milestones child table), 9 (RAG derived, rag_override wins),
// 10 (projects.summary/source), 11 (activity.accent), 12 (shows.cabinets),
// B (templates now carry owner_role and come from templates.json), H (the live
// push path stays 501 — that is a separate, later decision).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadProject, loadShow, loadJob, projectForRow, mintTempJobNumber,
        deleteProjectCascade, deleteShowCascade } = require('../lib/db');
const { requireAuth, requireRole, canEditProject, canUpdateStepStatus, roleRank,
        hasFinance } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, conflict, idParam, limitOf, offsetOf } = require('../lib/http');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');
const { announceShowChange, projectAudience, showAudience } = require('../lib/audience');
const { lanesForType, allLaneKeys } = require('../lib/seed');
const { resolveUsernames, recordMentions, parseMentions, notifyTargets } = require('../lib/mentions');
const {
  pick, has, dbToProject, dbToShow, deriveRag, dbToJob, dbToStep, dbToTemplate,
  dbToTemplateStep, dbToActivity, dbToMilestone, dbToUser, stripMoney
} = require('../lib/mappers');
const {
  PROJECT_TYPES, STAGES, RAGS, STEP_STATUSES, EVIDENCE_TYPES, AUTO_SOURCES,
  SCOPE_KINDS, LIFECYCLE_STAGES, ROLE_RANK, DEAL_TYPES,
  oneOf, addDays, slug, isISODate, intOrNull, num, money, sameUser,
  canonicalStage, stageLabel, isConfirmed, scopeLine, scopeOf, todayISO
} = require('../lib/enums');
// F2/F3/F5/F6 — the four post-deploy engines. Each one owns its decision; this
// module only routes to them.
const lifecycle = require('../lib/lifecycle');
const reports = require('../lib/reports');
const notify = require('../lib/notify');
const { scopeFromDocs, scopeQuestions } = require('../lib/speccheck');
// The staffing-app client. The field mapping (M1–M14) lives there, not here,
// so the dry run and the live push can never drift.
const {
  buildSchedulerPayloads, pushShowToScheduler, schedulerConfigured,
  schedulerCredentialed, fetchRoster, validateForPush, deriveBookingCategory, mapEventType,
  fetchSchedulerEvents, notConfigured: schedulerNotConfigured, PUSH_MODES
} = require('../lib/scheduler');

const router = express.Router();
router.use(requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// F3/F5/F8. THE MATERIAL SETS — classification as DATA, not as if-statements
// ────────────────────────────────────────────────────────────────────────────
// The review's sharpest process finding is that the app split notification on
// CREATE vs EDIT, which is the wrong axis: moving load-in from 08:00 to 05:00
// the night before a show is an "edit". The right axis is MATERIAL vs ROUTINE,
// and the cheapest honest way to express it is a named list of fields per
// entity. A field in the map produces a diff and addresses the audience; a
// field outside it (slug, summary, source — bookkeeping) does neither.
//
// Adding a column to one of these maps is the whole ceremony for making it
// announce itself. That is deliberate: the pre-build checklist asks "name the
// audience of every mutation", and this is where the answer gets written down.
const MATERIAL_SHOW_FIELDS = {
  name: 'name', venue: 'venue', city: 'city',
  load_in_date: 'load-in', event_date: 'event date', strike_date: 'strike',
  stage: 'stage', owner: 'owner', on_site_poc: 'on-site POC',
  cabinets: 'cabinets', rag_override: 'RAG override', default_job_id: 'job'
};
const MATERIAL_PROJECT_FIELDS = {
  name: 'name', client: 'client', stage: 'stage', owner: 'owner',
  type: 'type', description: 'description'
};
const MATERIAL_STEP_FIELDS = {
  title: 'title', lane: 'lane', owner: 'owner', due_date: 'due',
  status: 'status', risk: 'risk flag', depends_on: 'depends on'
};

// ── shared hydration ────────────────────────────────────────────────────────
// `money` is the finance-capability gate (hardening 2): a job's contract value
// is margin-equivalent, so it is stripped for a caller who may not see margin.
// It DEFAULTS TO FALSE — a caller that forgets to pass the session gets the
// redacted job, never the leaky one.
async function jobsFor(projectId, q = pool, money = false) {
  const r = await q.query(
    `SELECT j.*, COALESCE(b.total,0) AS budget_total
     FROM jobs j
     LEFT JOIN (SELECT job_id, SUM(allotted) AS total FROM budget_lines GROUP BY job_id) b
       ON b.job_id = j.id
     WHERE j.project_id=$1 ORDER BY j.id`, [projectId]);
  return r.rows.map((row) => stripMoney(dbToJob(row), money));
}
async function milestonesFor({ showId = null, projectId = null }, q = pool) {
  const r = showId
    ? await q.query('SELECT * FROM milestones WHERE show_id=$1 ORDER BY date, sort_order, id', [showId])
    : await q.query('SELECT * FROM milestones WHERE project_id=$1 ORDER BY date, sort_order, id', [projectId]);
  return r.rows.map(dbToMilestone);
}
// 9. attach the derived RAG so the mapper can resolve override > derived > stored.
//
// HARDENING 8. This is THE hydrateShow. routes/schedule.js had a second one of
// the same name that attached `project` and `type` but no derived rag, so the
// call sheet reported the STORED rag column while every other endpoint reported
// the derived one — the same show, two colours, depending on which route you
// asked. Schedule now calls this and passes its extras through `extra`.
async function hydrateShow(row, q = pool, { withSteps = false, extra: more = null } = {}) {
  if (!row) return null;
  const steps = (await q.query(
    'SELECT * FROM steps WHERE show_id=$1 ORDER BY sort_order ASC, id ASC', [row.id])).rows;
  const extra = { rag: deriveRag(steps, row) || row.rag || 'idle' };
  if (withSteps) extra.steps = steps.map(dbToStep);
  // ── scheduler push state, derived here because it needs the children ──────
  // `scheduler_stale` answers "did anything the push publishes change after the
  // last push?" — the show row itself (name, dates, venue, header times) plus
  // its steps and crew lines, all of which cross the wire. schedule_items are
  // deliberately NOT consulted: the day-by-day schedule never leaves Showrunner
  // (B.1 sends only the four header times), so an edit there cannot make the
  // staffing copy stale. Compared in SQL so the timezone semantics are
  // Postgres's own; the same-statement NOW() that stamps pushed_at and
  // updated_at together makes a fresh push read exactly not-stale.
  // Costs one query, and only on a show that has actually been pushed.
  if (row.scheduler_pushed_at) {
    const st = await q.query(
      `SELECT (s.updated_at > s.scheduler_pushed_at)
           OR EXISTS (SELECT 1 FROM steps t
                      WHERE t.show_id = s.id AND t.updated_at > s.scheduler_pushed_at)
           OR EXISTS (SELECT 1 FROM crew_assignments ca
                      WHERE ca.show_id = s.id
                        AND GREATEST(ca.created_at, ca.updated_at) > s.scheduler_pushed_at)
              AS stale
       FROM shows s WHERE s.id = $1`, [row.id]);
    extra.scheduler_stale = !!(st.rows[0] && st.rows[0].stale);
  } else {
    extra.scheduler_stale = false;
  }
  // "View in Scheduler" — the same URL shape the push response has always
  // returned. Auth-gated (every show read is), so the base URL is not leaked
  // through the public /api/config; null while the integration is unconfigured
  // and the UI says so instead of opening nothing.
  extra.scheduler_deep_link = row.scheduler_event_id && process.env.SCHEDULER_BASE_URL
    ? `${String(process.env.SCHEDULER_BASE_URL).replace(/\/+$/, '')}/?event=${row.scheduler_event_id}`
    : null;
  return dbToShow(row, more ? { ...extra, ...more } : extra);
}
async function showsFor(projectId, q = pool) {
  const r = await q.query(
    'SELECT * FROM shows WHERE project_id=$1 ORDER BY event_date ASC, id ASC', [projectId]);
  const out = [];
  // withSteps costs nothing here — hydrateShow already queries the steps for
  // deriveRag; the season dashboard rolls up from these embedded shows.
  for (const row of r.rows) out.push(await hydrateShow(row, q, { withSteps: true }));
  return out;
}
// api.js hydrateProject(): jobs + shows + the auto-collapse `single` flag.
async function hydrateProject(row, q = pool, { deep = true, session = null } = {}) {
  if (!row) return null;
  if (!deep) return dbToProject(row);
  const shows = await showsFor(row.id, q);
  return dbToProject(row, {
    jobs: await jobsFor(row.id, q, hasFinance(session)),
    milestones: await milestonesFor({ projectId: row.id }, q),
    shows,
    single: shows.length === 1,
    show_count: shows.length
  });
}

// The notification principle (Tony) now lives in lib/mentions.js so every
// route family shares one implementation — see notifyTargets there.

// ════════════════════════════════════════════════════════════════════════════
// F6. THE ARCHIVE FILTER — one predicate, three list routes
// ────────────────────────────────────────────────────────────────────────────
// Tom: "we don't want 300 in our normal area in a year… fully searchable/
// browsable via an Archive filter/view."  So:
//
//   (no param)             archived rows are EXCLUDED — the working set
//   ?archived=1            ONLY archived rows — the Archive view
//   ?include_archived=1    both — for a caller that wants the whole history
//
// It applies to the LIST routes only. GET /projects/:id and GET /shows/:id
// always resolve, archived or not, so a deep link, a bell row and a search hit
// all still open. And hydrateProject() keeps EVERY show of a folder it is
// asked for, archived included — that is what leaves season rollups unaffected.
function archiveClause(req, col = 'archived_at') {
  const only = String(pick(req.query, 'archived') || '') === '1' ||
               String(pick(req.query, 'archived') || '') === 'true';
  const both = String(pick(req.query, 'include_archived') || '') === '1' ||
               String(pick(req.query, 'include_archived') || '') === 'true';
  if (both) return '';
  return only ? ` ${col} IS NOT NULL` : ` ${col} IS NULL`;
}

// ════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ════════════════════════════════════════════════════════════════════════════
router.get('/projects', asyncH(async (req, res) => {
  const clause = archiveClause(req);
  const r = await pool.query(
    `SELECT * FROM projects${clause ? ' WHERE' + clause : ''} ORDER BY created_at DESC, id DESC`);
  const out = [];
  for (const row of r.rows) out.push(await hydrateProject(row, pool, { session: req.session }));
  res.json(out);
}));

router.get('/projects/:id', asyncH(async (req, res) => {
  const p = await loadProject(idParam(req));
  if (!p) throw notFound();
  res.json(await hydrateProject(p, pool, { session: req.session }));
}));

// api.resolveFolder() — the auto-collapse rule lives HERE so every caller agrees.
router.get('/projects/:id/folder', asyncH(async (req, res) => {
  const p = await loadProject(idParam(req));
  if (!p) throw notFound();
  const project = await hydrateProject(p, pool, { session: req.session });
  const single = project.shows.length === 1;
  let show = null;
  if (single) {
    const row = await loadShow(project.shows[0].id);
    show = await hydrateShow(row, pool, { withSteps: true });
    show.project = dbToProject(p);
    show.type = p.type;
  }
  res.json({ project, single, show });
}));

router.post('/projects', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const name = pick(b, 'name');
  if (!name) throw badRequest('name required');
  // A pm always owns what they create; manager+ may set any owner.
  const owner = (roleRank(req.session.role) >= 3 && pick(b, 'owner'))
    ? pick(b, 'owner') : req.session.username;
  const row = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO projects (name, slug, client, type, stage, owner, description, summary, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, pick(b, 'slug') || slug(name), pick(b, 'client') || '',
       oneOf(pick(b, 'type'), PROJECT_TYPES, 'led'), oneOf(pick(b, 'stage'), STAGES, 'lead'),
       owner, pick(b, 'description') || '', pick(b, 'summary') || null, pick(b, 'source') || null]
    );
    const p = ins.rows[0];
    // A one-off auto-creates its single job (HANDOFF: "One-offs auto-create
    // their single job"), unless the caller says otherwise.
    // POLISH_LIST #5: that job opens on a TEMP placeholder — nobody has a
    // QuickBooks number the moment a folder is opened, and the work starts now.
    if (pick(b, 'createJob', true) !== false) {
      await c.query(
        `INSERT INTO jobs (project_id, name, qb_job_number, qb_number_status, client,
                           deal_type, description, contract_value)
         VALUES ($1,$2,$3,'temp',$4,$5,$6,$7)`,
        [p.id, pick(b, 'jobName') || name, await mintTempJobNumber(c), pick(b, 'client') || '',
         oneOf(pick(b, 'dealType'), DEAL_TYPES, 'rental'), '', 0]);
    }
    await logActivity(c, { projectId: p.id, actor: req.actor, action: 'project.create',
      detail: name, accent: true });
    await notifyTargets(c, { body: b, anchorType: 'project', anchorId: p.id, projectId: p.id,
      showId: null, actor: req.actor, summary: `opened the folder “${name}” —` });
    return p;
  });
  res.json(await hydrateProject(row, pool, { session: req.session }));
}));

router.put('/projects/:id', asyncH(async (req, res) => {
  const p = await loadProject(idParam(req));
  if (!p) throw notFound();
  if (!canEditProject(req.session, p)) throw forbidden('Not allowed to edit this project');
  const b = req.body || {};
  const owner = (roleRank(req.session.role) >= 3 && pick(b, 'owner') != null) ? pick(b, 'owner') : p.owner;
  const r = await pool.query(
    `UPDATE projects SET name=$1, slug=$2, client=$3, type=$4, stage=$5, owner=$6,
       description=$7, summary=$8, source=$9, updated_at=NOW() WHERE id=$10 RETURNING *`,
    [pick(b, 'name', p.name), pick(b, 'slug', p.slug), pick(b, 'client', p.client),
     oneOf(pick(b, 'type'), PROJECT_TYPES, p.type), oneOf(pick(b, 'stage'), STAGES, p.stage),
     owner, pick(b, 'description', p.description),
     has(b, 'summary') ? pick(b, 'summary') : p.summary,
     has(b, 'source') ? pick(b, 'source') : p.source, p.id]
  );
  const changes = diffFields(p, r.rows[0], MATERIAL_PROJECT_FIELDS);
  await logActivity(pool, { projectId: p.id, actor: req.actor, action: 'project.update',
    accent: changes.length > 0, detail: changeSummary(changes, r.rows[0].name), changes });
  // A folder-level change reaches everyone on every show inside it — a client
  // rename or an owner handover is exactly the kind of thing that used to
  // travel by word of mouth or not at all.
  if (changes.length) {
    const people = await projectAudience(pool, p.id);
    if (people.length) {
      await announceShowChange(pool, {
        showId: null, projectId: p.id, actor: req.actor, to: people,
        what: `the folder ${r.rows[0].name}`, changes, link: `/#folder/${p.id}`
      });
    }
  }
  res.json(await hydrateProject(r.rows[0], pool, { session: req.session }));
}));

// Manual cascade, one transaction. lib/db.js deleteProjectCascade knows every
// child table — a new table that is not listed there leaks rows.
router.delete('/projects/:id', asyncH(async (req, res) => {
  const p = await loadProject(idParam(req));
  if (!p) throw notFound();
  if (!canEditProject(req.session, p)) throw forbidden('Not allowed to delete this project');
  await withTx(async (c) => { await deleteProjectCascade(c, p.id); });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// SHOWS
// ════════════════════════════════════════════════════════════════════════════
router.get('/shows', asyncH(async (req, res) => {
  const params = [];
  const where = [];
  const projectId = intOrNull(pick(req.query, 'project_id'));
  if (projectId) { params.push(projectId); where.push(`project_id=$${params.length}`); }
  const arch = archiveClause(req);
  if (arch) where.push(arch.trim());
  let q = 'SELECT * FROM shows';
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY event_date ASC, id ASC';
  const r = await pool.query(q, params);
  const out = [];
  for (const row of r.rows) out.push(await hydrateShow(row));
  res.json(out);
}));

// api.getShow(id) — the hydrated detail: steps, its project, its default job,
// its type (type lives on the project), milestones.
router.get('/shows/:id', asyncH(async (req, res) => {
  const s = await loadShow(idParam(req));
  if (!s) throw notFound();
  const p = await loadProject(s.project_id);
  const show = await hydrateShow(s, pool, { withSteps: true });
  show.project = await hydrateProject(p, pool, { deep: false });
  show.type = p ? p.type : 'led';
  show.milestones = await milestonesFor({ showId: s.id });
  show.job = s.default_job_id
    ? stripMoney(dbToJob((await pool.query('SELECT * FROM jobs WHERE id=$1',
        [s.default_job_id])).rows[0]), hasFinance(req.session)) : null;
  show.lanes = await lanesForType(show.type);
  res.json(show);
}));

router.post('/shows', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const projectId = intOrNull(pick(b, 'project_id'));
  if (!projectId) throw badRequest('project_id required');
  const project = await loadProject(projectId);
  if (!project) throw notFound('Project not found');
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to add shows to this project');

  const result = await withTx(async (c) => {
    const name = pick(b, 'name') || '';
    const ins = await c.query(
      `INSERT INTO shows (project_id, name, slug, venue, city, load_in_date, event_date, strike_date,
                          stage, rag, on_site_poc, owner, default_job_id, cabinets)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [project.id, name, pick(b, 'slug') || slug(name || project.name), pick(b, 'venue') || '',
       pick(b, 'city') || '', pick(b, 'load_in_date') || '', pick(b, 'event_date') || '',
       pick(b, 'strike_date') || '', oneOf(pick(b, 'stage'), STAGES, 'lead'),
       oneOf(pick(b, 'rag'), RAGS, 'idle'), pick(b, 'on_site_poc') || '',
       pick(b, 'owner') || project.owner || req.session.username,
       intOrNull(pick(b, 'default_job_id')), parseInt(pick(b, 'cabinets'), 10) || 0]
    );
    const show = ins.rows[0];
    // A show with no explicit job inherits the folder's first job.
    if (!show.default_job_id) {
      const j = await c.query('SELECT id FROM jobs WHERE project_id=$1 ORDER BY id LIMIT 1', [project.id]);
      if (j.rows.length) {
        await c.query('UPDATE shows SET default_job_id=$1 WHERE id=$2', [j.rows[0].id, show.id]);
        show.default_job_id = j.rows[0].id;
      }
    }
    let instantiated = 0;
    const templateId = intOrNull(pick(b, 'template_id'));
    if (templateId) instantiated = await instantiateTemplateOnShow(c, templateId, show, project);
    await logActivity(c, { projectId: project.id, showId: show.id, actor: req.actor,
      action: 'show.create', accent: true,
      detail: (name || show.venue || '') + (instantiated ? ` (+${instantiated} steps)` : '') });
    await notifyTargets(c, { body: b, anchorType: 'show', anchorId: show.id, projectId: project.id,
      showId: show.id, actor: req.actor, summary: `added the show “${name || show.venue}” —` });
    return { show, instantiated };
  });
  const out = await hydrateShow(result.show, pool, { withSteps: true });
  out.instantiated_steps = result.instantiated;
  res.json(out);
}));

router.put('/shows/:id', asyncH(async (req, res) => {
  const s = await loadShow(idParam(req));
  if (!s) throw notFound();
  const project = await loadProject(s.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this show');
  const b = req.body || {};
  const newEventDate = pick(b, 'event_date', s.event_date);

  const row = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE shows SET name=$1, slug=$2, venue=$3, city=$4, load_in_date=$5, event_date=$6,
         strike_date=$7, stage=$8, rag=$9, rag_override=$10, on_site_poc=$11, owner=$12,
         default_job_id=$13, cabinets=$14, summary=$15, source=$16, updated_at=NOW()
       WHERE id=$17 RETURNING *`,
      [pick(b, 'name', s.name), pick(b, 'slug', s.slug), pick(b, 'venue', s.venue),
       pick(b, 'city', s.city), pick(b, 'load_in_date', s.load_in_date), newEventDate,
       pick(b, 'strike_date', s.strike_date), oneOf(pick(b, 'stage'), STAGES, s.stage),
       oneOf(pick(b, 'rag'), RAGS, s.rag),
       // 9. the manager override: null clears it and RAG goes back to derived.
       has(b, 'rag_override') ? oneOf(pick(b, 'rag_override'), RAGS, null) : s.rag_override,
       pick(b, 'on_site_poc', s.on_site_poc), pick(b, 'owner', s.owner),
       has(b, 'default_job_id') ? intOrNull(pick(b, 'default_job_id')) : s.default_job_id,
       has(b, 'cabinets') ? (parseInt(pick(b, 'cabinets'), 10) || 0) : s.cabinets,
       has(b, 'summary') ? pick(b, 'summary') : s.summary,
       has(b, 'source') ? pick(b, 'source') : s.source, s.id]
    );
    // Keeping BOTH due_date and due_offset_days means a date change recomputes
    // the back-schedule instead of stranding it (SCHEMA.md).
    let moved = 0;
    if (newEventDate !== s.event_date && isISODate(newEventDate)) {
      const steps = await c.query(
        'SELECT id, due_offset_days FROM steps WHERE show_id=$1 AND due_offset_days IS NOT NULL', [s.id]);
      for (const st of steps.rows) {
        await c.query('UPDATE steps SET due_date=$1, updated_at=NOW() WHERE id=$2',
          [addDays(newEventDate, st.due_offset_days), st.id]);
      }
      moved = steps.rows.length;
    }
    // F3. The diff, over the named MATERIAL set — so `show.update` stops
    // meaning "something about this show changed" and starts saying which
    // field, from what, to what. `detail` is now built from the same array.
    const changes = diffFields(s, r.rows[0], MATERIAL_SHOW_FIELDS);
    await logActivity(c, { projectId: s.project_id, showId: s.id, actor: req.actor,
      action: 'show.update', accent: changes.length > 0,
      detail: changeSummary(changes, r.rows[0].name), changes });
    await notifyTargets(c, { body: b, anchorType: 'show', anchorId: s.id, projectId: s.project_id,
      showId: s.id, actor: req.actor, summary: `updated the show —` });
    // F1/F5. THE POINT OF THE WHOLE PASS. Moving the event date used to rewrite
    // every deadline in the show and tell only whoever the caller happened to
    // type into notify:[]. Now the show's own people are addressed because they
    // are on it — no notify array involved, nobody having to remember.
    if (changes.length) {
      await announceShowChange(c, {
        showId: s.id, projectId: s.project_id, actor: req.actor,
        what: `${r.rows[0].name || 'the show'}`,
        changes,
        extra: moved
          ? `${moved} task deadline${moved === 1 ? '' : 's'} moved with the date. Check yours.`
          : ''
      });
    }
    return r.rows[0];
  });
  res.json(await hydrateShow(row, pool, { withSteps: true }));
}));

router.delete('/shows/:id', asyncH(async (req, res) => {
  const s = await loadShow(idParam(req));
  if (!s) throw notFound();
  const project = await loadProject(s.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to delete this show');
  await withTx(async (c) => { await deleteShowCascade(c, s.id); });
  res.json({ ok: true });
}));

// 8. milestones ("Content due", "Proof approved", "Freight", "Target").
router.get('/shows/:id/milestones', asyncH(async (req, res) => {
  res.json(await milestonesFor({ showId: idParam(req) }));
}));
router.post('/shows/:id/milestones', requireRole('pm'), asyncH(async (req, res) => {
  const showId = idParam(req);
  const s = await loadShow(showId);
  if (!s) throw notFound('Show not found');
  if (!canEditProject(req.session, await loadProject(s.project_id))) throw forbidden();
  const label = pick(req.body, 'label');
  if (!label) throw badRequest('label required');
  const date = pick(req.body, 'date') || '';
  if (date && !isISODate(date)) throw badRequest('date must be YYYY-MM-DD');
  const r = await pool.query(
    `INSERT INTO milestones (show_id, label, date, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
    [showId, label, date, parseInt(pick(req.body, 'sort_order'), 10) || 0]);
  res.json(dbToMilestone(r.rows[0]));
}));
// H1 + H3. This carried a rank check, no ownership check and no existence
// check — so any pm could delete any milestone on anybody's project, and a
// stale screen got {ok:true} for an id that was already gone.
router.delete('/milestones/:id', requireRole('pm'), asyncH(async (req, res) => {
  const id = idParam(req);
  const cur = (await pool.query('SELECT * FROM milestones WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound(`milestone ${id} not found`);
  const project = await projectForRow(cur);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to delete this milestone');
  await pool.query('DELETE FROM milestones WHERE id=$1', [id]);
  await logActivity(pool, { projectId: project ? project.id : null, showId: cur.show_id || null,
    actor: req.actor, action: 'milestone.delete', detail: cur.label });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// F1. NEW EVENT — folder + job + show + lanes, in ONE transaction
// ────────────────────────────────────────────────────────────────────────────
// "New Event" was the last mock button in the app. This is what it now calls.
//
// It is a COMPOSITE over the routes that already exist — POST /projects, the
// auto-created TEMP-numbered job, POST /shows, instantiate-template — not a
// second implementation of any of them. Three reasons it is one endpoint rather
// than three calls from the browser:
//
//   · ATOMICITY. A folder with no show, or a show with no job, is a broken
//     record somebody has to clean up by hand. One transaction, or nothing.
//   · ONE NOTIFY. Tom's own blind spot (TEAM_FEEDBACK, 2026-08-27): "when I add
//     an event I should have the option of letting people know about it." Three
//     calls would mean three notify lists and three pings for one act. The
//     notify-picker row on this modal produces exactly ONE anchored ping,
//     naming the event.
//   · ONE ACTIVITY STORY. `event.create` reads as one line in the feed.
//
// The job opens on a TEMP placeholder (POLISH_LIST #5) because nobody has a
// QuickBooks number the moment a folder is opened — and F5's Confirm is the
// moment Candice swaps in the real one.
router.post('/events', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const name = String(pick(b, 'name') || '').trim();
  if (!name) throw badRequest('name required');
  const type = oneOf(pick(b, 'type'), PROJECT_TYPES, 'led');
  const client = String(pick(b, 'client') || '').trim();
  const venue = String(pick(b, 'venue') || '').trim();
  const eventDate = String(pick(b, 'event_date') || '').trim();
  if (eventDate && !isISODate(eventDate)) throw badRequest('event_date must be YYYY-MM-DD');
  const loadIn = String(pick(b, 'load_in_date') || '').trim();
  if (loadIn && !isISODate(loadIn)) throw badRequest('load_in_date must be YYYY-MM-DD');
  const strike = String(pick(b, 'strike_date') || '').trim();
  if (strike && !isISODate(strike)) throw badRequest('strike_date must be YYYY-MM-DD');
  // A pm always owns what they create; manager+ may hand it to someone else.
  const owner = (roleRank(req.session.role) >= ROLE_RANK.manager && pick(b, 'owner'))
    ? String(pick(b, 'owner')) : req.session.username;
  if (owner !== req.session.username) {
    const { unknown } = await resolveUsernames([owner]);
    if (unknown.length) throw badRequest(`Unknown user '${owner}'`);
  }
  // A brand-new event is QUOTED — nobody has committed to anything yet, and
  // pretending otherwise is exactly what F5's Confirm button exists to stop.
  const stage = oneOf(pick(b, 'stage'), STAGES, 'quoted');

  const out = await withTx(async (c) => {
    const proj = (await c.query(
      `INSERT INTO projects (name, slug, client, type, stage, owner, description, summary, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, slug(name), client, type, stage, owner,
       String(pick(b, 'description') || ''), pick(b, 'summary') || null,
       pick(b, 'source') || null])).rows[0];

    const job = (await c.query(
      `INSERT INTO jobs (project_id, name, qb_job_number, qb_number_status, client, deal_type,
                         description, contract_value)
       VALUES ($1,$2,$3,'temp',$4,$5,'',$6) RETURNING *`,
      [proj.id, pick(b, 'job_name') || name, await mintTempJobNumber(c), client,
       oneOf(pick(b, 'deal_type'), DEAL_TYPES, 'rental'),
       money(pick(b, 'contract_value'), 0)])).rows[0];

    const showName = String(pick(b, 'show_name') || name).trim();
    const show = (await c.query(
      `INSERT INTO shows (project_id, name, slug, venue, city, load_in_date, event_date,
                          strike_date, stage, rag, on_site_poc, owner, default_job_id, cabinets)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'idle',$10,$11,$12,$13) RETURNING *`,
      [proj.id, showName, slug(showName), venue, String(pick(b, 'city') || ''),
       loadIn, eventDate, strike, stage, String(pick(b, 'on_site_poc') || ''),
       owner, job.id, parseInt(pick(b, 'cabinets'), 10) || 0])).rows[0];

    // The event TYPE's template supplies the lane set + the T-minus pipeline.
    // Explicit template_id wins; otherwise the first template for this type.
    let templateId = intOrNull(pick(b, 'template_id'));
    if (!templateId && pick(b, 'seed_template', true) !== false) {
      const t = await c.query(
        'SELECT id FROM event_type_templates WHERE event_type=$1 ORDER BY id LIMIT 1', [type]);
      if (t.rows.length) templateId = t.rows[0].id;
    }
    let instantiated = 0;
    if (templateId) instantiated = await instantiateTemplateOnShow(c, templateId, show, proj);

    // F4. A scope line may be entered at creation. Silently ignored when empty,
    // because most events are opened before anyone knows the cabinet count.
    const scope = await applyScope(c, show, b, req.actor, { silent: true });
    if (scope) Object.assign(show, scope);

    await logActivity(c, {
      projectId: proj.id, showId: show.id, actor: req.actor, action: 'event.create',
      detail: `${name} · ${type}` + (venue ? ` · ${venue}` : '') +
              ` · job ${job.qb_job_number}` + (instantiated ? ` · +${instantiated} steps` : ''),
      accent: true
    });
    // ONE ping for the whole act, carrying the event's own name.
    const notified = await notifyTargets(c, {
      body: b, anchorType: 'show', anchorId: show.id, projectId: proj.id, showId: show.id,
      actor: req.actor,
      summary: `opened the event “${name}”${venue ? ' at ' + venue : ''}${eventDate ? ' · ' + eventDate : ''} —`,
      link: '/#show/' + show.id
    });
    return { proj, job, show, instantiated, notified };
  });

  const showRec = await hydrateShow(out.show, pool, { withSteps: true });
  showRec.instantiated_steps = out.instantiated;
  res.json({
    ok: true,
    project: await hydrateProject(out.proj, pool, { session: req.session }),
    job: stripMoney(dbToJob(out.job), hasFinance(req.session)),
    show: showRec,
    instantiated_steps: out.instantiated,
    notified: out.notified
  });
}));

// ════════════════════════════════════════════════════════════════════════════
// F4. SCOPE LINE
// ════════════════════════════════════════════════════════════════════════════
// Structured "what we're delivering", per show. ONE writer, shared by
// PUT /shows/:id/scope and the create flow above, so both validate identically.
//
// `silent` is for the create path: an event opened with no scope numbers is the
// normal case, not a 400.
async function applyScope(c, show, b, actor, { silent = false } = {}) {
  const has_ = (k) => has(b, k) || has(b, 'scope_' + k);
  const get_ = (k) => (has(b, 'scope_' + k) ? pick(b, 'scope_' + k) : pick(b, k));
  const wanted = ['kind', 'linear_feet', 'cabinet_count', 'cabinet_type', 'pitch',
                  'print_pieces', 'print_sqft'].filter(has_);
  const scopeObj = pick(b, 'scope');
  if (!wanted.length && (!scopeObj || typeof scopeObj !== 'object')) {
    if (silent) return null;
    throw badRequest('nothing to set — send a scope kind and at least one number');
  }
  const src = (scopeObj && typeof scopeObj === 'object' && !Array.isArray(scopeObj)) ? scopeObj : null;
  const val = (k) => (src && src[k] !== undefined) ? src[k] : (has_(k) ? get_(k) : undefined);

  const kindIn = val('kind');
  const kind = kindIn === undefined ? show.scope_kind
    : (kindIn === null || kindIn === '' ? null : oneOf(String(kindIn), SCOPE_KINDS, null));
  if (kindIn !== undefined && kindIn !== null && kindIn !== '' && !kind) {
    throw badRequest(`scope kind must be one of: ${SCOPE_KINDS.join(', ')}`);
  }
  const numField = (k, cur, isInt) => {
    const v = val(k);
    if (v === undefined) return cur;
    if (v === null || v === '') return null;
    const n2 = isInt ? intOrNull(v) : num(v, null);
    if (n2 == null || n2 < 0) throw badRequest(`scope ${k} must be a non-negative number`);
    return n2;
  };
  const textField = (k, cur) => {
    const v = val(k);
    if (v === undefined) return cur;
    const t = String(v == null ? '' : v).trim().slice(0, 60);
    return t || null;
  };

  const next = {
    scope_kind: kind,
    scope_linear_feet: numField('linear_feet', show.scope_linear_feet, false),
    scope_cabinet_count: numField('cabinet_count', show.scope_cabinet_count, true),
    scope_cabinet_type: textField('cabinet_type', show.scope_cabinet_type),
    scope_pitch: textField('pitch', show.scope_pitch),
    scope_print_pieces: numField('print_pieces', show.scope_print_pieces, true),
    scope_print_sqft: numField('print_sqft', show.scope_print_sqft, false),
    scope_source: oneOf(String(val('source') || show.scope_source || 'manual'),
                        ['manual', 'spec'], 'manual')
  };
  const r = await c.query(
    `UPDATE shows SET scope_kind=$2, scope_linear_feet=$3, scope_cabinet_count=$4,
       scope_cabinet_type=$5, scope_pitch=$6, scope_print_pieces=$7, scope_print_sqft=$8,
       scope_source=$9, scope_verified_at=NOW(), scope_verified_by=$10, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [show.id, next.scope_kind, next.scope_linear_feet, next.scope_cabinet_count,
     next.scope_cabinet_type, next.scope_pitch, next.scope_print_pieces, next.scope_print_sqft,
     next.scope_source, String(actor || '').replace(/^agent:/, '')]);
  return r.rows[0];
}

// GET the scope + whatever the bound spec has to say about it.
router.get('/shows/:id/scope', asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const { boundSpecDocs } = require('./files');
  const { docs } = await boundSpecDocs(show.id);
  const derived = scopeFromDocs(docs);
  const scope = scopeOf(show);
  res.json({
    show_id: show.id,
    scope,
    scope_line: scopeLine(show),
    source: show.scope_source || 'manual',
    verified_at: show.scope_verified_at, verified_by: show.scope_verified_by,
    spec: derived,
    // D7's rule, reused: a difference between the sold scope and the bound
    // spec is a QUESTION for a human, never an error and never a silent
    // overwrite. Same shape as the chain checker's findings.
    questions: scopeQuestions(scope, derived)
  });
}));

// pm+ (and only on a folder they may edit) — the scope line is a commercial
// statement, not a field note.
router.put('/shows/:id/scope', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this show');
  const b = req.body || {};

  const row = await withTx(async (c) => {
    const updated = await applyScope(c, show, b, req.actor);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id, actor: req.actor, action: 'scope.set',
      detail: scopeLine(updated) || 'scope cleared', accent: true });
    await notifyTargets(c, { body: b, anchorType: 'show', anchorId: show.id,
      projectId: show.project_id, showId: show.id, actor: req.actor,
      summary: `set the scope to ${scopeLine(updated) || '—'} —`, link: '/#show/' + show.id });
    return updated;
  });
  const { boundSpecDocs } = require('./files');
  const { docs } = await boundSpecDocs(show.id);
  const derived = scopeFromDocs(docs);
  res.json({ ...(await hydrateShow(row, pool)), spec: derived,
             questions: scopeQuestions(scopeOf(row), derived) });
}));

// Auto-fill from the bound spec. Explicitly a SEPARATE act from GET — a spec
// bind never silently rewrites a number a human typed; somebody asks for it.
router.post('/shows/:id/scope/from-spec', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this show');
  const { boundSpecDocs } = require('./files');
  const { docs } = await boundSpecDocs(show.id);
  const derived = scopeFromDocs(docs);
  if (!derived.available) {
    throw conflict('No bound spec on this show can answer for the scope yet — ' +
      'bind a .e360, .nsf or .pcfg first, or enter the numbers by hand.');
  }
  const row = await withTx(async (c) => {
    const patch = { source: 'spec' };
    if (derived.cabinet_count != null) patch.cabinet_count = derived.cabinet_count;
    if (derived.cabinet_type) patch.cabinet_type = derived.cabinet_type;
    // A show with no scope kind yet takes the one its spec implies.
    if (!show.scope_kind) patch.kind = (project && project.type === 'print') ? 'print' : 'led';
    const updated = await applyScope(c, show, { scope: patch }, req.actor);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id, actor: req.actor, action: 'scope.from_spec',
      detail: `${scopeLine(updated)} · ${derived.count_source}` +
              (derived.stack_aware ? ' (stack-aware)' : ''), accent: true });
    return updated;
  });
  res.json({ ...(await hydrateShow(row, pool)), spec: derived,
             questions: scopeQuestions(scopeOf(row), derived) });
}));

// ════════════════════════════════════════════════════════════════════════════
// F5. CONFIRM — the explicit act that records the client committed
// ════════════════════════════════════════════════════════════════════════════
// Tom: "Confirm = explicit action, admin/PM only, means the client committed
// (signed/PO'd) — datestamped + logged."
//
// It is a BUTTON, never a side effect of editing the stage dropdown: the stage
// string can be typed by anyone who may edit the show, and "the client signed"
// is a different claim with a different gate (lifecycle.canConfirm).
router.post('/shows/:id/confirm', asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!lifecycle.canConfirm(req.session, show, project)) {
    throw forbidden('confirming a show requires manager, admin — or the pm who owns it');
  }
  if (show.confirmed_at) {
    throw conflict(`This show was already confirmed by ${show.confirmed_by || 'someone'}`,
      { confirmedAt: show.confirmed_at, confirmedBy: show.confirmed_by });
  }
  const b = req.body || {};

  const out = await withTx(async (c) => {
    // The stage advances to 'confirmed' unless it is already further along —
    // confirming a show that is mid-delivery records the fact without dragging
    // the pipeline backwards.
    const nextStage = lifecycle.stageAtLeast(show.stage, 'confirmed') ? show.stage : 'confirmed';
    const r = await c.query(
      `UPDATE shows SET confirmed_at=NOW(), confirmed_by=$2, stage=$3, updated_at=NOW()
       WHERE id=$1 RETURNING *`, [show.id, req.session.username, nextStage]);

    // The temp-job prompt. Confirming is the moment the deal is real, which is
    // exactly when Candice can cut the QuickBooks number (POLISH_LIST #5). We
    // do NOT mint one here — accounting owns that number — we surface it.
    const job = show.default_job_id ? await loadJob(show.default_job_id, c) : null;
    const tempJob = job && job.qb_number_status === 'temp' ? job : null;

    await logActivity(c, {
      projectId: show.project_id, showId: show.id, jobId: job ? job.id : null,
      actor: req.actor, action: 'show.confirm',
      detail: `client committed — confirmed by ${req.session.username}` +
              (tempJob ? ` · job still on ${tempJob.qb_job_number}` : ''),
      accent: true });
    await notifyTargets(c, { body: b, anchorType: 'show', anchorId: show.id,
      projectId: show.project_id, showId: show.id, actor: req.actor,
      summary: `confirmed ${show.name || show.venue || 'the show'} — the client committed —`,
      link: '/#show/' + show.id });
    return { row: r.rows[0], tempJob };
  });

  const rec = await hydrateShow(out.row, pool, { withSteps: true });
  res.json({
    ok: true,
    show: rec,
    // What the UI turns into the "enter the real QB number" prompt.
    qb_prompt: out.tempJob ? {
      job_id: out.tempJob.id,
      qb_job_number: out.tempJob.qb_job_number,
      message: `This job is still on the placeholder ${out.tempJob.qb_job_number}. ` +
               'Now that the client has committed, Candice can cut the real QuickBooks number.'
    } : null,
    scheduler_unlocked: true
  });
}));

// ════════════════════════════════════════════════════════════════════════════
// F2. STRUCK — "the show is over; everyone on the crew owes a report"
// ════════════════════════════════════════════════════════════════════════════
// The hand-operated twin of the sweep's date trigger. Both call
// reports.ensureTechReports(), so a pm who strikes early and a strike date that
// simply passes produce identical rows.
router.post('/shows/:id/struck', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to modify this show');

  const out = await withTx(async (c) => {
    if (!show.struck_at) {
      await c.query('UPDATE shows SET struck_at=NOW(), struck_by=$2, updated_at=NOW() WHERE id=$1',
        [show.id, req.session.username]);
    }
    const created = await reports.ensureTechReports(c, show, { actor: req.actor });
    const renagged = await reports.nagOwed(c, show, { actor: req.actor });
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'show.struck',
      detail: `struck · ${created.length} report${created.length === 1 ? '' : 's'} now owed`,
      accent: true });
    const summary = await reports.owedSummary(show.id, c);
    return { created: created.length, renagged, summary };
  });
  const fresh = await loadShow(show.id);
  res.json({ ok: true, show: await hydrateShow(fresh, pool), ...out });
}));

// ════════════════════════════════════════════════════════════════════════════
// F6. CLOSEOUT + ARCHIVING
// ════════════════════════════════════════════════════════════════════════════
// The machine-checked closeout: recap sent · every tech report filed · no open
// finance exception on this show. Reading it also SYNCS the marker, so the
// number a person sees and the 60-day clock can never disagree.
router.get('/shows/:id/closeout', asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const st = await withTx(async (c) => lifecycle.syncCloseout(c, show.id, { actor: req.actor }));
  res.json(st);
}));

router.post('/shows/:id/archive', asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  if (!lifecycle.canArchive(req.session)) {
    throw forbidden('archiving is an admin act — ask Tom, Tony or Jim');
  }
  const out = await withTx(async (c) => lifecycle.archiveShow(c, show, { actor: req.actor }));
  const fresh = await loadShow(show.id);
  res.json({ ok: true, already: out.already, show: await hydrateShow(fresh, pool) });
}));

router.post('/shows/:id/unarchive', asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  if (!lifecycle.canArchive(req.session)) {
    throw forbidden('unarchiving is an admin act — ask Tom, Tony or Jim');
  }
  const out = await withTx(async (c) => lifecycle.unarchiveShow(c, show, { actor: req.actor }));
  const fresh = await loadShow(show.id);
  res.json({ ok: true, already: out.already, show: await hydrateShow(fresh, pool) });
}));

router.post('/projects/:id/archive', asyncH(async (req, res) => {
  const p = await loadProject(idParam(req));
  if (!p) throw notFound('Project not found');
  if (!lifecycle.canArchive(req.session)) {
    throw forbidden('archiving is an admin act — ask Tom, Tony or Jim');
  }
  await withTx(async (c) => {
    const shows = await c.query('SELECT * FROM shows WHERE project_id=$1', [p.id]);
    for (const s of shows.rows) await lifecycle.archiveShow(c, s, { actor: req.actor });
    // An EMPTY folder has no shows to carry it, so archive it directly.
    await c.query(
      `UPDATE projects SET archived_at=NOW(), archived_by=$2, updated_at=NOW()
       WHERE id=$1 AND archived_at IS NULL`, [p.id, req.actor]);
    await logActivity(c, { projectId: p.id, actor: req.actor, action: 'project.archive',
      detail: 'archived by hand', accent: true });
  });
  res.json(await hydrateProject(await loadProject(p.id), pool, { session: req.session }));
}));

router.post('/projects/:id/unarchive', asyncH(async (req, res) => {
  const p = await loadProject(idParam(req));
  if (!p) throw notFound('Project not found');
  if (!lifecycle.canArchive(req.session)) {
    throw forbidden('unarchiving is an admin act — ask Tom, Tony or Jim');
  }
  await withTx(async (c) => {
    await c.query(
      'UPDATE projects SET archived_at=NULL, archived_by=NULL, updated_at=NOW() WHERE id=$1', [p.id]);
    const shows = await c.query('SELECT * FROM shows WHERE project_id=$1 AND archived_at IS NOT NULL',
      [p.id]);
    for (const s of shows.rows) await lifecycle.unarchiveShow(c, s, { actor: req.actor });
    await logActivity(c, { projectId: p.id, actor: req.actor, action: 'project.unarchive',
      detail: 'back in the working set', accent: true });
  });
  res.json(await hydrateProject(await loadProject(p.id), pool, { session: req.session }));
}));

// The stage vocabulary itself, so the UI never hardcodes it (the same argument
// GET /event-types makes for lanes).
router.get('/stages', asyncH(async (req, res) => {
  res.json({
    lifecycle: LIFECYCLE_STAGES,
    all: STAGES,
    labels: LIFECYCLE_STAGES.concat(STAGES.filter((s) => LIFECYCLE_STAGES.indexOf(s) < 0))
      .reduce((a, s) => { a[s] = stageLabel(s); return a; }, {}),
    // the legacy → lifecycle display map, published rather than duplicated
    alias: STAGES.filter((s) => LIFECYCLE_STAGES.indexOf(s) < 0)
      .reduce((a, s) => { a[s] = canonicalStage(s); return a; }, {}),
    archive_after_days: lifecycle.ARCHIVE_AFTER_DAYS
  });
}));

// ════════════════════════════════════════════════════════════════════════════
// STEPS
// ════════════════════════════════════════════════════════════════════════════
// C. A step's lane must be one of the lanes ITS project type declares. That is
// read from `event_types`, so adding "Motion Graphics" with three new lanes is
// a config row, not a deploy.
async function assertLane(lane, project, q = pool) {
  const known = await allLaneKeys(q);
  if (!known.includes(lane)) throw badRequest(`Unknown lane '${lane}'`);
  const allowed = await lanesForType(project ? project.type : 'led', q);
  if (!allowed.includes(lane)) {
    throw badRequest(`Lane '${lane}' is not part of the '${project ? project.type : 'led'}' event type ` +
      `(its lanes: ${allowed.join(', ')})`);
  }
  return lane;
}

router.get('/steps', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
  const showId = intOrNull(pick(req.query, 'show_id'));
  const projectId = intOrNull(pick(req.query, 'project_id'));
  if (showId) add('show_id=$?', showId);
  if (projectId) add('project_id=$?', projectId);
  if (req.query.lane) add('lane=$?', req.query.lane);
  if (req.query.owner) add('LOWER(owner)=LOWER($?)', req.query.owner);
  if (req.query.status) add('status=$?', req.query.status);
  let q = 'SELECT * FROM steps';
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY sort_order ASC, id ASC';
  const r = await pool.query(q, params);
  res.json(r.rows.map(dbToStep));
}));

router.get('/steps/:id', asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM steps WHERE id=$1', [idParam(req)]);
  if (!r.rows.length) throw notFound();
  res.json(dbToStep(r.rows[0]));
}));

// "My tasks" — every open step owned by the caller, across all folders.
router.get('/my-steps', asyncH(async (req, res) => {
  let who = req.session.username;
  const asked = pick(req.query, 'username');
  if (asked && asked !== who) {
    if (roleRank(req.session.role) < 3) throw forbidden("Only manager+ may read another person's tasks");
    who = asked;
  }
  // F6. An archived show is out of the working set, so its open steps stop
  // nagging. A project-level step (show_id NULL) is unaffected by the LEFT JOIN.
  const r = await pool.query(
    `SELECT s.*, sh.name AS show_name, sh.venue AS show_venue, sh.project_id AS show_project_id
     FROM steps s LEFT JOIN shows sh ON sh.id = s.show_id
     WHERE LOWER(s.owner)=LOWER($1) AND s.status NOT IN ('done','na')
       AND sh.archived_at IS NULL
     ORDER BY s.due_date ASC NULLS LAST, s.id ASC`, [who]);
  res.json(r.rows.map((row) => ({
    ...dbToStep(row),
    show: row.show_id ? { id: row.show_id, name: row.show_name, venue: row.show_venue,
                          project_id: row.show_project_id } : null
  })));
}));

// F5 (narrow form). A task changing under its owner is THEIR event, not the
// show's. Reassignment is the one case with two interested parties — the person
// who just lost it and the person who just gained it — and both are told.
async function notifyChangedStep(c, { step, prev, changes, project, actor }) {
  const show = step.show_id ? await loadShow(step.show_id, c) : null;
  const where = show ? (show.name || show.venue || ('show ' + show.id))
    : (project ? project.name : 'Showrunner');
  const link = step.show_id ? '/#show/' + step.show_id : '';
  const reassigned = changes.some((ch) => ch.field === 'owner');
  // The new owner is told by the assignment path's own words, so this is the
  // 'change' kind and not a duplicate 'assignment'.
  const people = new Set();
  if (step.owner) people.add(step.owner);
  if (reassigned && prev.owner) people.add(prev.owner);
  const targets = Array.from(people).filter(Boolean);
  if (!targets.length) return [];
  return announceShowChange(c, {
    showId: step.show_id || null, projectId: project ? project.id : null,
    actor, to: targets, link,
    subject: `Your task changed — “${step.title}” on ${where}`,
    what: `“${step.title}” on ${where}`,
    changes
  });
}

router.post('/steps', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const showId = intOrNull(pick(b, 'show_id'));
  const projectId = intOrNull(pick(b, 'project_id'));
  if (!showId && !projectId) throw badRequest('show_id or project_id required');
  const title = pick(b, 'title');
  if (!title) throw badRequest('title required');

  const owningProject = await projectForRow({ show_id: showId, project_id: projectId });
  if (!owningProject) throw notFound('Parent project/show not found');
  if (!canEditProject(req.session, owningProject)) throw forbidden('Not allowed to add steps here');
  const lane = await assertLane(pick(b, 'lane'), owningProject);

  // due_date from an explicit date, or back-scheduled from the show's event date.
  let dueDate = pick(b, 'due_date') || '';
  const off = pick(b, 'due_offset_days');
  if (!dueDate && off != null && showId) {
    const show = await loadShow(showId);
    if (show && show.event_date) dueDate = addDays(show.event_date, off);
  }

  // An owner named at CREATE time is an assignment and must ping exactly as
  // PUT /steps/:id/assign does.
  //
  // It is NOT validated against the roster here, deliberately. `steps.owner` is
  // free text on purpose: a template seeds role slugs ('lead_tech'), and a local
  // hire can own a step without ever having a login. The canonical-name gate
  // lives at the push (lib/scheduler.js validateForPush, M6) — that is where an
  // unresolvable owner has a consequence, and moving the check here would refuse
  // rows the product legitimately creates. So: resolve, and ping only if there
  // is a real person on the other end. You cannot email a role slug.
  const newOwner = String(pick(b, 'owner') || '').trim();
  const ownerIsPerson = newOwner
    ? (await resolveUsernames([newOwner])).valid.length > 0 : false;

  const row = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO steps (show_id, project_id, lane, title, status, owner, owner_role, due_date,
         due_offset_days, evidence_type, evidence_ref, depends_on, auto_source, sort_order, notes, risk)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [showId, projectId, lane, title, oneOf(pick(b, 'status'), STEP_STATUSES, 'todo'),
       newOwner, pick(b, 'owner_role') || null, dueDate,
       off != null ? parseInt(off, 10) : null,
       oneOf(pick(b, 'evidence_type'), EVIDENCE_TYPES, 'none'), pick(b, 'evidence_ref') || '',
       intOrNull(pick(b, 'depends_on')), oneOf(pick(b, 'auto_source'), AUTO_SOURCES, 'none'),
       parseInt(pick(b, 'sort_order'), 10) || 0, pick(b, 'notes') || '', !!pick(b, 'risk')]
    );
    await logActivity(c, { projectId: owningProject.id, showId, actor: req.actor,
      action: 'step.create', detail: `[${lane}] ${title}` });
    if (ownerIsPerson) {
      const show = showId ? await loadShow(showId, c) : null;
      const where = show ? (show.name || show.venue || ('show ' + show.id)) : owningProject.name;
      await notify.enqueue(c, {
        username: newOwner, kind: 'assignment', actor: req.actor,
        subject: `Assigned to you — ${title}`,
        body: `${req.actor} created “${title}” on ${where} and assigned it to you` +
              (dueDate ? `, due ${dueDate}.` : '.'),
        projectId: owningProject.id, showId: showId || null,
        link: showId ? '/#show/' + showId : ''
      });
    }
    // F6. Every step route now takes the picker's list, like schedule.js does.
    // The note anchors on whichever parent the step actually has.
    await notifyTargets(c, {
      body: b,
      anchorType: showId ? 'show' : 'project', anchorId: showId || owningProject.id,
      projectId: owningProject.id, showId: showId || null, actor: req.actor,
      summary: `added the task “${title}” —`
    });
    return r.rows[0];
  });
  res.json(dbToStep(row));
}));

router.put('/steps/:id', asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM steps WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const project = await projectForRow(cur);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this step');
  const b = req.body || {};
  const lane = has(b, 'lane') ? await assertLane(pick(b, 'lane'), project) : cur.lane;

  let dueDate = has(b, 'due_date') ? pick(b, 'due_date') : cur.due_date;
  const off = has(b, 'due_offset_days') ? intOrNull(pick(b, 'due_offset_days')) : cur.due_offset_days;
  if (has(b, 'due_offset_days') && !has(b, 'due_date') && cur.show_id) {
    const show = await loadShow(cur.show_id);
    if (show && show.event_date && off != null) dueDate = addDays(show.event_date, off);
  }

  const row = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE steps SET lane=$1, title=$2, status=$3, owner=$4, owner_role=$5, due_date=$6,
         due_offset_days=$7, evidence_type=$8, evidence_ref=$9, depends_on=$10, auto_source=$11,
         sort_order=$12, notes=$13, risk=$14, updated_at=NOW() WHERE id=$15 RETURNING *`,
      [lane, pick(b, 'title', cur.title), oneOf(pick(b, 'status'), STEP_STATUSES, cur.status),
       pick(b, 'owner', cur.owner), pick(b, 'owner_role', cur.owner_role), dueDate, off,
       oneOf(pick(b, 'evidence_type'), EVIDENCE_TYPES, cur.evidence_type),
       pick(b, 'evidence_ref', cur.evidence_ref),
       has(b, 'depends_on') ? intOrNull(pick(b, 'depends_on')) : cur.depends_on,
       oneOf(pick(b, 'auto_source'), AUTO_SOURCES, cur.auto_source),
       has(b, 'sort_order') ? (parseInt(pick(b, 'sort_order'), 10) || 0) : cur.sort_order,
       pick(b, 'notes', cur.notes),
       has(b, 'risk') ? !!pick(b, 'risk') : cur.risk, cur.id]
    );
    const next = r.rows[0];
    const changes = diffFields(cur, next, MATERIAL_STEP_FIELDS);
    await logActivity(c, { projectId: project ? project.id : null, showId: cur.show_id,
      actor: req.actor, action: 'step.update',
      accent: changes.some((ch) => ch.field === 'status' && ch.to === 'blocked'),
      detail: changes.length ? `${next.title} · ${changeSummary(changes)}` : next.title,
      changes });
    // A re-date or a re-lane lands on the person doing the work. The owner is
    // told directly (it is their deadline); the wider audience is not, because
    // one task moving is not a show-level event — the show's date moving is,
    // and that path is PUT /shows/:id above.
    if (changes.length && next.owner) {
      await notifyChangedStep(c, {
        step: next, prev: cur, changes, project, actor: req.actor
      });
    }
    await notifyTargets(c, {
      body: b,
      anchorType: cur.show_id ? 'show' : 'project',
      anchorId: cur.show_id || (project ? project.id : null),
      projectId: project ? project.id : null, showId: cur.show_id || null,
      actor: req.actor, summary: `updated the task “${next.title}” —`
    });
    return next;
  });
  res.json(dbToStep(row));
}));

// Assigning work to someone else is a management act.
router.put('/steps/:id/assign', requireRole('pm'), asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM steps WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const project = await projectForRow(cur);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to assign on this project');
  const owner = pick(req.body, 'owner', pick(req.body, 'username')) || '';
  if (owner) {
    const { unknown } = await resolveUsernames([owner]);
    // Roster names are allowed too (local hires appear as steps' owners), but
    // an unknown token is worth flagging rather than silently storing.
    if (unknown.length) throw badRequest(`Unknown user '${owner}'`);
  }
  const r = await withTx(async (c) => {
    const upd = await c.query('UPDATE steps SET owner=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [owner, cur.id]);
    await logActivity(c, { projectId: project ? project.id : null, showId: cur.show_id,
      actor: req.actor, action: 'step.assign', detail: `${cur.title} → ${owner || '(unassigned)'}` });
    // F3. Being given work is the archetypal REAL delivery, and Tom's default
    // for it is immediate. The bell already carries it (the assignee sees it in
    // My Tasks); this is the second channel. Unassigning notifies nobody —
    // there is no one to tell.
    if (owner) {
      const show = cur.show_id ? await loadShow(cur.show_id, c) : null;
      const where = show ? (show.name || show.venue || ('show ' + show.id))
        : (project ? project.name : 'Showrunner');
      await notify.enqueue(c, {
        username: owner, kind: 'assignment', actor: req.actor,
        subject: `Assigned to you — ${cur.title}`,
        body: `${req.actor} assigned you “${cur.title}” on ${where}` +
              (cur.due_date ? `, due ${cur.due_date}.` : '.'),
        projectId: project ? project.id : null, showId: cur.show_id || null,
        link: cur.show_id ? '/#show/' + cur.show_id : ''
      });
    }
    return upd;
  });
  res.json(dbToStep(r.rows[0]));
}));

// The "techs update their own tasks" path: the step OWNER, or pm+ on the project.
router.put('/steps/:id/status', asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM steps WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const project = await projectForRow(cur);
  if (!canUpdateStepStatus(req.session, cur, project)) throw forbidden('Not allowed to update this step');
  const status = oneOf(pick(req.body, 'status'), STEP_STATUSES, null);
  if (!status) throw badRequest('Invalid status');
  const notes = has(req.body, 'notes') ? pick(req.body, 'notes') : cur.notes;
  const risk = has(req.body, 'risk') ? !!pick(req.body, 'risk') : cur.risk;
  const row = await withTx(async (c) => {
    const r = await c.query(
      'UPDATE steps SET status=$1, notes=$2, risk=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
      [status, notes, risk, cur.id]);
    const changes = diffFields(cur, r.rows[0], { status: 'status', risk: 'risk flag' });
    await logActivity(c, { projectId: project ? project.id : null, showId: cur.show_id,
      actor: req.actor, action: 'step.status', detail: `${cur.title} → ${status}`,
      accent: status === 'done' || status === 'blocked', changes });

    // ── F2. "THIS IS STUCK" NOW REACHES A HUMAN ────────────────────────────
    // The app already flagged `blocked` as significant to ITSELF — the activity
    // row is accented, the RAG model treats it as crit, the Overview's "biggest
    // risk" reads it. It told nobody. That is the single most crack-shaped
    // event in the business and it was the cheapest fix in the document.
    //
    // The audience is deliberately NARROW: the show owner and the folder owner,
    // the two people who can unblock something, plus the step's owner if
    // somebody else marked their task stuck. Not the whole crew — a blocked
    // task is a management event, not a broadcast.
    const wentBlocked = status === 'blocked' && cur.status !== 'blocked';
    const wentRisky = !!risk && !cur.risk;
    if (wentBlocked || wentRisky) {
      const show = cur.show_id ? await loadShow(cur.show_id, c) : null;
      const where = show ? (show.name || show.venue || ('show ' + show.id))
        : (project ? project.name : 'Showrunner');
      const to = [];
      if (show && show.owner) to.push(show.owner);
      if (project && project.owner) to.push(project.owner);
      if (cur.owner) to.push(cur.owner);
      await announceShowChange(c, {
        showId: cur.show_id || null, projectId: project ? project.id : null,
        actor: req.actor, to: Array.from(new Set(to.filter(Boolean))),
        kind: 'change',
        subject: wentBlocked
          ? `Blocked — “${cur.title}” on ${where}`
          : `Flagged at risk — “${cur.title}” on ${where}`,
        what: `“${cur.title}” on ${where}`,
        changes,
        extra: wentBlocked
          ? (notes ? `Why: ${notes}` : 'No reason given — ask before it becomes a surprise.')
          : (notes || '')
      });
    }
    // F6. The status route now carries the picker's list too. It was the one
    // route family where a person could not say "and tell Brenden" at all.
    await notifyTargets(c, {
      body: req.body,
      anchorType: cur.show_id ? 'show' : 'project',
      anchorId: cur.show_id || (project ? project.id : null),
      projectId: project ? project.id : null, showId: cur.show_id || null,
      actor: req.actor, summary: `marked “${cur.title}” ${status} —`
    });
    return r.rows[0];
  });
  res.json(dbToStep(row));
}));

router.delete('/steps/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM steps WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const project = await projectForRow(cur);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to delete this step');
  await withTx(async (c) => {
    await c.query(`DELETE FROM notes WHERE anchor_type='step' AND anchor_id=$1`, [cur.id]);
    await c.query(`DELETE FROM note_reads WHERE note_id NOT IN (SELECT id FROM notes)`);
    await c.query(`DELETE FROM note_mentions WHERE note_id NOT IN (SELECT id FROM notes)`);
    await c.query('UPDATE steps SET depends_on=NULL WHERE depends_on=$1', [cur.id]);
    await c.query('DELETE FROM steps WHERE id=$1', [cur.id]);
    await logActivity(c, { projectId: project ? project.id : null, showId: cur.show_id,
      actor: req.actor, action: 'step.delete', detail: cur.title });
    // Work disappearing off someone's list is exactly as material as work
    // arriving on it, and until now it happened in total silence.
    if (cur.owner) {
      await announceShowChange(c, {
        showId: cur.show_id || null, projectId: project ? project.id : null,
        actor: req.actor, to: [cur.owner],
        subject: `Removed from your list — “${cur.title}”`,
        what: `“${cur.title}”`,
        changes: [{ field: 'status', label: 'task', from: cur.status || 'todo', to: 'deleted' }]
      });
    }
    await notifyTargets(c, {
      body: req.body,
      anchorType: cur.show_id ? 'show' : 'project',
      anchorId: cur.show_id || (project ? project.id : null),
      projectId: project ? project.id : null, showId: cur.show_id || null,
      actor: req.actor, summary: `deleted the task “${cur.title}” —`
    });
  });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// TEMPLATES  (seeded from templates.json by lib/seed.js — punch item B)
// ════════════════════════════════════════════════════════════════════════════
router.get('/templates', asyncH(async (req, res) => {
  const eventType = pick(req.query, 'event_type');
  const r = eventType
    ? await pool.query('SELECT * FROM event_type_templates WHERE event_type=$1 ORDER BY name', [eventType])
    : await pool.query('SELECT * FROM event_type_templates ORDER BY event_type, name');
  const steps = await pool.query('SELECT * FROM template_steps ORDER BY sort_order ASC, id ASC');
  const byTpl = new Map();
  for (const s of steps.rows) {
    if (!byTpl.has(s.template_id)) byTpl.set(s.template_id, []);
    byTpl.get(s.template_id).push(dbToTemplateStep(s));
  }
  const types = await pool.query('SELECT * FROM event_types ORDER BY sort_order');
  const typeByKey = new Map(types.rows.map((t) => [t.key, t]));
  res.json(r.rows.map((row) => dbToTemplate(row, {
    steps: byTpl.get(row.id) || [],
    // the front-end's listTemplates() shape: each entry carries its type def
    def: typeByKey.get(row.event_type) || null
  })));
}));

// api.getTemplate(type) keys by EVENT TYPE; the REST id also works.
router.get('/templates/:key', asyncH(async (req, res) => {
  const key = String(req.params.key);
  const r = /^\d+$/.test(key)
    ? await pool.query('SELECT * FROM event_type_templates WHERE id=$1', [parseInt(key, 10)])
    : await pool.query('SELECT * FROM event_type_templates WHERE event_type=$1 ORDER BY id LIMIT 1', [key]);
  if (!r.rows.length) throw notFound();
  const t = r.rows[0];
  const steps = await pool.query(
    'SELECT * FROM template_steps WHERE template_id=$1 ORDER BY sort_order ASC, id ASC', [t.id]);
  const type = await pool.query('SELECT * FROM event_types WHERE key=$1', [t.event_type]);
  res.json(dbToTemplate(t, { steps: steps.rows.map(dbToTemplateStep), def: type.rows[0] || null }));
}));

// C. the lane sets themselves, so the front-end never hardcodes them either.
router.get('/event-types', asyncH(async (req, res) => {
  const types = await pool.query('SELECT * FROM event_types ORDER BY sort_order');
  const lanes = await pool.query('SELECT * FROM lanes ORDER BY sort_order');
  const laneByKey = new Map(lanes.rows.map((l) => [l.key, l]));
  res.json({
    lanes: lanes.rows,
    types: types.rows.map((t) => ({ ...t, lane_defs: (t.lanes || []).map((k) => laneByKey.get(k)).filter(Boolean) }))
  });
}));

router.post('/templates', requireRole('manager'), asyncH(async (req, res) => {
  const b = req.body || {};
  const name = pick(b, 'name');
  if (!name) throw badRequest('name required');
  const eventType = oneOf(pick(b, 'event_type'), PROJECT_TYPES, 'led');
  const allowed = await lanesForType(eventType);
  const t = await withTx(async (c) => {
    const ins = await c.query(
      'INSERT INTO event_type_templates (name, event_type, description) VALUES ($1,$2,$3) RETURNING *',
      [name, eventType, pick(b, 'description') || '']);
    const tid = ins.rows[0].id;
    let i = 0;
    for (const s of (pick(b, 'steps') || [])) {
      const lane = pick(s, 'lane');
      if (!allowed.includes(lane) || !s.title) continue;
      await c.query(
        `INSERT INTO template_steps (template_id, lane, title, due_offset_days, owner_role,
           evidence_type, auto_source, depends_on_title, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tid, lane, s.title, intOrNull(pick(s, 'due_offset_days')), pick(s, 'owner_role') || null,
         oneOf(pick(s, 'evidence_type'), EVIDENCE_TYPES, 'none'),
         oneOf(pick(s, 'auto_source'), AUTO_SOURCES, 'none'),
         pick(s, 'depends_on_title') || pick(s, 'depends_on') || '',
         intOrNull(pick(s, 'sort_order')) != null ? intOrNull(pick(s, 'sort_order')) : i++]);
    }
    return ins.rows[0];
  });
  res.json(dbToTemplate(t));
}));

router.post('/shows/:id/instantiate-template', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to modify this show');
  const templateId = intOrNull(pick(req.body, 'template_id'));
  if (!templateId) throw badRequest('template_id required');
  const count = await withTx(async (c) => {
    const n = await instantiateTemplateOnShow(c, templateId, show, project);
    await logActivity(c, { projectId: project.id, showId: show.id, actor: req.actor,
      action: 'template.instantiate', detail: `${n} steps from template ${templateId}`, accent: true });
    return n;
  });
  res.json({ ok: true, instantiated_steps: count });
}));

// Materialize template_steps -> steps on a show. Computes due_date from the
// show's event_date + the T-minus offset, then resolves depends_on_title to
// the freshly-created step id. Lanes the show's type does not declare are
// SKIPPED (not an error): the print template on a 'both' show still lands its
// print lanes, which is exactly what a combined event needs.
async function instantiateTemplateOnShow(c, templateId, show, project) {
  const tpl = (await c.query(
    'SELECT * FROM template_steps WHERE template_id=$1 ORDER BY sort_order ASC, id ASC',
    [templateId])).rows;
  if (!tpl.length) return 0;
  const allowed = await lanesForType(project ? project.type : 'led', c);
  const usable = tpl.filter((t) => allowed.includes(t.lane));
  const titleToId = {};
  let sort = 0;
  for (const ts of usable) {
    const due = (show.event_date && ts.due_offset_days != null)
      ? addDays(show.event_date, ts.due_offset_days) : '';
    const ins = await c.query(
      `INSERT INTO steps (show_id, lane, title, status, owner_role, due_date, due_offset_days,
         evidence_type, auto_source, sort_order)
       VALUES ($1,$2,$3,'todo',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [show.id, ts.lane, ts.title, ts.owner_role, due, ts.due_offset_days,
       ts.evidence_type || 'none', ts.auto_source || 'none', sort++]);
    titleToId[ts.title] = ins.rows[0].id;
  }
  for (const ts of usable) {
    if (ts.depends_on_title && titleToId[ts.depends_on_title]) {
      await c.query('UPDATE steps SET depends_on=$1 WHERE id=$2',
        [titleToId[ts.depends_on_title], titleToId[ts.title]]);
    }
  }
  return usable.length;
}

// ════════════════════════════════════════════════════════════════════════════
// ACTIVITY FEED (read; writes happen internally via logActivity)
// ════════════════════════════════════════════════════════════════════════════
router.get('/activity', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
  const showId = intOrNull(pick(req.query, 'show_id'));
  const projectId = intOrNull(pick(req.query, 'project_id'));
  const poId = intOrNull(pick(req.query, 'po_id'));
  // POLISH_LIST #5: a job's own history — job.create, budget.line.*, and the
  // job.number.confirm row that records the QuickBooks swap.
  const jobId = intOrNull(pick(req.query, 'job_id'));
  if (showId) add('show_id=$?', showId);
  if (projectId) add('project_id=$?', projectId);
  if (poId) add('po_id=$?', poId);
  if (jobId) add('job_id=$?', jobId);
  if (req.query.actor) add('actor=$?', req.query.actor);

  // ── F4. THE READ SHAPE THE CHANGELOG NEEDS ─────────────────────────────────
  // The table had 68 verbs, 128 writers and one buried per-show tab. These four
  // filters are what turn it into something a person can ask a question of.
  //
  //   ?since=ISO           everything after a timestamp — the "what changed
  //                        while I was on site" question
  //   ?action=show.update  one verb, or a family with a trailing dot
  //                        (?action=step. matches step.create/update/status/…)
  //   ?changed=1           ONLY rows carrying a before→after. This is the
  //                        changelog filter: it drops creates, reads and
  //                        bookkeeping and leaves the decisions.
  //   ?mine=1              scoped to the shows I am ON (audience membership),
  //                        which is the cross-project feed F4 asks for without
  //                        inventing a second table.
  const since = pick(req.query, 'since');
  if (since) {
    const d = new Date(String(since));
    if (isNaN(d.getTime())) throw badRequest('since must be an ISO timestamp');
    add('created_at > $?', d.toISOString());
  }
  const action = String(pick(req.query, 'action') || '').trim();
  if (action) {
    if (action.endsWith('.')) add('action LIKE $?', action + '%');
    else add('action=$?', action);
  }
  if (pick(req.query, 'changed') === '1' || pick(req.query, 'changed') === 'true') {
    where.push('changes IS NOT NULL');
  }
  if (pick(req.query, 'mine') === '1' || pick(req.query, 'mine') === 'true') {
    const ids = await showsIAmOn(req.session.username);
    // No shows means no feed — NOT "the whole company's feed". An empty answer
    // to "what changed on my shows" is the honest answer when you are on none.
    if (!ids.length) return res.json([]);
    params.push(ids);
    where.push(`show_id = ANY($${params.length}::int[])`);
  }

  let q = 'SELECT * FROM activity';
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  params.push(limitOf(req, 100, 500));
  q += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const r = await pool.query(q, params);
  res.json(r.rows.map(dbToActivity));
}));

// The inverse of lib/audience.showAudience(): which shows is THIS person on?
// Same four memberships, so "you are told about it" and "you can read about it"
// can never disagree.
async function showsIAmOn(username) {
  const u = String(username || '').trim();
  if (!u) return [];
  const r = await pool.query(
    `SELECT DISTINCT s.id FROM shows s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE LOWER(s.owner) = LOWER($1)
         OR LOWER(p.owner) = LOWER($1)
         OR EXISTS (SELECT 1 FROM steps st
                     WHERE st.show_id = s.id AND LOWER(st.owner) = LOWER($1))
         OR EXISTS (SELECT 1 FROM crew_assignments ca
                     WHERE ca.show_id = s.id AND LOWER(ca.username) = LOWER($1))`,
    [u]);
  return r.rows.map((x) => x.id);
}

// ════════════════════════════════════════════════════════════════════════════
// PUSH TO SCHEDULER  (Showrunner show -> the staffing app)
// ────────────────────────────────────────────────────────────────────────────
// The field mapping now lives in lib/scheduler.js — ONE builder feeding both
// paths, so the dry run shows byte-for-byte what the live push sends. That was
// the whole point of keeping the dry run: it is the field-by-field source of
// truth (SCHEMA.md's mapping table is generated from it).
//
// Punch H is RESOLVED, not flipped: the live path exists, but
//   · it is session-only. An agent key still gets a 403 by route topology
//     (AGENT_API §9 forbids publishing crew and bookings to an agent outright).
//   · it is pm+ AND canEditProject.
//   · with SCHEDULER_BASE_URL unset it is a 501 that names the missing var —
//     the default posture, so nobody turns it on by accident.
//   · it REFUSES rather than writes junk: no show name, no load-in date, or a
//     crew name that does not match the staffing roster all abort with 422
//     before a single byte crosses the wire (M6/M7/R23).
// The auth model is programmatic login + 401 retry, NOT a static token: the
// staffing app has no durable service credential and none is planned (§1.4.1,
// R1). SCHEDULER_API_TOKEN is retired.
// ════════════════════════════════════════════════════════════════════════════

router.post('/shows/:id/push-to-scheduler', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to push this show');

  const force = !!pick(req.body, 'force');
  if (show.scheduler_event_id && !force) {
    throw conflict('Show already pushed to scheduler', {
      schedulerEventId: show.scheduler_event_id,
      hint: 'Pass { "force": true } to re-push (updates the linked event).'
    });
  }
  // How this push treats children already on the event (Tom, 2026-09-03).
  // 'keep' is the default and the only value that needs no confirm: rows a
  // person entered in the staffing app are never touched. 'override' replaces
  // the event's children wholesale and is chosen FRESH each push — nothing here
  // remembers it. An unknown value is a 400, never a silent fallback: the
  // difference between the two is somebody's hand-entered itinerary.
  const mode = has(req.body, 'mode')
    ? oneOf(String(pick(req.body, 'mode') || '').trim(), PUSH_MODES, null)
    : 'keep';
  if (!mode) {
    throw badRequest(`unknown push mode "${pick(req.body, 'mode')}" — one of ${PUSH_MODES.join(', ')}`);
  }
  const steps = (await pool.query('SELECT * FROM steps WHERE show_id=$1', [show.id])).rows;
  const crew = (await pool.query('SELECT * FROM crew_assignments WHERE show_id=$1', [show.id])).rows;
  // The Showrunner roster, for the identity link: steps.owner and
  // crew_assignments.username are Showrunner handles, and the staffing app
  // knows people only by display name. users.staffing_name is how a person
  // whose two systems disagree still matches (lib/scheduler staffingNameFor).
  // Everyone, not the working roster: somebody deactivated last week can still
  // be the owner of a step on a show that is being pushed today.
  //
  // THREE COLUMNS, not `SELECT *`. The resolver needs exactly these, and the
  // dry run echoes its payloads back to the caller — so a row that never
  // carried password_hash into this function cannot ever be leaked out of it by
  // some later refactor that decides to include the roster in the response.
  const users = (await pool.query(
    'SELECT username, name, staffing_name FROM users')).rows;

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  // Shows EXACTLY what live would send, including the travel legs that used to
  // be missing entirely (M4). When the scheduler is reachable it also resolves
  // crew names against the real roster so the operator sees the M6 problems
  // here rather than discovering them mid-push.
  if (!pick(req.body, 'live')) {
    let roster = null;
    let rosterNote = 'Crew names are NOT canonicalized in this dry run — the scheduler is not ' +
                     'configured, so GET /api/roster could not be consulted (M6).';
    if (schedulerCredentialed()) {
      try { roster = await fetchRoster(); rosterNote = `Crew names checked against ${roster.length} roster rows.`; }
      catch (e) { rosterNote = 'Roster lookup failed, so crew names are unchecked: ' + e.message; }
    }
    const payloads = buildSchedulerPayloads(project, show, steps, crew,
      { roster, users, eventId: show.scheduler_event_id || null });
    const problems = validateForPush(project, show, payloads, roster);
    const base = process.env.SCHEDULER_BASE_URL || '<SCHEDULER_BASE_URL>';
    return res.json({
      dryRun: true,
      note: 'No data sent. This is byte-for-byte what { "live": true } would send.',
      ready: problems.length === 0,
      problems,
      rosterNote,
      linkedEventId: show.scheduler_event_id || null,
      targets: {
        auth: 'POST ' + base + '/api/auth/login  (programmatic, 11h token cache, 401-retry)',
        event: (show.scheduler_event_id ? 'PUT ' : 'POST ') + base + '/api/events' +
               (show.scheduler_event_id ? '/' + show.scheduler_event_id + '  (read-modify-write)' : ''),
        bookings: `POST /api/bookings  ×${payloads.bookings.length}`,
        venueContacts: `POST /api/venue-contacts  ×${payloads.venueContacts.length}`,
        clientContacts: `POST /api/client-contacts  ×${payloads.clientContacts.length}`,
        travel: `POST /api/travel  ×${payloads.travel.length}  (upsert on travel_key)`,
        childCleanup: mode === 'override'
          ? 'DELETE every booking / venue contact / client contact on the event first — ' +
            'override replaces hand-entered staffing rows too'
          : 'DELETE the child ids recorded in shows.pushed_child_ids first (M8) — ' +
            'rows entered by hand in the staffing app are never touched'
      },
      payloads
    });
  }

  // ── F5. THE CONFIRM GATE — on the LIVE path only ─────────────────────────
  // Tom: "Confirming is the natural trigger moment for … scheduler-push
  // unlock." Publishing crew and travel to the staffing app commits real
  // people's calendars, so it waits for the client to have committed too.
  //
  // It sits HERE and not above the dry run on purpose. A dry run sends nothing;
  // its entire job is to tell you what is wrong before you commit, and refusing
  // to run the diagnostic that would have explained the refusal is the classic
  // way to make a gate feel like a bug. The dry run therefore REPORTS
  // "not confirmed" among its problems (lib/scheduler validateForPush) and
  // reports ready:false; the live push is the one that says no.
  //
  // Additive-safe by construction: isConfirmed() answers YES for an explicit
  // confirm datestamp OR for any stage at or past 'confirmed' on the lifecycle,
  // which covers every legacy 'planning' / 'ready' / 'scheduled' / 'closed' row
  // already in the database. Only a genuinely pre-commitment show ('lead' /
  // 'quoted') is refused, and the refusal says exactly what to do about it.
  if (!isConfirmed(show)) {
    throw conflict(
      'This show is not confirmed yet, so it cannot be pushed to the scheduler. ' +
      'Confirm it first — that records who committed and when, and it is the moment ' +
      'to swap a TEMP job number for the real QuickBooks one.',
      { stage: show.stage, stageCanonical: canonicalStage(show.stage),
        confirmEndpoint: `POST /api/shows/${show.id}/confirm` });
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  if (!schedulerConfigured()) {
    return res.status(501).json({
      error: 'Live push to the scheduler is not configured.',
      hint: 'Set SCHEDULER_BASE_URL (see .env.example), plus SCHEDULER_USER / SCHEDULER_PASS for the ' +
            "dedicated 'showrunner' service account in the staffing app. SCHEDULER_API_TOKEN is retired — " +
            'staffing sessions are in-memory with a 12h TTL, so a static token is dead within hours ' +
            '(INTEGRATIONS_SPEC.md §1.4.1).'
    });
  }

  const result = await pushShowToScheduler({
    project, show, steps, crew, users, mode,
    tracked: show.pushed_child_ids || null,
    // Persist the link the MOMENT the event exists. The fan-out is resumable,
    // not atomic (§2.7): a failure past this point leaves a linked, partly
    // populated event that a retry repairs, not an orphan a retry duplicates.
    onEventId: async (eventId) => {
      await pool.query(
        'UPDATE shows SET scheduler_event_id=$1, scheduler_pushed_at=NOW(), updated_at=NOW() WHERE id=$2',
        [eventId, show.id]);
    }
  });

  await withTx(async (c) => {
    await c.query(
      `UPDATE shows SET scheduler_event_id=$1, pushed_child_ids=$2::jsonb, stage=$3,
         scheduler_pushed_at=NOW(), scheduler_pushed_by=$4, updated_at=NOW() WHERE id=$5`,
      [result.eventId, JSON.stringify(result.tracked),
       show.stage === 'closed' ? show.stage : 'scheduled', req.actor, show.id]);
    await logActivity(c, {
      projectId: project.id, showId: show.id, actor: req.actor,
      action: 'scheduler.push',
      detail: `${result.created ? 'created' : 'updated'} staffing event #${result.eventId} — ` +
              `${result.counts.bookings} bookings, ${result.counts.venueContacts} venue contacts, ` +
              `${result.counts.clientContacts} client contacts, ${result.counts.travel} travel legs` +
              // The mode is part of the record: an override that removed
              // somebody's hand-entered rows must be answerable from the trail.
              (result.created ? '' : result.mode === 'override'
                ? ' · mode override — replaced the event’s existing children'
                : ' · mode keep — hand-entered staffing rows untouched'),
      accent: true
    });
  });

  res.json({
    ok: true,
    dryRun: false,
    schedulerEventId: result.eventId,
    created: result.created,
    mode: result.mode,
    clientId: result.clientId,
    counts: result.counts,
    removed: result.removed,
    crewNames: result.crewNames,
    deepLink: `${process.env.SCHEDULER_BASE_URL.replace(/\/+$/, '')}/?event=${result.eventId}`
  });
}));

// ════════════════════════════════════════════════════════════════════════════
// LINK TO AN EXISTING STAFFING EVENT  (Tom, 2026-09-02: "we get the choice to
// start a new event or integrate into an already started one")
// ────────────────────────────────────────────────────────────────────────────
// The push above CREATES an event when the show is unlinked. These three routes
// are the other arm of the choice: list the staffing app's events, bind one to
// the show, and undo the binding. The binding itself is purely local —
// scheduler_event_id plus the push-ledger columns — so linking sends nothing
// and unlinking deletes nothing remote. Only a subsequent push writes.
// ════════════════════════════════════════════════════════════════════════════

// The honest 501, ANSWERED rather than thrown — same device as the live push
// above, so a deliberate "not configured yet" never prints a stack trace as if
// the server had failed. The message still names the exact env vars to set.
function schedulerUnconfigured501(res) {
  return res.status(501).json({
    error: schedulerNotConfigured(
      schedulerConfigured() ? 'SCHEDULER_USER / SCHEDULER_PASS' : 'SCHEDULER_BASE_URL').message
  });
}

// GET /api/scheduler/events — the candidate list for the "Link to existing
// event" picker. pm+, same floor as the push; proxied so the browser never
// needs staffing credentials. Unconfigured ⇒ the same honest 501 as the push.
router.get('/scheduler/events', requireRole('pm'), asyncH(async (req, res) => {
  if (!schedulerCredentialed()) return schedulerUnconfigured501(res);
  res.json(await fetchSchedulerEvents());
}));

// POST /api/shows/:id/scheduler-link  { event_id } — bind the show to an event
// that already exists in the staffing app. The next push goes INTO that event
// (read-modify-write PUT + child sync) instead of creating one.
router.post('/shows/:id/scheduler-link', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to link this show');
  if (!schedulerCredentialed()) return schedulerUnconfigured501(res);

  const eventId = intOrNull(pick(req.body, 'event_id'));
  if (!eventId || eventId <= 0) throw badRequest('event_id (a staffing event id) is required');
  // Re-binding a linked show silently would orphan the push ledger for the old
  // event; the unlink affordance exists precisely so this stays a two-step,
  // eyes-open act.
  if (show.scheduler_event_id && Number(show.scheduler_event_id) !== eventId) {
    throw conflict(`This show is already linked to staffing event #${show.scheduler_event_id}.`, {
      hint: 'Unlink first (DELETE /api/shows/:id/scheduler-link), then link the new event.'
    });
  }
  // The id must name a real event NOW — a stale picker or a typo becomes a 400
  // here rather than a half-bound show whose next push 404s mid-fan-out.
  const events = await fetchSchedulerEvents();
  const ev = events.find((e) => Number(e.id) === eventId);
  if (!ev) {
    throw badRequest(`Staffing event #${eventId} does not exist (it may have been deleted) — ` +
                     'refresh the event list and pick again.');
  }

  const updated = await withTx(async (c) => {
    // A fresh binding starts with an EMPTY push ledger: nothing in that event
    // is ours yet, so the first push's delete pass has nothing to delete and
    // every row already there — a human's — survives by construction.
    const r = await c.query(
      `UPDATE shows SET scheduler_event_id=$1, pushed_child_ids=NULL,
         scheduler_pushed_at=NULL, scheduler_pushed_by=NULL, updated_at=NOW()
       WHERE id=$2 RETURNING *`, [eventId, show.id]);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'scheduler.link', accent: true,
      detail: `linked to staffing event #${eventId} — ${ev.name || 'unnamed'}` +
              (ev.eventDate ? ` (${ev.eventDate})` : '')
    });
    return r.rows[0];
  });

  res.json({ ok: true, show: await hydrateShow(updated), event: ev });
}));

// DELETE /api/shows/:id/scheduler-link — clear the binding. LOCAL ONLY: the
// staffing event and every row on it stay exactly as they are (the rows this
// show pushed included — they are real bookings someone may be relying on).
// Afterwards the push offers the create-vs-link choice again. Works with the
// integration unconfigured, because it touches nothing remote.
router.delete('/shows/:id/scheduler-link', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to unlink this show');
  if (!show.scheduler_event_id) {
    throw conflict('This show is not linked to a staffing event.', {
      hint: 'Nothing to unlink — the next push will offer create-new or link-existing.'
    });
  }
  const oldEventId = show.scheduler_event_id;

  const updated = await withTx(async (c) => {
    // The ledger goes with the binding: those child ids belong to the OLD
    // event, and a later push into a different event must not reach back and
    // delete rows there.
    const r = await c.query(
      `UPDATE shows SET scheduler_event_id=NULL, pushed_child_ids=NULL,
         scheduler_pushed_at=NULL, scheduler_pushed_by=NULL, updated_at=NOW()
       WHERE id=$1 RETURNING *`, [show.id]);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'scheduler.unlink', accent: true,
      detail: `unlinked from staffing event #${oldEventId} — nothing was deleted in the staffing app`
    });
    return r.rows[0];
  });

  res.json({ ok: true, show: await hydrateShow(updated), unlinkedEventId: oldEventId });
}));

module.exports = router;
module.exports.instantiateTemplateOnShow = instantiateTemplateOnShow;
module.exports.buildSchedulerPayloads = buildSchedulerPayloads;
module.exports.deriveBookingCategory = deriveBookingCategory;
module.exports.mapEventType = mapEventType;
module.exports.hydrateProject = hydrateProject;
module.exports.hydrateShow = hydrateShow;
module.exports.notifyTargets = notifyTargets;
