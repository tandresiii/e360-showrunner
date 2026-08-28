// ════════════════════════════════════════════════════════════════════════════
// lib/db.js — pool, transactions, the single additive initDB(), manual cascades
// ────────────────────────────────────────────────────────────────────────────
// House rules (inherited from the staffing app, preserved deliberately):
//   · ONE initDB(). CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT
//     EXISTS only. Never DROP. An existing database upgrades in place.
//   · NO SQL foreign keys and no ON DELETE CASCADE. Parent/child links are
//     plain integer columns; cascade deletes are handled manually, in code,
//     inside a transaction (see the CASCADES section at the bottom).
//   · Multi-row writes run inside withTx().
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { Pool } = require('pg');
// lib/enums.js is pure data + pure functions — no requires of its own, so this
// is the one import this module can take without risking a cycle.
const { TEMP_JOB_PREFIX, TEMP_JOB_RE, tempJobNumber } = require('./enums');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\bsslmode=disable\b/.test(process.env.DATABASE_URL || '') ? false
     : (process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
        ? { rejectUnauthorized: false } : false),
  max: parseInt(process.env.PG_POOL_MAX || '10', 10)
});

// Anything that writes more than one row runs in here so a mid-way failure
// rolls the whole thing back instead of leaving orphans.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

// ── LOOKUP HELPERS (shared by every route module) ───────────────────────────
async function loadProject(id, q = pool) {
  if (!id) return null;
  const r = await q.query('SELECT * FROM projects WHERE id=$1', [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}
async function loadShow(id, q = pool) {
  if (!id) return null;
  const r = await q.query('SELECT * FROM shows WHERE id=$1', [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}
async function loadJob(id, q = pool) {
  if (!id) return null;
  const r = await q.query('SELECT * FROM jobs WHERE id=$1', [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}
// POLISH_LIST #5. Mint the next `TEMP-{yy}-{seq}` placeholder for this year.
// Shared by routes/finance.js (a pm creating a job) and routes/proposals.js
// (confirming an agent-proposed project), which is why it lives here.
// The seq is the highest already minted THIS year plus one; a gap left by a
// deleted job is never reused, so a TEMP label is stable in history.
async function mintTempJobNumber(q = pool) {
  const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
  const r = await q.query(
    'SELECT qb_job_number FROM jobs WHERE qb_job_number LIKE $1', [`${TEMP_JOB_PREFIX}${yy}-%`]);
  let max = 0;
  for (const row of r.rows) {
    const m = TEMP_JOB_RE.exec(row.qb_job_number || '');
    if (m) max = Math.max(max, parseInt(m[2], 10) || 0);
  }
  return tempJobNumber(yy, max + 1);
}
async function loadRow(table, id, q = pool) {
  if (!id) return null;
  // `table` is never user-supplied — call sites pass a literal.
  const r = await q.query(`SELECT * FROM ${table} WHERE id=$1`, [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}
// Resolve the owning project for a row that carries show_id and/or project_id.
async function projectForRow(row, q = pool) {
  if (!row) return null;
  if (row.show_id) {
    const show = await loadShow(row.show_id, q);
    if (show) return loadProject(show.project_id, q);
  }
  if (row.project_id) return loadProject(row.project_id, q);
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════════════
async function initDB(q = pool) {
  const run = (sql) => q.query(sql);

  // ── projects: the "Event Folder". A project has 1+ shows and 1+ jobs. ──
  await run(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT DEFAULT '',
      client TEXT DEFAULT '',
      type TEXT DEFAULT 'led',
      stage TEXT DEFAULT 'lead',
      owner TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  // 10. AI-summary panel + provenance line. 23/§7. agent hooks.
  await addCols(q, 'projects', {
    slug: 'TEXT DEFAULT \'\'',
    summary: 'TEXT DEFAULT NULL',
    source: 'TEXT DEFAULT NULL',
    provenance: 'JSONB DEFAULT NULL',
    source_ref: 'TEXT DEFAULT NULL',
    // F6. A FOLDER archives when every show inside it is archived (or, for an
    // empty folder, by hand). Archived folders drop out of the portfolio list;
    // the folder itself still resolves by id, so a deep link and a search hit
    // both still open.
    archived_at: 'TIMESTAMPTZ DEFAULT NULL',
    archived_by: 'TEXT DEFAULT NULL'
  });
  await run(`CREATE INDEX IF NOT EXISTS projects_archived_idx ON projects(archived_at);`);

  // ── shows: each show ≈ one staffing "event". ──
  await run(`
    CREATE TABLE IF NOT EXISTS shows (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT DEFAULT '',
      venue TEXT DEFAULT '',
      load_in_date TEXT DEFAULT '',
      event_date TEXT DEFAULT '',
      strike_date TEXT DEFAULT '',
      stage TEXT DEFAULT 'lead',
      rag TEXT DEFAULT 'idle',
      on_site_poc TEXT DEFAULT '',
      scheduler_event_id INTEGER DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS shows_project_idx ON shows(project_id);`);
  await addCols(q, 'shows', {
    slug: 'TEXT DEFAULT \'\'',
    city: 'TEXT DEFAULT \'\'',
    owner: 'TEXT DEFAULT \'\'',
    summary: 'TEXT DEFAULT NULL',
    source: 'TEXT DEFAULT NULL',
    // 5. the commercial dimension every cost-bearing row inherits.
    default_job_id: 'INTEGER DEFAULT NULL',
    // 12. drives Flex kit sizing.
    cabinets: 'INTEGER DEFAULT 0',
    // 9. RAG: derived from steps; this nullable column is the manager override
    //    and, when set, WINS. `rag` above is the legacy/stored fallback.
    rag_override: 'TEXT DEFAULT NULL',
    // 38. call-sheet header fields (all nullable).
    load_in_time: 'TEXT DEFAULT NULL',
    doors_time: 'TEXT DEFAULT NULL',
    event_time: 'TEXT DEFAULT NULL',
    strike_time: 'TEXT DEFAULT NULL',
    venue_address: 'TEXT DEFAULT NULL',
    parking_notes: 'TEXT DEFAULT NULL',
    radio_channel: 'TEXT DEFAULT NULL',
    dress_code: 'TEXT DEFAULT NULL',
    venue_poc: 'JSONB DEFAULT NULL',
    client_poc: 'JSONB DEFAULT NULL',
    provenance: 'JSONB DEFAULT NULL',
    source_ref: 'TEXT DEFAULT NULL',
    // M8 / §2.7 ownership marker. The staffing app has NO `source` column on
    // bookings / venue_contacts / client_contacts, so Showrunner cannot tell
    // rows it created from rows an operator typed by hand. Option (a), the one
    // that needs no staffing-repo change: remember the ids we created and
    // delete ONLY those on a re-push. Rows a human added survive.
    //   { bookings:[id,…], venueContacts:[id,…], clientContacts:[id,…] }
    pushed_child_ids: 'JSONB DEFAULT NULL',
    scheduler_pushed_at: 'TIMESTAMPTZ DEFAULT NULL',
    // ── F4. the SCOPE LINE — "what we're delivering", structured. ───────────
    // Flat nullable columns, not a JSONB blob: they are queried (the season
    // rollup sums cabinets), they are typed per event type, and a 'both' show
    // carries the LED numbers AND the print numbers at once. Every one defaults
    // to NULL, so an existing show simply has no scope line until someone
    // enters one — no row is rewritten and nothing renders differently.
    scope_kind: 'TEXT DEFAULT NULL',
    scope_linear_feet: 'NUMERIC(10,2) DEFAULT NULL',
    scope_cabinet_count: 'INTEGER DEFAULT NULL',
    scope_cabinet_type: 'TEXT DEFAULT NULL',
    scope_pitch: 'TEXT DEFAULT NULL',
    scope_print_pieces: 'INTEGER DEFAULT NULL',
    scope_print_sqft: 'NUMERIC(12,2) DEFAULT NULL',
    scope_source: `TEXT DEFAULT 'manual'`,
    scope_verified_at: 'TIMESTAMPTZ DEFAULT NULL',
    scope_verified_by: 'TEXT DEFAULT NULL',
    // ── F5. the CONFIRM FACT. ───────────────────────────────────────────────
    // The stage STRING is display + ordering; THIS is the record that the
    // client committed, and it is written only by the explicit Confirm action.
    // A legacy row has stage='planning' and confirmed_at=NULL, and reads as
    // "confirmed by stage position, no datestamp" — which is the truth.
    confirmed_at: 'TIMESTAMPTZ DEFAULT NULL',
    confirmed_by: 'TEXT DEFAULT NULL',
    // ── F2. the strike marker that owes everyone a report. ──────────────────
    struck_at: 'TIMESTAMPTZ DEFAULT NULL',
    struck_by: 'TEXT DEFAULT NULL',
    // ── F6. closeout + archiving. ───────────────────────────────────────────
    // closeout_complete_at is MACHINE-SET the first time the three conditions
    // hold together (recap sent · every tech report filed · no open finance
    // exception on the show). The 60-day archive clock runs from it.
    closeout_complete_at: 'TIMESTAMPTZ DEFAULT NULL',
    archived_at: 'TIMESTAMPTZ DEFAULT NULL',
    archived_by: 'TEXT DEFAULT NULL'
  });
  await run(`CREATE INDEX IF NOT EXISTS shows_job_idx ON shows(default_job_id);`);
  await run(`CREATE INDEX IF NOT EXISTS shows_archived_idx ON shows(archived_at);`);
  await run(`CREATE INDEX IF NOT EXISTS shows_closeout_idx ON shows(closeout_complete_at);`);

  // ── 5/16/20. jobs: one deal = one client = one qb_job_number = one budget ──
  await run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT DEFAULT '',
      qb_job_number TEXT DEFAULT NULL,
      client TEXT DEFAULT '',
      deal_type TEXT DEFAULT 'rental',
      description TEXT DEFAULT '',
      contract_value NUMERIC(12,2) DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id);`);
  // POLISH_LIST #5. A job may exist BEFORE Candice cuts the real QuickBooks
  // number: it is created with an auto `TEMP-{yy}-{seq}` label and
  // qb_number_status='temp'. Existing rows default to 'confirmed' — every
  // number already in the table came from QuickBooks. Nothing links by the
  // number (all joins are on jobs.id), so the swap re-links nothing.
  await addCols(q, 'jobs', { qb_number_status: `TEXT DEFAULT 'confirmed'` });
  // 20. budget_total is DERIVED (sum of budget_lines) — never stored. See
  //     routes/finance.js jobFinance(). No column here on purpose.

  // ── 17/21. budget_lines ──
  await run(`
    CREATE TABLE IF NOT EXISTS budget_lines (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      allotted NUMERIC(12,2) DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT ''
    );`);
  await run(`CREATE INDEX IF NOT EXISTS budget_lines_job_idx ON budget_lines(job_id);`);

  // ── steps: the pipeline unit. ──
  await run(`
    CREATE TABLE IF NOT EXISTS steps (
      id SERIAL PRIMARY KEY,
      show_id INTEGER DEFAULT NULL,
      project_id INTEGER DEFAULT NULL,
      lane TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'todo',
      owner TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      due_offset_days INTEGER DEFAULT NULL,
      evidence_type TEXT DEFAULT 'none',
      evidence_ref TEXT DEFAULT '',
      depends_on INTEGER DEFAULT NULL,
      auto_source TEXT DEFAULT 'none',
      sort_order INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS steps_show_idx ON steps(show_id);`);
  await run(`CREATE INDEX IF NOT EXISTS steps_project_idx ON steps(project_id);`);
  await run(`CREATE INDEX IF NOT EXISTS steps_owner_idx ON steps(owner);`);
  await addCols(q, 'steps', {
    // 4. drives the RAG rollup + the warn pill.
    risk: 'BOOLEAN DEFAULT FALSE',
    owner_role: 'TEXT DEFAULT NULL',
    provenance: 'JSONB DEFAULT NULL',
    source_ref: 'TEXT DEFAULT NULL'
  });

  // ── C. lanes catalogue + per-event-type lane sets (config, not an enum) ──
  await run(`
    CREATE TABLE IF NOT EXISTS lanes (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );`);
  await run(`
    CREATE TABLE IF NOT EXISTS event_types (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      tag TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      anchor TEXT DEFAULT '',
      lanes TEXT[] NOT NULL DEFAULT '{}',
      sort_order INTEGER DEFAULT 0
    );`);

  // ── event-type templates + their steps (the SOP, encoded once) ──
  await run(`
    CREATE TABLE IF NOT EXISTS event_type_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      event_type TEXT DEFAULT 'led',
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`
    CREATE TABLE IF NOT EXISTS template_steps (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL,
      lane TEXT NOT NULL,
      title TEXT NOT NULL,
      due_offset_days INTEGER DEFAULT NULL,
      evidence_type TEXT DEFAULT 'none',
      auto_source TEXT DEFAULT 'none',
      depends_on_title TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );`);
  await run(`CREATE INDEX IF NOT EXISTS template_steps_tpl_idx ON template_steps(template_id);`);
  // B. the 10 planning-role slugs templates.json carries and the old loader dropped.
  await addCols(q, 'template_steps', { owner_role: 'TEXT DEFAULT NULL' });
  await addCols(q, 'event_type_templates', { source_key: 'TEXT DEFAULT NULL' });
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS templates_source_key_uq
             ON event_type_templates(source_key) WHERE source_key IS NOT NULL;`);

  // ── files: metadata only. Bytes live on the NAS at nas_path. ──
  await run(`
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      project_id INTEGER DEFAULT NULL,
      show_id INTEGER DEFAULT NULL,
      name TEXT NOT NULL,
      ext TEXT DEFAULT '',
      kind TEXT DEFAULT 'other',
      spec_type TEXT DEFAULT NULL,
      nas_path TEXT DEFAULT '',
      size BIGINT DEFAULT 0,
      uploaded_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS files_project_idx ON files(project_id);`);
  await run(`CREATE INDEX IF NOT EXISTS files_show_idx ON files(show_id);`);
  await addCols(q, 'files', {
    // 1/2/3. what `kind` cannot express + the chain UI's v{rev} + the dim string.
    artifact: 'TEXT DEFAULT NULL',
    ver: 'TEXT DEFAULT \'v1\'',
    dim: 'TEXT DEFAULT NULL',
    meta: 'TEXT DEFAULT \'\'',
    chain_key: 'TEXT DEFAULT NULL',
    // financial-doc columns (AGENT_API §11 hooks).
    amount: 'NUMERIC(12,2) DEFAULT NULL',
    vendor: 'TEXT DEFAULT NULL',
    doc_date: 'TEXT DEFAULT NULL',
    job_id: 'INTEGER DEFAULT NULL',
    attached_to: 'INTEGER DEFAULT NULL',
    // 23/§7. proposed-vs-filed + audit on every doc.
    status: 'TEXT DEFAULT \'filed\'',
    provenance: 'JSONB DEFAULT NULL',
    source_ref: 'TEXT DEFAULT NULL',
    // 43. photo columns.
    taken_at: 'TIMESTAMPTZ DEFAULT NULL',
    width: 'INTEGER DEFAULT NULL',
    height: 'INTEGER DEFAULT NULL',
    caption: 'TEXT DEFAULT NULL',
    tags: 'TEXT[] DEFAULT NULL',
    shot_by: 'TEXT DEFAULT NULL',
    recap_pick: 'BOOLEAN DEFAULT FALSE',
    thumb_path: 'TEXT DEFAULT NULL'
  });
  await run(`CREATE INDEX IF NOT EXISTS files_kind_idx ON files(kind);`);
  await run(`CREATE INDEX IF NOT EXISTS files_status_idx ON files(status);`);
  await run(`CREATE INDEX IF NOT EXISTS files_job_idx ON files(job_id);`);
  await run(`CREATE INDEX IF NOT EXISTS files_source_ref_idx ON files(source_ref);`);

  // ── expenses: job costing. ──
  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      show_id INTEGER DEFAULT NULL,
      vendor TEXT DEFAULT '',
      amount NUMERIC(12,2) DEFAULT 0,
      category TEXT DEFAULT '',
      status TEXT DEFAULT 'proposed',
      match_confidence NUMERIC(5,2) DEFAULT NULL,
      match_reason TEXT DEFAULT '',
      evidence_ref TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS expenses_show_idx ON expenses(show_id);`);
  await addCols(q, 'expenses', {
    project_id: 'INTEGER DEFAULT NULL',
    job_id: 'INTEGER DEFAULT NULL',
    // 17. the shared 7-category vocabulary.
    budget_line_category: 'TEXT DEFAULT \'misc\'',
    txn_date: 'TEXT DEFAULT NULL',
    file_id: 'INTEGER DEFAULT NULL',
    // 18. "who to chase" + the memo line.
    by: 'TEXT DEFAULT NULL',
    memo: 'TEXT DEFAULT \'\'',
    // 27. PO-generated actuals trace to their order (and are excluded from
    //     the exceptions scan — the PO carries that exception, never both).
    po_id: 'INTEGER DEFAULT NULL',
    provenance: 'JSONB DEFAULT NULL',
    source_ref: 'TEXT DEFAULT NULL'
  });
  await run(`CREATE INDEX IF NOT EXISTS expenses_job_status_idx ON expenses(job_id, status);`);
  await run(`CREATE INDEX IF NOT EXISTS expenses_po_idx ON expenses(po_id);`);

  // ── 15/19. bookings (Showrunner-side; the staffing app has its own) ──
  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      job_id INTEGER DEFAULT NULL,
      category TEXT DEFAULT '',
      vendor TEXT DEFAULT '',
      status TEXT DEFAULT 'todo',
      amount NUMERIC(12,2) DEFAULT NULL,
      booked_date TEXT DEFAULT NULL,
      file_id INTEGER DEFAULT NULL,
      confirmation_number TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS bookings_show_idx ON bookings(show_id);`);
  await run(`CREATE INDEX IF NOT EXISTS bookings_status_file_idx ON bookings(status, file_id);`);

  // ── 25/26. purchase orders + lines ──
  await run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id SERIAL PRIMARY KEY,
      po_number TEXT NOT NULL,
      vendor TEXT DEFAULT '',
      project_id INTEGER DEFAULT NULL,
      job_id INTEGER DEFAULT NULL,
      status TEXT DEFAULT 'needed',
      created_by TEXT DEFAULT '',
      ordered_date TEXT DEFAULT NULL,
      expected_date TEXT DEFAULT NULL,
      received_date TEXT DEFAULT NULL,
      approval JSONB DEFAULT NULL,
      provenance JSONB DEFAULT NULL,
      source_ref TEXT DEFAULT NULL,
      memo TEXT DEFAULT '',
      tracking TEXT DEFAULT NULL,
      quote_file_id INTEGER DEFAULT NULL,
      invoice_file_id INTEGER DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS po_status_idx ON purchase_orders(status);`);
  await run(`CREATE INDEX IF NOT EXISTS po_project_idx ON purchase_orders(project_id);`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS po_number_uq ON purchase_orders(po_number);`);
  await run(`
    CREATE TABLE IF NOT EXISTS po_lines (
      id SERIAL PRIMARY KEY,
      po_id INTEGER NOT NULL,
      item TEXT NOT NULL,
      detail TEXT DEFAULT '',
      qty NUMERIC(12,2) DEFAULT 1,
      unit_cost NUMERIC(12,2) DEFAULT 0,
      category TEXT DEFAULT 'gear',
      job_id INTEGER DEFAULT NULL,
      show_id INTEGER DEFAULT NULL,
      ownership TEXT DEFAULT 'cogs',
      expense_id INTEGER DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS po_lines_po_idx ON po_lines(po_id);`);
  await run(`CREATE INDEX IF NOT EXISTS po_lines_job_idx ON po_lines(job_id);`);

  // ── users ──
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await addCols(q, 'users', {
    name: 'TEXT DEFAULT \'\'',
    // 13. display columns the front-end roster needs.
    initials: 'TEXT DEFAULT \'\'',
    color: 'TEXT DEFAULT \'\'',
    title: 'TEXT DEFAULT \'\'',
    discipline: 'TEXT DEFAULT \'\'',
    // 41. call-sheet tel: links.
    phone: 'TEXT DEFAULT \'\'',
    // The address the notification outbox delivers to. NULLABLE and optional —
    // a person with no address is not an error, their outbox rows are marked
    // `skipped: no email address on file` (lib/notify.js flushOne) and the app
    // still tells them everything through the bell. Validated and kept unique
    // among ACTIVE users in ROUTE LOGIC (routes/auth.js), never by a DB
    // constraint: this table is upgraded in place on a live database and
    // nothing here ever drops or rewrites a column. "No address" is stored as
    // the empty string (the column default); NULL is read as the same thing
    // everywhere, so a row written by hand either way behaves identically.
    email: 'TEXT DEFAULT \'\'',
    // The identity half of the cross-system linkage (SCHEMA.md). The staffing
    // app keys its roster, its travel_key segments and every events.staff[]
    // entry on a DISPLAY NAME — it has no notion of a Showrunner username. When
    // this is NULL the person is called the same thing in both systems and
    // their Showrunner display name is what crosses the wire; when the two
    // differ, this is the name the staffing app knows them by.
    staffing_name: 'TEXT DEFAULT NULL',
    // Roles section: finance is a CAPABILITY, not a rank. Sees margins,
    // approves POs alongside the admins.
    finance: 'BOOLEAN DEFAULT FALSE',
    // People come and go. `active` is the WHOLE lifecycle: a person who leaves
    // is deactivated, never deleted, so every step they owned, note they wrote,
    // report they filed and activity line they caused still reads correctly
    // years later. Nothing in this app deletes a user as part of offboarding.
    active: 'BOOLEAN DEFAULT TRUE',
    // The server mints a temp password on create and on reset, and sets this.
    // It gates NOTHING server-side — a session is a session — it is the fact
    // the LOGIN RESPONSE carries so the client can insist on a real password
    // before the app opens. Named without the word "password" in the API
    // record (`must_change`), because the roster assertion greps for it.
    must_change_password: 'BOOLEAN DEFAULT FALSE',
    // F. bcrypt migration marker — 'sha256' rows are re-hashed on next login.
    pw_algo: 'TEXT DEFAULT \'bcrypt\''
  });

  // ── E. durable sessions (survive redeploys) ──
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      ip TEXT DEFAULT ''
    );`);
  await run(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);`);

  // ── AGENT_API §1. api_keys ──
  await run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      label TEXT DEFAULT '',
      key_prefix TEXT DEFAULT '',
      key_hash TEXT NOT NULL,
      scopes TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by TEXT DEFAULT '',
      revoked_at TIMESTAMPTZ DEFAULT NULL,
      last_used_at TIMESTAMPTZ DEFAULT NULL,
      last_used_ip TEXT DEFAULT NULL
    );`);
  await run(`CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uq ON api_keys(key_hash);`);

  // ── AGENT_API §6. proposals — one generic table, payload JSONB ──
  await run(`
    CREATE TABLE IF NOT EXISTS proposals (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      proposed_by TEXT NOT NULL,
      assigned_to TEXT DEFAULT '',
      project_id INTEGER DEFAULT NULL,
      show_id INTEGER DEFAULT NULL,
      job_id INTEGER DEFAULT NULL,
      payload JSONB NOT NULL,
      provenance JSONB NOT NULL,
      confidence NUMERIC(5,2) DEFAULT NULL,
      resolved_by TEXT DEFAULT NULL,
      resolved_at TIMESTAMPTZ DEFAULT NULL,
      resolve_reason TEXT DEFAULT NULL,
      created_rows JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS proposals_assigned_idx ON proposals(assigned_to);`);
  await run(`CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status);`);
  await run(`CREATE INDEX IF NOT EXISTS proposals_show_idx ON proposals(show_id);`);
  await run(`CREATE INDEX IF NOT EXISTS proposals_project_idx ON proposals(project_id);`);

  // ── AGENT_API §8. idempotency ledger — UNIQUE (username, key) ──
  await run(`
    CREATE TABLE IF NOT EXISTS agent_idempotency (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      username TEXT NOT NULL,
      endpoint TEXT DEFAULT '',
      body_hash TEXT DEFAULT '',
      response JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS agent_idem_uq ON agent_idempotency(username, key);`);

  // ── 31/32. notes + read tracking + the mention fact ──
  await run(`
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      anchor_type TEXT NOT NULL,
      anchor_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      show_id INTEGER DEFAULT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      mentions TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      edited_at TIMESTAMPTZ DEFAULT NULL,
      provenance JSONB DEFAULT NULL,
      source_ref TEXT DEFAULT NULL
    );`);
  await run(`CREATE INDEX IF NOT EXISTS notes_anchor_idx ON notes(anchor_type, anchor_id);`);
  await run(`CREATE INDEX IF NOT EXISTS notes_parent_idx ON notes(parent_id);`);
  await run(`CREATE INDEX IF NOT EXISTS notes_project_idx ON notes(project_id);`);
  await run(`CREATE INDEX IF NOT EXISTS notes_show_idx ON notes(show_id);`);
  await run(`
    CREATE TABLE IF NOT EXISTS note_reads (
      id SERIAL PRIMARY KEY,
      note_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      read_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS note_reads_uq ON note_reads(note_id, username);`);
  // the mention FACT, separate from read state (punch 32).
  await run(`
    CREATE TABLE IF NOT EXISTS note_mentions (
      id SERIAL PRIMARY KEY,
      note_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS note_mentions_uq ON note_mentions(note_id, username);`);
  await run(`CREATE INDEX IF NOT EXISTS note_mentions_user_idx ON note_mentions(username);`);

  // ── 39/40. run of show ──
  await run(`
    CREATE TABLE IF NOT EXISTS schedule_items (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT DEFAULT NULL,
      title TEXT NOT NULL,
      detail TEXT DEFAULT '',
      who JSONB DEFAULT '"all"',
      location TEXT DEFAULT '',
      kind TEXT DEFAULT 'work',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS schedule_show_idx ON schedule_items(show_id);`);
  await run(`
    CREATE TABLE IF NOT EXISTS crew_assignments (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      username TEXT DEFAULT NULL,
      name TEXT DEFAULT NULL,
      phone TEXT DEFAULT NULL,
      role_on_site TEXT DEFAULT '',
      call_time TEXT DEFAULT NULL,
      travel JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS crew_show_idx ON crew_assignments(show_id);`);

  // ── 8. extra milestones ──
  await run(`
    CREATE TABLE IF NOT EXISTS milestones (
      id SERIAL PRIMARY KEY,
      show_id INTEGER DEFAULT NULL,
      project_id INTEGER DEFAULT NULL,
      label TEXT NOT NULL,
      date TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );`);
  await run(`CREATE INDEX IF NOT EXISTS milestones_show_idx ON milestones(show_id);`);
  await run(`CREATE INDEX IF NOT EXISTS milestones_project_idx ON milestones(project_id);`);

  // ── 14. proofs + proof_rounds ──
  await run(`
    CREATE TABLE IF NOT EXISTS proofs (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      code TEXT DEFAULT '',
      name TEXT DEFAULT '',
      status TEXT DEFAULT 'sent',
      client TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS proofs_show_idx ON proofs(show_id);`);
  await run(`
    CREATE TABLE IF NOT EXISTS proof_rounds (
      id SERIAL PRIMARY KEY,
      proof_id INTEGER NOT NULL,
      round TEXT DEFAULT '',
      date TEXT DEFAULT '',
      status TEXT DEFAULT 'sent',
      note TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );`);
  await run(`CREATE INDEX IF NOT EXISTS proof_rounds_proof_idx ON proof_rounds(proof_id);`);

  // ── 6. spec-derivation chain state, one row per node (INTEGRATION.md §48–67) ──
  await run(`
    CREATE TABLE IF NOT EXISTS spec_chain (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      node TEXT NOT NULL,
      gen BOOLEAN DEFAULT FALSE,
      rev INTEGER DEFAULT 0,
      derived_from_rev INTEGER DEFAULT 0,
      by TEXT DEFAULT '',
      when_at TEXT DEFAULT '',
      file_id INTEGER DEFAULT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS spec_chain_uq ON spec_chain(show_id, node);`);

  // ── D2. the render bundle (INTEGRATIONS_SPEC.md §9.5 D2) ──
  // Showrunner already stored the spec FILE (a `files` row + NAS bytes) and the
  // chain STATE (`spec_chain`), but had nowhere to put the svg / html / png the
  // three browser tools produce. Without it a bound spec cannot be viewed or
  // printed without opening the source tool — which is precisely the promise
  // the two-tier model makes ("the DB holds what you need to look at and print").
  // The staffing app solves this with twelve columns on `events` AND twelve on
  // `residencies`; one row per bound artifact is narrower and gives history for
  // free. `html` renders in an <iframe srcdoc> (the tools inline their own
  // stylesheets, so browser Print → PDF just works); prefer `png` for anything
  // email-bound, because Gmail strips inline <svg>.
  await run(`
    CREATE TABLE IF NOT EXISTS spec_renders (
      id SERIAL PRIMARY KEY,
      file_id INTEGER NOT NULL,
      show_id INTEGER NOT NULL,
      node TEXT NOT NULL,
      spec_type TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      svg TEXT DEFAULT NULL,
      html TEXT DEFAULT NULL,
      png TEXT DEFAULT NULL,
      json JSONB DEFAULT NULL,
      tool_version TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS spec_renders_show_idx ON spec_renders(show_id, node);`);
  await run(`CREATE INDEX IF NOT EXISTS spec_renders_file_idx ON spec_renders(file_id);`);

  // ── 7. Flex gear state ──
  await run(`
    CREATE TABLE IF NOT EXISTS flex_state (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      linked BOOLEAN DEFAULT FALSE,
      pulled BOOLEAN DEFAULT FALSE,
      element_id TEXT DEFAULT NULL,
      gear_list_id TEXT DEFAULT NULL,
      gear_list_type TEXT DEFAULT 'pull-sheet',
      doc_number TEXT DEFAULT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS flex_state_uq ON flex_state(show_id);`);

  // ── 49. deliverables (the post-event client recap, extensible by `kind`) ──
  await run(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id SERIAL PRIMARY KEY,
      project_id INTEGER DEFAULT NULL,
      show_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'recap',
      status TEXT DEFAULT 'draft',
      body JSONB NOT NULL,
      generated_by TEXT DEFAULT '',
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      edited_by TEXT DEFAULT NULL,
      edited_at TIMESTAMPTZ DEFAULT NULL,
      approved_by TEXT DEFAULT NULL,
      approved_at TIMESTAMPTZ DEFAULT NULL,
      sent_at TIMESTAMPTZ DEFAULT NULL,
      sent_to TEXT DEFAULT NULL,
      provenance JSONB DEFAULT NULL
    );`);
  await run(`CREATE INDEX IF NOT EXISTS deliverables_show_kind_idx ON deliverables(show_id, kind);`);

  // ════════════════════════════════════════════════════════════════════════
  // F2. TECH SHOW REPORTS — a DEDICATED TABLE, not a deliverables kind
  // ────────────────────────────────────────────────────────────────────────
  // Three reasons this is its own table rather than `deliverables.kind =
  // 'tech_report'`:
  //
  //   1. THE FIREWALL. A recap is the one artifact that leaves the building,
  //      and the rule is that its generator must NEVER read a report body. If
  //      reports lived in `deliverables`, that rule would be a promise a future
  //      SELECT could break. In their own table it is a TOPOLOGY FACT — the
  //      same argument this codebase already makes for /api/agent/* — and
  //      lib/firewall.js now asserts it at runtime (guardRecapQuery).
  //   2. SHAPE. A report is per-PERSON and REQUIRED. `deliverables` has no
  //      username column and no obligation semantics; it has a JSONB body and
  //      a draft→approved→sent lifecycle that is wrong here (sign-off is NOT
  //      required — Tom, 2026-08-27). Bolting both on would leave every recap
  //      row carrying five columns it never uses.
  //   3. NAGGING. "who still owes theirs" is a JOIN against crew_assignments,
  //      and the natural key is (show_id, username) — which is a UNIQUE INDEX
  //      here and would be unenforceable in a shared, kind-discriminated table.
  //
  // The report BODY is plain text (escaped at render). An uploaded doc lands as
  // a `files` row of kind 'report' and is referenced by file_id; both forms are
  // "filed", which is what closeout counts.
  await run(`
    CREATE TABLE IF NOT EXISTS tech_reports (
      id SERIAL PRIMARY KEY,
      show_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      username TEXT NOT NULL,
      crew_assignment_id INTEGER DEFAULT NULL,
      role_on_site TEXT DEFAULT '',
      status TEXT DEFAULT 'owed',
      body TEXT DEFAULT '',
      file_id INTEGER DEFAULT NULL,
      due_date TEXT DEFAULT '',
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      filed_at TIMESTAMPTZ DEFAULT NULL,
      reviewed_by TEXT DEFAULT NULL,
      reviewed_at TIMESTAMPTZ DEFAULT NULL,
      last_nagged_at TIMESTAMPTZ DEFAULT NULL,
      nag_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS tech_reports_uq ON tech_reports(show_id, username);`);
  await run(`CREATE INDEX IF NOT EXISTS tech_reports_user_idx ON tech_reports(username, status);`);
  await run(`CREATE INDEX IF NOT EXISTS tech_reports_show_idx ON tech_reports(show_id);`);

  // ════════════════════════════════════════════════════════════════════════
  // F3. THE NOTIFICATION OUTBOX + per-user delivery preference
  // ────────────────────────────────────────────────────────────────────────
  // The bell is unchanged and remains the primary surface; this table is the
  // SECOND channel. Every real delivery (assignment · @mention · a notify-
  // picker pick · a report nag) ADDITIONALLY enqueues a row here, and a driver
  // flushes it. Nothing here can suppress a bell notification.
  //
  // `note_id` is what makes "skip if read in-app" possible: the flush joins
  // note_reads and marks the row skipped rather than mailing someone about a
  // thing they already read.
  await run(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT DEFAULT 'immediate',
      status TEXT DEFAULT 'queued',
      subject TEXT DEFAULT '',
      body TEXT DEFAULT '',
      link TEXT DEFAULT '',
      note_id INTEGER DEFAULT NULL,
      project_id INTEGER DEFAULT NULL,
      show_id INTEGER DEFAULT NULL,
      actor TEXT DEFAULT '',
      driver TEXT DEFAULT NULL,
      attempts INTEGER DEFAULT 0,
      last_error TEXT DEFAULT NULL,
      skipped_reason TEXT DEFAULT NULL,
      queued_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ DEFAULT NULL
    );`);
  await run(`CREATE INDEX IF NOT EXISTS outbox_user_idx ON notification_outbox(username, status);`);
  await run(`CREATE INDEX IF NOT EXISTS outbox_status_idx ON notification_outbox(status, mode);`);
  await run(`CREATE INDEX IF NOT EXISTS outbox_note_idx ON notification_outbox(note_id);`);
  await run(`CREATE INDEX IF NOT EXISTS outbox_show_idx ON notification_outbox(show_id);`);

  // One row per (user, kind) — and ONLY for a DEVIATION from the house default
  // (NOTIFY_DEFAULT_MODE in lib/enums.js). A user who never opens Settings has
  // no rows here and gets assignments+mentions immediately, the rest digested.
  await run(`
    CREATE TABLE IF NOT EXISTS notification_prefs (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS notification_prefs_uq ON notification_prefs(username, kind);`);

  // ── 54. client-safe recap stat keys, by FK not regex ──
  await run(`
    CREATE TABLE IF NOT EXISTS recap_stat_keys (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );`);

  // ── activity: audit trail + agent-action transparency ──
  await run(`
    CREATE TABLE IF NOT EXISTS activity (
      id SERIAL PRIMARY KEY,
      project_id INTEGER DEFAULT NULL,
      show_id INTEGER DEFAULT NULL,
      actor TEXT DEFAULT '',
      action TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await run(`CREATE INDEX IF NOT EXISTS activity_project_idx ON activity(project_id);`);
  await run(`CREATE INDEX IF NOT EXISTS activity_show_idx ON activity(show_id);`);
  await addCols(q, 'activity', {
    // 11. the front-end's accent flag.
    accent: 'BOOLEAN DEFAULT FALSE',
    po_id: 'INTEGER DEFAULT NULL',
    job_id: 'INTEGER DEFAULT NULL',
    provenance: 'JSONB DEFAULT NULL',
    // F3. The structured before→after: [{field,label,from,to}, …]. NULL on a
    // create/delete row and on anything routine — a diff is what a MATERIAL
    // update produces, and its absence is meaningful, not missing data.
    changes: 'JSONB DEFAULT NULL'
  });
  await run(`CREATE INDEX IF NOT EXISTS activity_po_idx ON activity(po_id);`);

  // ── config: server-side settings (28. po_approval_threshold) ──
  await run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT ''
    );`);

  return true;
}

// ADD COLUMN IF NOT EXISTS, one statement per column, so a partial failure
// never leaves half a table. Postgres 9.6+ supports the IF NOT EXISTS clause.
async function addCols(q, table, cols) {
  for (const [name, type] of Object.entries(cols)) {
    await q.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CASCADES — no SQL FKs, so EVERY table hangs off one of these three.
// Repeat because every build pass flagged it: a new table that is not listed
// here leaks rows on every folder delete.
// ════════════════════════════════════════════════════════════════════════════

// Everything that hangs off ONE purchase order.
async function deletePoCascade(c, poId) {
  await c.query(`DELETE FROM notes WHERE anchor_type='po' AND anchor_id=$1`, [poId]);
  await c.query(`DELETE FROM note_reads WHERE note_id NOT IN (SELECT id FROM notes)`);
  await c.query(`DELETE FROM note_mentions WHERE note_id NOT IN (SELECT id FROM notes)`);
  await c.query(`UPDATE expenses SET po_id=NULL WHERE po_id=$1`, [poId]);
  await c.query(`DELETE FROM po_lines WHERE po_id=$1`, [poId]);
  await c.query(`DELETE FROM activity WHERE po_id=$1`, [poId]);
  await c.query(`DELETE FROM purchase_orders WHERE id=$1`, [poId]);
}

// Everything that hangs off ONE show.
async function deleteShowCascade(c, showId) {
  const id = [showId];
  // notes anchored on this show's children, then on the show itself
  await c.query(`DELETE FROM notes WHERE anchor_type='step'
                 AND anchor_id IN (SELECT id FROM steps WHERE show_id=$1)`, id);
  await c.query(`DELETE FROM notes WHERE anchor_type='file'
                 AND anchor_id IN (SELECT id FROM files WHERE show_id=$1)`, id);
  await c.query(`DELETE FROM notes WHERE anchor_type='expense'
                 AND anchor_id IN (SELECT id FROM expenses WHERE show_id=$1)`, id);
  await c.query(`DELETE FROM notes WHERE (anchor_type='show' AND anchor_id=$1) OR show_id=$1`, id);
  await c.query(`DELETE FROM note_reads WHERE note_id NOT IN (SELECT id FROM notes)`);
  await c.query(`DELETE FROM note_mentions WHERE note_id NOT IN (SELECT id FROM notes)`);

  await c.query(`DELETE FROM proof_rounds WHERE proof_id IN (SELECT id FROM proofs WHERE show_id=$1)`, id);
  await c.query(`DELETE FROM proofs WHERE show_id=$1`, id);
  await c.query(`DELETE FROM steps WHERE show_id=$1`, id);
  await c.query(`DELETE FROM files WHERE show_id=$1`, id);
  await c.query(`DELETE FROM expenses WHERE show_id=$1`, id);
  await c.query(`DELETE FROM bookings WHERE show_id=$1`, id);
  await c.query(`DELETE FROM schedule_items WHERE show_id=$1`, id);
  await c.query(`DELETE FROM crew_assignments WHERE show_id=$1`, id);
  await c.query(`DELETE FROM deliverables WHERE show_id=$1`, id);
  await c.query(`DELETE FROM milestones WHERE show_id=$1`, id);
  await c.query(`DELETE FROM spec_chain WHERE show_id=$1`, id);
  // D2. A new table that is not listed here leaks rows on every folder delete.
  await c.query(`DELETE FROM spec_renders WHERE show_id=$1`, id);
  await c.query(`DELETE FROM flex_state WHERE show_id=$1`, id);
  await c.query(`DELETE FROM proposals WHERE show_id=$1`, id);
  // F2/F3. A new table that is not listed here leaks rows on every folder
  // delete — the rule this section exists to repeat.
  await c.query(`DELETE FROM tech_reports WHERE show_id=$1`, id);
  await c.query(`DELETE FROM notification_outbox WHERE show_id=$1`, id);
  await c.query(`UPDATE po_lines SET show_id=NULL WHERE show_id=$1`, id);
  await c.query(`DELETE FROM activity WHERE show_id=$1`, id);
  await c.query(`DELETE FROM shows WHERE id=$1`, id);
}

// Everything that hangs off ONE project — its shows (via the show cascade),
// its jobs and their budget lines, its purchase orders (via the PO cascade),
// and the project-level rows.
async function deleteProjectCascade(c, projectId) {
  const id = [projectId];
  const shows = await c.query('SELECT id FROM shows WHERE project_id=$1', id);
  for (const row of shows.rows) await deleteShowCascade(c, row.id);

  const pos = await c.query('SELECT id FROM purchase_orders WHERE project_id=$1', id);
  for (const row of pos.rows) await deletePoCascade(c, row.id);

  await c.query(`DELETE FROM notes WHERE anchor_type='job'
                 AND anchor_id IN (SELECT id FROM jobs WHERE project_id=$1)`, id);
  await c.query(`DELETE FROM notes WHERE (anchor_type='project' AND anchor_id=$1) OR project_id=$1`, id);
  await c.query(`DELETE FROM note_reads WHERE note_id NOT IN (SELECT id FROM notes)`);
  await c.query(`DELETE FROM note_mentions WHERE note_id NOT IN (SELECT id FROM notes)`);

  await c.query(`DELETE FROM budget_lines WHERE job_id IN (SELECT id FROM jobs WHERE project_id=$1)`, id);
  await c.query(`DELETE FROM jobs WHERE project_id=$1`, id);
  await c.query(`DELETE FROM steps WHERE project_id=$1`, id);
  await c.query(`DELETE FROM files WHERE project_id=$1`, id);
  await c.query(`DELETE FROM expenses WHERE project_id=$1`, id);
  await c.query(`DELETE FROM milestones WHERE project_id=$1`, id);
  await c.query(`DELETE FROM deliverables WHERE project_id=$1`, id);
  await c.query(`DELETE FROM proposals WHERE project_id=$1`, id);
  // F2/F3. project-scoped leftovers (a report or an outbox row whose show has
  // already gone takes its project_id with it).
  await c.query(`DELETE FROM tech_reports WHERE project_id=$1`, id);
  await c.query(`DELETE FROM notification_outbox WHERE project_id=$1`, id);
  await c.query(`DELETE FROM shows WHERE project_id=$1`, id);
  await c.query(`DELETE FROM activity WHERE project_id=$1`, id);
  await c.query(`DELETE FROM projects WHERE id=$1`, id);
}

// ── config helpers (28) ─────────────────────────────────────────────────────
async function getConfig(key, fallback = null, q = pool) {
  const r = await q.query('SELECT value FROM config WHERE key=$1', [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
async function setConfig(key, value, by = '', q = pool) {
  await q.query(
    `INSERT INTO config (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
    [key, String(value), by]
  );
}

module.exports = {
  pool, withTx, initDB, addCols,
  loadProject, loadShow, loadJob, loadRow, projectForRow, mintTempJobNumber,
  deleteShowCascade, deleteProjectCascade, deletePoCascade,
  getConfig, setConfig
};
