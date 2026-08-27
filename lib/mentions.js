// ════════════════════════════════════════════════════════════════════════════
// lib/mentions.js — @mention parsing + the notification principle
// ────────────────────────────────────────────────────────────────────────────
// Mention grammar (public/data.js parseMentions is the reference): '@' + first
// name OR username, case-insensitive, matched against the roster. Unknown
// tokens pass through as plain text and are simply not mentions.
//
// Parsing is SERVER-SIDE on every write and re-parsed on every edit (punch 37),
// so a client cannot claim a mention it did not type — and cannot suppress one
// it did.
//
// Notification principle (Tony, Roles section): the actor picks who to notify
// on significant actions; routine edits are silent. `notify` is an OPTIONAL
// param on mutating routes; it lands as note_mentions/inbox entries and is
// never forced.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool } = require('./db');

// username + first name -> username, built fresh per call from `users`. Small
// table, and a stale cache here would silently drop a new hire's mentions.
async function mentionLookup(q = pool) {
  const r = await q.query('SELECT username, name FROM users WHERE active IS NOT FALSE');
  const map = new Map();
  for (const u of r.rows) {
    map.set(u.username.toLowerCase(), u.username);
    const first = String(u.name || '').split(' ')[0];
    // A username always wins over someone else's first name.
    if (first && !map.has(first.toLowerCase())) map.set(first.toLowerCase(), u.username);
  }
  return map;
}

// '@Tom' / '@tandres' / '@CANDICE' -> ['tandres','candice']; '@nobody' ignored.
function parseMentionsWith(lookup, body) {
  const out = [];
  const seen = new Set();
  String(body || '').replace(/@([A-Za-z][A-Za-z0-9_]*)/g, (m, tok) => {
    const u = lookup.get(tok.toLowerCase());
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
    return m;
  });
  return out;
}
async function parseMentions(body, q = pool) {
  return parseMentionsWith(await mentionLookup(q), body);
}

// Validate an explicit notify/mentions list against the roster. AGENT_API §5:
// `mentions[]` must be existing usernames (400 otherwise).
async function resolveUsernames(list, q = pool) {
  const wanted = [...new Set((list || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return { valid: [], unknown: [] };
  const r = await q.query('SELECT username FROM users WHERE LOWER(username) = ANY($1::text[])', [wanted]);
  const found = new Set(r.rows.map((x) => x.username.toLowerCase()));
  return {
    valid: r.rows.map((x) => x.username),
    unknown: wanted.filter((w) => !found.has(w))
  };
}

// Write the mention FACT rows (punch 32 — separate from note_reads, which is
// read state). Idempotent.
async function recordMentions(q, noteId, usernames) {
  for (const u of usernames || []) {
    await q.query(
      `INSERT INTO note_mentions (note_id, username) VALUES ($1,$2)
       ON CONFLICT (note_id, username) DO NOTHING`, [noteId, u]);
  }
}
// A person's own note is read the moment it is written.
async function markRead(q, noteId, username) {
  await q.query(
    `INSERT INTO note_reads (note_id, username) VALUES ($1,$2)
     ON CONFLICT (note_id, username) DO NOTHING`, [noteId, username]);
}

// ── the notification principle, in one place ────────────────────────────────
// Tony's rule: the ACTOR picks who to notify on significant actions; routine
// edits are silent. `notify` is an OPTIONAL param on mutating routes — never
// forced — and it lands as an anchored note plus mention rows, which is what
// the bell already reads. An unknown username is a 400, not a silent drop: a
// notification that vanishes is worse than one that fails loudly.
//
// HARDENING 10. There were FOUR of these — this one, plus notifyFrom() in
// purchasing, deliverNotify() in schedule and applyNotify() in photos. Four
// copies of one mechanism, and they had quietly drifted apart on every axis
// that mattered:
//
//   · a non-array `notify` was a 400 in three of them and SILENTLY IGNORED here
//   · only purchasing accepted a comma-separated string
//   · only schedule dropped a self-notify
//   · only this one stripped the `agent:` prefix before marking its own note
//     read, so an agent's notify left the agent an unread mention of itself
//   · four different 400 messages for the same mistake
//
// They are one mechanism, so they are now one function. The differences that
// were REAL — where the note anchors, and how its one line reads — stay as
// parameters; the differences that were ACCIDENTS are gone. Each family keeps
// its own wording through `format`, which is the only thing a reader of those
// routes actually needed to see.
//
// Unified answers:
//   absent (undefined/null)  -> [] — silence is the default for routine edits
//   a string                 -> split on commas (purchasing's affordance)
//   anything else non-array  -> 400, loudly
//   an unknown username      -> 400, naming every one it did not recognise
//   the actor's own name     -> dropped; you are not notified of your own act
const DEFAULT_FORMAT = (summary, mentions) =>
  `${summary} ${mentions.map((u) => '@' + u).join(' ')}`.trim();

function notifyList(raw) {
  if (raw === undefined || raw === null) return null;         // silence
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(',');
  const e = new Error('notify must be an array of usernames');
  e.status = 400;
  throw e;
}

async function notifyTargets(c, {
  body, anchorType, anchorId, projectId = null, showId = null, actor, summary,
  format = DEFAULT_FORMAT
}) {
  const raw = body && (body.notify !== undefined ? body.notify : body.notifyUsers);
  const list = notifyList(raw);
  if (!list || !list.length) return [];
  const { valid, unknown } = await resolveUsernames(list, c);
  if (unknown.length) {
    const e = new Error(
      `Unknown user${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `'${u}'`).join(', ')} in notify`);
    e.status = 400;
    throw e;
  }
  // An actor is 'tandres' on the human surface and 'agent:tandres' on the agent
  // one; both mean the same person, and neither should be told about their own
  // action.
  const me = String(actor || '').replace(/^agent:/, '').toLowerCase();
  const targets = valid.filter((u) => u.toLowerCase() !== me);
  if (!targets.length) return [];

  const text = format(summary, targets);
  const ins = await c.query(
    `INSERT INTO notes (anchor_type, anchor_id, project_id, show_id, author, body, mentions)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [anchorType, anchorId, projectId, showId, actor, text, targets]);
  await recordMentions(c, ins.rows[0].id, targets);
  await markRead(c, ins.rows[0].id, me);
  return targets;
}

module.exports = {
  mentionLookup, parseMentions, parseMentionsWith, resolveUsernames,
  recordMentions, markRead, notifyTargets, DEFAULT_FORMAT
};
