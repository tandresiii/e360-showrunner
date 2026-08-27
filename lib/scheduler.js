// ════════════════════════════════════════════════════════════════════════════
// lib/scheduler.js — the staffing-app ("e360-staffing3") client
// ────────────────────────────────────────────────────────────────────────────
// Showrunner is the PM app; the staffing app is the scheduler. This module is
// the ONLY place that speaks to it. INTEGRATIONS_SPEC.md §1, §2 and §4 are the
// workbook; every mapping fix M1–M14 lives here, named in the comment beside it.
//
// AUTH (§1.4.1) — the fact that shapes this whole module:
//   The staffing app has NO API-key path and no service-credential mechanism.
//   Sessions are an in-memory Map with a 12 h TTL, wiped on every redeploy. So
//   a static SCHEDULER_API_TOKEN would be dead within hours (R1). We log in
//   programmatically as SCHEDULER_USER/SCHEDULER_PASS, cache the token for 11 h
//   (one hour inside the server's TTL), and RETRY ONCE on 401 — which is what a
//   redeploy looks like from here.
//
// CONFIG
//   SCHEDULER_BASE_URL   unset ⇒ every live call is a 501 with a clear message.
//   SCHEDULER_USER / SCHEDULER_PASS   the `showrunner` service account.
//   SCHEDULER_API_TOKEN is RETIRED. Do not reintroduce it.
//
// TRANSACTIONALITY (§2.7): no transaction crosses the wire. Each HTTP call is
// its own commit, so the fan-out is RESUMABLE, not atomic — scheduler_event_id
// is persisted the moment the event exists, so a retry updates rather than
// duplicates.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const SCHEDULER_TIMEOUT_MS = parseInt(process.env.SCHEDULER_TIMEOUT_MS || '20000', 10);
const TOKEN_TTL_MS = 11 * 60 * 60 * 1000;     // 11 h, one hour inside staffing's 12 h

// ── configuration ───────────────────────────────────────────────────────────
function notConfigured(which) {
  const e = new Error(
    `Live push to the scheduler is not configured: ${which} is unset. ` +
    `Set SCHEDULER_BASE_URL (the staffing app's host), plus SCHEDULER_USER and SCHEDULER_PASS ` +
    `for the dedicated 'showrunner' service account. Until then the dry run is the only path ` +
    `(INTEGRATIONS_SPEC.md §1.4.1, §8).`
  );
  e.status = 501;
  e.code = 'SCHEDULER_NOT_CONFIGURED';
  return e;
}
function schedulerBaseUrl() {
  const raw = process.env.SCHEDULER_BASE_URL;
  if (!raw) throw notConfigured('SCHEDULER_BASE_URL');
  return String(raw).replace(/\/+$/, '');
}
function schedulerConfigured() { return !!process.env.SCHEDULER_BASE_URL; }
function schedulerCredentialed() {
  return !!(process.env.SCHEDULER_BASE_URL && process.env.SCHEDULER_USER && process.env.SCHEDULER_PASS);
}

// ── the token cache (§1.4.1) ────────────────────────────────────────────────
let _tok = null;
let _exp = 0;
async function schedulerToken(force) {
  if (!force && _tok && Date.now() < _exp) return _tok;
  if (!process.env.SCHEDULER_USER) throw notConfigured('SCHEDULER_USER');
  if (!process.env.SCHEDULER_PASS) throw notConfigured('SCHEDULER_PASS');
  const r = await rawFetch(schedulerBaseUrl() + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // staffing lowercases + trims the username server-side (staffing/server.js:773)
    body: JSON.stringify({ username: process.env.SCHEDULER_USER, password: process.env.SCHEDULER_PASS })
  });
  if (!r.ok) {
    const e = new Error(`Scheduler login failed: ${r.status}` +
      (r.status === 401 ? ' — check SCHEDULER_USER / SCHEDULER_PASS' : ''));
    e.status = r.status === 401 ? 502 : 502;
    e.body = r.body;
    throw e;
  }
  _tok = r.body && r.body.token;
  if (!_tok) { const e = new Error('Scheduler login returned no token'); e.status = 502; throw e; }
  _exp = Date.now() + TOKEN_TTL_MS;
  return _tok;
}
function schedulerResetToken() { _tok = null; _exp = 0; }

async function rawFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCHEDULER_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(e && e.name === 'AbortError'
      ? `Scheduler request timed out after ${SCHEDULER_TIMEOUT_MS}ms: ${url}`
      : `Scheduler unreachable: ${e && e.message ? e.message : e}`);
    err.status = 502;
    err.code = 'SCHEDULER_UNREACHABLE';
    throw err;
  }
  clearTimeout(timer);
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { ok: res.ok, status: res.status, body };
}

// The authenticated door. One 401 retry — that is a redeploy having wiped the
// in-memory session Map, not a credential problem.
async function schedulerFetch(apiPath, options = {}, _retried) {
  const token = await schedulerToken(false);
  const res = await rawFetch(schedulerBaseUrl() + apiPath, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'x-auth-token': token,
      ...(options.headers || {})
    }
  });
  if (res.status === 401 && !_retried) {
    schedulerResetToken();
    await schedulerToken(true);
    return schedulerFetch(apiPath, options, true);
  }
  if (!res.ok) {
    const msg = (res.body && (res.body.error || res.body.message)) ||
                (typeof res.body === 'string' ? res.body.slice(0, 200) : '') || 'unknown error';
    const e = new Error(`Scheduler ${options.method || 'GET'} ${apiPath} → ${res.status}: ${msg}`);
    e.status = res.status >= 400 && res.status < 500 ? 502 : 502;   // their 4xx is our 502
    e.upstreamStatus = res.status;
    e.body = res.body;
    throw e;
  }
  return res.body;
}

// Every GET in §4.4 is UNAUTHENTICATED on the staffing side, but we send the
// token anyway: if Tom ever gates the read routes (R3/R29), this keeps working
// with no change.
const schedulerGet = (p) => schedulerFetch(p, { method: 'GET' });

// ════════════════════════════════════════════════════════════════════════════
// MAPPING — the fourteen fixes (§2.4)
// ════════════════════════════════════════════════════════════════════════════

// M1 — the staffing category vocabulary is a CLOSED 7-key enum living in the
// frontend (staffing/index.html:4392-4400). The DB column is free text, so a
// value outside these seven is stored and then INVISIBLE: every render path
// iterates BOOKING_CATEGORIES and filters `b.category === cat.key`. The old
// Showrunner values ('Trucking', 'Hotel', 'Rental', …) matched NONE of them.
const SCHED_BOOKING_CATEGORIES = ['trucking', 'forklift', 'feeder_cable',
                                  'install_labor', 'strike_labor', 'hotel', 'other'];

// M1/M2/M14. Order is load-bearing: `hotel` first so "hotel block for the
// install crew" is not labor, and `strike_labor` before `install_labor` because
// both match /labor/. 'Travel' and 'Power/Cable' are GONE — travel is not a
// booking (it is travel_info) and power/cable is feeder_cable.
function deriveBookingCategory(title) {
  const s = String(title || '').toLowerCase();
  if (/hotel|lodging|room|motel/.test(s))                       return 'hotel';   // M2: LOWERCASE
  if (/truck|freight|shipping|ship|carrier|ltl/.test(s))        return 'trucking';
  if (/forklift|telehandler|scissor|boom|lift/.test(s))         return 'forklift';
  if (/feeder|cable|power|distro|generator|genny/.test(s))      return 'feeder_cable';
  if (/strike|load[- ]?out|tear[- ]?down|breakdown/.test(s))    return 'strike_labor';
  if (/install|load[- ]?in|stagehand|labor|hands|crew/.test(s)) return 'install_labor';
  return 'other';        // the real title always rides along in customLabel
}

// M3 — staffing's two states are 'booked' and 'needed' (index.html:5215,5267).
// The old code emitted 'confirmed', which renders as amber ⚡ NEEDED forever
// and never counts toward "booked".
function mapBookingStatus(status) { return status === 'done' ? 'booked' : 'needed'; }

function mapEventType(t) { return t === 'print' ? 'Print' : t === 'both' ? 'Both' : 'LED'; }

// ── M5 — the travel_key sentinel forms (§4.2) ───────────────────────────────
// Three legal forms, and the two sentinels are MANDATORY. Writing an empty
// segment ("Tom|12|") stores a row the staffing UI will never look up, because
// its own lookup constructs "Tom|12|outbound" for that case. Note the
// asymmetry: BOTH sentinel forms put the event id in position 1.
function travelKey(person, idA, idB) { return `${person}|${idA}|${idB}`; }
function arrivalKey(person, prevEventId, eventId) {
  return prevEventId ? travelKey(person, prevEventId, eventId) : `${person}|${eventId}|inbound`;
}
function departureKey(person, eventId, nextEventId) {
  return nextEventId ? travelKey(person, eventId, nextEventId) : `${person}|${eventId}|outbound`;
}

// ════════════════════════════════════════════════════════════════════════════
// READ-BACK (§4.4) — no staffing-side change is required for any of this
// ════════════════════════════════════════════════════════════════════════════

// GET /api/travel returns an OBJECT keyed by travel_key (not an array), for the
// whole table, unfiltered. The disambiguation below reproduces the packet
// builder's own reading of the key exactly (staffing/server.js:1927-1941).
async function fetchTravelForEvent(eventId) {
  const all = await schedulerGet('/api/travel');
  const id = String(eventId);
  const arrivals = {};
  const departures = {};
  for (const [key, v] of Object.entries(all || {})) {
    const p = String(key).split('|');
    if (p.length < 3) continue;                       // malformed keys silently dropped
    const person = p[0];
    if (p[2] === id) arrivals[person] = { ...v, key };            // this event is the "next"
    else if (p[1] === id) {
      if (p[2] === 'inbound') arrivals[person] = { ...v, key };   // arrival, no prev event
      else departures[person] = { ...v, key };                    // departure, incl. 'outbound'
    }
  }
  return { arrivals, departures };
}

// A hotel is NOT in travel_info — it is a bookings row with category 'hotel'
// and the occupants in staff_assigned. dbToBooking already parses that JSONB
// into a real array, so no JSON.parse here.
async function fetchHotelsForEvent(eventId) {
  const rows = await schedulerGet(`/api/bookings?eventId=${encodeURIComponent(eventId)}`);
  return (Array.isArray(rows) ? rows : []).filter((b) => b && b.category === 'hotel');   // LOWERCASE
}

function hotelForPerson(hotels, personName) {
  const k = String(personName || '').toLowerCase().trim();
  if (!k) return null;
  return (hotels || []).find((h) =>
    (Array.isArray(h.staffAssigned) ? h.staffAssigned : []).some(
      (n) => String(n).toLowerCase().trim() === k)) || null;
}

// The canonical-name contract (M6): staffing keys its roster on
// name.toLowerCase().trim(). A miss means no email, no colour chip, no tech
// packet — silently.
async function fetchRoster() {
  const rows = await schedulerGet('/api/roster');
  return Array.isArray(rows) ? rows : [];
}

// Everything a call sheet needs from the scheduler, in one call, and NEVER
// fatal: if the scheduler is unreachable the sheet must still render from local
// data. The `unavailable` field says what happened instead of pretending the
// person has no travel booked.
async function fetchShowTravelBundle(eventId) {
  if (!eventId) return { linked: false, arrivals: {}, departures: {}, hotels: [] };
  if (!schedulerCredentialed()) {
    return { linked: true, arrivals: {}, departures: {}, hotels: [],
             unavailable: 'scheduler not configured (SCHEDULER_BASE_URL / SCHEDULER_USER / SCHEDULER_PASS)' };
  }
  try {
    const [travel, hotels] = await Promise.all([
      fetchTravelForEvent(eventId),
      fetchHotelsForEvent(eventId)
    ]);
    return { linked: true, arrivals: travel.arrivals, departures: travel.departures, hotels };
  } catch (e) {
    return { linked: true, arrivals: {}, departures: {}, hotels: [],
             unavailable: e && e.message ? e.message : String(e) };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PAYLOAD BUILDING — what the dry run shows and what the live push sends,
// from ONE function, so they can never drift.
// ════════════════════════════════════════════════════════════════════════════

// M6 — crew names must be CANONICAL roster names before they cross the wire.
// Showrunner owners may be "roster name / username / role token", and pushing
// `lead_tech` as a crew member produces a ghost with no email and no packet.
function resolveCrewNames(rawNames, rosterRows) {
  const byKey = new Map();
  for (const r of (rosterRows || [])) {
    const n = String(r && r.name || '').toLowerCase().trim();
    if (n) byKey.set(n, r.name);
    const u = String(r && r.username || '').toLowerCase().trim();
    if (u && !byKey.has(u)) byKey.set(u, r.name);
  }
  const resolved = [];
  const unmatched = [];
  for (const raw of rawNames) {
    const k = String(raw || '').toLowerCase().trim();
    if (!k) continue;
    if (byKey.has(k)) { if (!resolved.includes(byKey.get(k))) resolved.push(byKey.get(k)); }
    else unmatched.push(raw);
  }
  return { resolved, unmatched };
}

// One leg of crew_assignments.travel -> one POST /api/travel body.
// The staffing route is an UPSERT on travel_key, so re-pushing the same key
// updates in place — idempotent by construction, no delete needed (§2.6). A
// missing `key` inserts travel_key = null, violates NOT NULL, and 500s: guarded.
function travelLegPayload(key, leg, { goingHome = false } = {}) {
  const l = leg || {};
  return {
    key,
    flightNum:     l.flight_num || l.flightNum || '',
    arrivalTime:   l.arrival_time || l.arrivalTime || '',
    arrivalDate:   l.arrival_date || l.arrivalDate || '',
    isDriving:     !!(l.is_driving !== undefined ? l.is_driving : l.isDriving),
    departureCity: l.departure_city || l.departureCity || '',
    departureDate: l.departure_date || l.departureDate || '',
    departureTime: l.departure_time || l.departureTime || '',
    goingHome:     l.going_home !== undefined ? !!l.going_home
                 : l.goingHome !== undefined ? !!l.goingHome : !!goingHome,
    recordLocator: l.record_locator || l.recordLocator || ''
  };
}

// M4 — travel was NEVER pushed. buildSchedulerPayloads returned five keys and
// none of them was travel, and the commented live path had no /api/travel call.
// Showrunner's own call sheet then read back travel Showrunner never wrote.
//
// `nameFor` maps a crew row to the canonical roster name (M6). `eventId` is the
// staffing event id when known; before the event exists we emit the sentinel
// with a placeholder so the dry run still shows the SHAPE.
function buildTravelPayloads(crew, { nameFor, eventId }) {
  const out = [];
  const id = eventId == null ? '<eventId>' : String(eventId);
  for (const row of (crew || [])) {
    const t = row && row.travel;
    if (!t || typeof t !== 'object') continue;
    const person = nameFor(row);
    if (!person) continue;

    // OUTBOUND-FROM-HOME = the arrival at THIS event. When the mirror already
    // carries an explicit travel_key naming a real neighbouring event, honour
    // it — that is the shared-leg form, and writing a second row for the same
    // physical leg is exactly what §4.2 forbids.
    if (t.out) {
      const explicit = t.out.travel_key || t.out.key;
      out.push({ leg: 'arrival', person,
                 ...travelLegPayload(explicit || arrivalKey(person, null, id), t.out) });
    }
    if (t.back) {
      const explicit = t.back.travel_key || t.back.key;
      out.push({ leg: 'departure', person,
                 ...travelLegPayload(explicit || departureKey(person, id, null), t.back,
                                     { goingHome: true }) });
    }
  }
  return out;
}

// The single source of truth for the field mapping. `roster` is optional; when
// supplied, crew names are canonicalized (M6) and `unmatchedCrew` is reported.
function buildSchedulerPayloads(project, show, steps, crew, { roster = null, eventId = null } = {}) {
  const rawCrew = [...new Set([
    ...steps.filter((s) => s.lane === 'crew' && s.owner && s.status !== 'na').map((s) => String(s.owner).trim()),
    ...crew.map((c) => String(c.name || c.username || '').trim()).filter(Boolean)
  ])].filter(Boolean);

  // M6. Without a roster we cannot canonicalize; say so rather than guessing.
  const { resolved, unmatched } = roster
    ? resolveCrewNames(rawCrew, roster)
    : { resolved: rawCrew, unmatched: [] };
  const crewNames = resolved;

  // canonical name for a crew row, for travel keys
  const rosterByKey = new Map();
  for (const r of (roster || [])) {
    const n = String(r.name || '').toLowerCase().trim();
    if (n) rosterByKey.set(n, r.name);
    const u = String(r.username || '').toLowerCase().trim();
    if (u && !rosterByKey.has(u)) rosterByKey.set(u, r.name);
  }
  const nameFor = (row) => {
    const cand = String(row.name || row.username || '').trim();
    if (!cand) return '';
    return rosterByKey.get(cand.toLowerCase()) || cand;
  };

  const eventPayload = {
    event: show.name || project.name,
    // M13 — eventDate:'' stores an empty string, not NULL, and '' sorts before
    // real dates in staffing's ORDER BY. Omit the key instead.
    ...(show.event_date ? { eventDate: show.event_date } : {}),
    setup: show.load_in_date || '',
    breakdown: show.strike_date || '',
    setupTime: show.load_in_time || '',
    eventTime: show.event_time || '',
    location: show.venue || '',
    staff: crewNames,
    notes: project.description || '',
    clientId: null,                      // filled by the live path (M12)
    eventType: mapEventType(project.type),
    // M7 — shipOutDate/shipReturnDate were hardcoded ''. flexCreateEventFolder
    // computes startSource = shipOutDate || setup and THROWS when both are
    // falsy, surfacing as an opaque 502. We still send '' (Showrunner has no
    // ship dates), which is why the live path REFUSES a show with no load-in.
    shipOutDate: '', shipReturnDate: '', noShipOut: false, noShipReturn: false
    // M9 — mediaServer / techNotes / archived are DELIBERATELY ABSENT. On a
    // create, staffing applies its own defaults ('N/A', '', false). On an
    // update the live path read-modify-writes, so the operator's typing
    // survives. Hardcoding them here is what wiped it.
    // M11 — the five legacy clientContact* fields are DELIBERATELY ABSENT.
    // Company-only is inert clutter that the boot-time backfill can resurrect
    // as a duplicate contact (R14). The multi-row client_contacts table is the
    // live one.
  };

  const bookings = steps.filter((s) => s.lane === 'logistics').map((s, i) => ({
    category: deriveBookingCategory(s.title),          // M1/M2
    customLabel: s.title,
    // M10 — vendorName was sourced from evidence_ref, which is a free-text
    // evidence POINTER (a URL, a doc link), not a vendor. It renders as the
    // vendor in tech packets. Leave it empty; the ref rides in notes.
    vendorName: '',
    contactName: '', contactPhone: '', contactEmail: '',
    quantity: '1',                                     // R10: the column is TEXT
    status: mapBookingStatus(s.status),                // M3
    startDate: show.load_in_date || '',
    endDate: show.strike_date || '',
    confirmationNumber: '',
    notes: [s.notes || '', s.evidence_type === 'booking' && s.evidence_ref
             ? `ref: ${s.evidence_ref}` : ''].filter(Boolean).join(' — '),
    staffAssigned: s.owner ? (roster ? resolveCrewNames([s.owner], roster).resolved : [String(s.owner).trim()]) : [],
    sortOrder: i
  }));

  const venueContacts = [];
  if (show.on_site_poc) venueContacts.push({ name: show.on_site_poc, role: 'On-site POC', phone: '', email: '' });
  if (show.venue_poc && show.venue_poc.name) {
    venueContacts.push({ name: show.venue_poc.name, role: show.venue_poc.title || 'Venue',
                         phone: show.venue_poc.phone || '', email: '' });
  }
  steps.filter((s) => s.lane === 'venue' && s.owner)
    .forEach((s) => venueContacts.push({ name: s.owner, role: s.title, phone: '', email: '' }));
  venueContacts.forEach((v, i) => { v.sortOrder = i; });

  const clientContacts = steps.filter((s) => s.lane === 'client' && s.owner).map((s) => ({
    name: s.owner, title: s.title, company: project.client || '', phone: '', email: ''
  }));
  if (show.client_poc && show.client_poc.name) {
    clientContacts.unshift({ name: show.client_poc.name, title: show.client_poc.title || '',
                             company: project.client || '', phone: show.client_poc.phone || '', email: '' });
  }
  clientContacts.forEach((c, i) => { c.sortOrder = i; });

  // M4 — the payload that never existed.
  const travel = buildTravelPayloads(crew, { nameFor, eventId });

  return { eventPayload, bookings, venueContacts, clientContacts, crewNames, travel,
           unmatchedCrew: unmatched };
}

// ════════════════════════════════════════════════════════════════════════════
// PRE-FLIGHT VALIDATION (§2.7 step 1)
// ════════════════════════════════════════════════════════════════════════════
// R23: POST /api/events performs NO validation whatsoever. A missing `event`
// comes back as a raw Postgres message inside a 500. Validate here or get
// unactionable errors.
function validateForPush(project, show, payloads, roster) {
  const problems = [];
  if (!String(payloads.eventPayload.event || '').trim()) {
    problems.push('The show has no name (staffing events.event is NOT NULL — a blank name is a raw 500).');
  }
  // M7 — no load-in date means the event can never get a Flex folder, and the
  // failure surfaces as a 502 from /flex/create-element, not a validation error.
  if (!show.load_in_date) {
    problems.push('The show has no load-in date. staffing derives the Flex folder start from ' +
                  '(shipOutDate || setup); with neither, creating the Flex Event Folder throws.');
  }
  if (roster && payloads.unmatchedCrew.length) {
    // M6 — refuse rather than write a ghost.
    problems.push(`These crew names do not match the staffing roster: ${payloads.unmatchedCrew.join(', ')}. ` +
                  'A non-matching name silently gets no email, no colour chip and no tech packet. ' +
                  'Fix the owner/crew name in Showrunner, or add the person to the staffing roster.');
  }
  for (const t of payloads.travel) {
    if (!t.key || /\|\s*$/.test(t.key)) {
      problems.push(`Travel leg for ${t.person} has an empty key segment — the staffing UI would never ` +
                    "find it. Use the 'inbound'/'outbound' sentinels (§4.2).");
    }
  }
  return problems;
}

// ════════════════════════════════════════════════════════════════════════════
// THE LIVE PUSH (§2.7)
// ════════════════════════════════════════════════════════════════════════════

// M12 — the resolver GETs /api/clients and matches case-insensitively, else
// POSTs. POST returns 400 'Client name already exists' on a unique violation,
// so a 400 means "someone else created it" — re-GET and match, never fatal.
async function resolveClientId(clientName) {
  const name = String(clientName || '').trim();
  if (!name) return null;
  const match = (rows) => (Array.isArray(rows) ? rows : []).find(
    (c) => String(c.name || '').toLowerCase().trim() === name.toLowerCase());
  let found = match(await schedulerGet('/api/clients'));
  if (found) return found.id;
  try {
    const created = await schedulerFetch('/api/clients', { method: 'POST', body: JSON.stringify({ name }) });
    if (created && created.id) return created.id;
  } catch (e) {
    if (e.upstreamStatus !== 400) throw e;      // a real failure
  }
  found = match(await schedulerGet('/api/clients'));
  return found ? found.id : null;
}

// M8 — re-push duplicated EVERY child row: the old live path unconditionally
// POSTed each booking / contact, so {force:true} appended a second full set.
// There is no upsert and no delete-first on the staffing side.
//
// OWNERSHIP (§2.7): staffing has no `source` column on the child tables, so we
// cannot tell our rows from Brendon's. Option (a), the no-schema-change one:
// Showrunner remembers the ids it created in shows.pushed_child_ids and deletes
// ONLY those. Rows a human added by hand survive a re-push untouched.
async function deleteTrackedChildren(tracked) {
  const removed = { bookings: 0, venueContacts: 0, clientContacts: 0 };
  const paths = { bookings: '/api/bookings', venueContacts: '/api/venue-contacts',
                  clientContacts: '/api/client-contacts' };
  for (const [key, base] of Object.entries(paths)) {
    for (const id of ((tracked && tracked[key]) || [])) {
      try {
        await schedulerFetch(`${base}/${id}`, { method: 'DELETE' });
        removed[key] += 1;
      } catch (e) {
        // Already gone (someone deleted it in staffing) is a success for our
        // purposes: the goal is "no duplicate", not "this id existed".
        if (e.upstreamStatus !== 404) throw e;
      }
    }
  }
  return removed;
}

// The whole §2.7 algorithm. Resumable, not atomic — `onEventId` is called the
// moment the event exists so the caller can persist scheduler_event_id BEFORE
// the fan-out, which is what makes a retry an update instead of a duplicate.
async function pushShowToScheduler({ project, show, steps, crew, tracked, onEventId }) {
  if (!schedulerConfigured()) throw notConfigured('SCHEDULER_BASE_URL');

  // 0/1. token + roster, then validate.
  await schedulerToken(false);
  const roster = await fetchRoster();
  let payloads = buildSchedulerPayloads(project, show, steps, crew,
    { roster, eventId: show.scheduler_event_id || null });
  const problems = validateForPush(project, show, payloads, roster);
  if (problems.length) {
    const e = new Error('Push refused — the show is not ready for the scheduler.');
    e.status = 422;
    e.extra = { problems, payloads };
    throw e;
  }

  // 2. clientId (M12)
  const clientId = await resolveClientId(project.client);
  payloads.eventPayload.clientId = clientId;

  // 3. event: create, or read-modify-write (M9).
  let eventId = show.scheduler_event_id || null;
  let created = false;
  if (eventId) {
    const events = await schedulerGet('/api/events');
    const cur = (Array.isArray(events) ? events : []).find((e) => Number(e.id) === Number(eventId));
    if (!cur) {
      eventId = null;                       // deleted in staffing — treat as unlinked
    } else {
      // R8 — PUT is a FULL 23-column REPLACE. Anything omitted is written as
      // its DEFAULT, not preserved: techNotes erased, archived un-set, staff
      // emptied. So merge onto the row that is actually there.
      const merged = { ...cur, ...payloads.eventPayload };
      await schedulerFetch(`/api/events/${eventId}`, { method: 'PUT', body: JSON.stringify(merged) });
    }
  }
  if (!eventId) {
    const ev = await schedulerFetch('/api/events', {
      method: 'POST', body: JSON.stringify(payloads.eventPayload) });
    if (!ev || !ev.id) { const e = new Error('Scheduler created no event id'); e.status = 502; throw e; }
    eventId = ev.id;
    created = true;
  }
  // Persist NOW. A failure past this line leaves a linked, half-populated
  // event that a retry repairs — not an orphan that a retry duplicates.
  if (onEventId) await onEventId(eventId);

  // Rebuild travel now that the real event id exists (the sentinels embed it).
  payloads = buildSchedulerPayloads(project, show, steps, crew, { roster, eventId });
  payloads.eventPayload.clientId = clientId;

  // 4. children — DELETE the ones we created, then INSERT the new set (M8).
  const removed = await deleteTrackedChildren(tracked);
  const newTracked = { bookings: [], venueContacts: [], clientContacts: [] };
  for (const b of payloads.bookings) {
    const r = await schedulerFetch('/api/bookings', {
      method: 'POST', body: JSON.stringify({ ...b, eventId }) });
    if (r && r.id) newTracked.bookings.push(r.id);
  }
  for (const v of payloads.venueContacts) {
    const r = await schedulerFetch('/api/venue-contacts', {
      method: 'POST', body: JSON.stringify({ ...v, eventId }) });
    if (r && r.id) newTracked.venueContacts.push(r.id);
  }
  for (const c of payloads.clientContacts) {
    const r = await schedulerFetch('/api/client-contacts', {
      method: 'POST', body: JSON.stringify({ ...c, eventId }) });
    if (r && r.id) newTracked.clientContacts.push(r.id);
  }

  // 5. travel — upsert per leg, no delete needed (M4/M5/§2.6).
  let travelPushed = 0;
  for (const t of payloads.travel) {
    const { leg, person, ...body } = t;          // eslint-disable-line no-unused-vars
    await schedulerFetch('/api/travel', { method: 'POST', body: JSON.stringify(body) });
    travelPushed += 1;
  }

  return {
    eventId,
    created,
    clientId,
    counts: {
      bookings: newTracked.bookings.length,
      venueContacts: newTracked.venueContacts.length,
      clientContacts: newTracked.clientContacts.length,
      travel: travelPushed
    },
    removed,
    tracked: newTracked,
    crewNames: payloads.crewNames,
    payloads
  };
}

module.exports = {
  // config
  schedulerBaseUrl, schedulerConfigured, schedulerCredentialed, notConfigured,
  // transport
  schedulerToken, schedulerResetToken, schedulerFetch, schedulerGet,
  // mapping
  SCHED_BOOKING_CATEGORIES, deriveBookingCategory, mapBookingStatus, mapEventType,
  travelKey, arrivalKey, departureKey, travelLegPayload,
  resolveCrewNames, buildSchedulerPayloads, buildTravelPayloads, validateForPush,
  // read-back
  fetchTravelForEvent, fetchHotelsForEvent, hotelForPerson, fetchRoster, fetchShowTravelBundle,
  // push
  resolveClientId, deleteTrackedChildren, pushShowToScheduler
};
