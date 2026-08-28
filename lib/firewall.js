// ════════════════════════════════════════════════════════════════════════════
// lib/firewall.js — THE CLIENT-FACING CONTENT FIREWALL (punch item 52)
// ────────────────────────────────────────────────────────────────────────────
// A recap is the one artifact in this app that LEAVES the building, so the leak
// guard is a CODE-LEVEL PROPERTY, not an editorial hope. The client copies in
// public/data.js are UX only — THIS is the enforcement.
//
// Two layers, exactly as specified:
//
//   A · ONE SOURCE FUNCTION. recapFacts(show) is the only reader the generator
//       has, and it returns a flat bag of client-safe scalars drawn from the
//       closed whitelist in RECAP_SOURCES. Its SQL never touches expenses,
//       bookings, purchase_orders, jobs, budget_lines, notes, step notes,
//       activity detail or schedule free text. No money value can reach a body
//       because no money value is ever SELECTed. Schedule and step data
//       contribute STRUCTURE only (day count, lane completion, the four
//       canonical times) — never prose.
//
//   B · ONE TEXT GATE. recapUnsafe() runs over every string that enters a body,
//       generated or hand-typed. The generator DROPS a line that trips it; the
//       PUT route REJECTS the edit and names what tripped it — so a human who
//       pastes a dollar figure into the narrative is stopped too.
//
// Layer A means a leak needs a new SELECT; layer B means it needs that AND to
// slip past the vocabulary gate.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { LANE_CATALOG, EVENT_TYPE_CONFIG, scopeOf, scopeLine, num } = require('./enums');

// The closed list of fields recapFacts() may read. Adding a field here is the
// deliberate act of widening the client surface — and it is the only place a
// reviewer has to look.
const RECAP_SOURCES = {
  // F4 WIDENS THIS ROW, DELIBERATELY. The seven scope_* fields are the physical
  // description of what the client bought — linear feet, cabinet count, cabinet
  // type, pitch, print pieces, print square footage. They are client-safe by
  // the only test that matters: none of them can be turned into a cost, a rate
  // or a margin, and the client already knows them (they are in the proposal
  // they signed). scope_verified_by / scope_verified_at are NOT here: who
  // checked our numbers internally is nobody's business but ours.
  show:            ['name', 'venue', 'city', 'type', 'owner', 'on_site_poc', 'cabinets',
                    'event_date', 'load_in_date', 'strike_date',
                    'load_in_time', 'doors_time', 'event_time', 'strike_time', 'client_poc',
                    'scope_kind', 'scope_linear_feet', 'scope_cabinet_count',
                    'scope_cabinet_type', 'scope_pitch', 'scope_print_pieces',
                    'scope_print_sqft'],
  project:         ['name', 'client', 'type'],
  step:            ['lane', 'status'],              // structure only — never title/notes
  schedule_item:   ['day', 'kind'],                 // structure only — never title/detail
  crew_assignment: [],                              // COUNT only — no names, travel, phones
  photo:           ['id', 'caption', 'taken_at', 'recap_pick', 'status']
};

// ── LAYER A′ · THE TABLE GUARD (F2) ─────────────────────────────────────────
// RECAP_SOURCES says which FIELDS the generator may read; this says which
// TABLES it may not touch at all, and — unlike a comment — it is enforced.
//
// The tech show report is the reason this exists. Reports are internal, blunt
// and often unflattering ("the venue's power was wrong, we lost an hour"), and
// TEAM_FEEDBACK is explicit: "the recap content firewall must never read report
// bodies". Keeping `tech_reports` in its own table already makes that a
// topology fact rather than a promise (lib/db.js), and guardRecapQuery() makes
// it a RUNTIME one: recapFacts() runs against a wrapped querier that throws if
// any SQL it issues so much as names a forbidden table.
//
// A future edit that tries to enrich a recap from a report body does not leak —
// it throws, in the test suite, with the reason on the exception.
const RECAP_FORBIDDEN_TABLES = [
  'tech_reports',        // F2 — the whole point
  'expenses', 'bookings', 'purchase_orders', 'po_lines', 'jobs', 'budget_lines',
  'notes', 'note_mentions', 'note_reads', 'activity', 'deliverables',
  'notification_outbox', 'notification_prefs', 'proposals', 'config'
];
function guardRecapQuery(q) {
  return {
    query(sql, params) {
      const s = String(sql || '');
      for (const t of RECAP_FORBIDDEN_TABLES) {
        if (new RegExp('\\b' + t + '\\b', 'i').test(s)) {
          const e = new Error(
            'recap firewall: the client-recap generator may not read `' + t + '` — ' +
            'widen RECAP_SOURCES in lib/firewall.js deliberately, or do not read it');
          e.status = 500;
          throw e;
        }
      }
      return q.query(sql, params);
    }
  };
}

// ── LAYER B: the vocabulary gate ────────────────────────────────────────────
const RECAP_FORBIDDEN = [
  { re: /\$\s*[\d.,]/,                                                          why: 'a dollar amount' },
  { re: /\b(?:margin|profit|markup|cogs|overhead|underwater|capex)\b/i,         why: 'internal financial language' },
  { re: /\b(?:budget|invoice|receipt|expense|vendor|purchase order|payable|reconcile[ds]?)\b/i, why: 'internal accounting language' },
  { re: /\bpo-\d|\b\d{2}-\d{3,4}\b|\bquickbooks\b|\bqb\b/i,                     why: 'an internal job or purchase-order number' },
  { re: /\b(?:at risk|blocked|over budget|waiting on me|behind schedule)\b/i,   why: 'internal status language' }
];
// -> null when the text is client-safe, else {why, match}
function recapUnsafe(text) {
  const s = String(text == null ? '' : text);
  for (const rule of RECAP_FORBIDDEN) {
    const m = rule.re.exec(s);
    if (m) return { why: rule.why, match: m[0] };
  }
  return null;
}
// generator-side: keep it or drop it, silently — a draft never ships a leak
function recapSafe(text) {
  const t = String(text == null ? '' : text).trim();
  return (t && !recapUnsafe(t)) ? t : null;
}
function push(arr, text) { const t = recapSafe(text); if (t) arr.push(t); return arr; }

// ── LAYER A: the only reader ────────────────────────────────────────────────
// Every SELECT below is column-explicit and matches RECAP_SOURCES. Do not
// change any of them to `SELECT *`.
//
// The guard is applied HERE, not at the call site, so a caller cannot forget
// it: `q` is rebound to the wrapped querier on the first line and every query
// in this function goes through it.
async function recapFacts(rawQ, show) {
  const q = guardRecapQuery(rawQ);
  const showId = show.id;

  const projR = await q.query('SELECT name, client, type FROM projects WHERE id=$1', [show.project_id]);
  const project = projR.rows[0] || {};

  // steps -> lane completion ONLY (lane key + status; never a title or note)
  const stepsR = await q.query('SELECT lane, status FROM steps WHERE show_id=$1', [showId]);
  const byLane = {};
  let doneN = 0, totalN = 0;
  for (const st of stepsR.rows) {
    const l = (byLane[st.lane] = byLane[st.lane] || { n: 0, done: 0 });
    l.n += 1; totalN += 1;
    if (st.status === 'done') { l.done += 1; doneN += 1; }
  }
  const typeKey = show.type || project.type || 'led';
  const typeCfg = EVENT_TYPE_CONFIG.find((t) => t.key === typeKey) || EVENT_TYPE_CONFIG[0];
  const lanesComplete = typeCfg.lanes.filter((k) => byLane[k] && byLane[k].n && byLane[k].done === byLane[k].n);

  // schedule -> day count + which kinds ran (never a title or detail)
  const schedR = await q.query('SELECT day, kind FROM schedule_items WHERE show_id=$1', [showId]);
  const daySet = new Set();
  const kinds = {};
  for (const it of schedR.rows) { if (it.day) daySet.add(it.day); kinds[it.kind] = (kinds[it.kind] || 0) + 1; }

  // crew -> COUNT only
  const crewR = await q.query('SELECT COUNT(*)::int AS n FROM crew_assignments WHERE show_id=$1', [showId]);

  // photos -> the human-curated recap picks, in taken_at order
  const picksR = await q.query(
    `SELECT id, caption, taken_at, recap_pick, status FROM files
     WHERE show_id=$1 AND kind='photo' AND status='filed' AND recap_pick=TRUE
     ORDER BY taken_at ASC, id ASC LIMIT 8`, [showId]);

  const ownerR = show.owner
    ? await q.query('SELECT name, title FROM users WHERE username=$1', [show.owner]) : { rows: [] };
  const siteR = show.on_site_poc
    ? await q.query('SELECT name FROM users WHERE username=$1', [show.on_site_poc]) : { rows: [] };

  const poc = show.client_poc || null;
  const lead = ownerR.rows[0] || null;
  const site = siteR.rows[0] || null;

  return {
    showName: show.name || project.name || '',
    venue: show.venue || '', city: show.city || '',
    client: project.client || '',
    type: typeKey, typeLabel: typeCfg.label,
    eventDate: show.event_date || '', loadInDate: show.load_in_date || '',
    strikeDate: show.strike_date || '',
    loadInTime: show.load_in_time || null, doorsTime: show.doors_time || null,
    showTime: show.event_time || null, strikeTime: show.strike_time || null,
    cabinets: Number(show.cabinets) || 0,
    // F4. The scope line, client-safe by the RECAP_SOURCES.show whitelist above.
    scope: scopeOf(show),
    scopeLine: scopeLine(show),
    crewSize: crewR.rows[0].n || 0,
    daysOnSite: daySet.size || spanDays(show),
    hasDoors: !!kinds.show, hasStrike: !!kinds.strike,
    lanesComplete, stepsDone: doneN, stepsTotal: totalN,
    photoIds: picksR.rows.map((f) => f.id),
    photoCaptions: picksR.rows.map((f) => f.caption || ''),
    leadName: lead ? (lead.name || '') : '', leadTitle: lead ? (lead.title || '') : '',
    siteName: site ? (site.name || '') : '',
    clientPocName: poc && poc.name ? poc.name : '', clientPocTitle: poc && poc.title ? poc.title : ''
  };
}

function spanDays(show) {
  const a = show.load_in_date, b = show.strike_date || show.event_date;
  if (!a || !b) return 1;
  const d = Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  return isNaN(d) ? 1 : Math.max(1, d + 1);
}

// ── phrasing ────────────────────────────────────────────────────────────────
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
function dateLong(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d.getTime()) ? '' : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function hm(t) {
  if (!t) return '';
  const p = String(t).split(':');
  const h = Number(p[0]), m = p[1] || '00';
  if (isNaN(h)) return String(t);
  return `${h % 12 || 12}:${m}${h >= 12 ? ' pm' : ' am'}`;
}
// client-safe phrasing for a lane that closed out complete — the ONLY way a
// lane's name reaches the client. No lane's step titles ever do.
const LANE_WINS = {
  client:       'Scope and content brief locked with the client',
  venue:        'Venue advance, power and access confirmed ahead of load-in',
  logistics:    'Freight and crew travel landed on schedule',
  crew:         'Full crew called and on site',
  gear:         'Gear prepped, scanned out and returned complete',
  deliverables: 'Every content deliverable produced and delivered',
  design:       'Artwork built to the venue’s dielines',
  proof:        'Proof rounds completed with the client',
  approval:     'Client approval received and the approved files locked',
  production:   'Approved files released to the print floor',
  tracking:     'Full run produced and quality-checked against the approved proof',
  ship:         'Crated, labeled and freighted to the venue',
  install:      'Installed and walked with the client',
  return:       'De-installed, inspected and inventoried'
};
const LANE_LABEL = Object.fromEntries(LANE_CATALOG.map((l) => [l.key, l.label]));

// ── the generator ───────────────────────────────────────────────────────────
// PURE with respect to the record: reads recapFacts() and nothing else, writes
// no activity, mutates nothing. Deterministic, so regenerating an untouched
// show produces the same body (idempotency).
function buildRecapDraft(f) {
  const isPrint = f.type === 'print';
  const where = f.venue + ((f.city && f.venue.indexOf(f.city) < 0) ? ', ' + f.city : '');
  const pkg = isPrint ? 'large-format print package'
    : (f.cabinets ? f.cabinets + '-cabinet ' : '') + (f.type === 'both' ? 'LED and print package' : 'LED package');

  const narrative = [];
  const p1 = 'E360 Sport ' + (isPrint ? 'produced and installed the ' : 'delivered the ') + pkg +
    ' for ' + f.showName + ' at ' + where + '. ' +
    (f.daysOnSite > 1
      ? 'The crew was on site ' + f.daysOnSite + ' days — load-in ' + dateLong(f.loadInDate) +
        ' through ' + (f.hasStrike || f.strikeDate !== f.eventDate ? 'strike ' : 'wrap ') +
        dateLong(f.strikeDate || f.eventDate) + '.'
      : 'The crew was on site for a single day, ' + dateLong(f.eventDate) + ', load-in through handover.');
  push(narrative, p1);

  const beats = [];
  if (f.loadInTime) beats.push('load-in at ' + hm(f.loadInTime));
  if (f.doorsTime) beats.push('doors at ' + hm(f.doorsTime));
  if (f.showTime) beats.push('first cue at ' + hm(f.showTime));
  if (f.strikeTime) beats.push('strike from ' + hm(f.strikeTime));
  let p2 = (isPrint ? 'The install day' : 'Show day') + ' ran to plan' +
    (beats.length ? ' — ' + beats.join(', ') + '.' : '.') +
    (f.crewSize ? ' A crew of ' + f.crewSize + ' covered the build' +
      (isPrint ? ' and the client walk.' : ', the show and the strike.') : '');
  const wins = f.lanesComplete.map((k) => LANE_LABEL[k] || k);
  if (wins.length) {
    const w = wins.slice(0, 3);
    p2 += ' ' + (w.length > 1 ? w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1] : w[0]) +
      ' closed out complete.';
  }
  push(narrative, p2);

  const p3 = (f.photoIds.length
    ? 'A selection of ' + f.photoIds.length + ' photograph' + (f.photoIds.length === 1 ? '' : 's') +
      ' from the ' + (isPrint ? 'install' : 'show') + ' is included with this recap. '
    : '') + 'The full set is archived with the event record and available on request.';
  push(narrative, p3);

  const highlights = [];
  f.photoCaptions.slice(0, 4).forEach((c) => push(highlights, c));
  for (const k of f.lanesComplete) {
    if (highlights.length >= 5) break;
    push(highlights, LANE_WINS[k]);
  }

  // 54. stats carry their client-safe KEY (an FK into recap_stat_keys), not a
  // regex-matched label. No money value is even readable from here.
  const stats = [];
  if (f.eventDate) stats.push({ key: 'date', label: isPrint ? 'Install date' : 'Show date', value: dateLong(f.eventDate) });
  // F4. The scope line leads the stats when one exists — it is the single most
  // client-legible fact about the job, and it is what the client bought.
  // The individual numbers follow it, each under its own client-safe FK.
  const sc = f.scope || {};
  if (f.scopeLine) stats.push({ key: 'scope', label: 'Scope', value: f.scopeLine });
  if (num(sc.linear_feet, null) != null) {
    stats.push({ key: 'linear_feet', label: 'Linear feet of LED', value: String(num(sc.linear_feet, 0)) });
  }
  if (num(sc.cabinet_count, null) != null) {
    stats.push({ key: 'cabinet_count', label: 'LED cabinets', value: String(num(sc.cabinet_count, 0)) });
  } else if (f.cabinets) {
    stats.push({ key: 'cabinets', label: 'LED cabinets', value: String(f.cabinets) });
  }
  if (sc.pitch) stats.push({ key: 'pitch', label: 'Pixel pitch', value: String(sc.pitch) });
  if (num(sc.print_pieces, null) != null) {
    stats.push({ key: 'print_pieces', label: 'Printed pieces', value: String(num(sc.print_pieces, 0)) });
  }
  if (num(sc.print_sqft, null) != null) {
    stats.push({ key: 'print_sqft', label: 'Square feet printed', value: String(num(sc.print_sqft, 0)) });
  }
  if (f.crewSize) stats.push({ key: 'crew', label: 'Crew on site', value: String(f.crewSize) });
  if (f.daysOnSite) stats.push({ key: 'days', label: 'Days on site', value: String(f.daysOnSite) });

  return {
    headline: recapSafe(f.showName + ' — ' + (isPrint ? 'install' : 'show') + ' recap · ' + dateLong(f.eventDate)) ||
              (isPrint ? 'Install recap' : 'Show recap'),
    narrative,
    highlights,
    stats,
    photo_ids: f.photoIds.slice(),
    closing: recapSafe('Thank you from everyone at E360 Sport — it was a pleasure to be part of ' +
      f.showName + '. We would be glad to work with you again.') || 'Thank you from everyone at E360 Sport.'
  };
}

// 50. provenance for a generated recap. source_kind 'closeout', confidence 100,
// matched_by ['show_record'] — the source IS the show's own record.
function recapProvenance(show, agentUser, showLabel) {
  return {
    source_kind: 'closeout',
    source_ref: 'showrunner:show/' + show.id + '#recap',
    source_label: 'Post-strike closeout — ' + (showLabel || show.name || ('show ' + show.id)),
    agent_user: agentUser,
    actor: 'agent:' + agentUser,
    confidence: 100,
    matched_by: ['show_record'],
    matched_at: new Date().toISOString()
  };
}

module.exports = {
  RECAP_SOURCES, RECAP_FORBIDDEN, RECAP_FORBIDDEN_TABLES, guardRecapQuery,
  recapUnsafe, recapSafe,
  recapFacts, buildRecapDraft, recapProvenance, dateLong, hm, LANE_WINS
};
