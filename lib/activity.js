// ════════════════════════════════════════════════════════════════════════════
// lib/activity.js — the audit trail + agent transparency
// ────────────────────────────────────────────────────────────────────────────
// 11. `accent` flag column.  22. `actor` accepts 'agent:<username>' and the UI
// renders "Tom's agent".  §7. an optional `provenance` JSONB so the feed can
// render "filed by Tom's agent from email 'Re: LOVB invoices' — 93% (client,
// date, vendor history)" with a source_url link back to the original message.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool } = require('./db');

// ── F3. THE DIFF — what a changelog is actually made of ─────────────────────
// The coherence review's finding: only 14 of ~100 `detail:` strings carried a
// before→after, and NONE of the material ones did. `show.update · Wrigley
// Field` is the log line for a venue change, an owner change AND a date move —
// so "what changed" could not be built from the log at all.
//
// The fix is a STRUCTURED column, not a longer sentence. `changes` is
//   [{ field, label, from, to }, …]
// written in the same INSERT as the row, so a diff can never drift from the
// action it describes. `detail` still gets a human sentence built from the same
// array (see `changeSummary`) — one source, two renderings.
//
// Anything reading the log — the per-show feed, the cross-project feed, a
// digest — reads `changes`. Nothing parses `detail`.

// Compare two rows over a NAMED material set. `spec` is { column: 'Label' }.
// A field absent from the spec is by definition routine and produces no diff —
// which is the material-vs-routine classification the review asked for (F8),
// expressed as data rather than as an if-statement per route.
function diffFields(before, after, spec) {
  const out = [];
  for (const field of Object.keys(spec || {})) {
    const from = normalizeVal(before ? before[field] : undefined);
    const to = normalizeVal(after ? after[field] : undefined);
    if (from === to) continue;
    out.push({ field, label: spec[field] || field, from, to });
  }
  return out;
}

// Everything lands as a string or null so a diff compares and renders the same
// way whatever the column's postgres type is. `2500` and `'2500'` are the same
// contract value; a JSONB POC is compared by its JSON text.
function normalizeVal(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// The human sentence, built from the same array the column stores.
//   "event date 2026-03-04 → 2026-03-11 · venue — → Fiserv Forum"
function changeSummary(changes, fallback = '') {
  if (!changes || !changes.length) return fallback;
  return changes.map((c) =>
    `${c.label} ${c.from == null ? '—' : c.from} → ${c.to == null ? '—' : c.to}`
  ).join(' · ');
}

// The one writer. Everything mutating calls this; nothing INSERTs into
// `activity` directly.
async function logActivity(q, {
  projectId = null, showId = null, poId = null, jobId = null,
  actor, action, detail = '', accent = false, provenance = null, changes = null
} = {}) {
  const list = Array.isArray(changes) && changes.length ? changes : null;
  const r = await (q || pool).query(
    `INSERT INTO activity (project_id, show_id, po_id, job_id, actor, action, detail, accent,
                           provenance, changes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [projectId, showId, poId, jobId, actor || 'system', action, detail || '',
     !!accent, provenance ? JSON.stringify(provenance) : null,
     list ? JSON.stringify(list) : null]
  );
  return r.rows[0].id;
}

// 'agent:tom' -> 'tom'; 'tom' -> 'tom'. The UI reads the prefix, the server
// reads the person.
function actorUser(actor) {
  const s = String(actor || '');
  return s.startsWith('agent:') ? s.slice(6) : s;
}
function isAgentActor(actor) { return String(actor || '').startsWith('agent:'); }

module.exports = { logActivity, actorUser, isAgentActor, diffFields, changeSummary, normalizeVal };
