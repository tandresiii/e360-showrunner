// ════════════════════════════════════════════════════════════════════════════
// routes/calendar.js — COMPANY LIFE on the calendar (wave 3, 2026-09-25)
// ────────────────────────────────────────────────────────────────────────────
// Tom: "Anything put on a calendar needs to belong to a show... what if we want
// to put generic stuff on there? someone's birthday? out of office notes,
// etc?" — then: "put post it notes on a date and have it show up on someone
// elses calendar - like reminders for everyone - or just someone."
//
// A calendar entry hangs off NO show and NO folder. Three audiences:
//
//   team      everybody signed in
//   personal  its creator, and NOBODY else — not a teammate, not an admin.
//             "Never served" is enforced HERE, in one SQL fragment (VISIBLE
//             below), and smoke pins it with two discriminating identities.
//   directed  its creator + the roster usernames in for_users. Each target is
//             pinged ONCE through lib/notify's outbox (kind 'notify' — the
//             notify-picker's own lane), which already drops the actor: a note
//             you direct at yourself pings nobody.
//
// ROLES — deliberately LOOSER than milestones/tasks. ANY signed-in role may
// create: an out-of-office is self-service, and a tech marking themselves out
// must not need a PM. Edit and delete are the CREATOR's, or an admin's.
//
// Nothing here writes to `activity`: the feed is show-scoped and read by
// everybody, and a personal note's label has no business in it.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx } = require('../lib/db');
const { isISODate, oneOf } = require('../lib/enums');
const { pick, has, dbToCalendarEntry } = require('../lib/mappers');
const { asyncH, badRequest, forbidden, notFound, idParam } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { resolveUsernames } = require('../lib/mentions');
const notify = require('../lib/notify');

const router = express.Router();

// Session-only, like every other human router — server.js mounts it in the
// fourth group, below everything that accepts an agent key.
router.use(requireAuth);

const ENTRY_SCOPES = ['team', 'personal', 'directed'];
const ENTRY_KINDS = ['note', 'ooo', 'birthday'];
const ENTRY_REPEATS = ['none', 'yearly'];
const LABEL_MAX = 120;          // a chip, not a document
const SPAN_MAX_DAYS = 366;      // a year of OOO is already absurd; this bounds the render
const TARGETS_MAX = 25;

// THE VISIBILITY RULE, ONCE. $1 is the signed-in username. Every read and the
// non-admin write lookups go through this fragment, so "who may see a row" has
// exactly one answer on the server.
const VISIBLE = `(scope = 'team'
   OR (scope = 'personal' AND LOWER(created_by) = LOWER($1))
   OR (scope = 'directed' AND (LOWER(created_by) = LOWER($1)
        OR LOWER($1) IN (SELECT LOWER(u) FROM unnest(for_users) AS u))))`;

function isAdmin(req) { return !!(req.session && req.session.role === 'admin'); }

// A real calendar day, not merely the shape of one ('2026-02-30' is refused).
function realDate(s) {
  if (!isISODate(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function dateOr400(v, field) {
  const s = String(v == null ? '' : v).trim();
  if (!realDate(s)) throw badRequest(`${field} must be a real date (YYYY-MM-DD) — got "${v == null ? '' : v}"`);
  return s;
}
function endOrNull(v, start) {
  if (v === null || v === undefined || v === '') return null;
  const s = dateOr400(v, 'end_date');
  if (s < start) throw badRequest(`end_date ${s} is before the start date ${start}`);
  if (s === start) return null;                  // a one-day "span" is just a day
  const days = Math.round((new Date(s + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000);
  if (days > SPAN_MAX_DAYS) throw badRequest(`a calendar entry may span at most ${SPAN_MAX_DAYS} days`);
  return s;
}
function labelOr400(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) throw badRequest('a calendar entry needs a label — what is this date?');
  if (s.length > LABEL_MAX) throw badRequest(`a label is at most ${LABEL_MAX} characters`);
  return s;
}
function enumOr400(v, list, field, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim();
  if (!list.includes(s)) throw badRequest(`${field} must be one of: ${list.join(', ')}`);
  return oneOf(s, list, fallback);
}
// for_users: roster usernames, resolved the way a step's owner is
// (lib/mentions resolveUsernames). Unknown names are a 400 naming each one.
async function targetsFor(scope, raw, q = pool) {
  let list = raw;
  if (list === undefined || list === null || list === '') list = [];
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) throw badRequest('for_users must be an array of usernames');
  list = list.map((u) => String(u || '').trim()).filter(Boolean);
  if (scope !== 'directed') {
    if (list.length) throw badRequest("for_users is only for scope 'directed' — a team note is everybody's, a personal one is yours");
    return [];
  }
  if (!list.length) throw badRequest('a directed note needs at least one person to show up for');
  if (list.length > TARGETS_MAX) throw badRequest(`a directed note may name at most ${TARGETS_MAX} people`);
  const { valid, unknown } = await resolveUsernames(list, q);
  if (unknown.length) {
    throw badRequest(`Unknown user${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `'${u}'`).join(', ')} in for_users`);
  }
  return valid;
}

async function nameOf(username, q = pool) {
  const r = await q.query('SELECT name FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  return (r.rows[0] && r.rows[0].name) || username;
}

// One ping per target, through the SAME outbox lane the notify picker uses.
// enqueue() drops the actor, so a note to yourself pings nobody. Returns the
// usernames whose row was actually QUEUED (a target whose preference is 'off'
// gets a 'skipped' row, and the toast must not claim they were told).
async function pingTargets(c, row, targets, actor) {
  if (!targets.length) return [];
  const who = await nameOf(actor, c);
  const when = row.date + (row.end_date ? ' → ' + row.end_date : '');
  const text = `${who} left a note on your calendar: ${row.label} — ${when}`;
  const rows = await notify.enqueueMany(c, targets, {
    kind: 'notify', actor, subject: text, body: text, link: '/#calendar'
  });
  return rows.filter((r) => r.status === 'queued').map((r) => r.username);
}

// The row a write may touch: a non-admin must be able to SEE it (an invisible
// row is a 404 — a stranger learns nothing about another person's personal
// note), and then must be its creator (403). An admin reaches any row.
async function writableEntry(req, id, q = pool) {
  const r = isAdmin(req)
    ? await q.query('SELECT * FROM calendar_entries WHERE id=$1', [id])
    : await q.query(`SELECT * FROM calendar_entries WHERE id=$2 AND ${VISIBLE}`, [req.actor, id]);
  const row = r.rows[0];
  if (!row) throw notFound(`calendar entry ${id} not found`);
  if (!isAdmin(req) && String(row.created_by).toLowerCase() !== String(req.actor).toLowerCase()) {
    throw forbidden('only the person who added this calendar entry, or an admin, can change or remove it');
  }
  return row;
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/calendar-entries — every team entry, my own personal ones, and the
// directed ones I wrote or that name me. Nothing else, for anybody.
router.get('/calendar-entries', asyncH(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM calendar_entries WHERE ${VISIBLE} ORDER BY date ASC, id ASC`, [req.actor]);
  res.json(r.rows.map(dbToCalendarEntry));
}));

// POST /api/calendar-entries — ANY signed-in role (see the header).
router.post('/calendar-entries', asyncH(async (req, res) => {
  const b = req.body || {};
  const label = labelOr400(pick(b, 'label'));
  const date = dateOr400(pick(b, 'date'), 'date');
  const endDate = endOrNull(pick(b, 'end_date'), date);
  const scope = enumOr400(pick(b, 'scope'), ENTRY_SCOPES, 'scope', 'team');
  const kind = enumOr400(pick(b, 'kind'), ENTRY_KINDS, 'kind', 'note');
  const repeat = enumOr400(pick(b, 'repeat'), ENTRY_REPEATS, 'repeat', 'none');
  const targets = await targetsFor(scope, pick(b, 'for_users'));

  const out = await withTx(async (c) => {
    const r = await c.query(
      `INSERT INTO calendar_entries (label, date, end_date, scope, kind, repeat, for_users, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [label, date, endDate, scope, kind, repeat, targets, req.actor]);
    const row = r.rows[0];
    const notified = await pingTargets(c, row, targets, req.actor);
    return { ...dbToCalendarEntry(row), notified };
  });
  res.json(out);
}));

// PUT /api/calendar-entries/:id — the creator or an admin. A partial patch; a
// person newly added to a directed note is pinged, one already on it is not.
router.put('/calendar-entries/:id', asyncH(async (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  const cur = await writableEntry(req, id);

  const label = has(b, 'label') ? labelOr400(pick(b, 'label')) : cur.label;
  const date = has(b, 'date') ? dateOr400(pick(b, 'date'), 'date') : cur.date;
  const endDate = has(b, 'end_date') ? endOrNull(pick(b, 'end_date'), date) : endOrNull(cur.end_date, date);
  const scope = has(b, 'scope') ? enumOr400(pick(b, 'scope'), ENTRY_SCOPES, 'scope', cur.scope) : cur.scope;
  const kind = has(b, 'kind') ? enumOr400(pick(b, 'kind'), ENTRY_KINDS, 'kind', cur.kind) : cur.kind;
  const repeat = has(b, 'repeat') ? enumOr400(pick(b, 'repeat'), ENTRY_REPEATS, 'repeat', cur.repeat) : cur.repeat;
  // moving OFF directed drops the list; staying on it keeps it unless replaced
  const rawTargets = has(b, 'for_users') ? pick(b, 'for_users')
    : (scope === 'directed' ? (cur.for_users || []) : []);
  const targets = await targetsFor(scope, rawTargets);

  const before = new Set((cur.scope === 'directed' ? cur.for_users || [] : []).map((u) => u.toLowerCase()));
  const added = targets.filter((u) => !before.has(u.toLowerCase()));

  const out = await withTx(async (c) => {
    const r = await c.query(
      `UPDATE calendar_entries SET label=$1, date=$2, end_date=$3, scope=$4, kind=$5, repeat=$6,
         for_users=$7, updated_at=NOW() WHERE id=$8 RETURNING *`,
      [label, date, endDate, scope, kind, repeat, targets, id]);
    const row = r.rows[0];
    const notified = await pingTargets(c, row, added, req.actor);
    return { ...dbToCalendarEntry(row), notified };
  });
  res.json(out);
}));

// DELETE /api/calendar-entries/:id — the creator or an admin; a 404 on a row
// that never existed (or that you could never see).
router.delete('/calendar-entries/:id', asyncH(async (req, res) => {
  const id = idParam(req);
  await writableEntry(req, id);
  await pool.query('DELETE FROM calendar_entries WHERE id=$1', [id]);
  res.json({ ok: true, id });
}));

router.VISIBLE = VISIBLE;
module.exports = router;
