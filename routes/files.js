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
const crypto = require('crypto');
const { pool, withTx, loadProject, loadShow, projectForRow } = require('../lib/db');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, conflict, idParam, limitOf } = require('../lib/http');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');
const { announceShowChange } = require('../lib/audience');
const { notifyTargets } = require('../lib/mentions');
const { storage, buildNasPath, MAX_BYTES, contentTypeFor, fileName, storageProbe } = require('../lib/storage');
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
  flexIsFabricatedElementId,
  flexListEquipmentListsUnder, flexReadPullSheet
} = require('../lib/flex');

const router = express.Router();
router.use(requireAuth);

// F3. The material set for a booking. `notes` is absent on purpose — it is the
// routine field, the one you fix a typo in. A vendor, a date, an amount or a
// confirmation number changing is logistics changing, and the crew on that show
// finds out.
const MATERIAL_BOOKING_FIELDS = {
  vendor: 'vendor', category: 'category', status: 'status', amount: 'amount',
  booked_date: 'booked for', confirmation_number: 'confirmation', job_id: 'job'
};

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
// ADMIN: THE STORAGE PROBE — the permanent instrument
// ────────────────────────────────────────────────────────────────────────────
// POST /api/admin/storage-probe
//
// WHY THIS IS A ROUTE AND NOT A SCRIPT. Railway gives us no shell and no log an
// operator can read from a laptop, so on 2026-08-28 a NAS that answered every
// LAN request perfectly was unreachable from production and the ONLY signal the
// app could produce was one line — "The NAS did not answer" — for nine
// different faults. /api/health made it worse by printing storageReady:true and
// storageTls:"verified", both of which were labels derived from environment
// variables and neither of which had ever opened a socket.
//
// The response body IS the instrument. Every step reports outcome + ms + error,
// including the ones that pass, because the layer that answers in 2ms is how
// you know the layer that hangs for 8s is the fault. It ships permanently for
// the same reason a rack has a patch-bay meter: the next time bytes stop
// moving, nobody should have to build this again.
//
// ADMIN-ONLY, and it has to be: the response names the NAS host, the share
// path, certificate fingerprints and tailnet peers. It never carries a
// credential — user/pass are reported as booleans and the probe's own Basic
// header is built and discarded inside lib/storage.js.
//
// Body (all optional): { timeoutMs: 8000, write: true }
//   · timeoutMs budgets EACH step, so nine hung layers still answer inside one
//     HTTP request. Range 1000-60000.
//   · write:false stops after PROPFIND — a read-only first run against a live
//     share, for when you do not yet trust what this thing will do.
// It cleans up after itself: the probe collection is deleted on the way out and
// the response says whether that succeeded.
router.post('/admin/storage-probe', requireRole('admin'), asyncH(async (req, res) => {
  const b = req.body || {};
  const out = await storageProbe({
    timeoutMs: pick(b, 'timeoutMs') || pick(b, 'timeout_ms'),
    write: pick(b, 'write') !== false
  });
  // 200 whatever the verdict: a probe that reports "step 3 hung" has SUCCEEDED
  // at its job, and a non-2xx would make curl and the SPA hide the body that is
  // the entire point of the call.
  res.json(out);
}));

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

// ════════════════════════════════════════════════════════════════════════════
// BYTES — the two routes that make the two-tier model real
// ────────────────────────────────────────────────────────────────────────────
// Metadata-first means a failed upload leaves a resolvable record, not a ghost
// row (AGENT_API §3): the `files` row is created by POST /api/files, and the
// bytes follow on PUT here. Both halves are separately retryable.
//
// The DOWNLOAD route is what makes Showrunner usable off the office LAN. The
// NAS is not on the internet and never will be; the app is. A tech in a truck
// at Wrigley gets the spec because the SERVER can reach the NAS over the
// tailnet and streams it out over the session she already has — she never
// touches a UNC path, a VPN client, or a share password.
// ════════════════════════════════════════════════════════════════════════════

// HARDENING 21. `commitAddFile`/`dropFile` used to stamp a fabricated
// `size`/`dim` on a row a human asked for. The front end no longer invents
// them — but this route is the backstop, and it is the right place for one:
// once real bytes exist, the bytes ARE the truth.
//   · size — always replaced by the real byte count.
//   · dim  — a guess about pixels. Either the uploader MEASURED it (?w=&h=,
//            which the browser fills in from the decoded image itself) and it
//            is recorded, or it is cleared. What it may never be is a number
//            somebody's ADD_TYPES table made up.
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
    if (!cur.nas_path) throw badRequest('This file row has no nas_path — re-create it');

    // The byte write happens BEFORE the metadata update, and its failure is
    // reported as its own status. A NAS that is down must not leave the row
    // claiming a size it does not have.
    const result = await storage.put(cur.nas_path, req.body);

    const w = intOrNull(pick(req.query, 'w')) || intOrNull(pick(req.query, 'width'));
    const h = intOrNull(pick(req.query, 'h')) || intOrNull(pick(req.query, 'height'));
    const measured = w && h ? `${w} x ${h}` : null;
    await pool.query(
      `UPDATE files SET size=$1, dim=$2,
         width = COALESCE($3, width), height = COALESCE($4, height)
       WHERE id=$5`,
      [result.size, measured, w, h, cur.id]);

    await logActivity(pool, {
      projectId: project ? project.id : null, showId: cur.show_id, actor: req.actor,
      action: 'file.upload',
      detail: `${cur.name}${cur.ext ? '.' + cur.ext : ''} — ${result.size.toLocaleString()} bytes`
    });
    res.json({
      ok: true, size: result.size, nas_path: cur.nas_path,
      // So a caller can verify the round trip without a second transfer. This
      // is what the wiring-day smoke sequence byte-compares against.
      sha256: crypto.createHash('sha256').update(req.body).digest('hex'),
      dim: measured
    });
  }));

// Stream the bytes back out. Any signed-in user may read a file they can
// already see the metadata for — the folder gates are on WRITING, and a
// download that needed a second permission model would be a different app.
//
// STREAMED, never buffered: a 400 MB show render must not sit in the server's
// heap on its way to a browser, and Railway's memory limit is the reason the
// driver has getStream() at all.
router.get('/files/:id/content', asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM files WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  if (!cur.nas_path) throw notFound('This file row has no nas_path');

  // Throws before a byte is written to the socket, so a 404/502 is still a
  // clean JSON error the SPA can show — not a truncated download.
  const { stream, size } = await storage.getStream(cur.nas_path);

  res.setHeader('Content-Type', contentTypeFor(cur.ext));
  if (size != null) res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', contentDisposition(
    fileName({ name: cur.name, ext: cur.ext }),
    String(pick(req.query, 'inline') || '') === '1'));
  // These bytes are somebody's contract or client proof. Nothing caches them.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  stream.on('error', (e) => {
    // Headers are already out; the only honest signal left is an aborted body.
    console.error(`[files/${cur.id}/content] transfer failed:`, e.message);
    res.destroy(e);
  });
  req.on('aborted', () => { try { stream.destroy(); } catch (_) {} });
  stream.pipe(res);
}));

// RFC 6266 / 5987. `filename` for the ASCII-only clients, `filename*` for the
// em dashes and accented vendor names that are in half of e360's real file
// names — without both, "E360 — Big Ten.pdf" downloads as garbage.
function contentDisposition(name, inline) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; ` +
         `filename*=UTF-8''${encodeURIComponent(name)}`;
}

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

// ════════════════════════════════════════════════════════════════════════════
// 7b. THE READ PATH — 2026-08-28. Two routes, both GET, NOTHING is written.
// ────────────────────────────────────────────────────────────────────────────
// Until tonight "Pull from Flex" was a button that said "not wired yet", which
// was at least honest, and before that it was a button that invented a gear
// list, which was not. These two routes are the real thing: they read the
// folder's equipment lists and one list's actual line items, live, every time.
//
// NOTHING here writes — not to Flex, not to `flex_state`, not to `files`. A
// read that quietly caches into the database is a read that can be WRONG
// tomorrow while still looking authoritative; a pull sheet costs two GETs, so
// it is read when a human asks and never stored.
//
// The guard order is the create route's, deliberately:
//   role  ->  configuration (501)  ->  existence (404)  ->  link state (409)
// with one documented DIVERGENCE. Create is requireRole('pm') AND ownership-
// gated (canEditProject) because it writes into a live rental system. A READ is
// requireRole('tech') and NOT ownership-gated: the warehouse tech who pulls the
// gear is rarely the pm who owns the folder, and refusing them the pull sheet
// for their own show would be an invented restriction. A viewer/client role is
// still refused — a read still costs a live call against a BETA API on e360's
// key, and that is not a client's to spend.
function flexLinkedElementId(row, showId) {
  const state = dbToFlexState(row, showId);
  if (!state.linked || !state.elementId) {
    throw conflict(
      'This show is not linked to a real Flex folder. Create the Event Folder ' +
      '(or link an existing one by its element id) first — there is no folder to read a pull sheet out of.');
  }
  if (flexIsFabricatedElementId(state.elementId)) {
    throw conflict(
      `This show is not linked to a real Flex folder. Element ${state.elementId} was ` +
      'generated by the prototype in a browser and exists in no Flex tenant — ' +
      'create the real folder to replace it, then read its pull sheet.');
  }
  return state.elementId;
}

// GET /api/shows/:id/flex/gear-lists
//   -> { showId, elementId, folderName, folderDeepLink, lists:[…], count,
//        empty, truncated, message }
//
// ONE tree call. flexFindGearListsUnder would tell us pull-sheet-vs-manifest,
// but it costs an /identity per candidate to do it; for a picker a human
// clicks, one call is the whole courtesy budget, and the tree already knows
// which nodes are equipment lists. `type` therefore comes back null and the
// pull-sheet route fills it in from the header. Unknown is said, not guessed.
router.get('/shows/:id/flex/gear-lists', requireRole('tech'), asyncH(async (req, res) => {
  const missing = ['FLEX_BASE_URL', 'FLEX_API_KEY'].filter((v) => !process.env[v]);
  if (missing.length) throw notConfigured(missing.join(' and '));

  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');

  const cur = (await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [showId])).rows[0] || {};
  const elementId = flexLinkedElementId(cur, showId);

  const found = await flexListEquipmentListsUnder(elementId);
  res.json({
    showId,
    elementId,
    folderName: found.folderName,
    folderDeepLink: flexElementUrl(elementId),
    lists: found.lists,
    count: found.lists.length,
    empty: found.empty,
    truncated: found.truncated,
    // The brand-new folder's state, said in words rather than shown as an
    // empty table. "No lists" is a fact about the FOLDER, not a failure here.
    message: found.empty
      ? `Flex folder “${found.folderName || elementId}” has no equipment lists yet. ` +
        'Build a pull sheet in Flex and it will show up here — Showrunner reads them, it does not create them.'
      : ''
  });
}));

// GET /api/shows/:id/flex/pull-sheet?listId=<uuid>
//   -> { showId, elementId, folderDeepLink, sheet:{…} }
//
// listId is VERIFIED against the folder's tree before it is read. Without that
// check this route would happily serve any equipment list in the tenant under
// any show's id, and a stale id in a bookmark would show the warehouse the
// wrong gear under the right show name — the exact failure the "Link existing"
// modal already warns about. The tree read is the same one the picker makes.
//
// listId may be omitted when the folder holds exactly ONE list; with more than
// one, the answer is a 400 that names them rather than a guess.
router.get('/shows/:id/flex/pull-sheet', requireRole('tech'), asyncH(async (req, res) => {
  const missing = ['FLEX_BASE_URL', 'FLEX_API_KEY'].filter((v) => !process.env[v]);
  if (missing.length) throw notConfigured(missing.join(' and '));

  const showId = idParam(req);
  const show = await loadShow(showId);
  if (!show) throw notFound('Show not found');

  const cur = (await pool.query('SELECT * FROM flex_state WHERE show_id=$1', [showId])).rows[0] || {};
  const elementId = flexLinkedElementId(cur, showId);

  const wanted = String(pick(req.query, 'listId') || pick(req.query, 'list_id') || '').trim();
  if (wanted && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) {
    throw badRequest(`'${wanted}' is not a Flex element id. Expected a UUID from this show's gear-lists.`);
  }

  const found = await flexListEquipmentListsUnder(elementId);
  if (found.empty) {
    throw notFound(
      `Flex folder “${found.folderName || elementId}” has no equipment lists yet — ` +
      'there is no pull sheet to read. Build one in Flex first.');
  }

  let target;
  if (wanted) {
    target = found.lists.find((l) => String(l.id).toLowerCase() === wanted.toLowerCase());
    if (!target) {
      throw notFound(
        `Equipment list ${wanted} is not under this show's Flex folder (${elementId}). ` +
        'Showrunner will not read a list from a folder this show is not linked to. ' +
        `This folder holds: ${found.lists.map((l) => `${l.name} (${l.docNumber || 'no doc number'})`).join(', ')}.`);
    }
  } else if (found.lists.length === 1) {
    target = found.lists[0];
  } else {
    throw badRequest(
      `This folder holds ${found.lists.length} equipment lists — say which one with ?listId=. ` +
      found.lists.map((l) => `${l.docNumber || l.name} = ${l.id}`).join(' · '));
  }

  const sheet = await flexReadPullSheet(target.id);
  res.json({
    showId,
    elementId,
    folderName: found.folderName,
    folderDeepLink: flexElementUrl(elementId),
    // the picker's view of this list, so a caller that skipped gear-lists still
    // gets the tree facts (depth, parentId) the header does not carry
    listing: target,
    sheet
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
  await withTx(async (c) => notifyTargets(c, {
    body: b, anchorType: 'show', anchorId: showId,
    projectId: show.project_id, showId, actor: req.actor,
    summary: `booked ${r.rows[0].category || 'a vendor'} — ${r.rows[0].vendor} —`
  }));
  res.json(dbToBooking(r.rows[0]));
}));

// H1. This route carried a RANK check and no OWNERSHIP check, while its
// immediate neighbour (POST, above) carried both — so any pm in the company
// could edit any booking on anybody's project, and silently: there was no
// activity row either. The gate is now stated the same way as every other
// booking route, and the write leaves a trace with a diff on it.
router.put('/bookings/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = (await pool.query('SELECT * FROM bookings WHERE id=$1', [idParam(req)])).rows[0];
  if (!cur) throw notFound();
  const show = await loadShow(cur.show_id);
  const project = show ? await loadProject(show.project_id) : null;
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this booking');
  const b = req.body || {};
  // POST validates booked_date and PUT did not, so the one column the delivery
  // and call-sheet views read could be set to anything by the correction path.
  if (has(b, 'booked_date') && pick(b, 'booked_date') && !isISODate(pick(b, 'booked_date'))) {
    throw badRequest('booked_date must be YYYY-MM-DD');
  }
  const r = await pool.query(
    `UPDATE bookings SET job_id=$1, category=$2, vendor=$3, status=$4, amount=$5, booked_date=$6,
       file_id=$7, confirmation_number=$8, notes=$9 WHERE id=$10 RETURNING *`,
    [has(b, 'job_id') ? intOrNull(pick(b, 'job_id')) : cur.job_id,
     pick(b, 'category', cur.category), pick(b, 'vendor', cur.vendor), pick(b, 'status', cur.status),
     has(b, 'amount') ? money(pick(b, 'amount'), null) : cur.amount,
     has(b, 'booked_date') ? pick(b, 'booked_date') : cur.booked_date,
     has(b, 'file_id') ? intOrNull(pick(b, 'file_id')) : cur.file_id,
     pick(b, 'confirmation_number', cur.confirmation_number), pick(b, 'notes', cur.notes), cur.id]);
  const changes = diffFields(cur, r.rows[0], MATERIAL_BOOKING_FIELDS);
  await logActivity(pool, {
    projectId: show ? show.project_id : null, showId: cur.show_id || null,
    jobId: r.rows[0].job_id || null, actor: req.actor, action: 'booking.update',
    detail: changeSummary(changes, `${r.rows[0].category} · ${r.rows[0].vendor}`), changes });
  if (changes.length && show) {
    await withTx(async (c) => {
      await notifyTargets(c, {
        body: b, anchorType: 'show', anchorId: show.id,
        projectId: show.project_id, showId: show.id, actor: req.actor,
        summary: `updated the ${r.rows[0].category || 'booking'} with ${r.rows[0].vendor} —`
      });
      // Logistics changing is a show-level fact: the truck arriving at a
      // different time is everyone's problem, not just the person who booked it.
      await announceShowChange(c, {
        showId: show.id, projectId: show.project_id, actor: req.actor,
        subject: `Booking changed — ${r.rows[0].vendor} on ${show.name || 'show ' + show.id}`,
        what: `the ${r.rows[0].category || 'booking'} with ${r.rows[0].vendor}`,
        changes
      });
    });
  }
  res.json(dbToBooking(r.rows[0]));
}));

router.delete('/bookings/:id', requireRole('manager'), asyncH(async (req, res) => {
  const id = idParam(req);
  // H3. This answered {ok:true} for ANY id, including one that never existed,
  // so a stale screen reported a successful delete of nothing.
  const cur = (await pool.query('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound(`booking ${id} not found`);
  const show = await loadShow(cur.show_id);
  const project = show ? await loadProject(show.project_id) : null;
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to delete this booking');
  await pool.query('DELETE FROM bookings WHERE id=$1', [id]);
  await logActivity(pool, {
    projectId: show ? show.project_id : null, showId: cur.show_id || null,
    actor: req.actor, action: 'booking.delete', accent: true,
    detail: `${cur.category} · ${cur.vendor}`,
    changes: [{ field: 'booking', label: cur.category || 'booking',
                from: cur.vendor || 'booked', to: null }] });
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
    await logActivity(c, { projectId: show.project_id, showId, actor: req.actor,
      action: 'proof.add', accent: true,
      detail: `${proof.code || proof.name}${proof.client ? ' · ' + proof.client : ''}` });
    return dbToProof(proof, rounds);
  });
  res.json(out);
}));
// H1. Three proof routes carried rank and no ownership while POST /proofs, two
// lines above them, carried both. `editableProof` is the entity's predicate,
// written once, and every route in the family now uses it — the house rule
// hasFinance/canApprovePO already prove for the hard questions, applied to the
// routine ones.
async function editableProof(req, proofId) {
  const proof = (await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId])).rows[0];
  if (!proof) throw notFound(`proof ${proofId} not found`);
  const show = await loadShow(proof.show_id);
  const project = show ? await loadProject(show.project_id) : null;
  if (!canEditProject(req.session, project)) throw forbidden('Not allowed to edit this proof');
  return { proof, show, project };
}

router.post('/proofs/:id/rounds', requireRole('pm'), asyncH(async (req, res) => {
  const proofId = idParam(req);
  const { proof, show } = await editableProof(req, proofId);
  const b = req.body || {};
  const n = await pool.query('SELECT COUNT(*)::int AS n FROM proof_rounds WHERE proof_id=$1', [proofId]);
  const r = await pool.query(
    `INSERT INTO proof_rounds (proof_id, round, date, status, note, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [proofId, pick(b, 'round') || `R${n.rows[0].n + 1}`, pick(b, 'date') || '',
     pick(b, 'status') || 'sent', pick(b, 'note') || '', n.rows[0].n]);
  await logActivity(pool, {
    projectId: show ? show.project_id : null, showId: proof.show_id || null,
    actor: req.actor, action: 'proof.round.add', accent: true,
    detail: `${proof.code || proof.name} · ${r.rows[0].round} ${r.rows[0].status}` });
  res.json(dbToProofRound(r.rows[0]));
}));

router.put('/proofs/:id', requireRole('pm'), asyncH(async (req, res) => {
  const { proof: cur, show } = await editableProof(req, idParam(req));
  const b = req.body || {};
  const r = await pool.query(
    'UPDATE proofs SET code=$1, name=$2, status=$3, client=$4 WHERE id=$5 RETURNING *',
    [pick(b, 'code', cur.code), pick(b, 'name', cur.name), pick(b, 'status', cur.status),
     pick(b, 'client', cur.client), cur.id]);
  const changes = diffFields(cur, r.rows[0],
    { code: 'code', name: 'name', status: 'status', client: 'client' });
  await logActivity(pool, {
    projectId: show ? show.project_id : null, showId: cur.show_id || null,
    actor: req.actor, action: 'proof.update',
    accent: changes.some((ch) => ch.field === 'status'),
    detail: changeSummary(changes, r.rows[0].name || r.rows[0].code), changes });
  // A proof approving or bouncing is the print persona's whole workflow, and it
  // is a show-level fact — the floor, the PM and the owner all act on it.
  if (changes.some((ch) => ch.field === 'status') && show) {
    await withTx(async (c) => announceShowChange(c, {
      showId: show.id, projectId: show.project_id, actor: req.actor,
      subject: `Proof ${r.rows[0].status} — ${r.rows[0].name || r.rows[0].code}`,
      what: `the proof ${r.rows[0].name || r.rows[0].code}`,
      changes
    }));
  }
  res.json(dbToProof(r.rows[0]));
}));

router.delete('/proofs/:id', requireRole('pm'), asyncH(async (req, res) => {
  const id = idParam(req);
  const { proof, show } = await editableProof(req, id);
  await withTx(async (c) => {
    await c.query('DELETE FROM proof_rounds WHERE proof_id=$1', [id]);
    await c.query('DELETE FROM proofs WHERE id=$1', [id]);
    await logActivity(c, {
      projectId: show ? show.project_id : null, showId: proof.show_id || null,
      actor: req.actor, action: 'proof.delete', detail: proof.name || proof.code });
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
