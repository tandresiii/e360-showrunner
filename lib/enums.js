// ════════════════════════════════════════════════════════════════════════════
// lib/enums.js — the canonical vocabulary + tiny pure helpers
// ────────────────────────────────────────────────────────────────────────────
// Every whitelist the server enforces lives here, and NOWHERE else. The
// front-end prototype (public/data.js) is the behavioural spec: these values
// are its values, verbatim, so a REST swap is mechanical.
//
// Punch-list coverage: A (evidence_type = flex_element), C (lanes are
// per-event-type config, not a fixed enum), D (stage vocabulary confirmed at
// five values — 'in_production' is a PRINT LANE, never a stage), 16 (deal
// types), 17 (one shared budget-category vocabulary), 23 (file kinds += the
// financial doc types).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ── roles + capabilities ────────────────────────────────────────────────────
const ROLE_RANK = { viewer: 0, tech: 1, pm: 2, manager: 3, admin: 4 };
const ALL_ROLES = Object.keys(ROLE_RANK);
function roleRank(role) { return ROLE_RANK[role] != null ? ROLE_RANK[role] : 0; }

// ── core enums ──────────────────────────────────────────────────────────────
const PROJECT_TYPES  = ['led', 'print', 'both'];
// D. Confirmed against public/data.js STAGE_LABELS — five values, no
//    'in_production' (that string is a PRINT LANE key, not a stage).
const STAGES         = ['lead', 'planning', 'ready', 'scheduled', 'closed'];
const RAGS           = ['go', 'warn', 'crit', 'idle'];
const STEP_STATUSES  = ['todo', 'in_progress', 'done', 'blocked', 'na'];
// A. flex_element wins. templates.json's `file` on Flex steps is reconciled by
//    the seed loader (lib/seed.js), not by widening the enum.
const EVIDENCE_TYPES = ['flex_element', 'doc_link', 'booking', 'file', 'none'];
const AUTO_SOURCES   = ['spec_gen', 'novaspec', 'powerspec', 'flex', 'travel', 'none'];
// 23. six original kinds + the financial/agent doc types.
const FILE_KINDS     = ['spec', 'proof', 'contract', 'confirmation', 'recording', 'other',
                        'receipt', 'invoice', 'po', 'transcript', 'photo'];
// the subset that IS a financial document (drives the finance feed) — FIN_KINDS
const FIN_KINDS      = ['receipt', 'invoice', 'po', 'confirmation'];
// 1. files.artifact carries what `kind` cannot express.
const FILE_ARTIFACTS = ['pullsheet', 'manifest', 'image', 'document'];
// HARDENING 6. `superseded` is written by the spec-bind path — binding a new
// revision retires the file the previous rev pointed at (routes/files.js) — but
// it was missing from this list, so it was neither a known status nor a
// filtered one, and retired revisions listed alongside live files.
const FILE_STATUSES  = ['filed', 'proposed', 'rejected', 'superseded'];
// What a CLIENT may set when registering a file. Supersession is a SERVER act,
// so it is not on offer here: a caller cannot file something born retired.
const FILE_STATUSES_WRITABLE = ['filed', 'proposed', 'rejected'];
// History, not inventory. Excluded from the default GET /files listing; still
// reachable by asking for them by name (?status=superseded).
const FILE_STATUSES_HIDDEN = ['rejected', 'superseded'];
const SPEC_TYPES     = ['e360', 'nsf', 'pcfg'];
// §9.3.3. Which chain node each producing tool binds to, and the file extension
// each spec type carries. Both are MAPS on purpose: the staffing app derives the
// extension with `type === 'e360' ? '.e360' : '.nsf'` in two places, which is
// why a PowerSpec bind tells the user it is attaching a .nsf (defect T2). A map
// cannot drift when a fourth type lands.
const SPEC_NODE_FOR_TYPE = { e360: 'content', nsf: 'cabling', pcfg: 'power' };
const EXT_FOR_SPEC_TYPE  = { e360: '.e360', nsf: '.nsf', pcfg: '.pcfg' };
// The derivation chain itself. routes/files.js owns the traversal (chainFor and
// the stale rule); these are here so any module needing to VALIDATE a chain_key
// — the agent surface does — has one list to check against.
const CHAIN_NODES    = ['content', 'cabling', 'power', 'pull'];
const EXPENSE_STATUS = ['proposed', 'filed', 'confirmed', 'posted'];

// 16/17. jobs.deal_type + the ONE shared category vocabulary, enforced on
// budget_lines.category, expenses.budget_line_category and po_lines.category.
const DEAL_TYPES     = ['rental', 'sale'];
const BUDGET_CATS    = ['travel', 'freight', 'labor', 'gear', 'print', 'production', 'misc'];

// POLISH_LIST #5. A job can exist before accounting cuts the real QuickBooks
// number. `temp` = the number on the row is a placeholder this app minted;
// `confirmed` = it came from QuickBooks. Only accounting flips it, and only by
// writing a real number.
const QB_NUMBER_STATUSES = ['temp', 'confirmed'];
const TEMP_JOB_PREFIX = 'TEMP-';
// TEMP-{yy}-{seq} — the year the placeholder was minted, then a 3-digit
// sequence within that year. Matching is anchored so a real QuickBooks number
// can never be mistaken for one.
const TEMP_JOB_RE = /^TEMP-(\d{2})-(\d{3,})$/;
function isTempJobNumber(v) { return TEMP_JOB_RE.test(String(v || '')); }
function tempJobNumber(yy, seq) {
  return `${TEMP_JOB_PREFIX}${String(yy).padStart(2, '0')}-${String(seq).padStart(3, '0')}`;
}

// 25. purchase-order pipeline. Advance one stage at a time.
const PO_STATUSES    = ['needed', 'quoted', 'ordered', 'shipped', 'received', 'reconciled'];
const PO_COMMITTED   = ['ordered', 'shipped'];
const PO_OWNERSHIP   = ['inventory', 'cogs'];

// 31/34. note anchors — the whitelist the notes routes and the agent API share.
const NOTE_ANCHORS   = ['project', 'show', 'step', 'file', 'job', 'expense', 'po'];

// 39. run-of-show item kinds.
const SCHEDULE_KINDS = ['travel', 'work', 'show', 'meal', 'strike'];

// 49/51. deliverables — `kind` is the extension point (recap now).
const DELIVERABLE_KINDS    = ['recap', 'call_sheet', 'photo_set'];
const DELIVERABLE_STATUSES = ['draft', 'approved', 'sent'];

// 54. client-safe stat keys, by FK not regex.
const RECAP_STAT_KEYS = ['cabinets', 'panels', 'crew', 'days', 'attendance', 'date'];

// AGENT_API §7 + punch 44/50: provenance source kinds.
const SOURCE_KINDS   = ['email', 'meeting', 'chat', 'manual', 'camera_roll', 'closeout'];
// AGENT_API §2 matchedBy tokens.
const MATCHED_BY     = ['explicit_id', 'client_name', 'venue', 'date_window', 'participant',
                        'vendor_history', 'thread_ref', 'job_number', 'keyword', 'show_record'];
// AGENT_API §1 scopes.
const AGENT_SCOPES   = ['agent:read', 'agent:file', 'agent:propose'];
// AGENT_API §6 proposal kinds.
const PROPOSAL_KINDS = ['document', 'tasks_batch', 'project', 'expense', 'purchase_request'];
const PROPOSAL_STATUSES = ['pending', 'confirmed', 'rejected', 'expired'];

// B. templates.json's 10 planning-role slugs — stored on template_steps.owner_role.
const OWNER_ROLES = ['sales', 'account_manager', 'pm', 'technical_director', 'content_manager',
                     'lead_tech', 'gear_lead', 'logistics_coordinator', 'graphic_designer',
                     'print_producer'];

// ── C. LANES ARE CONFIG, NOT AN ENUM ────────────────────────────────────────
// The lane catalogue and the per-event-type lane sets mirror public/data.js
// LANES + EVENT_TYPES exactly. They are seeded into `lanes` + `event_types` on
// boot (lib/seed.js) and read back from the DB at request time, so adding an
// event type is a row, not a deploy.
const LANE_CATALOG = [
  { key: 'client',       label: 'Client',              color: '#59A9F0' },
  { key: 'venue',        label: 'Venue',               color: '#8ED14A' },
  { key: 'logistics',    label: 'Logistics',           color: '#F4B740' },
  { key: 'crew',         label: 'Crew',                color: '#35E0A1' },
  { key: 'gear',         label: 'Gear',                color: '#B98CF0' },
  { key: 'deliverables', label: 'Deliverables',        color: '#4ADEDE' },
  { key: 'design',       label: 'Graphic Design',      color: '#E36FBE' },
  { key: 'proof',        label: 'Proof Rounds',        color: '#7C9FF2' },
  { key: 'approval',     label: 'Client Approval',     color: '#C9E265' },
  { key: 'production',   label: 'Into Production',     color: '#F0A24B' },
  { key: 'tracking',     label: 'Production Tracking', color: '#4ADEDE' },
  { key: 'ship',         label: 'Ship',                color: '#F08C59' },
  { key: 'install',      label: 'Install',             color: '#4FD1C5' },
  { key: 'return',       label: 'Return',              color: '#F0616B' }
];
const ALL_LANE_KEYS = LANE_CATALOG.map(l => l.key);

const EVENT_TYPE_CONFIG = [
  { key: 'led',   label: 'LED',         tag: 'led',   icon: 'led',    anchor: 'Show day',
    lanes: ['client', 'venue', 'logistics', 'crew', 'gear', 'deliverables'] },
  { key: 'print', label: 'Print',       tag: 'print', icon: 'print',  anchor: 'Install day',
    lanes: ['design', 'proof', 'approval', 'production', 'tracking', 'ship', 'install', 'return'] },
  { key: 'both',  label: 'LED + Print', tag: 'both',  icon: 'layers', anchor: 'Show day',
    lanes: ['client', 'venue', 'design', 'proof', 'approval', 'logistics', 'crew', 'gear', 'deliverables', 'install'] }
];

// ── helpers ─────────────────────────────────────────────────────────────────
function oneOf(val, list, fallback) {
  return list.includes(val) ? val : fallback;
}
function sameUser(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
// Add N days to a YYYY-MM-DD string in UTC (no timezone drift). `offset` is
// T-minus: negative = before the event date.
function addDays(dateStr, offset) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Number(offset || 0));
  return d.toISOString().slice(0, 10);
}
function isISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function isHHMM(s) { return /^\d{2}:\d{2}$/.test(String(s || '')); }
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }
// day age of an ISO date relative to today (positive = in the past)
function dayAge(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const t = new Date(todayISO() + 'T00:00:00Z');
  return Math.round((t - d) / 86400000);
}
function isoDiffDays(a, b) {
  if (!isISODate(a) || !isISODate(b)) return null;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function num(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function money(v, fallback = null) {
  const n = num(v, null);
  return n == null ? fallback : Math.round(n * 100) / 100;
}
function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  ROLE_RANK, ALL_ROLES, roleRank,
  PROJECT_TYPES, STAGES, RAGS, STEP_STATUSES, EVIDENCE_TYPES, AUTO_SOURCES,
  FILE_KINDS, FIN_KINDS, FILE_ARTIFACTS, FILE_STATUSES, FILE_STATUSES_WRITABLE,
  FILE_STATUSES_HIDDEN, SPEC_TYPES, EXPENSE_STATUS,
  SPEC_NODE_FOR_TYPE, EXT_FOR_SPEC_TYPE, CHAIN_NODES,
  DEAL_TYPES, BUDGET_CATS, QB_NUMBER_STATUSES, TEMP_JOB_PREFIX, TEMP_JOB_RE,
  isTempJobNumber, tempJobNumber,
  PO_STATUSES, PO_COMMITTED, PO_OWNERSHIP,
  NOTE_ANCHORS, SCHEDULE_KINDS, DELIVERABLE_KINDS, DELIVERABLE_STATUSES,
  RECAP_STAT_KEYS, SOURCE_KINDS, MATCHED_BY, AGENT_SCOPES, PROPOSAL_KINDS,
  PROPOSAL_STATUSES, OWNER_ROLES,
  LANE_CATALOG, ALL_LANE_KEYS, EVENT_TYPE_CONFIG,
  oneOf, sameUser, addDays, isISODate, isHHMM, slug, todayISO, nowISO,
  dayAge, isoDiffDays, num, money, intOrNull
};
