// ════════════════════════════════════════════════════════════════════════════
// routes/deliverables.js — the post-event CLIENT RECAP (punch items 49–54)
// ────────────────────────────────────────────────────────────────────────────
// THE HUMAN SURFACE ONLY. Mounted at /api, behind requireAuth, which refuses
// any request carrying an x-agent-key header (lib/auth.js). That is punch item
// 53 as a topology fact rather than a promise:
//
//   53. deliverables are DELIBERATELY ABSENT from /api/agent/*. No agent-key
//       path may create, edit, approve or send one. This module exports ONE
//       thing — an express.Router() for the human API — so the agent router
//       has nothing here it could mount even by accident. Every write below
//       also calls assertHuman() as belt and braces.
//
// Why this module is the paranoid one: a recap is the single artifact in the
// app that LEAVES the building. Two firewall layers from lib/firewall.js hold:
//
//   A · ONE SOURCE. The generator reads recapFacts(q, show) and NOTHING else.
//       There is no SELECT in this file against expenses, bookings,
//       purchase_orders, jobs, budget_lines, notes, step notes, activity
//       detail or schedule free text — and there must never be one. If a
//       future body field seems to need such a read, that is a firewall
//       violation, not a missing query: widen RECAP_SOURCES in lib/firewall.js
//       deliberately, where a reviewer has one place to look, or leave a
//       comment. The route's own SELECTs are limited to: the deliverable row,
//       the show/project rows (loadShow/loadProject), photo file rows for the
//       strip, and recap_stat_keys — none of which carries a money value.
//
//   B · ONE TEXT GATE. recapUnsafe() runs over EVERY hand-typed string on the
//       PUT, and a trip is a 400 that names what tripped it. A human who
//       pastes a dollar figure into the narrative is REFUSED with the reason,
//       never silently scrubbed. (The generator's own strings went through
//       recapSafe() inside buildRecapDraft() — drop, not reject.)
//
// 52. Generation is a pm+ SESSION route that runs AS THE OWNER'S AGENT:
//     generated_by = 'agent:<show.owner>', provenance from recapProvenance()
//     with source_kind 'closeout' (item 50), and the activity row is attributed
//     to the agent with accent = true.
//
// 51. deliverables.kind is the extension point — 'recap' is implemented here;
//     'call_sheet' and 'photo_set' get their own generators later and are
//     already listable through GET /shows/:id/deliverables?kind=…
//
// Shapes: responses are snake_case records via lib/mappers (public/api.js is
// the behavioural spec and its error strings are reproduced verbatim); request
// bodies accept snake_case OR camelCase via pick()/the key normaliser below.
// `body` is JSONB — always written with JSON.stringify in the parameter list.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');

const { pool, withTx, loadShow, loadProject } = require('../lib/db');
const { asyncH, badRequest, forbidden, notFound, conflict, idParam, limitOf } = require('../lib/http');
const { requireAuth, canApproveRecap, roleRank } = require('../lib/auth');
const { pick, dbToDeliverable, dbToFile } = require('../lib/mappers');
const { DELIVERABLE_KINDS, DELIVERABLE_STATUSES, RECAP_STAT_KEYS, ROLE_RANK } = require('../lib/enums');
const { recapUnsafe, recapFacts, buildRecapDraft, recapProvenance } = require('../lib/firewall');
const { logActivity } = require('../lib/activity');

const router = express.Router();

// Session auth on EVERY route below — and applied per route, never with
// router.use(). This router shares the /api mount point with the others, and a
// router-level guard here would 401 (or, on an x-agent-key, 403) requests that
// merely pass through on their way to a later router — including /api/agent/*.
// requireAuth itself 403s an x-agent-key outright (AGENT_API §9 route
// topology), which is half of item 53 on its own.

// ════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ════════════════════════════════════════════════════════════════════════════

// 53, belt and braces. requireAuth already rejected the agent key; this is the
// assertion a future refactor would have to delete on purpose.
function assertHuman(req) {
  if (req.session && req.session.isAgent) {
    throw forbidden('a client recap is drafted, approved and sent by a person — never by an agent key');
  }
}

// The recap on a show. There is no UNIQUE (show_id, kind) constraint, so the
// newest row wins — the same "last one" the client prototype resolves.
async function recapForShow(showId, q = pool) {
  const r = await q.query(
    `SELECT * FROM deliverables WHERE show_id=$1 AND kind='recap' ORDER BY id DESC LIMIT 1`,
    [showId]
  );
  return r.rows[0] || null;
}
async function recapById(id, q = pool) {
  const r = await q.query(`SELECT * FROM deliverables WHERE id=$1 AND kind='recap'`, [id]);
  return r.rows[0] || null;
}

// PUT/approve/reopen/sent are each reachable two ways — /shows/:id/recap… and
// /recaps/:id… — because public/api.js documents `/api/recaps/:id` but calls
// it as updateRecap(showId, patch). ONE handler serves both so the front-end
// swap is mechanical whichever spelling the caller picked.
async function context(req, by, q = pool) {
  const id = idParam(req);
  let show = null;
  let rec = null;
  if (by === 'show') {
    show = await loadShow(id, q);
    if (!show) throw notFound('show ' + id + ' not found');
    rec = await recapForShow(show.id, q);
  } else {
    rec = await recapById(id, q);
    if (!rec) throw notFound('recap ' + id + ' not found');
    show = await loadShow(rec.show_id, q);
    if (!show) throw notFound('show ' + rec.show_id + ' not found');
  }
  const project = await loadProject(show.project_id, q);
  return { show, project, rec };
}

// pm+ AND the SHOW-owner gate — the same predicate the Approve path uses.
//
// SETTLED 2026-08-27 (Tom): a closeout belongs to the SHOW's owner. Drafting is
// the show's owner plus manager/admin as cover; approving is the same set. One
// decision, one expression — canApproveRecap() in lib/auth.js is that
// expression, and both paths now call it.
//
// This gate used to key off canEditProject (the PROJECT's owner) while approve
// keyed off SHOW.owner. Because a show can carry a different owner from its
// project, that let a show-owning pm APPROVE a recap he was forbidden to DRAFT,
// and an admin's draft of it was still credited to `agent:<show.owner>` — the
// agent of the one person the gate had just turned away. Approving is the
// higher-privilege act, so that ordering was backwards.
//
// Attribution is unchanged and is now coherent with the gate: generate() sets
// generated_by = 'agent:' + show.owner, which is the person who may draft it.
//
// SETTLED — HARDENING 14 (2026-08-27). The gap this note used to record is
// closed: the pm+ floor moved INTO canApproveRecap(), so the draft path and the
// approve path are now the same expression and cannot disagree for any role.
// Previously the floor lived only here, which let a sub-pm show owner approve a
// recap he could not draft.
//
// The rank check below is NO LONGER A SECOND DECISION — canApproveRecap already
// refuses anyone below pm. It survives only to pick the SHARPER MESSAGE: "you
// are not senior enough" reads better than "you do not own this show" when the
// caller is a tech, and the two answers are otherwise indistinguishable to the
// person reading them. Both branches derive from ROLE_RANK.pm, so they cannot
// drift apart.
function assertCanDraft(session, show, verb) {
  if (roleRank(session && session.role) < ROLE_RANK.pm) {
    throw forbidden(verb + ' requires pm, manager or admin');
  }
  if (!canApproveRecap(session, show)) {
    throw forbidden(verb + ' on this show requires manager, admin — or the show’s own owner');
  }
}

// LAYER B, the throwing form. The message shape is public/api.js verbatim,
// curly quotes included.
function guard(value, where) {
  const u = recapUnsafe(value);
  if (u) {
    throw badRequest(where + ' cannot carry ' + u.why + ' (“' + u.match + '”) — a recap is client-facing');
  }
}

const isArray = (v) => Array.isArray(v);
const trimmed = (v) => String(v == null ? '' : v).trim();

// 54. the client-safe stat vocabulary, read from its table (the FK) with the
// canonical enum as the fallback for a database whose seed has not run yet.
async function statKeySet(q = pool) {
  try {
    const r = await q.query('SELECT key FROM recap_stat_keys');
    if (r.rows.length) return new Set(r.rows.map((x) => x.key));
  } catch (_) { /* table missing on a half-migrated db — fall through */ }
  return new Set(RECAP_STAT_KEYS);
}

// Mirrors the client's _noteShowLabel(): a project holding a single show is
// named by the project, otherwise by the show. Reads projects.name (already in
// RECAP_SOURCES.project) plus a row COUNT — no free text, and the result goes
// to provenance.source_label ONLY. It never reaches the recap body.
async function showLabel(show, project, q = pool) {
  const r = await q.query('SELECT COUNT(*)::int AS n FROM shows WHERE project_id=$1', [show.project_id]);
  const single = r.rows[0] && r.rows[0].n === 1;
  return (single && project && project.name) ? project.name
    : (show.name || (project && project.name) || ('show ' + show.id));
}

// ════════════════════════════════════════════════════════════════════════════
// READS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/deliverables — every deliverable on the show.
// 51. `kind` is the extension point, so it is a filter, not a hardcode.
router.get('/shows/:id/deliverables', requireAuth, asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('show ' + showId + ' not found');

  const kind = req.query.kind ? String(req.query.kind) : null;
  if (kind && !DELIVERABLE_KINDS.includes(kind)) throw badRequest(`"${kind}" is not a deliverable kind`);
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !DELIVERABLE_STATUSES.includes(status)) throw badRequest(`"${status}" is not a deliverable status`);

  const r = await pool.query(
    `SELECT * FROM deliverables
     WHERE show_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR status=$3)
     ORDER BY id ASC`,
    [show.id, kind, status]
  );
  res.json(r.rows.map(dbToDeliverable));
}));

// GET /api/shows/:id/recap — the recap, hydrated with its photo strip.
//   photos: the file rows named by body.photo_ids, IN THAT ORDER (the strip is
//           human-ordered, so the array order is the data).
//   pool:   filed photos on this show that the recap is NOT carrying — the
//           "add it back" affordance, so removing a photo is never one-way.
router.get('/shows/:id/recap', requireAuth, asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('show ' + showId + ' not found');

  const rec = await recapForShow(show.id);
  if (!rec) return res.json(null);

  const ids = ((rec.body && rec.body.photo_ids) || []).map(Number).filter(Number.isFinite);

  let photos = [];
  if (ids.length) {
    const r = await pool.query(
      `SELECT * FROM files WHERE id = ANY($1::int[]) AND show_id=$2 AND kind='photo'`,
      [ids, show.id]
    );
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    photos = ids.map((id) => byId.get(id)).filter(Boolean).map(dbToFile);
  }

  // taken_at order = the chronology the strip and the generator both use.
  const poolR = await pool.query(
    `SELECT * FROM files
     WHERE show_id=$1 AND kind='photo' AND status='filed' AND NOT (id = ANY($2::int[]))
     ORDER BY taken_at ASC NULLS LAST, id ASC`,
    [show.id, ids]
  );

  res.json({ ...dbToDeliverable(rec), photos, pool: poolR.rows.map(dbToFile) });
}));

// GET /api/me/recaps-awaiting-review — draft recaps THIS person is the one to
// act on. Same canApproveRecap() predicate as the Approve button, so the bell
// and the button can never disagree ("you see what you can act on").
router.get('/me/recaps-awaiting-review', requireAuth, asyncH(async (req, res) => {
  const r = await pool.query(
    `SELECT d.*, s.name AS s_name, s.venue AS s_venue, s.owner AS s_owner, s.event_date AS s_event_date
     FROM deliverables d JOIN shows s ON s.id = d.show_id
     WHERE d.kind='recap' AND d.status='draft'
     ORDER BY d.generated_at DESC, d.id DESC
     LIMIT $1`,
    [limitOf(req, 100, 500)]
  );
  const out = [];
  for (const row of r.rows) {
    // ONE predicate, evaluated per row rather than compiled into SQL — the
    // manager+/owner rule lives in lib/auth.js and nowhere else.
    if (!canApproveRecap(req.session, { owner: row.s_owner })) continue;
    out.push({
      ...dbToDeliverable(row),
      show_name: row.s_name || '',
      show_venue: row.s_venue || '',
      show_owner: row.s_owner || '',
      event_date: row.s_event_date || ''
    });
  }
  res.json(out);
}));

// GET /api/recap-stat-keys — 54. the client-safe stat vocabulary, by FK.
// Seeded by lib/seed.js from enums.RECAP_STAT_KEYS.
router.get('/recap-stat-keys', requireAuth, asyncH(async (req, res) => {
  const r = await pool.query('SELECT key, label, sort_order FROM recap_stat_keys ORDER BY sort_order ASC, key ASC');
  res.json(r.rows.map((x) => ({ key: x.key, label: x.label, sort_order: x.sort_order || 0 })));
}));

// ════════════════════════════════════════════════════════════════════════════
// 52. GENERATE — pm+ session route, running as the OWNER'S agent
// ════════════════════════════════════════════════════════════════════════════
// Idempotent by construction: buildRecapDraft() is pure over recapFacts(), so
// regenerating an untouched show produces the same body. A DRAFT is replaced IN
// PLACE (same row, edited_by/edited_at cleared — a regenerate discards human
// edits on purpose); an approved or sent recap is refused.
router.post('/shows/:id/recap', requireAuth, asyncH(async (req, res) => {
  assertHuman(req);
  const showId = idParam(req);

  const out = await withTx(async (c) => {
    const show = await loadShow(showId, c);
    if (!show) throw notFound('show ' + showId + ' not found');
    const project = await loadProject(show.project_id, c);

    assertCanDraft(req.session, show, 'drafting a client recap');

    const existing = await recapForShow(show.id, c);
    if (existing && existing.status !== 'draft') {
      throw conflict('this recap is already ' + existing.status + ' — reopen it before regenerating');
    }

    // ── FIREWALL LAYER A ────────────────────────────────────────────────────
    // These two lines are the ENTIRE reading surface of the generator. Nothing
    // else in this handler feeds the body. Do not add a SELECT here.
    const facts = await recapFacts(c, show);
    const body = buildRecapDraft(facts);

    // The recap is drafted BY THE OWNER'S AGENT, not by whoever clicked. A show
    // with no owner yet falls back to the acting session so attribution is
    // never the literal string 'agent:'.
    const agentUser = show.owner || req.session.username;
    const prov = recapProvenance(show, agentUser, await showLabel(show, project, c));
    const actor = 'agent:' + agentUser;

    let row;
    if (existing) {
      const r = await c.query(
        `UPDATE deliverables
           SET body=$2, generated_by=$3, generated_at=NOW(),
               edited_by=NULL, edited_at=NULL, provenance=$4
         WHERE id=$1 RETURNING *`,
        [existing.id, JSON.stringify(body), actor, JSON.stringify(prov)]
      );
      row = r.rows[0];
    } else {
      const r = await c.query(
        `INSERT INTO deliverables
           (project_id, show_id, kind, status, body, generated_by, generated_at, provenance)
         VALUES ($1,$2,'recap','draft',$3,$4,NOW(),$5) RETURNING *`,
        [show.project_id, show.id, JSON.stringify(body), actor, JSON.stringify(prov)]
      );
      row = r.rows[0];
    }

    await logActivity(c, {
      projectId: show.project_id,
      showId: show.id,
      actor,                               // 22. the UI renders "Tom's agent"
      action: (existing ? 'regenerated' : 'drafted') + ' the post-event client recap',
      detail: (body.highlights || []).length + ' highlights · ' +
              (body.photo_ids || []).length + ' photos · awaiting review',
      accent: true,
      provenance: prov
    });

    return row;
  });

  res.json(dbToDeliverable(out));
}));

// ════════════════════════════════════════════════════════════════════════════
// EDIT — pm+, draft only, every string through the firewall
// ════════════════════════════════════════════════════════════════════════════

// The ONLY six sections a body carries. Anything else is a 400, not a silent
// pass-through into JSONB.
const RECAP_SECTIONS = ['headline', 'narrative', 'highlights', 'stats', 'photo_ids', 'closing'];
const SECTION_SET = new Set(RECAP_SECTIONS);
const SECTION_LABEL = {
  headline: 'headline', narrative: 'narrative', highlights: 'highlights',
  stats: 'stats', photo_ids: 'photos', closing: 'closing'
};
// 'photoIds' -> 'photo_ids'. Request bodies accept both spellings (mappers.js
// house rule); the stored body is snake_case, always.
function snakeKey(k) { return String(k).replace(/([A-Z])/g, (_, c) => '_' + c.toLowerCase()); }

function updateRecapHandler(by) {
  return asyncH(async (req, res) => {
    assertHuman(req);

    const out = await withTx(async (c) => {
      const { show, project, rec } = await context(req, by, c);
      if (!rec) throw notFound('no recap on this show yet — generate one first');

      assertCanDraft(req.session, show, 'editing a client recap');
      if (rec.status !== 'draft') throw conflict('this recap is ' + rec.status + ' — reopen it to edit');

      // ── the allowed-key gate ────────────────────────────────────────────
      const raw = (req.body && typeof req.body === 'object') ? req.body : {};
      const patch = {};
      for (const key of Object.keys(raw)) {
        const k = snakeKey(key);
        if (!SECTION_SET.has(k)) throw badRequest('"' + key + '" is not a recap section');
        patch[k] = raw[key];
      }
      if (!Object.keys(patch).length) {
        throw badRequest('nothing to edit — send at least one recap section');
      }

      // ── FIREWALL LAYER B + shape validation, in public/api.js's order ────
      if (patch.headline !== undefined) {
        if (!trimmed(patch.headline)) throw badRequest('a recap needs a headline');
        guard(patch.headline, 'The headline');
      }
      if (patch.closing !== undefined) {
        if (!trimmed(patch.closing)) throw badRequest('a recap needs a closing');
        guard(patch.closing, 'The closing');
      }
      if (patch.narrative !== undefined) {
        if (!isArray(patch.narrative) || !patch.narrative.length) {
          throw badRequest('the narrative must be at least one paragraph');
        }
        patch.narrative.forEach((p, i) => guard(p, 'Paragraph ' + (i + 1)));
      }
      if (patch.highlights !== undefined) {
        if (!isArray(patch.highlights)) throw badRequest('highlights must be a list');
        patch.highlights.forEach((h, i) => guard(h, 'Highlight ' + (i + 1)));
      }
      if (patch.stats !== undefined) {
        if (!isArray(patch.stats)) throw badRequest('stats must be a list');
        // 54. a stat's KEY is checked against recap_stat_keys — a closed,
        // client-safe vocabulary by FK. The label and value still go through
        // the text gate, because a human types those.
        const keys = await statKeySet(c);
        patch.stats.forEach((st, i) => {
          const where = 'Stat ' + (i + 1);
          if (!st || typeof st !== 'object' || isArray(st)) throw badRequest(where + ' needs a label');
          if (!trimmed(st.label)) throw badRequest(where + ' needs a label');
          if (st.key !== undefined && st.key !== null && st.key !== '' && !keys.has(String(st.key))) {
            throw badRequest(where + '’s key “' + st.key + '” is not a client-safe stat key');
          }
          guard(st.label, where + '’s label');
          guard(st.value, where + '’s value');
        });
      }
      if (patch.photo_ids !== undefined) {
        if (!isArray(patch.photo_ids)) throw badRequest('photo_ids must be a list');
        const ids = patch.photo_ids.map(Number);
        if (ids.some((n) => !Number.isFinite(n))) {
          throw badRequest('a recap can only carry filed photos from this show');
        }
        if (ids.length) {
          // Photo rows only — no caption/tag free text is trusted here beyond
          // what the photos routes already gated; this check is about identity.
          const r = await c.query(
            `SELECT id FROM files WHERE id = ANY($1::int[]) AND show_id=$2 AND kind='photo' AND status='filed'`,
            [ids, show.id]
          );
          const okIds = new Set(r.rows.map((x) => x.id));
          if (!ids.every((id) => okIds.has(id))) {
            throw badRequest('a recap can only carry filed photos from this show');
          }
        }
      }

      // ── write ───────────────────────────────────────────────────────────
      const body = { ...(rec.body || {}) };
      for (const k of Object.keys(patch)) {
        if (k === 'photo_ids') {
          body[k] = patch[k].map(Number);
        } else if (k === 'narrative' || k === 'highlights') {
          body[k] = patch[k].map(trimmed).filter(Boolean);
        } else if (k === 'stats') {
          body[k] = patch[k].map((st) => {
            const out2 = {};
            // preserve the FK when the client sent one; never invent one
            if (st.key !== undefined && st.key !== null && st.key !== '') out2.key = String(st.key);
            out2.label = trimmed(st.label);
            out2.value = trimmed(st.value);
            return out2;
          });
        } else {
          body[k] = trimmed(patch[k]);
        }
      }

      const r = await c.query(
        `UPDATE deliverables SET body=$2, edited_by=$3, edited_at=NOW() WHERE id=$1 RETURNING *`,
        [rec.id, JSON.stringify(body), req.session.username]
      );

      const sections = Object.keys(patch).map((k) => SECTION_LABEL[k]).join(', ');
      await logActivity(c, {
        projectId: show.project_id,
        showId: show.id,
        actor: req.session.username,
        action: 'edited the client recap draft',
        detail: sections
      });

      return r.rows[0];
    });

    res.json(dbToDeliverable(out));
  });
}
// api.js's doc comment names PUT /api/recaps/:id; its call signature is
// updateRecap(showId, patch). Both are wired to the same handler.
router.put('/recaps/:id', requireAuth, updateRecapHandler('recap'));
router.put('/shows/:id/recap', requireAuth, updateRecapHandler('show'));

// ════════════════════════════════════════════════════════════════════════════
// APPROVE / REOPEN — SESSION ONLY (item 53), manager+ or the show's own owner
// ════════════════════════════════════════════════════════════════════════════
function approveHandler(by) {
  return asyncH(async (req, res) => {
    assertHuman(req);

    const out = await withTx(async (c) => {
      const { show, rec } = await context(req, by, c);
      if (!rec) throw notFound('no recap on this show yet');
      if (rec.status !== 'draft') throw conflict('this recap is already ' + rec.status);
      if (!canApproveRecap(req.session, show)) {
        throw forbidden('approving a client recap requires manager, admin — or the show’s own pm+ owner');
      }

      const r = await c.query(
        `UPDATE deliverables SET status='approved', approved_by=$2, approved_at=NOW()
         WHERE id=$1 RETURNING *`,
        [rec.id, req.session.username]
      );
      await logActivity(c, {
        projectId: show.project_id,
        showId: show.id,
        actor: req.session.username,
        action: 'approved the client recap',
        detail: 'locked for send — a human sends it, never the agent',
        accent: true
      });
      return r.rows[0];
    });

    res.json(dbToDeliverable(out));
  });
}
router.post('/recaps/:id/approve', requireAuth, approveHandler('recap'));
router.post('/shows/:id/recap/approve', requireAuth, approveHandler('show'));

function reopenHandler(by) {
  return asyncH(async (req, res) => {
    assertHuman(req);

    const out = await withTx(async (c) => {
      const { show, rec } = await context(req, by, c);
      if (!rec) throw notFound('no recap on this show yet');
      // A sent recap is a RECORD of what went to the client. Reopening it would
      // rewrite history, so it is refused outright — regenerate is not a thing
      // you do to something that already left the building.
      if (rec.status === 'sent') throw badRequest('this recap has been sent — that is a record, not a draft');
      if (rec.status !== 'approved') throw conflict('this recap is already a draft');
      if (!canApproveRecap(req.session, show)) {
        throw forbidden('reopening an approved recap requires manager, admin — or the show’s own pm+ owner');
      }

      const r = await c.query(
        `UPDATE deliverables SET status='draft', approved_by=NULL, approved_at=NULL
         WHERE id=$1 RETURNING *`,
        [rec.id]
      );
      await logActivity(c, {
        projectId: show.project_id,
        showId: show.id,
        actor: req.session.username,
        action: 'reopened the client recap for edits',
        detail: 'back to draft'
      });
      return r.rows[0];
    });

    res.json(dbToDeliverable(out));
  });
}
router.post('/recaps/:id/reopen', requireAuth, reopenHandler('recap'));
router.post('/shows/:id/recap/reopen', requireAuth, reopenHandler('show'));

// ════════════════════════════════════════════════════════════════════════════
// MARK SENT — A MOCK THAT RECORDS A HUMAN'S SEND
// ────────────────────────────────────────────────────────────────────────────
// THIS ENDPOINT SENDS NOTHING. There is no outbound path anywhere in this app:
// not for an agent (AGENT_API §9 — "Any outbound send: no such endpoint exists
// on the agent surface"; the agent's own M365 MCP send tools are the human's
// business, not the app's) and not for a person either. A human copies the
// approved recap out through their own mail client and then records here that
// they did it. The response says so out loud so no caller can mistake a 200 for
// a delivery receipt.
// ════════════════════════════════════════════════════════════════════════════
function markSentHandler(by) {
  return asyncH(async (req, res) => {
    assertHuman(req);

    const out = await withTx(async (c) => {
      const { show, project, rec } = await context(req, by, c);
      if (!rec) throw notFound('no recap on this show yet');
      if (rec.status !== 'approved') {
        throw conflict(rec.status === 'sent'
          ? 'this recap is already marked sent'
          : 'only an approved recap can be marked sent — approve it first');
      }
      assertCanDraft(req.session, show, 'recording a send');

      const poc = show.client_poc && show.client_poc.name ? show.client_poc.name : '';
      const to = trimmed(pick(req.body || {}, 'sent_to') || poc || (project && project.client) || 'the client');

      const r = await c.query(
        `UPDATE deliverables SET status='sent', sent_to=$2, sent_at=NOW() WHERE id=$1 RETURNING *`,
        [rec.id, to]
      );
      await logActivity(c, {
        projectId: show.project_id,
        showId: show.id,
        actor: req.session.username,
        action: 'recap sent to ' + to,
        detail: 'marked sent by hand — the app has no outbound path',
        accent: true
      });
      return r.rows[0];
    });

    res.json({ recap: dbToDeliverable(out), note: 'recorded only — the app has no outbound path' });
  });
}
router.post('/recaps/:id/sent', requireAuth, markSentHandler('recap'));
router.post('/shows/:id/recap/sent', requireAuth, markSentHandler('show'));

// ONE export, and it is the human router. 53: nothing here is mountable under
// /api/agent/*.
module.exports = router;
