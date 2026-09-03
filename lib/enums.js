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

// The avatar palette. These are the nine colours already on the seeded roster
// (lib/seed.js) plus the tenth public/data.js uses, so a person added through
// the Team view is indistinguishable from one who was always there. Assignment
// prefers a colour nobody is wearing; once all ten are taken it wraps, which is
// fine — the initials carry the identity, the colour is only a fast glance.
const USER_COLORS = [
  '#F4B740', '#59A9F0', '#8ED14A', '#E36FBE', '#35E0A1',
  '#F0616B', '#B98CF0', '#4ADEDE', '#F08C59', '#7C9FF2'
];
// 'Tom Andres' -> 'TA'; 'candice' -> 'CA'. Only ever a FALLBACK: whatever the
// admin typed wins, because a person's initials are theirs to choose.
function initialsFrom(name, username) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  const one = parts[0] || String(username || '');
  return one.slice(0, 2).toUpperCase();
}

// ── core enums ──────────────────────────────────────────────────────────────
const PROJECT_TYPES  = ['led', 'print', 'both'];
// D. Confirmed against public/data.js STAGE_LABELS — five values, no
//    'in_production' (that string is a PRINT LANE key, not a stage).
//
// F5 (2026-08-27, Tom-confirmed). The COMMERCIAL LIFECYCLE lands as a UNION,
// never a replacement: `STAGES` is the legacy five PLUS the six lifecycle
// values, so every stage string already in the database is still a legal value
// and NO ROW IS EVER REWRITTEN. The two vocabularies coexist; the mapping below
// is a DISPLAY/ORDERING concern only.
//
//   quoted → confirmed → in_progress → delivered → closed → archived
//
// STAGE_ALIAS maps a legacy value onto its lifecycle POSITION so a chip, a
// timeline and the push gate can order an old row without touching it:
//   lead      → quoted        (a genuine pre-commitment stage)
//   planning  → confirmed     (E360 does not plan an event it has not sold)
//   ready     → confirmed
//   scheduled → in_progress   (it was pushed to the scheduler; work is running)
//   closed    → closed        (identity)
// The CONFIRM FACT is `shows.confirmed_at`, never the stage string: a legacy
// row reads as confirmed-by-position with no datestamp, which is the truth.
const LEGACY_STAGES  = ['lead', 'planning', 'ready', 'scheduled', 'closed'];
const LIFECYCLE_STAGES = ['quoted', 'confirmed', 'in_progress', 'delivered', 'closed', 'archived'];
const STAGES         = LEGACY_STAGES.concat(
  LIFECYCLE_STAGES.filter((s) => LEGACY_STAGES.indexOf(s) < 0));
const STAGE_ALIAS    = { lead: 'quoted', planning: 'confirmed', ready: 'confirmed',
                         scheduled: 'in_progress' };
const STAGE_LABELS   = {
  // the lifecycle
  quoted: 'Quoted', confirmed: 'Confirmed', in_progress: 'In progress',
  delivered: 'Delivered', closed: 'Closed', archived: 'Archived',
  // the legacy five keep their OWN labels — an old row is never relabelled
  lead: 'Sales', planning: 'Planning', ready: 'Ready', scheduled: 'Scheduled'
};
// legacy value -> lifecycle value. Unknown strings degrade to 'quoted' (the
// least-committed position) rather than throwing out of a renderer.
function canonicalStage(s) {
  const v = String(s || '');
  if (LIFECYCLE_STAGES.indexOf(v) >= 0) return v;
  return STAGE_ALIAS[v] || 'quoted';
}
function stageLabel(s) { return STAGE_LABELS[String(s || '')] || String(s || ''); }
function stageIndex(s) { return LIFECYCLE_STAGES.indexOf(canonicalStage(s)); }
// "is this row at least at <min> on the lifecycle?" — the ordering question
// every gate asks, answered identically for legacy and lifecycle values.
function stageAtLeast(s, min) { return stageIndex(s) >= LIFECYCLE_STAGES.indexOf(min); }
// THE confirm predicate. An explicit confirm datestamp wins; otherwise a row
// whose stage POSITION is confirmed-or-later counts — which is what keeps every
// pre-existing 'planning'/'ready'/'scheduled'/'closed' show pushable.
function isConfirmed(row) {
  if (!row) return false;
  if (row.confirmed_at) return true;
  return stageAtLeast(row.stage, 'confirmed');
}
const RAGS           = ['go', 'warn', 'crit', 'idle'];
const STEP_STATUSES  = ['todo', 'in_progress', 'done', 'blocked', 'na'];
// A. flex_element wins. templates.json's `file` on Flex steps is reconciled by
//    the seed loader (lib/seed.js), not by widening the enum.
const EVIDENCE_TYPES = ['flex_element', 'doc_link', 'booking', 'file', 'none'];
const AUTO_SOURCES   = ['spec_gen', 'novaspec', 'powerspec', 'flex', 'travel', 'none'];
// 23. six original kinds + the financial/agent doc types.
// F2: 'report' joins them — a filed tech show report lands in the event
// folder's Files as a first-class document kind. Purely additive: no existing
// row changes kind, and the finance feed (FIN_KINDS) is untouched.
const FILE_KINDS     = ['spec', 'proof', 'contract', 'confirmation', 'recording', 'other',
                        'receipt', 'invoice', 'po', 'transcript', 'photo', 'report'];
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
//
// 'service' (2026-09-02, LOVB 2027) lands ADDITIVELY as a third deal type. Some
// jobs sell neither gear nor a rental: E360 staffs and runs LED systems the
// CLIENT already owns — Madison and Atlanta run LOVB's own cabinets with e360
// techs on them. That is a labour deal against someone else's hardware, and
// calling it 'rental' would claim E360 owns gear it does not.
//
// Ownership derivation is deliberately untouched: only 'sale' books a purchase
// as COGS (routes/purchasing.js, routes/agent.js). A service job that somehow
// buys hardware keeps it, which is the same answer 'rental' gives and the right
// one — E360 retains anything it buys on a job it is only staffing.
const DEAL_TYPES     = ['rental', 'sale', 'service'];
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

// ── NEEDS LIST — the per-job purchasing checklist (Tom, 2026-09-02) ─────────
// "each one of those systems need all kinds of ancillary things — it would be
// really advantageous if i had a spot to check those off the list." A need is
// a CHECKLIST ITEM, not money: nothing here touches a budget until it is
// raised into a PO, at which point the PO machinery above takes over.
//   open    — still needs buying (or a decision)
//   covered — handled: raised onto a PO (covered_by_po_id) or checked off by
//             hand ("already ordered outside the list")
//   na      — deliberately not needed on this system ("venue has it",
//             "rides the traveling kit"). Kept, struck through — a decision
//             is a record, not an absence.
const NEED_STATUSES  = ['open', 'covered', 'na'];

// The standard LED-system ancillaries, seeded onto a job in one click. Every
// install needs roughly this list around the cabinets themselves; the seed is
// idempotent, so re-running it only fills gaps. Categories are the shared
// BUDGET_CATS vocabulary, quantities are starting points, est_cost is left
// null — a guess nobody made is worse than a blank.
// NOTE: this list is a first cut for the LOVB 2027 installs — TOM WILL TUNE IT
// as the season teaches us what every system actually eats.
const LED_ANCILLARIES = [
  { item: 'Main power distro',                detail: 'per-system distro rack sized to the wall',          qty: 1, category: 'gear' },
  { item: '208V / breakout cabling',          detail: 'feeder + breakouts, wall to distro to cabinets',    qty: 1, category: 'gear' },
  { item: 'LED processor',                    detail: 'primary processor for the system',                  qty: 1, category: 'gear' },
  { item: 'Backup processor',                 detail: 'hot spare, configured and shelved on site',         qty: 1, category: 'gear' },
  { item: 'Data / fiber runs',                detail: 'processor-to-wall data, fiber where the run is long', qty: 1, category: 'gear' },
  { item: 'Network switch',                   detail: 'control network for processor + peripherals',       qty: 1, category: 'gear' },
  { item: 'Rigging / ground-support hardware', detail: 'flown: rigging kit · floor: ground-support frames', qty: 1, category: 'gear' },
  { item: 'Spare cabinets / modules allowance', detail: 'attrition stock — pixels fail on install day',    qty: 1, category: 'gear' },
  { item: 'Spare PSUs + receiving cards',     detail: 'the two parts that actually die',                   qty: 1, category: 'gear' },
  { item: 'Freight / shipping',               detail: 'hardware to the venue',                             qty: 1, category: 'freight' },
  { item: 'Install consumables',              detail: 'gaff · zip ties · hardware · edge trim',            qty: 1, category: 'misc' },
  { item: 'Test + commissioning kit',         detail: 'test patterns, meters, spares caddy for sign-off',  qty: 1, category: 'gear' }
];

// ── CONTACT ROLODEX — the cross-project directory (Tom, 2026-08-27) ─────────
// "there should be a contact rolodex in our app if we dont already have one."
// Until now a contact lived in four places at once — a POC JSONB on a show, a
// vendor string on a PO, a local hire inline on the crew, and a Flex-side
// contact record — and none of them knew about the others. `kind` says which
// hat a contact wears; it is a coarse sort key for the rolodex filter, never a
// permission. 'crew' covers local hires; a freight broker is a 'vendor'.
const CONTACT_KINDS  = ['client', 'venue', 'vendor', 'crew', 'other'];

// 31/34. note anchors — the whitelist the notes routes and the agent API share.
const NOTE_ANCHORS   = ['project', 'show', 'step', 'file', 'job', 'expense', 'po'];

// 39. run-of-show item kinds.
const SCHEDULE_KINDS = ['travel', 'work', 'show', 'meal', 'strike'];

// 49/51. deliverables — `kind` is the extension point (recap now).
const DELIVERABLE_KINDS    = ['recap', 'call_sheet', 'photo_set'];
const DELIVERABLE_STATUSES = ['draft', 'approved', 'sent'];

// 54. client-safe stat keys, by FK not regex.
// F4 WIDENS THIS LIST DELIBERATELY. The scope line is "what we delivered" —
// linear feet, cabinet count, cabinet type, pitch, print pieces, print square
// footage. Every one of those is a physical fact about the product the client
// bought; none of them is derivable into a cost, a rate or a margin, which is
// the only test that matters here. Adding a key is the deliberate act of
// widening the client surface, and this is the one place a reviewer looks.
// (The corresponding rows are seeded into `recap_stat_keys` by lib/seed.js.)
const RECAP_STAT_KEYS = ['cabinets', 'panels', 'crew', 'days', 'attendance', 'date',
                         'scope', 'linear_feet', 'cabinet_count', 'cabinet_type', 'pitch',
                         'print_pieces', 'print_sqft'];

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

// ── F4. SCOPE LINE — "what we're delivering", structured per show ───────────
// Typed per event type. `both` carries BOTH sets, which is why the fields are
// flat columns rather than a discriminated union: a show that starts LED and
// grows a print package must not lose the LED numbers on the way.
const SCOPE_KINDS   = ['led', 'print', 'both'];
// Where the numbers came from. 'spec' = auto-filled/verified from a bound spec
// (the stack-aware count from lib/speccheck.js); 'manual' = hand-entered, which
// is the only option before a spec exists.
const SCOPE_SOURCES = ['manual', 'spec'];

// ── F2. TECH SHOW REPORTS ───────────────────────────────────────────────────
// owed     — auto-created for every crew member when the show strikes
// filed    — the tech wrote it in-app or uploaded a doc; the obligation is MET
// reviewed — a pm/admin read it. OPTIONAL bookkeeping: sign-off is NOT required
//            and a report is never blocked on one (Tom, 2026-08-27).
const TECH_REPORT_STATUSES = ['owed', 'filed', 'reviewed'];

// ── F3. NOTIFICATION OUTBOX + THE EMAIL LAYER ───────────────────────────────
// `kind` is what happened; `mode` is the per-user preference for that kind.
// 'change' (F5) is the SUBSCRIPTION kind: you are on this show, so a material
// change to it reaches you without the changer naming you. It is deliberately
// separate from 'notify' (the actor picked you) so a person can silence the
// firehose and keep their direct pings, or the reverse.
const NOTIFY_KINDS  = ['assignment', 'mention', 'notify', 'report_nag', 'change', 'digest'];
const NOTIFY_MODES  = ['immediate', 'digest', 'off'];
// Tom's defaults (TEAM_FEEDBACK): assignments + mentions immediate, rest
// digested. A user with no prefs row gets exactly this, so the table only ever
// stores DEVIATIONS from the house default.
//
// 'change' defaults to DIGEST on purpose: it is the highest-volume kind in the
// app and the one most able to train people to ignore their mail. Twelve edits
// on a Tuesday must arrive as one digest row, not twelve emails — that is what
// makes subscription-by-assignment bind the team instead of spamming it.
const NOTIFY_DEFAULT_MODE = {
  assignment: 'immediate', mention: 'immediate',
  notify: 'digest', report_nag: 'digest', change: 'digest', digest: 'digest'
};
// queued  — waiting for a flush
// sent    — a driver accepted it
// skipped — deliberately not sent (preference 'off', or read in-app first)
// failed  — a driver refused it and it is NOT retried automatically
const NOTIFY_STATUSES = ['queued', 'sent', 'skipped', 'failed'];
// 'log' is the DEFAULT and is not a stub: it really does deliver, to the
// activity log. 'graph' is the Microsoft Graph sendMail skeleton.
const MAIL_DRIVERS  = ['log', 'graph'];

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

// ── F4. the scope line, rendered ────────────────────────────────────────────
// ONE renderer, so the show header, the season row, the projects table, the
// call-sheet header and the recap stat all print the same string. Mirrored
// verbatim in public/data.js scopeLine() for demo mode.
//
//   LED   · 800′ · 144× P10
//   Print · 12 pcs · 3,400 sq ft
//   LED + Print · 800′ · 144× P10 · 12 pcs · 3,400 sq ft
//
// Accepts either a scope object ({kind, linear_feet, …}) or a show row
// carrying the scope_* columns, because both call sites exist.
function scopeOf(row) {
  if (!row) return null;
  if (row.kind !== undefined || row.linear_feet !== undefined) return row;
  return {
    kind: row.scope_kind || null,
    linear_feet: row.scope_linear_feet, cabinet_count: row.scope_cabinet_count,
    cabinet_type: row.scope_cabinet_type, pitch: row.scope_pitch,
    print_pieces: row.scope_print_pieces, print_sqft: row.scope_print_sqft,
    source: row.scope_source || 'manual'
  };
}
function grouped(v) {
  const x = num(v, null);
  if (x == null) return '';
  const rounded = Math.round(x * 100) / 100;
  const [int, frac] = String(rounded).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
}
const SCOPE_LABEL = { led: 'LED', print: 'Print', both: 'LED + Print' };
function scopeParts(raw) {
  const sc = scopeOf(raw);
  if (!sc || !sc.kind || !SCOPE_KINDS.includes(sc.kind)) return [];
  const out = [SCOPE_LABEL[sc.kind]];
  if (sc.kind === 'led' || sc.kind === 'both') {
    if (num(sc.linear_feet, null) != null) out.push(grouped(sc.linear_feet) + '′');
    if (num(sc.cabinet_count, null) != null) {
      const spec = [sc.cabinet_type, sc.pitch].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
      out.push(grouped(sc.cabinet_count) + '×' + (spec ? ' ' + spec : ''));
    }
  }
  if (sc.kind === 'print' || sc.kind === 'both') {
    if (num(sc.print_pieces, null) != null) out.push(grouped(sc.print_pieces) + ' pcs');
    if (num(sc.print_sqft, null) != null) out.push(grouped(sc.print_sqft) + ' sq ft');
  }
  // A kind with no numbers behind it is not a scope line — it is a label with
  // nothing to say, and printing "LED" alone everywhere would be noise.
  return out.length > 1 ? out : [];
}
function scopeLine(raw) { return scopeParts(raw).join(' · '); }
function hasScope(raw) { return scopeParts(raw).length > 0; }

module.exports = {
  ROLE_RANK, ALL_ROLES, roleRank, USER_COLORS, initialsFrom,
  LEGACY_STAGES, LIFECYCLE_STAGES, STAGE_ALIAS, STAGE_LABELS,
  canonicalStage, stageLabel, stageIndex, stageAtLeast, isConfirmed,
  SCOPE_KINDS, SCOPE_SOURCES, SCOPE_LABEL, scopeOf, scopeParts, scopeLine, hasScope,
  TECH_REPORT_STATUSES,
  NOTIFY_KINDS, NOTIFY_MODES, NOTIFY_DEFAULT_MODE, NOTIFY_STATUSES, MAIL_DRIVERS,
  PROJECT_TYPES, STAGES, RAGS, STEP_STATUSES, EVIDENCE_TYPES, AUTO_SOURCES,
  FILE_KINDS, FIN_KINDS, FILE_ARTIFACTS, FILE_STATUSES, FILE_STATUSES_WRITABLE,
  FILE_STATUSES_HIDDEN, SPEC_TYPES, EXPENSE_STATUS,
  SPEC_NODE_FOR_TYPE, EXT_FOR_SPEC_TYPE, CHAIN_NODES,
  DEAL_TYPES, BUDGET_CATS, QB_NUMBER_STATUSES, TEMP_JOB_PREFIX, TEMP_JOB_RE,
  isTempJobNumber, tempJobNumber,
  PO_STATUSES, PO_COMMITTED, PO_OWNERSHIP, NEED_STATUSES, LED_ANCILLARIES,
  CONTACT_KINDS,
  NOTE_ANCHORS, SCHEDULE_KINDS, DELIVERABLE_KINDS, DELIVERABLE_STATUSES,
  RECAP_STAT_KEYS, SOURCE_KINDS, MATCHED_BY, AGENT_SCOPES, PROPOSAL_KINDS,
  PROPOSAL_STATUSES, OWNER_ROLES,
  LANE_CATALOG, ALL_LANE_KEYS, EVENT_TYPE_CONFIG,
  oneOf, sameUser, addDays, isISODate, isHHMM, slug, todayISO, nowISO,
  dayAge, isoDiffDays, num, money, intOrNull
};
