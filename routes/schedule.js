// ════════════════════════════════════════════════════════════════════════════
// routes/schedule.js — the SCHEDULE + call sheet (call-sheet pass, punch 38–42)
// ────────────────────────────────────────────────────────────────────────────
// NAMING (Tom, 2026-08-21 — POLISH_LIST #1). In E360's world "run of show" is
// the document describing WHAT PLAYS WHEN, and that name is RESERVED for it.
// This feature is the SCHEDULE (day-by-day crew and times); its printable is
// the CALL SHEET. Nothing a person reads — activity actions, notify summaries,
// error messages — may say "run of show". The route path
// /api/shows/:id/run-of-show is kept only because the front-end already maps
// to it; rename it whenever that mapping is next touched.
//
// The schedule is the per-show, day-by-day call sheet: the PM twin of the
// staffing app's Tech Packet. It is assembled from four things —
//
//   · the SHOW's own header fields (punch 38): load-in / doors / event / strike
//     times, venue address, parking, radio channel, dress code, and the venue +
//     client POC blobs. These live on `shows` because there is exactly one of
//     each per show.
//   · `schedule_items` (punch 39): the timed rows. `who` is JSONB and is one of
//     'all' | ['username', …] | a role slug ('tech'), exactly as the front-end
//     prototype models it (public/data.js schedItemFor / dist rosItemFor).
//   · `crew_assignments` (punch 40): who is on site, in what role, at what call
//     time, with their travel.
//   · a `weather` PLACEHOLDER. There is no forecast proxy on this server and
//     none is stubbed here; the object says so in its own summary string.
//
// WHO OWNS WHICH HALF OF THE TRAVEL DATA (punch 42, INTEGRATION.md B.1/B.6)
//   · Showrunner owns the day-by-day schedule outright. Staffing never receives
//     schedule_items — only the four header times, via the B.1 event push.
//   · Staffing owns the booked travel facts: `travel_info` rows (B.6) and hotel
//     `bookings` (B.2, category 'hotel'). Showrunner holds a MIRROR of them in
//     crew_assignments.travel, stored in the B.6 leg shape 1:1 so the read-back
//     API can be dropped in without reshaping anything:
//       { out: leg, back: leg, hotel: {name, address, conf, checkin, checkout} }
//       leg = { travel_key, flight_num, is_driving, departure_city,
//               departure_date, departure_time, arrival_date, arrival_time,
//               going_home, record_locator }
//     Because those shapes are staffing's, `travel` is validated LOOSELY here
//     (object-or-null, and each leg an object) — the staffing app is the schema
//     authority, not this route.
//
// ROLES (PUNCH_LIST "Roles"): editing the schedule is pm+ (admin/manager/pm
// = ROS_EDIT_ROLES) AND canEditProject on the show's project, so a pm may edit
// only their own projects. viewer/tech read the sheet and never edit it.
//
// NOTIFICATIONS (Tony's principle): every mutating route takes an OPTIONAL
// `notify: ['username', …]`. Absent = silent, which is the default for routine
// edits. Present = one show-anchored note authored by the actor, plus the
// note_mentions rows that light the bell. Unknown usernames are a 400 — an
// agent (or a person) may not invent people. POST/PUT return the record itself,
// unchanged in shape from public/api.js; the DELETE responses carry `notified`.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadShow, loadProject } = require('../lib/db');
const {
  SCHEDULE_KINDS, ALL_ROLES, oneOf, isISODate, isHHMM, intOrNull
} = require('../lib/enums');
const {
  pick, has, dbToScheduleItem, dbToCrew, dbToRoomAssignment, dbToProject, dbToUser
} = require('../lib/mappers');
const { asyncH, badRequest, forbidden, notFound, idParam } = require('../lib/http');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');
const { announceShowChange } = require('../lib/audience');
const { notifyTargets } = require('../lib/mentions');
// punch 42. The staffing read-back needed no staffing-side change — both
// endpoints already exist and are unauthenticated (INTEGRATIONS_SPEC.md §4.4).
// fetchShowTravelBundle NEVER throws: an unreachable scheduler must not stop a
// call sheet from rendering.
const { fetchShowTravelBundle, hotelForPerson, crewStaffingName } = require('../lib/scheduler');
// HARDENING 8: ONE hydrateShow. See the wrapper below.
const { hydrateShow: hydrateShowCore } = require('./core');

const router = express.Router();

// server.js mounts this at /api and does NOT authenticate for us. Every route
// in this module — reads included — needs a session.
router.use(requireAuth);

// pm+ is the rank half of the gate; canEditProject() is the ownership half.
//
// ⚠ THE OWNER HERE IS THE FOLDER'S, AND THAT DIFFERS FROM THE RECAP GATE ON
// PURPOSE. A schedule belongs to the PROJECT's pm (canEditProject); a closeout
// belongs to the SHOW's owner (canApproveRecap, settled 2026-08-27). Because a
// show may carry a different owner from its project, the same person can sit on
// opposite sides of these two gates — that is the intended behaviour, not a
// leftover inconsistency, and it is NOT the project/show split that was fixed
// in routes/deliverables.js. Do not "unify" them: a change meant for one would
// silently move the other. scripts/smoke.js pins both directions on a
// deliberately owner-split show.
const pmPlus = requireRole('pm');

// ── F3/F8. THE MATERIAL SETS FOR THIS FAMILY ────────────────────────────────
// Same device as routes/core.js: a named list of fields per entity, so
// "material vs routine" is data a reader can check rather than an if-statement
// buried in a handler. Everything NOT listed here is routine and stays silent —
// deliberately, and that is the whole of Tony's suppression rule preserved.
//
// F12 is also settled in this file: every action key here is now dotted
// (`crew.add`, `schedule.update`, `callsheet.update`) rather than the English
// sentences it used to log. Nothing could key on a sentence, which is exactly
// why `GET /api/activity?action=` and `?changed=1` could not exist before.
const MATERIAL_CREW_FIELDS = {
  username: 'person', name: 'name', phone: 'phone',
  role_on_site: 'role on site', call_time: 'call time', travel: 'travel'
};
// Rooming: `notes` is absent on purpose, same argument as the booking set —
// it is the routine field. Who, where, which room, which nights and under what
// confirmation is what somebody standing at a front desk at midnight needs to
// be true.
const MATERIAL_ROOMING_FIELDS = {
  person: 'person', hotel: 'hotel', room_type: 'room type',
  confirmation: 'confirmation', check_in: 'check-in', check_out: 'check-out',
  booking_id: 'booking'
};
const MATERIAL_CALLSHEET_FIELDS = {
  load_in_time: 'load-in time', doors_time: 'doors', event_time: 'show time',
  strike_time: 'strike time', venue_address: 'venue address',
  parking_notes: 'parking', radio_channel: 'radio', dress_code: 'dress code',
  venue_poc: 'venue POC', client_poc: 'client POC'
};
// `detail` is deliberately absent: a typo fix in the description line is the
// canonical ROUTINE edit, and the reason F8 exists is that the old create-vs-
// edit split treated it identically to moving load-in three hours earlier.
const MATERIAL_SCHED_FIELDS = {
  day: 'day', start_time: 'start', end_time: 'end',
  title: 'item', who: 'who', location: 'location', kind: 'kind'
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// The roster, keyed by lowercased username. Small table, read per request: a
// cache here would silently reject a new hire's username on `who`.
async function loadRoster(q = pool) {
  const r = await q.query('SELECT * FROM users ORDER BY id');
  const byName = new Map();
  for (const u of r.rows) byName.set(String(u.username || '').toLowerCase(), u);
  return {
    rows: r.rows,
    get(name) { return byName.get(String(name || '').trim().toLowerCase()) || null; },
    has(name) { return byName.has(String(name || '').trim().toLowerCase()); }
  };
}

// The show + its project, or a 404. Reads only.
async function showAndProject(showId, q = pool) {
  const show = await loadShow(showId, q);
  if (!show) throw notFound(`show ${showId} not found`);
  const project = await loadProject(show.project_id, q);
  return { show, project };
}

// The full edit gate: pm+ (enforced by the pmPlus middleware) AND edit rights on
// the owning project.
async function editableShow(req, showId, q = pool) {
  const { show, project } = await showAndProject(showId, q);
  if (!canEditProject(req.session, project)) {
    throw forbidden('editing the schedule requires pm, manager or admin on this project');
  }
  return { show, project };
}

// hydrateShow() from the prototype: the show record + its project, and `type`,
// which lives on the project and not on the show.
//
// HARDENING 8. This used to build the show itself, which meant it shipped the
// STORED `rag` column while routes/core.js shipped the DERIVED one — the call
// sheet could show a green show that the dashboard showed as red. There is now
// one hydrateShow (core.js); this only adds the two fields the call sheet needs
// on top of it.
async function hydrateShow(show, project, q = pool) {
  return hydrateShowCore(show, q, {
    extra: {
      project: dbToProject(project),
      type: (project && project.type) || 'led'
    }
  });
}

// ── field coercion / validation ─────────────────────────────────────────────
function timeOrNull(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!isHHMM(s)) throw badRequest(`${label} must be HH:MM (24-hour) or null — got "${value}"`);
  return s;
}
function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
function requireISODay(value) {
  const s = String(value == null ? '' : value).trim();
  if (!isISODate(s)) throw badRequest(`day must be an ISO date (YYYY-MM-DD) — got "${value}"`);
  return s;
}
function requireStart(value) {
  const s = String(value == null ? '' : value).trim();
  if (!isHHMM(s)) throw badRequest(`start_time must be HH:MM (24-hour) — got "${value}"`);
  return s;
}
function requireTitle(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw badRequest('a schedule item needs a title');
  return s;
}
// Absent kind defaults to 'work'; a kind that WAS supplied and is unknown is a
// 400 rather than a silent fallback — nobody should invent a lane colour.
function requireKind(value) {
  const s = String(value == null ? '' : value).trim();
  const k = oneOf(s, SCHEDULE_KINDS, null);
  if (!k) throw badRequest(`unknown schedule kind "${value}" — one of ${SCHEDULE_KINDS.join(', ')}`);
  return k;
}

// `who` (punch 39): 'all' | array of KNOWN usernames | a role slug. Anything
// else is a 400 that names the offending value — an agent or a typo must never
// be able to address a person who does not exist.
function normalizeWho(raw, roster) {
  if (raw === null || raw === undefined || raw === '') return 'all';
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.toLowerCase() === 'all') return 'all';
    if (ALL_ROLES.includes(s)) return s;                 // role slug, e.g. 'tech'
    throw badRequest(
      `who must be 'all', an array of known usernames, or a role slug ` +
      `(${ALL_ROLES.join('/')}) — got "${s}"`);
  }
  if (Array.isArray(raw)) {
    const names = raw.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
    if (!names.length) return 'all';
    const unknown = names.filter((n) => !roster.has(n));
    if (unknown.length) {
      throw badRequest(`who names ${unknown.length === 1 ? 'an unknown user' : 'unknown users'}: ` +
                       unknown.join(', '));
    }
    // store the canonical spelling so rosItemFor comparisons stay exact
    return [...new Set(names.map((n) => roster.get(n).username))];
  }
  throw badRequest("who must be 'all', an array of usernames, or a role slug");
}

// `travel` is staffing's shape (B.6) — validate the envelope, nothing more.
function normalizeTravel(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('travel must be an object (the staffing B.6 shape) or null');
  }
  for (const leg of ['out', 'back']) {
    const v = raw[leg];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) {
      throw badRequest(`travel.${leg} must be an object (a B.6 travel leg) or null`);
    }
  }
  return raw;
}

// venue_poc / client_poc: {name, phone, title} JSONB, or null to clear.
function normalizePoc(raw, label) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest(`${label} must be an object {name, phone, title} or null`);
  }
  const out = {
    name: String(raw.name || '').trim(),
    phone: String(raw.phone || '').trim(),
    title: String(raw.title || '').trim()
  };
  if (!out.name && !out.phone && !out.title) return null;
  return out;
}

// ── the assembled sheet ─────────────────────────────────────────────────────
async function scheduleRows(showId, q = pool) {
  const r = await q.query(
    'SELECT * FROM schedule_items WHERE show_id=$1 ORDER BY day, start_time, id', [showId]);
  return r.rows.map(dbToScheduleItem);
}
async function crewRows(showId, q = pool) {
  const r = await q.query('SELECT * FROM crew_assignments WHERE show_id=$1 ORDER BY id', [showId]);
  return r.rows;
}
// dbToCrew + the roster row for a staffed (non-local-hire) assignment.
function hydrateCrew(row, roster) {
  const c = dbToCrew(row);
  const u = row.username ? roster.get(row.username) : null;
  return { ...c, user: u ? dbToUser(u) : null };
}

// rosDayTag(): what a day IS relative to the show's own dates.
function dayTag(show, day) {
  if (day === show.load_in_date && day === show.event_date) return 'Show day';
  if (day === show.load_in_date) return 'Load-in';
  if (day === show.event_date) return 'Show day';
  if (day === show.strike_date) return 'Strike';
  return '';
}

// rosItemFor(): does this item apply to <username>? who is 'all' | usernames[]
// | a role slug matched against the person's users.role.
function itemAppliesTo(item, username, roster) {
  const w = item.who;
  if (w === 'all' || w == null) return true;
  if (Array.isArray(w)) {
    const me = String(username || '').toLowerCase();
    return w.some((u) => String(u || '').toLowerCase() === me);
  }
  const u = roster.get(username);
  return !!(u && u.role === w);
}

// ── the optional notify fan-out (Tony's principle) ──────────────────────────
// Returns [] when the caller said nothing — silence is the default. Otherwise
// writes ONE show-anchored note authored by the actor and the mention rows.
//
// HARDENING 10: the mechanism moved to lib/mentions.js notifyTargets(). This
// module contributed the self-notify drop, which is now the behaviour
// everywhere. Its summary lines already read as whole sentences, so it keeps a
// format that appends nothing — the mention rows carry the targets.
async function deliverNotify(c, { body, show, actor, summary }) {
  return notifyTargets(c, {
    body,
    anchorType: 'show',
    anchorId: show.id,
    projectId: show.project_id || null,
    showId: show.id,
    actor,
    summary,
    format: (line) => line
  });
}

// ════════════════════════════════════════════════════════════════════════════
// THE ASSEMBLED SHEET
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/call-sheet   ← CANONICAL (POLISH_LIST #1)
// GET /api/shows/:id/run-of-show  ← retained alias, same handler
//
// public/api.js getSchedule() is the spec, verbatim:
//   { show, days:[{day, tag, items}], schedule, crew, pocs, weather }
// `?username=` adds `my: {crew, items}` — that person's own assignment and the
// items addressed to them.
//
// NAMING. The rename in POLISH_LIST #1 could not simply move this handler to
// /shows/:id/schedule: that path is ALREADY the schedule ITEMS collection
// (GET list · POST create, below), and they are different resources. So the
// assembled document takes the name it actually has on paper — the CALL SHEET,
// which is what the printable has always been called — and "run of show" is
// freed for the future what-plays-when document. The old path keeps working so
// nothing that already maps to it breaks; SCHEMA.md documents both.
// PUT /shows/:id/call-sheet (below) edits this same sheet's header fields, so
// GET and PUT now finally share one name.
const assembledSheet = asyncH(async (req, res) => {
  const showId = idParam(req);
  const { show, project } = await showAndProject(showId);
  const roster = await loadRoster();

  const items = await scheduleRows(showId);
  const crew = (await crewRows(showId)).map((row) => hydrateCrew(row, roster));

  // punch 42. Fold in what the SCHEDULER has actually booked for these people —
  // flights, drives and hotel — so the sheet shows the real arrival time rather
  // than only what someone remembered to mirror into Showrunner. Never fatal:
  // fetchShowTravelBundle returns an `unavailable` string instead of throwing,
  // and the sheet renders from local data regardless.
  const bundle = await fetchShowTravelBundle(show.scheduler_event_id);
  const byPerson = (map, name) => {
    const k = String(name || '').toLowerCase().trim();          // staffing's own key
    if (!k) return null;
    for (const [person, v] of Object.entries(map)) {
      if (String(person).toLowerCase().trim() === k) return v;
    }
    return null;
  };
  for (const c of crew) {
    // The name STAFFING filed this person under — users.staffing_name when the
    // two systems call them different things, their name here otherwise. Same
    // expression the push builder used to write these rows, so the read-back
    // cannot look for a spelling the push never sent (lib/scheduler).
    const name = crewStaffingName(c, c.user);
    const arrival = byPerson(bundle.arrivals, name);
    const departure = byPerson(bundle.departures, name);
    const hotel = hotelForPerson(bundle.hotels, name);
    c.booked = (arrival || departure || hotel)
      ? { arrival: arrival || null, departure: departure || null, hotel: hotel || null }
      : null;
  }

  // distinct days, chronological (the rows already come out sorted)
  const days = [];
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.day)) continue;
    seen.add(it.day);
    days.push({
      day: it.day,
      tag: dayTag(show, it.day),
      items: items.filter((x) => x.day === it.day)
    });
  }

  const onsite = show.on_site_poc ? roster.get(show.on_site_poc) : null;
  const payload = {
    show: await hydrateShow(show, project),
    days,
    schedule: items,
    crew,
    // The rooming list rides the assembled sheet so the printable (and any
    // agent reading this document) answers "where does each person sleep"
    // without a second fetch. Empty array when nobody is roomed — the sheet
    // renders the section only when rows exist.
    rooming: await roomingRows(showId),
    pocs: {
      onsite: onsite ? dbToUser(onsite) : null,
      venue: show.venue_poc || null,
      client: show.client_poc || null
    },
    // No forecast proxy exists on this server — this is a literal placeholder,
    // not a stubbed call. Wiring one up is its own piece of work.
    weather: {
      placeholder: true,
      summary: 'No forecast provider is wired to Showrunner yet — this sheet shows no weather.'
    },
    // Says whether the `booked` blocks above are trustworthy, so a sheet can
    // print "travel not checked" rather than implying nobody is flying.
    scheduler: {
      linked: !!show.scheduler_event_id,
      eventId: show.scheduler_event_id || null,
      unavailable: bundle.unavailable || null
    }
  };

  const username = String(req.query.username || '').trim();
  if (username) {
    const person = roster.get(username);
    if (!person) throw badRequest(`unknown username "${username}"`);
    payload.my = {
      crew: crew.find((c) => c.username && c.username.toLowerCase() === person.username.toLowerCase()) || null,
      items: items.filter((it) => itemAppliesTo(it, person.username, roster))
    };
  }

  res.json(payload);
});

// One handler, two paths. `call-sheet` is the name to write down; `run-of-show`
// is kept alive for anything already pointing at it (public/api.js still does).
router.get('/shows/:id/call-sheet', assembledSheet);
router.get('/shows/:id/run-of-show', assembledSheet);

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULE ITEMS (punch 39)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/schedule — the sorted items, nothing assembled.
router.get('/shows/:id/schedule', asyncH(async (req, res) => {
  const showId = idParam(req);
  await showAndProject(showId);
  res.json(await scheduleRows(showId));
}));

// POST /api/shows/:id/schedule — pm+ on this project.
router.post('/shows/:id/schedule', pmPlus, asyncH(async (req, res) => {
  const showId = idParam(req);
  const body = req.body || {};
  const { show } = await editableShow(req, showId);
  const roster = await loadRoster();

  const title = requireTitle(pick(body, 'title'));
  const day = requireISODay(pick(body, 'day'));
  const startTime = requireStart(pick(body, 'start_time'));
  const endTime = timeOrNull(pick(body, 'end_time'), 'end_time');
  const kind = has(body, 'kind') ? requireKind(pick(body, 'kind')) : 'work';
  const who = normalizeWho(pick(body, 'who'), roster);
  const detail = String(pick(body, 'detail') || '').trim();
  const location = String(pick(body, 'location') || '').trim();

  const item = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO schedule_items
         (show_id, day, start_time, end_time, title, detail, who, location, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [showId, day, startTime, endTime, title, detail, JSON.stringify(who), location, kind]
    );
    const row = r.rows[0];
    await logActivity(c, {
      projectId: show.project_id, showId,
      actor: req.actor, action: 'schedule.add',
      detail: `${title} · ${startTime}`
    });
    await deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Schedule — added "${title}" at ${startTime} on ${day} (${show.name || 'show ' + showId}).`
    });
    return dbToScheduleItem(row);
  });

  res.json(item);
}));

// PUT /api/schedule/:id — partial patch, same gate, same validation.
router.put('/schedule/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const existing = (await pool.query('SELECT * FROM schedule_items WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`schedule item ${id} not found`);
  const { show } = await editableShow(req, existing.show_id);
  const roster = await loadRoster();

  const sets = [];
  const params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

  if (has(body, 'day')) set('day', requireISODay(pick(body, 'day')));
  if (has(body, 'start_time')) set('start_time', requireStart(pick(body, 'start_time')));
  if (has(body, 'end_time')) set('end_time', timeOrNull(pick(body, 'end_time'), 'end_time'));
  if (has(body, 'title')) set('title', requireTitle(pick(body, 'title')));
  if (has(body, 'detail')) set('detail', String(pick(body, 'detail') || '').trim());
  if (has(body, 'location')) set('location', String(pick(body, 'location') || '').trim());
  if (has(body, 'kind')) set('kind', requireKind(pick(body, 'kind')));
  if (has(body, 'who')) {
    params.push(JSON.stringify(normalizeWho(pick(body, 'who'), roster)));
    sets.push(`who=$${params.length}::jsonb`);
  }
  if (!sets.length) throw badRequest('nothing to update');
  sets.push('updated_at=NOW()');
  params.push(id);

  const item = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE schedule_items SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    const row = r.rows[0];
    // F8. The app used to split notification on CREATE vs EDIT and call every
    // edit "routine". Moving load-in from 08:00 to 05:00 the evening before is
    // an edit. The axis is MATERIAL vs ROUTINE: a day, a time or a `who` is
    // material; fixing a typo in the detail line is not.
    const changes = diffFields(existing, row, MATERIAL_SCHED_FIELDS);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id,
      actor: req.actor, action: 'schedule.update',
      detail: changes.length
        ? `${row.title} · ${changeSummary(changes)}`
        : `${row.title} · ${row.start_time}`,
      changes
    });
    await deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Schedule — updated "${row.title}" at ${row.start_time} on ${row.day} ` +
               `(${show.name || 'show ' + show.id}).`
    });
    if (changes.length) {
      await announceShowChange(c, {
        showId: show.id, projectId: show.project_id, actor: req.actor,
        subject: `Schedule changed — "${row.title}" on ${show.name || 'show ' + show.id}`,
        what: `"${row.title}" on ${show.name || 'show ' + show.id}`,
        changes
      });
    }
    return dbToScheduleItem(row);
  });

  res.json(item);
}));

// DELETE /api/schedule/:id
router.delete('/schedule/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const existing = (await pool.query('SELECT * FROM schedule_items WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`schedule item ${id} not found`);
  const { show } = await editableShow(req, existing.show_id);

  const notified = await withTx(async (c) => {
    await c.query('DELETE FROM schedule_items WHERE id=$1', [id]);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id,
      actor: req.actor, action: 'schedule.remove',
      detail: existing.title
    });
    return deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Schedule — removed "${existing.title}" (${existing.day} ${existing.start_time}) ` +
               `from ${show.name || 'show ' + show.id}.`
    });
  });

  res.json({ ok: true, show_id: existing.show_id, notified });
}));

// ════════════════════════════════════════════════════════════════════════════
// CREW ASSIGNMENTS (punch 40)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/crew — each row + its roster record when it is one of ours.
router.get('/shows/:id/crew', asyncH(async (req, res) => {
  const showId = idParam(req);
  await showAndProject(showId);
  const roster = await loadRoster();
  res.json((await crewRows(showId)).map((row) => hydrateCrew(row, roster)));
}));

// A crew line is either one of ours (username) or a local hire (name + phone).
function crewLabel(row) {
  return row.username || row.name || 'crew';
}

// POST /api/shows/:id/crew — pm+.
router.post('/shows/:id/crew', pmPlus, asyncH(async (req, res) => {
  const showId = idParam(req);
  const body = req.body || {};
  const { show } = await editableShow(req, showId);
  const roster = await loadRoster();

  const rawUser = String(pick(body, 'username') || '').trim();
  const name = textOrNull(pick(body, 'name'));
  let username = null;
  if (rawUser) {
    const person = roster.get(rawUser);
    if (!person) throw badRequest(`unknown username "${rawUser}" — a local hire is added with name + phone instead`);
    username = person.username;
  }
  if (!username && !name) {
    throw badRequest('a crew line needs either a known username or a name (local hires carry name + phone)');
  }
  const phone = textOrNull(pick(body, 'phone'));
  const roleOnSite = String(pick(body, 'role_on_site') || '').trim();
  const callTime = timeOrNull(pick(body, 'call_time'), 'call_time');
  const travel = normalizeTravel(pick(body, 'travel'));

  const crew = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO crew_assignments (show_id, username, name, phone, role_on_site, call_time, travel)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [showId, username, name, phone, roleOnSite, callTime,
       travel ? JSON.stringify(travel) : null]
    );
    const row = r.rows[0];
    await logActivity(c, {
      projectId: show.project_id, showId,
      actor: req.actor, action: 'crew.add', accent: true,
      detail: `${crewLabel(row)}${roleOnSite ? ' · ' + roleOnSite : ''}${callTime ? ' · call ' + callTime : ''}`
    });
    await deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Crew — ${crewLabel(row)} added to ${show.name || 'show ' + showId}` +
               `${roleOnSite ? ' as ' + roleOnSite : ''}${callTime ? ', call ' + callTime : ''}.`
    });
    // F5. Being put on a show is the moment you acquire a standing interest in
    // it — so it is also the moment you are told, without the PM having to
    // remember. A local hire (no username) gets nothing here and that is
    // correct: they have no inbox. The call sheet is their channel.
    if (username) {
      await announceShowChange(c, {
        showId, projectId: show.project_id, actor: req.actor, to: [username],
        subject: `You are on ${show.name || 'show ' + showId}` +
                 `${roleOnSite ? ' — ' + roleOnSite : ''}`,
        what: `the crew for ${show.name || 'show ' + showId}`,
        changes: [
          { field: 'crew', label: 'you', from: null, to: roleOnSite || 'on the crew' },
          ...(callTime ? [{ field: 'call_time', label: 'call time', from: null, to: callTime }] : [])
        ],
        extra: `Load-in ${show.load_in_date || 'TBC'} · event ${show.event_date || 'TBC'}` +
               `${show.venue ? ' · ' + show.venue : ''}. ` +
               'You will now hear about changes to this show automatically.'
      });
    }
    return hydrateCrew(row, roster);
  });

  res.json(crew);
}));

// PUT /api/crew/:id — pm+.
router.put('/crew/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const existing = (await pool.query('SELECT * FROM crew_assignments WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`crew assignment ${id} not found`);
  const { show } = await editableShow(req, existing.show_id);
  const roster = await loadRoster();

  const sets = [];
  const params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

  // whatever the patch leaves behind still has to identify a person
  let nextUsername = existing.username;
  let nextName = existing.name;

  if (has(body, 'username')) {
    const raw = pick(body, 'username');
    if (raw === null || String(raw).trim() === '') {
      nextUsername = null;
    } else {
      const person = roster.get(raw);
      if (!person) throw badRequest(`unknown username "${raw}"`);
      nextUsername = person.username;
    }
    set('username', nextUsername);
  }
  if (has(body, 'name')) { nextName = textOrNull(pick(body, 'name')); set('name', nextName); }
  if (!nextUsername && !nextName) {
    throw badRequest('a crew line needs either a known username or a name (local hires carry name + phone)');
  }
  if (has(body, 'phone')) set('phone', textOrNull(pick(body, 'phone')));
  if (has(body, 'role_on_site')) set('role_on_site', String(pick(body, 'role_on_site') || '').trim());
  if (has(body, 'call_time')) set('call_time', timeOrNull(pick(body, 'call_time'), 'call_time'));
  if (has(body, 'travel')) {
    const travel = normalizeTravel(pick(body, 'travel'));
    params.push(travel ? JSON.stringify(travel) : null);
    sets.push(`travel=$${params.length}::jsonb`);
  }
  if (!sets.length) throw badRequest('nothing to update');
  // The scheduler stale check compares this stamp against the show's last push
  // — a crew line is half of what a push publishes.
  sets.push('updated_at=NOW()');
  params.push(id);

  const crew = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE crew_assignments SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    const row = r.rows[0];
    const changes = diffFields(existing, row, MATERIAL_CREW_FIELDS);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id,
      actor: req.actor, action: 'crew.update',
      detail: changes.length
        ? `${crewLabel(row)} · ${changeSummary(changes)}`
        : `${crewLabel(row)}${row.role_on_site ? ' · ' + row.role_on_site : ''}`,
      changes
    });
    await deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Crew — ${crewLabel(row)} updated on ${show.name || 'show ' + show.id}` +
               `${row.call_time ? ' (call ' + row.call_time + ')' : ''}.`
    });
    // F8, on the right axis. A call time moving from 08:00 to 05:00 is an EDIT,
    // and it is the single most consequential thing that happens to a tech the
    // night before a show. Material, therefore announced — to the person it
    // happens to, and to whoever is now off the show.
    if (changes.length) {
      const to = [];
      if (row.username) to.push(row.username);
      if (existing.username && existing.username !== row.username) to.push(existing.username);
      if (to.length) {
        await announceShowChange(c, {
          showId: show.id, projectId: show.project_id, actor: req.actor, to,
          subject: `Your call changed — ${show.name || 'show ' + show.id}`,
          what: `your crew line on ${show.name || 'show ' + show.id}`,
          changes
        });
      }
    }
    return hydrateCrew(row, roster);
  });

  res.json(crew);
}));

// DELETE /api/crew/:id — pm+.
router.delete('/crew/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const existing = (await pool.query('SELECT * FROM crew_assignments WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`crew assignment ${id} not found`);
  const { show } = await editableShow(req, existing.show_id);

  const notified = await withTx(async (c) => {
    await c.query('DELETE FROM crew_assignments WHERE id=$1', [id]);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id,
      actor: req.actor, action: 'crew.remove', accent: true,
      detail: crewLabel(existing)
    });
    // Being taken OFF a show is at least as material as being put on it, and
    // it is the version nobody ever gets told about.
    if (existing.username) {
      await announceShowChange(c, {
        showId: show.id, projectId: show.project_id, actor: req.actor,
        to: [existing.username],
        subject: `You are off ${show.name || 'show ' + show.id}`,
        what: `the crew for ${show.name || 'show ' + show.id}`,
        changes: [{ field: 'crew', label: 'you',
                    from: existing.role_on_site || 'on the crew', to: null }]
      });
    }
    return deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Crew — ${crewLabel(existing)} removed from ${show.name || 'show ' + show.id}.`
    });
  });

  res.json({ ok: true, show_id: existing.show_id, notified });
}));

// ════════════════════════════════════════════════════════════════════════════
// ROOMING LIST (TEAM_FEEDBACK "Rooming lists", 2026-08-27)
// ────────────────────────────────────────────────────────────────────────────
// Who sleeps where: person ↔ hotel / room / confirmation / nights, one row per
// bed. The finding behind it: a hotel booking is ONE row for a block of six
// techs, so five of them had no lodging anywhere a per-person surface could
// read. This table is that per-person surface.
//
// GATES mirror the bookings family exactly (routes/files.js): reads are open
// to anyone signed in — a tech checks their own hotel off this list the same
// way they read the bookings tab — and every write is pm+ RANK plus
// canEditProject OWNERSHIP, delete included (the booking-delete floor was
// deliberately aligned manager→pm in the H-pass; the sibling keeps that
// convention rather than re-litigating it).
//
// NO NOTIFICATIONS in v1, deliberately — the needs-list precedent. A room
// changing hands the night before is real, but the channel for it is the
// call sheet these rows print on; wiring announceShowChange here can come
// with the push integration.
// ════════════════════════════════════════════════════════════════════════════

// The pm+ / ownership gate, worded for this surface (editableShow's message
// says "the schedule", which would send a refused caller to the wrong tab).
async function editableRooming(req, showId, q = pool) {
  const { show, project } = await showAndProject(showId, q);
  if (!canEditProject(req.session, project)) {
    throw forbidden('editing the rooming list requires pm, manager or admin on this project');
  }
  return { show, project };
}

function roomDateOrNull(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!isISODate(s)) throw badRequest(`${label} must be an ISO date (YYYY-MM-DD) or null — got "${value}"`);
  return s;
}
// The one sanity rule dates get: a stay may be a single night (equal dates are
// somebody day-rooming) but it may not end before it starts.
function checkStayOrder(checkIn, checkOut) {
  if (checkIn && checkOut && checkOut < checkIn) {
    throw badRequest(`check_out must be on or after check_in — got check_in ${checkIn}, check_out ${checkOut}`);
  }
}
// A linked booking must be a real one ON THIS SHOW — a rooming row quietly
// pointing at another show's paperwork is exactly the cross-wiring this
// validation refuses to let an agent (or a stale screen) create.
async function roomBookingOrNull(rawId, showId, q = pool) {
  const bookingId = intOrNull(rawId);
  if (!bookingId) return null;
  const r = await q.query('SELECT id, show_id FROM bookings WHERE id=$1', [bookingId]);
  if (!r.rows.length) throw badRequest(`booking ${bookingId} not found`);
  if (r.rows[0].show_id !== showId) {
    throw badRequest(`booking ${bookingId} belongs to another show — a room links only to its own show's bookings`);
  }
  return bookingId;
}
async function roomingRows(showId, q = pool) {
  const r = await q.query(
    'SELECT * FROM room_assignments WHERE show_id=$1 ORDER BY sort_order, id', [showId]);
  return r.rows.map(dbToRoomAssignment);
}
function roomLabel(row) {
  return `${row.person}${row.hotel ? ' · ' + row.hotel : ''}${row.room_type ? ' · ' + row.room_type : ''}`;
}

// GET /api/shows/:id/rooming — anyone signed in, like the bookings list.
router.get('/shows/:id/rooming', asyncH(async (req, res) => {
  const showId = idParam(req);
  await showAndProject(showId);
  res.json(await roomingRows(showId));
}));

// POST /api/shows/:id/rooming — pm+ on this project.
router.post('/shows/:id/rooming', pmPlus, asyncH(async (req, res) => {
  const showId = idParam(req);
  const body = req.body || {};
  const { show } = await editableRooming(req, showId);
  const roster = await loadRoster();

  // person is the printable truth; user_username is the optional roster link.
  // Picking a user without typing a name fills person from the roster, so the
  // sheet never prints a blank line for a real human.
  let username = null;
  const rawUser = String(pick(body, 'user_username') || '').trim();
  if (rawUser) {
    const u = roster.get(rawUser);
    if (!u) throw badRequest(`unknown username "${rawUser}" — free-text rows carry person only`);
    username = u.username;
  }
  let person = String(pick(body, 'person') || '').trim();
  if (!person && username) person = roster.get(username).name || username;
  if (!person) throw badRequest('a room row needs a person — a name, or a username from the roster');

  const checkIn = roomDateOrNull(pick(body, 'check_in'), 'check_in');
  const checkOut = roomDateOrNull(pick(body, 'check_out'), 'check_out');
  checkStayOrder(checkIn, checkOut);
  const bookingId = await roomBookingOrNull(pick(body, 'booking_id'), showId);

  const room = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO room_assignments
         (show_id, person, user_username, hotel, booking_id, room_type, confirmation,
          check_in, check_out, notes, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [showId, person, username, String(pick(body, 'hotel') || '').trim(), bookingId,
       String(pick(body, 'room_type') || '').trim(), String(pick(body, 'confirmation') || '').trim(),
       checkIn, checkOut, String(pick(body, 'notes') || '').trim(),
       parseInt(pick(body, 'sort_order'), 10) || 0, req.actor]);
    const row = r.rows[0];
    await logActivity(c, {
      projectId: show.project_id, showId,
      actor: req.actor, action: 'rooming.add',
      detail: roomLabel(row)
    });
    return dbToRoomAssignment(row);
  });

  res.json(room);
}));

// POST /api/shows/:id/rooming/from-crew — the bulk affordance: one click gives
// everyone on the crew a rooming row, skipping anyone already listed. Matching
// is by username for roster crew and by name for local hires — the same two
// identities a crew line can carry. Idempotent: a second click adds nobody.
router.post('/shows/:id/rooming/from-crew', pmPlus, asyncH(async (req, res) => {
  const showId = idParam(req);
  const { show } = await editableRooming(req, showId);
  const roster = await loadRoster();
  const crew = await crewRows(showId);
  const existing = await roomingRows(showId);
  const haveUser = new Set(existing.filter((r) => r.user_username)
    .map((r) => r.user_username.toLowerCase()));
  const havePerson = new Set(existing.map((r) => String(r.person || '').trim().toLowerCase()));

  const added = [];
  await withTx(async (c) => {
    for (const line of crew) {
      const u = line.username ? roster.get(line.username) : null;
      const person = u ? (u.name || u.username) : String(line.name || '').trim();
      if (!person) continue;                       // a crew line with no identity has no bed to book
      if (u && haveUser.has(u.username.toLowerCase())) continue;
      if (!u && havePerson.has(person.toLowerCase())) continue;
      const r = await c.query(
        `INSERT INTO room_assignments (show_id, person, user_username, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [showId, person, u ? u.username : null, req.actor]);
      added.push(dbToRoomAssignment(r.rows[0]));
      if (u) haveUser.add(u.username.toLowerCase());
      havePerson.add(person.toLowerCase());
    }
    // One activity row for the gesture, not one per bed — the add was one act.
    if (added.length) {
      await logActivity(c, {
        projectId: show.project_id, showId,
        actor: req.actor, action: 'rooming.add', accent: true,
        detail: `${added.length} room${added.length === 1 ? '' : 's'} from the crew`
      });
    }
  });

  res.json({ added, skipped: crew.length - added.length });
}));

// PUT /api/rooming/:id — partial patch, same gate, same validation.
router.put('/rooming/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const existing = (await pool.query('SELECT * FROM room_assignments WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`room assignment ${id} not found`);
  const { show } = await editableRooming(req, existing.show_id);
  const roster = await loadRoster();

  const sets = [];
  const params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

  if (has(body, 'user_username')) {
    const raw = pick(body, 'user_username');
    if (raw === null || String(raw).trim() === '') set('user_username', null);
    else {
      const u = roster.get(raw);
      if (!u) throw badRequest(`unknown username "${raw}"`);
      set('user_username', u.username);
    }
  }
  if (has(body, 'person')) {
    const person = String(pick(body, 'person') || '').trim();
    if (!person) throw badRequest('a room row needs a person — delete the row instead of blanking the name');
    set('person', person);
  }
  for (const col of ['hotel', 'room_type', 'confirmation', 'notes']) {
    if (has(body, col)) set(col, String(pick(body, col) || '').trim());
  }
  // the stay-order rule holds on whatever the PATCH leaves behind, so a date
  // moved on its own is checked against the one it kept
  const nextIn = has(body, 'check_in')
    ? roomDateOrNull(pick(body, 'check_in'), 'check_in') : existing.check_in;
  const nextOut = has(body, 'check_out')
    ? roomDateOrNull(pick(body, 'check_out'), 'check_out') : existing.check_out;
  checkStayOrder(nextIn, nextOut);
  if (has(body, 'check_in')) set('check_in', nextIn);
  if (has(body, 'check_out')) set('check_out', nextOut);
  if (has(body, 'booking_id')) {
    set('booking_id', await roomBookingOrNull(pick(body, 'booking_id'), existing.show_id));
  }
  if (has(body, 'sort_order')) set('sort_order', parseInt(pick(body, 'sort_order'), 10) || 0);
  if (!sets.length) throw badRequest('nothing to update');
  sets.push('updated_at=NOW()');
  params.push(req.actor);
  sets.push(`updated_by=$${params.length}`);
  params.push(id);

  const room = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE room_assignments SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    const row = r.rows[0];
    const changes = diffFields(existing, row, MATERIAL_ROOMING_FIELDS);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id,
      actor: req.actor, action: 'rooming.update',
      detail: changes.length ? `${row.person} · ${changeSummary(changes)}` : roomLabel(row),
      changes
    });
    return dbToRoomAssignment(row);
  });

  res.json(room);
}));

// DELETE /api/rooming/:id — pm+, 404 on a row that never existed (the H3 rule:
// a stale screen must not be told it deleted nothing successfully).
router.delete('/rooming/:id', pmPlus, asyncH(async (req, res) => {
  const id = idParam(req);
  const existing = (await pool.query('SELECT * FROM room_assignments WHERE id=$1', [id])).rows[0];
  if (!existing) throw notFound(`room assignment ${id} not found`);
  const { show } = await editableRooming(req, existing.show_id);

  await withTx(async (c) => {
    await c.query('DELETE FROM room_assignments WHERE id=$1', [id]);
    await logActivity(c, {
      projectId: show.project_id, showId: show.id,
      actor: req.actor, action: 'rooming.remove', accent: true,
      detail: roomLabel(existing)
    });
  });

  res.json({ ok: true, show_id: existing.show_id });
}));

// ════════════════════════════════════════════════════════════════════════════
// CALL-SHEET HEADER (punch 38)
// ════════════════════════════════════════════════════════════════════════════

// PUT /api/shows/:id/call-sheet — pm+. Sets ONLY the header fields; the show's
// dates, stage and RAG belong to the shows routes, not to this one.
router.put('/shows/:id/call-sheet', pmPlus, asyncH(async (req, res) => {
  const showId = idParam(req);
  const body = req.body || {};
  const { show, project } = await editableShow(req, showId);

  const sets = [];
  const params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  const touched = [];

  for (const col of ['load_in_time', 'doors_time', 'event_time', 'strike_time']) {
    if (!has(body, col)) continue;
    set(col, timeOrNull(pick(body, col), col));
    touched.push(col);
  }
  for (const col of ['venue_address', 'parking_notes', 'radio_channel', 'dress_code']) {
    if (!has(body, col)) continue;
    set(col, textOrNull(pick(body, col)));
    touched.push(col);
  }
  for (const col of ['venue_poc', 'client_poc']) {
    if (!has(body, col)) continue;
    const poc = normalizePoc(pick(body, col), col);
    params.push(poc ? JSON.stringify(poc) : null);
    sets.push(`${col}=$${params.length}::jsonb`);
    touched.push(col);
  }
  if (!sets.length) throw badRequest('nothing to update');
  sets.push('updated_at=NOW()');
  params.push(showId);

  const updated = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE shows SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    const row = r.rows[0];
    const changes = diffFields(show, row, MATERIAL_CALLSHEET_FIELDS);
    await logActivity(c, {
      projectId: show.project_id, showId,
      actor: req.actor, action: 'callsheet.update',
      detail: changes.length ? changeSummary(changes) : touched.join(', '),
      changes
    });
    await deliverNotify(c, {
      body, show, actor: req.actor,
      summary: `Call sheet — header updated on ${show.name || 'show ' + showId} (${touched.join(', ')}).`
    });
    // The four clock times are the call sheet. Everyone rostered on the show
    // reads them at 6am; a change to them that reaches nobody is the exact
    // failure Tom described.
    if (changes.length) {
      await announceShowChange(c, {
        showId, projectId: show.project_id, actor: req.actor,
        subject: `Call sheet changed — ${show.name || 'show ' + showId}`,
        what: `the call sheet for ${show.name || 'show ' + showId}`,
        changes,
        extra: 'Re-print or re-open your call sheet before you travel.'
      });
    }
    return row;
  });

  res.json(await hydrateShow(updated, project));
}));

// ════════════════════════════════════════════════════════════════════════════
// TRAVEL (punch 42) — READ-ONLY PROJECTION
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shows/:id/travel
// Whatever Showrunner already holds in crew_assignments.travel, one row per
// crew line, in the staffing B.6 shape — MERGED with what the scheduler
// actually has booked. `name` falls back to the roster's display name so the
// caller sees the CANONICAL name the staffing app keys on.
//
// RESOLVED (punch 42): the read-back needed NO staffing-side change. Both
// endpoints already exist and are unauthenticated (INTEGRATIONS_SPEC.md §4.4) —
// the earlier TODO here was written against a premise that turned out to be
// wrong:
//   · GET /api/travel      — the WHOLE travel_info table, as an OBJECT keyed by
//                            travel_key. lib/scheduler.js reproduces the packet
//                            builder's own key disambiguation exactly, including
//                            the two mandatory sentinel forms
//                            "Name|<eventId>|inbound" / "|outbound" (§4.2).
//   · GET /api/bookings?eventId=N  — hotels are NOT in travel_info; a hotel is a
//                            bookings row with category 'hotel' (LOWERCASE) and
//                            the occupants in staff_assigned.
//
// GRACEFUL BY CONTRACT: if the scheduler is unreachable, unconfigured, or the
// show was never pushed, this route still answers 200 from local data and says
// what it could not reach in `scheduler.unavailable`. THE CALL SHEET MUST STILL
// RENDER — a travel lookup failure is not a reason to fail a crew sheet.
//
// The direction of travel in the other direction stays as it is: staffing gets
// only the four header times (B.1). The day-by-day schedule is Showrunner's.
router.get('/shows/:id/travel', asyncH(async (req, res) => {
  const showId = idParam(req);
  const { show } = await showAndProject(showId);
  const roster = await loadRoster();

  const bundle = await fetchShowTravelBundle(show.scheduler_event_id);
  // Staffing keys people on name.toLowerCase().trim() — match the same way.
  const pick2 = (map, name) => {
    const k = String(name || '').toLowerCase().trim();
    if (!k) return null;
    for (const [person, v] of Object.entries(map)) {
      if (String(person).toLowerCase().trim() === k) return v;
    }
    return null;
  };

  const rows = await crewRows(showId);
  const crew = rows.map((row) => {
    const u = row.username ? roster.get(row.username) : null;
    // The staffing-side name (users.staffing_name, else theirs here) — the same
    // expression the push wrote these legs under.
    const name = crewStaffingName(row, u) || null;
    const local = row.travel || null;
    const arrival = pick2(bundle.arrivals, name);
    const departure = pick2(bundle.departures, name);
    const hotel = hotelForPerson(bundle.hotels, name);
    return {
      crew_id: row.id,
      username: row.username || null,
      name,
      role_on_site: row.role_on_site || '',
      call_time: row.call_time || null,
      // what a human or an agent filed HERE — unchanged, still the local record
      travel: local,
      // what the scheduler actually has booked. Null (not {}) when we could not
      // look, so a caller can tell "nothing booked" from "did not ask".
      booked: (arrival || departure || hotel)
        ? { arrival: arrival || null, departure: departure || null, hotel: hotel || null }
        : null
    };
  });

  res.json({
    crew,
    scheduler: {
      linked: !!show.scheduler_event_id,
      eventId: show.scheduler_event_id || null,
      unavailable: bundle.unavailable || null,
      hotels: bundle.hotels.length,
      arrivals: Object.keys(bundle.arrivals).length,
      departures: Object.keys(bundle.departures).length
    }
  });
}));

module.exports = router;
