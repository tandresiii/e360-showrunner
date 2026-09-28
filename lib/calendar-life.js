// ════════════════════════════════════════════════════════════════════════════
// lib/calendar-life.js — COMPANY LIFE, shared by the route and the digest
// (wave 4, 2026-09-28)
// ────────────────────────────────────────────────────────────────────────────
// Tom: "Would be cool if OOO calendar things are sent to people's digests —
// like maybe the option to notify your choice of people when created, then in
// global digests when it gets close to those days."
//
// Two consumers read calendar_entries: routes/calendar.js (the calendar) and
// lib/digest.js (the morning digest's "Company life" section). They must agree
// on exactly two things, so both live HERE, once:
//
//   · VISIBLE — the one visibility rule. A stranger's personal entry must never
//     be served to anyone, and a digest is a serving: the digest reads through
//     this same SQL fragment, never a second copy of it.
//   · THE YEARLY EXPANSION — a 'yearly' row's stored date is its ANCHOR; one
//     occurrence per year from the anchor year on, a Feb 29 anchor landing on
//     Feb 28 in a common year, a span keeping its length in every occurrence.
//     This is public/views-global.js calEntryItems' rule, server-side.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// THE VISIBILITY RULE, ONCE. $1 is the username whose eyes these are.
const VISIBLE = `(scope = 'team'
   OR (scope = 'personal' AND LOWER(created_by) = LOWER($1))
   OR (scope = 'directed' AND (LOWER(created_by) = LOWER($1)
        OR LOWER($1) IN (SELECT LOWER(u) FROM unnest(for_users) AS u))))`;

const SPAN_MAX_DAYS = 366;

function isoOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function shiftISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function yearlyOn(anchorISO, year) {
  let md = anchorISO.slice(5);
  if (md === '02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) md = '02-28';
  return year + '-' + md;
}

// Every occurrence of an entry whose covered days [start, end] touch the
// window [from, to] (inclusive ISO days). One-off rows yield at most one.
function occurrencesIn(e, from, to) {
  if (!e || !isoOk(e.date)) return [];
  const len = isoOk(e.end_date) && e.end_date > e.date
    ? Math.min(daysBetween(e.date, e.end_date), SPAN_MAX_DAYS) : 0;
  const starts = [];
  if (e.repeat === 'yearly') {
    const y0 = Math.max(Number(e.date.slice(0, 4)), Number(from.slice(0, 4)) - 1);
    const y1 = Number(to.slice(0, 4));
    for (let y = y0; y <= y1; y++) starts.push(yearlyOn(e.date, y));
  } else starts.push(e.date);
  return starts
    .map((st) => ({ start: st, end: len ? shiftISO(st, len) : st }))
    .filter((o) => o.start <= to && o.end >= from);
}

// ── words ───────────────────────────────────────────────────────────────────
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Thu Oct 1"
function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
// "Thu Oct 1 – Fri Oct 2", or the one day
function fmtRange(start, end) {
  return end && end !== start ? `${fmtDay(start)} – ${fmtDay(end)}` : fmtDay(start);
}
const KIND_WORD = { ooo: 'out of office', birthday: 'birthday', note: '' };
// "Jim — out of office, Thu Oct 1 – Fri Oct 2"; a plain note has no kind word
function lifeLine(label, kind, start, end) {
  const w = KIND_WORD[kind] || '';
  return `${label} — ${w ? w + ', ' : ''}${fmtRange(start, end)}`;
}

module.exports = {
  VISIBLE, SPAN_MAX_DAYS, occurrencesIn, yearlyOn, shiftISO, daysBetween,
  fmtDay, fmtRange, lifeLine, KIND_WORD
};
