// ════════════════════════════════════════════════════════════════════════════
// lib/seed.js — idempotent boot seeds
// ────────────────────────────────────────────────────────────────────────────
// Everything here is safe to run on EVERY boot. Nothing overwrites human edits.
//
// Punch coverage:
//   B. templates.json -> DB. Until now templates.json was referenced by
//      NOTHING. The loader reads all four templates, keeps their 10 planning
//      `owner_role` slugs (a new column), and reconciles the evidence_type
//      divergence: templates.json types Flex steps `file`; the server's own
//      seed typed them `flex_element`. **flex_element wins** (punch A) — the
//      loader rewrites `file` -> `flex_element` wherever auto_source='flex'.
//   C. lanes + event_types become config rows, not a hardcoded enum.
//   28. po_approval_threshold default 5000.
//   54. recap_stat_keys.
//   13. the roster is OPT-IN (SEED_ROSTER=1) — those usernames are placeholders
//      to be reconciled against the real staffing roster at go-live.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { pool, withTx, setConfig } = require('./db');
const { hashPassword } = require('./auth');
const { LANE_CATALOG, EVENT_TYPE_CONFIG, RECAP_STAT_KEYS, OWNER_ROLES,
        EVIDENCE_TYPES, AUTO_SOURCES, slug } = require('./enums');

const TEMPLATES_PATH = path.join(__dirname, '..', 'templates.json');

// ── C. lanes + event types ──────────────────────────────────────────────────
async function seedLanes(q = pool) {
  let i = 0;
  for (const l of LANE_CATALOG) {
    await q.query(
      `INSERT INTO lanes (key, label, color, sort_order) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label, color=EXCLUDED.color,
                                       sort_order=EXCLUDED.sort_order`,
      [l.key, l.label, l.color, i++]
    );
  }
  let j = 0;
  for (const t of EVENT_TYPE_CONFIG) {
    // DO NOTHING on conflict: an operator who reorders a type's lanes in the
    // DB keeps their edit across reboots. Only new types are inserted.
    await q.query(
      `INSERT INTO event_types (key, label, tag, icon, anchor, lanes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO NOTHING`,
      [t.key, t.label, t.tag, t.icon, t.anchor, t.lanes, j++]
    );
  }
}

// Read the lane set for an event type back out of the DB (falls back to the
// LED set so an unknown type can never crash a write path).
async function lanesForType(type, q = pool) {
  const r = await q.query('SELECT lanes FROM event_types WHERE key=$1', [type || 'led']);
  if (r.rows.length && Array.isArray(r.rows[0].lanes) && r.rows[0].lanes.length) return r.rows[0].lanes;
  const cfg = EVENT_TYPE_CONFIG.find((t) => t.key === (type || 'led')) || EVENT_TYPE_CONFIG[0];
  return cfg.lanes;
}
async function allLaneKeys(q = pool) {
  const r = await q.query('SELECT key FROM lanes ORDER BY sort_order');
  return r.rows.length ? r.rows.map((x) => x.key) : LANE_CATALOG.map((l) => l.key);
}

// ── 54. recap stat keys ─────────────────────────────────────────────────────
const RECAP_STAT_LABELS = {
  cabinets: 'LED cabinets', panels: 'Panels', crew: 'Crew on site',
  days: 'Days on site', attendance: 'Attendance', date: 'Show date',
  // F4 — the scope line and its numbers. Client-safe by the only test that
  // matters: none is derivable into a cost, a rate or a margin, and the client
  // already has them in the proposal they signed. Adding a key here is the
  // deliberate act of widening the client surface (lib/enums RECAP_STAT_KEYS).
  scope: 'Scope', linear_feet: 'Linear feet of LED', cabinet_count: 'LED cabinets',
  cabinet_type: 'Cabinet type', pitch: 'Pixel pitch',
  print_pieces: 'Printed pieces', print_sqft: 'Square feet printed'
};
async function seedRecapStatKeys(q = pool) {
  let i = 0;
  for (const key of RECAP_STAT_KEYS) {
    await q.query(
      `INSERT INTO recap_stat_keys (key, label, sort_order) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label`,
      [key, RECAP_STAT_LABELS[key] || key, i++]
    );
  }
}

// ── 28. config defaults ─────────────────────────────────────────────────────
async function seedConfig(q = pool) {
  const existing = await q.query(`SELECT key FROM config WHERE key='po_approval_threshold'`);
  if (!existing.rows.length) await setConfig('po_approval_threshold', '5000', 'system', q);
}

// ── default admin ───────────────────────────────────────────────────────────
async function seedAdmin(q = pool) {
  const c = await q.query('SELECT COUNT(*)::int AS n FROM users');
  if (c.rows[0].n > 0) return false;
  const pw = process.env.ADMIN_PASSWORD || 'e360admin';
  await q.query(
    `INSERT INTO users (username, password_hash, role, name, initials, finance, pw_algo)
     VALUES ($1,$2,'admin','Administrator','AD',TRUE,'bcrypt')`,
    ['admin', await hashPassword(pw)]
  );
  console.log(`[seed] default admin created: admin / ${process.env.ADMIN_PASSWORD ? '(ADMIN_PASSWORD)' : 'e360admin'}`);
  return true;
}

// ── 13. OPT-IN demo roster ──────────────────────────────────────────────────
// These usernames are the prototype's placeholders (public/data.js USERS).
// They are NOT the real staffing roster — hence opt-in. Set SEED_ROSTER=1 in
// dev / demo, leave it unset in production and create real users through
// POST /api/users.
const DEMO_ROSTER = [
  { username: 'tandres', name: 'Tom Andres',     initials: 'TA', color: '#F4B740', role: 'admin',   title: 'Owner · Engineer',        discipline: 'both',  finance: true,  phone: '(414) 555-0114' },
  { username: 'tvigon',  name: 'Tony Vigon',     initials: 'TV', color: '#59A9F0', role: 'admin',   title: 'Ops / Project Lead',      discipline: 'led',   finance: false, phone: '(414) 555-0127' },
  { username: 'jeaton',  name: 'Jim Eaton',      initials: 'JE', color: '#8ED14A', role: 'admin',   title: 'Principal',               discipline: 'print', finance: false, phone: '(305) 555-0188' },
  { username: 'candice', name: 'Candice Wren',   initials: 'CW', color: '#E36FBE', role: 'manager', title: 'Accounting · QuickBooks', discipline: 'both',  finance: true,  phone: '(414) 555-0196' },
  { username: 'bsawyer', name: 'Brendon Sawyer', initials: 'BS', color: '#35E0A1', role: 'manager', title: 'Field Ops / On-site POC', discipline: 'led',   finance: false, phone: '(414) 555-0139' },
  { username: 'lfarkos', name: 'Larry Farkos',   initials: 'LF', color: '#F0616B', role: 'pm',      title: 'Print Production Lead',   discipline: 'print', finance: false, phone: '(414) 555-0142' },
  { username: 'jhawk',   name: 'Josh Hawk',      initials: 'JH', color: '#B98CF0', role: 'pm',      title: 'Content / Graphic Design',discipline: 'print', finance: false, phone: '(414) 555-0158' },
  { username: 'dvargas', name: 'Devin Vargas',   initials: 'DV', color: '#4ADEDE', role: 'tech',    title: 'Gear / Prep Tech',        discipline: 'led',   finance: false, phone: '(262) 555-0161' },
  { username: 'aramos',  name: 'Aaron Ramos',    initials: 'AR', color: '#F08C59', role: 'tech',    title: 'Install / Field Tech',    discipline: 'both',  finance: false, phone: '(262) 555-0175' }
];
async function seedRoster(q = pool) {
  if (process.env.SEED_ROSTER !== '1') return 0;
  const pw = await hashPassword(process.env.SEED_ROSTER_PASSWORD || 'e360demo');
  let n = 0;
  for (const u of DEMO_ROSTER) {
    const r = await q.query(
      `INSERT INTO users (username, password_hash, role, name, initials, color, title,
                          discipline, phone, finance, pw_algo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'bcrypt')
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [u.username, pw, u.role, u.name, u.initials, u.color, u.title, u.discipline, u.phone, u.finance]
    );
    if (r.rows.length) n++;
  }
  if (n) console.log(`[seed] demo roster: ${n} user(s) created (SEED_ROSTER=1)`);
  return n;
}

// ════════════════════════════════════════════════════════════════════════════
// B. TEMPLATES.JSON -> DB
// ════════════════════════════════════════════════════════════════════════════
// A. evidence_type reconciliation. templates.json marks the Flex steps
// `"evidence_type": "file"` while the server's own seed used `flex_element`.
// flex_element wins: a Flex pull sheet is an ELEMENT in Flex, not a file on the
// NAS, and the front-end's gear lane keys off it.
function reconcileEvidenceType(evidence, autoSource) {
  let ev = EVIDENCE_TYPES.includes(evidence) ? evidence : 'none';
  if (autoSource === 'flex' && ev === 'file') ev = 'flex_element';
  return ev;
}

function readTemplatesFile() {
  if (!fs.existsSync(TEMPLATES_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8')); }
  catch (e) { console.error('[seed] templates.json is not valid JSON:', e.message); return null; }
}

// Flattens one templates.json entry (lanes -> ordered step list).
function flattenTemplate(tpl) {
  const out = [];
  let i = 0;
  for (const [lane, steps] of Object.entries(tpl.lanes || {})) {
    for (const s of steps || []) {
      if (!s || !s.title) continue;
      const auto = AUTO_SOURCES.includes(s.auto_source) ? s.auto_source : 'none';
      out.push({
        lane,
        title: String(s.title),
        due_offset_days: s.due_offset_days == null ? null : parseInt(s.due_offset_days, 10),
        owner_role: OWNER_ROLES.includes(s.owner_role) ? s.owner_role : null,
        evidence_type: reconcileEvidenceType(s.evidence_type, auto),
        auto_source: auto,
        depends_on_title: s.depends_on || '',
        sort_order: i++
      });
    }
  }
  // Back-schedule order: earliest T-minus first, then authoring order. Keeps a
  // prerequisite above its dependent in every UI that renders sort_order.
  out.sort((a, b) => {
    const ao = a.due_offset_days == null ? 9999 : a.due_offset_days;
    const bo = b.due_offset_days == null ? 9999 : b.due_offset_days;
    return ao - bo || a.sort_order - b.sort_order;
  });
  out.forEach((s, idx) => { s.sort_order = idx; });
  return out;
}

// Idempotent: keyed on `source_key` (a slug of the template name), so re-running
// UPDATES the template in place rather than duplicating it. Human-authored
// templates (source_key NULL) are never touched.
async function seedTemplatesFromJson(q = pool) {
  const doc = readTemplatesFile();
  if (!doc || !Array.isArray(doc.templates)) {
    console.warn('[seed] templates.json missing or malformed — no templates loaded');
    return { loaded: 0, steps: 0 };
  }
  let loaded = 0, stepCount = 0, reconciled = 0;
  for (const tpl of doc.templates) {
    if (!tpl || !tpl.name) continue;
    const key = 'json:' + slug(tpl.name);
    const steps = flattenTemplate(tpl);
    reconciled += (tpl.lanes ? Object.values(tpl.lanes).flat() : [])
      .filter((s) => s && s.auto_source === 'flex' && s.evidence_type === 'file').length;

    await withTxOn(q, async (c) => {
      const found = await c.query('SELECT id FROM event_type_templates WHERE source_key=$1', [key]);
      let tid;
      if (found.rows.length) {
        tid = found.rows[0].id;
        await c.query(
          `UPDATE event_type_templates SET name=$1, event_type=$2, description=$3 WHERE id=$4`,
          [tpl.name, tpl.event_type || 'led', tpl.description || '', tid]
        );
        await c.query('DELETE FROM template_steps WHERE template_id=$1', [tid]);
      } else {
        const ins = await c.query(
          `INSERT INTO event_type_templates (name, event_type, description, source_key)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [tpl.name, tpl.event_type || 'led', tpl.description || '', key]
        );
        tid = ins.rows[0].id;
      }
      for (const s of steps) {
        await c.query(
          `INSERT INTO template_steps (template_id, lane, title, due_offset_days, owner_role,
                                       evidence_type, auto_source, depends_on_title, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tid, s.lane, s.title, s.due_offset_days, s.owner_role, s.evidence_type,
           s.auto_source, s.depends_on_title, s.sort_order]
        );
      }
    });
    loaded += 1;
    stepCount += steps.length;
  }
  console.log(`[seed] templates.json -> DB: ${loaded} template(s), ${stepCount} steps ` +
              `(${reconciled} evidence_type file->flex_element reconciliations)`);
  return { loaded, steps: stepCount, reconciled };
}

// withTx that works whether it is handed the pool or an existing client.
async function withTxOn(q, fn) {
  if (q === pool) return withTx(fn);
  return fn(q);
}

// ── the one call boot makes ─────────────────────────────────────────────────
async function seedAll(q = pool) {
  await seedLanes(q);
  await seedRecapStatKeys(q);
  await seedConfig(q);
  await seedAdmin(q);
  await seedRoster(q);
  const t = await seedTemplatesFromJson(q);
  return t;
}

module.exports = {
  seedAll, seedLanes, seedRecapStatKeys, seedConfig, seedAdmin, seedRoster,
  seedTemplatesFromJson, lanesForType, allLaneKeys, reconcileEvidenceType,
  flattenTemplate, DEMO_ROSTER
};
