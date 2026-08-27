// ════════════════════════════════════════════════════════════════════════════
// lib/agent.js — matching, confidence bands, idempotency, proposals
// ────────────────────────────────────────────────────────────────────────────
// AGENT_API.md §2 / §6 / §7 / §8, implemented as written. Matching lives
// SERVER-SIDE so it is consistent across every teammate's agent and improvable
// in one place — the agent never guesses against a list it scraped.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');
const { pool } = require('./db');
const { SOURCE_KINDS, MATCHED_BY, money, num, isISODate, isoDiffDays } = require('./enums');
const { badRequest, conflict, unprocessable } = require('./http');

// ════════════════════════════════════════════════════════════════════════════
// §2. CONFIDENCE BANDS — server-enforced, not advisory
// ════════════════════════════════════════════════════════════════════════════
//   high   >= 85  file directly            -> status 'filed'
//   medium 60–84  file AS A PROPOSAL        -> status 'proposed' + target
//   low    <  60  submit UNATTACHED         -> status 'proposed', no target
function bandFor(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'low';
  if (c >= 85) return 'high';
  if (c >= 60) return 'medium';
  return 'low';
}

// A write asking for status:'filed' below the band is REJECTED 422, never
// silently downgraded: a silent downgrade hides agent misbehaviour, a hard
// error shows up in the agent's transcript and in ours.
function assertBand(requestedStatus, confidence, ambiguous) {
  const status = requestedStatus === 'filed' ? 'filed' : 'proposed';
  const band = bandFor(confidence);
  if (status === 'filed') {
    if (band !== 'high') {
      throw unprocessable(
        `Confidence ${num(confidence, 0)} is '${band}' band — status:"filed" requires 85 or higher`,
        { band, confidence: num(confidence, 0), allowed: 'proposed' });
    }
    // ambiguous:true (top two within 10 points) forces a proposal regardless
    // of confidence: "confident about two different shows" is exactly the
    // wrong-folder failure we are guarding against.
    if (ambiguous) {
      throw unprocessable(
        'Ambiguous match (top two candidates within 10 points) — this must be filed as a proposal',
        { band, ambiguous: true, allowed: 'proposed' });
    }
  }
  return { status, band };
}

// ════════════════════════════════════════════════════════════════════════════
// §7. PROVENANCE — non-negotiable on every agent write
// ════════════════════════════════════════════════════════════════════════════
// agent_user and actor are SERVER-SET; a client value is ignored.
function normalizeProvenance(raw, agentUsername) {
  if (!raw || typeof raw !== 'object') {
    throw badRequest('provenance is required on every agent write (AGENT_API §7)');
  }
  const sourceKind = raw.sourceKind || raw.source_kind;
  const sourceRef = raw.sourceRef || raw.source_ref;
  if (!SOURCE_KINDS.includes(sourceKind)) {
    throw badRequest(`provenance.sourceKind must be one of: ${SOURCE_KINDS.join(', ')}`);
  }
  if (!sourceRef || typeof sourceRef !== 'string') {
    throw badRequest('provenance.sourceRef is required');
  }
  const rawMatched = raw.matchedBy || raw.matched_by || [];
  const matchedBy = (Array.isArray(rawMatched) ? rawMatched : [])
    .filter((t) => MATCHED_BY.includes(t));
  const confidence = num(raw.confidence, null);
  if (confidence == null || confidence < 0 || confidence > 100) {
    throw badRequest('provenance.confidence must be a number 0–100');
  }
  return {
    source_kind: sourceKind,
    source_ref: String(sourceRef).slice(0, 512),
    source_label: String(raw.sourceLabel || raw.source_label || '').slice(0, 512),
    source_url: raw.sourceUrl || raw.source_url || null,
    agent_user: agentUsername,                 // server-set
    actor: 'agent:' + agentUsername,           // server-set
    confidence,
    // A claimed confidence the server cannot corroborate is still accepted —
    // it is recorded as the AGENT'S CLAIM, so the audit shows who lied.
    matched_by: matchedBy,
    matched_at: new Date().toISOString()
  };
}

// ════════════════════════════════════════════════════════════════════════════
// §2. THE MATCHER
// ════════════════════════════════════════════════════════════════════════════
// Weighted signals, each one attributable to a `matchedBy` token so the answer
// carries its reasons. Deliberately explainable rather than clever: a PM has to
// be able to read `why` and agree or disagree.
const SIGNALS = {
  explicit_id:    { weight: 55, why: (v) => `explicit id ${v}` },
  job_number:     { weight: 40, why: (v) => `job number ${v} appears in the source` },
  client_name:    { weight: 25, why: (v) => `client '${v}' matches` },
  venue:          { weight: 20, why: (v) => `venue '${v}' appears in the source` },
  date_window:    { weight: 25, why: (v) => v },
  vendor_history: { weight: 20, why: (v) => v },
  participant:    { weight: 12, why: (v) => `participant ${v}` },
  thread_ref:     { weight: 18, why: (v) => `thread ${v} already filed here` },
  keyword:        { weight: 10, why: (v) => `'${v}' appears in the subject` }
};

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}
function contains(haystack, needle) {
  if (!needle) return false;
  return String(haystack || '').toLowerCase().includes(String(needle).toLowerCase());
}

async function matchCandidates(input, q = pool) {
  const subject = String(input.subject || '');
  const bodyExcerpt = String(input.bodyExcerpt || input.body_excerpt || '').slice(0, 4000);
  const haystack = (subject + ' ' + bodyExcerpt).toLowerCase();
  const dates = (input.dates || []).filter(isISODate);
  const vendors = (input.vendors || []).map((v) => String(v || '')).filter(Boolean);
  const participants = (input.participants || []).map((p) => String(p || '').toLowerCase());
  const hints = input.hints || {};
  const sourceRef = input.sourceRef || input.source_ref || null;

  // One pass over the joinable record. Bounded: shows carry their project and
  // default job, and we cap at a sane number of live folders.
  const rows = (await q.query(
    `SELECT s.id AS show_id, s.name AS show_name, s.venue, s.city, s.event_date, s.load_in_date,
            s.strike_date, s.default_job_id, s.stage AS show_stage,
            p.id AS project_id, p.name AS project_name, p.client, p.owner,
            j.id AS job_id, j.qb_job_number, j.client AS job_client
     FROM shows s
     JOIN projects p ON p.id = s.project_id
     LEFT JOIN jobs j ON j.id = s.default_job_id
     WHERE p.stage <> 'closed'
     ORDER BY s.event_date DESC NULLS LAST
     LIMIT 500`)).rows;

  // vendor history: which shows/jobs has this vendor billed to before?
  const vendorShows = new Map();
  if (vendors.length) {
    const vh = await q.query(
      `SELECT show_id, job_id, vendor FROM expenses
       WHERE show_id IS NOT NULL AND vendor <> '' AND LOWER(vendor) = ANY($1::text[])`,
      [vendors.map((v) => v.toLowerCase())]);
    for (const r of vh.rows) {
      if (!vendorShows.has(r.show_id)) vendorShows.set(r.show_id, new Set());
      vendorShows.get(r.show_id).add(r.vendor);
    }
  }
  // thread continuity: has anything from this exact source_ref already landed?
  const threadShows = new Set();
  if (sourceRef) {
    const th = await q.query(
      `SELECT DISTINCT show_id FROM files WHERE source_ref=$1 AND show_id IS NOT NULL
       UNION SELECT DISTINCT show_id FROM steps WHERE source_ref=$1 AND show_id IS NOT NULL`,
      [sourceRef]);
    for (const r of th.rows) threadShows.add(r.show_id);
  }

  const candidates = [];
  for (const r of rows) {
    const hits = [];
    const add = (token, value) => {
      hits.push({ token, weight: SIGNALS[token].weight, why: SIGNALS[token].why(value) });
    };

    if (hints.showId && Number(hints.showId) === r.show_id) add('explicit_id', `show ${r.show_id}`);
    else if (hints.projectId && Number(hints.projectId) === r.project_id) add('explicit_id', `project ${r.project_id}`);

    if (r.qb_job_number && contains(haystack, r.qb_job_number)) add('job_number', r.qb_job_number);

    const clientName = hints.clientName || hints.client_name;
    const clients = [r.client, r.job_client].filter(Boolean);
    for (const c of clients) {
      if ((clientName && contains(c, clientName)) || (clientName && contains(clientName, c))) {
        add('client_name', c); break;
      }
      if (contains(haystack, c)) { add('client_name', c); break; }
    }

    if (r.venue && (contains(haystack, r.venue) || tokens(r.venue).some((t) => haystack.includes(t) && t.length > 4))) {
      add('venue', r.venue);
    }

    // date window: load-in − 3 .. strike + 3, with a bonus for an exact hit
    if (dates.length) {
      let best = null;
      for (const d of dates) {
        if (d === r.event_date) { best = `${d} is the show date`; break; }
        if (d === r.load_in_date) { best = `${d} is load-in`; break; }
        const from = r.load_in_date || r.event_date;
        const to = r.strike_date || r.event_date;
        if (from && to) {
          const a = isoDiffDays(from, d);
          const b = isoDiffDays(d, to);
          if (a != null && b != null && a >= -3 && b >= -3) best = `${d} falls inside the show window`;
        }
      }
      if (best) add('date_window', best);
    }

    if (vendorShows.has(r.show_id)) {
      const names = [...vendorShows.get(r.show_id)];
      add('vendor_history', `${names[0]} has billed to this show before`);
    }
    if (threadShows.has(r.show_id)) add('thread_ref', sourceRef.slice(0, 24) + '…');

    if (participants.length && r.owner && participants.some((p) => p.startsWith(r.owner.toLowerCase() + '@'))) {
      add('participant', r.owner);
    }

    const nameTokens = tokens(r.show_name).concat(tokens(r.project_name));
    const kw = nameTokens.find((t) => t.length > 4 && haystack.includes(t));
    if (kw) add('keyword', kw);

    if (!hits.length) continue;

    // Score: additive, capped. Only an explicit id may reach 100 — everything
    // else tops out at 97, because inference is never certainty.
    const raw = hits.reduce((a, h) => a + h.weight, 0);
    const hasExplicit = hits.some((h) => h.token === 'explicit_id');
    const confidence = Math.min(raw, hasExplicit ? 100 : 97);

    candidates.push({
      projectId: r.project_id, projectName: r.project_name,
      showId: r.show_id, showName: r.show_name || r.venue,
      jobId: r.job_id || r.default_job_id || null, qbJobNumber: r.qb_job_number || null,
      confidence, band: bandFor(confidence),
      matchedBy: hits.map((h) => h.token),
      why: hits.map((h) => h.why).join('; ')
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.showId - b.showId);
  const top = candidates[0] || null;
  const second = candidates[1] || null;
  const ambiguous = !!(top && second && (top.confidence - second.confidence) <= 10);

  return {
    candidates: candidates.slice(0, 10),
    top: top ? { confidence: top.confidence, band: top.band } : { confidence: 0, band: 'low' },
    ambiguous
  };
}

// ════════════════════════════════════════════════════════════════════════════
// §8. IDEMPOTENCY — one ledger, scoped per user, replays return the ORIGINAL
// ════════════════════════════════════════════════════════════════════════════
function bodyHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

// Returns {replay: true, response} when this exact call already happened,
// throws 409 when the same key arrives with a DIFFERENT body, and returns
// {replay: false} on a first call.
//
// SCOPE, stated honestly: this makes SEQUENTIAL retries safe — the realistic
// agent shape (get a 200 or a timeout, retry) — because routes/agent.js awaits
// the ledger write before answering. It does NOT serialise two identical
// requests that are genuinely IN FLIGHT AT THE SAME MOMENT: both read an empty
// ledger before either writes, and both proceed. Closing that would mean
// claiming the key up front and giving callers an "in progress" state, which is
// more machinery than the failure mode justifies today. If agents ever fan out
// concurrently on one key, claim-first is the fix — not a longer comment.
async function checkIdempotency({ key, username, endpoint, body }, q = pool) {
  const hash = bodyHash(body);
  const r = await q.query(
    'SELECT * FROM agent_idempotency WHERE username=$1 AND key=$2', [username, key]);
  if (!r.rows.length) return { replay: false, hash };
  const row = r.rows[0];
  if (row.body_hash !== hash) {
    const original = row.response || {};
    throw conflict('Idempotency key reused with a different payload', {
      originalId: original.fileId || original.proposalId || original.noteId || row.id
    });
  }
  return { replay: true, response: row.response, hash };
}
async function recordIdempotency({ key, username, endpoint, hash, response }, q = pool) {
  await q.query(
    `INSERT INTO agent_idempotency (key, username, endpoint, body_hash, response)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username, key) DO NOTHING`,
    [key, username, endpoint, hash, JSON.stringify(response)]);
}
// Retain 90 days (§8).
async function purgeIdempotency(q = pool) {
  const r = await q.query(`DELETE FROM agent_idempotency WHERE created_at < NOW() - INTERVAL '90 days'`);
  return r.rowCount;
}

// ════════════════════════════════════════════════════════════════════════════
// §6. PROPOSALS
// ════════════════════════════════════════════════════════════════════════════
// ONE generic table with a payload JSONB, not a table per type: proposal kinds
// will grow faster than we want migrations, and the payload is the request body
// we already validated.
async function createProposal(c, {
  kind, proposedBy, assignedTo, projectId = null, showId = null, jobId = null,
  payload, provenance, confidence, createdRows = null
}) {
  const r = await c.query(
    `INSERT INTO proposals (kind, status, proposed_by, assigned_to, project_id, show_id, job_id,
       payload, provenance, confidence, created_rows)
     VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [kind, proposedBy, assignedTo || '', projectId, showId, jobId,
     JSON.stringify(payload), JSON.stringify(provenance), money(confidence, null),
     createdRows ? JSON.stringify(createdRows) : null]);
  return r.rows[0];
}

// Who should decide? The project owner if there is one, else the agent's user.
async function assigneeFor({ projectId, showId, agentUser }, q = pool) {
  if (showId) {
    const r = await q.query(
      `SELECT COALESCE(NULLIF(s.owner,''), p.owner) AS owner
       FROM shows s JOIN projects p ON p.id = s.project_id WHERE s.id=$1`, [showId]);
    if (r.rows.length && r.rows[0].owner) return r.rows[0].owner;
  }
  if (projectId) {
    const r = await q.query('SELECT owner FROM projects WHERE id=$1', [projectId]);
    if (r.rows.length && r.rows[0].owner) return r.rows[0].owner;
  }
  return agentUser;
}

// Housekeeping: pending proposals older than 30 days -> expired (§6).
async function expireStaleProposals(q = pool) {
  const r = await q.query(
    `UPDATE proposals SET status='expired', resolved_at=NOW(), resolve_reason='expired after 30 days'
     WHERE status='pending' AND created_at < NOW() - INTERVAL '30 days'`);
  return r.rowCount;
}

module.exports = {
  bandFor, assertBand, normalizeProvenance, matchCandidates,
  bodyHash, checkIdempotency, recordIdempotency, purgeIdempotency,
  createProposal, assigneeFor, expireStaleProposals, SIGNALS
};
