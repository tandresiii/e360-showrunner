/* ============================================================================
   e360 SHOWRUNNER — MOCK DATA STORE
   ----------------------------------------------------------------------------
   Shapes track showrunner-app/SCHEMA.md so the wiring pass is a swap, not a
   rewrite:

     PROJECT (event folder)  →  SHOWS[]  →  STEPS[] (6 fixed lanes per type)
     PROJECT                 →  JOBS[]   (one commercial deal = one qb job #)

   Rules held here (all audit fixes):
     · integer ids everywhere (projects, shows, jobs, steps, files, bookings…)
     · dates are ISO YYYY-MM-DD, GENERATED RELATIVE TO TODAY so the demo never
       goes stale. Every show anchors on event_date; every step carries a
       T-minus due_offset_days and a derived due_date (SCHEMA.md keeps both).
     · owners are USERNAMES (users table concept); initials are display-only.
     · stage / status / rag / lane / kind use the server enum values verbatim;
       display labels are mapped at render time.
     · activity is structured {actor, action, detail, ts} — NO raw HTML in data.
   ========================================================================== */

/* ---------------- date spine (relative to the real current date) ---------- */
var TODAY = (function () { var d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
function addDays(date, n) { var d = new Date(date.getTime()); d.setDate(d.getDate() + n); return d; }
function isoDate(date) {
  var m = String(date.getMonth() + 1), d = String(date.getDate());
  return date.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (d.length < 2 ? '0' + d : d);
}
/* day offset from today -> ISO date */
function dayISO(n) { return isoDate(addDays(TODAY, n)); }
var TODAY_ISO = isoDate(TODAY);

/* ---------------- current user + roster (users table concept) ------------- */
/* `finance: true` is a CAPABILITY flag, not a role — it gates margin /
   profitability visibility per TEAM_FEEDBACK ("budgets broadly visible; full
   margin role-gated to management/accounting"). Budgets stay visible to all. */
/* `phone` feeds the schedule call sheet (tel: links onsite). 555-01xx =
   reserved fictional range; staffing roster carries the real numbers. */
/* Admins = Tom, Tony, Jim (Tom's decision, 2026-08-21). Jim Mercer is the
   management third — appended LAST so '@jim' resolves to him, not the Marlins
   client stakeholder Jim Eaton (mentionLookup: last write wins). */
/* `staffing_name` is the identity link to the staffing app, which keys its
   roster, its travel keys and its crew lists on a DISPLAY NAME and has never
   heard of a Showrunner username. Set only where the two systems disagree —
   Showrunner shows the techs by first name, the staffing roster carries their
   full one — which is exactly the case the column exists for. Everybody else
   leaves it unset and travels under the name shown here. */
var USERS = [
  { id: 1, username: 'tandres',  name: 'Tom Andres',     initials: 'TA', color: '#F4B740', role: 'admin',   title: 'Owner · Engineer',           discipline: 'both', finance: true, phone: '(414) 555-0114' },
  { id: 2, username: 'tvigon',   name: 'Tony Vigon',     initials: 'TV', color: '#59A9F0', role: 'admin',   title: 'Ops / Project Lead',         discipline: 'led',   phone: '(414) 555-0127' },
  { id: 3, username: 'bsawyer',  name: 'Brendon Sawyer', initials: 'BS', color: '#35E0A1', role: 'manager', title: 'Field Ops / On-site POC',    discipline: 'led',   phone: '(414) 555-0139' },
  { id: 4, username: 'lfarkos',  name: 'Larry Farkos',   initials: 'LF', color: '#F0616B', role: 'pm',      title: 'Print Production Lead',      discipline: 'print', phone: '(414) 555-0142' },
  { id: 5, username: 'jhawk',    name: 'Josh Hawk',      initials: 'JH', color: '#B98CF0', role: 'pm',      title: 'Content / Graphic Design',   discipline: 'print', phone: '(414) 555-0158' },
  { id: 6, username: 'dvargas',  name: 'Devin',          initials: 'DV', color: '#4ADEDE', role: 'tech',    title: 'Gear / Prep Tech',           discipline: 'led',   phone: '(262) 555-0161', staffing_name: 'Devin Vargas' },
  { id: 7, username: 'aramos',   name: 'Aaron',          initials: 'AR', color: '#F08C59', role: 'tech',    title: 'Install / Field Tech',       discipline: 'both',  phone: '(262) 555-0175', staffing_name: 'Aaron Ramos' },
  { id: 8, username: 'jeaton',   name: 'Jim Eaton',      initials: 'JE', color: '#8ED14A', role: 'viewer',  title: 'Client Stakeholder',         discipline: 'print', phone: '(305) 555-0188' },
  { id: 9, username: 'candice',  name: 'Candice Wren',   initials: 'CW', color: '#E36FBE', role: 'manager', title: 'Accounting · QuickBooks',    discipline: 'both', finance: true, phone: '(414) 555-0196' },
  { id: 10, username: 'jmercer', name: 'Jim Mercer',     initials: 'JM', color: '#7C9FF2', role: 'admin',   title: 'General Manager',            discipline: 'both', phone: '(414) 555-0106' }
];
var ROSTER = {};                                  /* username -> user */
var USERS_BY_ID = {};
USERS.forEach(function (u) { ROSTER[u.username] = u; USERS_BY_ID[u.id] = u; });

/* THE PICKER ROSTER — everybody who can still be handed work.
   ---------------------------------------------------------------------------
   USERS is the read-through cache and keeps every person it has ever seen,
   deactivated ones included, because the app has to be able to render the name
   on work a former teammate did. The moment an admin opens Team & Roles the
   store also holds the people who have LEFT (that view asks for `?all=1`), and
   from then on any picker reading USERS directly would offer them.

   So: USERS is the RECORD, activeUsers() is the ROSTER. Anything that assigns,
   notifies, crews or @mentions reads this one; anything that renders history
   reads USERS. Getting that backwards is how a person who left in March ends
   up on a call sheet in June. */
function activeUsers() {
  return USERS.filter(function (u) { return u.active !== false; });
}

/* ME stays a constant for now, but it READS from CURRENT_USER. */
var CURRENT_USER = ROSTER.tandres;
var ME = CURRENT_USER.username;

/* ---------------- roles ---------------------------------------------------- */
var ROLES = {
  admin:   { name: 'Admin',   cls: 'acc',  ic: 'shield', col: 'var(--accent)', can: ['admin', 'manager', 'pm', 'tech', 'viewer'], desc: 'Full control of the workspace — manages templates, the roster, integrations and every event folder.' },
  manager: { name: 'Manager', cls: 'info', ic: 'users',  col: 'var(--info)',   can: ['pm', 'tech', 'viewer'], desc: 'Runs events end-to-end. Edits pipelines and assigns PMs, techs and viewers on any event.' },
  pm:      { name: 'PM',      cls: 'go',   ic: 'checkC', col: 'var(--go)',     can: ['tech', 'viewer'], desc: 'Owns an event folder. Assigns techs and viewers on the events they lead.' },
  tech:    { name: 'Tech',    cls: 'warn', ic: 'bolt',   col: 'var(--warn)',   can: [], desc: 'Executes assigned tasks and books gear. Completes work but cannot assign others.' },
  viewer:  { name: 'Viewer',  cls: 'idle', ic: 'eye',    col: 'var(--muted)',  can: [], desc: 'Read-only. Sees folders, specs and approved proofs; cannot edit, assign or book.' }
};
var ROLE_ORDER = ['admin', 'manager', 'pm', 'tech', 'viewer'];
/* Guarded accessor — the ROLES analogue of typeDef(). In API mode the role
   comes off the SERVER's users row, so a role this build does not know about
   (a new one added server-side, or a null on a half-hydrated session) must
   degrade to a readable pill, never throw from inside a renderer and take the
   view down. Falls back to 'viewer' — the least-privilege label — and keeps
   the unknown key as the display name so it is visible, not silently wrong. */
function roleDefOf(role) {
  if (ROLES[role]) return ROLES[role];
  var base = ROLES.viewer;
  return { name: role ? String(role) : 'Unknown', cls: base.cls, ic: base.ic,
           col: base.col, can: [], desc: base.desc };
}
function roleName(role) { return roleDefOf(role).name; }

/* ---------------- canonical vocabulary (server enums) --------------------- */
/* steps.status */
var STATUS = {
  todo:        { pill: 'idle', label: 'To do',       bar: 'var(--surface-3)' },
  in_progress: { pill: 'info', label: 'In progress', bar: 'var(--info)' },
  done:        { pill: 'go',   label: 'Done',        bar: 'var(--go)' },
  blocked:     { pill: 'crit', label: 'Blocked',     bar: 'var(--crit)' },
  na:          { pill: 'idle', label: 'N/A',         bar: 'var(--surface-3)' }
};
var STATUS_ALIAS = { wip: 'in_progress', block: 'blocked', crit: 'blocked', prog: 'in_progress' };
function normStatus(s) { return STATUS[s] ? s : (STATUS_ALIAS[s] || 'todo'); }

/* projects.stage / shows.stage — enum value -> display label.

   F5 (Tom-confirmed, 2026-08-27). The COMMERCIAL LIFECYCLE lands as a UNION:
   the legacy five stay exactly as they are — no stored row is ever rewritten —
   and the six lifecycle values join them.

     quoted → confirmed → in_progress → delivered → closed → archived

   STAGE_ALIAS maps a legacy value onto its lifecycle POSITION so a chip, a
   timeline and the push gate can ORDER an old row without touching it. It is a
   display/ordering map and nothing more: the CONFIRM FACT is `confirmed_at`,
   never the stage string, so a legacy row reads as confirmed-by-position with
   no datestamp — which is the truth about it.

   Mirrors lib/enums.js exactly. */
var LEGACY_STAGES = ['lead', 'planning', 'ready', 'scheduled', 'closed'];
var LIFECYCLE_STAGES = ['quoted', 'confirmed', 'in_progress', 'delivered', 'closed', 'archived'];
var STAGES = LEGACY_STAGES.concat(LIFECYCLE_STAGES.filter(function (s) {
  return LEGACY_STAGES.indexOf(s) < 0;
}));
var STAGE_ALIAS = { lead: 'quoted', planning: 'confirmed', ready: 'confirmed',
                    scheduled: 'in_progress' };
var STAGE_LABELS = {
  lead: 'Sales', planning: 'Planning', ready: 'Ready', scheduled: 'Scheduled', closed: 'Closed',
  quoted: 'Quoted', confirmed: 'Confirmed', in_progress: 'In progress',
  delivered: 'Delivered', archived: 'Archived'
};
function stageLabel(s) { return STAGE_LABELS[s] || s; }
function canonicalStage(s) {
  var v = String(s || '');
  if (LIFECYCLE_STAGES.indexOf(v) >= 0) return v;
  return STAGE_ALIAS[v] || 'quoted';
}
function stageIndex(s) { return LIFECYCLE_STAGES.indexOf(canonicalStage(s)); }
function stageAtLeast(s, min) { return stageIndex(s) >= LIFECYCLE_STAGES.indexOf(min); }
/* THE confirm predicate — an explicit datestamp, or a stage POSITION at or past
   'confirmed'. The second clause is what keeps every pre-existing row pushable. */
function isConfirmed(row) {
  if (!row) return false;
  if (row.confirmed_at) return true;
  return stageAtLeast(row.stage, 'confirmed');
}
/* a legacy row is confirmed by POSITION but has no datestamp to show for it */
function confirmIsLegacy(row) { return !!row && !row.confirmed_at && isConfirmed(row); }

/* shows.rag */
var RAG = { go: ['go', 'On track'], warn: ['warn', 'At risk'], crit: ['crit', 'Late'], idle: ['idle', 'Sales'] };
/* proof round statuses (print) */
var PS = { approved: ['go', 'Approved'], review: ['warn', 'Client review'], sent: ['info', 'Sent'], rev: ['crit', 'Revisions'] };

/* files.kind (server enum) + the extra artifact axis — see report/schema Qs.
   Accounting pass extends the whitelist with the financial doc types the agent
   API files (AGENT_API.md §3): receipt · invoice · po (+ transcript · photo). */
var FILE_KINDS = ['spec', 'proof', 'contract', 'confirmation', 'recording', 'other',
                  'receipt', 'invoice', 'po', 'transcript', 'photo'];
/* the subset that IS a financial document — drives the finance feed + tab */
var FIN_KINDS = { receipt: 1, invoice: 1, po: 1, confirmation: 1 };
var SPEC_TYPES = ['e360', 'nsf', 'pcfg'];

/* ============================================================================
   EVENT TYPES — THE EXTENSIBILITY SPINE
   ----------------------------------------------------------------------------
   Each event TYPE defines its OWN lane set, and types are EXTENSIBLE. Nothing
   about lanes is hardcoded in the render layer — a Show renders whatever lanes
   ITS project type declares (see laneSteps() / tabPipeline).

   ---- HOW TO ADD A NEW EVENT TYPE (e.g. Motion Graphics) --------------------
   1. If it needs new lanes, add them to LANES once:
        storyboard:{key:'storyboard',label:'Storyboard',color:'#F58BB0'},
        animation :{key:'animation', label:'Animation', color:'#7C9FF2'},
        render    :{key:'render',    label:'Render / Delivery',color:'#4ADEDE'}
   2. Add ONE config entry:
        motion:{ label:'Motion Graphics', tag:'both', icon:'play', anchor:'Delivery day',
                 lanes: laneset('client','storyboard','animation','render','deliverables') }
   3. (optional) add a TEMPLATE_STEPS['motion'] block.
   That's the whole change — dashboard RAG rollup, folder, pipeline, templates
   grid and calendar are all lane-agnostic and pick it up automatically.
   ========================================================================== */
var LANES = {
  client:       { key: 'client',       label: 'Client',              color: '#59A9F0' },
  venue:        { key: 'venue',        label: 'Venue',               color: '#8ED14A' },
  logistics:    { key: 'logistics',    label: 'Logistics',           color: '#F4B740' },
  crew:         { key: 'crew',         label: 'Crew',                color: '#35E0A1' },
  gear:         { key: 'gear',         label: 'Gear',                color: '#B98CF0' },
  deliverables: { key: 'deliverables', label: 'Deliverables',        color: '#4ADEDE' },
  design:       { key: 'design',       label: 'Graphic Design',      color: '#E36FBE' },
  proof:        { key: 'proof',        label: 'Proof Rounds',        color: '#7C9FF2' },
  approval:     { key: 'approval',     label: 'Client Approval',     color: '#C9E265' },
  production:   { key: 'production',   label: 'Into Production',     color: '#F0A24B' },
  tracking:     { key: 'tracking',     label: 'Production Tracking', color: '#4ADEDE' },
  ship:         { key: 'ship',         label: 'Ship',                color: '#F08C59' },
  install:      { key: 'install',      label: 'Install',             color: '#4FD1C5' },
  return:       { key: 'return',       label: 'Return',              color: '#F0616B' }
};
function laneset() { return Array.prototype.slice.call(arguments).map(function (k) { return LANES[k]; }); }

var EVENT_TYPES = {
  led:   { label: 'LED',        tag: 'led',   icon: 'led',    anchor: 'Show day',
           lanes: laneset('client', 'venue', 'logistics', 'crew', 'gear', 'deliverables') },
  print: { label: 'Print',      tag: 'print', icon: 'print',  anchor: 'Install day',
           lanes: laneset('design', 'proof', 'approval', 'production', 'tracking', 'ship', 'install', 'return') },
  both:  { label: 'LED + Print', tag: 'both', icon: 'layers', anchor: 'Show day',
           lanes: laneset('client', 'venue', 'design', 'proof', 'approval', 'logistics', 'crew', 'gear', 'deliverables', 'install') }
  /* <-- EXTENSION POINT: add new event types here (see "HOW TO ADD" above). */
};
function typeDef(t) { return EVENT_TYPES[t] || EVENT_TYPES.led; }
function typeLabel(t) { return typeDef(t).label; }

/* ============================================================================
   F4 · THE SCOPE LINE — "what we're delivering", structured per show
   ----------------------------------------------------------------------------
   Typed per event type (Tom, 2026-08-27): LED carries linear feet / cabinet
   count / cabinet type + pitch; Print carries pieces / sq ft; `both` carries
   BOTH sets — which is why these are flat fields and not a discriminated union.
   A show that starts LED and grows a print package must not lose its LED
   numbers on the way.

   ONE renderer, mirroring lib/enums.js scopeLine() byte for byte, so the show
   header, the season row, the projects table, the call-sheet header and the
   recap stat all print the same string:

     LED   · 800′ · 144× P10
     Print · 12 pcs · 3,400 sq ft
     LED + Print · 800′ · 144× P10 · 12 pcs · 3,400 sq ft
   ========================================================================== */
var SCOPE_KINDS = ['led', 'print', 'both'];
var SCOPE_LABEL = { led: 'LED', print: 'Print', both: 'LED + Print' };
var SCOPE_FIELD_LABEL = {
  linear_feet: 'Linear feet', cabinet_count: 'Cabinets', cabinet_type: 'Cabinet type',
  pitch: 'Pitch', print_pieces: 'Pieces', print_sqft: 'Square feet'
};
/* accepts either a scope object or a show row carrying the scope_* fields */
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
function _scopeNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function _scopeGrouped(v) {
  var n = _scopeNum(v);
  if (n === null) return '';
  var r = Math.round(n * 100) / 100, parts = String(r).split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts[1] ? '.' + parts[1] : '');
}
function scopeParts(raw) {
  var sc = scopeOf(raw);
  if (!sc || !sc.kind || SCOPE_KINDS.indexOf(sc.kind) < 0) return [];
  var out = [SCOPE_LABEL[sc.kind]];
  if (sc.kind === 'led' || sc.kind === 'both') {
    if (_scopeNum(sc.linear_feet) !== null) out.push(_scopeGrouped(sc.linear_feet) + '′');
    if (_scopeNum(sc.cabinet_count) !== null) {
      var spec = [sc.cabinet_type, sc.pitch].map(function (x) { return String(x || '').trim(); })
        .filter(Boolean).join(' ');
      out.push(_scopeGrouped(sc.cabinet_count) + '×' + (spec ? ' ' + spec : ''));
    }
  }
  if (sc.kind === 'print' || sc.kind === 'both') {
    if (_scopeNum(sc.print_pieces) !== null) out.push(_scopeGrouped(sc.print_pieces) + ' pcs');
    if (_scopeNum(sc.print_sqft) !== null) out.push(_scopeGrouped(sc.print_sqft) + ' sq ft');
  }
  /* a kind with no numbers behind it is a label with nothing to say */
  return out.length > 1 ? out : [];
}
function scopeLine(raw) { return scopeParts(raw).join(' · '); }
function hasScope(raw) { return scopeParts(raw).length > 0; }

/* ============================================================================
   RECORD BUILDERS — allocate integer ids, keep authoring terse
   ========================================================================== */
var _stepSeq = 0, _fileSeq = 0, _bookingSeq = 0, _actSeq = 0, _proofSeq = 0, _roundSeq = 0,
    _msSeq = 0;

/* mkStep(lane, title, status, ownerUsername|null, dueOffsetDays, extras)
   extras: {risk, auto:'spec_gen'|'novaspec'|'powerspec'|'flex'|'travel',
            dep:'<upstream step title in this show>', evidence, ref, notes} */
function mkStep(lane, title, status, owner, off, x) {
  x = x || {};
  return {
    id: ++_stepSeq, show_id: 0, project_id: null,
    lane: lane, title: title, status: status, owner: owner || null,
    due_date: '', due_offset_days: off,
    evidence_type: x.evidence || 'none', evidence_ref: x.ref || '',
    depends_on: null, _dep_title: x.dep || null,
    auto_source: x.auto || 'none', sort_order: 0, notes: x.notes || '',
    /* `risk` has no backend column yet — see report §4 */
    risk: !!x.risk
  };
}
/* mkFile({name, ext, kind, spec_type, artifact, ver, size(bytes), dim, by, off, meta, chain}) */
function mkFile(o) {
  return {
    id: ++_fileSeq, show_id: 0, project_id: null,
    name: o.name, ext: o.ext,
    kind: o.kind || 'other', spec_type: o.spec_type || null,
    /* `artifact` carries what `kind` can't express (pullsheet / manifest /
       image). See report §4 — schema question for the wiring pass. */
    artifact: o.artifact || null,
    ver: o.ver || 'v1',                 /* no backend column yet — report §4 */
    size: o.size == null ? 0 : o.size,  /* BIGINT bytes */
    dim: o.dim || '—',                  /* display-only */
    uploaded_by: o.by || 'tandres',
    created_at: dayISO(o.off == null ? 0 : o.off),
    nas_path: '', meta: o.meta || '', chain_key: o.chain || null,
    /* financial-doc columns (AGENT_API schema hooks — files.amount/vendor/
       doc_date/job_id/status/provenance). Null/'filed' on ordinary files. */
    amount: o.amount == null ? null : o.amount,
    vendor: o.vendor || null,
    doc_date: o.doc_date || null,
    job_id: o.job_id || null,               /* per-item job override */
    status: o.status || 'filed',            /* 'filed' | 'proposed' */
    provenance: o.provenance || null        /* null = human upload */
  };
}
/* mkSpecVer(node, specType, rev, off, by, state[, fileName]) — one row of a
   show's spec version history. Mirrors GET /shows/:id/spec-history exactly:
   `state` is one of current | outdated | superseded | unbound, derived
   server-side and seeded literally here so the chips render from file://. */
var _specVerSeq = 9000;
function mkSpecVer(node, specType, rev, off, by, state, fileName) {
  return { id: ++_specVerSeq, node: node, specType: specType, rev: rev,
           fileId: null, fileName: fileName || '',
           boundBy: by || 'tandres', boundAt: dayISO(off) + 'T14:00',
           state: state || 'superseded' };
}
/* mkGearSnapshot({label, kind, docNumber, name, off, fetched_off, by, sheet})
   — a banked pull-sheet/manifest record, the gear_snapshots row's shape. The
   count columns are derived from the sheet so list and body cannot disagree. */
var _snapSeq = 9500;
function mkGearSnapshot(o) {
  var sheet = o.sheet || { groups: [], totals: { groups: 0, lines: 0, units: 0 } };
  var t = sheet.totals || { groups: 0, lines: 0, units: 0 };
  return {
    id: ++_snapSeq, show_id: 0,
    element_id: o.element_id || null, list_id: o.list_id || null,
    kind: o.kind || '', doc_label: o.label || 'Equipment list',
    doc_number: o.docNumber || '', name: o.name || '',
    groups_count: t.groups || 0, lines_count: t.lines || 0, units_count: t.units || 0,
    sheet: sheet,
    fetched_at: dayISO(o.fetched_off == null ? (o.off || 0) : o.fetched_off) + 'T13:05:00',
    saved_by: o.by || 'dvargas',
    created_at: dayISO(o.off == null ? 0 : o.off) + 'T13:06'
  };
}
/* mkBooking(category, vendor, status, jobId, {amount, booked_off, file})
   amount + booked_date power the finance feed; file_id = attached paperwork
   (a financial doc). Booked/ordered WITHOUT paperwork -> "waiting on me". */
function mkBooking(category, vendor, status, jobId, x) {
  x = x || {};
  return { id: ++_bookingSeq, show_id: 0, job_id: jobId || null, category: category, vendor: vendor, status: status,
           amount: x.amount == null ? null : x.amount,
           booked_date: x.booked_off == null ? null : dayISO(x.booked_off),
           file_id: x.file || null };
}
/* mkAct(actorUsername|null, action, detail|null, dayOffset, 'HH:MM', accent) */
function mkAct(actor, action, detail, off, time, accent) {
  return { id: ++_actSeq, show_id: 0, project_id: null, actor: actor || null, action: action,
           detail: detail || null, ts: dayISO(off) + 'T' + (time || '09:00'), accent: !!accent };
}
function mkProof(code, name, status, client, rounds) {
  return { id: ++_proofSeq, show_id: 0, code: code, name: name, status: status, client: client,
           rounds: rounds.map(function (r) { return { id: ++_roundSeq, round: r[0], date: dayISO(r[1]), status: r[2], note: r[3] }; }) };
}
/* a milestone now carries an id, because the milestone modal edits and deletes
   BY id — the server's rows always had one, and a demo row the modal cannot
   address teaches the wrong shape. show_id/project_id land in hydrate(). */
function mkMs(label, off) { return { id: ++_msSeq, label: label, date: dayISO(off) }; }

/* ============================================================================
   PORTFOLIO — 6 project folders / 11 shows / 8 jobs
   Show day offsets are relative to TODAY, preserving the original demo's
   T-minus shape (AVCA show +10, Marlins install +8, the spring events ~+230).
   ========================================================================== */

/* ---- 1 · AVCA First Serve — single-show LED folder ------------------------ */
var P_AVCA = {
  id: 1, slug: 'avca-first-serve', name: 'AVCA First Serve', client: 'AVCA · Fox & Co',
  type: 'led', stage: 'planning', owner: 'tvigon',
  description: 'Self-contained courtside / perimeter LED show at Fiserv Forum.',
  jobs: [{ id: 1, project_id: 1, qb_job_number: '26-1044', client: 'AVCA · Fox & Co', deal_type: 'rental',
           description: 'AVCA First Serve — courtside + perimeter LED package', contract_value: 96500 }],
  shows: [{
    id: 1, project_id: 1, slug: 'avca-first-serve', name: 'AVCA First Serve',
    venue: 'Fiserv Forum — Milwaukee, WI', city: 'Milwaukee, WI',
    load_in_date: dayISO(9), event_date: dayISO(10), strike_date: dayISO(12),
    stage: 'planning', rag: 'warn', on_site_poc: 'bsawyer', owner: 'tvigon',
    default_job_id: 1, scheduler_event_id: null, cabinets: 48,
    milestones: [mkMs('Content due', 3), mkMs('Load-in', 9), mkMs('Show', 10), mkMs('Strike', 12)],
    summary: 'Kickoff/coordination call with Fiserv Forum + the AVCA/Fox&Co team. E360 runs a self-contained courtside/perimeter LED show; venue runs Daktronics. Sync "big moments" via HD-SDI + shared subnet; Bolt6 stat feed (serve speed, attack, height) via the Python bridge. Logistics mostly routine — but power (no feeder cable on site), the Terraflex load-in timing, and forklift/driver are the open risks.',
    source: 'read.ai · planning call · 38 min',
    steps: [
      mkStep('client', 'First meeting held', 'done', 'tvigon', -28),
      mkStep('client', 'Scope defined + specs confirmed', 'done', 'tvigon', -21),
      mkStep('client', 'Production summary sent to group', 'done', 'tandres', -28, { auto: 'spec_gen' }),
      mkStep('venue', 'Power plan — no feeder on site, union tie-in TBD', 'in_progress', 'tandres', -8, { risk: true }),
      mkStep('venue', 'Confirm load-in window around Terraflex floor', 'in_progress', 'bsawyer', -6),
      mkStep('venue', 'Forklift / certified driver', 'blocked', null, -5),
      mkStep('venue', 'Operator position — Bolt6 area, fiber to court', 'done', 'bsawyer', -28),
      mkStep('logistics', 'Source ~200ft 3-phase feeder + cam-lok', 'todo', null, -7),
      mkStep('logistics', 'Book truck / freight to Milwaukee', 'todo', 'bsawyer', -6, { evidence: 'booking' }),
      mkStep('logistics', 'Book tech travel + lodging', 'todo', 'bsawyer', -4, { dep: 'Book truck / freight to Milwaukee', evidence: 'booking' }),
      mkStep('crew', 'Assign install + show crew', 'in_progress', 'tvigon', -6),
      mkStep('crew', 'Brendon → on-site POC', 'done', 'bsawyer', -28),
      mkStep('crew', 'Book stagehands (IATSE via production)', 'todo', null, -4),
      mkStep('gear', 'Flex folder + pull sheet', 'todo', 'dvargas', -5, { auto: 'flex' }),
      mkStep('gear', 'Bolt6 bridge prep — collegiate thresholds', 'in_progress', 'tandres', -3),
      mkStep('gear', 'Prep / scan-out', 'todo', 'dvargas', -2),
      mkStep('deliverables', 'LED content spec (.e360)', 'done', 'tandres', -28, { auto: 'spec_gen' }),
      mkStep('deliverables', 'Cabling + power sheets (.nsf/.pcfg)', 'todo', 'tandres', -5, { dep: 'LED content spec (.e360)' }),
      mkStep('deliverables', 'Content package — client submits', 'todo', 'jhawk', -7)
    ],
    files: [
      mkFile({ name: 'AVCA First Serve — LED Spec', ext: 'e360', kind: 'spec', spec_type: 'e360', ver: 'v1', size: 421888, dim: '2 zones · 1408 x 96', by: 'tandres', off: -28, meta: 'banked · baseline', chain: 'content' }),
      mkFile({ name: 'Planning Call — recap', ext: 'pdf', kind: 'other', size: 184320, by: 'tandres', off: -28, meta: 'read.ai · 38 min' }),
      mkFile({ name: 'Fiserv Forum — venue map', ext: 'pdf', kind: 'other', size: 2202010, dim: 'A2', by: 'bsawyer', off: -27, meta: 'venue packet' }),
      mkFile({ name: 'Bolt6 data — bridge notes', ext: 'md', kind: 'other', size: 22528, by: 'tandres', off: -26, meta: 'thresholds + WebSocket' }),
      mkFile({ name: 'AVCA — master agreement', ext: 'pdf', kind: 'contract', size: 1468006, by: 'tvigon', off: -30, meta: 'signed' }),
      mkFile({ name: 'Courtside render', ext: 'jpg', kind: 'other', artifact: 'image', size: 5452595, dim: '3840 x 1080', by: 'tandres', off: -28, meta: 'concept' })
    ],
    bookings: [
      mkBooking('Forklift', 'TBD — rent vs IATSE driver', 'blocked'),
      /* ordered 4 days ago, no confirmation on file -> "waiting on me" */
      mkBooking('Stagehands (×4)', 'IATSE via production', 'in_progress', null, { amount: 4800, booked_off: -4 }),
      mkBooking('Truck / freight', '—', 'todo'),
      mkBooking('Crew travel', 'AmTrav (draft)', 'todo'),
      mkBooking('Lodging', '—', 'todo')
    ],
    proofs: [],
    activity: [
      mkAct('tandres', 'banked the LED content spec to Deliverables', null, -28, '16:20', true),
      mkAct(null, 'AI summary of the planning call posted to the folder', null, -28, '11:12', true),
      mkAct('tvigon', 'flagged Power as at-risk — no feeder cable on site', null, -28, '11:05'),
      mkAct('bsawyer', 'set as on-site point of contact', null, -28, '11:01'),
      mkAct(null, 'Event created from the confirmed AVCA engagement', null, -30, '09:30')
    ],
    chain: { content: [1, 1, 0, -28, 'tandres'], cabling: [0], power: [0], pull: [0] },
    gear: { linked: false, pulled: false, elementId: null }
  }]
};

/* ---- 2 · Marlins Perimeter Wraps — single-show PRINT folder --------------- */
var P_MARLINS = {
  id: 2, slug: 'marlins-perimeter-wraps', name: 'Marlins Perimeter Wraps', client: 'Miami Marlins',
  type: 'print', stage: 'ready', owner: 'lfarkos',
  description: 'Large-format perimeter wrap package for loanDepot Park.',
  jobs: [{ id: 2, project_id: 2, qb_job_number: '26-0998', client: 'Miami Marlins', deal_type: 'sale',
           description: 'Perimeter wraps, dugout rail + on-deck circle', contract_value: 74200 }],
  shows: [{
    id: 2, project_id: 2, slug: 'marlins-perimeter-wraps', name: 'Marlins Perimeter Wraps',
    venue: 'loanDepot Park — Miami, FL', city: 'Miami, FL',
    load_in_date: dayISO(8), event_date: dayISO(8), strike_date: dayISO(15),
    stage: 'ready', rag: 'go', on_site_poc: 'jhawk', owner: 'lfarkos',
    default_job_id: 2, scheduler_event_id: null, cabinets: 0,
    milestones: [mkMs('Proof approved', -5), mkMs('Into production', -4), mkMs('Freight', 4), mkMs('Install', 8)],
    summary: 'Large-format perimeter wrap package for loanDepot Park — 14 rail panels plus dugout rail and the on-deck circle. R2 proofs were approved by the club after a blue color-match revision on panels 3-7 (matched to PMS 298 C); approved files were released to the print floor the next morning. Media is on order — 13oz blockout mesh, ~1,240 sf. Print run and finishing are next, targeting freight in four days and an install a week out. Watch sponsor-logo clearances on the outfield line-wrap set — still in client review.',
    source: 'Job jacket · Print-floor sync',
    steps: [
      mkStep('design', 'Collect Marlins brand kit + Pantone build', 'done', 'jhawk', -31),
      mkStep('design', 'Lay out 14 perimeter panels to rail dielines', 'done', 'jhawk', -27, { auto: 'spec_gen' }),
      mkStep('design', 'Dugout rail + on-deck circle artwork', 'done', 'jhawk', -25),
      mkStep('design', 'Internal color / QC pass on export set', 'done', 'lfarkos', -23),
      mkStep('proof', 'R1 proof set to Marlins creative', 'done', 'lfarkos', -21, { auto: 'spec_gen' }),
      mkStep('proof', 'R1 markup back — blue too warm, panels 3-7', 'done', 'jhawk', -19),
      mkStep('proof', 'R2 proof set — color-corrected', 'done', 'lfarkos', -17),
      mkStep('proof', 'R2 held for club sign-off', 'done', 'lfarkos', -15),
      mkStep('approval', 'Final proof PDF issued for signature', 'done', 'lfarkos', -14, { auto: 'spec_gen' }),
      mkStep('approval', 'Marlins approval received (e-sign)', 'done', 'jeaton', -13),
      mkStep('approval', 'Approved proof locked + versioned', 'done', 'lfarkos', -13),
      mkStep('production', 'Release approved files to print floor', 'done', 'lfarkos', -12),
      mkStep('production', 'Media order — 13oz blockout mesh, 1,240 sf', 'done', 'dvargas', -11, { dep: 'Release approved files to print floor' }),
      mkStep('production', 'Ganged RIP + print queue scheduled', 'in_progress', 'dvargas', -7),
      mkStep('tracking', 'Print run — panels 1-14', 'in_progress', 'dvargas', -6),
      mkStep('tracking', 'Hem, grommet + pole-pocket finishing', 'todo', 'aramos', -5),
      mkStep('tracking', 'QC against approved proof + count', 'todo', 'lfarkos', -4, { dep: 'Print run — panels 1-14' }),
      mkStep('ship', 'Crate + label by rail section', 'todo', 'aramos', -3),
      mkStep('ship', 'Freight to loanDepot Park — dock C', 'todo', null, -2, { dep: 'Crate + label by rail section', evidence: 'booking' }),
      mkStep('ship', 'Delivery confirmation + BOL to folder', 'todo', null, -1, { auto: 'flex' }),
      mkStep('install', 'On-site crew call — 6:00 AM', 'todo', 'aramos', 0),
      mkStep('install', 'Hang + tension perimeter wraps', 'todo', 'aramos', 0),
      mkStep('install', 'Client walk + photo documentation', 'todo', 'lfarkos', 0, { auto: 'flex' }),
      mkStep('return', 'De-install post-series', 'todo', null, 7),
      mkStep('return', 'Inspect, fold + inventory to NAS log', 'todo', 'dvargas', 8),
      mkStep('return', 'Close job + archive approved proof', 'todo', 'lfarkos', 9, { auto: 'flex' })
    ],
    files: [
      mkFile({ name: 'Marlins Perimeter Wraps — Approved Proof', ext: 'pdf', kind: 'proof', ver: 'v2', size: 8808038, dim: '2160 x 864', by: 'lfarkos', off: -5, meta: 'v2 · approved' }),
      mkFile({ name: 'Perimeter Wrap — Print Spec', ext: 'e360', kind: 'spec', spec_type: 'e360', ver: 'v1', size: 421888, dim: '14 panels', by: 'lfarkos', off: -4, meta: 'released to floor' }),
      mkFile({ name: 'Panel Layout — Rail Dielines', ext: 'pdf', kind: 'other', ver: 'v3', size: 3355443, dim: 'A1', by: 'jhawk', off: -27, meta: 'dieline set' }),
      mkFile({ name: 'Dugout Rail Artwork', ext: 'jpg', kind: 'other', artifact: 'image', ver: 'v2', size: 6396509, dim: '4096 x 1024', by: 'jhawk', off: -25, meta: 'concept render' }),
      mkFile({ name: 'Marlins Brand Kit + Pantone', ext: 'pdf', kind: 'other', size: 1153434, by: 'jhawk', off: -31, meta: 'PMS 298 C / 156 C' }),
      mkFile({ name: 'Signed Approval — e-sign record', ext: 'pdf', kind: 'contract', size: 225280, by: 'jeaton', off: -5, meta: 'e-sign record' })
    ],
    bookings: [],
    proofs: [
      mkProof('P-01', 'Perimeter Wraps — Panels 1-14', 'approved', 'Miami Marlins · creative', [
        ['R1', -21, 'rev', 'Marlins blue reads warm on panels 3-7 — match to PMS 298 C, keep red at 156 C.'],
        ['R2', -17, 'approved', 'Color corrected across the run. Club signed off via e-sign.']
      ]),
      mkProof('P-02', 'Dugout Rail + On-Deck Circle', 'approved', 'Miami Marlins · creative', [
        ['R1', -20, 'approved', 'Approved as submitted — no changes requested.']
      ]),
      mkProof('P-03', 'Outfield Line Wraps — Sponsor Set', 'review', 'Miami Marlins · creative', [
        ['R1', -16, 'sent', 'Sent to club — awaiting sponsor logo clearances before sign-off.']
      ])
    ],
    activity: [
      mkAct('lfarkos', 'locked the approved proof (v2) and archived it to the folder', null, -5, '15:40', true),
      mkAct(null, 'Approved files released to the print floor', null, -4, '09:02', true),
      mkAct('jeaton', 'returned e-sign approval on R2', 'Miami Marlins', -5, '15:31'),
      mkAct('jhawk', 'corrected panels 3-7 to PMS 298 C and issued R2', null, -17, '11:20'),
      mkAct('lfarkos', 'logged R1 markup from the club', null, -19, '16:05'),
      mkAct(null, 'Event created from the Print job template', null, -32, '10:15')
    ],
    chain: { content: [0], cabling: [0], power: [0], pull: [0] },
    gear: { linked: false, pulled: false, elementId: null }
  }]
};

/* ---- 3 · LOVB 2026–27 Season — MULTI-SHOW folder (season dashboard) -------
   6 jobs, two deal types (Tom, 2026-08-21): two venues run under LEAGUE
   RENTAL deals (client: LOVB — E360 keeps the gear) and four matches are
   INDIVIDUAL TEAM SALES agreements (client: the team — hardware becomes
   cost-of-goods on that job). Each show's default_job_id is its own deal.
   Split-billing: the traveling kit's freight stays league-covered even on
   sale venues, so those cost items OVERRIDE onto a rental job. */
var LOVB_JOBS = [
  { id: 3, project_id: 3, qb_job_number: '26-1180', client: 'League One Volleyball', deal_type: 'rental',
    description: 'League rental — Madison (Match 1) + traveling-kit legs', contract_value: 62000 },
  { id: 10, project_id: 3, qb_job_number: '26-1219', client: 'LOVB Atlanta', deal_type: 'sale',
    description: 'Atlanta team sale — match LED package (hardware COGS)', contract_value: 61000 },
  { id: 4, project_id: 3, qb_job_number: '26-1207', client: 'LOVB Houston', deal_type: 'sale',
    description: 'Houston team sale — baseline + tunnel LED package (hardware COGS)', contract_value: 38500 },
  /* POLISH_LIST #5 demo case: the Salt Lake team agreement landed late, so
     Candice has not cut the QuickBooks number yet — but gear is ALREADY on
     order against this job (po2 / po4 lines below). That is exactly the
     situation the temp number exists for: the work never waits on accounting,
     and the job rides the finance chase list until the real number lands. */
  { id: 11, project_id: 3, qb_job_number: 'TEMP-26-014', qb_number_status: 'temp',
    client: 'LOVB Salt Lake', deal_type: 'sale',
    description: 'Salt Lake team sale — match LED package (hardware COGS)', contract_value: 59500 },
  { id: 9, project_id: 3, qb_job_number: '26-1184', client: 'League One Volleyball', deal_type: 'rental',
    description: 'League rental — Omaha (Match 5)', contract_value: 58000 },
  { id: 5, project_id: 3, qb_job_number: '26-1233', client: 'LOVB Austin', deal_type: 'sale',
    description: 'Austin team sale — LED package + courtside rail wraps', contract_value: 64500 },
  /* the third deal type. E360 sells no gear here and rents none: the league
     already owns the cabinets, and this job buys the PEOPLE who run them. It
     carries labour and travel and no hardware line, which is why 'rental'
     would have been the wrong shape — it would imply E360 gear on the floor. */
  { id: 12, project_id: 3, qb_job_number: '26-1240', client: 'League One Volleyball',
    deal_type: 'service',
    description: 'Season tech services — e360 operators on LOVB-owned systems', contract_value: 24000 }
];

function lovbShow(o) {
  return {
    id: o.id, project_id: 3, slug: o.slug, name: o.name, venue: o.venue, city: o.city,
    load_in_date: dayISO(o.d - 1), event_date: dayISO(o.d), strike_date: dayISO(o.d + 1),
    stage: o.stage, rag: o.rag, on_site_poc: o.poc, owner: o.owner || 'bsawyer',
    default_job_id: o.job || 3, scheduler_event_id: null, cabinets: o.cabinets || 40,
    milestones: [mkMs('Content due', o.d - 7), mkMs('Load-in', o.d - 1), mkMs('Match', o.d), mkMs('Strike', o.d + 1)],
    summary: o.summary, source: o.source || 'Season plan · LOVB ops',
    steps: o.steps, files: o.files || [], bookings: o.bookings || [], proofs: [],
    activity: o.activity || [],
    chain: o.chain || { content: [0], cabling: [0], power: [0], pull: [0] },
    gear: o.gear || { linked: false, pulled: false, elementId: null }
  };
}

var P_LOVB = {
  id: 3, slug: 'lovb-2026-27-season', name: 'LOVB 2026–27 Season', client: 'League One Volleyball',
  type: 'led', stage: 'planning', owner: 'bsawyer',
  description: 'Repeatable league-match LED kit that travels city to city across the 2026–27 LOVB season.',
  summary: 'Repeatable league-match LED kit that travels city to city across the 2026–27 LOVB season — six matches on the calendar. The kit is a fixed traveling package; per-city work is venue advance, crew travel and the per-match content refresh. Commercially it is six deals: Madison and Omaha run under league rental agreements (E360 keeps the gear), while Atlanta, Houston, Salt Lake and Austin are individual team sales agreements — hardware is cost-of-goods on those jobs. Kit freight stays league-covered on every leg, so it bills to the rental jobs even at sale venues.',
  source: 'Season plan · LOVB ops',
  jobs: LOVB_JOBS,
  milestones: [mkMs('Kit prep', 91), mkMs('First match', 116), mkMs('Last match', 250), mkMs('Season wrap', 257)],
  shows: [
    /* -- Match 1 · Madison — RICH, carries the season spec + kit manifest -- */
    lovbShow({
      id: 3, slug: 'lovb-madison-match-1', name: 'LOVB Madison — Match 1',
      venue: 'UW Field House — Madison, WI', city: 'Madison, WI', d: 116, job: 3,
      stage: 'planning', rag: 'warn', poc: 'bsawyer', cabinets: 40,
      summary: 'Season opener and the shakedown run for the traveling kit. Season content spec is banked and inherited; the venue advance and the city-to-city freight framework are the open items. Field House has a tight dock window and no house feeder — power tie-in is the item to watch, exactly as it was at Fiserv.',
      steps: [
        mkStep('client', 'Season agreement + match calendar locked', 'done', 'bsawyer', -47),
        mkStep('client', 'Recurring content windows set per city', 'in_progress', 'jhawk', -32),
        mkStep('venue', 'Venue advance — survey + power (Field House)', 'in_progress', 'tvigon', -22, { risk: true }),
        mkStep('venue', 'Dock window + floor protection confirmed', 'todo', 'bsawyer', -18),
        mkStep('venue', 'Operator position + fiber run to court', 'todo', 'bsawyer', -14),
        mkStep('logistics', 'Advance-freight plan city-to-city', 'todo', 'bsawyer', -19, { evidence: 'booking' }),
        mkStep('logistics', 'Crew travel framework (6 legs)', 'todo', 'bsawyer', -16, { dep: 'Advance-freight plan city-to-city', evidence: 'booking' }),
        mkStep('logistics', 'Truck / freight — leg 1 to Madison', 'todo', 'bsawyer', -12, { evidence: 'booking' }),
        mkStep('crew', 'Name traveling operator pool', 'done', 'bsawyer', -47),
        mkStep('crew', 'Assign match-1 operators', 'in_progress', 'tvigon', -14),
        mkStep('crew', 'Book local stagehands', 'todo', null, -8),
        mkStep('gear', 'Travel kit pull + case check', 'in_progress', 'dvargas', -25, { auto: 'flex' }),
        mkStep('gear', 'Prep / scan-out — leg 1', 'todo', 'dvargas', -4),
        mkStep('deliverables', 'Master season content spec (.e360)', 'done', 'tandres', -49, { auto: 'spec_gen' }),
        mkStep('deliverables', 'Per-match package template', 'todo', 'jhawk', -11),
        mkStep('deliverables', 'Match-1 content received + QC', 'todo', 'jhawk', -7, { dep: 'Per-match package template' })
      ],
      files: [
        mkFile({ name: 'LOVB — Season Content Spec', ext: 'e360', kind: 'spec', spec_type: 'e360', ver: 'v1', size: 532480, dim: 'court-side kit', by: 'tandres', off: 67, meta: 'banked · inherited by every match', chain: 'content' }),
        mkFile({ name: 'Traveling Kit — Manifest', ext: 'pdf', kind: 'other', size: 860160, by: 'dvargas', off: 71, meta: 'case list' }),
        mkFile({ name: 'LOVB — Season agreement', ext: 'pdf', kind: 'contract', size: 1468006, by: 'bsawyer', off: 69, meta: 'signed · league deal' })
      ],
      bookings: [
        mkBooking('Advance freight (6 legs)', 'TBD', 'todo'),
        mkBooking('Crew travel — leg 1', 'AmTrav', 'todo'),
        mkBooking('Stagehands', 'Local labor', 'todo'),
        /* the booked room block the rooming list (seedSchedule) links into —
           one booking row for six beds is exactly the gap TEAM_FEEDBACK's
           "Rooming lists" entry names */
        mkBooking('Lodging — crew room block', "The Governor's Inn", 'done', null, { amount: 2140, booked_off: -5 })
      ],
      activity: [
        mkAct('tandres', 'banked the season content spec — every match inherits it', null, 67, '14:10', true),
        mkAct('bsawyer', 'locked the 6-match calendar', null, 69, '09:00'),
        mkAct('tvigon', 'flagged the Field House power tie-in as at-risk', null, 80, '11:30')
      ],
      chain: { content: [1, 1, 0, 67, 'tandres'], cabling: [0], power: [0], pull: [0] },
      gear: { linked: true, pulled: false, elementId: '2a41c7de-90bb-4e21-9f3a-77c1e4b8a012' }
    }),
    /* -- Match 2 · Atlanta — RICH -- */
    lovbShow({
      id: 4, slug: 'lovb-atlanta-match-2', name: 'LOVB Atlanta — Match 2',
      venue: 'Gas South Arena — Duluth, GA', city: 'Atlanta, GA', d: 138, job: 10,
      stage: 'planning', rag: 'go', poc: 'aramos', cabinets: 40,
      summary: 'Second leg, and the first of the team sales agreements — the match package bills to Atlanta’s own job, with the hardware carried as cost-of-goods. Gas South has run our kit before, so the advance is short. Freight rolls straight from Madison and stays league-covered, so that cost item bills to the league rental job, not Atlanta’s.',
      steps: [
        mkStep('client', 'Match-2 content window confirmed', 'done', 'jhawk', -30),
        mkStep('venue', 'Venue advance — reuse prior Gas South packet', 'done', 'tvigon', -24),
        mkStep('venue', 'Dock + load-in window confirmed', 'done', 'bsawyer', -18),
        mkStep('logistics', 'Freight leg Madison → Atlanta', 'in_progress', 'bsawyer', -14, { evidence: 'booking' }),
        mkStep('logistics', 'Crew travel — leg 2', 'todo', 'bsawyer', -12, { dep: 'Freight leg Madison → Atlanta', evidence: 'booking' }),
        mkStep('crew', 'Assign match-2 operators', 'done', 'tvigon', -16),
        mkStep('crew', 'Book local stagehands', 'in_progress', null, -8),
        mkStep('gear', 'Kit check between legs', 'todo', 'dvargas', -6, { auto: 'flex' }),
        mkStep('gear', 'Prep / scan-out — leg 2', 'todo', 'dvargas', -3),
        mkStep('deliverables', 'Season spec inherited (no per-match gen)', 'done', 'tandres', -30),
        mkStep('deliverables', 'Match-2 content received + QC', 'todo', 'jhawk', -7)
      ],
      files: [
        mkFile({ name: 'Gas South Arena — advance packet', ext: 'pdf', kind: 'other', size: 1153434, by: 'tvigon', off: 100, meta: 'reused from prior visit' })
      ],
      bookings: [
        /* league-covered kit freight ON a sale venue -> overrides to the
           rental job (3), and the invoice isn't in yet -> "waiting on me" */
        mkBooking('Freight — leg 2 (league-covered)', "O'Brien Freight", 'in_progress', 3, { amount: 7800, booked_off: -6 }),
        mkBooking('Crew travel — leg 2', 'AmTrav', 'todo'),
        mkBooking('Stagehands', 'Local labor', 'in_progress')
      ],
      activity: [
        mkAct('tvigon', 'reused the Gas South advance packet — no new survey needed', null, 100, '10:40', true),
        mkAct('bsawyer', 'confirmed the dock + load-in window', null, 104, '13:15')
      ]
    }),
    /* -- Match 3 · Houston — team SALE job (4) + league-covered kit freight -- */
    lovbShow({
      id: 5, slug: 'lovb-houston-match-3', name: 'LOVB Houston — Match 3',
      venue: 'Fertitta Center — Houston, TX', city: 'Houston, TX', d: 160, job: 4,
      stage: 'planning', rag: 'warn', poc: 'aramos', cabinets: 40,
      summary: 'Individual sales agreement with the Houston club — the baseline and tunnel LED package bills to Houston’s own job, and the hardware is cost-of-goods on that deal. The traveling kit’s freight leg stays league-covered, so that one item bills to the league rental job: two deals, one show. Hardware buys have already outrun the sale budget, and the venue advance is not started, so it reads at-risk.',
      steps: [
        mkStep('client', 'Team sale scoped with Houston front office', 'in_progress', 'tvigon', -26),
        mkStep('venue', 'Venue advance — Fertitta Center', 'todo', null, -20, { risk: true }),
        mkStep('logistics', 'Freight leg Atlanta → Houston', 'todo', 'bsawyer', -14, { evidence: 'booking' }),
        mkStep('crew', 'Assign match-3 operators', 'todo', 'tvigon', -14),
        mkStep('gear', 'Add sale baseline + tunnel cabinets to pull', 'todo', 'dvargas', -10, { auto: 'flex' }),
        mkStep('deliverables', 'Match-3 content received + QC', 'todo', 'jhawk', -7)
      ],
      files: [],
      bookings: [
        /* split billing: kit freight is league-covered -> rental job 3 */
        mkBooking('Freight — leg 3 (league-covered)', "O'Brien Freight", 'todo', 3),
        mkBooking('Crew travel — leg 3', 'AmTrav', 'todo'),
        mkBooking('Baseline + tunnel LED — sale hardware', 'e360 inventory', 'todo'),
        mkBooking('Tunnel install labor', 'Local labor', 'todo')
      ],
      activity: [
        mkAct('tvigon', 'opened the Houston team sale as its own QuickBooks job', null, 120, '15:05', true)
      ]
    }),
    /* -- Match 4 · Salt Lake — LIGHT -- */
    lovbShow({
      id: 6, slug: 'lovb-salt-lake-match-4', name: 'LOVB Salt Lake — Match 4',
      venue: 'Maverik Center — West Valley City, UT', city: 'Salt Lake City, UT', d: 187, job: 11,
      stage: 'planning', rag: 'go', poc: 'aramos',
      summary: 'Mid-season leg on a team sales agreement — the match package bills to Salt Lake’s own job. Nothing unusual operationally: standard traveling-kit build on a known arena floor, advance and freight queued behind the earlier legs.',
      steps: [
        mkStep('venue', 'Venue advance — Maverik Center', 'todo', 'tvigon', -20),
        mkStep('logistics', 'Freight leg Houston → Salt Lake', 'todo', 'bsawyer', -14, { evidence: 'booking' }),
        mkStep('crew', 'Assign match-4 operators', 'todo', 'tvigon', -14),
        mkStep('deliverables', 'Match-4 content received + QC', 'todo', 'jhawk', -7)
      ],
      bookings: [mkBooking('Freight — leg 4', 'Regional carrier', 'todo'), mkBooking('Crew travel — leg 4', 'AmTrav', 'todo')],
      activity: [mkAct(null, 'Match created from the LOVB season calendar', null, 69, '09:05')]
    }),
    /* -- Match 5 · Omaha — LIGHT -- */
    lovbShow({
      id: 7, slug: 'lovb-omaha-match-5', name: 'LOVB Omaha — Match 5',
      venue: 'Baxter Arena — Omaha, NE', city: 'Omaha, NE', d: 215, job: 9,
      stage: 'lead', rag: 'idle', poc: 'aramos',
      summary: 'Late-season leg on the second league rental agreement — E360 keeps the gear; the league is the client. Still in the sales/hold column while the league confirms the broadcast window. No advance work started.',
      steps: [
        mkStep('client', 'Broadcast window confirmation from league', 'todo', 'bsawyer', -40),
        mkStep('venue', 'Venue advance — Baxter Arena', 'todo', null, -20),
        mkStep('logistics', 'Freight leg Salt Lake → Omaha', 'todo', 'bsawyer', -14, { evidence: 'booking' }),
        mkStep('deliverables', 'Match-5 content received + QC', 'todo', 'jhawk', -7)
      ],
      bookings: [mkBooking('Freight — leg 5', 'Regional carrier', 'todo')],
      activity: [mkAct(null, 'Match created from the LOVB season calendar', null, 69, '09:06')]
    }),
    /* -- Match 6 · Austin — LIGHT + an Austin team PRINT buy (job 5) -- */
    lovbShow({
      id: 8, slug: 'lovb-austin-match-6', name: 'LOVB Austin — Match 6',
      venue: 'Moody Center — Austin, TX', city: 'Austin, TX', d: 250, job: 5,
      stage: 'planning', rag: 'go', poc: 'aramos',
      summary: 'Season closer at Moody Center on a team sales agreement — LED package plus courtside rail wraps, all billing to Austin’s own job with hardware as cost-of-goods. The kit-return freight is league-covered, so that final leg bills back to the league rental job.',
      steps: [
        mkStep('venue', 'Venue advance — Moody Center', 'todo', 'tvigon', -20),
        mkStep('logistics', 'Freight leg Omaha → Austin + kit return', 'todo', 'bsawyer', -14, { evidence: 'booking' }),
        mkStep('crew', 'Assign match-6 operators', 'todo', 'tvigon', -14),
        mkStep('deliverables', 'Courtside rail wrap artwork — team sale', 'todo', 'jhawk', -21)
      ],
      bookings: [
        /* split billing: kit-return freight is league-covered -> rental job 3 */
        mkBooking('Freight — leg 6 + kit return (league-covered)', "O'Brien Freight", 'todo', 3),
        mkBooking('Courtside rail wraps — print', 'e360 print floor', 'todo')
      ],
      activity: [mkAct('lfarkos', 'set up the Austin team sale — LED package + rail wraps on one job', null, 130, '11:45', true)]
    })
  ]
};

/* ---- 4 · NW Stadium — single-show LED folder ------------------------------ */
var P_NW = {
  id: 4, slug: 'nw-stadium-france-colombia', name: 'NW Stadium — France v Colombia', client: 'Unified Events',
  type: 'led', stage: 'scheduled', owner: 'tvigon',
  description: 'Traveling-crew perimeter LED field-board show for an international friendly.',
  jobs: [{ id: 6, project_id: 4, qb_job_number: '27-1012', client: 'Unified Events', deal_type: 'rental',
           description: 'France v Colombia — perimeter field-board LED', contract_value: 128000 }],
  shows: [{
    id: 9, project_id: 4, slug: 'nw-stadium-france-colombia', name: 'NW Stadium — France v Colombia',
    venue: 'Northwest Stadium', city: 'Landover, MD',
    load_in_date: dayISO(230), event_date: dayISO(231), strike_date: dayISO(231),
    stage: 'scheduled', rag: 'go', on_site_poc: 'aramos', owner: 'tvigon',
    default_job_id: 6, scheduler_event_id: null, cabinets: 96,
    milestones: [mkMs('Content due', 224), mkMs('Load-in', 230), mkMs('Show', 231), mkMs('Strike', 231)],
    summary: 'Traveling-crew perimeter LED field-board show for an international friendly. Power, feeder and load-in are confirmed; crew and pull sheet are set. Remaining work is crew travel finalization, stagehand booking and final content QC on the media server.',
    source: 'Advance packet · Ops',
    steps: [
      mkStep('client', 'Kickoff + scope call', 'done', 'tvigon', -37),
      mkStep('client', 'Production summary sent', 'done', 'tandres', -19, { auto: 'spec_gen' }),
      mkStep('venue', 'Power source + feeder path confirmed', 'done', 'tandres', -24),
      mkStep('venue', 'Load-in window + dock confirmed', 'done', 'bsawyer', -21),
      mkStep('logistics', 'Truck / freight booked', 'done', 'bsawyer', -23, { evidence: 'booking' }),
      mkStep('logistics', 'Crew travel + lodging', 'in_progress', 'bsawyer', -11, { evidence: 'booking' }),
      mkStep('crew', 'Install + show crew assigned', 'done', 'tvigon', -23),
      mkStep('crew', 'Book stagehands', 'in_progress', null, -9),
      mkStep('gear', 'Flex pull sheet built', 'done', 'dvargas', -17, { auto: 'flex' }),
      mkStep('gear', 'Prep / scan-out', 'todo', 'dvargas', -3),
      mkStep('deliverables', 'Content spec (.e360)', 'done', 'tandres', -32, { auto: 'spec_gen' }),
      mkStep('deliverables', 'Cabling + power sheets (.nsf/.pcfg)', 'done', 'tandres', -21, { dep: 'Content spec (.e360)' }),
      mkStep('deliverables', 'Content received + QC on media server', 'in_progress', 'jhawk', -5)
    ],
    files: [
      mkFile({ name: 'NW Stadium — LED Spec', ext: 'e360', kind: 'spec', spec_type: 'e360', ver: 'v2', size: 491520, dim: 'perimeter · 336 panels', by: 'tandres', off: 199, meta: 'banked · v2', chain: 'content' }),
      mkFile({ name: 'Field-board render', ext: 'jpg', kind: 'other', artifact: 'image', size: 5033165, dim: '3840 x 1080', by: 'jhawk', off: 203, meta: 'concept' })
    ],
    bookings: [
      /* confirmed AND paperwork attached (file_id linked in the finance seed)
         — the healthy contrast to STL's missing confirmation below */
      mkBooking('Truck / freight', 'Landstar — dedicated haul', 'done', null, { amount: 7200, booked_off: -23 }),
      mkBooking('Stagehands', 'Local labor', 'in_progress')
    ],
    proofs: [],
    activity: [
      mkAct('dvargas', 'built the Flex pull sheet from the power spec', null, 214, '13:00', true),
      mkAct('tvigon', 'confirmed power + feeder path with the venue', null, 207, '10:30')
    ],
    chain: { content: [1, 2, 0, 199, 'tandres'], cabling: [1, 1, 2, 210, 'tandres'], power: [1, 1, 1, 210, 'tandres'], pull: [1, 1, 1, 214, 'dvargas'] },
    gear: { linked: true, pulled: true, elementId: '6fe1b084-b1cc-4e90-83ce-bbd69eb3e4fa' },
    /* the lifecycle demo twin: content was re-bound once (v1 → v2), so the
       history modal has a superseded row and a current one to chip */
    spec_history: [
      mkSpecVer('content', 'e360', 2, 199, 'tandres', 'current', 'NW Stadium — LED Spec'),
      mkSpecVer('cabling', 'nsf', 1, 210, 'tandres', 'current', 'NW Stadium — Data Cabling'),
      mkSpecVer('power', 'pcfg', 1, 210, 'tandres', 'current', 'NW Stadium — Power Config'),
      mkSpecVer('content', 'e360', 1, 180, 'tandres', 'superseded', 'NW Stadium — LED Spec')
    ],
    /* the gear look-back twin: a pull sheet banked at prep and the case
       manifest banked at ship-out, so Gear history renders from file:// */
    gear_snapshots: [
      mkGearSnapshot({
        label: 'Pull Sheet', kind: 'pull-sheet', docNumber: 'PS-1733',
        name: 'NW Stadium — France v Colombia', off: 214, by: 'dvargas',
        sheet: {
          listId: 'demo-nw-pull', name: 'NW Stadium — France v Colombia',
          docNumber: 'PS-1733', type: 'pull-sheet', deepLink: '',
          fetchedAt: dayISO(214) + 'T13:05:00',
          status: { stages: [
            { key: 'prep', label: 'Prepped', done: true, at: dayISO(214) + 'T11:40:00', by: 'D. Vargas' },
            { key: 'ship', label: 'Shipped', done: false, at: null, by: '' }
          ] },
          groups: [
            { id: 'g1', name: 'LED Cabinets', path: 'LED Cabinets', type: 'category', containerSerial: '',
              items: [
                { name: 'BP2 V2 500x1000 cabinet', qty: 96, barcode: '00114', serial: '', note: '', resourceId: 'res-bp2', contains: 0, qtyAssumed: false },
                { name: 'Spare BP2 module kit', qty: 4, barcode: '00961', serial: '', note: 'ride in case 9', resourceId: 'res-mod', contains: 0, qtyAssumed: false }
              ] },
            { id: 'g2', name: 'Processing', path: 'Processing', type: 'category', containerSerial: '',
              items: [
                { name: 'NovaStar MX40 Pro', qty: 2, barcode: '00410', serial: 'MX4-2211', note: '', resourceId: 'res-mx40', contains: 0, qtyAssumed: false },
                { name: 'Fiber spool 300m', qty: 2, barcode: '00068', serial: '', note: '', resourceId: 'res-fib', contains: 0, qtyAssumed: false }
              ] }
          ],
          totals: { groups: 2, lines: 4, units: 104 },
          empty: false, rowCount: 4
        }
      }),
      mkGearSnapshot({
        label: 'Manifest', kind: 'manifest', docNumber: 'MN-1733',
        name: 'NW Stadium — cases', off: 216, by: 'dvargas',
        sheet: {
          listId: 'demo-nw-manifest', name: 'NW Stadium — cases',
          docNumber: 'MN-1733', type: 'manifest', deepLink: '',
          fetchedAt: dayISO(216) + 'T08:20:00',
          status: { stages: [
            { key: 'ship', label: 'Shipped', done: true, at: dayISO(216) + 'T08:00:00', by: 'D. Vargas' }
          ] },
          groups: [
            { id: 'm1', name: 'Flight cases', path: 'Flight cases', type: 'category', containerSerial: '',
              items: [
                { name: 'Cabinet case (8-pack)', qty: 12, barcode: '', serial: '', note: '', resourceId: 'res-case', contains: 0, qtyAssumed: false },
                { name: 'Processor rack case', qty: 1, barcode: '', serial: 'RK-071', note: '', resourceId: 'res-rack', contains: 0, qtyAssumed: false }
              ] }
          ],
          totals: { groups: 1, lines: 2, units: 13 },
          empty: false, rowCount: 2
        }
      })
    ]
  }]
};

/* ---- 5 · STL / UFL Field Boards — single-show LED folder ------------------ */
var P_STL = {
  id: 5, slug: 'stl-ufl-field-boards', name: 'STL / UFL Field Boards', client: 'UFL · K-Lance',
  type: 'led', stage: 'scheduled', owner: 'tvigon',
  description: 'UFL field-board LED show in St. Louis.',
  jobs: [{ id: 7, project_id: 5, qb_job_number: '27-1009', client: 'UFL · K-Lance', deal_type: 'rental',
           description: 'UFL St. Louis — field-board LED', contract_value: 87500 }],
  shows: [{
    id: 10, project_id: 5, slug: 'stl-ufl-field-boards', name: 'STL / UFL Field Boards',
    venue: 'St. Louis', city: 'St. Louis, MO',
    load_in_date: dayISO(229), event_date: dayISO(230), strike_date: dayISO(230),
    stage: 'scheduled', rag: 'warn', on_site_poc: 'aramos', owner: 'tvigon',
    default_job_id: 7, scheduler_event_id: null, cabinets: 72,
    milestones: [mkMs('Content due', 223), mkMs('Load-in', 229), mkMs('Show', 230), mkMs('Strike', 230)],
    summary: 'UFL field-board LED show in St. Louis. Spec is banked and the crew is being assigned, but the venue power tie-in is still unconfirmed and reads as the biggest risk this close in. Truck is booked; travel and pull sheet still open.',
    source: 'Advance packet · Ops',
    steps: [
      mkStep('client', 'Kickoff + scope call', 'done', 'tvigon', -38),
      mkStep('venue', 'Power tie-in confirmed with venue', 'in_progress', 'tandres', -14, { risk: true }),
      mkStep('venue', 'Load-in window confirmed', 'in_progress', 'bsawyer', -12),
      mkStep('logistics', 'Truck / freight booked', 'done', 'bsawyer', -20, { evidence: 'booking' }),
      mkStep('logistics', 'Crew travel + lodging', 'todo', 'bsawyer', -10, { evidence: 'booking' }),
      mkStep('crew', 'Install + show crew assigned', 'in_progress', 'tvigon', -13),
      mkStep('gear', 'Flex pull sheet', 'todo', 'dvargas', -8, { auto: 'flex' }),
      mkStep('deliverables', 'Content spec (.e360)', 'done', 'tandres', -32, { auto: 'spec_gen' }),
      mkStep('deliverables', 'Cabling + power sheets (.nsf/.pcfg)', 'todo', 'tandres', -13, { dep: 'Content spec (.e360)' })
    ],
    files: [
      mkFile({ name: 'STL Field Boards — LED Spec', ext: 'e360', kind: 'spec', spec_type: 'e360', ver: 'v1', size: 404480, dim: 'perimeter · 288 panels', by: 'tandres', off: 198, meta: 'banked', chain: 'content' }),
      mkFile({ name: 'Power plan — St. Louis', ext: 'pdf', kind: 'other', size: 655360, by: 'tandres', off: 204, meta: 'tie-in TBD' })
    ],
    bookings: [
      /* confirmed 20 days ago, confirmation never reached accounting ->
         the oldest item on the "waiting on me" chase list */
      mkBooking('Truck / freight', 'Landstar — dedicated haul', 'done', null, { amount: 6800, booked_off: -20 }),
      mkBooking('Crew travel', '—', 'todo')
    ],
    proofs: [],
    activity: [
      mkAct('tvigon', 'spec.outdate', 'content v1 flagged outdated — UFL moved to 336 panels, new spec pending', 207, '09:40', true),
      mkAct('tandres', 'banked the STL LED spec', null, 198, '16:00', true),
      mkAct('tvigon', 'flagged the venue power tie-in as at-risk', null, 206, '11:00')
    ],
    /* the OUTDATED twin: the spec is still the bound spec — the client changed
       the board count and nothing new is bound yet — sixth seed slot = flag */
    chain: { content: [1, 1, 0, 198, 'tandres', 1], cabling: [0], power: [0], pull: [0] },
    gear: { linked: false, pulled: false, elementId: null },
    spec_history: [
      mkSpecVer('content', 'e360', 1, 198, 'tandres', 'outdated', 'STL Field Boards — LED Spec')
    ]
  }]
};

/* ---- 6 · NRL @ Allegiant — single-show BOTH folder (sales) ---------------- */
var P_NRL = {
  id: 6, slug: 'nrl-allegiant', name: 'NRL @ Allegiant', client: 'NRL',
  type: 'both', stage: 'lead', owner: 'tvigon',
  description: 'Early-stage sales engagement — combined LED field-board + large-format print package.',
  jobs: [{ id: 8, project_id: 6, qb_job_number: '26-1251', client: 'NRL', deal_type: 'rental',
           description: 'NRL doubleheader — LED field boards + printed field wall (in negotiation)', contract_value: 0 }],
  shows: [{
    id: 11, project_id: 6, slug: 'nrl-allegiant', name: 'NRL @ Allegiant',
    venue: 'Allegiant Stadium — Las Vegas, NV', city: 'Las Vegas, NV',
    load_in_date: dayISO(51), event_date: dayISO(52), strike_date: dayISO(53),
    stage: 'lead', rag: 'idle', on_site_poc: 'tvigon', owner: 'tvigon',
    default_job_id: 8, scheduler_event_id: null, cabinets: 64,
    milestones: [mkMs('Target', 52), mkMs('LED + Print', 52)],
    summary: 'Early-stage sales engagement for an NRL doubleheader at Allegiant — a combined LED field-board + large-format print package (a "Both" event). Scope is still forming across both the LED show side and the printed field-wall/perimeter drape side; contract is in negotiation.',
    source: 'Sales pipeline',
    steps: [
      mkStep('client', 'PO / contract in negotiation', 'in_progress', 'tvigon', -26),
      mkStep('venue', 'Site survey scheduled', 'todo', null, -19),
      mkStep('design', 'Concept design — printed field wall', 'todo', 'jhawk', -11),
      mkStep('logistics', 'Rough freight + labor estimate', 'todo', null, -6),
      mkStep('deliverables', 'Scope both LED + print deliverables', 'todo', 'tandres', -16)
    ],
    files: [
      mkFile({ name: 'NRL Allegiant — Scope draft', ext: 'pdf', kind: 'other', size: 266240, by: 'tvigon', off: -13, meta: 'sales · draft' })
    ],
    bookings: [
      mkBooking('Freight (estimate)', '—', 'todo'),
      mkBooking('Local labor (estimate)', '—', 'todo')
    ],
    proofs: [],
    activity: [
      mkAct('tvigon', 'opened the NRL engagement in Sales', null, -13, '09:15')
    ],
    chain: { content: [0], cabling: [0], power: [0], pull: [0] },
    gear: { linked: false, pulled: false, elementId: null }
  }]
};

/* ---- 7 · Bucks Preseason Courtside — the CLOSEOUT-IN-PROGRESS folder ------
   F2/F6 demo. The show has already happened (strike 11 days ago) and was
   struck, so every crew member owes a show report. Two are in, two are not —
   and one of the two outstanding is TOM's, so the demo user's own My Tasks and
   bell carry a live nag the moment the app opens. The recap is drafted but not
   sent, so the closeout is deliberately INCOMPLETE and you can watch the three
   conditions turn green one at a time.
   Deliberately thin: no expenses, no POs, no photos, no budget lines — this
   folder exists to tell the closeout story, not to move the money numbers. */
var P_BUCKS = {
  id: 7, slug: 'bucks-preseason-courtside', name: 'Bucks Preseason Courtside',
  client: 'Milwaukee Bucks', type: 'led', stage: 'delivered', owner: 'tvigon',
  description: 'Two-night preseason courtside LED. Delivered — closeout running.',
  jobs: [{ id: 20, project_id: 7, qb_job_number: '26-1088', client: 'Milwaukee Bucks',
           deal_type: 'rental', description: 'Preseason courtside LED — two nights',
           contract_value: 41200 }],
  shows: [{
    id: 12, project_id: 7, slug: 'bucks-preseason-courtside', name: 'Bucks Preseason Courtside',
    venue: 'Fiserv Forum — Milwaukee, WI', city: 'Milwaukee, WI',
    load_in_date: dayISO(-14), event_date: dayISO(-12), strike_date: dayISO(-11),
    stage: 'delivered', rag: 'go', on_site_poc: 'bsawyer', owner: 'tvigon',
    default_job_id: 20, scheduler_event_id: null, cabinets: 32,
    confirmed_at: dayISO(-40) + 'T10:12', confirmed_by: 'tvigon',
    struck_at: dayISO(-11) + 'T16:40', struck_by: 'bsawyer',
    scope_kind: 'led', scope_linear_feet: 188, scope_cabinet_count: 32,
    scope_cabinet_type: 'BP2V2', scope_pitch: 'P3.9', scope_source: 'manual',
    scope_verified_at: dayISO(-40) + 'T10:14', scope_verified_by: 'tvigon',
    load_in_time: '08:00', doors_time: '18:00', event_time: '19:00', strike_time: '22:15',
    milestones: [mkMs('Load-in', -14), mkMs('Show', -12), mkMs('Strike', -11)],
    summary: 'Two preseason nights, courtside only. Clean build, clean strike. Closeout is the ' +
             'work that is left: two show reports still outstanding and the client recap is drafted ' +
             'but not sent.',
    source: 'closeout',
    steps: [
      mkStep('client', 'Scope confirmed', 'done', 'tvigon', -30),
      mkStep('venue', 'Load-in window + floor protection', 'done', 'bsawyer', -16),
      mkStep('crew', 'Assign install + show crew', 'done', 'tvigon', -18),
      mkStep('gear', 'Pull + prep courtside kit', 'done', 'dvargas', -15),
      mkStep('logistics', 'Truck to venue', 'done', 'bsawyer', -15),
      mkStep('deliverables', 'Post-event client recap', 'in_progress', 'tvigon', 2)
    ],
    files: [], bookings: [], proofs: [], expenses: [],
    chain: { content: [1, 2, 0, -30, 'tandres'], cabling: [1, 1, 2, -28, 'tandres'],
             power: [1, 1, 1, -28, 'tandres'], pull: [1, 1, 1, -20, 'dvargas'] },
    gear: { linked: true, pulled: true, elementId: 'a220432c-bucks' },
    activity: [
      mkAct('tvigon', 'confirmed the show', 'client committed — scheduler push unlocked', -40, '10:12', true),
      mkAct('bsawyer', 'marked the show struck', '4 show reports now owed', -11, '16:40', true),
      mkAct('aramos', 'filed their show report', 'document in the folder', -10, '09:20'),
      mkAct('bsawyer', 'filed their show report', 'document in the folder', -9, '18:05')
    ]
  }]
};

/* ---- 8 · Brewers Concourse Wraps — the ARCHIVED folder --------------------
   F6 demo. Everything closed out 75 days ago: recap sent, every report filed,
   no money outstanding. Sixty days later the sweep archived it, which is why
   it does NOT appear in the portfolio, the calendar, Files or My Tasks — and
   why the Archive filter is the only way to see it. Season rollups and search
   still reach it, and an admin can put it back with one click. */
var P_BREWERS = {
  id: 8, slug: 'brewers-concourse-wraps', name: 'Brewers Concourse Wraps',
  client: 'Milwaukee Brewers', type: 'print', stage: 'archived', owner: 'lfarkos',
  description: 'Concourse wrap package, opening series. Closed out and archived.',
  archived_at: dayISO(-15) + 'T03:00', archived_by: 'system',
  jobs: [{ id: 21, project_id: 8, qb_job_number: '26-1012', client: 'Milwaukee Brewers',
           deal_type: 'sale', description: 'Concourse wraps — opening series',
           contract_value: 28750 }],
  shows: [{
    id: 13, project_id: 8, slug: 'brewers-concourse-wraps', name: 'Brewers Concourse Wraps',
    venue: 'American Family Field — Milwaukee, WI', city: 'Milwaukee, WI',
    load_in_date: dayISO(-97), event_date: dayISO(-95), strike_date: dayISO(-95),
    stage: 'archived', rag: 'go', on_site_poc: 'lfarkos', owner: 'lfarkos',
    default_job_id: 21, scheduler_event_id: null, cabinets: 0,
    confirmed_at: dayISO(-140) + 'T14:00', confirmed_by: 'lfarkos',
    struck_at: dayISO(-95) + 'T15:00', struck_by: 'lfarkos',
    closeout_complete_at: dayISO(-75) + 'T11:30',
    archived_at: dayISO(-15) + 'T03:00', archived_by: 'system',
    scope_kind: 'print', scope_print_pieces: 34, scope_print_sqft: 4120,
    scope_source: 'manual', scope_verified_at: dayISO(-140) + 'T14:02',
    scope_verified_by: 'lfarkos',
    load_in_time: '06:00', event_time: '12:00',
    milestones: [mkMs('Install', -97), mkMs('Opening series', -95)],
    summary: 'Thirty-four concourse pieces, installed over two mornings. Closed out cleanly ' +
             'and archived automatically sixty days later.',
    source: 'closeout',
    steps: [
      mkStep('design', 'Artwork to venue dielines', 'done', 'jhawk', -30),
      mkStep('approval', 'Client approval', 'done', 'lfarkos', -20),
      mkStep('production', 'Release to print floor', 'done', 'lfarkos', -14),
      mkStep('install', 'Install + client walk', 'done', 'aramos', -2)
    ],
    files: [], bookings: [], proofs: [], expenses: [],
    chain: {}, gear: { linked: false, pulled: false, elementId: null },
    activity: [
      mkAct('lfarkos', 'confirmed the show', 'client committed', -140, '14:00', true),
      mkAct('lfarkos', 'recap sent to Milwaukee Brewers', 'marked sent by hand', -76, '16:20', true),
      mkAct('system', 'closeout complete', 'recap sent · 2/2 reports filed · finance clear', -75, '11:30', true),
      mkAct('system', 'archived the show', 'auto-archived — closeout completed more than 60 days ago', -15, '03:00', true)
    ]
  }]
};

var PROJECTS = [P_AVCA, P_MARLINS, P_LOVB, P_NW, P_STL, P_NRL, P_BUCKS, P_BREWERS];

/* ============================================================================
   FINANCE SEED — budgets · expenses · financial docs  (accounting pass)
   ----------------------------------------------------------------------------
   One shared category vocabulary across budget_lines / expenses / bookings.
   budget_lines : {id, job_id, category, allotted, notes}
   expenses     : {id, show_id, project_id, job_id(null = inherit show default),
                   budget_line_category, vendor, amount, txn_date,
                   status 'filed'|'proposed', file_id (evidence doc), by,
                   provenance (agent writes only), memo}
   financial doc: a FILE with kind receipt|invoice|po|confirmation plus
                   amount/vendor/doc_date/job_id/status/provenance — exactly
                   the AGENT_API schema hooks, so the agent API lands with
                   zero migrations.
   ========================================================================== */
var BUDGET_CATS = { travel: 'Travel', freight: 'Freight', labor: 'Labor', gear: 'Gear',
                    print: 'Print', production: 'Production', misc: 'Misc' };
var BUDGET_CAT_ORDER = ['travel', 'freight', 'labor', 'gear', 'print', 'production', 'misc'];

var _budgetSeq = 0, _expSeq = 0, _finEvSeq = 0, _provSeq = 0;
var BUDGET_LINES = [];
/* the id index every other entity already had. api.js A.budget() merges into it
   with keep(), so a budget line is ONE object across BUDGET_LINES and
   BUDGET_BY_JOB — see the note there (hardening 11). */
var BUDGET_BY_ID = {};
function mkBudget(jobId, category, allotted, notes) {
  var b = { id: ++_budgetSeq, job_id: jobId, category: category, allotted: allotted, notes: notes || '' };
  BUDGET_LINES.push(b);
  BUDGET_BY_ID[b.id] = b;
  return b;
}
/* mkExpense(show, category, vendor, amount, dayOff, {job, file, status, by, provenance, memo}) */
function mkExpense(show, category, vendor, amount, off, x) {
  x = x || {};
  var e = { id: ++_expSeq, show_id: 0, project_id: null,
            job_id: x.job || null, budget_line_category: category,
            vendor: vendor, amount: amount, txn_date: dayISO(off),
            status: x.status || 'filed', file_id: x.file || null,
            by: x.by || null, provenance: x.provenance || null, memo: x.memo || '' };
  (show.expenses = show.expenses || []).push(e);
  return e;
}
/* a financial doc is just mkFile with the money columns, pushed to the show */
function mkDoc(show, o) { var f = mkFile(o); show.files.push(f); return f; }
/* provenance for agent-filed docs (AGENT_API §7 shape, mock refs) */
function prov(kind, label, agentUser, confidence) {
  return { source_kind: kind, source_ref: 'm365:AAMk-' + (9100 + (++_provSeq)),
           source_label: label, agent_user: agentUser, confidence: confidence };
}
function dayAge(iso) {
  if (!iso) return null;
  var d = new Date(iso.slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? null : Math.round((TODAY - d) / 86400000);
}

/* ---- budget lines · every job gets allotments ----------------------------- */
/* job 1 · AVCA (contract 96,500) */
mkBudget(1, 'travel', 9500, 'flights + hotel · 4 techs');
mkBudget(1, 'freight', 8000, 'truck to Milwaukee r/t');
mkBudget(1, 'labor', 14000, 'IATSE stagehands + forklift driver');
mkBudget(1, 'gear', 5000, 'feeder cable + consumables');
mkBudget(1, 'production', 3500, 'content + Bolt6 bridge');
mkBudget(1, 'misc', 1500, '');
/* job 2 · Marlins (74,200) */
mkBudget(2, 'travel', 5200, 'install crew · MIA');
mkBudget(2, 'freight', 4500, 'crates to dock C');
mkBudget(2, 'labor', 9000, 'install + finishing');
mkBudget(2, 'print', 16000, 'media + ink · 1,240 sf');
mkBudget(2, 'misc', 800, '');
/* job 3 · LOVB league rental — Madison + kit legs (62,000). Rental economics:
   lower per-show cost, E360 retains the asset. Carries the league-covered kit
   freight from every leg, including sale venues (the split-billing overrides). */
mkBudget(3, 'travel', 6000, 'kit crew · leg 1');
mkBudget(3, 'freight', 14000, 'league-covered kit freight · all legs');
mkBudget(3, 'labor', 5000, 'Madison stagehands');
mkBudget(3, 'gear', 12000, 'kit prep + spares — E360 retains the asset');
mkBudget(3, 'production', 2500, 'season content refresh');
mkBudget(3, 'misc', 1000, '');
/* job 9 · LOVB league rental — Omaha (58,000) */
mkBudget(9, 'travel', 5500, '');
mkBudget(9, 'freight', 6000, 'leg 5');
mkBudget(9, 'labor', 5000, '');
mkBudget(9, 'gear', 3000, 'kit consumables');
mkBudget(9, 'production', 2000, '');
mkBudget(9, 'misc', 800, '');
/* job 10 · Atlanta team sale (61,000) — hardware is COGS on the job */
mkBudget(10, 'gear', 28000, 'hardware COGS — asset transfers to the team');
mkBudget(10, 'travel', 4500, '');
mkBudget(10, 'freight', 3500, 'hardware inbound');
mkBudget(10, 'labor', 5500, '');
mkBudget(10, 'production', 2000, '');
mkBudget(10, 'misc', 500, '');
/* job 4 · Houston team sale (38,500) — the underwater deal: hardware COGS
   has already outrun both the allotment and the contract */
mkBudget(4, 'gear', 16000, 'hardware COGS — baseline + tunnel cabinets');
mkBudget(4, 'labor', 8000, 'tunnel package install');
mkBudget(4, 'freight', 3000, 'inbound hardware');
mkBudget(4, 'production', 2500, 'tunnel content');
mkBudget(4, 'misc', 500, '');
/* job 11 · Salt Lake team sale (59,500) */
mkBudget(11, 'gear', 27000, 'hardware COGS');
mkBudget(11, 'travel', 4000, '');
mkBudget(11, 'freight', 3000, '');
mkBudget(11, 'labor', 5000, '');
mkBudget(11, 'misc', 500, '');
/* job 5 · Austin team sale (64,500) — LED package + rail wraps */
mkBudget(5, 'gear', 30000, 'hardware COGS');
mkBudget(5, 'print', 6500, 'rail wrap media');
mkBudget(5, 'freight', 2500, '');
mkBudget(5, 'labor', 5500, 'install at Moody');
mkBudget(5, 'travel', 3000, '');
mkBudget(5, 'misc', 500, '');
/* job 6 · NW Stadium (128,000) */
mkBudget(6, 'travel', 14000, 'traveling crew · 6');
mkBudget(6, 'freight', 16000, 'dedicated haul r/t');
mkBudget(6, 'labor', 18000, 'stagehands + spotters');
mkBudget(6, 'gear', 9000, 'consumables + spares');
mkBudget(6, 'production', 6000, '');
mkBudget(6, 'misc', 2000, '');
/* job 7 · STL / UFL (87,500) */
mkBudget(7, 'travel', 9000, '');
mkBudget(7, 'freight', 11000, '');
mkBudget(7, 'labor', 12000, '');
mkBudget(7, 'gear', 7000, '');
mkBudget(7, 'production', 4500, '');
mkBudget(7, 'misc', 1500, '');
/* job 8 · NRL — in negotiation, no budget yet (empty-state demo) */

/* ---- docs + expenses ------------------------------------------------------ */
(function seedFinance() {
  var S_AVCA = P_AVCA.shows[0], S_MARL = P_MARLINS.shows[0],
      S_MAD = P_LOVB.shows[0], S_ATL = P_LOVB.shows[1], S_HOU = P_LOVB.shows[2],
      S_AUS = P_LOVB.shows[5], S_NW = P_NW.shows[0], S_STL = P_STL.shows[0];

  /* AVCA — costs landing now (show is T-10) */
  var d1 = mkDoc(S_AVCA, { name: 'AmTrav — crew flights receipt', ext: 'pdf', kind: 'receipt', size: 118784,
    by: 'candice', off: -3, meta: '4 seats · MKE', amount: 2840, vendor: 'AmTrav', doc_date: dayISO(-3) });
  mkExpense(S_AVCA, 'travel', 'AmTrav', 2840, -3, { file: d1.id, by: 'bsawyer' });
  mkExpense(S_AVCA, 'travel', 'Hyatt Regency Milwaukee', 1860, -2, { by: 'bsawyer', memo: 'room-block deposit' });
  var d2 = mkDoc(S_AVCA, { name: 'B&H — SDI + fiber consumables', ext: 'pdf', kind: 'receipt', size: 96256,
    by: 'candice', off: -1, meta: 'order 1189-441', amount: 640, vendor: 'B&H Photo', doc_date: dayISO(-1) });
  mkExpense(S_AVCA, 'gear', 'B&H Photo', 640, -1, { file: d2.id, by: 'tandres' });
  /* PROPOSED · Tom's agent, medium band -> awaiting human confirm */
  var d3 = mkDoc(S_AVCA, { name: "O'Brien Freight — Milwaukee truck (inv 8841)", ext: 'pdf', kind: 'invoice', size: 132096,
    by: 'tandres', off: -2, meta: 'awaiting review', amount: 1200, vendor: "O'Brien Freight", doc_date: dayISO(-2),
    status: 'proposed', provenance: prov('email', "Fwd: O'Brien Freight invoice #8841", 'tandres', 74) });
  mkExpense(S_AVCA, 'freight', "O'Brien Freight", 1200, -2, { file: d3.id, status: 'proposed', provenance: d3.provenance });
  S_AVCA.activity.unshift(mkAct('agent:tandres', "proposed an O'Brien Freight invoice for review", '$1,200 · from email · 74% match', -2, '09:41', true));

  /* Marlins */
  var d4 = mkDoc(S_MARL, { name: 'Grimco — 13oz blockout mesh', ext: 'pdf', kind: 'invoice', size: 150528,
    by: 'candice', off: -10, meta: '1,240 sf media', amount: 7420, vendor: 'Grimco', doc_date: dayISO(-10) });
  mkExpense(S_MARL, 'print', 'Grimco', 7420, -10, { file: d4.id, by: 'dvargas' });
  mkExpense(S_MARL, 'print', 'Ink + finishing consumables', 1130, -6, { by: 'dvargas' });
  var d5 = mkDoc(S_MARL, { name: 'Install labor — day-rate confirmation', ext: 'pdf', kind: 'confirmation', size: 88064,
    by: 'lfarkos', off: -6, meta: 'crew of 3 · loanDepot', amount: 1800, vendor: 'Miami Event Labor', doc_date: dayISO(-6) });
  mkExpense(S_MARL, 'labor', 'Miami Event Labor', 1800, -6, { file: d5.id, by: 'lfarkos' });

  /* LOVB Madison — season-prep costs on the league job */
  var d6 = mkDoc(S_MAD, { name: "O'Brien Freight — season advance deposit", ext: 'pdf', kind: 'invoice', size: 141312,
    by: 'tandres', off: -4, meta: 'leg 1 · Madison', amount: 8400, vendor: "O'Brien Freight", doc_date: dayISO(-4),
    provenance: prov('email', 'Re: LOVB freight invoice', 'tandres', 92) });
  mkExpense(S_MAD, 'freight', "O'Brien Freight", 8400, -4, { file: d6.id, by: 'bsawyer' });
  S_MAD.activity.unshift(mkAct('agent:tandres', "filed the O'Brien season freight invoice", '$8,400 · from email "Re: LOVB freight invoice" · 92%', -4, '14:02', true));
  var d7 = mkDoc(S_MAD, { name: 'AmTrav — season fare-class deposit', ext: 'pdf', kind: 'receipt', size: 104448,
    by: 'bsawyer', off: -5, meta: '6 legs · crew of 5', amount: 4200, vendor: 'AmTrav', doc_date: dayISO(-5),
    provenance: prov('email', 'AmTrav receipt — LOVB season deposit', 'bsawyer', 88) });
  mkExpense(S_MAD, 'travel', 'AmTrav', 4200, -5, { file: d7.id, by: 'bsawyer' });
  var d8 = mkDoc(S_MAD, { name: 'Kit refurb + spares — shop PO', ext: 'pdf', kind: 'po', size: 92160,
    by: 'candice', off: -8, meta: 'PO-2214 · travel kit', amount: 6900, vendor: 'e360 shop', doc_date: dayISO(-8) });
  mkExpense(S_MAD, 'gear', 'e360 shop', 6900, -8, { file: d8.id, by: 'dvargas' });
  /* PROPOSED · Candice's agent caught a labor invoice in her inbox */
  var d9 = mkDoc(S_MAD, { name: 'UW Field House — stagehand deposit (inv 2291)', ext: 'pdf', kind: 'invoice', size: 99328,
    by: 'candice', off: -2, meta: 'awaiting review', amount: 1500, vendor: 'UW Field House labor', doc_date: dayISO(-2),
    status: 'proposed', provenance: prov('email', 'Inv 2291 — UW Field House labor', 'candice', 68) });
  mkExpense(S_MAD, 'labor', 'UW Field House labor', 1500, -2, { file: d9.id, status: 'proposed', provenance: d9.provenance });

  /* LOVB Atlanta — team SALE (job 10 default): first hardware COGS landing */
  var d16 = mkDoc(S_ATL, { name: 'ROE Visual — hardware deposit (sale)', ext: 'pdf', kind: 'invoice', size: 164864,
    by: 'candice', off: -7, meta: 'team sale · hardware COGS', amount: 14200, vendor: 'ROE Visual', doc_date: dayISO(-7) });
  mkExpense(S_ATL, 'gear', 'ROE Visual', 14200, -7, { file: d16.id, by: 'tvigon', memo: 'hardware deposit — COGS' });

  /* LOVB Houston — team SALE (job 4 default). Hardware COGS has outrun the
     allotment AND the 38,500 contract -> underwater at a glance. */
  var d10 = mkDoc(S_HOU, { name: 'ROE Visual — tunnel cabinet purchase', ext: 'pdf', kind: 'invoice', size: 187392,
    by: 'candice', off: -12, meta: 'team sale · hardware COGS', amount: 21400, vendor: 'ROE Visual', doc_date: dayISO(-12) });
  mkExpense(S_HOU, 'gear', 'ROE Visual', 21400, -12, { file: d10.id, by: 'tvigon', memo: 'hardware — COGS' });
  mkExpense(S_HOU, 'labor', 'Gulf Coast Fabrication', 9800, -12, { by: 'tvigon', memo: 'tunnel frame build' });
  var d11 = mkDoc(S_HOU, { name: 'Saia LTL — inbound tunnel hardware', ext: 'pdf', kind: 'receipt', size: 101376,
    by: 'tandres', off: -6, meta: 'team sale', amount: 3900, vendor: 'Saia LTL', doc_date: dayISO(-6),
    provenance: prov('email', 'Saia freight receipt — Fertitta', 'tandres', 90) });
  mkExpense(S_HOU, 'freight', 'Saia LTL', 3900, -6, { file: d11.id, by: 'tvigon' });
  mkExpense(S_HOU, 'production', 'Studio K Motion', 4900, -9, { by: 'jhawk', memo: 'tunnel content package' });
  /* league-covered cost on the SAME show — overrides to the rental job (3) */
  var d12 = mkDoc(S_HOU, { name: 'Fertitta advance — site-visit travel', ext: 'pdf', kind: 'receipt', size: 87040,
    by: 'tandres', off: -15, meta: 'league-covered', amount: 980, vendor: 'Delta / Marriott', doc_date: dayISO(-15), job_id: 3,
    provenance: prov('email', 'Re: Fertitta advance — receipts', 'tandres', 91) });
  mkExpense(S_HOU, 'travel', 'Delta / Marriott', 980, -15, { file: d12.id, job: 3, by: 'tvigon' });
  S_HOU.activity.unshift(mkAct('candice', 'flagged the Houston sale over budget', 'hardware COGS passed the $30,000 allotment', -6, '10:15', true));

  /* LOVB Austin — team SALE (job 5 default): rail-wrap media on order */
  var d13 = mkDoc(S_AUS, { name: 'Grimco — rail wrap mesh PO', ext: 'pdf', kind: 'po', size: 90112,
    by: 'lfarkos', off: -9, meta: 'team sale · 26-1233', amount: 2150, vendor: 'Grimco', doc_date: dayISO(-9) });
  mkExpense(S_AUS, 'print', 'Grimco', 2150, -9, { file: d13.id, by: 'lfarkos' });

  /* NW Stadium — booking with paperwork ATTACHED (healthy) + a missing receipt */
  var d14 = mkDoc(S_NW, { name: 'Landstar — freight booking confirmation', ext: 'pdf', kind: 'confirmation', size: 94208,
    by: 'bsawyer', off: -23, meta: 'dedicated haul · confirmed', amount: 3600, vendor: 'Landstar', doc_date: dayISO(-23) });
  mkExpense(S_NW, 'freight', 'Landstar', 3600, -23, { file: d14.id, by: 'bsawyer', memo: 'booking deposit' });
  S_NW.bookings[0].file_id = d14.id;
  mkExpense(S_NW, 'travel', 'AmTrav', 5240, -5, { by: 'bsawyer', memo: 'crew airfare · 6 seats' });
  /* PROPOSED · Brendon's agent — every teammate's agent files as them */
  var d15 = mkDoc(S_NW, { name: 'Marriott Landover — room block receipt', ext: 'pdf', kind: 'receipt', size: 99328,
    by: 'bsawyer', off: -1, meta: 'awaiting review', amount: 2280, vendor: 'Marriott', doc_date: dayISO(-1),
    status: 'proposed', provenance: prov('email', 'Marriott folio — NW Stadium block', 'bsawyer', 71) });
  mkExpense(S_NW, 'travel', 'Marriott', 2280, -1, { file: d15.id, status: 'proposed', provenance: d15.provenance, by: 'bsawyer' });

  /* STL — no expenses yet; its confirmed truck with missing paperwork is the
     oldest chase-list item. NRL seeds nothing: the empty-state demo. */
  void S_STL;
})();

/* budget-change events for the finance feed (no timestamps on lines yet) */
var FINANCE_EVENTS = [
  { id: ++_finEvSeq, ts: dayISO(-1), actor: 'candice', action: 'raised the league-covered kit-freight allotment',
    detail: 'League rental 26-1180 · $14,000 across all legs', job_id: 3 },
  { id: ++_finEvSeq, ts: dayISO(-12), actor: 'candice', action: 'opened the budget for the Houston team sale',
    detail: '5 categories · $30,000 allotted · hardware as COGS', job_id: 4 }
];

/* ============================================================================
   HYDRATION — derive due_date from event_date + T-minus, resolve depends_on,
   normalise chain seeds, build the flat indexes the api layer reads.
   ========================================================================== */
var PROJECTS_BY_ID = {}, SHOWS_BY_ID = {}, STEPS_BY_ID = {}, FILES_BY_ID = {},
    BOOKINGS_BY_ID = {}, JOBS_BY_ID = {}, ALL_SHOWS = [], ALL_JOBS = [],
    EXPENSES_BY_ID = {}, ALL_EXPENSES = [], BUDGET_BY_JOB = {},
    GEAR_SNAPSHOTS_BY_ID = {};

function _chainNode(seed) {
  seed = seed || [0];
  /* seed slot 6 (index 5) is the lifecycle flag — truthy means a pm marked
     the CURRENT bind outdated. Same shape dbToChainNode serves. */
  return { gen: !!seed[0], rev: seed[1] || 0, derivedRev: seed[2] || 0,
           when: seed[3] == null ? '' : dayISO(seed[3]), by: seed[4] || 'tandres',
           outdated: !!seed[5], outdatedBy: seed[5] ? (seed[4] || 'tandres') : null,
           outdatedAt: seed[5] ? dayISO((seed[3] || 0) + 2) + 'T09:40' : null,
           outdatedNote: seed[5] ? 'design changed — replacement spec pending' : '' };
}

(function hydrate() {
  PROJECTS.forEach(function (p) {
    PROJECTS_BY_ID[p.id] = p;
    (p.milestones || []).forEach(function (m) { m.project_id = p.id; m.show_id = null; });
    /* POLISH_LIST #5: a job number is CONFIRMED (it came from QuickBooks)
       unless the literal says otherwise — the server's mapper defaults the
       same way, so the demo store and the API agree without a per-job field. */
    (p.jobs || []).forEach(function (j) {
      if (j.qb_number_status !== 'temp') j.qb_number_status = 'confirmed';
      JOBS_BY_ID[j.id] = j; ALL_JOBS.push(j);
    });
    p.shows.forEach(function (s) {
      s.project_id = p.id;
      /* type lives on the project (SCHEMA.md) — mirrored onto the show so the
         lane-agnostic render helpers never need a store lookup. */
      s.type = p.type;
      (s.milestones || []).forEach(function (m) { m.show_id = s.id; m.project_id = null; });
      SHOWS_BY_ID[s.id] = s; ALL_SHOWS.push(s);
      var evt = new Date(s.event_date + 'T00:00:00');
      var byTitle = {};
      s.steps.forEach(function (st, i) {
        st.show_id = s.id; st.sort_order = i;
        st.due_date = isoDate(addDays(evt, st.due_offset_days));
        STEPS_BY_ID[st.id] = st;
        byTitle[st.title] = st.id;
      });
      s.steps.forEach(function (st) {
        if (st._dep_title && byTitle[st._dep_title] != null) st.depends_on = byTitle[st._dep_title];
        delete st._dep_title;
      });
      s.files.forEach(function (f) { f.show_id = s.id; f.project_id = p.id; FILES_BY_ID[f.id] = f; });
      s.bookings.forEach(function (b) { b.show_id = s.id; BOOKINGS_BY_ID[b.id] = b; });
      s.expenses = s.expenses || [];
      s.expenses.forEach(function (e) { e.show_id = s.id; e.project_id = p.id; EXPENSES_BY_ID[e.id] = e; ALL_EXPENSES.push(e); });
      s.proofs.forEach(function (pr) { pr.show_id = s.id; });
      s.activity.forEach(function (a) { a.show_id = s.id; a.project_id = p.id; });
      /* chain node seeds -> live objects */
      var c = {};
      ['content', 'cabling', 'power', 'pull'].forEach(function (k) { c[k] = _chainNode(s.chain && s.chain[k]); });
      s.chain = c;
      /* the lifecycle twins: version history rows + the show-level outdated
         flag the season row's scope chip reads (hydrateShow derives the same
         flag server-side, so both worlds carry it on the show record) */
      s.spec_history = s.spec_history || [];
      s.spec_history.forEach(function (v) { v.show_id = s.id; });
      s.spec_outdated = ['content', 'cabling', 'power'].some(function (k) {
        return c[k].gen && c[k].outdated; });
      /* gear snapshot twins -> indexed like every other child collection */
      s.gear_snapshots = s.gear_snapshots || [];
      s.gear_snapshots.forEach(function (g) { g.show_id = s.id; GEAR_SNAPSHOTS_BY_ID[g.id] = g; });
      /* gear state — the kit is built eagerly so renderers never need a lazy
         ensureGear() call (that ordering trap is gone). */
      s.gear = s.gear || { linked: false, pulled: false, elementId: null };
      s.gear.kit = buildKit(s.cabinets || 72);
      s.gear.view = 'pull-sheet';
      s.gear.gearListId = s.gear.pulled ? 'a220432c-s' + s.id + '-gl' : null;
      s.gear.gearListType = 'pull-sheet';
      s.gear.docNumber = 'PS-' + (1700 + (s.id * 37) % 400);
    });
  });
  /* budget lines -> per-job index + derived jobs.budget_total (sum of lines) */
  BUDGET_LINES.forEach(function (b) { (BUDGET_BY_JOB[b.job_id] = BUDGET_BY_JOB[b.job_id] || []).push(b); });
  ALL_JOBS.forEach(function (j) {
    j.budget_total = (BUDGET_BY_JOB[j.id] || []).reduce(function (a, b) { return a + b.allotted; }, 0);
  });
})();

/* ============================================================================
   F4 · SCOPE SEED + the SPEC the scope is verified against
   ----------------------------------------------------------------------------
   Every show gets the seven scope_* fields so no renderer ever branches on
   hasOwnProperty; the ones that have actually been scoped get numbers.

   SPEC_SCOPE stands in for what lib/speccheck.js scopeFromDocs() derives from a
   bound .e360 / .nsf / .pcfg on the server: a STACK-AWARE cabinet count and a
   cabinet type, and nothing else — a spec records neither linear feet (the
   field dimensions are the playing surface, not the run of LED) nor pixel pitch
   (it lives in nobody's file). Those two stay hand-entered on both sides.

   Madison is seeded to DISAGREE with its bound spec on purpose: 40 sold, 44
   stack-aware in the .nsf. That is not an error and nothing is overwritten —
   it surfaces as a checker-style QUESTION, exactly like the chain checker's
   findings, because two correct documents can legitimately disagree.
   ========================================================================== */
var SCOPE_SEED = {
  1:  { kind: 'led',   linear_feet: 340,  cabinet_count: 48, cabinet_type: 'BP2V2', pitch: 'P3.9', source: 'spec',   by: 'tvigon',  off: -21 },
  2:  { kind: 'print', print_pieces: 18,  print_sqft: 2140,                                        source: 'manual', by: 'lfarkos', off: -24 },
  3:  { kind: 'led',   linear_feet: 220,  cabinet_count: 40, cabinet_type: 'BP2V2', pitch: 'P10',  source: 'manual', by: 'bsawyer', off: -9 },
  4:  { kind: 'led',   linear_feet: 220,  cabinet_count: 40,                        pitch: 'P10',  source: 'manual', by: 'bsawyer', off: -9 },
  9:  { kind: 'led',   linear_feet: 1180, cabinet_count: 96, cabinet_type: 'BP2V2', pitch: 'P3.9', source: 'spec',   by: 'tandres', off: -30 },
  10: { kind: 'led',   linear_feet: 900,  cabinet_count: 72,                        pitch: 'P10',  source: 'manual', by: 'tvigon',  off: -18 },
  11: { kind: 'both',  linear_feet: 560,  cabinet_count: 64,                        pitch: 'P6',
        print_pieces: 12, print_sqft: 1650, source: 'manual', by: 'tvigon', off: -5 }
};
/* what a bound spec would answer for — modeled per show. Absent = nothing
   bound that can speak to the scope, which is the normal early state. */
var SPEC_SCOPE = {
  1:  { available: true, cabinet_count: 48, cabinet_type: 'BP2V2', count_source: 'nsf',  stack_aware: true,  bound: ['e360', 'nsf', 'pcfg'] },
  3:  { available: true, cabinet_count: 44, cabinet_type: 'BP2V2', count_source: 'nsf',  stack_aware: true,  bound: ['e360', 'nsf'] },
  9:  { available: true, cabinet_count: 96, cabinet_type: 'BP2V2', count_source: 'e360', stack_aware: false, bound: ['e360'] },
  12: { available: true, cabinet_count: 32, cabinet_type: 'BP2V2', count_source: 'nsf',  stack_aware: true,  bound: ['e360', 'nsf', 'pcfg'] }
};
function specScopeFor(showId) {
  return SPEC_SCOPE[Number(showId)] ||
    { available: false, cabinet_count: null, cabinet_type: null, count_source: null,
      stack_aware: false, bound: [] };
}
/* divergence -> a QUESTION, never an error. Mirrors lib/speccheck scopeQuestions(). */
function scopeQuestionsFor(show) {
  var derived = specScopeFor(show && show.id);
  var out = [];
  if (!derived.available || !show) return out;
  var sc = scopeOf(show);
  var n = _scopeNum(sc.cabinet_count);
  if (n !== null && derived.cabinet_count !== null && n !== derived.cabinet_count) {
    out.push({ id: 'scope.cabinets', kind: 'question',
      ask: 'The scope line says ' + n + ' cabinets and the bound ' + derived.count_source +
           ' spec ' + (derived.stack_aware ? 'counts (stack-aware)' : 'counts') + ' ' +
           derived.cabinet_count + '. Which is what we delivered?',
      detail: 'Stacking is recorded differently at every node of the chain, so a gap here is often ' +
              'the spec catching up with a change rather than either number being wrong. Nothing ' +
              'has been overwritten.',
      values: { scope: n, spec: derived.cabinet_count, source: derived.count_source,
                stackAware: derived.stack_aware } });
  }
  var t = String(sc.cabinet_type || '').trim();
  if (t && derived.cabinet_type && t.toLowerCase() !== derived.cabinet_type.toLowerCase()) {
    out.push({ id: 'scope.cabtype', kind: 'question',
      ask: 'The scope line says "' + t + '" and the bound spec says "' + derived.cabinet_type +
           '". Which cabinet went on the wall?',
      detail: 'The cabinet model drives pitch, power and the client-facing scope line, so the two ' +
              'should agree before a recap quotes either.',
      values: { scope: t, spec: derived.cabinet_type } });
  }
  return out;
}

(function seedScopeAndLifecycle() {
  var SCOPE_FIELDS = ['scope_kind', 'scope_linear_feet', 'scope_cabinet_count',
                      'scope_cabinet_type', 'scope_pitch', 'scope_print_pieces',
                      'scope_print_sqft'];
  ALL_SHOWS.forEach(function (s) {
    SCOPE_FIELDS.forEach(function (k) { if (s[k] === undefined) s[k] = null; });
    if (s.scope_source === undefined) s.scope_source = 'manual';
    if (s.scope_verified_at === undefined) s.scope_verified_at = null;
    if (s.scope_verified_by === undefined) s.scope_verified_by = null;
    /* F5/F6 — every show carries the lifecycle columns, mostly null. A null
       confirmed_at on a legacy stage is the honest state: confirmed by
       POSITION, with no datestamp to show for it. */
    ['confirmed_at', 'confirmed_by', 'struck_at', 'struck_by',
     'closeout_complete_at', 'archived_at', 'archived_by'].forEach(function (k) {
      if (s[k] === undefined) s[k] = null;
    });
    var seed = SCOPE_SEED[s.id];
    if (seed) {
      s.scope_kind = seed.kind || null;
      s.scope_linear_feet = seed.linear_feet == null ? null : seed.linear_feet;
      s.scope_cabinet_count = seed.cabinet_count == null ? null : seed.cabinet_count;
      s.scope_cabinet_type = seed.cabinet_type || null;
      s.scope_pitch = seed.pitch || null;
      s.scope_print_pieces = seed.print_pieces == null ? null : seed.print_pieces;
      s.scope_print_sqft = seed.print_sqft == null ? null : seed.print_sqft;
      s.scope_source = seed.source || 'manual';
      s.scope_verified_at = dayISO(seed.off == null ? -1 : seed.off) + 'T11:00';
      s.scope_verified_by = seed.by || s.owner;
    }
  });
  PROJECTS.forEach(function (p) {
    if (p.archived_at === undefined) p.archived_at = null;
    if (p.archived_by === undefined) p.archived_by = null;
  });
  /* Madison is the one show where the deal is recorded on the NEW vocabulary
     with a real datestamp — every other pre-existing show keeps its legacy
     stage and reads as confirmed-by-position. That contrast IS the F5 demo. */
  var S_MAD = SHOWS_BY_ID[3];
  if (S_MAD) {
    S_MAD.stage = 'confirmed';
    S_MAD.confirmed_at = dayISO(-16) + 'T15:40';
    S_MAD.confirmed_by = 'bsawyer';
    S_MAD.activity.unshift(mkAct('bsawyer', 'confirmed the show',
      'client committed — scheduler push unlocked · job still on a TEMP number', -16, '15:40', true));
  }
})();

/* ============================================================================
   TEMPLATES — the SOP for each event type, encoded once. Keyed by type -> lane
   -> steps. { name, role(canonical), off(T-minus days), flag:'auto'|'dep'|'' }
   ========================================================================== */
function st(name, role, off, flag) { return { name: name, role: role, off: off, flag: flag || '' }; }
var TEMPLATE_STEPS = {
  led: {
    client: [st('Kickoff / scope call', 'manager', 30), st('Specs confirmed + content brief', 'manager', 24, 'dep'), st('Production summary to group', 'admin', 23, 'auto')],
    venue: [st('Power plan — feeder + union tie-in', 'manager', 21), st('Load-in window + floor protection', 'manager', 18), st('Operator position + fiber run', 'tech', 18), st('Forklift + certified driver', 'tech', 14)],
    logistics: [st('Source feeder + cam-lok', 'tech', 17), st('Book truck / freight', 'manager', 16, 'dep'), st('Crew travel + lodging', 'manager', 14, 'dep')],
    crew: [st('Assign install + show crew', 'manager', 16), st('On-site POC named', 'manager', 16), st('Book stagehands (IATSE)', 'manager', 14)],
    gear: [st('Flex pull sheet + folder', 'tech', 13, 'auto'), st('Data bridge / thresholds prep', 'admin', 10), st('Prep + scan-out', 'tech', 5, 'dep')],
    deliverables: [st('LED content spec (.e360)', 'admin', 28, 'auto'), st('Data cabling (.nsf) + power (.pcfg)', 'admin', 15, 'dep'), st('Content package due', 'pm', 7)]
  },
  print: {
    design: [st('Brand kit + Pantone build', 'pm', 31), st('Layout to dielines', 'pm', 27, 'auto'), st('Internal color / QC pass', 'pm', 23)],
    proof: [st('R1 proof to client', 'pm', 21, 'auto'), st('Client markup logged', 'pm', 19), st('R2 corrected + reissued', 'pm', 17)],
    approval: [st('Final proof issued for signature', 'pm', 16, 'auto'), st('Approval received (e-sign)', 'viewer', 14), st('Lock + version approved proof', 'pm', 14)],
    production: [st('Release files to print floor', 'pm', 12), st('Media order', 'tech', 11, 'dep'), st('RIP + print queue', 'tech', 10)],
    tracking: [st('Print run', 'tech', 7), st('Finishing (hem / grommet)', 'tech', 6), st('QC vs approved proof', 'pm', 5, 'dep')],
    ship: [st('Crate + label', 'tech', 4), st('Freight to venue', 'manager', 3, 'dep'), st('Delivery confirm + BOL', 'manager', 2, 'auto')],
    install: [st('On-site crew call', 'tech', 0), st('Hang + tension', 'tech', 0), st('Client walk + photos', 'pm', 0, 'auto')],
    return: [st('De-install', 'tech', -5), st('Inspect + inventory', 'tech', -6), st('Close job + archive proof', 'pm', -7, 'auto')]
  },
  both: {
    client: [st('Kickoff / scope call (LED + print)', 'manager', 30), st('Combined production summary', 'admin', 24, 'auto')],
    venue: [st('Power plan + install access', 'manager', 21), st('Site survey / measurements', 'pm', 20, 'dep')],
    design: [st('Printed-element artwork build', 'pm', 24), st('Layout to dielines', 'pm', 20, 'auto')],
    proof: [st('Proof to client', 'pm', 18, 'auto'), st('Markup logged + reissued', 'pm', 15)],
    approval: [st('Approval received (e-sign)', 'viewer', 13), st('Lock + version approved proof', 'pm', 13)],
    logistics: [st('Book truck / freight', 'manager', 16, 'dep'), st('Crew travel + lodging', 'manager', 14, 'dep')],
    crew: [st('Assign combined crew', 'manager', 16), st('Book stagehands / install labor', 'manager', 12)],
    gear: [st('LED content spec (.e360) chain', 'admin', 26, 'auto'), st('Flex pull sheet + folder', 'tech', 12, 'dep')],
    deliverables: [st('Content package due', 'pm', 7), st('Print files released', 'pm', 10, 'dep')],
    install: [st('On-site crew call', 'tech', 0), st('LED build + print hang', 'tech', 0), st('Client walk + photos', 'pm', 0, 'auto')]
  }
};
var TEMPLATE_META = {
  led:   { desc: 'Traveling-crew perimeter LED for a stadium/arena match — kickoff call through strike. Full spec derivation chain (.e360 → .nsf → .pcfg → pull sheet).' },
  print: { desc: 'Large-format print engagement — graphic design through proof, approval, production, ship, install and return.' },
  both:  { desc: 'Combined LED + print package — a sensible union of both lane sets for events that carry a show and a printed element.' }
};

/* ============================================================================
   FLEX KIT BUILDER (modeled — see INTEGRATION.md part a)
   Grounded in the REAL e360-staffing3 Flex integration:
     · Auth header  X-Auth-Token           · every path prefixed  /f5
     · Event Folder def 358f312c-…  · Pull Sheet def a220432c-…  · Manifest 9945d54c-…
   ========================================================================== */
function buildKit(n) {
  var cabPerCase = 8, cabCases = Math.ceil(n / cabPerCase);
  var pull = [
    { cat: 'Processing & Control', items: [
      { name: 'NovaStar MX40 Pro processor', qty: 2, resourceId: 'MX40-0417' },
      { name: 'NovaStar CX40 (hot spare)', qty: 1, resourceId: 'CX40-0119' },
      { name: 'Media server — Watchout 6RU', qty: 1, resourceId: 'MS-2208' },
      { name: 'Bolt6 stat-bridge laptop', qty: 1, resourceId: 'BB-0007' },
      { name: 'Managed switch — Luminex GigaCore 10', qty: 2, resourceId: 'GC10-3341' }] },
    { cat: 'LED Cabinets', items: [
      { name: '10mm field-board cabinet 500x1000', qty: n, resourceId: 'FB10' },
      { name: 'Cabinet — hot spare', qty: Math.max(4, Math.round(n * 0.06)), resourceId: 'FB10-SP' }] },
    { cat: 'Power & Distro', items: [
      { name: '3-phase distro rack 200A', qty: 1, resourceId: 'DST-200' },
      { name: 'Cam-lok feeder tails — 100ft set', qty: 1, resourceId: 'CAM-100' },
      { name: 'PDU 20A — 8-outlet', qty: 8, resourceId: 'PDU-20' },
      { name: 'UPS 1500VA', qty: 2, resourceId: 'UPS-15' }] },
    { cat: 'Data & Cable', items: [
      { name: 'Cat6 shielded — 50ft', qty: 24, resourceId: 'C6-50' },
      { name: 'Cat6 shielded — 100ft', qty: 8, resourceId: 'C6-100' },
      { name: 'Fiber SM tactical — 300ft', qty: 2, resourceId: 'FIB-300' },
      { name: 'SDI BNC — 100ft', qty: 4, resourceId: 'SDI-100' }] },
    { cat: 'Rigging & Monitors', items: [
      { name: 'Field-board base plate', qty: n + 4, resourceId: 'BP' },
      { name: 'Safety cable', qty: n + 12, resourceId: 'SC' },
      { name: 'Confidence monitor 32in', qty: 1, resourceId: 'MON-32' },
      { name: 'Utility monitor 24in', qty: 2, resourceId: 'MON-24' }] }
  ];
  var manifest = [
    { case: 'Processing mini-rack', size: '24 x 24 x 36 in', weight: 145, contents: 'MX40 x2, CX40, GigaCore x2' },
    { case: 'Media / control rack', size: '22 x 30 x 40 in', weight: 165, contents: 'Watchout server, UPS x2, monitors' },
    { case: 'Distro case', size: '30 x 20 x 20 in', weight: 190, contents: '200A distro, cam-lok tails, PDUs' },
    { case: 'Cable trunk A', size: '40 x 22 x 22 in', weight: 205, contents: 'Cat6, SDI, power runs' },
    { case: 'Cable trunk B', size: '40 x 22 x 22 in', weight: 198, contents: 'Fiber, spare data, comms' }
  ];
  for (var i = 0; i < cabCases; i++) manifest.push({ case: 'LED cabinet road case ' + String.fromCharCode(65 + i), size: '48 x 48 x 24 in', weight: 420, contents: '8 x 10mm field-board cabinet' });
  manifest.push({ case: 'Base-plate cart', size: '48 x 28 x 40 in', weight: 260, contents: 'base plates, safety cable', loose: true });
  return { pull: pull, manifest: manifest, cabCases: cabCases, cabinets: n };
}

/* derivation-chain topology: child -> upstream */
var CHAIN_UP = { content: null, cabling: 'content', power: 'cabling', pull: 'power' };
var CHAIN_LABEL = { content: '.e360 content', cabling: '.nsf cabling', power: '.pcfg power', pull: 'Flex pull sheet' };

/* DEMO ONLY — the render bundle a spec-history "View" opens from file://.
   Against a real server the same modal renders the STORED bundle out of
   spec_renders (GET /shows/:id/spec-render/:node?rev=N); the demo store keeps
   no svg, so this draws a plainly-labeled placeholder card instead of
   pretending a drawing exists. Same honesty rule as buildKit: generated
   locally so the screens have something to show, and it says the word. */
function demoSpecRenderFor(show, node, rev) {
  var v = (show.spec_history || []).filter(function (x) {
    return x.node === node && x.rev === Number(rev); })[0] || null;
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#101614"/>' +
    '<rect x="24" y="24" width="592" height="312" fill="none" stroke="#2E4038" stroke-width="2"/>' +
    '<text x="320" y="150" fill="#9AB8AC" font-family="monospace" font-size="20" text-anchor="middle">' +
    (show.name || 'Show') + '</text>' +
    '<text x="320" y="185" fill="#9AB8AC" font-family="monospace" font-size="15" text-anchor="middle">' +
    CHAIN_LABEL[node] + ' · v' + rev + '</text>' +
    '<text x="320" y="220" fill="#5E7A6E" font-family="monospace" font-size="12" text-anchor="middle">' +
    'DEMO — generated locally, no bound render bundle exists</text></svg>';
  return { node: node, specType: (v && v.specType) || (node === 'content' ? 'e360' : node === 'cabling' ? 'nsf' : 'pcfg'),
           rev: Number(rev), fileId: v ? v.fileId : null, svg: svg, html: '', png: '', json: null,
           createdBy: v ? v.boundBy : 'tandres', createdAt: v ? v.boundAt : dayISO(0) + 'T14:00',
           retired: !!(v && v.state === 'unbound'), demo: true };
}

/* DEMO ONLY — the demo gear tab has no live Flex sheet to snapshot, so Save
   snapshot banks the modeled kit reshaped into the real flexReadPullSheet
   grammar (groups/items/totals). The record it makes is exactly the shape a
   live save makes; only its SOURCE is the simulation, and the label says so. */
function demoSnapshotFromKit(s) {
  var g = s.gear || {};
  var kit = g.kit || buildKit(s.cabinets || 72);
  var groups = kit.pull.map(function (c, i) {
    return { id: 'demo-g' + i, name: c.cat, path: c.cat, type: 'category', containerSerial: '',
             items: c.items.map(function (it) {
               return { name: it.name, qty: it.qty, barcode: '', serial: '', note: '',
                        resourceId: it.resourceId || '', contains: 0, qtyAssumed: false }; }) };
  });
  var lines = 0, units = 0;
  groups.forEach(function (x) { lines += x.items.length; x.items.forEach(function (it) { units += it.qty; }); });
  return {
    listId: g.gearListId || null, name: s.name || 'Pull sheet',
    docNumber: g.docNumber || '', type: 'pull-sheet', deepLink: '',
    fetchedAt: new Date().toISOString(),
    status: { stages: [] },
    groups: groups,
    totals: { groups: groups.length, lines: lines, units: units },
    empty: groups.length === 0, rowCount: lines
  };
}

/* DEMO ONLY — a Flex-shaped uuid hashed out of the show id.
   ────────────────────────────────────────────────────────────────────────────
   Renamed from `modeledUuid` on 2026-08-27, after this function's output was
   found sitting in the PRODUCTION database on rows marked `linked`, pointing at
   Event Folders that do not exist. Nothing in the API path may call it: a real
   element id comes back from `POST /f5/api/element` and from nowhere else.
   The constant tail is deliberate — routes/files.js recognises it and lets a
   real create REPLACE a fabricated link instead of 409-ing forever. */
function demoModeledUuid(showId) {
  var h = 0, s = 'show-' + showId;
  for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8) + '-b1cc-4e90-83ce-bbd69eb3e4fa';
}

/* ============================================================================
   FINANCE ROLLUPS — pure reads over the store (the api layer + sync render
   helpers both call these, the way rollup()/buildKit() are shared).
   Job attribution rule everywhere: item.job_id override > show default_job_id.
   ========================================================================== */
function expenseJobId(e) { var s = SHOWS_BY_ID[e.show_id]; return e.job_id || (s && s.default_job_id) || null; }
function fileJobId(f) { var s = SHOWS_BY_ID[f.show_id]; return f.job_id || (s && s.default_job_id) || null; }

/* everything the money views need to know about one job */
function financeForJob(jobId) {
  var job = JOBS_BY_ID[jobId];
  if (!job) return null;
  var lines = (BUDGET_BY_JOB[jobId] || []).slice();
  var exps = [], docs = [], showIds = {}, actual = 0, proposedTotal = 0, proposedCount = 0, byCat = {};
  ALL_SHOWS.forEach(function (s) {
    if (s.default_job_id === jobId) showIds[s.id] = 1;
    (s.expenses || []).forEach(function (e) {
      if ((e.job_id || s.default_job_id) !== jobId) return;
      exps.push({ e: e, show: s }); showIds[s.id] = 1;
      if (e.status === 'proposed') { proposedTotal += e.amount; proposedCount++; }
      else { actual += e.amount; byCat[e.budget_line_category] = (byCat[e.budget_line_category] || 0) + e.amount; }
    });
    s.files.forEach(function (f) {
      if (!FIN_KINDS[f.kind]) return;
      if ((f.job_id || s.default_job_id) !== jobId) return;
      docs.push({ f: f, show: s }); showIds[s.id] = 1;
    });
  });
  /* committed tier (procurement pass): ordered/shipped PO cogs lines sit
     between allotted and actual; inventory lines are E360 capex, not job cost */
  var cm = committedForJob(jobId);
  var lineRows = lines.map(function (l) {
    return { category: l.category, label: BUDGET_CATS[l.category] || l.category,
             allotted: l.allotted, actual: byCat[l.category] || 0,
             committed: cm.byCat[l.category] || 0, notes: l.notes };
  });
  var extraCats = {};
  Object.keys(byCat).forEach(function (c) { extraCats[c] = 1; });
  Object.keys(cm.byCat).forEach(function (c) { extraCats[c] = 1; });
  var unbudgeted = Object.keys(extraCats).filter(function (c) {
    return !lines.some(function (l) { return l.category === c; });
  }).map(function (c) { return { category: c, label: BUDGET_CATS[c] || c, allotted: 0, actual: byCat[c] || 0, committed: cm.byCat[c] || 0 }; });
  var budgetTotal = lines.reduce(function (a, l) { return a + l.allotted; }, 0);
  var billed = job.contract_value || 0;
  exps.sort(function (a, b) { return a.e.txn_date < b.e.txn_date ? 1 : a.e.txn_date > b.e.txn_date ? -1 : b.e.id - a.e.id; });
  return { job: job, project: PROJECTS_BY_ID[job.project_id] || null,
           lines: lineRows, unbudgeted: unbudgeted,
           budget_total: budgetTotal, actual: actual,
           committed: cm.total, capexCommitted: cm.capex,
           proposedTotal: proposedTotal, proposedCount: proposedCount,
           billed: billed, margin: billed - actual,
           marginPct: billed ? (billed - actual) / billed * 100 : null,
           burnPct: budgetTotal ? actual / budgetTotal * 100 : null,
           expenses: exps, docs: docs,
           shows: Object.keys(showIds).map(function (id) { return SHOWS_BY_ID[Number(id)]; }) };
}

/* the "waiting on me" chase list: booked/ordered money with no doc on file */
function financeExceptions() {
  var out = [];
  ALL_SHOWS.forEach(function (s) {
    s.bookings.forEach(function (b) {
      var st = normStatus(b.status);
      if ((st !== 'done' && st !== 'in_progress') || b.file_id) return;
      if (b.amount == null && !b.booked_date) return;   /* nothing committed yet */
      out.push({ kind: 'booking', id: b.id, show: s, label: b.category, vendor: b.vendor,
                 amount: b.amount, category: null,
                 job: JOBS_BY_ID[b.job_id || s.default_job_id] || null,
                 age: dayAge(b.booked_date), chase: s.owner, missing: 'confirmation' });
    });
    (s.expenses || []).forEach(function (e) {
      if (e.status === 'proposed' || e.file_id) return;
      if (e.po_id) return;   /* its PO carries the exception — never both */
      out.push({ kind: 'expense', id: e.id, show: s, label: e.vendor, vendor: e.vendor,
                 amount: e.amount, category: e.budget_line_category,
                 job: JOBS_BY_ID[e.job_id || s.default_job_id] || null,
                 age: dayAge(e.txn_date), chase: e.by || s.owner, missing: 'receipt' });
    });
  });
  /* ordered-or-received POs with no vendor invoice on file (kind 'po') */
  ALL_POS.forEach(function (po) {
    if (!poUnreconciled(po)) return;
    out.push({ kind: 'po', id: po.id, show: poPrimaryShow(po),
               label: po.po_number + ' · ' + po.vendor, vendor: po.vendor,
               amount: poTotal(po), category: null,
               job: JOBS_BY_ID[po.job_id] || null,
               age: dayAge(po.received_date || po.ordered_date),
               chase: po.created_by, missing: 'invoice' });
  });
  /* POLISH_LIST #5. A job still on a TEMP placeholder is Candice's to chase —
     but only once something is riding on it (a cost, a PO line, a budget
     line). A temp job nobody has touched is just an early folder. */
  ALL_JOBS.forEach(function (j) {
    if (j.qb_number_status !== 'temp') return;
    var touches = (BUDGET_BY_JOB[j.id] || []).length +
      PO_LINES.filter(function (l) { return poLineJobId(l) === j.id; }).length +
      ALL_SHOWS.reduce(function (n, s) {
        return n + (s.expenses || []).filter(function (e) { return e.job_id === j.id; }).length;
      }, 0);
    if (!touches) return;
    out.push({ kind: 'job_number', id: j.id, show: null,
               label: j.qb_job_number + ' · ' + j.client, vendor: null,
               amount: null, category: null, job: j,
               age: null, chase: 'candice', missing: 'a QB job number — Candice' });
  });
  out.sort(function (a, b) { return (b.age || 0) - (a.age || 0); });
  return out;
}

/* reverse-chron money events. An expense WITH an evidence doc reports once,
   as its doc — never twice. */
function financeFeed() {
  var evs = [];
  ALL_SHOWS.forEach(function (s) {
    s.files.forEach(function (f) { if (FIN_KINDS[f.kind]) evs.push({ type: 'doc', ts: f.created_at, id: f.id, file: f, show: s }); });
    (s.expenses || []).forEach(function (e) { if (!e.file_id) evs.push({ type: 'expense', ts: e.txn_date, id: e.id, exp: e, show: s }); });
    s.bookings.forEach(function (b) {
      if (b.booked_date && normStatus(b.status) === 'done') evs.push({ type: 'booking', ts: b.booked_date, id: b.id, bk: b, show: s });
    });
  });
  FINANCE_EVENTS.forEach(function (ev) { evs.push({ type: 'budget', ts: ev.ts, id: ev.id, ev: ev, show: null }); });
  /* an ordered PO is a money event — committed spend enters the record */
  ALL_POS.forEach(function (po) {
    if (po.ordered_date) evs.push({ type: 'po', ts: po.ordered_date, id: 9000 + po.id, po: po });
  });
  evs.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id; });
  return evs;
}

/* headline numbers for the Finance stat strip + Settings card */
function financeStats() {
  var exc = financeExceptions();
  var excAmount = exc.reduce(function (a, x) { return a + (x.amount || 0); }, 0);
  var weekAgo = dayISO(-7), docsWeek = 0, proposed = 0, actual = 0, budgeted = 0, billed = 0;
  ALL_SHOWS.forEach(function (s) {
    s.files.forEach(function (f) {
      if (!FIN_KINDS[f.kind]) return;
      if (f.created_at >= weekAgo) docsWeek++;
      if (f.status === 'proposed') proposed++;
    });
    (s.expenses || []).forEach(function (e) { if (e.status !== 'proposed') actual += e.amount; });
  });
  ALL_JOBS.forEach(function (j) { budgeted += j.budget_total || 0; billed += j.contract_value || 0; });
  /* committed tier (procurement): cogs -> job budgets · inventory -> E360 capex */
  var committed = 0, capex = 0;
  ALL_POS.forEach(function (po) {
    if (!PO_COMMITTED_STATUSES[po.status]) return;
    (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
      if (l.ownership === 'inventory') capex += poLineTotal(l); else committed += poLineTotal(l);
    });
  });
  return { exceptions: exc.length, excAmount: excAmount, docsWeek: docsWeek, proposed: proposed,
           actual: actual, budgeted: budgeted, billed: billed,
           committed: committed, capex: capex,
           margin: billed - actual, marginPct: billed ? (billed - actual) / billed * 100 : null };
}

/* ============================================================================
   PURCHASING — purchase orders + lines  (procurement pass)
   ----------------------------------------------------------------------------
   purchase_orders: {id, po_number, vendor, project_id, job_id (default
     allocation), status needed|quoted|ordered|shipped|received|reconciled,
     created_by, ordered_date, expected_date, received_date,
     approval {required, threshold_exceeded, approved_by, approved_at} | null,
     provenance (agent-drafted only), memo, tracking,
     quote_file_id / invoice_file_id (financial-doc flow), activity[]}
   po_lines: {id, po_id, item, detail, qty, unit_cost, category (shared 7-cat
     budget vocabulary), job_id (null = inherit PO default), show_id (null =
     season-wide), ownership 'inventory'|'cogs', expense_id (the actual this
     line generated — set on receive, or seeded for reconciled history)}

   The budget mechanic:  ORDERED/SHIPPED = COMMITTED · RECEIVED = ACTUAL.
     - cogs lines      -> committed rides the job budget between allotted and
                          actual; on receive they generate expense rows.
     - inventory lines -> E360 capex (deal_type semantics: rental keeps the
                          gear) — tracked as "-> inventory" spend on the PO and
                          purchasing stats, NEVER as a job cost. On receive
                          they surface the "-> Flex inventory" intake hint.
   DECISION (Tom, 2026-08-21 — confirmed): POs over $5,000 need sign-off from
   an ADMIN (Tom · Tony · Jim) or CANDICE (via her finance capability) before
   'quoted' can advance to 'ordered'; under the threshold auto-approves.
   Deliberately NOT the generic manager+ predicate — a manager without the
   finance capability runs shows, not spend authority. Surfaced in Settings.
   ========================================================================== */
var PO_APPROVAL_THRESHOLD = 5000;
var PO_STATUSES = ['needed', 'quoted', 'ordered', 'shipped', 'received', 'reconciled'];
var PO_STATUS_META = {
  needed:     { label: 'Needed',     pill: 'idle', dot: 'var(--muted)',  hint: 'scoped — nothing committed yet' },
  quoted:     { label: 'Quoted',     pill: 'info', dot: 'var(--info)',   hint: 'quotes in — the approval gate lives here' },
  ordered:    { label: 'Ordered',    pill: 'warn', dot: 'var(--warn)',   hint: 'committed spend — counts against budgets' },
  shipped:    { label: 'Shipped',    pill: 'acc',  dot: 'var(--accent)', hint: 'in transit — watch the load-in dates' },
  received:   { label: 'Received',   pill: 'go',   dot: 'var(--go)',     hint: 'landed — cogs lines become actuals' },
  reconciled: { label: 'Reconciled', pill: 'go',   dot: 'var(--go)',     hint: 'vendor invoice on file — closed out' }
};
var PO_COMMITTED_STATUSES = { ordered: 1, shipped: 1 };

var _poSeq = 0, _poLineSeq = 0;
var ALL_POS = [], PO_LINES = [], POS_BY_ID = {}, PO_LINES_BY_PO = {}, PO_LINES_BY_ID = {};

function deriveOwnership(jobId) {
  var j = jobId ? JOBS_BY_ID[jobId] : null;
  return j && j.deal_type === 'sale' ? 'cogs' : 'inventory';
}
function mkPO(o) {
  var po = { id: ++_poSeq, po_number: o.num, vendor: o.vendor, project_id: o.project || null,
    job_id: o.job || null, status: o.status || 'needed', created_by: o.by || 'tandres',
    ordered_date: o.ordered == null ? null : dayISO(o.ordered),
    expected_date: o.expected == null ? null : dayISO(o.expected),
    received_date: o.received == null ? null : dayISO(o.received),
    approval: o.approval || null, provenance: o.provenance || null,
    memo: o.memo || '', tracking: o.tracking || null,
    quote_file_id: o.quote || null, invoice_file_id: o.invoice || null,
    activity: [] };
  ALL_POS.push(po); POS_BY_ID[po.id] = po; PO_LINES_BY_PO[po.id] = [];
  return po;
}
function mkPOLine(po, o) {
  var l = { id: ++_poLineSeq, po_id: po.id, item: o.item, detail: o.detail || '',
    qty: o.qty == null ? 1 : o.qty, unit_cost: o.unit || 0, category: o.category || 'gear',
    job_id: o.job || null, show_id: o.show || null,
    ownership: o.ownership || deriveOwnership(o.job || po.job_id || null),
    expense_id: o.expense || null };
  PO_LINES.push(l); PO_LINES_BY_PO[po.id].push(l); PO_LINES_BY_ID[l.id] = l;
  return l;
}

/* ---------------- pure rollups (mirror the finance helpers' style) --------- */
function poLineTotal(l) { return (l.qty || 0) * (l.unit_cost || 0); }
function poTotal(po) {
  return (PO_LINES_BY_PO[po.id] || []).reduce(function (a, l) { return a + poLineTotal(l); }, 0);
}
function poLineJobId(l) { var po = POS_BY_ID[l.po_id]; return l.job_id || (po && po.job_id) || null; }
function poNeedsApproval(po) {
  return poTotal(po) > PO_APPROVAL_THRESHOLD && !(po.approval && po.approval.approved_by);
}
/* WHO may approve an over-threshold PO — the admins (Tom · Tony · Jim) plus
   Candice, whose finance capability signs off for accounting. One predicate,
   used by the api gate AND every render site (queue · panel · drill-in).

   It DELEGATES rather than restating the rule. This and canSeeFinance() were
   byte-identical copies of the same Tom decision (`admin ‖ finance`), which is
   the silent-divergence shape: a later change updates one and leaves the other
   quietly enforcing the old policy. They stay separate FUNCTIONS because they
   are separate decisions — if approving a PO and seeing a margin ever come
   apart, this gets its own body then, deliberately and visibly. Mirrors the
   backend, where canApprovePO() delegates to hasFinance() for the same reason.
   (Safe despite living in the lower layer: nothing calls this during load.) */
function canApprovePOs(user) {
  return canSeeFinance(user || CURRENT_USER);
}
/* WHO may delete a PO — the server floor is manager+ (routes/purchasing.js
   DELETE /api/pos/:id, requireRole('manager')). Rendered, not just enforced:
   the button never dangles a guaranteed 403 in front of a pm. Deliberately a
   separate predicate from canApprovePOs — deleting an order and approving
   spend are different decisions (a manager without finance can delete, and
   Candice-without-manager could approve but not delete). */
function canDeletePOs(user) {
  var u = user || CURRENT_USER;
  return !!u && (u.role === 'admin' || u.role === 'manager');
}
function poUnreconciled(po) {
  return (po.status === 'ordered' || po.status === 'shipped' || po.status === 'received') && !po.invoice_file_id;
}
function isoDiffDays(a, b) {
  var da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}
/* season-wide lines (show_id null) don't pin to one load-in; only lines with
   an explicit show carry delivery risk / gear-strip presence. */
function poShowsLinked(po) {
  var seen = {}, out = [];
  (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
    if (!l.show_id || seen[l.show_id]) return;
    seen[l.show_id] = 1;
    var s = SHOWS_BY_ID[l.show_id];
    if (s) out.push(s);
  });
  return out;
}
function poPrimaryShow(po) {
  var linked = poShowsLinked(po);
  if (linked.length) return linked[0];
  var byDefault = ALL_SHOWS.filter(function (s) { return s.default_job_id === po.job_id; })[0];
  if (byDefault) return byDefault;
  var p = PROJECTS_BY_ID[po.project_id];
  return p ? p.shows[0] : null;
}
/* the killer feature: hardware landing after (or hair-close to) a load-in */
function poRiskForShow(po, show) {
  if (!show || !show.load_in_date) return null;
  if (po.status === 'received' || po.status === 'reconciled') return null;
  var li = show.load_in_date;
  if (po.expected_date) {
    var gap = isoDiffDays(po.expected_date, li);      /* load-in minus expected */
    if (gap == null) return null;
    if (gap < 0) return { level: 'crit', days: -gap, why: 'lands ' + (-gap) + 'd after load-in' };
    if (gap <= 5) return { level: 'warn', days: gap, why: 'T−' + gap + 'd before load-in' };
    return null;
  }
  var d = isoDiffDays(TODAY_ISO, li);                  /* no ETA at all */
  if (d != null && d >= 0 && d <= 5) return { level: 'warn', days: d, why: 'no ETA · load-in in ' + d + 'd' };
  return null;
}
function poRisks(po) {
  var out = [];
  poShowsLinked(po).forEach(function (s) {
    var r = poRiskForShow(po, s);
    if (r) out.push({ po: po, show: s, level: r.level, why: r.why, days: r.days });
  });
  return out;
}
function listAllPoRisks() {
  var out = [];
  ALL_POS.forEach(function (po) { poRisks(po).forEach(function (r) { out.push(r); }); });
  out.sort(function (a, b) {
    if (a.level !== b.level) return a.level === 'crit' ? -1 : 1;
    return a.show.load_in_date < b.show.load_in_date ? -1 : 1;
  });
  return out;
}
function procurementRisksForShow(showId) {
  var s = SHOWS_BY_ID[Number(showId)], out = [];
  if (!s) return out;
  ALL_POS.forEach(function (po) {
    var linked = (PO_LINES_BY_PO[po.id] || []).some(function (l) { return l.show_id === s.id; });
    if (!linked) return;
    var r = poRiskForShow(po, s);
    if (r) out.push({ po: po, show: s, level: r.level, why: r.why, days: r.days });
  });
  out.sort(function (a, b) { return a.level === b.level ? 0 : a.level === 'crit' ? -1 : 1; });
  return out;
}
/* committed tier for one job: cogs -> budget committed; inventory -> capex */
function committedForJob(jobId) {
  var out = { total: 0, capex: 0, byCat: {}, lines: [] };
  ALL_POS.forEach(function (po) {
    if (!PO_COMMITTED_STATUSES[po.status]) return;
    (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
      if (poLineJobId(l) !== jobId) return;
      var t = poLineTotal(l);
      if (l.ownership === 'inventory') out.capex += t;
      else { out.total += t; out.byCat[l.category] = (out.byCat[l.category] || 0) + t; }
      out.lines.push({ po: po, line: l });
    });
  });
  return out;
}
/* every PO touching a job (any status) — the job drill-in's PO panel */
function posForJob(jobId) {
  var out = [];
  ALL_POS.forEach(function (po) {
    var amt = 0, n = 0;
    (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
      if (poLineJobId(l) !== jobId) return;
      amt += poLineTotal(l); n++;
    });
    if (n) out.push({ po: po, amount: amt, lines: n });
  });
  return out;
}
function purchasingStats() {
  var open = 0, committed = 0, capex = 0, pipeline = 0,
      awaitingN = 0, awaitingAmt = 0, unrecN = 0, unrecAmt = 0, needs = {};
  ALL_POS.forEach(function (po) {
    var t = poTotal(po);
    if (po.status !== 'reconciled') open++;
    if (PO_COMMITTED_STATUSES[po.status]) {
      (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
        if (l.ownership === 'inventory') capex += poLineTotal(l); else committed += poLineTotal(l);
      });
    }
    if (po.status === 'needed' || po.status === 'quoted') pipeline += t;
    if (po.status === 'quoted' && poNeedsApproval(po)) { awaitingN++; awaitingAmt += t; needs[po.id] = 1; }
    if (poUnreconciled(po)) { unrecN++; unrecAmt += t; needs[po.id] = 1; }
    if (poRisks(po).length) needs[po.id] = 1;
  });
  var risks = listAllPoRisks();
  var crit = risks.filter(function (r) { return r.level === 'crit'; }).length;
  return { open: open, committed: committed, capex: capex, pipeline: pipeline,
           awaiting: awaitingN, awaitingAmount: awaitingAmt,
           risks: risks.length, riskCrit: crit, riskWarn: risks.length - crit,
           unreconciled: unrecN, unreconciledAmount: unrecAmt,
           needsAction: Object.keys(needs).length };
}
/* receive side-effect: cogs lines lacking an expense generate one (actuals).
   Lines already linked (reconciled history) are skipped — no double-count.
   Inventory lines generate nothing: capex, not a job cost. */
function _registerExpense(e, s) {
  e.show_id = s.id; e.project_id = s.project_id;
  EXPENSES_BY_ID[e.id] = e; ALL_EXPENSES.push(e);
}
function poLineShowResolved(l, po) {
  if (l.show_id) return SHOWS_BY_ID[l.show_id] || null;
  var jid = poLineJobId(l);
  var byDefault = ALL_SHOWS.filter(function (s) { return s.default_job_id === jid; })[0];
  if (byDefault) return byDefault;
  var p = PROJECTS_BY_ID[po.project_id];
  return p ? p.shows[0] : null;
}
function poGenerateExpenses(po, off) {
  var made = [];
  (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
    if (l.expense_id || l.ownership !== 'cogs') return;
    var s = poLineShowResolved(l, po);
    if (!s) return;
    var jid = poLineJobId(l);
    var e = mkExpense(s, l.category, po.vendor, poLineTotal(l), off || 0, {
      job: jid && jid !== s.default_job_id ? jid : null,
      file: po.invoice_file_id || null, by: po.created_by, memo: po.po_number + ' received' });
    e.po_id = po.id;
    _registerExpense(e, s);
    l.expense_id = e.id;
    made.push(e);
  });
  return made;
}

/* ============================================================================
   PURCHASING SEED — the LOVB season order, front and center
   ========================================================================== */
(function seedPurchasing() {
  function findExp(showId, vendor, amount) {
    return ALL_EXPENSES.filter(function (e) {
      return e.show_id === showId && e.vendor === vendor && e.amount === amount;
    })[0] || null;
  }
  function findFile(showId, kind, vendor) {
    var hit = null;
    Object.keys(FILES_BY_ID).forEach(function (k) {
      var f = FILES_BY_ID[k];
      if (f.show_id === showId && f.kind === kind && f.vendor === vendor) hit = f;
    });
    return hit;
  }
  /* quote/invoice paperwork filed post-hydration — register like api.addFile */
  function poDoc(showId, o) {
    var s = SHOWS_BY_ID[showId];
    var f = mkFile(o);
    f.show_id = s.id; f.project_id = s.project_id;
    FILES_BY_ID[f.id] = f;
    s.files.push(f);
    return f;
  }
  function pa(po, actor, action, detail, off, time, accent) {
    po.activity.push(mkAct(actor, action, detail, off, time, accent));
  }

  var eHou = findExp(5, 'ROE Visual', 21400);    /* Houston tunnel hardware — already in the books */
  var eAtl = findExp(4, 'ROE Visual', 14200);    /* Atlanta hardware deposit — already in the books */
  var dHou = findFile(5, 'invoice', 'ROE Visual');

  /* -- 1 - Wave 1: RECEIVED + RECONCILED — the hardware that blew Houston.
        Its lines POINT AT the existing COGS expenses; nothing double-counts. -- */
  var po1 = mkPO({ num: 'PO-26-028', vendor: 'ROE Visual', project: 3, job: 4, status: 'reconciled',
    by: 'tvigon', ordered: -16, expected: -13, received: -12,
    approval: { required: true, threshold_exceeded: true, approved_by: 'tandres', approved_at: dayISO(-17) },
    invoice: dHou ? dHou.id : null,
    memo: 'Season hardware, wave 1 — Houston tunnel package + Atlanta deposit. This buy is what pushed the Houston sale past its allotment.' });
  mkPOLine(po1, { item: 'CB5 baseline + tunnel cabinets — Houston install', detail: '10mm, 20 cabinets', qty: 20, unit: 1070,
    category: 'gear', job: 4, show: 5, ownership: 'cogs', expense: eHou ? eHou.id : null });
  mkPOLine(po1, { item: 'Match LED package — Atlanta hardware deposit', detail: 'deposit against the season order', qty: 1, unit: 14200,
    category: 'gear', job: 10, show: 4, ownership: 'cogs', expense: eAtl ? eAtl.id : null });
  if (eHou) eHou.po_id = po1.id;
  if (eAtl) eAtl.po_id = po1.id;
  pa(po1, 'candice', 'reconciled PO-26-028 against the ROE invoice', 'costs now actuals on 26-1207 / 26-1219', -11, '09:20', true);
  pa(po1, 'aramos', 'marked PO-26-028 received', 'Houston cabinets landed at Fertitta staging', -12, '15:30');
  pa(po1, 'tvigon', 'marked PO-26-028 ordered', '$35,600 committed to ROE Visual', -16, '10:12');
  pa(po1, 'tandres', 'approved PO-26-028', 'over the $5,000 threshold — cleared to order', -17, '11:05');
  pa(po1, 'tvigon', 'opened PO-26-028 for the wave-1 hardware', 'Houston tunnel + Atlanta deposit', -17, '09:40');

  /* -- 2 - Wave 2: THE BIG ONE — ordered = committed across the 4 team sales.
        Expected date lands 5 days AFTER Atlanta's load-in -> genuine CRIT. -- */
  var po2 = mkPO({ num: 'PO-26-041', vendor: 'ROE Visual', project: 3, job: 10, status: 'ordered',
    by: 'tvigon', ordered: -2, expected: 142,
    approval: { required: true, threshold_exceeded: true, approved_by: 'tandres', approved_at: dayISO(-3) },
    memo: 'Season install hardware, wave 2 — balance for all four team sales, one consolidated freight. Rigging sets stay E360 inventory and travel with the kit.' });
  mkPOLine(po2, { item: 'CB5 MKII cabinets — Atlanta install balance', detail: '10mm, balance after deposit', qty: 12, unit: 1240, category: 'gear', job: 10, show: 4, ownership: 'cogs' });
  mkPOLine(po2, { item: 'CB5 MKII cabinets — Houston tunnel expansion', detail: '10mm, phase 2 of the tunnel', qty: 18, unit: 1240, category: 'gear', job: 4, show: 5, ownership: 'cogs' });
  mkPOLine(po2, { item: 'CB5 MKII cabinets — Salt Lake install', detail: '10mm, baseline package', qty: 21, unit: 1240, category: 'gear', job: 11, show: 6, ownership: 'cogs' });
  mkPOLine(po2, { item: 'CB5 MKII cabinets + spares — Austin install', detail: '10mm, baseline + rail spares', qty: 23, unit: 1240, category: 'gear', job: 5, show: 8, ownership: 'cogs' });
  mkPOLine(po2, { item: 'Ground-support base plates + rigging sets', detail: 'reusable — travels with the kit', qty: 2, unit: 2450, category: 'gear', job: 3, ownership: 'inventory' });
  pa(po2, 'tvigon', 'marked PO-26-041 ordered', '$96,660 committed, consolidated season freight', -2, '09:15', true);
  pa(po2, 'tandres', 'approved PO-26-041', 'over the $5,000 threshold — admin sign-off', -3, '16:45', true);
  pa(po2, 'tvigon', 'drafted PO-26-041 from the season install plan', '5 lines across 4 team-sale jobs + kit rigging', -3, '14:20');

  /* -- 3 - Power ancillaries: SHIPPED, cutting 3 days close to Madison's
        load-in -> WARN. Apostrophe vendor = the esc() audit case. -- */
  var po3 = mkPO({ num: 'PO-26-044', vendor: "O'Neill Power & Rigging", project: 3, job: 3, status: 'shipped',
    by: 'bsawyer', ordered: -6, expected: 112, tracking: 'ONL-88213-04',
    approval: { required: true, threshold_exceeded: true, approved_by: 'tandres', approved_at: dayISO(-7) },
    memo: 'Power ancillaries for the traveling kit + Houston tunnel whips. Kit distro stays E360 inventory.' });
  mkPOLine(po3, { item: '200A 3-phase distro rack', detail: 'traveling kit — replaces rented distro', qty: 1, unit: 6400, category: 'gear', job: 3, show: 3, ownership: 'inventory' });
  mkPOLine(po3, { item: 'Cam-lok feeder — 100ft set', qty: 4, unit: 1450, category: 'gear', job: 3, show: 3, ownership: 'inventory' });
  mkPOLine(po3, { item: 'PDU 20A, 8-outlet', qty: 8, unit: 320, category: 'gear', job: 3, show: 3, ownership: 'inventory' });
  mkPOLine(po3, { item: 'Tunnel feeder whips — Houston install', qty: 6, unit: 240, category: 'gear', job: 4, show: 5, ownership: 'cogs' });
  pa(po3, 'bsawyer', 'marked PO-26-044 shipped', 'tracking ONL-88213-04, expected T-3 before Madison load-in', -1, '16:20', true);
  pa(po3, 'bsawyer', 'marked PO-26-044 ordered', "$16,200 to O'Neill Power & Rigging", -6, '11:00');
  pa(po3, 'tandres', 'approved PO-26-044', 'over the $5,000 threshold', -7, '09:10');
  pa(po3, 'bsawyer', 'opened PO-26-044 from the Madison power plan', 'no house feeder at the Field House', -8, '10:30');

  /* -- 4 - LED processors: QUOTED + over threshold -> the approval demo.
        CX40 spare line rides an Omaha RENTAL job -> inventory ownership. -- */
  var po4 = mkPO({ num: 'PO-26-047', vendor: 'NovaStar (US)', project: 3, job: 10, status: 'quoted',
    by: 'tvigon',
    approval: { required: true, threshold_exceeded: true, approved_by: null, approved_at: null },
    memo: 'LED processors — one MX40 per team install, plus hot spares for the traveling kit. Quote in; waiting on sign-off.' });
  mkPOLine(po4, { item: 'MX40 Pro processor — Atlanta install', qty: 1, unit: 5600, category: 'gear', job: 10, show: 4, ownership: 'cogs' });
  mkPOLine(po4, { item: 'MX40 Pro processor — Salt Lake install', qty: 1, unit: 5600, category: 'gear', job: 11, show: 6, ownership: 'cogs' });
  mkPOLine(po4, { item: 'MX40 Pro processor — Austin install', qty: 1, unit: 5600, category: 'gear', job: 5, show: 8, ownership: 'cogs' });
  mkPOLine(po4, { item: 'CX40 Pro — traveling-kit hot spare', detail: 'league rental — E360 keeps the gear', qty: 2, unit: 3900, category: 'gear', job: 9, show: 7, ownership: 'inventory' });
  var q4 = poDoc(3, { name: 'NovaStar (US) — processor quote', ext: 'pdf', kind: 'po', size: 118784,
    by: 'tvigon', off: -1, meta: 'vendor quote, PO-26-047', amount: 24600, vendor: 'NovaStar (US)', doc_date: dayISO(-1), job_id: 10 });
  po4.quote_file_id = q4.id;
  pa(po4, 'tvigon', 'attached the NovaStar quote — marked quoted', '$24,600, awaiting approval (over $5,000)', -1, '10:25', true);
  pa(po4, 'tvigon', 'opened PO-26-047 for the season processors', '3 installs + kit spares', -2, '13:40');

  /* -- 5 - Agent-drafted: NEEDED, provenance from the LOVB planning meeting.
        The future create_purchase_request tool rides exactly these rails. -- */
  var po5 = mkPO({ num: 'PO-26-049', vendor: 'TBD — quotes out', project: 3, job: 3, status: 'needed',
    by: 'tandres',
    provenance: { source_kind: 'meeting', source_ref: 'teams:19:meeting_LOVB-2026-planning',
                  source_label: 'LOVB season planning', agent_user: 'tandres', confidence: 82 },
    memo: "Drafted by Tom's agent from the LOVB season planning meeting — spares + consumables list still to quote." });
  mkPOLine(po5, { item: 'Spare 10mm LED modules + PSU kit', detail: 'estimate — traveling kit attrition', qty: 1, unit: 4800, category: 'gear', job: 3, ownership: 'inventory' });
  mkPOLine(po5, { item: 'Powered road cases — team processors', detail: 'estimate', qty: 3, unit: 760, category: 'gear', job: 10, show: 4, ownership: 'cogs' });
  pa(po5, 'agent:tandres', "drafted PO-26-049 from meeting 'LOVB season planning'", '2 lines, 82% match — review + quote it out', -1, '17:05', true);

  /* -- 6 - AVCA feeder: ORDERED, under threshold -> auto-approved. No invoice
        yet -> the "waiting on me" exception, kind 'po'. -- */
  var po6 = mkPO({ num: 'PO-26-036', vendor: 'CableTek Supply', project: 1, job: 1, status: 'ordered',
    by: 'tandres', ordered: -4, expected: 3,
    approval: { required: false, threshold_exceeded: false, approved_by: null, approved_at: null },
    memo: 'No feeder on site at Fiserv — 200ft 3-phase run, budgeted to the job.' });
  mkPOLine(po6, { item: '3-phase feeder — 200ft cam-lok run', qty: 1, unit: 2450, category: 'gear', job: 1, show: 1, ownership: 'cogs' });
  mkPOLine(po6, { item: 'Cam-lok tails + 3-way splitter', qty: 1, unit: 700, category: 'gear', job: 1, show: 1, ownership: 'cogs' });
  pa(po6, 'tandres', 'marked PO-26-036 ordered', '$3,150 to CableTek Supply, expected T-6 before load-in', -4, '10:05', true);
  pa(po6, 'tandres', 'opened PO-26-036 from the power-plan step', 'auto-approved — under the $5,000 threshold', -4, '09:50');

  /* -- 7 - Marlins finishing hardware: RECEIVED -> its cogs line just became
        an actual (generated below). Invoice still out -> unreconciled. -- */
  var po7 = mkPO({ num: 'PO-26-033', vendor: 'Grimco', project: 2, job: 2, status: 'received',
    by: 'dvargas', ordered: -9, expected: -2, received: -1,
    approval: { required: false, threshold_exceeded: false, approved_by: null, approved_at: null },
    memo: 'Finishing hardware for the perimeter wrap run.' });
  mkPOLine(po7, { item: 'Grommets, pole-pocket tape + finishing kit', detail: 'perimeter wrap run, 1,240 sf', qty: 1, unit: 1180, category: 'print', job: 2, show: 2, ownership: 'cogs' });
  pa(po7, 'aramos', 'marked PO-26-033 received', 'checked in at the print floor — cost is now an actual', -1, '14:45', true);
  pa(po7, 'dvargas', 'marked PO-26-033 ordered', '$1,180, auto-approved (under $5,000)', -9, '11:30');
  poGenerateExpenses(po7, -1);
})();

/* ============================================================================
   NEEDS LIST — the per-job purchasing checklist (Tom, 2026-09-02)
   ----------------------------------------------------------------------------
   "each one of those systems need all kinds of ancillary things — it would be
   really advantageous if i had a spot to check those off the list." A need is
   a checklist item, not money — it touches nothing until it is raised onto a
   PO, at which point covered_by_po_id ties the check mark to the order.
     open · covered (raised or hand-checked) · na (deliberately not needed —
     kept and struck through, because a decision is a record, not an absence).
   LED_NEEDS_TEMPLATE mirrors lib/enums.js LED_ANCILLARIES verbatim — the demo
   twin of the server's seed constant. Tom will tune the list.
   ========================================================================== */
var NEED_STATUSES = ['open', 'covered', 'na'];
var LED_NEEDS_TEMPLATE = [
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

var _needSeq = 0;
var ALL_NEEDS = [], NEEDS_BY_ID = {};

function mkNeed(o) {
  var job = JOBS_BY_ID[o.job];
  var nd = { id: ++_needSeq, project_id: o.project || (job ? job.project_id : null),
    job_id: o.job, show_id: o.show || null,
    item: o.item, detail: o.detail || '', qty: o.qty == null ? 1 : o.qty,
    est_cost: o.est == null ? null : o.est, category: o.category || 'gear',
    status: o.status || 'open', covered_by_po_id: o.po || null,
    checked_by: o.checkedBy || null, checked_at: o.checkedAt || null,
    sort_order: o.sort != null ? o.sort : _needSeq,
    created_by: o.by || 'tandres', created_at: dayISO(o.off || 0), updated_at: dayISO(o.off || 0) };
  ALL_NEEDS.push(nd); NEEDS_BY_ID[nd.id] = nd;
  return nd;
}

/* ---------------- pure rollups (mirror the PO helpers' style) -------------- */
function needsForJob(jobId) {
  return ALL_NEEDS.filter(function (nd) { return nd.job_id === Number(jobId); })
    .sort(function (a, b) { return a.sort_order - b.sort_order || a.id - b.id; });
}
function openNeedsForShow(showId) {
  return ALL_NEEDS.filter(function (nd) { return nd.show_id === Number(showId) && nd.status === 'open'; });
}
/* the Purchasing cockpit's "Still needed" rollup: open items grouped by job */
function openNeedsByJob() {
  var byJob = {};
  ALL_NEEDS.forEach(function (nd) {
    if (nd.status !== 'open') return;
    var b = byJob[nd.job_id] = byJob[nd.job_id] || { job: JOBS_BY_ID[nd.job_id] || null, count: 0, est: 0 };
    b.count += 1;
    if (nd.est_cost != null) b.est += (nd.qty || 1) * nd.est_cost;
  });
  return Object.keys(byJob).map(function (jid) { return byJob[jid]; })
    .filter(function (b) { return !!b.job; })
    .sort(function (a, b) { return b.count - a.count || b.est - a.est; });
}

/* ---- demo seed: the Salt Lake install (job 11) mid-checklist ----
   One item already covered by the NovaStar processor PO, one struck n/a, the
   rest open — so the panel shows every state the moment the demo opens. */
(function seedNeeds() {
  var poNova = ALL_POS.filter(function (po) { return po.po_number === 'PO-26-047'; })[0] || null;
  mkNeed({ job: 11, show: 6, item: 'LED processor', detail: 'MX40 Pro — on the season processor order',
    qty: 1, est: 5600, status: 'covered', po: poNova ? poNova.id : null,
    checkedBy: 'tvigon', checkedAt: dayISO(-1), by: 'tvigon', off: -3, sort: 1 });
  mkNeed({ job: 11, show: 6, item: 'Main power distro', detail: 'per-system distro rack sized to the wall',
    qty: 1, est: 6400, by: 'tvigon', off: -3, sort: 2 });
  mkNeed({ job: 11, show: 6, item: '208V / breakout cabling', detail: 'feeder + breakouts, wall to distro to cabinets',
    qty: 1, est: 1800, by: 'tvigon', off: -3, sort: 3 });
  mkNeed({ job: 11, show: 6, item: 'Freight / shipping', detail: 'hardware to Maverik Center', qty: 1,
    est: 2500, category: 'freight', by: 'tvigon', off: -3, sort: 4 });
  mkNeed({ job: 11, show: 6, item: 'Install consumables', detail: 'gaff · zip ties · hardware · edge trim',
    qty: 1, est: 400, category: 'misc', by: 'tvigon', off: -3, sort: 5 });
  mkNeed({ job: 11, show: 6, item: 'Rigging / ground-support hardware',
    detail: 'venue steel + house rig already contracted', qty: 1, status: 'na',
    checkedBy: 'tandres', checkedAt: dayISO(-2), by: 'tvigon', off: -3, sort: 6 });
})();

/* ============================================================================
   CONTACT ROLODEX — the cross-project directory (Tom, 2026-08-27)
   ----------------------------------------------------------------------------
   "there should be a contact rolodex in our app if we dont already have one."
   contacts       : {id, name, org, title, kind, email, phone, notes,
                     flex_contact_id, archived_at/by, created_at/by, updated_at}
   show_contacts  : {id, show_id, contact_id, role} — "People on this show".
   The show's venue_poc/client_poc JSONB stay FREE TEXT (the call sheet must
   carry a name typed once at 11pm); the rolodex FILLS them, never replaces
   them. `kind` is a coarse filter, never a permission. `flex_contact_id` is
   the Rosetta-stone ref the Flex event-folder create path back-fills.
   Archive-not-delete is the retirement path, same as people and folders.
   ========================================================================== */
var CONTACT_KINDS = ['client', 'venue', 'vendor', 'crew', 'other'];
/* the write floor is RANK (pm+), not ownership — a rolodex row is global */
var CONTACT_EDIT_ROLES = { admin: 1, manager: 1, pm: 1 };
function canEditContacts(user) {
  var u = user || CURRENT_USER;
  return !!u && !!CONTACT_EDIT_ROLES[u.role];
}

var _contactSeq = 0, _showContactSeq = 0;
var ALL_CONTACTS = [], CONTACTS_BY_ID = {};
var ALL_SHOW_CONTACTS = [], SHOW_CONTACTS_BY_ID = {};

function mkContact(o) {
  var c = { id: ++_contactSeq, name: o.name,
    org: o.org || '', title: o.title || '',
    kind: CONTACT_KINDS.indexOf(o.kind) >= 0 ? o.kind : 'other',
    email: o.email || '', phone: o.phone || '', notes: o.notes || '',
    flex_contact_id: o.flex || null,
    archived_at: o.archivedOff != null ? dayISO(o.archivedOff) + 'T09:00' : null,
    archived_by: o.archivedOff != null ? (o.archivedBy || 'tandres') : null,
    created_at: dayISO(o.off || 0), created_by: o.by || 'tandres',
    updated_at: dayISO(o.off || 0) };
  ALL_CONTACTS.push(c); CONTACTS_BY_ID[c.id] = c;
  return c;
}
function mkShowContact(o) {
  var sc = { id: ++_showContactSeq, show_id: o.show, contact_id: o.contact,
    role: o.role || '', created_at: dayISO(o.off || 0), created_by: o.by || 'tandres' };
  ALL_SHOW_CONTACTS.push(sc); SHOW_CONTACTS_BY_ID[sc.id] = sc;
  return sc;
}

/* ---------------- pure rollups (mirror the needs helpers' style) ----------- */
function contactsForShow(showId) {
  return ALL_SHOW_CONTACTS.filter(function (sc) { return sc.show_id === Number(showId); })
    .map(function (sc) { return { link: sc, contact: CONTACTS_BY_ID[sc.contact_id] || null }; })
    .filter(function (x) { return !!x.contact; });
}
function showsForContact(contactId) {
  return ALL_SHOW_CONTACTS.filter(function (sc) { return sc.contact_id === Number(contactId); })
    .map(function (sc) { return { link: sc, show: SHOWS_BY_ID[sc.show_id] || null }; })
    .filter(function (x) { return !!x.show; });
}
function contactLinkCount(contactId) {
  return ALL_SHOW_CONTACTS.filter(function (sc) { return sc.contact_id === Number(contactId); }).length;
}
function activeContacts() { return ALL_CONTACTS.filter(function (c) { return !c.archived_at; }); }
function archivedContacts() { return ALL_CONTACTS.filter(function (c) { return !!c.archived_at; }); }

/* ---- demo seed: the POC literals above, promoted to rolodex rows ----
   Marcus + Dana are LINKED to the AVCA show so the "People on this show"
   panel and the linked-shows count both render on file:// open; Priya carries
   a (modeled) flex ref so the Flex marker has a face; Rita is the archived
   card, so the Archived filter is never an empty claim. */
(function seedContacts() {
  var marcus = mkContact({ name: 'Marcus Hale', org: 'Fiserv Forum', title: 'Event ops',
    kind: 'venue', phone: '(414) 555-0221', email: 'mhale@fiservforum.com', off: -40 });
  var dana = mkContact({ name: 'Dana Fox', org: 'Fox & Co', title: 'Producer',
    kind: 'client', phone: '(312) 555-0245', email: 'dana@foxandco.tv', off: -40 });
  mkContact({ name: 'Priya Shah', org: 'LOVB', title: 'Event production',
    kind: 'client', phone: '(646) 555-0132', email: 'priya.shah@lovb.com',
    flex: 'demo-flex-contact-lovb', off: -60,
    notes: 'Runs the LOVB side for every 2026–27 match build.' });
  mkContact({ name: 'Wei Lin', org: 'Shenzhen Fabulux', title: 'Account manager',
    kind: 'vendor', email: 'wei.lin@fabulux.cn', off: -90,
    notes: 'Cabinet + spares orders; quotes in USD, 3-week sea freight.' });
  mkContact({ name: 'Rita Calloway', org: 'Wrigley Field', title: 'Dock chief',
    kind: 'venue', phone: '(773) 555-0166', off: -120, archivedOff: -30,
    notes: 'Left the venue — the new dock contact is TBD.' });
  mkShowContact({ show: 1, contact: marcus.id, role: 'Venue ops', off: -35 });
  mkShowContact({ show: 1, contact: dana.id, role: 'Client day-of', off: -35 });
})();

/* ============================================================================
   NOTES + @MENTIONS — anchored comments (notes pass)
   ----------------------------------------------------------------------------
   The decided model (TEAM_FEEDBACK): threads live ON things, never free-
   floating. AGENT_API §5 is the contract these shapes track:

   notes      : {id, anchor_type 'show'|'step'|'file'|'po'|'job'|'project',
                 anchor_id, author (username or 'agent:<username>'), body,
                 created_at, edited_at, mentions [usernames — parsed from the
                 body server-side], parent_id (null = thread root; ONE level
                 of replies, never deeper), provenance (agent notes only)}
   note_reads : per-user read tracking — powers the bell badge + bold rows.

   Mention grammar: '@' + first name or username, case-insensitive, matched
   against the roster. Unknown tokens pass through as plain text. Bodies are
   ALWAYS escaped before mention-chipping — no HTML rides in through a note.
   ========================================================================== */
var NOTE_ANCHORS = { show: 1, step: 1, file: 1, po: 1, job: 1, project: 1 };
var _noteSeq = 0;
var ALL_NOTES = [], NOTES_BY_ID = {};
var NOTE_READS = {};                       /* username -> { noteId: read_at } */

var MENTION_LOOKUP = null;                 /* lower(first name | username) -> username */
function mentionLookup() {
  if (!MENTION_LOOKUP) {
    MENTION_LOOKUP = {};
    USERS.forEach(function (u) {
      MENTION_LOOKUP[u.username.toLowerCase()] = u.username;
      MENTION_LOOKUP[u.name.split(' ')[0].toLowerCase()] = u.username;
    });
  }
  return MENTION_LOOKUP;
}
/* '@Tom' / '@tandres' / '@CANDICE' -> usernames; '@nobody' -> ignored */
function parseMentions(body) {
  var lk = mentionLookup(), out = [], seen = {};
  String(body || '').replace(/@([A-Za-z][A-Za-z0-9_]*)/g, function (m, tok) {
    var u = lk[tok.toLowerCase()];
    if (u && !seen[u]) { seen[u] = 1; out.push(u); }
    return m;
  });
  return out;
}

/* x.kind 'note' (default) | 'notify' — a notify note is a SYSTEM inbox entry
   (the notify-picker's delivery vehicle): it rides the same store, read
   tracking and bell, but never renders in a thread and never counts as one.
   x.mentions (notify only) names the chosen recipients explicitly — a
   notification's targets are picked, never parsed out of its text. */
function mkNote(anchorType, anchorId, author, body, off, time, x) {
  x = x || {};
  var n = { id: ++_noteSeq, anchor_type: anchorType, anchor_id: Number(anchorId),
            author: author, body: body, kind: x.kind || 'note',
            created_at: dayISO(off) + 'T' + (time || '09:00'),
            edited_at: null, mentions: x.mentions ? x.mentions.slice() : parseMentions(body),
            parent_id: x.parent || null, provenance: x.provenance || null };
  ALL_NOTES.push(n); NOTES_BY_ID[n.id] = n;
  return n;
}
function noteAuthorUser(n) { return String(n.author).indexOf('agent:') === 0 ? n.author.slice(6) : n.author; }
function noteIsRead(username, noteId) { return !!(NOTE_READS[username] && NOTE_READS[username][noteId]); }
function markNoteRead(username, noteId) {
  (NOTE_READS[username] = NOTE_READS[username] || {})[noteId] = TODAY_ISO;
}

/* threads on one anchored thing: chronological roots, each with its replies */
function notesFor(anchorType, anchorId) {
  var roots = [], byParent = {};
  var srt = function (a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id; };
  ALL_NOTES.forEach(function (n) {
    if (n.kind === 'notify') return;             /* inbox-only — never a thread */
    if (n.anchor_type !== anchorType || n.anchor_id !== Number(anchorId)) return;
    if (n.parent_id) (byParent[n.parent_id] = byParent[n.parent_id] || []).push(n);
    else roots.push(n);
  });
  roots.sort(srt);
  return roots.map(function (r) { return { root: r, replies: (byParent[r.id] || []).sort(srt) }; });
}
function noteCount(anchorType, anchorId) {
  var n = 0;
  ALL_NOTES.forEach(function (x) {
    if (x.kind === 'notify') return;             /* inbox-only — never a thread */
    if (x.anchor_type === anchorType && x.anchor_id === Number(anchorId)) n++;
  });
  return n;
}

/* the display name a show goes by (single-show folders collapse to the folder
   name) — inlined here so data.js stays self-sufficient, like the finance
   helpers. components.js showLabel() is the render-layer twin. */
/* The data-layer twin of components.js showLabel(). That one grew a null guard
   when the show-less 'po' / 'job_number' exceptions landed; this copy did not,
   and it is one careless caller away from the same crash. Same contract now:
   show-less answers '' rather than throwing from inside a renderer. */
function _noteShowLabel(s) {
  if (!s) return '';
  var p = PROJECTS_BY_ID[s.project_id];
  return p && p.shows.length === 1 ? p.name : s.name;
}
/* resolve a note's anchor to display info + (where one exists) its show */
function noteAnchor(n) {
  var id = n.anchor_id;
  if (n.anchor_type === 'show') { var s = SHOWS_BY_ID[id]; return s ? { label: _noteShowLabel(s), show: s, sub: s.venue } : null; }
  if (n.anchor_type === 'step') {
    var st = STEPS_BY_ID[id], ss = st && SHOWS_BY_ID[st.show_id];
    return st ? { label: st.title, show: ss || null, sub: ss ? _noteShowLabel(ss) : '' } : null;
  }
  if (n.anchor_type === 'file') {
    var f = FILES_BY_ID[id], fs = f && SHOWS_BY_ID[f.show_id];
    return f ? { label: f.name, show: fs || null, sub: fs ? _noteShowLabel(fs) : '' } : null;
  }
  if (n.anchor_type === 'po') { var po = POS_BY_ID[id]; return po ? { label: po.po_number + ' · ' + po.vendor, show: null, sub: 'purchase order' } : null; }
  if (n.anchor_type === 'job') { var j = JOBS_BY_ID[id]; return j ? { label: 'Job ' + j.qb_job_number, show: null, sub: j.client } : null; }
  if (n.anchor_type === 'project') { var p = PROJECTS_BY_ID[id]; return p ? { label: p.name, show: null, sub: 'season folder' } : null; }
  return null;
}

/* the personal inbox: mentions of me + replies to my notes + later notes on
   threads I wrote in. My own notes (and my agent's — it acts as me) never
   notify me. Newest first. */
function noteInbox(username) {
  var rootsIn = {};                        /* thread-root ids I participated in */
  ALL_NOTES.forEach(function (n) {
    if (noteAuthorUser(n) !== username) return;
    if (n.kind === 'notify') return;       /* a notification is not a thread root */
    rootsIn[n.parent_id || n.id] = 1;
  });
  var out = [];
  ALL_NOTES.forEach(function (n) {
    if (noteAuthorUser(n) === username) return;
    var reason = null;
    if (n.kind === 'notify') {
      /* the actor chose exactly these people (Tony's rule) — nobody else hears */
      if (n.mentions.indexOf(username) >= 0) reason = 'notify';
    } else if (n.mentions.indexOf(username) >= 0) reason = 'mention';
    else if (n.parent_id && rootsIn[n.parent_id]) {
      var root = NOTES_BY_ID[n.parent_id];
      reason = root && noteAuthorUser(root) === username ? 'reply' : 'thread';
    }
    if (!reason) return;
    out.push({ note: n, reason: reason, read: noteIsRead(username, n.id), anchor: noteAnchor(n) });
  });
  out.sort(function (a, b) { return a.note.created_at < b.note.created_at ? 1 : a.note.created_at > b.note.created_at ? -1 : b.note.id - a.note.id; });
  return out;
}
function noteUnreadCount(username) {
  var n = 0;
  noteInbox(username).forEach(function (x) { if (!x.read) n++; });
  return n;
}
/* proposed docs whose agent acted AS this user — the person who confirms
   (AGENT_API §6: assigned_to = the agent's user). The other half of the bell. */
function proposalsForUser(username) {
  var out = [];
  Object.keys(FILES_BY_ID).forEach(function (k) {
    var f = FILES_BY_ID[k];
    if (f.status === 'proposed' && f.provenance && f.provenance.agent_user === username) out.push(f);
  });
  out.sort(function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id; });
  return out;
}
/* bell badge = unread mentions/replies + my pending agent proposals + any
   draft client recap I'm the one who can approve (recap pass, below) */
function inboxBadgeCount(username) {
  return noteUnreadCount(username) + proposalsForUser(username).length +
         recapsAwaitingReview(username).length;
}

/* ============================================================================
   NOTES SEED — a believable working conversation layer. Anchors are resolved
   by name/number lookups (never hardcoded ids), and read state is seeded so
   Tom opens the app to a live bell: 3 unread mentions + 1 pending proposal.
   ========================================================================== */
(function seedNotes() {
  function fileByName(name) {
    var hit = null;
    Object.keys(FILES_BY_ID).forEach(function (k) { if (FILES_BY_ID[k].name === name) hit = FILES_BY_ID[k]; });
    return hit;
  }
  function stepByTitle(showId, title) {
    var s = SHOWS_BY_ID[showId], hit = null;
    if (s) s.steps.forEach(function (st) { if (st.title === title) hit = st; });
    return hit;
  }
  function poByNum(num) {
    var hit = null;
    ALL_POS.forEach(function (p) { if (p.po_number === num) hit = p; });
    return hit;
  }
  var read = markNoteRead;

  /* -- Houston blown budget (show 5) — Candice flags it, Tom + Tony reply -- */
  var h1 = mkNote('show', 5, 'candice', 'Hardware COGS on 26-1207 just passed the $30,000 allotment, and the wave-2 cabinets on PO-26-041 will push it further under. @Tom can we talk re-pricing the Houston sale before that order lands?', -6, '10:20');
  var h2 = mkNote('show', 5, 'tandres', "Seen it. @Tony hold the tunnel-expansion line until Houston's front office confirms the change order — the rest of wave 2 can ship.", -6, '11:05', { parent: h1.id });
  var h3 = mkNote('show', 5, 'tvigon', "Change-order draft goes to their front office tomorrow. I'd keep the freight leg league-covered either way — that part isn't the problem.", -5, '09:15', { parent: h1.id });
  read('tandres', h1.id); read('tandres', h3.id);   /* Tom replied — he's read the room */
  read('candice', h2.id); read('candice', h3.id);
  /* h2 mentions Tony -> stays UNREAD for tvigon */

  /* -- Atlanta delivery-risk PO (PO-26-041) — ops chasing the freight split -- */
  var po41 = poByNum('PO-26-041');
  if (po41) {
    var a1 = mkNote('po', po41.id, 'bsawyer', "ROE's consolidated ETA lands five days after Atlanta's load-in — that's the cost of one season freight. I've asked them to split the Atlanta balance onto its own truck.", -3, '14:30');
    var a2 = mkNote('po', po41.id, 'tvigon', "If the split adds less than ~$1,500 we eat it — a dark install day costs more than freight. @Brendon make the call by Friday either way.", -2, '09:40', { parent: a1.id });
    var a3 = mkNote('po', po41.id, 'bsawyer', 'Split quote requested — ROE says Thursday. Tracking it here.', -1, '16:10', { parent: a1.id });
    read('tvigon', a3.id);
    void a2;                                        /* a2 mention -> UNREAD for bsawyer */
  }

  /* -- Proof-file thread (Marlins approved proof) — client ask, checked -- */
  var proof = fileByName('Marlins Perimeter Wraps — Approved Proof');
  if (proof) {
    var p1 = mkNote('file', proof.id, 'jeaton', "Club's thrilled with the R2 color. One late ask from sponsorship — can the panel-9 logo clear the rail seam by another inch?", -4, '10:05');
    var p2 = mkNote('file', proof.id, 'jhawk', "It clears by 1.5in as built — overlay's in the folder. @Larry sanity-check the dieline before I tell the club it's fine.", -4, '11:20', { parent: p1.id });
    var p3 = mkNote('file', proof.id, 'lfarkos', "Checked — 1.6in on the locked dieline, and the seam allowance is already in the approved proof. It's fine as printed.", -3, '08:45', { parent: p1.id });
    read('lfarkos', p2.id);                         /* he replied */
    read('jeaton', p2.id); read('jeaton', p3.id);
    read('jhawk', p3.id);
  }

  /* -- Agent-author demo: Tom's agent narrates its PO draft, asks Candice -- */
  var po49 = poByNum('PO-26-049');
  if (po49) {
    mkNote('po', po49.id, 'agent:tandres', 'Drafted this PO from the LOVB season planning meeting — spares and consumables, two lines, both estimates. @Candice can you verify the kit-attrition line against last season’s actuals before it goes out for quotes?', -1, '17:10',
      { provenance: { source_kind: 'meeting', source_ref: 'teams:19:meeting_LOVB-2026-planning', source_label: 'LOVB season planning', agent_user: 'tandres', confidence: 82 } });
    /* mention -> UNREAD for candice */
  }

  /* -- A step/task thread (AVCA power plan) — UNREAD mention for Tom -- */
  var stPower = stepByTitle(1, 'Power plan — no feeder on site, union tie-in TBD');
  if (stPower) {
    mkNote('step', stPower.id, 'bsawyer', 'Fiserv ops came back: the union tie-in needs a certified electrician on our ticket, not the house’s. @Tom does the Bolt6 bridge rack need its own drop, or can it ride the ops feed?', -1, '13:25');
  }

  /* -- AVCA show thread — a second UNREAD mention for Tom, plus the
        injection-attempt body (esc() audit case: renders as plain text) -- */
  var v1 = mkNote('show', 1, 'tvigon', "Forklift is still unresolved at T-10. @Tom if IATSE won't supply a certified driver by Monday we rent one and bill the job — your call.", 0, '08:50');
  var v2 = mkNote('show', 1, 'dvargas', "Great — <b>bold</b> isn't allowed, right @Tom? Testing the new notes before I'm on the road.", 0, '09:20', { parent: v1.id });
  read('tvigon', v2.id);
  /* v1 + v2 mentions -> UNREAD for tandres */

  /* -- Season-level note on the LOVB project folder -- */
  var l1 = mkNote('project', 3, 'bsawyer', 'Season logistics rhythm for every city: freight books 21 days out, hotels at 14, content window confirmed at 10. Madison is the template — copy its checklist forward each leg.', -8, '15:40');
  var l2 = mkNote('project', 3, 'jhawk', 'Add the content refresh to that: clients need the per-match package brief 10 days out or QC slips. Baking it into the per-match template.', -7, '10:30', { parent: l1.id });
  read('bsawyer', l2.id);

  /* -- Thread on a financial doc (the O'Brien season freight invoice) -- */
  var obr = fileByName("O'Brien Freight — season advance deposit");
  if (obr) {
    var o1 = mkNote('file', obr.id, 'candice', "Reconciled against 26-1180. Heads up — O'Brien's rate came in 6% over the season quote. Flagging before the remaining legs book.", -3, '11:45');
    var o2 = mkNote('file', obr.id, 'bsawyer', "That's their new fuel surcharge. Legs 2–6 are locked at the quoted rate on the season agreement, so this should be the only bump.", -2, '09:05', { parent: o1.id });
    read('candice', o2.id);
  }

  /* -- Job-level note (Houston sale, job 4) -- */
  mkNote('job', 4, 'candice', 'Holding any new spend on 26-1207 until the change order lands — anything gear-tagged on this job needs my sign-off first. Budget is already over.', -5, '09:30');

  /* -- Madison venue-advance step — risk context where the work happens -- */
  var stMad = stepByTitle(3, 'Venue advance — survey + power (Field House)');
  if (stMad) {
    mkNote('step', stMad.id, 'tvigon', "Field House confirmed: no house feeder, same story as Fiserv. The O'Neill distro on PO-26-044 covers it — I'll clear the at-risk flag once the truck lands.", -2, '14:15');
  }

  /* -- NW show — UNREAD mention for Candice, pairs with Brendon's proposal -- */
  mkNote('show', 9, 'bsawyer', '@Candice the Marriott folio landed via my agent overnight — once I confirm the proposal, NW travel is fully papered and off your chase list.', -1, '07:55');
})();

/* ============================================================================
   SCHEDULE — day-by-day items + crew assignments  (call-sheet pass)
   ----------------------------------------------------------------------------
   The per-show, day-by-day call sheet (TEAM_FEEDBACK "Deliverables & onsite"):
   the PM twin of the staffing app's Tech Packet. Shapes:

   shows gain    : load_in_time · doors_time · event_time · strike_time (HH:MM)
                   venue_address · parking_notes · radio_channel · dress_code
                   venue_poc {name, phone, title} · client_poc {name, phone, title}
   schedule_items: {id, show_id, day (ISO), start_time, end_time?, title,
                   detail?, who (usernames[] | 'all' | role), location?,
                   kind 'travel'|'work'|'show'|'meal'|'strike'}
   crew_assignments: {id, show_id, username | (name+phone for local hires),
                   role_on_site, call_time, travel | null (local crew)}

   TRAVEL MIRRORS INTEGRATION.md B.6 (staffing travel_info) 1:1 so the future
   read-back API swaps in for this mock without reshaping:
     leg = { travel_key ("Name|prevEventId|nextEventId" — mock uses the SHOW id
             where staffing will use its event id; 0 = home), flight_num,
             is_driving, departure_city, departure_date, departure_time,
             arrival_date, arrival_time, going_home, record_locator }
   Hotels are NOT travel_info rows in staffing — they map to a booking
   (category 'hotel', vendor/confirmation_number/start/end, B.2) — so the
   hotel object here carries exactly those fields.
   ========================================================================== */
var SCHED_KINDS = {
  travel: { label: 'Travel',    color: 'var(--info)' },
  work:   { label: 'Work call', color: 'var(--warn)' },
  show:   { label: 'Show',      color: 'var(--accent)' },
  meal:   { label: 'Meal',      color: '#B98CF0' },      /* gear-lane purple — go/accent greens are taken */
  strike: { label: 'Strike',    color: 'var(--crit)' }
};
var SCHED_KIND_ORDER = ['travel', 'work', 'show', 'meal', 'strike'];
/* schedule edit rights — pm and up (viewer/tech read the sheet, never edit it) */
var SCHED_EDIT_ROLES = { admin: 1, manager: 1, pm: 1 };

var _schedSeq = 0, _crewSeq = 0, _roomSeq = 0;
var SCHEDULE_BY_ID = {}, CREW_BY_ID = {}, ROOMING_BY_ID = {};

function mkSched(show, day, start, title, x) {
  x = x || {};
  var it = { id: ++_schedSeq, show_id: show.id, day: day, start_time: start,
             end_time: x.end || null, title: title, detail: x.detail || '',
             who: x.who || 'all', location: x.location || '', kind: x.kind || 'work' };
  (show.schedule_items = show.schedule_items || []).push(it);
  SCHEDULE_BY_ID[it.id] = it;
  return it;
}
/* one B.6-shaped travel leg. prevId/nextId are event ids ("0" = home). */
function mkLeg(name, prevId, nextId, o) {
  return { travel_key: name + '|' + prevId + '|' + nextId,
           flight_num: o.flight || '', is_driving: !!o.driving,
           departure_city: o.from || '', departure_date: o.dd || '', departure_time: o.dt || '',
           arrival_date: o.ad || o.dd || '', arrival_time: o.at || '',
           going_home: !!o.home, record_locator: o.conf || '' };
}
function mkCrew(show, who, roleOnSite, callTime, travel) {
  var c = { id: ++_crewSeq, show_id: show.id,
            username: typeof who === 'string' ? who : null,
            name: typeof who === 'string' ? null : who.name,
            phone: typeof who === 'string' ? null : who.phone,
            role_on_site: roleOnSite, call_time: callTime, travel: travel || null };
  (show.crew_assignments = show.crew_assignments || []).push(c);
  CREW_BY_ID[c.id] = c;
  return c;
}
/* mkRoom(show, {person, username, hotel, booking_id, room_type, conf,
   check_in, check_out, notes}) — one rooming-list row, the room_assignments
   shape 1:1. `person` is the printed truth; `username` links a roster person
   the way a crew line does; `booking_id` points at the show's booked room
   block when there is one (a booking delete nulls it, never the row). */
function mkRoom(show, o) {
  o = o || {};
  /* data.js loads BEFORE components.js (index.html), so userName() does not
     exist yet at seed time — seeds pass `person` explicitly; the roster
     fallback serves only the runtime demo twins in api.js. */
  var r = { id: ++_roomSeq, show_id: show.id,
            person: o.person ||
              (o.username && typeof userName === 'function' ? userName(o.username) : o.username || ''),
            user_username: o.username || null,
            hotel: o.hotel || '', booking_id: o.booking_id || null,
            room_type: o.room_type || '', confirmation: o.conf || '',
            check_in: o.check_in || null, check_out: o.check_out || null,
            notes: o.notes || '', sort_order: o.sort_order || 0 };
  (show.room_assignments = show.room_assignments || []).push(r);
  ROOMING_BY_ID[r.id] = r;
  return r;
}

/* sorted schedule for a show; days come out chronological, items by time */
function scheduleForShow(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  var items = ((s && s.schedule_items) || []).slice();
  items.sort(function (a, b) {
    return a.day < b.day ? -1 : a.day > b.day ? 1
      : a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a.id - b.id;
  });
  return items;
}
function scheduleDays(showId) {
  var days = [], seen = {};
  scheduleForShow(showId).forEach(function (it) { if (!seen[it.day]) { seen[it.day] = 1; days.push(it.day); } });
  return days;
}
/* does this schedule item apply to <username>? who: 'all' | usernames[] | role */
function schedItemFor(item, username) {
  var w = item.who;
  if (w === 'all' || w == null) return true;
  if (Object.prototype.toString.call(w) === '[object Array]') return w.indexOf(username) >= 0;
  var u = ROSTER[username];
  return !!(u && u.role === w);                    /* role slug, e.g. 'tech' */
}
function crewForShow(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  return ((s && s.crew_assignments) || []).slice();
}
/* the rooming list, in the order the server would answer it */
function roomingForShow(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  var rows = ((s && s.room_assignments) || []).slice();
  rows.sort(function (a, b) {
    return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
  });
  return rows;
}
function crewFor(showId, username) {
  return crewForShow(showId).filter(function (c) { return c.username === username; })[0] || null;
}
/* what a day IS relative to the show's own dates — chips + sheet headers */
function schedDayTag(show, day) {
  if (day === show.load_in_date && day === show.event_date) return 'Show day';
  if (day === show.load_in_date) return 'Load-in';
  if (day === show.event_date) return 'Show day';
  if (day === show.strike_date) return 'Strike';
  return '';
}

/* ---- scheduler push twin (push v2 — the create-vs-link choice) -------------
   The staffing app's event list as GET /api/scheduler/events trims it, plus
   the local mutations behind link / unlink / push — so the whole flow (the
   choice modal, the searchable picker, the linked / pushed / unlink states)
   renders from file:// with no server. In this world the "staffing app" is
   this array; against a real unconfigured server the routes answer their
   honest 501 and none of this is consulted. Ids start at 501 so nobody
   confuses them with a demo show id. */
var DEMO_SCHED_EVENTS = [
  { id: 501, name: 'AVCA First Serve 2026', eventDate: dayISO(10), setup: dayISO(9),
    breakdown: dayISO(12), location: 'Fiserv Forum — Milwaukee, WI', clientId: null, archived: false },
  { id: 502, name: 'Marlins Opening Homestand — print install', eventDate: dayISO(8), setup: dayISO(8),
    breakdown: dayISO(15), location: 'loanDepot Park — Miami, FL', clientId: null, archived: false },
  { id: 503, name: 'LOVB Madison — court + perimeter', eventDate: dayISO(17), setup: dayISO(16),
    breakdown: dayISO(18), location: 'Alliant Energy Center — Madison, WI', clientId: null, archived: false },
  { id: 504, name: 'USA v Brazil friendly — field boards', eventDate: dayISO(231), setup: dayISO(230),
    breakdown: dayISO(231), location: 'Northwest Stadium — Landover, MD', clientId: null, archived: false },
  { id: 505, name: 'Bucks in-bowl activation', eventDate: dayISO(-12), setup: dayISO(-14),
    breakdown: dayISO(-11), location: 'Fiserv Forum — Milwaukee, WI', clientId: null, archived: true }
];
var _demoSchedEventSeq = 900;      /* ids for events a demo push "creates" */
function demoSchedEventById(id) {
  return DEMO_SCHED_EVENTS.filter(function (e) { return e.id === Number(id); })[0] || null;
}
/* wall-clock HH:MM for the activity lines these twins write */
function _demoHM() {
  var d = new Date(), h = String(d.getHours()), m = String(d.getMinutes());
  return (h.length < 2 ? '0' + h : h) + ':' + (m.length < 2 ? '0' + m : m);
}
/* The dry run, from the local store — same keys the server answers (payloads
   PLURAL), so the confirm modal reads one shape in both worlds. */
function demoSchedulerDry(s) {
  var steps = s.steps || [];
  var crew = s.crew_assignments || [];
  var crewNames = [];
  var add = function (n) { if (n && crewNames.indexOf(n) < 0) crewNames.push(n); };
  steps.forEach(function (st) {
    if (st.lane === 'crew' && st.owner && st.status !== 'na') add(userName(st.owner) || st.owner);
  });
  crew.forEach(function (c) { add(c.name || userName(c.username) || c.username); });
  var travel = [];
  crew.forEach(function (c) {
    if (c.travel && c.travel.out) travel.push({ leg: 'arrival' });
    if (c.travel && c.travel.back) travel.push({ leg: 'departure' });
  });
  var problems = [];
  if (!isConfirmed(s)) {
    problems.push('This show is not confirmed yet. Confirming records that the client committed and is what unlocks the push.');
  }
  if (!s.load_in_date) problems.push('The show has no load-in date.');
  return {
    dryRun: true,
    note: 'No data sent — the demo twin of the dry run.',
    ready: !problems.length,
    problems: problems,
    rosterNote: 'Demo — crew names are not checked against a staffing roster here.',
    linkedEventId: s.scheduler_event_id || null,
    payloads: {
      eventPayload: { event: s.name },
      bookings: steps.filter(function (st) { return st.lane === 'logistics'; })
        .map(function (st) { return { customLabel: st.title }; }),
      venueContacts: steps.filter(function (st) { return st.lane === 'venue' && st.owner; })
        .map(function (st) { return { name: st.owner }; }),
      clientContacts: [],
      travel: travel,
      crewNames: crewNames
    }
  };
}
function demoSchedulerLink(s, eventId) {
  var ev = demoSchedEventById(eventId);
  if (!ev) return { error: 'staffing event #' + eventId + ' does not exist — refresh the list and pick again' };
  if (s.scheduler_event_id && Number(s.scheduler_event_id) !== Number(eventId)) {
    return { error: 'already linked to staffing event #' + s.scheduler_event_id + ' — unlink first' };
  }
  s.scheduler_event_id = Number(eventId);
  s.scheduler_pushed_at = null; s.scheduler_pushed_by = null; s.scheduler_stale = false;
  s.activity.unshift(mkAct(ME, 'linked to the scheduler',
    'staffing event #' + eventId + ' — ' + ev.name, 0, _demoHM(), true));
  return { ok: true, show: s, event: ev };
}
function demoSchedulerUnlink(s) {
  if (!s.scheduler_event_id) return { error: 'this show is not linked to a staffing event' };
  var old = s.scheduler_event_id;
  s.scheduler_event_id = null;
  s.scheduler_pushed_at = null; s.scheduler_pushed_by = null; s.scheduler_stale = false;
  s.activity.unshift(mkAct(ME, 'unlinked from the scheduler',
    'staffing event #' + old + ' — nothing was deleted in the staffing app', 0, _demoHM(), true));
  return { ok: true, show: s, unlinkedEventId: old };
}
/* The live push, simulated the way every other demo write is: it mutates the
   local store and answers the server's shape. The activity line says which
   mode ran, exactly like routes/core.js logs it. */
function demoSchedulerPush(s, opts) {
  opts = opts || {};
  var dry = demoSchedulerDry(s);
  if (!dry.ready) return { error: dry.problems[0] || 'the show is not ready for the scheduler' };
  var created = !s.scheduler_event_id;
  if (created) s.scheduler_event_id = ++_demoSchedEventSeq;
  var mode = opts.mode === 'override' ? 'override' : 'keep';
  s.scheduler_pushed_at = new Date().toISOString();
  s.scheduler_pushed_by = ME;
  s.scheduler_stale = false;
  var pl = dry.payloads;
  s.activity.unshift(mkAct(ME, 'pushed to the scheduler',
    (created ? 'created' : 'updated') + ' staffing event #' + s.scheduler_event_id + ' — ' +
    pl.bookings.length + ' bookings, ' + pl.travel.length + ' travel legs' +
    (created ? '' : mode === 'override'
      ? ' · mode override — replaced the event’s existing children'
      : ' · mode keep — hand-entered staffing rows untouched'), 0, _demoHM(), true));
  return {
    ok: true, dryRun: false, schedulerEventId: s.scheduler_event_id, created: created,
    mode: mode,
    counts: { bookings: pl.bookings.length, venueContacts: pl.venueContacts.length,
              clientContacts: pl.clientContacts.length, travel: pl.travel.length },
    crewNames: pl.crewNames
  };
}

/* ---- staffing-link twin (Tom, 2026-09-03: "a way to link techs") -----------
   The staffing app's ROSTER, as GET /api/scheduler/roster trims it, seeded so
   file:// renders every state the panel has: two exact matches (one deliberately
   case/whitespace-mangled — staffing matches name.toLowerCase().trim(), and so
   does the panel), two profile links (Devin/Aaron already carry staffing_name),
   one first-name-only row with ONE candidate (Brendon → sure suggestion), one
   with TWO (Jim → ambiguous, nothing pre-picked), and two people who exist only
   over there. Ids start at 601 — the same nobody-confuses-these convention as
   DEMO_SCHED_EVENTS. */
var DEMO_STAFFING_ROSTER = [
  { id: 601, name: 'Tom Andres',     email: 'tom@e360sport.com',   initials: 'TA' },
  { id: 602, name: ' tony vigon ',   email: 'tony@e360sport.com',  initials: 'TV' },
  { id: 603, name: 'Devin Vargas',   email: 'devin@e360sport.com', initials: 'DV' },
  { id: 604, name: 'Aaron Ramos',    email: 'aaron@e360sport.com', initials: 'AR' },
  { id: 605, name: 'Brendon',        email: '',                    initials: 'B'  },
  { id: 606, name: 'Jim',            email: '',                    initials: 'J'  },
  { id: 607, name: 'Dana Fields',    email: 'dana@e360sport.com',  initials: 'DF' },
  { id: 608, name: 'Marcus Webb',    email: '',                    initials: 'MW' }
];
var _demoStaffingSeq = 650;        /* ids for rows a demo "add" creates */
function demoAddToStaffingRoster(userId) {
  if (CURRENT_USER.role !== 'admin') throw new Error('Adding to the staffing roster is an admin act');
  var u = USERS_BY_ID[Number(userId)];
  if (!u) throw new Error('No such person');
  var name = String(u.staffing_name || u.name || u.username || '').trim();
  if (!name) throw new Error('User ' + u.username + ' has no name to put on a roster');
  var k = name.toLowerCase();
  if (DEMO_STAFFING_ROSTER.some(function (r) { return String(r.name).toLowerCase().trim() === k; })) {
    throw new Error('"' + name + '" is already on the staffing roster — link them instead of adding a duplicate.');
  }
  var row = { id: ++_demoStaffingSeq, name: name, email: u.email || '', initials: u.initials || '' };
  DEMO_STAFFING_ROSTER.push(row);
  return { ok: true, created: row, demo: true };
}
/* GET /api/crew-names, from the local store: free-text crew lines on
   non-archived shows, grouped by spelling. Rey Fuentes (the Marlins local
   hire) is the seeded case — he names no user and no staffing roster row. */
function demoCrewNames() {
  var groups = [], byKey = {};
  activeShows().forEach(function (s) {
    (s.crew_assignments || []).forEach(function (c) {
      if (c.username || !c.name || !String(c.name).trim()) return;
      var key = String(c.name).toLowerCase().trim();
      var g = byKey[key];
      if (!g) { g = { name: String(c.name).trim(), crew: [] }; byKey[key] = g; groups.push(g); }
      g.crew.push({ id: c.id, show_id: s.id, show_name: s.name });
    });
  });
  groups.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
  return groups;
}

/* ---- seed: header fields + schedule + crew for the three near-term shows --
   Everything else renders the empty state ("no schedule yet") on purpose. */
(function seedSchedule() {
  var S_AVCA = SHOWS_BY_ID[1], S_MARL = SHOWS_BY_ID[2], S_MAD = SHOWS_BY_ID[3];

  /* ======== AVCA First Serve — Fiserv Forum · show-day sheet ============= */
  S_AVCA.load_in_time = '06:00'; S_AVCA.doors_time = '17:30';
  S_AVCA.event_time = '19:00';   S_AVCA.strike_time = '22:30';
  S_AVCA.venue_address = '1111 Vel R. Phillips Ave, Milwaukee, WI 53203';
  S_AVCA.parking_notes = 'Crew lot on N 6th St — dock passes at the security office; trucks marshal on W Juneau Ave';
  S_AVCA.radio_channel = 'CH 2 · production';
  S_AVCA.dress_code = 'Show blacks after 17:00';
  S_AVCA.venue_poc = { name: 'Marcus Hale', phone: '(414) 555-0221', title: 'Fiserv Forum event ops' };
  S_AVCA.client_poc = { name: 'Dana Fox', phone: '(312) 555-0245', title: 'Fox & Co · producer' };

  var aLI = S_AVCA.load_in_date, aSH = S_AVCA.event_date, aST = S_AVCA.strike_date;
  mkSched(S_AVCA, aLI, '06:00', 'Load-in — dock opens', { location: 'Dock 4 · N 6th St', detail: 'Dock passes at security. Terraflex floor goes down first — LED waits on it.' });
  mkSched(S_AVCA, aLI, '06:30', 'Truck unload + case push', { location: 'Dock 4' });
  mkSched(S_AVCA, aLI, '08:00', 'Courtside + perimeter build', { detail: '48 cabinets · 2 zones' });
  mkSched(S_AVCA, aLI, '12:00', 'Lunch — crew catering, loading dock green room', { kind: 'meal' });
  mkSched(S_AVCA, aLI, '13:30', 'Power tie-in — union electrician', { who: ['tandres'], location: 'House power vault', detail: 'No feeder on site — 200ft 3-phase run (PO-26-036). Union tie-in on our ticket.' });
  mkSched(S_AVCA, aLI, '15:00', 'Fiber run to Bolt6 operator position', { who: ['bsawyer'], location: 'Camera deck · section 214' });
  mkSched(S_AVCA, aLI, '17:00', 'Pixel-out + sync test with Daktronics house system', { who: ['tandres', 'aramos'], detail: 'HD-SDI + shared subnet — sync the "big moments"' });
  mkSched(S_AVCA, aSH, '09:00', 'Crew call — notes from load-in', { location: 'Production office' });
  mkSched(S_AVCA, aSH, '10:00', 'Bolt6 stat-feed rehearsal', { who: ['tandres'], detail: 'Serve speed / attack / height thresholds — collegiate bands' });
  mkSched(S_AVCA, aSH, '12:00', 'Lunch', { kind: 'meal' });
  mkSched(S_AVCA, aSH, '14:00', 'Full run-through with Fox & Co', { detail: 'Content package + sponsor loop on the perimeter' });
  mkSched(S_AVCA, aSH, '17:30', 'Doors', { kind: 'show' });
  mkSched(S_AVCA, aSH, '19:00', 'AVCA First Serve — show', { kind: 'show', location: 'Court' });
  mkSched(S_AVCA, aSH, '21:30', 'Post-show reset — system to standby', { who: 'tech' });
  mkSched(S_AVCA, aST, '08:00', 'Strike — cabinets down, case + label', { kind: 'strike' });
  mkSched(S_AVCA, aST, '11:00', 'Truck load-out', { kind: 'strike', location: 'Dock 4' });
  mkSched(S_AVCA, aST, '13:00', 'Crew release — flights out of MKE', { kind: 'travel' });

  mkCrew(S_AVCA, 'bsawyer', 'Show lead · on-site POC', '06:00', {
    out:  mkLeg('Brendon Sawyer', 0, 1, { flight: 'AA 2104', from: 'Charlotte, NC (CLT)', dd: dayISO(8), dt: '16:40', at: '18:05', conf: 'HKR4QZ' }),
    back: mkLeg('Brendon Sawyer', 1, 0, { flight: 'AA 1633', from: 'Milwaukee, WI (MKE)', dd: dayISO(12), dt: '17:20', at: '20:45', home: true, conf: 'HKR4QZ' }),
    hotel: { name: 'Hyatt Regency Milwaukee', address: '333 W Kilbourn Ave, Milwaukee, WI', conf: 'HY-102-4470', checkin: dayISO(8), checkout: dayISO(12) }
  });
  mkCrew(S_AVCA, 'aramos', 'LED tech', '06:00', {
    out:  mkLeg('Aaron', 0, 1, { flight: 'DL 1442', from: 'Dallas, TX (DFW)', dd: dayISO(8), dt: '13:10', at: '15:55', conf: 'MX2JLP' }),
    back: mkLeg('Aaron', 1, 0, { flight: 'DL 2251', from: 'Milwaukee, WI (MKE)', dd: dayISO(12), dt: '16:05', at: '18:40', home: true, conf: 'MX2JLP' }),
    hotel: { name: 'Hyatt Regency Milwaukee', address: '333 W Kilbourn Ave, Milwaukee, WI', conf: 'HY-102-4471', checkin: dayISO(8), checkout: dayISO(12) }
  });
  mkCrew(S_AVCA, 'tandres', 'Systems · Bolt6 bridge', '08:00', null);   /* local — Milwaukee HQ */
  mkCrew(S_AVCA, 'dvargas', 'Gear · truck + prep', '05:30', null);      /* local — drives the truck from the shop */

  /* ======== Marlins Perimeter Wraps — install-day sheet (lighter) ======== */
  S_MARL.load_in_time = '06:00'; S_MARL.doors_time = null;
  S_MARL.event_time = null;      S_MARL.strike_time = null;
  S_MARL.venue_address = '501 Marlins Way, Miami, FL 33125';
  S_MARL.parking_notes = 'Enter via dock C off NW 7th St — check in with stadium security; hard hats past the gate';
  S_MARL.radio_channel = null;
  S_MARL.dress_code = 'Hi-vis + closed toe on field';
  S_MARL.venue_poc = { name: 'Luis Ortega', phone: '(305) 555-0129', title: 'loanDepot park field ops' };
  S_MARL.client_poc = { name: 'Jim Eaton', phone: '(305) 555-0188', title: 'Miami Marlins · partnerships' };

  var mIN = S_MARL.load_in_date;
  mkSched(S_MARL, mIN, '06:00', 'Crew call — dock C security check-in', { location: 'Dock C · NW 7th St' });
  mkSched(S_MARL, mIN, '06:30', 'Crates to field — stage by rail section', { detail: 'Crates are labeled by section — panels 1–14 run first' });
  mkSched(S_MARL, mIN, '07:00', 'Hang + tension perimeter wraps', { location: 'Outfield rail' });
  mkSched(S_MARL, mIN, '12:00', 'Lunch — field level', { kind: 'meal' });
  mkSched(S_MARL, mIN, '13:00', 'Dugout rail + on-deck circle install', { who: ['aramos'] });
  mkSched(S_MARL, mIN, '15:00', 'Client walk + photo documentation', { who: ['lfarkos'], location: 'Field', detail: 'Photos feed the closeout recap' });
  mkSched(S_MARL, mIN, '16:00', 'Wrap — crew release', { kind: 'travel' });

  mkCrew(S_MARL, 'aramos', 'Install lead', '06:00', {
    out:  mkLeg('Aaron', 0, 2, { flight: 'AA 917', from: 'Dallas, TX (DFW)', dd: dayISO(7), dt: '10:35', at: '14:20', conf: 'QT8WVA' }),
    back: mkLeg('Aaron', 2, 0, { flight: 'AA 1210', from: 'Miami, FL (MIA)', dd: dayISO(9), dt: '09:15', at: '11:40', home: true, conf: 'QT8WVA' }),
    hotel: { name: 'Courtyard Miami Airport', address: '1201 NW 42nd Ave, Miami, FL', conf: 'CY-771208', checkin: dayISO(7), checkout: dayISO(9) }
  });
  mkCrew(S_MARL, 'lfarkos', 'PM · client walk', '08:00', {
    out:  mkLeg('Larry Farkos', 0, 2, { flight: 'DL 883', from: 'Milwaukee, WI (MKE)', dd: dayISO(7), dt: '07:00', at: '11:25', conf: 'RLP9KD' }),
    back: mkLeg('Larry Farkos', 2, 0, { flight: 'DL 1560', from: 'Miami, FL (MIA)', dd: dayISO(8), dt: '19:30', at: '22:10', home: true, conf: 'RLP9KD' }),
    hotel: { name: 'Courtyard Miami Airport', address: '1201 NW 42nd Ave, Miami, FL', conf: 'CY-771209', checkin: dayISO(7), checkout: dayISO(8) }
  });
  mkCrew(S_MARL, { name: 'Rey Fuentes', phone: '(305) 555-0163' }, 'Local hand · Miami Event Labor', '06:00', null);

  /* ======== LOVB Madison — multi-day install, the rich one =============== */
  S_MAD.load_in_time = '07:00'; S_MAD.doors_time = '17:00';
  S_MAD.event_time = '18:30';   S_MAD.strike_time = '21:30';
  S_MAD.venue_address = '1450 Monroe St, Madison, WI 53711';
  S_MAD.parking_notes = 'Dock off Regent St — window 07:00–11:00, no idling. Floor protection down before any case rolls.';
  S_MAD.radio_channel = 'CH 1 · all crew';
  S_MAD.dress_code = 'LOVB polo + blacks on show day';
  S_MAD.venue_poc = { name: 'Terry Novak', phone: '(608) 555-0187', title: 'UW Field House operations' };
  S_MAD.client_poc = { name: 'Priya Shah', phone: '(646) 555-0132', title: 'LOVB · event production' };

  var dLI = S_MAD.load_in_date, dSH = S_MAD.event_date, dST = S_MAD.strike_date;
  /* day 1 — install. The truck line is the PO delivery-risk story made
     operational: O'Neill distro (PO-26-044) is ON that truck. */
  mkSched(S_MAD, dLI, '04:30', 'Kit truck departs Milwaukee shop', { kind: 'travel', who: ['dvargas'], detail: "Truck 22 — traveling kit + the O'Neill distro (PO-26-044, tracking ONL-88213-04)" });
  mkSched(S_MAD, dLI, '07:00', 'Dock opens — floor protection down', { location: 'Regent St dock', detail: 'Dock window closes 11:00 — hard stop' });
  mkSched(S_MAD, dLI, '07:30', 'Truck arrives — unload + case push', { location: 'Dock B', detail: "O'Neill 200A distro rides this truck. If PO-26-044 slips, power waits." });
  mkSched(S_MAD, dLI, '09:00', 'Ground support + cabinet build', { detail: '40 cabinets · court-side kit' });
  mkSched(S_MAD, dLI, '12:00', 'Lunch on site', { kind: 'meal' });
  mkSched(S_MAD, dLI, '13:00', 'Power tie-in — no house feeder', { who: ['tandres'], location: 'NE mechanical room', detail: "O'Neill distro + cam-lok run — same story as Fiserv" });
  mkSched(S_MAD, dLI, '15:00', 'Data + processor rack · fiber to court', { who: ['tandres', 'aramos'] });
  mkSched(S_MAD, dLI, '17:30', 'Pixel-out test + color balance', { who: ['tandres', 'aramos'] });
  mkSched(S_MAD, dLI, '19:00', "Hotel check-in — The Governor's Inn", { kind: 'travel', location: '110 E Washington Ave' });
  /* day 2 — match day */
  mkSched(S_MAD, dSH, '08:00', 'Crew call — notes + overnight fixes', { location: 'Court' });
  mkSched(S_MAD, dSH, '10:00', 'Content load + season-spec check', { who: ['tandres'], detail: 'Match-1 package on the inherited season spec' });
  mkSched(S_MAD, dSH, '12:30', 'Lunch', { kind: 'meal' });
  mkSched(S_MAD, dSH, '14:00', 'Full run-through with LOVB production', { detail: "Sponsor loop + match graphics with Priya's team" });
  mkSched(S_MAD, dSH, '17:00', 'Doors', { kind: 'show' });
  mkSched(S_MAD, dSH, '18:30', 'LOVB Madison — Match 1', { kind: 'show', location: 'Court' });
  mkSched(S_MAD, dSH, '21:00', 'Post-match sponsor loop · system to standby', { who: 'tech' });
  /* day 3 — strike + hand-off to leg 2 */
  mkSched(S_MAD, dST, '08:00', 'Strike — cabinets down, kit repack', { kind: 'strike' });
  mkSched(S_MAD, dST, '12:00', 'Truck load-out — kit to the Atlanta leg', { kind: 'strike', location: 'Regent St dock', detail: "Freight leg 2 — O'Brien Freight, league-covered" });
  mkSched(S_MAD, dST, '14:00', 'Crew release — flights + drives home', { kind: 'travel' });

  var mD = function (n) { return isoDate(addDays(new Date(S_MAD.event_date + 'T00:00:00'), n)); };
  mkCrew(S_MAD, 'bsawyer', 'Show lead · on-site POC', '07:00', {
    out:  mkLeg('Brendon Sawyer', 0, 3, { flight: 'AA 1808', from: 'Charlotte, NC (CLT)', dd: mD(-2), dt: '17:05', at: '19:10', conf: 'HKR5MB' }),
    back: mkLeg('Brendon Sawyer', 3, 0, { flight: 'AA 2117', from: 'Madison, WI (MSN)', dd: mD(1), dt: '18:20', at: '21:55', home: true, conf: 'HKR5MB' }),
    hotel: { name: "The Governor's Inn — Madison", address: '110 E Washington Ave, Madison, WI', conf: 'GI-88213', checkin: mD(-2), checkout: mD(1) }
  });
  mkCrew(S_MAD, 'tandres', 'Systems · power + data', '07:00', {
    out:  mkLeg('Tom Andres', 0, 3, { driving: true, from: 'Milwaukee, WI (shop)', dd: mD(-1), dt: '05:30', at: '07:00' }),
    back: mkLeg('Tom Andres', 3, 0, { driving: true, from: 'Madison, WI', dd: mD(1), dt: '14:30', home: true }),
    hotel: { name: "The Governor's Inn — Madison", address: '110 E Washington Ave, Madison, WI', conf: 'GI-88214', checkin: mD(-1), checkout: mD(1) }
  });
  mkCrew(S_MAD, 'aramos', 'LED tech', '07:30', {
    out:  mkLeg('Aaron', 0, 3, { flight: 'AA 388', from: 'Dallas, TX (DFW)', dd: mD(-2), dt: '14:20', at: '16:45', conf: 'MX3TRD' }),
    back: mkLeg('Aaron', 3, 0, { flight: 'AA 1591', from: 'Madison, WI (MSN)', dd: mD(1), dt: '19:10', at: '22:05', home: true, conf: 'MX3TRD' }),
    hotel: { name: "The Governor's Inn — Madison", address: '110 E Washington Ave, Madison, WI', conf: 'GI-88215', checkin: mD(-2), checkout: mD(1) }
  });
  mkCrew(S_MAD, 'dvargas', 'Gear · kit truck', '04:30', {
    out:  mkLeg('Devin', 0, 3, { driving: true, from: 'Milwaukee shop — Truck 22', dd: mD(-1), dt: '04:30', at: '07:15' }),
    back: mkLeg('Devin', 3, 0, { driving: true, from: 'Madison, WI', dd: mD(1), dt: '13:00', home: true }),
    hotel: { name: "The Governor's Inn — Madison", address: '110 E Washington Ave, Madison, WI', conf: 'GI-88216', checkin: mD(-1), checkout: mD(1) }
  });
  mkCrew(S_MAD, { name: 'Mike Deroche', phone: '(608) 555-0144' }, 'Local stagehand', '07:30', null);
  mkCrew(S_MAD, { name: 'Sam Okafor', phone: '(608) 555-0171' }, 'Local stagehand · forklift cert', '07:30', null);

  /* ---- Madison's rooming list (TEAM_FEEDBACK "Rooming lists") -------------
     Three beds off the crew: the show lead on the booked room block (the
     'Lodging — crew room block' booking above carries the money; this row
     carries HIS bed in it), a tech on a free-text hotel, and a local hire who
     is a name and a phone number — no login, but he still sleeps somewhere.
     Every other show renders the rooming empty state on purpose. */
  var madLodging = (S_MAD.bookings || []).filter(function (b) {
    return b.category.indexOf('Lodging') === 0;
  })[0] || null;
  mkRoom(S_MAD, { person: 'Brendon Sawyer', username: 'bsawyer', hotel: "The Governor's Inn",
    booking_id: madLodging ? madLodging.id : null, room_type: 'King',
    conf: 'GI-88213', check_in: mD(-2), check_out: mD(1) });
  mkRoom(S_MAD, { person: 'Aaron', username: 'aramos', hotel: "The Governor's Inn",
    room_type: 'Double', conf: 'GI-88215', check_in: mD(-2), check_out: mD(1),
    notes: 'late arrival — front desk holds the key' });
  mkRoom(S_MAD, { person: 'Mike Deroche', hotel: "The Governor's Inn",
    room_type: 'Double', conf: 'GI-88217', check_in: mD(-1), check_out: mD(1),
    notes: 'local hire — room only on show nights' });

  /* ---- Bucks (12) · the crew who now owe show reports (F2) ---------------
     Four logins and one local hand. The local hand has NO login, so nobody can
     ask him for a report and none is created — which is exactly the difference
     the show owner needs to see between "five on the crew" and "four owe". */
  var S_BUCK = SHOWS_BY_ID[12];
  if (S_BUCK) {
    mkCrew(S_BUCK, 'bsawyer', 'Show lead · on-site POC', '08:00', null);
    mkCrew(S_BUCK, 'aramos', 'LED tech', '08:00', null);
    mkCrew(S_BUCK, 'tandres', 'Systems', '09:00', null);
    mkCrew(S_BUCK, 'dvargas', 'Gear · truck + prep', '07:00', null);
    mkCrew(S_BUCK, { name: 'Curtis Vale', phone: '(414) 555-0182' }, 'Local hand', '08:00', null);
  }
  /* ---- Brewers (13) · the archived show's crew --------------------------- */
  var S_BREW = SHOWS_BY_ID[13];
  if (S_BREW) {
    mkCrew(S_BREW, 'lfarkos', 'PM · client walk', '06:00', null);
    mkCrew(S_BREW, 'aramos', 'Install lead', '06:00', null);
  }

  /* every other show: fields exist (null) so renderers never branch on
     hasOwnProperty — and the Schedule tab shows its empty state. */
  ALL_SHOWS.forEach(function (s) {
    ['load_in_time', 'doors_time', 'event_time', 'strike_time', 'venue_address',
     'parking_notes', 'radio_channel', 'dress_code', 'venue_poc', 'client_poc'].forEach(function (k) {
      if (s[k] === undefined) s[k] = null;
    });
    s.schedule_items = s.schedule_items || [];
    s.crew_assignments = s.crew_assignments || [];
  });
})();

/* ============================================================================
   EVENT PHOTOS — NAS-backed photo organization  (photo pass)
   ----------------------------------------------------------------------------
   The model (TEAM_FEEDBACK "Deliverables & onsite"): each user's agent sorts
   and NAMES event photos into per-event folders on the NAS, tags them to the
   event, and surfaces them here. Big media never enters the DB — a photo is a
   FILE row (kind 'photo') carrying metadata + the NAS path only:

     files gain : taken_at (ISO datetime) · width · height · caption ·
                  tags[] · thumb (URL string) · shot_by (username | null) ·
                  recap_pick (bool — curation flag the recap pass consumes) ·
                  nas_path (\\e360-nas\showrunner\P{id}-{slug}\S{id}-{slug}\photo\{file})

   `thumb` is JUST A STRING URL. In the prototype it is a deterministic inline
   SVG placeholder from mkThumb(); live, the NAS-side thumbnailer writes a real
   320px JPEG next to the original and this string becomes its serving URL —
   nothing else changes. Filenames follow the agent's naming convention,
   YYYYMMDD_HHMM_{slug}.jpg, so a NAS folder sorts chronologically by itself.

   Provenance: agent-organized photos carry the §7 shape with source_kind
   'camera_roll' (a new enum value — see report). Low-confidence matches land
   status 'proposed', exactly like docs; confirm/reject reuses that machinery.
   ========================================================================== */
var PH_EDIT_ROLES = { admin: 1, manager: 1, pm: 1 };   /* curation: picks + captions */
function canEditPhoto(f) { return !!PH_EDIT_ROLES[CURRENT_USER.role] || f.uploaded_by === ME; }

/* ---- deterministic placeholder art (stands in for the NAS thumbnail) ----- */
function _phHash(s) {
  var h = 2166136261 >>> 0;
  s = String(s);
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/* duotones tuned to event photography — dark venue base, mid wash, one glow */
var PH_DUOS = [
  ['#07161F', '#0E3B54', '#35E0A1'],   /* arena night · LED green */
  ['#0B1026', '#232B5C', '#59A9F0'],   /* broadcast blue */
  ['#1C0E2E', '#42206B', '#B98CF0'],   /* stage violet */
  ['#20130A', '#54350F', '#F4B740'],   /* tungsten amber */
  ['#081C15', '#14532D', '#8ED14A'],   /* field green */
  ['#230B18', '#5C1E42', '#E36FBE'],   /* magenta wash */
  ['#0A1F1E', '#125B57', '#4ADEDE'],   /* cyan glow */
  ['#26100C', '#6B2A1B', '#F08C59']    /* sodium vapor */
];
/* mkThumb(seed, label?, aspectRatio?) -> data-URI SVG. Deterministic per seed
   (same seed = same art), varied by hash: duotone, gradient cast, and one of
   four motifs — LED-wall band · aperture · crop-hint · horizon glow. */
function mkThumb(seed, label, ar) {
  ar = ar || 1.5;
  var h = _phHash(seed);
  var duo = PH_DUOS[h % PH_DUOS.length];
  var W = 320, H = Math.max(120, Math.round(W / ar));
  /* unsigned shifts + a golden-ratio remix — similar seed prefixes must not
     collapse onto one motif (and >> would go signed-negative on high hashes) */
  var m2 = Math.imul(h, 2654435761) >>> 0;
  var motif = (m2 >>> 28) % 4, gx = (h >>> 5) % 2;
  var s = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '">'];
  s.push('<defs><linearGradient id="g" x1="0" y1="0" x2="' + (gx ? '1' : '.25') + '" y2="1">' +
    '<stop offset="0" stop-color="' + duo[0] + '"/><stop offset=".55" stop-color="' + duo[1] + '"/>' +
    '<stop offset="1" stop-color="' + duo[0] + '"/></linearGradient>' +
    '<radialGradient id="v" cx=".5" cy=".42" r=".95">' +
    '<stop offset=".55" stop-color="' + duo[0] + '" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="#040806" stop-opacity=".55"/></radialGradient></defs>');
  s.push('<rect width="' + W + '" height="' + H + '" fill="url(#g)"/>');
  if (motif === 0) {
    /* LED-wall band — a glowing run of cabinets with a floor reflection */
    var by = Math.round(H * 0.48), bh = Math.max(18, Math.round(H * 0.24)), cw = (W - 32) / 12;
    s.push('<rect x="14" y="' + by + '" width="' + (W - 28) + '" height="' + bh + '" rx="2" fill="' + duo[2] + '" opacity=".18"/>');
    for (var c = 0; c < 12; c++) {
      var o = (25 + (((h >>> (c % 11)) & 7) * 9)) / 100;
      s.push('<rect x="' + Math.round(16 + c * cw) + '" y="' + (by + 3) + '" width="' + Math.round(cw - 4) + '" height="' + (bh - 6) + '" fill="' + duo[2] + '" opacity="' + o + '"/>');
    }
    s.push('<rect x="14" y="' + (by + bh + 4) + '" width="' + (W - 28) + '" height="' + Math.round(bh * 0.5) + '" fill="' + duo[2] + '" opacity=".07"/>');
  } else if (motif === 1) {
    /* aperture — off-center focus rings + a hot focal dot */
    var cx = Math.round(W * (0.3 + ((h >>> 7) % 40) / 100)), cy = Math.round(H * 0.44), r = Math.round(Math.min(W, H) * 0.21);
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + duo[2] + '" stroke-width="1.5" opacity=".45"/>');
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + Math.round(r * 0.55) + '" fill="none" stroke="' + duo[2] + '" stroke-width="1" opacity=".7"/>');
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + Math.max(3, Math.round(r * 0.12)) + '" fill="' + duo[2] + '" opacity=".9"/>');
    s.push('<path d="M' + (cx - r - 8) + ' ' + cy + 'h6M' + (cx + r + 2) + ' ' + cy + 'h6M' + cx + ' ' + (cy - r - 8) + 'v6M' + cx + ' ' + (cy + r + 2) + 'v6" stroke="' + duo[2] + '" stroke-width="1" opacity=".4"/>');
    s.push('<circle cx="' + ((h >>> 9) % W) + '" cy="' + Math.round(H * 0.78) + '" r="7" fill="' + duo[2] + '" opacity=".12"/>');
  } else if (motif === 2) {
    /* crop-hint — corner marks, faint thirds, subject dot on a thirds cross */
    var m = 12, L = 16, t3w = Math.round(W / 3), t3h = Math.round(H / 3);
    s.push('<path d="M' + t3w + ' 0v' + H + 'M' + (t3w * 2) + ' 0v' + H + 'M0 ' + t3h + 'h' + W + 'M0 ' + (t3h * 2) + 'h' + W + '" stroke="#FFFFFF" stroke-width="1" opacity=".06"/>');
    s.push('<path d="M' + m + ' ' + (m + L) + 'V' + m + 'h' + L + 'M' + (W - m - L) + ' ' + m + 'h' + L + 'v' + L +
      'M' + (W - m) + ' ' + (H - m - L) + 'v' + L + 'h-' + L + 'M' + (m + L) + ' ' + (H - m) + 'h-' + L + 'v-' + L +
      '" fill="none" stroke="' + duo[2] + '" stroke-width="1.5" opacity=".55"/>');
    s.push('<circle cx="' + (t3w * 2) + '" cy="' + t3h + '" r="10" fill="' + duo[2] + '" opacity=".2"/>');
    s.push('<circle cx="' + (t3w * 2) + '" cy="' + t3h + '" r="4.5" fill="' + duo[2] + '" opacity=".85"/>');
  } else {
    /* horizon glow — stage line low in frame, bokeh above, camera glyph */
    var hy = Math.round(H * 0.64);
    s.push('<rect x="0" y="' + (hy - 1) + '" width="' + W + '" height="3" fill="' + duo[2] + '" opacity=".7"/>');
    s.push('<rect x="0" y="' + (hy + 2) + '" width="' + W + '" height="' + Math.round(H * 0.16) + '" fill="' + duo[2] + '" opacity=".1"/>');
    for (var b2 = 0; b2 < 4; b2++) {
      s.push('<circle cx="' + ((h >>> (2 * b2 + 1)) % W) + '" cy="' + (8 + ((h >>> (b2 + 3)) % Math.max(10, hy - 22))) +
        '" r="' + (3 + ((h >>> b2) % 6)) + '" fill="' + duo[2] + '" opacity=".' + (12 + ((h >>> b2) % 3) * 6) + '"/>');
    }
    s.push('<g stroke="#FFFFFF" opacity=".3" fill="none" stroke-width="1.4">' +
      '<rect x="' + (W - 40) + '" y="' + (H - 30) + '" width="24" height="17" rx="3"/>' +
      '<circle cx="' + (W - 28) + '" cy="' + (H - 21.5) + '" r="4.5"/></g>');
  }
  s.push('<rect width="' + W + '" height="' + H + '" fill="url(#v)"/>');
  if (label) s.push('<text x="11" y="' + (H - 9) + '" font-family="monospace" font-size="9" fill="#EAF0ED" opacity=".4" letter-spacing="2">' + label + '</text>');
  s.push('</svg>');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.join(''));
}

/* ---- pure reads (mirror the finance helpers' style) ----------------------- */
function photosForShow(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  var out = ((s && s.files) || []).filter(function (f) { return f.kind === 'photo'; });
  out.sort(function (a, b) { return a.taken_at < b.taken_at ? -1 : a.taken_at > b.taken_at ? 1 : a.id - b.id; });
  return out;
}
function photoCount(showId) { return photosForShow(showId).length; }
function photoDays(showId) {
  var days = [], seen = {};
  photosForShow(showId).forEach(function (f) {
    var d = String(f.taken_at || '').slice(0, 10);
    if (d && !seen[d]) { seen[d] = 1; days.push(d); }
  });
  return days;
}
function photoTagCounts(photos) {
  var n = {}, out = [];
  photos.forEach(function (f) { (f.tags || []).forEach(function (t) { n[t] = (n[t] || 0) + 1; }); });
  Object.keys(n).forEach(function (t) { out.push({ tag: t, n: n[t] }); });
  out.sort(function (a, b) { return b.n - a.n || (a.tag < b.tag ? -1 : 1); });
  return out;
}
/* the recap pass consumes exactly this list: picks first, newest fill */
function recapStripPhotos(showId, cap) {
  var all = photosForShow(showId).filter(function (f) { return f.status !== 'proposed'; });
  var picks = all.filter(function (f) { return f.recap_pick; });
  var rest = all.filter(function (f) { return !f.recap_pick; }).reverse();
  return picks.concat(rest).slice(0, cap || 5);
}

/* ============================================================================
   PHOTO SEED — AVCA rich (the show story), Madison install, Marlins wraps.
   Runs post-hydration, so rows register the way api.addFile does.
   ========================================================================== */
(function seedPhotos() {
  function nasPhotoPath(s, filename) {
    var p = PROJECTS_BY_ID[s.project_id];
    return '\\\\e360-nas\\showrunner\\P' + p.id + '-' + p.slug + '\\S' + s.id + '-' + s.slug + '\\photo\\' + filename;
  }
  /* mkPhoto(show, {d(ISO day), hm, slug, cap, tags, by(shot), agent, conf,
                    w, h, size, status, pick}) */
  function mkPhoto(s, o) {
    var base = o.d.replace(/-/g, '') + '_' + o.hm.replace(':', '') + '_' + o.slug;
    var f = mkFile({
      name: base, ext: 'jpg', kind: 'photo',
      size: o.size || (2800000 + (_phHash(base) % 2400000)),
      dim: o.w + ' x ' + o.h,
      by: o.agent || o.by || 'tandres', off: 0,
      meta: o.status === 'proposed' ? 'awaiting review' : 'organized by agent',
      status: o.status || 'filed',
      provenance: o.agent ? {
        source_kind: 'camera_roll',
        source_ref: 'photos:' + (o.agent || 'x') + '/IMG_' + (4000 + (_phHash(base) % 800)),
        source_label: 'Camera roll sync — ' + (ROSTER[o.agent] ? ROSTER[o.agent].name.split(' ')[0] : o.agent) + '’s phone',
        agent_user: o.agent, confidence: o.conf
      } : null
    });
    if (!o.agent) f.meta = 'uploaded by ' + (ROSTER[o.by] ? ROSTER[o.by].name.split(' ')[0] : o.by);
    f.show_id = s.id; f.project_id = s.project_id;
    f.created_at = o.d;
    f.taken_at = o.d + 'T' + o.hm;
    f.width = o.w; f.height = o.h;
    f.caption = o.cap; f.tags = o.tags.slice();
    f.shot_by = o.by || null;
    f.recap_pick = !!o.pick;
    f.nas_path = nasPhotoPath(s, base + '.jpg');
    f.thumb = mkThumb(base, 'IMG_' + (4000 + (_phHash(base) % 800)), o.w / o.h);
    FILES_BY_ID[f.id] = f;
    s.files.push(f);
    return f;
  }
  var LS = 4032, SS = 3024;                    /* phone landscape / short side */
  var S_AVCA = SHOWS_BY_ID[1], S_MARL = SHOWS_BY_ID[2], S_MAD = SHOWS_BY_ID[3];

  /* ---- AVCA First Serve — 14 photos across 4 days (the full show arc) ---- */
  var aSite = dayISO(-27), aLI = S_AVCA.load_in_date, aSH = S_AVCA.event_date, aST = S_AVCA.strike_date;
  mkPhoto(S_AVCA, { d: aSite, hm: '10:24', slug: 'operator-position-scout', w: LS, h: SS,
    cap: 'Operator position from section 214 — fiber path down to the court scouted', tags: ['venue', 'wide'], by: 'bsawyer', agent: 'bsawyer', conf: 91 });
  mkPhoto(S_AVCA, { d: aSite, hm: '10:51', slug: 'power-vault-tie-in', w: LS, h: SS,
    cap: 'House power vault — no feeder on site, tie-in point documented for the union call', tags: ['venue', 'power', 'detail'], by: 'tandres', agent: 'tandres', conf: 95 });
  mkPhoto(S_AVCA, { d: aLI, hm: '06:12', slug: 'dock-4-trucks', w: LS, h: SS,
    cap: 'Dock 4 opens — trucks marshalled off Juneau in the dark', tags: ['load-in', 'dock'], by: 'dvargas', agent: 'dvargas', conf: 93 });
  mkPhoto(S_AVCA, { d: aLI, hm: '08:47', slug: 'courtside-run-build', w: LS, h: SS, pick: true,
    cap: 'Courtside run going up — first 24 cabinets set', tags: ['load-in', 'rig'], by: 'tandres', agent: 'tandres', conf: 96 });
  mkPhoto(S_AVCA, { d: aLI, hm: '13:38', slug: 'feeder-pull', w: SS, h: LS,
    cap: '200ft of cam-lok to the vault — the feeder story, solved', tags: ['power', 'detail'], by: 'tandres', agent: 'tandres', conf: 95 });
  mkPhoto(S_AVCA, { d: aLI, hm: '15:04', slug: 'bolt6-nest', w: LS, h: SS,
    cap: "Bolt6 operator's nest above 214 — fiber landed and labeled", tags: ['detail', 'content'], by: 'bsawyer', agent: 'bsawyer', conf: 92 });
  mkPhoto(S_AVCA, { d: aLI, hm: '17:21', slug: 'first-pixel-out', w: 5568, h: 3132, pick: true,
    cap: 'First pixel-out — both zones alive for the first time', tags: ['led-wall', 'rig'], by: 'tandres', agent: 'tandres', conf: 97 });
  mkPhoto(S_AVCA, { d: aSH, hm: '10:15', slug: 'stat-overlay-rehearsal', w: 5568, h: 3132,
    cap: 'Serve-speed overlay rehearsal — Bolt6 feed live on the perimeter', tags: ['content', 'led-wall'], by: 'tandres', agent: 'tandres', conf: 94 });
  mkPhoto(S_AVCA, { d: aSH, hm: '17:38', slug: 'bowl-fills', w: LS, h: SS, pick: true,
    cap: 'Doors — the bowl filling with the perimeter on idle loop', tags: ['venue', 'wide', 'crowd'], by: 'bsawyer', agent: 'bsawyer', conf: 93 });
  mkPhoto(S_AVCA, { d: aSH, hm: '19:24', slug: 'match-point-wall', w: 5568, h: 3132, pick: true,
    cap: 'Match point on the courtside wall — sponsor loop holding through the rally', tags: ['led-wall', 'show'], by: 'aramos', agent: 'aramos', conf: 95 });
  mkPhoto(S_AVCA, { d: aSH, hm: '19:58', slug: 'crowd-glow', w: LS, h: SS, pick: true,
    cap: 'Crowd on its feet in the perimeter glow', tags: ['crowd', 'show'], by: 'tandres', agent: 'tandres', conf: 92 });
  mkPhoto(S_AVCA, { d: aST, hm: '09:12', slug: 'strike-cases-staged', w: LS, h: SS,
    cap: 'Strike — cases labeled and staged for the dock', tags: ['strike', 'dock'], by: 'dvargas', agent: 'dvargas', conf: 91 });
  /* two the agent was NOT sure about -> proposed, same machinery as docs */
  mkPhoto(S_AVCA, { d: aSH, hm: '18:02', slug: 'concourse-ribbon', w: LS, h: SS, status: 'proposed',
    cap: 'Concourse ribbon — might be the house Daktronics system, not ours', tags: ['venue'], by: 'tandres', agent: 'tandres', conf: 58 });
  mkPhoto(S_AVCA, { d: aST, hm: '08:41', slug: 'loadout-corridor', w: SS, h: LS, status: 'proposed',
    cap: 'Back corridor during load-out — venue unclear from the roll', tags: ['strike'], by: null, agent: 'tandres', conf: 71 });
  S_AVCA.activity.unshift(mkAct('agent:tandres', 'organized 14 event photos into the folder',
    'camera-roll sync · 4 phones · 2 proposed for review', 12, '22:12', true));

  /* ---- LOVB Madison — 6 install-in-progress photos (load-in day) --------- */
  var mLI = S_MAD.load_in_date;
  mkPhoto(S_MAD, { d: mLI, hm: '04:52', slug: 'truck-22-departs', w: LS, h: SS,
    cap: 'Truck 22 out of the shop — kit plus the O’Neill distro aboard', tags: ['truck', 'load-in'], by: 'dvargas', agent: 'dvargas', conf: 94 });
  mkPhoto(S_MAD, { d: mLI, hm: '07:44', slug: 'regent-st-dock', w: LS, h: SS,
    cap: 'Case push inside the Regent St dock window — hard stop at 11', tags: ['load-in', 'dock'], by: 'bsawyer', agent: 'bsawyer', conf: 93 });
  mkPhoto(S_MAD, { d: mLI, hm: '09:58', slug: 'ground-support-build', w: LS, h: SS, pick: true,
    cap: 'Ground support at half height — court-side kit taking shape', tags: ['rig'], by: 'aramos', agent: 'aramos', conf: 94 });
  mkPhoto(S_MAD, { d: mLI, hm: '13:26', slug: 'field-house-tie-in', w: LS, h: SS,
    cap: 'Field House tie-in — O’Neill distro landed, same story as Fiserv', tags: ['power', 'detail'], by: 'tandres', agent: 'tandres', conf: 96 });
  mkPhoto(S_MAD, { d: mLI, hm: '15:49', slug: 'fiber-to-court', w: SS, h: LS,
    cap: 'Fiber pull to the operator position', tags: ['detail'], by: 'aramos', agent: 'aramos', conf: 92 });
  /* hostile caption from outside the roster — the esc() audit case */
  mkPhoto(S_MAD, { d: mLI, hm: '17:52', slug: 'pixel-out-color', w: 5568, h: 3132,
    cap: 'Pixel-out <img src=x onerror=alert(1)> courtesy of venue ops', tags: ['rig', 'led-wall'], by: null, agent: 'tandres', conf: 88 });
  S_MAD.activity.unshift(mkAct('agent:tandres', 'organized 6 install photos into the folder',
    'camera-roll sync · load-in day', 115, '21:40', true));

  /* ---- Marlins wraps — 4 install photos (feed the client walk story) ----- */
  var wIN = S_MARL.load_in_date;
  mkPhoto(S_MARL, { d: wIN, hm: '06:34', slug: 'crates-dock-c', w: LS, h: SS,
    cap: 'Crates staged by rail section at dock C', tags: ['load-in', 'dock'], by: 'aramos', agent: 'aramos', conf: 93 });
  mkPhoto(S_MARL, { d: wIN, hm: '09:18', slug: 'panels-1-7-hung', w: 5568, h: 3132, pick: true,
    cap: 'Panels 1–7 hung — the blue reading true to PMS 298', tags: ['install', 'print'], by: 'aramos', agent: 'aramos', conf: 95 });
  mkPhoto(S_MARL, { d: wIN, hm: '15:07', slug: 'client-walk', w: 6000, h: 4000,
    cap: 'Client walk — sign-off panel by panel down the rail', tags: ['install', 'client'], by: 'lfarkos' });
  mkPhoto(S_MARL, { d: wIN, hm: '15:31', slug: 'dugout-rail-done', w: 6000, h: 4000, pick: true,
    cap: 'Dugout rail and on-deck circle in place', tags: ['install', 'print'], by: 'lfarkos' });
  S_MARL.activity.unshift(mkAct('agent:aramos', 'filed the install photo set',
    'camera-roll sync · 2 uploaded by Larry on the client walk', 8, '17:05', true));
})();

/* ============================================================================
   POST-EVENT CLIENT RECAP — deliverables  (recap pass)
   ----------------------------------------------------------------------------
   The post-strike closeout artifact (TEAM_FEEDBACK "Deliverables & onsite"):
   the show owner's agent drafts a client recap out of the event folder's own
   record — what happened, the highlights, the show stats — carrying the photos
   a human already starred as recap picks. DRAFT-FIRST is the whole point: an
   agent drafts, a human edits, a human approves, and only then can it be
   marked sent.

   NOTHING HERE SENDS ANYTHING. AGENT_API §9 is absolute — "file, don't fire".
   `markSent` is a MOCK that records who a human said they sent it to; no
   outbound path exists anywhere in this app, for agents or for people.

   deliverables : {id, project_id, show_id, kind 'recap' (extensible —
                  call_sheet · photo_set later), status 'draft'|'approved'|
                  'sent', body, generated_by ('agent:<username>' | username),
                  generated_at, edited_by/edited_at, approved_by/approved_at,
                  sent_at/sent_to, provenance}
   body         : {headline, narrative [2-3 paragraphs], highlights [strings],
                  stats [{label, value}], photo_ids [file ids — recap picks,
                  reorderable], closing}

   ---- THE CLIENT-FACING CONTENT FIREWALL -----------------------------------
   A recap is the one artifact in this app that LEAVES the building, so the
   leak guard is a CODE-LEVEL PROPERTY, not an editorial hope. Two layers:

   A · ONE SOURCE FUNCTION. recapFacts(show) is the only reader the generator
       has, and it returns a flat bag of client-safe scalars drawn from the
       closed whitelist in RECAP_SOURCES. It never touches expenses, bookings,
       purchase orders, jobs, budget lines, notes, step notes, activity detail
       or schedule free text — none of those objects are in scope inside
       buildRecapDraft(). No money value can reach a body because no money
       value is ever read. Schedule and step data contribute STRUCTURE only
       (day count, lane completion, the four canonical times) — never prose.
   B · ONE TEXT GATE. recapUnsafe() runs over every string that enters a body,
       generated or hand-typed. The generator DROPS a line that trips it; the
       api's updateRecap() REJECTS the edit and names what tripped it. So a
       human who pastes a dollar figure into the narrative is stopped too.

   Layer A means a leak needs a new source read; layer B means it needs that
   AND to slip past the vocabulary gate. Both are asserted in harness-recap.js
   against the real seeded internals (freight amounts, vendor names, job
   numbers, margins).
   ========================================================================== */

/* the closed list of fields recapFacts() may read — the firewall's layer A.
   Adding a field here is the deliberate act of widening the client surface. */
var RECAP_SOURCES = {
  /* F4 WIDENS THIS ROW, DELIBERATELY (mirrors lib/firewall.js). The seven
     scope_* fields describe what the client bought — linear feet, cabinet
     count, cabinet type, pitch, print pieces, square footage. Client-safe by
     the only test that matters: none can be turned into a cost, a rate or a
     margin, and the client already has them in the proposal they signed.
     scope_verified_by / scope_verified_at are NOT here — who checked our
     numbers internally is nobody's business but ours. */
  show:            ['name', 'venue', 'city', 'type', 'owner', 'on_site_poc', 'cabinets',
                    'event_date', 'load_in_date', 'strike_date',
                    'load_in_time', 'doors_time', 'event_time', 'strike_time', 'client_poc',
                    'scope_kind', 'scope_linear_feet', 'scope_cabinet_count',
                    'scope_cabinet_type', 'scope_pitch', 'scope_print_pieces',
                    'scope_print_sqft'],
  project:         ['name', 'client', 'type'],
  step:            ['lane', 'status'],              /* structure only — never title/notes */
  schedule_item:   ['day', 'kind'],                 /* structure only — never title/detail */
  crew_assignment: [],                              /* COUNT only — no names, travel or phones */
  photo:           ['id', 'caption', 'taken_at', 'recap_pick', 'status']
};

/* ── LAYER A′ · THE TABLE GUARD (F2) ────────────────────────────────────────
   RECAP_SOURCES says which FIELDS the generator may read; this says which
   COLLECTIONS it may not touch at all. The tech show report is why it exists:
   reports are internal, blunt and often unflattering, and TEAM_FEEDBACK is
   explicit that "the recap content firewall must never read report bodies".

   In demo mode there is no SQL to intercept, so the enforcement is structural
   and asserted: TECH_REPORTS is a separate store that recapFacts() does not
   name, and the harness proves it by planting a poisoned report body and
   checking it reaches no recap. The server-side twin (lib/firewall.js
   guardRecapQuery) throws on any SQL that so much as names one of these. */
var RECAP_FORBIDDEN_STORES = ['TECH_REPORTS', 'NOTIF_OUTBOX', 'ALL_EXPENSES', 'ALL_POS',
                              'BUDGET_LINES', 'ALL_NOTES', 'ALL_JOBS'];

/* the vocabulary gate — the firewall's layer B */
var RECAP_FORBIDDEN = [
  { re: /\$\s*[\d.,]/,                                                          why: 'a dollar amount' },
  { re: /\b(?:margin|profit|markup|cogs|overhead|underwater|capex)\b/i,         why: 'internal financial language' },
  { re: /\b(?:budget|invoice|receipt|expense|vendor|purchase order|payable|reconcile[ds]?)\b/i, why: 'internal accounting language' },
  { re: /\bpo-\d|\b\d{2}-\d{3,4}\b|\bquickbooks\b|\bqb\b/i,                     why: 'an internal job or purchase-order number' },
  { re: /\b(?:at risk|blocked|over budget|waiting on me|behind schedule)\b/i,   why: 'internal status language' }
];
/* -> null when the text is client-safe, else {why, match} */
function recapUnsafe(text) {
  var s = String(text == null ? '' : text);
  for (var i = 0; i < RECAP_FORBIDDEN.length; i++) {
    var m = RECAP_FORBIDDEN[i].re.exec(s);
    if (m) return { why: RECAP_FORBIDDEN[i].why, match: m[0] };
  }
  return null;
}
/* generator-side: keep it or drop it, silently — a draft never ships a leak */
function recapSafe(text) {
  var t = String(text == null ? '' : text).trim();
  return (t && !recapUnsafe(t)) ? t : null;
}
function _rcPush(arr, text) { var t = recapSafe(text); if (t) arr.push(t); return arr; }

/* ---------------- vocabulary + tiny local formatters ---------------------- */
var DELIVERABLE_KINDS = { recap: 'Client recap' };   /* extension point */
var RECAP_STATUSES = ['draft', 'approved', 'sent'];
var RECAP_STATUS = {
  draft:    { label: 'Draft — awaiting review', short: 'draft',    pill: 'warn' },
  approved: { label: 'Approved',                short: 'approved', pill: 'go' },
  sent:     { label: 'Sent to client',          short: 'sent',     pill: 'idle' }
};
/* who may draft/edit a recap · who may approve or reopen one */
var RECAP_EDIT_ROLES = { admin: 1, manager: 1, pm: 1 };
var RECAP_APPROVE_ROLES = { admin: 1, manager: 1 };
/* Edit rights on the FOLDER a show belongs to. Mirrors the backend's
   canEditProject() (lib/auth.js) exactly: manager+ anywhere, a pm only on a
   project they own, nobody below that. Two of the three pm+ gates compose this
   with their rank check and one deliberately does not — see canEditSchedule /
   canEditRecap / PH_EDIT_ROLES.

   With no show in hand it answers on RANK ALONE. That is the permissive
   fallback on purpose: the server is the gate, this is only what the UI
   offers, and a caller that cannot name a folder cannot evaluate ownership. */
function canEditFolderOf(show, user) {
  if (!show) return canEditFolder(null, user);
  return canEditFolder(show.project || PROJECTS_BY_ID[show.project_id], user);
}
/* The SAME predicate, given the folder directly — which is what the folder
   header has in hand and the show header does not. canEditFolderOf() now
   delegates to it, the way canApprovePOs() delegates to canSeeFinance(): one
   decision, one expression, two entry points. */
function canEditFolder(project, user) {
  var u = user || CURRENT_USER;
  if (!u) return false;
  if (u.role === 'admin' || u.role === 'manager') return true;
  if (u.role !== 'pm') return false;
  if (!project) return true;                    /* rank alone — see above */
  return project.owner === u.username;
}
/* WHO MAY TAKE A FILE BACK OFF THE RECORD.
   The mirror of the gate on `DELETE /api/files/:id` (routes/files.js), which is
   itself the same sentence as PUT /files/:id and PUT /files/:id/content:

       the UPLOADER, or anyone who can edit the folder (pm-owner / manager+).

   The uploader term is the one that matters in practice. The person who files
   the wrong document is the person who notices, usually within the minute, and
   before this they had to go and find a manager. Show-not-in-hand falls back to
   canEditFolderOf's permissive rank-alone answer for the same reason it does
   there: the server is the gate, this only decides what to offer. */
function canDeleteFile(f, show) {
  if (!f) return false;
  if (f.uploaded_by && CURRENT_USER && f.uploaded_by === CURRENT_USER.username) return true;
  return canEditFolderOf(show || SHOWS_BY_ID[f.show_id]);
}
/* pm+ AND the SHOW-owner predicate — matches assertCanDraft() server-side,
   which composes roleRank >= pm with canApproveRecap (manager+ OR show.owner).

   RESOLVED (2026-08-27): "who owns a closeout" is the SHOW's owner, not the
   folder's, and drafting now uses the SAME predicate as approving — so the old
   inversion (approve allowed, draft refused) is gone by construction. Note this
   is deliberately a DIFFERENT owner from canEditSchedule(), which stays keyed
   to the folder via canEditFolderOf(): a schedule belongs to the folder's pm, a
   closeout to the show's owner. Two questions, two answers, on purpose.

   No show in hand -> rank alone, the same permissive fallback as
   canEditFolderOf: the server is the gate, this only decides what to offer.

   SETTLED — HARDENING 14 (2026-08-27). The pm+ floor that used to live ONLY
   here now lives inside canApproveRecapFor() as well, mirroring the server's
   canApproveRecap(). Before that, a tech who owned a show was offered Approve
   and denied Generate — the dead-button problem in reverse. The
   RECAP_EDIT_ROLES check below is therefore no longer the only thing enforcing
   the floor; it stays because it is also the answer when there is NO show in
   hand, where ownership cannot be evaluated at all. */
function canEditRecap(show) {
  if (!RECAP_EDIT_ROLES[CURRENT_USER.role]) return false;
  return show ? canApproveRecapFor(show, ME) : true;
}
/* manager+ OR the show's own owner — one predicate, reused by the Approve
   button AND by the bell's awaiting-review row ("you see what you can act on") */
/* THE closeout-ownership predicate: manager+ anywhere, otherwise the SHOW's own
   owner. Mirrors the server's canApproveRecap() (lib/auth.js) exactly.

   canEditRecap() composes this with the pm+ rank check, which is what makes
   drafting and approving agree — for a while they did not, and a pm could
   approve a recap he was forbidden to write (approving being the higher-
   privilege act, the ordering was backwards). That is settled: one predicate,
   both paths. Do not re-split them. Deliberately NOT the same owner as
   canEditSchedule(), which keys to the folder — see canEditRecap().

   HARDENING 14: the pm+ floor is INSIDE the owner branch, matching the server's
   canApproveRecap(). Tom's rule reads "the show's owner + managers/admins", and
   the floor makes "owner" mean a pm+ owner — a tech handed a show does not
   inherit sign-off on what goes to the client; manager/admin cover it. Reverse
   it by deleting the RECAP_EDIT_ROLES line below AND the matching line in
   lib/auth.js. manager+ still passes on rank alone, so this is a floor under
   the owner branch, not a wall in front of everyone. */
function canApproveRecapFor(show, username) {
  var u = ROSTER[username];
  if (!u || !show) return false;
  if (RECAP_APPROVE_ROLES[u.role]) return true;
  if (!RECAP_EDIT_ROLES[u.role]) return false;
  return show.owner === username;
}
function canApproveRecap(show) { return canApproveRecapFor(show, ME); }

var RECAP_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
function _rcDateLong(iso) {
  var d = iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00') : null;
  return (!d || isNaN(d)) ? '' : RECAP_MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}
function _rcHM(hm) {
  if (!hm) return '';
  var p = String(hm).split(':'), h = Number(p[0]), m = p[1] || '00';
  if (isNaN(h)) return String(hm);
  return (h % 12 || 12) + ':' + m + (h >= 12 ? ' pm' : ' am');
}

/* ---------------- store ---------------------------------------------------- */
var _delivSeq = 0;
var ALL_DELIVERABLES = [], DELIVERABLES_BY_ID = {};

function recapProvenance(show, agentUser, confidence) {
  /* source_kind 'closeout' is a new enum value alongside email|meeting|chat|
     manual|camera_roll — the source IS the show's own record (see report). */
  return { source_kind: 'closeout',
           source_ref: 'showrunner:show/' + show.id + '#recap',
           source_label: 'Post-strike closeout — ' + _noteShowLabel(show),
           agent_user: agentUser, confidence: confidence == null ? 100 : confidence,
           matched_by: ['show_record'], matched_at: TODAY_ISO };
}
function mkDeliverable(show, body, x) {
  x = x || {};
  var owner = x.owner || show.owner;
  var d = { id: ++_delivSeq, project_id: show.project_id, show_id: show.id,
            kind: x.kind || 'recap', status: 'draft', body: body,
            generated_by: x.by || ('agent:' + owner),
            generated_at: (x.off == null ? TODAY_ISO : dayISO(x.off)) + 'T' + (x.time || '09:00'),
            edited_by: null, edited_at: null,
            approved_by: null, approved_at: null,
            sent_at: null, sent_to: null,
            provenance: x.provenance || recapProvenance(show, owner, x.confidence) };
  ALL_DELIVERABLES.push(d); DELIVERABLES_BY_ID[d.id] = d;
  return d;
}

/* ---------------- pure reads (mirror the finance / photo helpers) ---------- */
function deliverablesForShow(showId) {
  return ALL_DELIVERABLES.filter(function (d) { return d.show_id === Number(showId); });
}
function recapForShow(showId) {
  var hit = null;
  ALL_DELIVERABLES.forEach(function (d) { if (d.show_id === Number(showId) && d.kind === 'recap') hit = d; });
  return hit;
}
function recapPhotos(rec) {
  if (!rec || !rec.body) return [];
  return (rec.body.photo_ids || []).map(function (id) { return FILES_BY_ID[id] || null; })
    .filter(function (f) { return f && f.kind === 'photo'; });
}
/* filed photos on the show that this recap is NOT currently carrying — the
   "add it back" affordance, so removing a photo is never one-way */
function recapPhotoPool(rec, showId) {
  var inSet = {};
  ((rec && rec.body && rec.body.photo_ids) || []).forEach(function (id) { inSet[id] = 1; });
  return photosForShow(showId).filter(function (f) { return f.status !== 'proposed' && !inSet[f.id]; });
}
/* draft recaps this person is the one to act on (same predicate as Approve) */
function recapsAwaitingReview(username) {
  var out = [];
  ALL_DELIVERABLES.forEach(function (d) {
    if (d.kind !== 'recap' || d.status !== 'draft') return;
    var s = SHOWS_BY_ID[d.show_id];
    if (s && canApproveRecapFor(s, username)) out.push(d);
  });
  out.sort(function (a, b) { return a.generated_at < b.generated_at ? 1 : a.generated_at > b.generated_at ? -1 : b.id - a.id; });
  return out;
}

/* ============================================================================
   recapFacts(show) — THE ONLY READER buildRecapDraft() HAS (firewall layer A)
   Everything it returns is client-safe by construction. Nothing it reads is
   free text authored for internal eyes.
   ========================================================================== */
function recapFacts(show) {
  var p = PROJECTS_BY_ID[show.project_id] || {};

  /* steps -> lane completion ONLY (lane key + status; never a title or note) */
  var byLane = {}, doneN = 0, totalN = 0;
  (show.steps || []).forEach(function (st) {
    var l = byLane[st.lane] = byLane[st.lane] || { n: 0, done: 0 };
    l.n++; totalN++;
    if (normStatus(st.status) === 'done') { l.done++; doneN++; }
  });
  var lanesComplete = [];
  typeDef(show.type).lanes.forEach(function (l) {
    var x = byLane[l.key];
    if (x && x.n && x.done === x.n) lanesComplete.push(l.key);
  });

  /* schedule -> day count + which kinds ran (never a title or detail) */
  var days = scheduleDays(show.id), kinds = {};
  (show.schedule_items || []).forEach(function (it) { kinds[it.kind] = (kinds[it.kind] || 0) + 1; });

  /* photos -> the human-curated recap picks, in taken_at order */
  var picks = recapStripPhotos(show.id, 8).filter(function (f) { return f.recap_pick; });

  var poc = show.client_poc || null;
  var lead = ROSTER[show.owner] || null, site = ROSTER[show.on_site_poc] || null;
  return {
    showName: _noteShowLabel(show), venue: show.venue || '', city: show.city || '',
    client: (show.default_job_id && JOBS_BY_ID[show.default_job_id] ? JOBS_BY_ID[show.default_job_id].client : p.client) || p.client || '',
    type: show.type, typeLabel: typeLabel(show.type),
    eventDate: show.event_date, loadInDate: show.load_in_date, strikeDate: show.strike_date,
    loadInTime: show.load_in_time || null, doorsTime: show.doors_time || null,
    showTime: show.event_time || null, strikeTime: show.strike_time || null,
    cabinets: Number(show.cabinets) || 0,
    /* F4 — the scope line, client-safe by the RECAP_SOURCES.show whitelist */
    scope: scopeOf(show), scopeLine: scopeLine(show),
    crewSize: (show.crew_assignments || []).length,
    daysOnSite: days.length || _rcSpanDays(show),
    hasDoors: !!kinds.show, hasStrike: !!kinds.strike,
    lanesComplete: lanesComplete, stepsDone: doneN, stepsTotal: totalN,
    photoIds: picks.map(function (f) { return f.id; }),
    photoCaptions: picks.map(function (f) { return f.caption || ''; }),
    leadName: lead ? lead.name : '', leadTitle: lead ? lead.title : '',
    siteName: site ? site.name : '',
    clientPocName: poc ? poc.name : '', clientPocTitle: poc ? poc.title : ''
  };
}
function _rcSpanDays(show) {
  var a = show.load_in_date, b = show.strike_date || show.event_date;
  if (!a || !b) return 1;
  var d = Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  return isNaN(d) ? 1 : Math.max(1, d + 1);
}

/* client-safe phrasing for a lane that closed out complete — the ONLY way a
   lane's name reaches the client. No lane's step titles ever do. */
var RECAP_LANE_WINS = {
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

/* ============================================================================
   buildRecapDraft(show) — the agent's first pass. PURE: reads recapFacts()
   and nothing else, writes no activity, mutates nothing. Deterministic, so
   regenerating the same untouched show produces the same body (idempotency).
   ========================================================================== */
function buildRecapDraft(show) {
  var f = recapFacts(show);
  var isPrint = f.type === 'print';
  var where = f.venue + ((f.city && f.venue.indexOf(f.city) < 0) ? ', ' + f.city : '');
  var pkg = isPrint ? 'large-format print package'
    : (f.cabinets ? f.cabinets + '-cabinet ' : '') + (f.type === 'both' ? 'LED and print package' : 'LED package');

  /* ---- narrative: 2-3 paragraphs woven from the facts above -------------- */
  var narrative = [];
  var p1 = 'E360 Sport ' + (isPrint ? 'produced and installed the ' : 'delivered the ') + pkg +
    ' for ' + f.showName + ' at ' + where + '. ' +
    (f.daysOnSite > 1
      ? 'The crew was on site ' + f.daysOnSite + ' days — load-in ' + _rcDateLong(f.loadInDate) +
        ' through ' + (f.hasStrike || f.strikeDate !== f.eventDate ? 'strike ' : 'wrap ') + _rcDateLong(f.strikeDate || f.eventDate) + '.'
      : 'The crew was on site for a single day, ' + _rcDateLong(f.eventDate) + ', load-in through handover.');
  _rcPush(narrative, p1);

  var beats = [];
  if (f.loadInTime) beats.push('load-in at ' + _rcHM(f.loadInTime));
  if (f.doorsTime) beats.push('doors at ' + _rcHM(f.doorsTime));
  if (f.showTime) beats.push('first cue at ' + _rcHM(f.showTime));
  if (f.strikeTime) beats.push('strike from ' + _rcHM(f.strikeTime));
  var p2 = (isPrint ? 'The install day' : 'Show day') + ' ran to plan' +
    (beats.length ? ' — ' + beats.join(', ') + '.' : '.') +
    (f.crewSize ? ' A crew of ' + f.crewSize + ' covered the build' +
      (isPrint ? ' and the client walk.' : ', the show and the strike.') : '');
  var wins = f.lanesComplete.map(function (k) { return LANES[k] ? LANES[k].label : k; });
  if (wins.length) {
    var w = wins.slice(0, 3);
    p2 += ' ' + (w.length > 1 ? w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1] : w[0]) +
      ' closed out complete.';
  }
  _rcPush(narrative, p2);

  var p3 = (f.photoIds.length
    ? 'A selection of ' + f.photoIds.length + ' photograph' + (f.photoIds.length === 1 ? '' : 's') +
      ' from the ' + (isPrint ? 'install' : 'show') + ' is included with this recap. '
    : '') + 'The full set is archived with the event record and available on request.';
  _rcPush(narrative, p3);

  /* ---- highlights: starred photo captions first, then completed lanes ---- */
  var highlights = [];
  f.photoCaptions.slice(0, 4).forEach(function (c) { _rcPush(highlights, c); });
  f.lanesComplete.forEach(function (k) {
    if (highlights.length >= 5) return;
    _rcPush(highlights, RECAP_LANE_WINS[k]);
  });

  /* ---- stats: client-safe fields ONLY. No money value is even readable
         from here — recapFacts() never returned one. -------------------------- */
  var stats = [];
  if (f.eventDate) stats.push({ key: 'date', label: isPrint ? 'Install date' : 'Show date', value: _rcDateLong(f.eventDate) });
  /* F4 — the scope line leads when one exists: it is the single most client-
     legible fact about the job, and it is exactly what the client bought. The
     individual numbers follow, each under its own client-safe key. */
  var sc = f.scope || {};
  if (f.scopeLine) stats.push({ key: 'scope', label: 'Scope', value: f.scopeLine });
  if (_scopeNum(sc.linear_feet) !== null) stats.push({ key: 'linear_feet', label: 'Linear feet of LED', value: String(_scopeNum(sc.linear_feet)) });
  if (_scopeNum(sc.cabinet_count) !== null) stats.push({ key: 'cabinet_count', label: 'LED cabinets', value: String(_scopeNum(sc.cabinet_count)) });
  else if (f.cabinets) stats.push({ key: 'cabinets', label: 'LED cabinets', value: String(f.cabinets) });
  if (sc.pitch) stats.push({ key: 'pitch', label: 'Pixel pitch', value: String(sc.pitch) });
  if (_scopeNum(sc.print_pieces) !== null) stats.push({ key: 'print_pieces', label: 'Printed pieces', value: String(_scopeNum(sc.print_pieces)) });
  if (_scopeNum(sc.print_sqft) !== null) stats.push({ key: 'print_sqft', label: 'Square feet printed', value: String(_scopeNum(sc.print_sqft)) });
  if (f.crewSize) stats.push({ key: 'crew', label: 'Crew on site', value: String(f.crewSize) });
  if (f.daysOnSite) stats.push({ key: 'days', label: 'Days on site', value: String(f.daysOnSite) });

  return {
    headline: recapSafe(f.showName + ' — ' + (isPrint ? 'install' : 'show') + ' recap · ' + _rcDateLong(f.eventDate)) ||
              (isPrint ? 'Install recap' : 'Show recap'),
    narrative: narrative,
    highlights: highlights,
    stats: stats,
    photo_ids: f.photoIds.slice(),
    closing: recapSafe('Thank you from everyone at E360 Sport — it was a pleasure to be part of ' +
      f.showName + '. We would be glad to work with you again.') || 'Thank you from everyone at E360 Sport.'
  };
}

/* ============================================================================
   RECAP SEED — AVCA: agent-drafted, human-edited, APPROVED (the finished
   artifact). Marlins: a fresh agent DRAFT, untouched, waiting on a human —
   exactly what buildRecapDraft() emits, so the demo shows the generator's own
   voice. Madison + everything else: no recap, the empty state on purpose.
   ========================================================================== */
(function seedRecaps() {
  var S_AVCA = SHOWS_BY_ID[1], S_MARL = SHOWS_BY_ID[2];
  function photoBySlug(showId, slug) {
    var hit = null;
    photosForShow(showId).forEach(function (f) { if (f.name.indexOf(slug) > 0) hit = f; });
    return hit;
  }

  /* ---- Marlins · DRAFT straight off the generator ------------------------ */
  mkDeliverable(S_MARL, buildRecapDraft(S_MARL), { off: -1, time: '21:14' });
  S_MARL.activity.unshift(mkAct('agent:' + S_MARL.owner, 'drafted the post-event client recap',
    'from the folder’s own record · awaiting review before anything goes out', -1, '21:14', true));

  /* ---- AVCA · drafted by Tony's agent, edited by Tony, then approved ----- */
  var body = buildRecapDraft(S_AVCA);
  body.headline = 'A full bowl and a clean show — AVCA First Serve at Fiserv Forum';
  body.narrative = [
    'E360 Sport delivered the 48-cabinet courtside and perimeter LED package for AVCA First Serve at Fiserv Forum. Our crew was on site three days: load-in around the Terraflex floor, a full show day, and a clean strike the following morning.',
    'The build came up on schedule and both zones took their first pixel on load-in afternoon. Show day opened with a live rehearsal of the Bolt6 stat feed — serve speed, attack and height cut to collegiate thresholds — so the numbers were landing on the perimeter before anyone sat down. Doors at 5:30 pm, first serve at 7:00, and the courtside wall held the sponsor loop through every rally, including match point.',
    'Sync with the house system ran over HD-SDI on a shared subnet, so the big moments hit both displays together. The system went to standby after the final point, cases were labeled and staged overnight, and the truck was loaded out by mid-morning.'
  ];
  body.highlights = [
    'Both LED zones lit and color-matched on load-in day',
    'Bolt6 stat feed rehearsed live and running from first serve',
    'Sponsor loop held on the courtside wall straight through match point',
    'A full bowl at doors with the perimeter on its idle loop',
    'Clean strike — cases labeled and the truck loaded by mid-morning'
  ];
  body.stats = [
    { label: 'Show date', value: _rcDateLong(S_AVCA.event_date) },
    { label: 'LED cabinets', value: '48' },
    { label: 'Crew on site', value: '4' },
    { label: 'Days on site', value: '3' },
    { label: 'Attendance', value: '11,400' }          /* the human added this one */
  ];
  /* Tony pulled the stat-overlay rehearsal frame back in before approving —
     six photos in taken_at order, the five picks plus that one. */
  var extra = photoBySlug(1, 'stat-overlay-rehearsal');
  if (extra && body.photo_ids.indexOf(extra.id) < 0) {
    body.photo_ids.push(extra.id);
    body.photo_ids.sort(function (a, b) {
      var fa = FILES_BY_ID[a], fb = FILES_BY_ID[b];
      return fa.taken_at < fb.taken_at ? -1 : fa.taken_at > fb.taken_at ? 1 : a - b;
    });
  }
  body.closing = 'Thank you from everyone at E360 Sport — a genuine pleasure to be courtside for First Serve. Whenever the AVCA calendar firms up for next season, we would love to be there.';

  var rec = mkDeliverable(S_AVCA, body, { off: -2, time: '22:40' });
  rec.edited_by = 'tvigon'; rec.edited_at = dayISO(-2) + 'T23:05';
  rec.status = 'approved'; rec.approved_by = 'tvigon'; rec.approved_at = dayISO(-1) + 'T08:20';

  /* unshifted oldest-first so the feed reads newest-first, like every other
     seeded activity block */
  S_AVCA.activity.unshift(mkAct('agent:tvigon', 'drafted the post-event client recap',
    'from the folder’s own record · 5 recap picks', -2, '22:40', true));
  S_AVCA.activity.unshift(mkAct('tvigon', 'edited the recap draft',
    'headline, narrative, highlights + attendance', -2, '23:05'));
  S_AVCA.activity.unshift(mkAct('tvigon', 'approved the client recap',
    'locked for send — a human sends it, never the agent', -1, '08:20', true));
})();


/* ============================================================================
   F2 · TECH SHOW REPORTS
   ----------------------------------------------------------------------------
   A DEDICATED STORE, not a deliverables kind — the same call the backend makes,
   and for the same three reasons:

     1. THE FIREWALL. recapFacts() must never be able to read a report body
        (TEAM_FEEDBACK is explicit). Keeping reports out of ALL_DELIVERABLES
        makes that structural rather than a promise, and the harness proves it
        by planting a poisoned body and checking no recap can reach it.
     2. SHAPE. A report is per-PERSON and REQUIRED. Deliverables have no
        username and a draft/approved/sent lifecycle that is wrong here —
        sign-off is NOT required.
     3. NAGGING. "Who still owes theirs" is a join against the crew list, keyed
        on (show, person), which a shared kind-discriminated array cannot hold.

   Only crew with a LOGIN owe one: a local hire recorded by name has nobody to
   ask. Filing is what completes the obligation; 'reviewed' is optional pm
   bookkeeping and closeout never waits for it.
   ========================================================================== */
var TECH_REPORT_STATUSES = ['owed', 'filed', 'reviewed'];
var TECH_REPORT_STATUS = {
  owed:     { label: 'Owed',     short: 'owed',     pill: 'warn' },
  filed:    { label: 'Filed',    short: 'filed',    pill: 'go' },
  reviewed: { label: 'Reviewed', short: 'reviewed', pill: 'idle' }
};
/* pm+ sees every report on a show and may mark one reviewed; a tech sees their
   own and never anyone else's. Mirrors lib/reports.js exactly. */
var REPORT_VIEW_ALL_ROLES = { admin: 1, manager: 1, pm: 1 };
function canViewAllReports(user) {
  var u = user || CURRENT_USER;
  return !!u && !!REPORT_VIEW_ALL_ROLES[u.role];
}
function canReviewReports(user) { return canViewAllReports(user); }
function ownsReport(rep, user) {
  var u = user || CURRENT_USER;
  return !!rep && !!u && String(rep.username).toLowerCase() === String(u.username).toLowerCase();
}
function canReadReport(rep, user) { return canViewAllReports(user) || ownsReport(rep, user); }

var _reportSeq = 0;
var TECH_REPORTS = [], REPORTS_BY_ID = {};
function mkReport(show, username, roleOnSite, x) {
  x = x || {};
  var crew = (show.crew_assignments || []).filter(function (c) { return c.username === username; })[0];
  var r = { id: ++_reportSeq, show_id: show.id, project_id: show.project_id,
            username: username, crew_assignment_id: crew ? crew.id : null,
            role_on_site: roleOnSite || (crew ? crew.role_on_site : ''),
            status: x.status || 'owed', body: x.body || '', file_id: x.file_id || null,
            due_date: dayISO(x.dueOff == null ? -8 : x.dueOff),
            requested_at: dayISO(x.reqOff == null ? -11 : x.reqOff) + 'T16:40',
            filed_at: x.filedOff == null ? null : dayISO(x.filedOff) + 'T' + (x.filedTime || '09:20'),
            reviewed_by: x.reviewed_by || null,
            reviewed_at: x.reviewedOff == null ? null : dayISO(x.reviewedOff) + 'T10:00',
            last_nagged_at: x.naggedOff == null ? null : dayISO(x.naggedOff) + 'T07:00',
            nag_count: x.nag == null ? 1 : x.nag };
  TECH_REPORTS.push(r); REPORTS_BY_ID[r.id] = r;
  return r;
}
function reportsForShow(showId) {
  return TECH_REPORTS.filter(function (r) { return r.show_id === Number(showId); })
    .sort(function (a, b) { return a.username < b.username ? -1 : a.username > b.username ? 1 : 0; });
}
function reportFor(showId, username) {
  var hit = null;
  TECH_REPORTS.forEach(function (r) {
    if (r.show_id === Number(showId) && r.username === username) hit = r;
  });
  return hit;
}
/* what a person still owes, across every show — the My Tasks nag */
function reportsOwedBy(username, includeFiled) {
  return TECH_REPORTS.filter(function (r) {
    return r.username === username && (includeFiled || r.status === 'owed');
  }).sort(function (a, b) { return (a.due_date || '9999').localeCompare(b.due_date || '9999'); });
}
/* the show owner's "waiting on" line */
function reportSummary(showId) {
  var rows = reportsForShow(showId);
  var owed = rows.filter(function (r) { return r.status === 'owed'; });
  return { total: rows.length, filed: rows.length - owed.length, owed: owed.length,
           waiting_on: owed.map(function (r) { return r.username; }),
           complete: rows.length > 0 && owed.length === 0 };
}
/* the crew who owe nothing because they have no login to ask */
function reportlessCrew(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  return ((s && s.crew_assignments) || []).filter(function (c) { return !c.username; });
}

(function seedTechReports() {
  var S_BUCK = SHOWS_BY_ID[12], S_BREW = SHOWS_BY_ID[13];
  if (S_BUCK) {
    /* two in, two out — and one of the two out is TOM's, so the demo user's own
       My Tasks and bell carry a live nag from the moment the app opens. */
    mkReport(S_BUCK, 'aramos', 'LED tech', {
      status: 'filed', filedOff: -10, filedTime: '09:20',
      body: 'Clean two nights. One cabinet in the north run came up with a dead quadrant on ' +
            'first power — swapped it from the spare pack before doors, no show impact. The ' +
            'courtside dolly wheels are getting rough, worth replacing before the next arena job. ' +
            'Venue power was where they said it would be for once. 14 hours across both days.' });
    mkReport(S_BUCK, 'bsawyer', 'Show lead · on-site POC', {
      status: 'reviewed', filedOff: -9, filedTime: '18:05',
      reviewed_by: 'tvigon', reviewedOff: -8,
      body: 'Build ran an hour ahead. House AV gave us the feed early which is why. Only real ' +
            'note: the load-in dock was double-booked with catering at 08:00 and we lost twenty ' +
            'minutes waiting. Worth writing into the advance for next time. Strike was clean, ' +
            'everything back on the truck by 22:40.' });
    mkReport(S_BUCK, 'tandres', 'Systems', { status: 'owed', naggedOff: -2, nag: 3 });
    mkReport(S_BUCK, 'dvargas', 'Gear · truck + prep', { status: 'owed', naggedOff: -2, nag: 3 });
  }
  if (S_BREW) {
    mkReport(S_BREW, 'lfarkos', 'PM · client walk', {
      status: 'reviewed', reqOff: -95, dueOff: -92, filedOff: -93, reviewedOff: -90,
      reviewed_by: 'tvigon',
      body: 'Two mornings, thirty-four pieces, no rework. Client walked it before first pitch ' +
            'and signed off on the spot.' });
    mkReport(S_BREW, 'aramos', 'Install lead', {
      status: 'filed', reqOff: -95, dueOff: -92, filedOff: -94,
      body: 'Adhesive behaved once the concourse warmed up. Two panels needed a second pass on ' +
            'the seam. Nothing outstanding.' });
  }
})();

/* ============================================================================
   F3 · THE NOTIFICATION OUTBOX + per-user delivery preference
   ----------------------------------------------------------------------------
   The bell is unchanged and stays primary; this is the SECOND channel. Every
   real delivery (assignment, mention, a notify-picker pick, a report nag) ALSO
   queues here, subject to the recipient's own preference.

   PREFS store DEVIATIONS ONLY — a person who never opens Settings has no row
   and gets Tom's defaults: assignments + mentions immediately, the rest
   digested. 'off' silences the EMAIL, never the bell.

   The 'log' driver is the default and is not a stub: it records the delivery in
   the activity trail. 'graph' is the Microsoft Graph skeleton — unconfigured it
   answers a 501-shaped "mail not configured" and THE ITEM STAYS QUEUED, so the
   day the mailbox exists the backlog delivers instead of having been discarded.
   ========================================================================== */
var NOTIFY_KINDS = ['assignment', 'mention', 'notify', 'report_nag', 'digest'];
var NOTIFY_MODES = ['immediate', 'digest', 'off'];
var NOTIFY_DEFAULT_MODE = { assignment: 'immediate', mention: 'immediate',
                            notify: 'digest', report_nag: 'digest', digest: 'digest' };
var NOTIFY_KIND_LABEL = {
  assignment: 'Work assigned to me', mention: '@mentions of me',
  notify: 'Someone chose to notify me', report_nag: 'Show reports I still owe'
};
var NOTIFY_MODE_LABEL = { immediate: 'Right away', digest: 'In a digest', off: 'Bell only' };
var NOTIFY_STATUS_META = {
  queued:  { label: 'Queued',  pill: 'warn' },
  sent:    { label: 'Sent',    pill: 'go' },
  skipped: { label: 'Skipped', pill: 'idle' },
  failed:  { label: 'Failed',  pill: 'crit' }
};
/* the demo's delivery driver. 'log' matches the server default; nothing in the
   demo can reach a mail server, and it says so rather than implying otherwise. */
var MAIL_DRIVER = 'log';
var MAIL_CONFIGURED = true;

var NOTIF_PREFS = {};                    /* username -> { kind: mode } deviations */
var _notifSeq = 0;
var NOTIF_OUTBOX = [], NOTIF_BY_ID = {};

function notifyModeFor(username, kind) {
  var p = NOTIF_PREFS[username];
  if (p && p[kind] && NOTIFY_MODES.indexOf(p[kind]) >= 0) return p[kind];
  return NOTIFY_DEFAULT_MODE[kind] || 'digest';
}
function notifyPrefsFor(username) {
  var out = {};
  NOTIFY_KINDS.forEach(function (k) { out[k] = notifyModeFor(username, k); });
  return out;
}
function setNotifyPref(username, kind, mode) {
  if (NOTIFY_KINDS.indexOf(kind) < 0 || NOTIFY_MODES.indexOf(mode) < 0) return null;
  var deflt = NOTIFY_DEFAULT_MODE[kind] || 'digest';
  var p = NOTIF_PREFS[username] = NOTIF_PREFS[username] || {};
  /* writing the house default REMOVES the row, so the table stays a deviation
     list and a later change to the defaults reaches everyone with no opinion */
  if (mode === deflt) delete p[kind]; else p[kind] = mode;
  return mode;
}
function nowHM() {
  var d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function mkNotif(username, kind, subject, x) {
  x = x || {};
  var mode = x.mode || notifyModeFor(username, kind);
  var n = { id: ++_notifSeq, username: username, kind: kind,
            mode: mode === 'off' ? 'immediate' : mode,
            status: x.status || (mode === 'off' ? 'skipped' : 'queued'),
            subject: subject, body: x.body || '', link: x.link || '',
            note_id: x.note_id || null, project_id: x.project_id || null,
            show_id: x.show_id || null, actor: x.actor || '',
            driver: x.driver || null, attempts: x.attempts || 0,
            last_error: x.last_error || null,
            skipped_reason: x.skipped_reason || (mode === 'off' ? 'preference off' : null),
            queued_at: dayISO(x.off == null ? 0 : x.off) + 'T' + (x.time || '09:00'),
            sent_at: x.sentOff == null ? null : dayISO(x.sentOff) + 'T' + (x.sentTime || '09:01') };
  NOTIF_OUTBOX.push(n); NOTIF_BY_ID[n.id] = n;
  if (n.mode === 'digest' && n.status === 'queued' && n.kind !== 'digest') refreshDigestRow(username);
  return n;
}
/* "a queued digest row per user that a future scheduler flushes" — literally
   one open row per person, whose subject counts what is waiting behind it.
   HONEST TODO: nothing in this app runs on a timer. Immediate rows flush on the
   sweep; digest rows flush only when someone asks for them explicitly. A real
   daily digest needs a scheduler this app does not have and will not fake. */
function refreshDigestRow(username) {
  var n = NOTIF_OUTBOX.filter(function (o) {
    return o.username === username && o.mode === 'digest' && o.status === 'queued' && o.kind !== 'digest';
  }).length;
  var subject = 'Showrunner digest — ' + n + ' update' + (n === 1 ? '' : 's') + ' waiting';
  var row = null;
  NOTIF_OUTBOX.forEach(function (o) {
    if (o.username === username && o.kind === 'digest' && o.status === 'queued') row = row || o;
  });
  if (row) { row.subject = subject; return row; }
  return mkNotif(username, 'digest', subject, {
    mode: 'digest',
    body: 'The updates you asked to receive as a digest rather than one at a time.' });
}
function notificationsFor(username, status) {
  return NOTIF_OUTBOX.filter(function (n) {
    return n.username === username && (!status || n.status === status);
  }).slice().reverse();
}
function notifyQueuedCount(username) {
  return NOTIF_OUTBOX.filter(function (n) {
    return n.username === username && n.status === 'queued' && n.kind !== 'digest';
  }).length;
}
/* flush the immediate queue. Two rules, in order:
     1. SKIP IF READ IN-APP — a row carrying a note the person already read is
        marked skipped, not mailed. That rule lives in exactly one place.
     2. the driver — 'log' records the delivery and marks it sent. */
function flushNotifications(opts) {
  opts = opts || {};
  var counts = { considered: 0, sent: 0, skipped: 0, queued: 0, failed: 0,
                 driver: MAIL_DRIVER, configured: MAIL_CONFIGURED };
  NOTIF_OUTBOX.forEach(function (n) {
    if (n.status !== 'queued') return;
    if (!opts.digest && n.mode !== 'immediate') return;
    if (opts.username && n.username !== opts.username) return;
    counts.considered++;
    if (n.note_id && noteIsRead(n.username, n.note_id)) {
      n.status = 'skipped'; n.skipped_reason = 'read in-app';
      n.sent_at = TODAY_ISO + 'T' + nowHM(); counts.skipped++; return;
    }
    var u = ROSTER[n.username];
    if (!u || !u.email) {
      n.status = 'skipped'; n.skipped_reason = 'no email address on file';
      n.attempts++; n.sent_at = TODAY_ISO + 'T' + nowHM(); counts.skipped++; return;
    }
    if (!MAIL_CONFIGURED) { n.attempts++; n.last_error = 'mail not configured'; counts.queued++; return; }
    n.status = 'sent'; n.driver = MAIL_DRIVER; n.attempts++;
    n.sent_at = TODAY_ISO + 'T' + nowHM();
    counts.sent++;
  });
  if (opts.digest) {
    NOTIF_OUTBOX.forEach(function (n) {
      if (n.kind !== 'digest' || n.status !== 'queued') return;
      var left = NOTIF_OUTBOX.filter(function (o) {
        return o.username === n.username && o.kind !== 'digest' && o.status === 'queued';
      }).length;
      if (!left) { n.status = 'skipped'; n.skipped_reason = 'digest empty'; n.sent_at = TODAY_ISO + 'T' + nowHM(); }
    });
  }
  return counts;
}

(function seedNotifications() {
  /* every roster member gets an address so the outbox has somewhere to point.
     555-01xx phones are already the reserved fictional range; .test is the
     matching reserved TLD for mail. */
  USERS.forEach(function (u) { if (!u.email) u.email = u.username + '@e360sport.test'; });
  /* Devin runs quiet — a real deviation row, so the Settings card has something
     to show that is not the default. */
  setNotifyPref('dvargas', 'notify', 'off');
  setNotifyPref('dvargas', 'report_nag', 'immediate');

  var S_BUCK = SHOWS_BY_ID[12];
  if (S_BUCK) {
    mkNotif('tandres', 'report_nag', 'Show report required — Bucks Preseason Courtside', {
      off: -2, time: '07:00', show_id: 12, project_id: 7, actor: 'system',
      body: 'Your post-show report for Bucks Preseason Courtside has not been filed yet. ' +
            'Write it in Showrunner or upload the document you already have.',
      link: '/#show/12' });
    mkNotif('dvargas', 'report_nag', 'Show report required — Bucks Preseason Courtside', {
      off: -2, time: '07:00', show_id: 12, project_id: 7, actor: 'system',
      mode: 'immediate', status: 'sent', driver: 'log', attempts: 1,
      sentOff: -2, sentTime: '07:01',
      body: 'Your post-show report for Bucks Preseason Courtside has not been filed yet.',
      link: '/#show/12' });
  }
  mkNotif('bsawyer', 'assignment', 'Assigned to you — Confirm load-in window around Terraflex floor', {
    off: -6, time: '11:20', show_id: 1, project_id: 1, actor: 'tvigon',
    mode: 'immediate', status: 'sent', driver: 'log', attempts: 1, sentOff: -6, sentTime: '11:21',
    body: 'tvigon assigned you "Confirm load-in window around Terraflex floor" on AVCA First Serve.',
    link: '/#show/1' });
  mkNotif('candice', 'mention', 'tandres mentioned you on LOVB Madison — Match 1', {
    off: -3, time: '14:05', show_id: 3, project_id: 3, actor: 'tandres',
    mode: 'immediate', status: 'skipped', skipped_reason: 'read in-app', sentOff: -3, sentTime: '14:40',
    body: '@candice this one is still on a TEMP number — can you cut the QB job?',
    link: '/#show/3' });
  mkNotif('lfarkos', 'notify', 'Josh set the scope to Print · 18 pcs · 2,140 sq ft', {
    off: -4, time: '16:30', show_id: 2, project_id: 2, actor: 'jhawk',
    body: 'jhawk set the scope to Print · 18 pcs · 2,140 sq ft — @lfarkos',
    link: '/#show/2' });
})();

/* ============================================================================
   F6 · CLOSEOUT — machine-checked, three conditions, no flag to forget
   ----------------------------------------------------------------------------
   recap sent · every tech report filed · no OPEN money exception on this show.

   The third is deliberately the SHOW-SCOPED subset of financeExceptions():
   that scan also reports show-less rows (a PO with no show, a job still on a
   TEMP number), and a folder-wide accounting problem must not hold one city's
   show hostage.
   ========================================================================== */
var ARCHIVE_AFTER_DAYS = 60;

function showFinanceExceptions(showId) {
  return financeExceptions().filter(function (x) {
    return x.show && Number(x.show.id) === Number(showId);
  });
}
function closeoutStatus(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  var rec = recapForShow(showId);
  var rep = reportSummary(showId);
  var fin = showFinanceExceptions(showId);
  var recapSent = !!(rec && rec.status === 'sent');
  return {
    show_id: Number(showId),
    recap_sent: recapSent, recap_status: rec ? rec.status : null,
    reports_total: rep.total, reports_filed: rep.filed, reports_owed: rep.owed,
    /* a show with NO crew owes nothing and passes trivially — "nobody is still
       out", not "somebody filed something" */
    reports_complete: rep.owed === 0, waiting_on: rep.waiting_on,
    finance_exceptions: fin.length, finance_clear: fin.length === 0, exceptions: fin,
    complete: recapSent && rep.owed === 0 && fin.length === 0,
    closeout_complete_at: s ? s.closeout_complete_at : null,
    archived_at: s ? s.archived_at : null,
    archive_after_days: ARCHIVE_AFTER_DAYS
  };
}
/* stamp or CLEAR the marker. It clears again if the state regresses — reopening
   a recap or adding a late expense un-completes a closeout, and the 60-day
   clock should not keep running against paperwork that came undone. */
function syncCloseout(showId) {
  var s = SHOWS_BY_ID[Number(showId)];
  var st = closeoutStatus(showId);
  if (!s) return st;
  if (st.complete && !s.closeout_complete_at) {
    s.closeout_complete_at = TODAY_ISO + 'T' + nowHM();
    st.closeout_complete_at = s.closeout_complete_at;
    s.activity.unshift(mkAct('system', 'closeout complete',
      'recap sent · ' + st.reports_filed + '/' + st.reports_total + ' reports filed · finance clear' +
      ' — auto-archives in ' + ARCHIVE_AFTER_DAYS + ' days', 0, nowHM(), true));
  } else if (!st.complete && s.closeout_complete_at) {
    s.closeout_complete_at = null;
    st.closeout_complete_at = null;
  }
  return st;
}

/* ---- F5 · who may CONFIRM -------------------------------------------------
   "admin/PM only" (Tom), and for a pm only on a show they are responsible for.
   manager+ clears it on rank — the same cover pattern canApproveRecapFor uses;
   a pm must own the SHOW or its FOLDER. A tech or viewer never clears it.

   Deliberately a SEPARATE decision from canEditFolderOf(): confirming records
   that a client committed money, which is not the same act as editing a venue
   string, and the two should be able to diverge later without surprising
   anyone. Mirrors lib/lifecycle.js canConfirm(). */
function canConfirmShow(show, user) {
  var u = user || CURRENT_USER;
  if (!u) return false;
  if (u.role === 'admin' || u.role === 'manager') return true;
  if (u.role !== 'pm') return false;
  if (!show) return true;                     /* no show in hand -> rank alone */
  var p = PROJECTS_BY_ID[show.project_id];
  return show.owner === u.username || !!(p && p.owner === u.username);
}

/* ---- F4 · the ONE scope writer, shared by every demo mutation -------------
   Mirrors routes/core.js applyScope(): the same field list, the same
   non-negative-number rule, the same "undefined leaves it alone / null clears
   it" semantics, so the demo and the API cannot drift on what a patch means. */
function _applyScopeLocal(show, patch) {
  var p = patch || {};
  var pick = function (k) {
    return p[k] !== undefined ? p[k] : (p['scope_' + k] !== undefined ? p['scope_' + k] : undefined);
  };
  var numF = function (k, cur, isInt) {
    var v = pick(k);
    if (v === undefined) return cur;
    if (v === null || v === '') return null;
    var n = isInt ? parseInt(v, 10) : Number(v);
    if (!isFinite(n) || n < 0) return cur;
    return n;
  };
  var txtF = function (k, cur) {
    var v = pick(k);
    if (v === undefined) return cur;
    /* mirrors printable() in lib/enums.js: strip controls, zero-widths, bidi
       marks and the U+0334–U+0338 combining overlay strokes (the jumbled-chip
       bug) before trimming — never accents. Escaped, never literal. */
    var t = String(v == null ? '' : v).replace(new RegExp(
      '[\\u0000-\\u001F\\u007F-\\u009F\\u0334-\\u0338\\u200B-\\u200F\\u2028\\u2029' +
      '\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]', 'g'), '').trim().slice(0, 60);
    return t || null;
  };
  var kindIn = pick('kind');
  if (kindIn !== undefined) {
    show.scope_kind = (kindIn === null || kindIn === '') ? null
      : (SCOPE_KINDS.indexOf(String(kindIn)) >= 0 ? String(kindIn) : show.scope_kind);
  }
  show.scope_linear_feet = numF('linear_feet', show.scope_linear_feet, false);
  show.scope_cabinet_count = numF('cabinet_count', show.scope_cabinet_count, true);
  show.scope_cabinet_type = txtF('cabinet_type', show.scope_cabinet_type);
  show.scope_pitch = txtF('pitch', show.scope_pitch);
  show.scope_print_pieces = numF('print_pieces', show.scope_print_pieces, true);
  show.scope_print_sqft = numF('print_sqft', show.scope_print_sqft, false);
  var src = pick('source');
  show.scope_source = (src === 'spec' || src === 'manual') ? src : (show.scope_source || 'manual');
  show.scope_verified_at = TODAY_ISO + 'T' + nowHM();
  show.scope_verified_by = ME;
  return show;
}

/* ---- archive / unarchive -------------------------------------------------- */
var ARCHIVE_ROLES = { admin: 1 };
function canArchive(user) {
  var u = user || CURRENT_USER;
  return !!u && !!ARCHIVE_ROLES[u.role];
}
function isArchivedShow(s) { return !!(s && s.archived_at); }
function isArchivedProject(p) { return !!(p && p.archived_at); }
/* the WORKING SET — what every default list and dashboard reads */
function activeProjects() { return PROJECTS.filter(function (p) { return !p.archived_at; }); }
function activeShows() { return ALL_SHOWS.filter(function (s) { return !s.archived_at; }); }
function archivedProjects() { return PROJECTS.filter(function (p) { return !!p.archived_at; }); }
function archivedShows() { return ALL_SHOWS.filter(function (s) { return !!s.archived_at; }); }

function archiveShowLocal(show, actor, reason) {
  if (!show || show.archived_at) return false;
  show.archived_at = TODAY_ISO + 'T' + nowHM();
  show.archived_by = actor || ME;
  if (show.stage !== 'archived') show.stage = 'archived';
  show.activity.unshift(mkAct(actor || ME, 'archived the show',
    reason === 'auto'
      ? 'auto-archived — closeout completed more than ' + ARCHIVE_AFTER_DAYS + ' days ago'
      : 'archived by hand', 0, nowHM(), true));
  maybeArchiveProjectLocal(show.project_id, actor);
  return true;
}
function unarchiveShowLocal(show, actor) {
  if (!show || !show.archived_at) return false;
  show.archived_at = null; show.archived_by = null;
  if (show.stage === 'archived') show.stage = 'closed';
  var p = PROJECTS_BY_ID[show.project_id];
  if (p) { p.archived_at = null; p.archived_by = null; }
  show.activity.unshift(mkAct(actor || ME, 'unarchived the show',
    'back in the working set', 0, nowHM(), true));
  return true;
}
/* a FOLDER archives when every show inside it is archived. An EMPTY folder is
   never auto-archived — there is no evidence it is finished, only that it never
   started; an admin may archive it by hand. */
function maybeArchiveProjectLocal(projectId, actor) {
  var p = PROJECTS_BY_ID[Number(projectId)];
  if (!p || p.archived_at || !p.shows.length) return false;
  if (!p.shows.every(function (s) { return !!s.archived_at; })) return false;
  p.archived_at = TODAY_ISO + 'T' + nowHM();
  p.archived_by = actor || ME;
  return true;
}

/* one nag = one anchored note mentioning the tech (which IS the bell) plus one
   outbox row of kind 'report_nag' — so the recipient's preference for NAGS is
   the one that applies, not their preference for mentions. */
function nagReportLocal(show, rep, actor) {
  var label = _noteShowLabel(show);
  var n = mkNote('show', show.id, 'system',
    '@' + rep.username + ' your show report for ' + label + ' is required — write it in the app ' +
    'or upload a doc' + (rep.due_date ? ' (due ' + rep.due_date + ')' : ''), 0, nowHM());
  mkNotif(rep.username, 'report_nag', 'Show report required — ' + label, {
    off: 0, time: nowHM(), show_id: show.id, project_id: show.project_id, actor: 'system',
    note_id: n.id, link: '/#show/' + show.id,
    body: 'Your post-show report for ' + label + ' has not been filed yet.' +
          (rep.due_date ? ' It was due ' + rep.due_date + '.' : '') +
          ' Write it in Showrunner or upload the document you already have.' });
  rep.last_nagged_at = TODAY_ISO + 'T' + nowHM();
  rep.nag_count = (rep.nag_count || 0) + 1;
  return n;
}

/* ---- THE SWEEP (demo twin of lib/lifecycle.js sweep) ----------------------
   Idempotent: strike overdue shows, create + re-nag the reports their crews
   owe, re-check every closeout, auto-archive what is ripe, flush the immediate
   notification queue. NO CRON — it runs on demand, exactly like the server's. */
function sweepLocal(actor) {
  var out = { struck: 0, reports_created: 0, nagged: 0, closeout_complete: 0,
              archived: 0, projects_archived: 0, notifications: null, at: TODAY_ISO };
  ALL_SHOWS.forEach(function (s) {
    if (s.archived_at) return;
    var end = s.strike_date || s.event_date;
    if (!end || end > TODAY_ISO) return;
    if (!s.struck_at) { s.struck_at = TODAY_ISO + 'T' + nowHM(); s.struck_by = actor || 'system'; out.struck++; }
    (s.crew_assignments || []).forEach(function (c) {
      if (!c.username || reportFor(s.id, c.username)) return;
      var rep = mkReport(s, c.username, c.role_on_site, { status: 'owed', reqOff: 0, dueOff: 3, nag: 0 });
      out.reports_created++;
      nagReportLocal(s, rep, actor);
      out.nagged++;
    });
    if (syncCloseout(s.id).complete) out.closeout_complete++;
  });
  ALL_SHOWS.forEach(function (s) {
    if (s.archived_at || !s.closeout_complete_at) return;
    var age = dayAge(String(s.closeout_complete_at).slice(0, 10));
    if (age != null && age >= ARCHIVE_AFTER_DAYS) {
      var pWas = isArchivedProject(PROJECTS_BY_ID[s.project_id]);
      if (archiveShowLocal(s, actor || 'system', 'auto')) out.archived++;
      if (!pWas && isArchivedProject(PROJECTS_BY_ID[s.project_id])) out.projects_archived++;
    }
  });
  out.notifications = flushNotifications({});
  return out;
}

/* ---- the Brewers' SENT recap: the last of the three closeout conditions --- */
(function seedArchivedRecap() {
  var S_BREW = SHOWS_BY_ID[13];
  if (!S_BREW) return;
  var body = buildRecapDraft(S_BREW);
  body.headline = 'Thirty-four wraps, two mornings — Brewers concourse package';
  var rec = mkDeliverable(S_BREW, body, { off: -80, time: '10:10' });
  rec.status = 'sent';
  rec.approved_by = 'lfarkos'; rec.approved_at = dayISO(-78) + 'T09:00';
  rec.sent_at = dayISO(-76) + 'T16:20'; rec.sent_to = 'Milwaukee Brewers';
})();

/* ---- the nag notes the seeded owed reports already produced --------------- */
(function seedReportNagNotes() {
  var S_BUCK = SHOWS_BY_ID[12];
  if (!S_BUCK) return;
  ['tandres', 'dvargas'].forEach(function (u) {
    mkNote('show', 12, 'system',
      '@' + u + ' your show report for Bucks Preseason Courtside is required — write it in the ' +
      'app or upload a doc (due ' + dayISO(-8) + ')', -2, '07:00');
  });
})();
