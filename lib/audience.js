// ════════════════════════════════════════════════════════════════════════════
// lib/audience.js — F5. ASSIGNMENT IS SUBSCRIPTION
// ────────────────────────────────────────────────────────────────────────────
// Tom's north star (TEAM_FEEDBACK): *"a change made anywhere becomes visible to
// everyone it affects, without the person who made it having to remember to
// tell anyone."*
//
// The coherence review found the structural reason it did not: **nothing in the
// app had an audience.** 68 activity verbs, 128 logActivity call sites, and
// exactly four places that enqueued a notification — an @mention, a notify-
// picker pick, a step assignment and a report nag. Every one of them is
// push-BY-NAME. Being on a show's crew, owning one of its steps, owning the
// show or owning the folder created no standing interest in anything.
//
// This module is the missing half, and ONLY that half. It does not deliver
// anything: lib/notify.js's outbox, per-(user,kind) preferences, digest row,
// skip-if-read and driver were all finished already. What was missing was
// *who to address*, so that is all this file answers.
//
// ── THE TWO RULES THAT LIVE HERE ────────────────────────────────────────────
//
// 1. THE AUDIENCE OF A SHOW is derived, never stored:
//        the show's owner
//      + the folder's owner
//      + everyone who owns a step on it
//      + everyone on its crew who has a login
//    Derived means it is always current — put someone on the crew today and
//    they hear about tomorrow's date change with no subscription record to
//    maintain and none to forget.
//
//    A local hire (crew row with a name and no username) is deliberately NOT in
//    it. They have no login and no inbox; pretending to notify them would be
//    the same lie the review caught elsewhere. The call sheet is how they find
//    out, and lib/reports.js already surfaces them as un-naggable.
//
// 2. MATERIAL vs ROUTINE decides whether the audience is addressed at all.
//    The review is explicit that the axis must not be create-vs-edit (F8): the
//    load-in moving from 08:00 to 05:00 the night before a show is an *edit*.
//    So materiality is expressed as the DIFF being non-empty over a named field
//    set (lib/activity.js diffFields) — the same array that gets logged. One
//    decision, one expression: if it was worth a diff it is worth telling the
//    people it lands on.
//
// ── HOW THIS COEXISTS WITH TONY'S PICKER ────────────────────────────────────
// It does not replace it and does not fight it. Tony's rule governs *ad-hoc*
// pings: the actor names people, they get a bell item. Tom's rule governs
// *material* changes: the show's team is auto-informed. The two channels are
// different — the picker writes an anchored NOTE (the bell), this writes an
// OUTBOX row (the mail/digest). A caller who passes `notify:[…]` still gets
// exactly what they always got, in addition.
//
// The default mode for kind 'change' is DIGEST (lib/enums.js), which is what
// makes this bind the team without spamming it: twelve field edits on a Tuesday
// are one digest row, not twelve emails.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool } = require('./db');
const notify = require('./notify');
const { changeSummary } = require('./activity');

// ── WHO ─────────────────────────────────────────────────────────────────────
// Returns canonical usernames, deduped, lower-cased for comparison but spelled
// as the roster spells them. Never throws: an audience that cannot be computed
// is an empty audience, and a notification is a side effect of the real work.
async function showAudience(q, showId, { includeCrew = true } = {}) {
  const c = q || pool;
  const out = new Map();          // lower -> canonical
  const add = (u) => {
    const s = String(u || '').replace(/^agent:/, '').trim();
    if (!s) return;
    if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  };
  try {
    const show = (await c.query(
      'SELECT id, owner, project_id FROM shows WHERE id=$1', [showId])).rows[0];
    if (!show) return [];
    add(show.owner);
    if (show.project_id) {
      const p = (await c.query('SELECT owner FROM projects WHERE id=$1', [show.project_id])).rows[0];
      if (p) add(p.owner);
    }
    const steps = await c.query(
      `SELECT DISTINCT owner FROM steps WHERE show_id=$1 AND owner IS NOT NULL AND owner <> ''`,
      [showId]);
    for (const r of steps.rows) add(r.owner);
    if (includeCrew) {
      // Only crew WITH a login. A local hire has no inbox — see the header.
      const crew = await c.query(
        `SELECT DISTINCT username FROM crew_assignments
          WHERE show_id=$1 AND username IS NOT NULL AND username <> ''`, [showId]);
      for (const r of crew.rows) add(r.username);
    }
  } catch {
    return [];
  }
  // Only people who can actually sign in and read it.
  const names = Array.from(out.values());
  if (!names.length) return [];
  try {
    const live = await c.query(
      `SELECT username FROM users WHERE active = TRUE AND LOWER(username) = ANY($1::text[])`,
      [names.map((n) => n.toLowerCase())]);
    return live.rows.map((r) => r.username);
  } catch {
    return names;
  }
}

// The folder-level audience: the folder owner plus every show's audience.
async function projectAudience(q, projectId) {
  const c = q || pool;
  const out = new Map();
  const add = (u) => {
    const s = String(u || '').replace(/^agent:/, '').trim();
    if (s && !out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  };
  try {
    const p = (await c.query('SELECT owner FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!p) return [];
    add(p.owner);
    const shows = await c.query('SELECT id FROM shows WHERE project_id=$1', [projectId]);
    for (const s of shows.rows) {
      for (const u of await showAudience(c, s.id)) add(u);
    }
  } catch {
    return [];
  }
  return Array.from(out.values());
}

// ── WHAT THEY ARE TOLD ──────────────────────────────────────────────────────
// One line naming the thing, one line naming the diff. Deliberately terse: the
// digest that carries it counts items, and a person scanning ten of these wants
// the noun and the delta, not a paragraph.
function changeBody({ what, changes, actor, extra = '' }) {
  const lines = [];
  if (changes && changes.length) {
    for (const ch of changes) {
      lines.push(`  ${ch.label}: ${ch.from == null ? '—' : ch.from} → ${ch.to == null ? '—' : ch.to}`);
    }
  }
  return [
    `${actor || 'Someone'} changed ${what}.`,
    lines.length ? '' : null,
    lines.length ? lines.join('\n') : null,
    extra ? '' : null,
    extra || null,
    '',
    'You are on this show — you are told because of that, not because anyone remembered to tell you.'
  ].filter((l) => l !== null).join('\n');
}

// ── THE CALL EVERY MATERIAL MUTATION MAKES ──────────────────────────────────
// announceShowChange(c, { … }) — enqueue one outbox row per audience member.
//
// NEVER THROWS. A mail-layer problem must not roll back the date change that
// caused it; that is lib/notify.enqueue's contract and this preserves it.
// Returns the rows written (possibly []), so a caller — and the suite — can
// assert on the fan-out.
//
// `to` overrides the derived audience when a change has a narrower one (a step
// going blocked concerns its owner and the show owner, not the whole crew).
async function announceShowChange(q, {
  showId, projectId = null, actor, what, changes = null, subject = null,
  extra = '', kind = 'change', link = null, to = null
}) {
  try {
    const c = q || pool;
    const people = to && to.length ? to : await showAudience(c, showId);
    if (!people.length) return [];
    const summary = changeSummary(changes, '');
    return await notify.enqueueMany(c, people, {
      kind,
      subject: subject || `${what}${summary ? ' — ' + summary : ''}`,
      body: changeBody({ what, changes, actor, extra }),
      link: link || (showId ? `/#show/${showId}` : ''),
      projectId, showId, actor
    });
  } catch {
    return [];
  }
}

module.exports = { showAudience, projectAudience, announceShowChange, changeBody };
