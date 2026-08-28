// ════════════════════════════════════════════════════════════════════════════
// routes/files.js — files (incl. financial docs), bookings, proofs,
//                   the spec-derivation chain, and Flex gear state
// ────────────────────────────────────────────────────────────────────────────
// Two-tier by design: METADATA in Postgres, BYTES on the NAS behind
// lib/storage.js. Nothing here ever opens a UNC path directly.
//
// Punch coverage: 1 (files.artifact), 2 (files.ver), 3 (files.dim),
// 6 (spec_chain — {gen, rev, derived_from_rev, by, when} per node, plus the
// stale-flagging rule from INTEGRATION.md), 7 (flex_state), 14 (proofs +
// proof_rounds), 15/19 (bookings with amount/booked_date/file_id), 23 (the
// widened kind whitelist + status + provenance), 29 (PO quote/invoice docs
// reuse the financial-doc columns; POs merely reference file ids).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadProject, loadShow, projectForRow } = require('../lib/db');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf } = require('../lib/http');
const { logActivity } = require('../lib/activity');
const { notifyTargets } = require('../lib/mentions');
const { storage, buildNasPath, MAX_BYTES } = require('../lib/storage');
const {
  pick, has, dbToFile, dbToBooking, dbToProof, dbToProofRound, dbToChainNode,
  dbToFlexState, dbToExpense
} = require('../lib/mappers');
const {
  FILE_KINDS, FIN_KINDS, FILE_ARTIFACTS, FILE_STATUSES_WRITABLE,
  FILE_STATUSES_HIDDEN, SPEC_TYPES, BUDGET_CATS,
  SPEC_NODE_FOR_TYPE, EXT_FOR_SPEC_TYPE,
  oneOf, money, intOrNull, isISODate, todayISO
} = require('../lib/enums');
// D7/D8 + the type sniff. The checker reports QUESTIONS, never errors — see
// lib/speccheck.js for why two correct specs can legitimately disagree.
const { typeMismatch, sanitizeSpecJson, checkChain } = require('../lib/speccheck');
// §7. The Flex client. Every call below it is a REAL call against a live BETA
// API — see lib/flex.js for the six bugs it works around.
const {
  flexConfigured, notConfigured, flexElementUrl, flexCreateEventFolder,
  flexListContacts, flexResolveContact, flexTimesNote, flexOmittedNote,
  flexIsFabricatedElementId
} = require('../lib/flex');

const router = express.Router();
router.use(requireAuth);

// ── 6. the derivation chain, and what "stale" means ─────────────────────────
//   content spec (.e360) --derives--> data cabling (.nsf) --derives-->
//   power (.pcfg) --derives--> Flex pull sheet
// A child is STALE when child.derived_from_rev !== parent.rev. Re-binding a
// parent bumps its rev, which makes every descendant stale until re-bound.
const CHAIN_NODES = ['content', 'cabling', 'power', 'pull'];
const CHAIN_UP = { content: null, cabling: 'content', power: 'cabling', pull: 'power' };

async function chainFor(showId, q = pool) {
  const r = await q.query('SELECT * FROM spec_chain WHERE show_id=$1', [showId]);
  const byNode = new Map(r.rows.map((x) => [x.node, x]));
  const out = {};
  for (const n of CHAIN_NODES) out[n] = dbToChainNode(byNode.get(n));
  // derive `stale` rather than storing it — one less thing to keep in sync
  for (const n of CHAIN_NODES) {
    const up = CHAIN_UP[n];
    out[n].stale = !!(up && out[n].gen && out[up].gen && out[n].derivedRev !== out[up].rev);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// FILES
// ════════════════════════════════════════════════════════════════════════════
// HARDENING 6. The default listing hides files that are HISTORY rather than
// inventory — rejected AND superseded. `superseded` was missing from the enum
// entirely, so a spec rev that had been retired by a later bind kept listing
// next to the live one; the Files tab showed three "current" cabling specs.
// Both retired statuses stay reachable by asking for them by name
// (?status=superseded), which is what the revision history needs.
router.get('/files', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
  const projectId = intOrNull(pick(req.query, 'project_id'));
  const showId = intOrNull(pick(req.query, 'show_id'));
  if (projectId) add('project_id=$?', projectId);
  if (showId) add('show_id=$?', showId);
  if (req.query.kind) add('kind=$?', req.query.kind);
  if (req.query.spec_type || req.query.specType) add('spec_type=$?', req.query.spec_type || req.query.specType);
  if (req.query.status) add('status=$?', req.query.status);
  else add('NOT (status = ANY($?::text[]))', FILE_STATUSES_HIDDEN);
  if (req.query.chain_key || req.query.chainKey) add('chain_key=$?', req.query.chain_key || req.query.chainKey);
  if (String(req.query.financial) === '1') add('kind = ANY($?::text[])', FIN_KINDS);
  params.push(limitOf(req, 200, 1000));
  const r = await pool.query(
    `SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params);
  res.json(r.rows.map(dbToFile));
}));

router.get('/files/:id', asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM files WHERE id=$1', [idParam(req)]);
  if (!r.rows.length) throw notFound();
  res.json(dbToFile(r.rows[0]));
}));

// Register a file's metadata. tech+ may add (they upload confirmations, proofs
// and photos); nas_path is ALWAYS server-derived — a client may not supply one,
// or a caller could write bytes into somebody else's folder.
//
// This one route also covers api.addFinancialDoc(): pass `amount` and it
// creates the matching `expenses` row; pass `expense_id` / `booking_id` /
// `po_id` and it attaches as that item's missing paperwork instead. That
// mirrors AGENT_API §3 exactly, so the human and agent paths cannot drift.
router.post('/files', requireRole('tech'), asyncH(async (req, res) => {
  const b = req.body || {};
  const name = pick(b, 'name');
  if (!name) throw badRequest('name required');
  const showId = intOrNull(pick(b, 'show_id'));
  const projectId = intOrNull(pick(b, 'project_id'));
  if (!showId && !projectId) throw badRequest('project_id or show_id required');

  const show = showId ? await loadShow(showId) : null;
  if (showId && !show) throw notFound('Show not found');
  const project = show ? await loadProject(show.project_id) : await loadProject(projectId);
  if (!project) throw notFound('Parent project/show not found');

  const kind = oneOf(pick(b, 'kind'), FILE_KINDS, 'other');
  const specType = SPEC_TYPES.includes(pick(b, 'spec_type')) ? pick(b, 'spec_type') : null;
  const artifact = FILE_ARTIFACTS.includes(pick(b, 'artifact')) ? pick(b, 'artifact') : null;
  const amount = money(pick(b, 'amount'), null);
  const docDate = pick(b, 'doc_date') || null;
  if (docDate && !isISODate(docDate)) throw badRequest('doc_date must be YYYY-MM-DD');

  const linkExpenseId = intOrNull(pick(b, 'expense_id'));
  const linkBookingId = intOrNull(pick(b, 'booking_id'));
  const linkPoId = intOrNull(pick(b, 'po_id'));
  const chainKey = pick(b, 'chain_key') || null;
  const replaceChain = !!pick(b, 'replace_chain') && !!chainKey;

  const out = await withTx(async (c) => {
    // api.replaceChainFile(): a new spec supersedes the old one on that chain
    // node. The superseded row is marked, never silently deleted.
    if (replaceChain && show) {
      await c.query(
        `UPDATE files SET status='superseded' WHERE show_id=$1 AND chain_key=$2 AND status='filed'`,
        [show.id, chainKey]);
    }
    const vendor = pick(b, 'vendor') || null;
    const jobId = has(b, 'job_id') ? intOrNull(pick(b, 'job_id')) : null;
    const nasPath = buildNasPath(project, show, { kind, name, ext: pick(b, 'ext') || '' });

    const ins = await c.query(
      `INSERT INTO files (project_id, show_id, name, ext, kind, spec_type, artifact, ver, dim, meta,
         chain_key, nas_path, size, uploaded_by, amount, vendor, doc_date, job_id, attached_to,
         status, provenance, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [show ? null : project.id, show ? show.id : null, name, pick(b, 'ext') || '', kind, specType,
       artifact, pick(b, 'ver') || 'v1', pick(b, 'dim') || null, pick(b, 'meta') || '',
       chainKey, nasPath, parseInt(pick(b, 'size'), 10) || 0, req.session.username,
       amount, vendor, docDate, jobId, intOrNull(pick(b, 'attached_to')),
       oneOf(pick(b, 'status'), FILE_STATUSES_WRITABLE, 'filed'),
       pick(b, 'provenance') ? JSON.stringify(pick(b, 'provenance')) : null,
       pick(b, 'source_ref') || null]
    );
    const file = ins.rows[0];
    const created = { file_id: file.id, expense_id: null };

    // ── the financial-doc flow (mirrors api.addFinancialDoc) ────────────────
    if (linkPoId) {
      // 29/PO paperwork — NEVER a second expense: the PO owns its cost rows.
      const po = (await c.query('SELECT * FROM purchase_orders WHERE id=$1', [linkPoId])).rows[0];
      if (!po) throw notFound('PO not found');
      if (kind === 'invoice') {
        await c.query('UPDATE purchase_orders SET invoice_file_id=$1, updated_at=NOW() WHERE id=$2',
          [file.id, po.id]);
        await c.query('UPDATE expenses SET file_id=$1 WHERE po_id=$2 AND file_id IS NULL',
          [file.id, po.id]);
        if (po.status === 'received') {
          await c.query(`UPDATE purchase_orders SET status='reconciled', updated_at=NOW() WHERE id=$1`, [po.id]);
          await logActivity(c, { poId: po.id, projectId: po.project_id, actor: req.actor,
            action: 'po.reconcile', detail: `${po.po_number} — vendor invoice on file`, accent: true });
        }
      } else if (!po.quote_file_id) {
        await c.query('UPDATE purchase_orders SET quote_file_id=$1, updated_at=NOW() WHERE id=$2',
          [file.id, po.id]);
      }
      await logActivity(c, { poId: po.id, projectId: po.project_id, actor: req.actor,
        action: 'file.add', detail: `${kind}: ${name}` });
    } else if (linkExpenseId) {
      await c.query('UPDATE expenses SET file_id=$1 WHERE id=$2', [file.id, linkExpenseId]);
    } else if (linkBookingId) {
      // 19. a booking's paperwork clears its exception; with an amount it also
      // books the actual, because a confirmed booking with money on it IS a cost.
      const bk = (await c.query('SELECT * FROM bookings WHERE id=$1', [linkBookingId])).rows[0];
      if (!bk) throw notFound('Booking not found');
      await c.query('UPDATE bookings SET file_id=$1 WHERE id=$2', [file.id, bk.id]);
      if (amount != null && show) {
        created.expense_id = await insertExpense(c, {
          show, projectId: project.id, jobId: bk.job_id || jobId, category: pick(b, 'category'),
          vendor: vendor || bk.vendor, amount, fileId: file.id, by: req.session.username,
          memo: pick(b, 'memo') || '', status: 'filed'
        });
      }
    } else if (amount != null && show) {
      created.expense_id = await insertExpense(c, {
        show, projectId: project.id, jobId, category: pick(b, 'category'), vendor, amount,
        fileId: file.id, by: req.session.username, memo: pick(b, 'memo') || '', status: 'filed'
      });
    }

    if (!linkPoId) {
      await logActivity(c, { projectId: project.id, showId: show ? show.id : null, actor: req.actor,
        action: 'file.add', detail: `${kind}: ${name}`, accent: FIN_KINDS.includes(kind) });
    }
    // Filing a doc is exactly the kind of "significant action" the notify
    // picker is for — a receipt someone has been chasing, a proof that just
    // landed. Anchored on the FILE so the thread lives where the doc does.
    await notifyTargets(c, {
      body: b, anchorType: 'file', anchorId: file.id,
      projectId: project.id, showId: show ? show.id : null, actor: req.actor,
      summary: `filed a ${kind} — “${name}” —`
    });
    return { file, created };
  });
  res.json({ ...dbToFile(out.file), created: out.created,
             upload_url: `/api/files/${out.file.id}/content` });
}));

// One place that writes an expense row, so the human and agent paths produce
// identical rows.
async function insertExpense(c, { show, projectId, jobId, category, vendor, amount, fileId,
                                  by, memo, status = 'filed', provenance = null, poId = null }) {
  const cat = BUDGET_CATS.includes(category) ? category : 'misc';
  const r = await c.query(
    `INSERT INTO expenses (show_id, project_id, job_id, budget_line_category, category, vendor,
       amount, txn_date, status, file_id, by, memo, po_id, provenance)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [show ? show.id : null, projectId, jobId || null, cat, vendor || '', amount,
     todayISO(), status, fileId || null, by || null, memo || '', poId,
     provenance ? JSON.stringify(provenance) : null]);
  return r.rows[0].id;
}

router.put('/files/:id', asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM files WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const project = await projectForRow(cur);
  const isUploader = cur.uploaded_by === req.session.username;
  if (!canEditProject(req.session, project) && !isUploader) {
    throw forbidden('Not allowed to edit this file');
  }
  const b = req.body || {};
  const kind = oneOf(pick(b, 'kind'), FILE_KINDS, cur.kind);
  const specType = has(b, 'spec_type')
    ? (SPEC_TYPES.includes(pick(b, 'spec_type')) ? pick(b, 'spec_type') : null) : cur.spec_type;
  const r = await pool.query(
    `UPDATE files SET name=$1, ext=$2, kind=$3, spec_type=$4, artifact=$5, ver=$6, dim=$7, meta=$8,
       size=$9, amount=$10, vendor=$11, doc_date=$12, job_id=$13 WHERE id=$14 RETURNING *`,
    [pick(b, 'name', cur.name), pick(b, 'ext', cur.ext), kind, specType,
     has(b, 'artifact') ? (FILE_ARTIFACTS.includes(pick(b, 'artifact')) ? pick(b, 'artifact') : null) : cur.artifact,
     pick(b, 'ver', cur.ver), has(b, 'dim') ? pick(b, 'dim') : cur.dim, pick(b, 'meta', cur.meta),
     has(b, 'size') ? (parseInt(pick(b, 'size'), 10) || 0) : cur.size,
     has(b, 'amount') ? money(pick(b, 'amount'), null) : cur.amount,
     has(b, 'vendor') ? pick(b, 'vendor') : cur.vendor,
     has(b, 'doc_date') ? pick(b, 'doc_date') : cur.doc_date,
     has(b, 'job_id') ? intOrNull(pick(b, 'job_id')) : cur.job_id, cur.id]
  );
  res.json(dbToFile(r.rows[0]));
}));

// Bytes. Metadata-first means a failed upload leaves a resolvable record, not
// a ghost row (AGENT_API §3).
router.put('/files/:id/content',
  express.raw({ type: () => true, limit: MAX_BYTES }),
  asyncH(async (req, res) => {
    const cur = (await pool.query('SELECT * FROM files WHERE id=$1', [idParam(req)])).rows[0];
    if (!cur) throw notFound();
    const project = await projectForRow(cur);
    if (!canEditProject(req.session, project) && cur.uploaded_by !== req.session.username) {
      throw forbidden('Not allowed to upload to this file');
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Empty body');
    const result = await storage.put(cur.nas_path, req.body);
    await pool.query('UPDATE files SET size=$1 WHERE id=$2', [result.size, cur.id]);
    res.json({ ok: true, size: result.size, nas_path: cur.nas_path });
  }));

router.delete('/files/:id', asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM files WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const project = await projectForRow(cur);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to delete this file');
  await withTx(async (c) => {
    await c.query(`DELETE FROM notes WHERE anchor_type='file' AND anchor_id=$1`, [cur.id]);
    await c.query(`DELETE FROM note_reads WHERE note_id NOT IN (SELECT id FROM notes)`);
    await c.query(`DELETE FROM note_mentions WHERE note_id NOT IN (SELECT id FROM notes)`);
    await c.query('UPDATE expenses SET file_id=NULL WHERE file_id=$1', [cur.id]);
    await c.query('UPDATE bookings SET file_id=NULL WHERE file_id=$1', [cur.id]);
    await c.query('UPDATE purchase_orders SET quote_file_id=NULL WHERE quote_file_id=$1', [cur.id]);
    await c.query('UPDATE purchase_orders SET invoice_file_id=NULL WHERE invoice_file_id=$1', [cur.id]);
    // HARDENING 7. A spec RENDER is a projection OF this file — its svg/html/png
    // for the email-bound view — and spec_renders.file_id is NOT NULL, so it
    // cannot be orphaned the way expenses.file_id can. It goes with the file.
    // (deleteShowCascade already does the same by show_id; this is the
    // single-file path, which was missing it.)
    await c.query('DELETE FROM spec_renders WHERE file_id=$1', [cur.id]);
    await c.query('DELETE FROM files WHERE id=$1', [cur.id]);
  });
  // NOTE: only the DB metadata row goes. The NAS byte-file is left in place;
  // a housekeeping pass (or an operator) removes it from disk deliberately.
  await logActivity(pool, { projectId: project ? project.id : null, showId: cur.show_id,
    actor: req.actor, action: 'file.delete', detail: cur.name });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// 6. SPEC DERIVATION CHAIN
// ════════════════════════════════════════════════════════════════════════════
router.get('/shows/:id/chain', asyncH(async (req, res) => {
  res.json(await chainFor(idParam(req)));
}));

// Binding (or re-binding) a node bumps its rev and records what it was derived
// against, which is what makes every descendant computably stale.
router.put('/shows/:id/chain/:node', requireRole('pm'), asyncH(async (req, res) => {
  const showId = idParam(req);
  const node = String(req.params.node);
  if (!CHAIN_NODES.includes(node)) throw badRequest(`Unknown chain node '${node}'`);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to modify this show');

  const b = req.body || {};
  const out = await withTx(async (c) => {
    const chain = await chainFor(showId, c);
    const up = CHAIN_UP[node];
    const gen = has(b, 'gen') ? !!pick(b, 'gen') : true;
    const bump = gen && (!chain[node].gen || pick(b, 'rebind') !== false);
    const rev = has(b, 'rev') ? (parseInt(pick(b, 'rev'), 10) || 0)
                              : (bump ? (chain[node].rev || 0) + 1 : chain[node].rev);
    const derived = up ? chain[up].rev : 0;
    await c.query(
      `INSERT INTO spec_chain (show_id, node, gen, rev, derived_from_rev, by, when_at, file_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (show_id, node) DO UPDATE SET gen=EXCLUDED.gen, rev=EXCLUDED.rev,
         derived_from_rev=EXCLUDED.derived_from_rev, by=EXCLUDED.by, when_at=EXCLUDED.when_at,
         file_id=COALESCE(EXCLUDED.file_id, spec_chain.file_id), updated_at=NOW()`,
      [showId, node, gen, rev, derived, req.actor, pick(b, 'when') || todayISO(),
       intOrNull(pick(b, 'file_id'))]);
    await logActivity(c, { projectId: show.project_id, showId, actor: req.actor,
      action: 'chain.bind', detail: `${node} → v${rev}`, accent: true });
    // Re-binding a spec makes every DOWNSTREAM node stale, which is somebody
    // else's problem to act on — so this is one of the few places a notify is
    // genuinely load-bearing rather than noise.
    await notifyTargets(c, {
      body: b, anchorType: 'show', anchorId: showId,
      projectId: show.project_id, showId, actor: req.actor,
      summary: `bound the ${node} spec at v${rev} (anything downstream is now stale) —`
    });
    return chainFor(showId, c);
  });
  res.json(out);
}));

// ════════════════════════════════════════════════════════════════════════════
// D1. POST /api/shows/:id/spec-bind — the ATOMIC bind
// ────────────────────────────────────────────────────────────────────────────
// The three browser tools (Spec Sheet Generator, NovaSpec, PowerSpec) open a
// first-party Showrunner popup and postMessage their render bundle into it; the
// popup — carrying the operator's own session — posts it here. The tools never
// hold a credential, which is the whole reason for the popup pattern: they are
// static files on a public Caddy file-server, so anything embedded in them is
// world-readable (§9.3.1/C6).
//
// This endpoint exists to make the bind ATOMIC. Composing the three existing
// calls from the browser (POST /files → PUT /files/:id/content → PUT
// /shows/:id/chain/:node) would leave a half-bound show on any mid-sequence
// failure, and would push a multi-megabyte payload over three round trips.
//
// Two things the staffing app's equivalent does NOT do, and both matter:
//   · it TYPE-SNIFFS the document against its declared type. staffing validates
//     only that `type` is one of three and `svg` starts with '<svg', which is
//     how a .nsf gets filed as a .e360 and the chain silently corrupts (T4).
//   · it SUPERSEDES rather than overwrites. staffing's bind is a blind UPDATE
//     of four columns with a client-side confirm() as its only guard — no
//     revision, no history, no staleness.
//
// Binding a parent bumps its rev, and chainFor derives `stale` as
// `up && node.gen && up.gen && node.derivedRev !== up.rev` — so binding a .e360
// marks the .nsf, .pcfg and pull sheet stale with NO extra code here.
// ════════════════════════════════════════════════════════════════════════════
// The latest render bundle per node for a show — the checker's input, and the
// reason spec_renders keeps `json`: a consistency check never touches the NAS.
async function boundSpecDocs(showId, q = pool) {
  const r = await q.query(
    `SELECT DISTINCT ON (node) node, spec_type, json, rev, file_id, created_at
       FROM spec_renders WHERE show_id=$1 ORDER BY node, rev DESC, id DESC`, [showId]);
  const docs = {};
  const meta = {};
  for (const row of r.rows) {
    if (row.json) docs[row.spec_type] = row.json;
    meta[row.node] = { specType: row.spec_type, rev: row.rev, fileId: row.file_id,
                       boundAt: row.created_at };
  }
  return { docs, meta };
}

router.post('/shows/:id/spec-bind', requireRole('pm'), asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to bind a spec to this show');

  const b = req.body || {};
  const specType = pick(b, 'spec_type') || pick(b, 'specType');
  if (!SPEC_TYPES.includes(specType)) {
    throw badRequest(`specType must be one of: ${SPEC_TYPES.join(', ')}`);
  }
  const node = SPEC_NODE_FOR_TYPE[specType];
  const ext = EXT_FOR_SPEC_TYPE[specType];

  // 1. envelope validation
  let json = pick(b, 'json');
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw badRequest('json must be the spec document object');
  }
  const svg = pick(b, 'svg') || '';
  if (svg && (typeof svg !== 'string' || !svg.trim().startsWith('<svg'))) {
    throw badRequest("svg must be a string starting with '<svg'");
  }
  const pageHtml = pick(b, 'pageHtml') || pick(b, 'html') || '';
  if (pageHtml && typeof pageHtml !== 'string') throw badRequest('pageHtml must be a string');
  const png = pick(b, 'png') || '';
  if (png && !/^data:image\/png;base64,/.test(String(png))) {
    throw badRequest("png must be a 'data:image/png;base64,…' data URL");
  }

  // 2. the type sniff — four lines that prevent a whole class of silent
  //    chain corruption. The producers' own load-time guards, applied here.
  const mismatch = typeMismatch(specType, json);
  if (mismatch) throw badRequest(mismatch);

  // D8. the .e360 client-logo MIME gate. A stored spec is attacker-influenced
  // input the moment anyone can upload one, and the tool's own gate exists
  // specifically to stop `data:image/svg+xml,<svg onload=…>`. A bad logo does
  // not fail an otherwise-good bind — it simply does not survive into a render
  // path, and the caller is told.
  const sanitized = sanitizeSpecJson(json);
  json = sanitized.json;

  const name = String(pick(b, 'suggestedName') || show.name || project.name || 'spec').trim().slice(0, 120);
  const toolVersion = String(pick(b, 'toolVersion') || '').slice(0, 64);
  const sourceUrl = String(pick(b, 'sourceUrl') || '').slice(0, 500);
  const bytes = Buffer.from(JSON.stringify(json, null, 2), 'utf8');

  const out = await withTx(async (c) => {
    // 3. SUPERSEDE, never delete. Same semantics as POST /files' replace_chain.
    const sup = await c.query(
      `UPDATE files SET status='superseded' WHERE show_id=$1 AND chain_key=$2 AND status='filed'
       RETURNING id`, [showId, node]);
    const supersededFileIds = sup.rows.map((r) => r.id);

    // 4. the files row. nas_path is ALWAYS server-derived — a caller may not
    //    supply one, or bytes land in somebody else's folder.
    const nasPath = buildNasPath(project, show, { kind: 'spec', name, ext });
    const ins = await c.query(
      `INSERT INTO files (project_id, show_id, name, ext, kind, spec_type, artifact, ver, meta,
         chain_key, nas_path, size, uploaded_by, status, source_ref)
       VALUES (NULL,$1,$2,$3,'spec',$4,'document',$5,$6,$7,$8,$9,$10,'filed',$11)
       RETURNING *`,
      [showId, name, ext, specType, `v${supersededFileIds.length + 1}`,
       [toolVersion ? `tool ${toolVersion}` : '', sanitized.stripped ? 'logo stripped' : '']
         .filter(Boolean).join('; '),
       node, nasPath, bytes.length, req.session.username, sourceUrl || null]);
    const file = ins.rows[0];

    // 5. the bytes — byte-identical to what the tool's own Save button writes.
    await storage.put(nasPath, bytes);

    // 6/7. the chain upsert, identical to PUT /shows/:id/chain/:node.
    const chainBefore = await chainFor(showId, c);
    const up = CHAIN_UP[node];
    const rev = (chainBefore[node].rev || 0) + 1;
    const derived = up ? chainBefore[up].rev : 0;
    await c.query(
      `INSERT INTO spec_chain (show_id, node, gen, rev, derived_from_rev, by, when_at, file_id, updated_at)
       VALUES ($1,$2,TRUE,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (show_id, node) DO UPDATE SET gen=TRUE, rev=EXCLUDED.rev,
         derived_from_rev=EXCLUDED.derived_from_rev, by=EXCLUDED.by, when_at=EXCLUDED.when_at,
         file_id=EXCLUDED.file_id, updated_at=NOW()`,
      [showId, node, rev, derived, req.actor, todayISO(), file.id]);

    // D2. the render bundle. One row per bind, so history comes free.
    await c.query(
      `INSERT INTO spec_renders (file_id, show_id, node, spec_type, rev, svg, html, png, json,
         tool_version, source_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
      [file.id, showId, node, specType, rev, svg || null, pageHtml || null, png || null,
       JSON.stringify(json), toolVersion, sourceUrl, req.actor]);

    await logActivity(c, {
      projectId: show.project_id, showId, actor: req.actor, action: 'chain.bind',
      detail: `${node} → v${rev}` + (supersededFileIds.length ? ` (superseded ${supersededFileIds.length})` : ''),
      accent: true,
      provenance: sourceUrl ? { source_kind: 'manual', source_label: `bound from ${specType} tool`,
                                source_url: sourceUrl } : null
    });

    const chain = await chainFor(showId, c);
    const { docs } = await boundSpecDocs(showId, c);
    return { file, rev, chain, supersededFileIds, nasPath, docs };
  });

  // D7. The stack-aware checker runs over EVERY spec now bound to this show,
  // and reports questions — never errors. See lib/speccheck.js for why.
  const check = checkChain(out.docs);
  const stale = Object.fromEntries(Object.entries(out.chain).map(([k, v]) => [k, !!v.stale]));

  res.json({
    ok: true,
    fileId: out.file.id,
    node,
    specType,
    rev: out.rev,
    ext,
    nasPath: out.nasPath,
    supersededFileIds: out.supersededFileIds,
    logoStripped: sanitized.stripped,
    stale,
    chain: out.chain,
    check,
    // what the popup echoes back to the tool as {type:'bind-complete', …}
    showId, showName: show.name || project.name
  });
}));

// D2. The render bundle for a node, at its CURRENT rev. `html` is meant for an
// <iframe srcdoc> — the tools inline their own stylesheets, so browser Print →
// PDF works with no further work. Prefer `png` for anything email-bound.
router.get('/shows/:id/spec-render/:node', asyncH(async (req, res) => {
  const showId = idParam(req);
  const node = String(req.params.node);
  if (!CHAIN_NODES.includes(node)) throw badRequest(`Unknown chain node '${node}'`);
  if (!(await loadShow(showId))) throw notFound('Show not found');
  const r = await pool.query(
    `SELECT * FROM spec_renders WHERE show_id=$1 AND node=$2 ORDER BY rev DESC, id DESC LIMIT 1`,
    [showId, node]);
  if (!r.rows.length) throw notFound(`Nothing is bound to the '${node}' node of this show`);
  const row = r.rows[0];
  res.json({
    node, specType: row.spec_type, rev: row.rev, fileId: row.file_id,
    json: row.json, svg: row.svg || '', html: row.html || '', png: row.png || '',
    toolVersion: row.tool_version || '', sourceUrl: row.source_url || '',
    createdBy: row.created_by || '', createdAt: row.created_at
  });
}));

// D7. The checker as its own endpoint, so the UI can ask at any time rather
// than only at bind time.
router.get('/shows/:id/spec-check', asyncH(async (req, res) => {
  const showId = idParam(req);
  if (!(await loadShow(showId))) throw notFound('Show not found');
  const { docs, meta } = await boundSpecDocs(showId);
  res.json({ ...checkChain(docs), nodes: meta, chain: await chainFor(showId) });
}));

// ════════════════════════════════════════════════════════════════════════════
// 7. FLEX GEAR STATE — and, since 2026-08-27, the REAL Event Folder create
// ════════════════════════════════════════════════════════════════════════════
// This section stores the STATE the UI reads (linked / pulled / element_id /
// gear_list_id / doc_number) AND owns the one route that actually writes into
// Flex. The header used to say "the Flex API client is deliberately NOT built
// here"; that was true until the button that claimed to create a folder was
// found fabricating a UUID in the browser, persisting it, and toasting success.
// `POST /shows/:id/flex/create-element` below is the honest version: it calls
// lib/flex.js, and the id it stores is the id FLEX RETURNED or nothing at all.

// ONE gear payload, used by all four gear routes. The deep link is DERIVED,
// never stored — one env-var change relocates every link in the app — and it is
// absent (rather than broken) when Flex is unconfigured or nothing real is
// linked, so the UI can tell "no folder" from "no address for the folder".
function gearPayload(row, show) {
  const showId = show.id;
  const state = dbToFlexState(row, showId);
  const fabricated = flexIsFabricatedElementId(state.elementId);
  let deepLink = '';
  if (state.elementId && !fabricated && flexConfigured()) {
    try { deepLink = flexElementUrl(state.elementId); } catch (_) { deepLink = ''; }
  }
  return { ...state, cabinets: show.cabinets || 0, deepLink, fabricated };
}

router.get('/shows/:id/gear', asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  const r = await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [showId]);
  res.json(gearPayload(r.rows[0], show));
}));

// POST /api/shows/:id/flex/create-element
//   body: { create_contacts?: boolean }   (default TRUE — Tom, 2026-08-27)
//
// Guard order is deliberate: role, then configuration, then existence, then
// ownership, then the 409. The configuration answer is an OPS answer and comes
// before any database work; it names the variables that are missing.
router.post('/shows/:id/flex/create-element', requireRole('pm'), asyncH(async (req, res) => {
  const missing = ['FLEX_BASE_URL', 'FLEX_API_KEY'].filter((v) => !process.env[v]);
  if (missing.length) throw notConfigured(missing.join(' and '));

  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  const project = await loadProject(show.project_id);
  if (!canEditProject(req.session, project)) throw forbidden();

  const cur = (await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [showId])).rows[0] || {};
  if (cur.linked && cur.element_id && !flexIsFabricatedElementId(cur.element_id)) {
    const e = new Error(
      `This show is already linked to Flex Event Folder ${cur.element_id}. ` +
      `Unlink it first if you really want a second folder — a duplicate folder is ` +
      `a duplicate pull sheet, and the warehouse will pick from whichever it finds.`);
    e.status = 409;
    throw e;
  }

  // ── the payload, from show + project (the 19-field map) ───────────────────
  // A folder needs a start date. Load-in is the real one; the event date is the
  // fallback, and it goes in as a SHIP-OUT source so it moves plannedStartDate
  // WITHOUT inventing a load-in the show does not have.
  const loadInDate = show.load_in_date || null;
  const strikeDate = show.strike_date || null;
  const eventDate = show.event_date || null;
  if (!loadInDate && !eventDate) {
    throw badRequest('This show has neither a load-in date nor an event date. ' +
      'Flex requires a start date on an Event Folder — set one on the show first.');
  }

  // The show's name is the folder's name — it is the string every human on the
  // job already uses. Only a nameless show falls back to the project.
  const rawName = (show.name && String(show.name).trim()) ||
    (project && project.name) || `Show ${showId}`;

  const createContacts = has(req.body || {}, 'create_contacts')
    ? !!pick(req.body || {}, 'create_contacts')
    : true;

  // One directory read, reused for both lookups — 24 rows, filters ignored.
  let directory = null;
  let directoryError = '';
  try { directory = await flexListContacts(); }
  catch (e) { directory = []; directoryError = e.message; }

  const contacts = {
    client: await flexResolveContact(project && project.client, {
      directory, create: createContacts, label: 'client' }),
    venue: await flexResolveContact(show.venue, {
      directory, create: createContacts, label: 'venue' })
  };
  if (directoryError) {
    for (const k of ['client', 'venue']) {
      if (contacts[k].outcome === 'omitted' && !/directory/.test(contacts[k].reason)) {
        contacts[k].reason += ` (the contact directory read failed first: ${directoryError})`;
      }
    }
  }

  const timesNote = flexTimesNote({
    eventDate, doorsTime: show.doors_time, showTime: show.event_time, strikeTime: show.strike_time });
  const omittedNote = flexOmittedNote(contacts);
  const notes = [timesNote, omittedNote].filter(Boolean).join('\n');

  const made = await flexCreateEventFolder({
    event: rawName,
    notes,
    setup: loadInDate,
    setupTime: show.load_in_time || null,
    breakdown: strikeDate,
    // fallbacks ONLY — with a load-in / strike present these stay undefined and
    // the staffing derivation is byte-for-byte what it always was.
    shipOutDate: loadInDate ? null : eventDate,
    shipReturnDate: strikeDate ? null : eventDate,
    clientId: contacts.client.id,
    venueId: contacts.venue.id
  });

  if (!made.elementId) {
    const e = new Error('Flex accepted the request but returned no elementId — nothing was linked.');
    e.status = 502;
    throw e;
  }

  const saved = await pool.query(
    `INSERT INTO flex_state (show_id, linked, pulled, element_id, gear_list_id, gear_list_type, doc_number)
     VALUES ($1,TRUE,$2,$3,$4,$5,$6)
     ON CONFLICT (show_id) DO UPDATE SET linked=TRUE, element_id=EXCLUDED.element_id,
       doc_number=EXCLUDED.doc_number, updated_at=NOW()
     RETURNING *`,
    [showId, !!cur.pulled, made.elementId, cur.gear_list_id || null,
     cur.gear_list_type || 'pull-sheet', made.elementNumber || cur.doc_number || null]);

  const outcomeLine = `client ${contacts.client.outcome} · venue ${contacts.venue.outcome}`;
  await logActivity(pool, { projectId: show.project_id, showId, actor: req.actor,
    action: 'flex.create',
    detail: `Flex Event Folder created — ${made.payload.name} (${made.elementId}) · ${outcomeLine}` });

  res.json({
    ok: true,
    elementId: made.elementId,
    elementNumber: made.elementNumber,
    deepLink: flexElementUrl(made.elementId),
    name: made.payload.name,
    notes,
    contacts,
    createContacts,
    dates: {
      plannedStartDate: made.payload.plannedStartDate,
      plannedEndDate: made.payload.plannedEndDate,
      loadInDate: made.payload.loadInDate || null,
      loadOutDate: made.payload.loadOutDate || null
    },
    gear: gearPayload(saved.rows[0], show)
  });
}));

// Unlink — the honest counterpart to the 409 above, and the only way to clear a
// fabricated id left behind by the prototype. It does NOT delete anything in
// Flex; it forgets the pointer.
router.delete('/shows/:id/flex/element', requireRole('pm'), asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  if (!canEditProject(req.session, await loadProject(show.project_id))) throw forbidden();
  const r = await pool.query(
    `UPDATE flex_state SET linked=FALSE, element_id=NULL, updated_at=NOW()
     WHERE show_id=$1 RETURNING *`, [showId]);
  if (!r.rows.length) return res.json(gearPayload(null, show));
  await logActivity(pool, { projectId: show.project_id, showId, actor: req.actor,
    action: 'flex.unlink', detail: 'Flex Event Folder unlinked (the folder itself is untouched)' });
  res.json(gearPayload(r.rows[0], show));
}));

router.put('/shows/:id/gear', requireRole('tech'), asyncH(async (req, res) => {
  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  const b = req.body || {};
  const cur = (await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [showId])).rows[0] || {};
  const r = await pool.query(
    `INSERT INTO flex_state (show_id, linked, pulled, element_id, gear_list_id, gear_list_type, doc_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (show_id) DO UPDATE SET linked=EXCLUDED.linked, pulled=EXCLUDED.pulled,
       element_id=EXCLUDED.element_id, gear_list_id=EXCLUDED.gear_list_id,
       gear_list_type=EXCLUDED.gear_list_type, doc_number=EXCLUDED.doc_number, updated_at=NOW()
     RETURNING *`,
    [showId, has(b, 'linked') ? !!pick(b, 'linked') : !!cur.linked,
     has(b, 'pulled') ? !!pick(b, 'pulled') : !!cur.pulled,
     has(b, 'element_id') ? pick(b, 'element_id') : (cur.element_id || null),
     has(b, 'gear_list_id') ? pick(b, 'gear_list_id') : (cur.gear_list_id || null),
     pick(b, 'gear_list_type') || cur.gear_list_type || 'pull-sheet',
     has(b, 'doc_number') ? pick(b, 'doc_number') : (cur.doc_number || null)]);
  await logActivity(pool, { projectId: show.project_id, showId, actor: req.actor,
    action: 'gear.update', detail: r.rows[0].pulled ? 'pull sheet built' : 'Flex state updated' });
  res.json(gearPayload(r.rows[0], show));
}));

// ════════════════════════════════════════════════════════════════════════════
// 15/19. BOOKINGS (Showrunner-side)
// ════════════════════════════════════════════════════════════════════════════
router.get('/bookings', asyncH(async (req, res) => {
  const showId = intOrNull(pick(req.query, 'show_id'));
  const r = showId
    ? await pool.query('SELECT * FROM bookings WHERE show_id=$1 ORDER BY id', [showId])
    : await pool.query('SELECT * FROM bookings ORDER BY id DESC LIMIT $1', [limitOf(req, 200, 1000)]);
  res.json(r.rows.map(dbToBooking));
}));
router.get('/bookings/:id', asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM bookings WHERE id=$1', [idParam(req)]);
  if (!r.rows.length) throw notFound();
  res.json(dbToBooking(r.rows[0]));
}));
router.post('/bookings', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const showId = intOrNull(pick(b, 'show_id'));
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  if (!canEditProject(req.session, await loadProject(show.project_id))) throw forbidden();
  const bookedDate = pick(b, 'booked_date') || null;
  if (bookedDate && !isISODate(bookedDate)) throw badRequest('booked_date must be YYYY-MM-DD');
  const r = await pool.query(
    `INSERT INTO bookings (show_id, job_id, category, vendor, status, amount, booked_date,
       file_id, confirmation_number, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [showId, intOrNull(pick(b, 'job_id')), pick(b, 'category') || '', pick(b, 'vendor') || '',
     pick(b, 'status') || 'todo', money(pick(b, 'amount'), null), bookedDate,
     intOrNull(pick(b, 'file_id')), pick(b, 'confirmation_number') || '', pick(b, 'notes') || '']);
  await logActivity(pool, { projectId: show.project_id, showId, actor: req.actor,
    action: 'booking.add', detail: `${r.rows[0].category} · ${r.rows[0].vendor}` });
  res.json(dbToBooking(r.rows[0]));
}));
router.put('/bookings/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM bookings WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const b = req.body || {};
  const r = await pool.query(
    `UPDATE bookings SET job_id=$1, category=$2, vendor=$3, status=$4, amount=$5, booked_date=$6,
       file_id=$7, confirmation_number=$8, notes=$9 WHERE id=$10 RETURNING *`,
    [has(b, 'job_id') ? intOrNull(pick(b, 'job_id')) : cur.job_id,
     pick(b, 'category', cur.category), pick(b, 'vendor', cur.vendor), pick(b, 'status', cur.status),
     has(b, 'amount') ? money(pick(b, 'amount'), null) : cur.amount,
     has(b, 'booked_date') ? pick(b, 'booked_date') : cur.booked_date,
     has(b, 'file_id') ? intOrNull(pick(b, 'file_id')) : cur.file_id,
     pick(b, 'confirmation_number', cur.confirmation_number), pick(b, 'notes', cur.notes), cur.id]);
  res.json(dbToBooking(r.rows[0]));
}));
router.delete('/bookings/:id', requireRole('manager'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM bookings WHERE id=$1', [idParam(req)]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// 14. PROOFS + PROOF ROUNDS (print)
// ════════════════════════════════════════════════════════════════════════════
router.get('/proofs', asyncH(async (req, res) => {
  const showId = intOrNull(pick(req.query, 'show_id'));
  const r = showId
    ? await pool.query('SELECT * FROM proofs WHERE show_id=$1 ORDER BY id', [showId])
    : await pool.query('SELECT * FROM proofs ORDER BY id DESC LIMIT $1', [limitOf(req, 100, 500)]);
  if (!r.rows.length) return res.json([]);
  const ids = r.rows.map((x) => x.id);
  const rounds = await pool.query(
    'SELECT * FROM proof_rounds WHERE proof_id = ANY($1::int[]) ORDER BY sort_order, id', [ids]);
  const byProof = new Map();
  for (const rd of rounds.rows) {
    if (!byProof.has(rd.proof_id)) byProof.set(rd.proof_id, []);
    byProof.get(rd.proof_id).push(dbToProofRound(rd));
  }
  res.json(r.rows.map((p) => dbToProof(p, byProof.get(p.id) || [])));
}));
router.post('/proofs', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const showId = intOrNull(pick(b, 'show_id'));
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');
  if (!canEditProject(req.session, await loadProject(show.project_id))) throw forbidden();
  const out = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO proofs (show_id, code, name, status, client) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [showId, pick(b, 'code') || '', pick(b, 'name') || '', pick(b, 'status') || 'sent',
       pick(b, 'client') || '']);
    const proof = ins.rows[0];
    let i = 0;
    const rounds = [];
    for (const rd of (pick(b, 'rounds') || [])) {
      const r2 = await c.query(
        `INSERT INTO proof_rounds (proof_id, round, date, status, note, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [proof.id, pick(rd, 'round') || '', pick(rd, 'date') || '', pick(rd, 'status') || 'sent',
         pick(rd, 'note') || '', i++]);
      rounds.push(dbToProofRound(r2.rows[0]));
    }
    return dbToProof(proof, rounds);
  });
  res.json(out);
}));
router.post('/proofs/:id/rounds', requireRole('pm'), asyncH(async (req, res) => {
  const proofId = idParam(req);
  const b = req.body || {};
  const n = await pool.query('SELECT COUNT(*)::int AS n FROM proof_rounds WHERE proof_id=$1', [proofId]);
  const r = await pool.query(
    `INSERT INTO proof_rounds (proof_id, round, date, status, note, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [proofId, pick(b, 'round') || `R${n.rows[0].n + 1}`, pick(b, 'date') || '',
     pick(b, 'status') || 'sent', pick(b, 'note') || '', n.rows[0].n]);
  res.json(dbToProofRound(r.rows[0]));
}));
router.put('/proofs/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM proofs WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const b = req.body || {};
  const r = await pool.query(
    'UPDATE proofs SET code=$1, name=$2, status=$3, client=$4 WHERE id=$5 RETURNING *',
    [pick(b, 'code', cur.code), pick(b, 'name', cur.name), pick(b, 'status', cur.status),
     pick(b, 'client', cur.client), cur.id]);
  res.json(dbToProof(r.rows[0]));
}));
router.delete('/proofs/:id', requireRole('pm'), asyncH(async (req, res) => {
  const id = idParam(req);
  await withTx(async (c) => {
    await c.query('DELETE FROM proof_rounds WHERE proof_id=$1', [id]);
    await c.query('DELETE FROM proofs WHERE id=$1', [id]);
  });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.insertExpense = insertExpense;
module.exports.chainFor = chainFor;
// F4. The scope endpoints in routes/core.js auto-fill and verify against the
// bound spec, and this is the one reader of the render bundles.
module.exports.boundSpecDocs = boundSpecDocs;
module.exports.buildNasPath = buildNasPath;
