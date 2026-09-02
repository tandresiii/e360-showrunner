// ════════════════════════════════════════════════════════════════════════════
// lib/mappers.js — row -> API record
// ────────────────────────────────────────────────────────────────────────────
// SHAPE DECISION (important for the front-end REST-swap pass):
//
//   · HUMAN routes (/api/… except /api/agent/*) return records in the EXACT
//     shape public/data.js models — snake_case field names, integer ids,
//     ISO date strings. public/api.js is the behavioural spec, and its callers
//     read `show.default_job_id`, `file.recap_pick`, `expense.budget_line_
//     category`, `po.po_number`. Returning camelCase would have made the mock
//     -> fetch swap a re-mapping exercise instead of a one-line change.
//     (This supersedes the old server.js camelCase mappers.)
//
//   · AGENT routes (/api/agent/*) speak camelCase, verbatim per AGENT_API.md.
//     See agentShape() at the bottom.
//
//   · REQUEST bodies accept BOTH spellings everywhere — see pick().
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { num, scopeLine, canonicalStage, stageLabel, isConfirmed } = require('./enums');

// Read a field from a request body under either spelling.
//   pick(body, 'job_id')       -> body.job_id ?? body.jobId
//   pick(body, 'due_offset_days') -> ... ?? body.dueOffsetDays
function camel(s) { return String(s).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()); }
function pick(body, key, fallback = undefined) {
  if (!body || typeof body !== 'object') return fallback;
  if (body[key] !== undefined) return body[key];
  const c = camel(key);
  if (body[c] !== undefined) return body[c];
  return fallback;
}
// true when the caller supplied the field at all (so `null` can clear a value)
function has(body, key) {
  if (!body || typeof body !== 'object') return false;
  return body[key] !== undefined || body[camel(key)] !== undefined;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : v));
const n = (v) => (v == null ? null : Number(v));

// ── projects ────────────────────────────────────────────────────────────────
function dbToProject(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, slug: row.slug || '', name: row.name, client: row.client || '',
    type: row.type || 'led', stage: row.stage || 'lead', owner: row.owner || '',
    description: row.description || '',
    summary: row.summary || null, source: row.source || null,
    provenance: row.provenance || null, source_ref: row.source_ref || null,
    // F5/F6. Folders carry the same stage vocabulary and the same archive flag.
    stage_canonical: canonicalStage(row.stage),
    stage_label: stageLabel(row.stage),
    archived_at: iso(row.archived_at), archived_by: row.archived_by || null,
    archived: !!row.archived_at,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    show_count: row.show_count != null ? parseInt(row.show_count, 10) : undefined,
    ...extra
  };
}

// ── shows ───────────────────────────────────────────────────────────────────
// 9. RAG resolution: an explicit `rag_override` WINS; otherwise the value is
//    derived from the show's steps (see deriveRag); `rag` is the legacy stored
//    fallback for shows that have no steps yet.
function dbToShow(row, extra = {}) {
  if (!row) return null;
  const rec = {
    id: row.id, project_id: row.project_id, slug: row.slug || '',
    name: row.name || '', venue: row.venue || '', city: row.city || '',
    load_in_date: row.load_in_date || '', event_date: row.event_date || '',
    strike_date: row.strike_date || '',
    stage: row.stage || 'lead',
    rag: row.rag_override || extra.rag || row.rag || 'idle',
    rag_override: row.rag_override || null,
    on_site_poc: row.on_site_poc || '', owner: row.owner || '',
    default_job_id: row.default_job_id || null,
    cabinets: row.cabinets != null ? Number(row.cabinets) : 0,
    scheduler_event_id: row.scheduler_event_id || null,
    summary: row.summary || null, source: row.source || null,
    load_in_time: row.load_in_time || null, doors_time: row.doors_time || null,
    event_time: row.event_time || null, strike_time: row.strike_time || null,
    venue_address: row.venue_address || null, parking_notes: row.parking_notes || null,
    radio_channel: row.radio_channel || null, dress_code: row.dress_code || null,
    venue_poc: row.venue_poc || null, client_poc: row.client_poc || null,
    provenance: row.provenance || null, source_ref: row.source_ref || null,
    // ── F4. the scope line, flat + pre-rendered ───────────────────────────
    // The columns AND the one-line render travel together, so every surface
    // (show header · season row · projects table · call-sheet header) prints
    // the same string without each re-implementing the formatter.
    scope_kind: row.scope_kind || null,
    scope_linear_feet: n(row.scope_linear_feet),
    scope_cabinet_count: row.scope_cabinet_count != null ? Number(row.scope_cabinet_count) : null,
    scope_cabinet_type: row.scope_cabinet_type || null,
    scope_pitch: row.scope_pitch || null,
    scope_print_pieces: row.scope_print_pieces != null ? Number(row.scope_print_pieces) : null,
    scope_print_sqft: n(row.scope_print_sqft),
    scope_source: row.scope_source || 'manual',
    scope_verified_at: iso(row.scope_verified_at),
    scope_verified_by: row.scope_verified_by || null,
    scope_line: scopeLine(row),
    // ── F5. the lifecycle ─────────────────────────────────────────────────
    // `stage` above is the STORED string (legacy or lifecycle, never rewritten).
    // These three are the derived reading every chip and gate uses.
    stage_canonical: canonicalStage(row.stage),
    stage_label: stageLabel(row.stage),
    confirmed: isConfirmed(row),
    confirmed_at: iso(row.confirmed_at), confirmed_by: row.confirmed_by || null,
    struck_at: iso(row.struck_at), struck_by: row.struck_by || null,
    // ── F6. archiving ─────────────────────────────────────────────────────
    closeout_complete_at: iso(row.closeout_complete_at),
    archived_at: iso(row.archived_at), archived_by: row.archived_by || null,
    archived: !!row.archived_at,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    ...extra
  };
  // Precedence is resolved AFTER the spread, or a caller passing a derived
  // `rag` in `extra` would silently beat the manager's explicit override.
  rec.rag = row.rag_override || extra.rag || row.rag || 'idle';
  return rec;
}

// The derived RAG (punch 9). Mirrors the front-end rollup: any blocked or
// overdue-and-open step is crit; any risk-flagged or due-within-3-days open
// step is warn; nothing open at all is go; nothing at all is idle.
function deriveRag(steps, show) {
  if (!steps || !steps.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  let open = 0, warn = false, crit = false;
  for (const s of steps) {
    const st = s.status || 'todo';
    if (st === 'done' || st === 'na') continue;
    open += 1;
    if (st === 'blocked') crit = true;
    if (s.risk) warn = true;
    if (s.due_date && s.due_date < today) crit = true;
    else if (s.due_date && s.due_date <= addDaysStr(today, 3)) warn = true;
  }
  if (crit) return 'crit';
  if (warn) return 'warn';
  if (open === 0) return 'go';
  if (show && show.stage === 'lead') return 'idle';
  return 'go';
}
function addDaysStr(dateStr, offset) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ── the money projection (hardening 2, 2026-08-27) ──────────────────────────
// `margin` and `billed` used to be stripped for a caller without the finance
// capability while `contract_value` shipped in the clear on the very same job.
// That is not a redaction, it is a subtraction problem: budgets, burn and
// committed spend are visible to EVERYONE by design (TEAM_FEEDBACK), so the
// contract value is the only missing term — hand it over and the margin is
// arithmetic. The contract value therefore carries the same gate as the margin
// it implies.
//
// The DECISION stays in lib/auth.js (hasFinance); this is only the PROJECTION,
// which is what a mapper is for. Callers pass the boolean so this module keeps
// its single dependency on ./enums.
//
// It recurses into `job` / `jobs[]` because a job rides INSIDE several finance
// payloads (jobFinance, the feed), and a strip that only reached the top level
// was how the value escaped in the first place.
const MONEY_FIELDS = ['margin', 'marginPct', 'billed', 'contract_value'];
function stripMoney(payload, canSee) {
  if (canSee || !payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map((x) => stripMoney(x, canSee));
  const out = { ...payload };
  for (const f of MONEY_FIELDS) delete out[f];
  if (out.job) out.job = stripMoney(out.job, canSee);
  if (Array.isArray(out.jobs)) out.jobs = stripMoney(out.jobs, canSee);
  return out;
}

// ── jobs / budget ───────────────────────────────────────────────────────────
function dbToJob(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, project_id: row.project_id, name: row.name || '',
    qb_job_number: row.qb_job_number || null,
    // POLISH_LIST #5. 'temp' = a placeholder this app minted; 'confirmed' = the
    // number came from QuickBooks. A row written before the column existed has
    // no value and is confirmed by definition.
    qb_number_status: row.qb_number_status === 'temp' ? 'temp' : 'confirmed',
    client: row.client || '',
    deal_type: row.deal_type || 'rental', description: row.description || '',
    contract_value: n(row.contract_value) || 0, status: row.status || 'open',
    // 20. budget_total is DERIVED (sum of budget_lines); the finance queries
    // supply it, it is never a stored column.
    budget_total: row.budget_total != null ? Number(row.budget_total) : undefined,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), ...extra
  };
}
function dbToBudgetLine(row) {
  if (!row) return null;
  return {
    id: row.id, job_id: row.job_id, category: row.category,
    allotted: n(row.allotted) || 0, notes: row.notes || '',
    created_by: row.created_by || '', updated_by: row.updated_by || '',
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

// ── steps ───────────────────────────────────────────────────────────────────
function dbToStep(row) {
  if (!row) return null;
  return {
    id: row.id, show_id: row.show_id || null, project_id: row.project_id || null,
    lane: row.lane, title: row.title, status: row.status || 'todo',
    owner: row.owner || null, owner_role: row.owner_role || null,
    due_date: row.due_date || '',
    due_offset_days: row.due_offset_days != null ? row.due_offset_days : null,
    evidence_type: row.evidence_type || 'none', evidence_ref: row.evidence_ref || '',
    depends_on: row.depends_on || null, auto_source: row.auto_source || 'none',
    sort_order: row.sort_order || 0, notes: row.notes || '',
    risk: !!row.risk,
    provenance: row.provenance || null, source_ref: row.source_ref || null,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

// ── templates ───────────────────────────────────────────────────────────────
function dbToTemplate(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, event_type: row.event_type || 'led',
    description: row.description || '', source_key: row.source_key || null,
    created_at: iso(row.created_at), ...extra
  };
}
function dbToTemplateStep(row) {
  if (!row) return null;
  return {
    id: row.id, template_id: row.template_id, lane: row.lane, title: row.title,
    due_offset_days: row.due_offset_days, owner_role: row.owner_role || null,
    evidence_type: row.evidence_type || 'none', auto_source: row.auto_source || 'none',
    depends_on_title: row.depends_on_title || '', sort_order: row.sort_order || 0
  };
}

// ── files (incl. financial docs + photos) ───────────────────────────────────
function dbToFile(row) {
  if (!row) return null;
  return {
    id: row.id, project_id: row.project_id || null, show_id: row.show_id || null,
    name: row.name, ext: row.ext || '', kind: row.kind || 'other',
    spec_type: row.spec_type || null, artifact: row.artifact || null,
    ver: row.ver || 'v1', dim: row.dim || null, meta: row.meta || '',
    chain_key: row.chain_key || null,
    nas_path: row.nas_path || '', size: row.size != null ? Number(row.size) : 0,
    uploaded_by: row.uploaded_by || '',
    amount: n(row.amount), vendor: row.vendor || null, doc_date: row.doc_date || null,
    job_id: row.job_id || null, attached_to: row.attached_to || null,
    status: row.status || 'filed',
    provenance: row.provenance || null, source_ref: row.source_ref || null,
    taken_at: iso(row.taken_at), width: row.width || null, height: row.height || null,
    caption: row.caption || null, tags: row.tags || [], shot_by: row.shot_by || null,
    recap_pick: !!row.recap_pick, thumb_path: row.thumb_path || null,
    created_at: iso(row.created_at)
  };
}

// ── expenses / bookings ─────────────────────────────────────────────────────
function dbToExpense(row) {
  if (!row) return null;
  return {
    id: row.id, show_id: row.show_id || null, project_id: row.project_id || null,
    job_id: row.job_id || null,
    budget_line_category: row.budget_line_category || row.category || 'misc',
    category: row.category || row.budget_line_category || '',
    vendor: row.vendor || '', amount: n(row.amount) || 0,
    txn_date: row.txn_date || null, status: row.status || 'proposed',
    file_id: row.file_id || null, po_id: row.po_id || null,
    by: row.by || null, memo: row.memo || '',
    match_confidence: n(row.match_confidence), match_reason: row.match_reason || '',
    evidence_ref: row.evidence_ref || '',
    provenance: row.provenance || null, source_ref: row.source_ref || null,
    created_at: iso(row.created_at)
  };
}
function dbToBooking(row) {
  if (!row) return null;
  return {
    id: row.id, show_id: row.show_id, job_id: row.job_id || null,
    category: row.category || '', vendor: row.vendor || '', status: row.status || 'todo',
    amount: n(row.amount), booked_date: row.booked_date || null,
    file_id: row.file_id || null, confirmation_number: row.confirmation_number || '',
    notes: row.notes || '', created_at: iso(row.created_at)
  };
}

// ── purchasing ──────────────────────────────────────────────────────────────
function dbToPO(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, po_number: row.po_number, vendor: row.vendor || '',
    project_id: row.project_id || null, job_id: row.job_id || null,
    status: row.status || 'needed', created_by: row.created_by || '',
    ordered_date: row.ordered_date || null, expected_date: row.expected_date || null,
    received_date: row.received_date || null,
    approval: row.approval || null, provenance: row.provenance || null,
    source_ref: row.source_ref || null, memo: row.memo || '', tracking: row.tracking || null,
    quote_file_id: row.quote_file_id || null, invoice_file_id: row.invoice_file_id || null,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), ...extra
  };
}
function dbToPOLine(row) {
  if (!row) return null;
  return {
    id: row.id, po_id: row.po_id, item: row.item, detail: row.detail || '',
    qty: n(row.qty) || 0, unit_cost: n(row.unit_cost) || 0,
    category: row.category || 'gear', job_id: row.job_id || null,
    show_id: row.show_id || null, ownership: row.ownership || 'cogs',
    expense_id: row.expense_id || null
  };
}
// est_cost stays NULLABLE through the mapper — "no estimate" and "$0" are
// different answers, and the needs panel renders them differently.
function dbToNeed(row) {
  if (!row) return null;
  return {
    id: row.id, project_id: row.project_id, job_id: row.job_id,
    show_id: row.show_id || null, item: row.item, detail: row.detail || '',
    qty: n(row.qty) || 1, est_cost: n(row.est_cost),
    category: row.category || 'gear', status: row.status || 'open',
    covered_by_po_id: row.covered_by_po_id || null,
    checked_by: row.checked_by || null, checked_at: iso(row.checked_at),
    sort_order: row.sort_order || 0, created_by: row.created_by || '',
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

// ── notes ───────────────────────────────────────────────────────────────────
function dbToNote(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, anchor_type: row.anchor_type, anchor_id: row.anchor_id,
    project_id: row.project_id || null, show_id: row.show_id || null,
    author: row.author, body: row.body,
    parent_id: row.parent_id || null, mentions: row.mentions || [],
    created_at: iso(row.created_at), edited_at: iso(row.edited_at),
    provenance: row.provenance || null, source_ref: row.source_ref || null,
    ...extra
  };
}

// ── run of show ─────────────────────────────────────────────────────────────
function dbToScheduleItem(row) {
  if (!row) return null;
  return {
    id: row.id, show_id: row.show_id, day: row.day, start_time: row.start_time,
    end_time: row.end_time || null, title: row.title, detail: row.detail || '',
    who: row.who == null ? 'all' : row.who, location: row.location || '',
    kind: row.kind || 'work'
  };
}
function dbToCrew(row) {
  if (!row) return null;
  return {
    id: row.id, show_id: row.show_id, username: row.username || null,
    name: row.name || null, phone: row.phone || null,
    role_on_site: row.role_on_site || '', call_time: row.call_time || null,
    travel: row.travel || null
  };
}

// ── misc ────────────────────────────────────────────────────────────────────
// `self` and `admin` gate ONE field: the email address. Phone numbers ride on
// call sheets and are published to the whole roster by design; addresses are
// not, and a roster read is made by everybody. So the address comes back to the
// person it belongs to and to an admin — who is the only one allowed to edit it
// and the only one who needs to see, on the Team screen, who has not got one —
// and is `undefined` (absent from the JSON, not empty) for anybody else.
//
// `staffing_name` is deliberately NOT gated. It is a name, published in the
// staffing app to everybody who reads a call sheet there, and the crew surfaces
// that resolve it are open to the whole roster.
function dbToUser(row, { self = false, admin = false } = {}) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, name: row.name || row.username,
    role: row.role, initials: row.initials || '', color: row.color || '',
    title: row.title || '', discipline: row.discipline || '',
    phone: row.phone || '',
    email: (self || admin) ? (row.email || '') : undefined,
    staffing_name: row.staffing_name || null,
    finance: !!row.finance, active: row.active !== false,
    // Deliberately `must_change` and not `must_change_password`: the roster
    // assertion in scripts/smoke.js proves no user record ever carries the
    // substring "password", and that assertion is worth more than the longer
    // field name. It says "this person is still on the temp password the
    // server minted" — a fact, not a secret, and the login response is what
    // the client acts on.
    must_change: row.must_change_password === true,
    created_at: iso(row.created_at)
  };
}
function dbToActivity(row) {
  if (!row) return null;
  return {
    id: row.id, project_id: row.project_id || null, show_id: row.show_id || null,
    po_id: row.po_id || null, job_id: row.job_id || null,
    actor: row.actor || null, action: row.action || '', detail: row.detail || null,
    accent: !!row.accent, provenance: row.provenance || null,
    // F3. The structured before→after. An empty array is normalised to null so
    // the client's "does this row have a diff?" test is one truthiness check.
    changes: Array.isArray(row.changes) && row.changes.length ? row.changes : null,
    ts: iso(row.created_at), created_at: iso(row.created_at)
  };
}
function dbToMilestone(row) {
  if (!row) return null;
  return { id: row.id, show_id: row.show_id || null, project_id: row.project_id || null,
           label: row.label, date: row.date || '', sort_order: row.sort_order || 0 };
}
function dbToProof(row, rounds = []) {
  if (!row) return null;
  return { id: row.id, show_id: row.show_id, code: row.code || '', name: row.name || '',
           status: row.status || 'sent', client: row.client || '', rounds };
}
function dbToProofRound(row) {
  if (!row) return null;
  return { id: row.id, proof_id: row.proof_id, round: row.round || '', date: row.date || '',
           status: row.status || 'sent', note: row.note || '', sort_order: row.sort_order || 0 };
}
function dbToChainNode(row) {
  if (!row) return { gen: false, rev: 0, derivedRev: 0, by: '', when: '', file_id: null };
  return {
    gen: !!row.gen, rev: row.rev || 0, derivedRev: row.derived_from_rev || 0,
    derived_from_rev: row.derived_from_rev || 0,
    by: row.by || '', when: row.when_at || '', file_id: row.file_id || null
  };
}
function dbToFlexState(row, showId) {
  if (!row) return { show_id: showId, linked: false, pulled: false, elementId: null,
                     gearListId: null, gearListType: 'pull-sheet', docNumber: null };
  return {
    show_id: row.show_id, linked: !!row.linked, pulled: !!row.pulled,
    elementId: row.element_id || null, element_id: row.element_id || null,
    gearListId: row.gear_list_id || null, gear_list_id: row.gear_list_id || null,
    gearListType: row.gear_list_type || 'pull-sheet',
    docNumber: row.doc_number || null, doc_number: row.doc_number || null
  };
}
function dbToDeliverable(row) {
  if (!row) return null;
  return {
    id: row.id, project_id: row.project_id || null, show_id: row.show_id,
    kind: row.kind || 'recap', status: row.status || 'draft', body: row.body,
    generated_by: row.generated_by || '', generated_at: iso(row.generated_at),
    edited_by: row.edited_by || null, edited_at: iso(row.edited_at),
    approved_by: row.approved_by || null, approved_at: iso(row.approved_at),
    sent_at: iso(row.sent_at), sent_to: row.sent_to || null,
    provenance: row.provenance || null
  };
}
// ── F2. tech show reports ───────────────────────────────────────────────────
// `body` is the tech's own prose. It travels to the person who is allowed to
// read it and NOWHERE else: the list route strips it for a caller who may not
// view all (routes/reports.js), and the recap firewall cannot reach the table
// at all (lib/firewall.js guardRecapQuery).
function dbToTechReport(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id, show_id: row.show_id, project_id: row.project_id || null,
    username: row.username, crew_assignment_id: row.crew_assignment_id || null,
    role_on_site: row.role_on_site || '',
    status: row.status || 'owed',
    body: row.body || '', file_id: row.file_id || null,
    due_date: row.due_date || '',
    requested_at: iso(row.requested_at), filed_at: iso(row.filed_at),
    reviewed_by: row.reviewed_by || null, reviewed_at: iso(row.reviewed_at),
    last_nagged_at: iso(row.last_nagged_at), nag_count: row.nag_count || 0,
    // display extras the list query joins in
    user_name: row.user_name || undefined,
    user_initials: row.user_initials || undefined,
    user_role: row.user_role || undefined,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    ...extra
  };
}

// ── F3. the notification outbox ─────────────────────────────────────────────
function dbToNotification(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, kind: row.kind,
    mode: row.mode || 'immediate', status: row.status || 'queued',
    subject: row.subject || '', body: row.body || '', link: row.link || '',
    note_id: row.note_id || null, project_id: row.project_id || null,
    show_id: row.show_id || null, actor: row.actor || '',
    driver: row.driver || null, attempts: row.attempts || 0,
    last_error: row.last_error || null, skipped_reason: row.skipped_reason || null,
    queued_at: iso(row.queued_at), sent_at: iso(row.sent_at)
  };
}

function dbToProposal(row, { full = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id, kind: row.kind, status: row.status, proposed_by: row.proposed_by,
    assigned_to: row.assigned_to || '', project_id: row.project_id || null,
    show_id: row.show_id || null, job_id: row.job_id || null,
    confidence: n(row.confidence),
    resolved_by: row.resolved_by || null, resolved_at: iso(row.resolved_at),
    resolve_reason: row.resolve_reason || null,
    created_rows: row.created_rows || null, created_at: iso(row.created_at)
  };
  return full ? { ...base, payload: row.payload, provenance: row.provenance } : base;
}
function dbToApiKey(row) {
  if (!row) return null;
  return {
    id: row.id, user_id: row.user_id, username: row.username, label: row.label || '',
    key_prefix: row.key_prefix || '', scopes: row.scopes || [],
    created_at: iso(row.created_at), created_by: row.created_by || '',
    revoked_at: iso(row.revoked_at), last_used_at: iso(row.last_used_at),
    last_used_ip: row.last_used_ip || null
    // never the key itself, and never key_hash
  };
}

// ── AGENT SURFACE (camelCase, AGENT_API.md verbatim) ────────────────────────
function agentShow(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name || '', venue: row.venue || '',
    eventDate: row.event_date || '', loadInDate: row.load_in_date || '',
    strikeDate: row.strike_date || '', stage: row.stage || 'lead',
    // F5/F6 — an agent must be able to SEE that a show is pre-commitment or
    // out of the working set, for the same reason it must see a TEMP job
    // number: so it never files into one as though it were live work.
    stageCanonical: canonicalStage(row.stage),
    confirmed: isConfirmed(row),
    archived: !!row.archived_at,
    // F4 — the scope line is client-safe, so it is safe here too, and it is
    // the one string that tells an agent what the show actually IS.
    scopeLine: scopeLine(row),
    rag: row.rag_override || row.rag || 'idle', projectId: row.project_id,
    defaultJobId: row.default_job_id || null
  };
}
function agentProject(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, client: row.client || '', type: row.type || 'led',
           owner: row.owner || '', stage: row.stage || 'lead' };
}
function agentJob(row, isDefault = false) {
  if (!row) return null;
  return { id: row.id, name: row.name || '', qbJobNumber: row.qb_job_number || null,
           // POLISH_LIST #5: an agent must be able to SEE that a number is a
           // placeholder, so it never quotes one to a client as the QB job.
           qbNumberStatus: row.qb_number_status === 'temp' ? 'temp' : 'confirmed',
           isDefault: !!isDefault };
}
function agentStep(row) {
  if (!row) return null;
  return { id: row.id, lane: row.lane, title: row.title, owner: row.owner || '',
           dueDate: row.due_date || '', status: row.status || 'todo' };
}
function agentActivity(row) {
  if (!row) return null;
  return { actor: row.actor || '', action: row.action || '', detail: row.detail || '',
           createdAt: iso(row.created_at) };
}
function agentProposal(row, { full = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id, kind: row.kind, status: row.status, proposedBy: row.proposed_by,
    assignedTo: row.assigned_to || '', projectId: row.project_id || null,
    showId: row.show_id || null, jobId: row.job_id || null,
    confidence: n(row.confidence), createdAt: iso(row.created_at),
    resolvedBy: row.resolved_by || null, resolvedAt: iso(row.resolved_at),
    resolveReason: row.resolve_reason || null, createdRows: row.created_rows || null
  };
  return full ? { ...base, payload: row.payload, provenance: row.provenance } : base;
}

module.exports = {
  pick, has, camel, iso, stripMoney, MONEY_FIELDS,
  dbToProject, dbToShow, deriveRag, dbToJob, dbToBudgetLine, dbToStep,
  dbToTemplate, dbToTemplateStep, dbToFile, dbToExpense, dbToBooking,
  dbToPO, dbToPOLine, dbToNeed, dbToNote, dbToScheduleItem, dbToCrew, dbToUser,
  dbToActivity, dbToMilestone, dbToProof, dbToProofRound, dbToChainNode,
  dbToFlexState, dbToDeliverable, dbToTechReport, dbToNotification,
  dbToProposal, dbToApiKey,
  agentShow, agentProject, agentJob, agentStep, agentActivity, agentProposal
};
