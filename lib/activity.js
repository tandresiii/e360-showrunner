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

// The one writer. Everything mutating calls this; nothing INSERTs into
// `activity` directly.
async function logActivity(q, {
  projectId = null, showId = null, poId = null, jobId = null,
  actor, action, detail = '', accent = false, provenance = null
} = {}) {
  const r = await (q || pool).query(
    `INSERT INTO activity (project_id, show_id, po_id, job_id, actor, action, detail, accent, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [projectId, showId, poId, jobId, actor || 'system', action, detail || '',
     !!accent, provenance ? JSON.stringify(provenance) : null]
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

module.exports = { logActivity, actorUser, isAgentActor };
