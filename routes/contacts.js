// ════════════════════════════════════════════════════════════════════════════
// routes/contacts.js — the contact rolodex + the show↔contact links
// ────────────────────────────────────────────────────────────────────────────
// Tom (2026-08-27): "it has event folders, contacts (there should be a contact
// rolodex in our app if we dont already have one)". Until this file a contact
// lived in four places at once — a POC JSONB on a show, a vendor string on a
// PO, a local hire inline on the crew, a Flex-side contact record — and none
// of them knew about the others. This is the directory the others point at.
//
// The decided shape:
//   · `contacts` is GLOBAL — a person is not owned by a folder, so the write
//     floor is RANK (pm+), not ownership. Everyone signed in may read it; a
//     rolodex nobody can open is a drawer, not a rolodex.
//   · `show_contacts` is the STRUCTURED link ("People on this show"), and the
//     show's venue_poc/client_poc JSONB stay free text on purpose — a call
//     sheet must be able to carry a name typed once at 11pm with no directory
//     ceremony. The rolodex FILLS those fields; it never replaces them.
//   · Archive-not-delete is the retirement path (pm+, same floor as create —
//     retiring a stale card is routine upkeep, not an admin act the way
//     archiving a season is). Hard DELETE is admin-only and REFUSES while
//     show_contacts still reference the row, naming the shows: the archive
//     path is always open, so the refusal never strands anyone.
//   · Notifications: NONE in v1, deliberately — the needs-list precedent.
//     Editing a phone number is the definition of a routine edit.
//   · `flex_contact_id` is the Rosetta-stone column (TEAM_FEEDBACK "Flex
//     dependency chain"): back-filled by the event-folder create flow through
//     absorbFlexContact() below, never guessed, never written from the UI.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const { pool, withTx, loadShow, loadProject, loadRow } = require('../lib/db');
const { requireAuth, requireRole, canEditProject } = require('../lib/auth');
const { asyncH, badRequest, forbidden, notFound, idParam, limitOf } = require('../lib/http');
const { logActivity, diffFields, changeSummary } = require('../lib/activity');
const { pick, has, dbToContact, dbToShowContact } = require('../lib/mappers');
const { CONTACT_KINDS, oneOf } = require('../lib/enums');

const router = express.Router();
router.use(requireAuth);

// The material set — a change to any of these is a diff worth reading back.
// `notes` is deliberately outside it: a scratchpad edit is routine.
const MATERIAL_CONTACT_FIELDS = {
  name: 'name', org: 'org', title: 'title', kind: 'kind',
  email: 'email', phone: 'phone'
};

// Copied from routes/core.js archiveClause() — the ONE query-param contract
// every archived-capable list in this app answers:
//   (no param)             archived rows are EXCLUDED — the working set
//   ?archived=1            ONLY archived rows — the Archive view
//   ?include_archived=1    both — for a caller that wants the whole history
function archiveClause(req, col = 'archived_at') {
  const only = String(pick(req.query, 'archived') || '') === '1' ||
               String(pick(req.query, 'archived') || '') === 'true';
  const both = String(pick(req.query, 'include_archived') || '') === '1' ||
               String(pick(req.query, 'include_archived') || '') === 'true';
  if (both) return '';
  return only ? ` ${col} IS NOT NULL` : ` ${col} IS NULL`;
}

// A contact kind must be legal or loudly refused — the newer oneOf style
// (needs list), not the silent-coercion one: a rolodex that quietly re-files
// "sponsor" under "other" teaches people the filter lies.
function readKind(raw, fallback) {
  if (raw === undefined) return fallback;
  const v = oneOf(String(raw || ''), CONTACT_KINDS, null);
  if (!v) throw badRequest(`kind must be one of ${CONTACT_KINDS.join(', ')}`);
  return v;
}

// ── read ────────────────────────────────────────────────────────────────────
// api.listContacts({q, kind, archived, include_archived}) — the rolodex table.
// `linked_shows` rides every row so the table can print "used on N shows"
// without N round trips; it counts LINKS, archived shows included, because
// "where has this person worked" is a history question.
router.get('/contacts', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const P = (v) => { params.push(v); return `$${params.length}`; };

  const arch = archiveClause(req);
  if (arch) where.push(arch.trim());

  const rawKind = pick(req.query, 'kind') || '';
  if (rawKind) where.push(`kind=${P(readKind(rawKind, null))}`);

  const q = String(pick(req.query, 'q') || '').trim();
  if (q) {
    const like = P('%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%');
    where.push(`(name ILIKE ${like} OR org ILIKE ${like})`);
  }

  const r = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM show_contacts sc WHERE sc.contact_id=c.id) AS linked_shows
     FROM contacts c
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY name ASC, id ASC
     LIMIT ${limitOf(req, 500, 1000)}`, params);
  res.json(r.rows.map((row) => dbToContact(row, { linked_shows: row.linked_shows })));
}));

// One card, plus everywhere it is used. Resolves archived or not — the F6
// rule: out of the working set, never out of the app.
router.get('/contacts/:id', asyncH(async (req, res) => {
  const c = await loadRow('contacts', idParam(req));
  if (!c) throw notFound('Contact not found');
  const links = await pool.query(
    `SELECT sc.id AS link_id, sc.role, sc.show_id, s.name, s.venue, s.event_date,
            s.project_id, s.archived_at
     FROM show_contacts sc JOIN shows s ON s.id = sc.show_id
     WHERE sc.contact_id=$1
     ORDER BY s.event_date DESC NULLS LAST, s.id DESC`, [c.id]);
  res.json(dbToContact(c, {
    linked_shows: links.rows.length,
    shows: links.rows.map((row) => ({
      link_id: row.link_id, show_id: row.show_id, role: row.role || '',
      name: row.name || '', venue: row.venue || '', event_date: row.event_date || null,
      project_id: row.project_id, archived: !!row.archived_at
    }))
  }));
}));

// ── write (pm floor — rank, not ownership: the rolodex is global) ───────────
router.post('/contacts', requireRole('pm'), asyncH(async (req, res) => {
  const b = req.body || {};
  const name = String(pick(b, 'name') || '').trim();
  if (!name) throw badRequest('a contact is a named thing — name is required');
  const kind = readKind(pick(b, 'kind'), 'other');

  const r = await pool.query(
    `INSERT INTO contacts (name, org, title, kind, email, phone, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name,
     String(pick(b, 'org') || '').trim(),
     String(pick(b, 'title') || '').trim(),
     kind,
     String(pick(b, 'email') || '').trim(),
     String(pick(b, 'phone') || '').trim(),
     String(pick(b, 'notes') || ''),
     req.actor]);
  await logActivity(pool, { actor: req.actor, action: 'contact.add',
    detail: `${name}${r.rows[0].org ? ' · ' + r.rows[0].org : ''} (${kind})` });
  res.json(dbToContact(r.rows[0], { linked_shows: 0 }));
}));

router.put('/contacts/:id', requireRole('pm'), asyncH(async (req, res) => {
  const cur = await loadRow('contacts', idParam(req));
  if (!cur) throw notFound('Contact not found');
  const b = req.body || {};

  const name = has(b, 'name') ? String(pick(b, 'name') || '').trim() : cur.name;
  if (!name) throw badRequest('a contact keeps its name — blank is not a rename');

  const r = await pool.query(
    `UPDATE contacts SET name=$1, org=$2, title=$3, kind=$4, email=$5, phone=$6,
       notes=$7, updated_at=NOW()
     WHERE id=$8 RETURNING *`,
    [name,
     has(b, 'org') ? String(pick(b, 'org') || '').trim() : cur.org,
     has(b, 'title') ? String(pick(b, 'title') || '').trim() : cur.title,
     has(b, 'kind') ? readKind(pick(b, 'kind'), cur.kind) : cur.kind,
     has(b, 'email') ? String(pick(b, 'email') || '').trim() : cur.email,
     has(b, 'phone') ? String(pick(b, 'phone') || '').trim() : cur.phone,
     has(b, 'notes') ? String(pick(b, 'notes') || '') : cur.notes,
     cur.id]);

  const changes = diffFields(cur, r.rows[0], MATERIAL_CONTACT_FIELDS);
  await logActivity(pool, { actor: req.actor, action: 'contact.update',
    accent: changes.length > 0, detail: changeSummary(changes, r.rows[0].name), changes });
  res.json(dbToContact(r.rows[0]));
}));

// ── archive / unarchive — the retirement path, idempotent both ways ─────────
router.post('/contacts/:id/archive', requireRole('pm'), asyncH(async (req, res) => {
  const cur = await loadRow('contacts', idParam(req));
  if (!cur) throw notFound('Contact not found');
  if (cur.archived_at) return res.json({ ok: true, already: true, contact: dbToContact(cur) });
  const r = await pool.query(
    `UPDATE contacts SET archived_at=NOW(), archived_by=$2, updated_at=NOW()
     WHERE id=$1 AND archived_at IS NULL RETURNING *`, [cur.id, req.actor]);
  await logActivity(pool, { actor: req.actor, action: 'contact.archive',
    accent: true, detail: cur.name });
  res.json({ ok: true, already: false, contact: dbToContact(r.rows[0] || cur) });
}));

router.post('/contacts/:id/unarchive', requireRole('pm'), asyncH(async (req, res) => {
  const cur = await loadRow('contacts', idParam(req));
  if (!cur) throw notFound('Contact not found');
  if (!cur.archived_at) return res.json({ ok: true, already: true, contact: dbToContact(cur) });
  const r = await pool.query(
    `UPDATE contacts SET archived_at=NULL, archived_by=NULL, updated_at=NOW()
     WHERE id=$1 RETURNING *`, [cur.id]);
  await logActivity(pool, { actor: req.actor, action: 'contact.unarchive',
    detail: cur.name });
  res.json({ ok: true, already: false, contact: dbToContact(r.rows[0]) });
}));

// ── hard delete — admin only, and it REFUSES while referenced ───────────────
// The refusal NAMES the shows, because "still referenced" without the list is
// a scavenger hunt. Archive is never refused, so nothing is ever stranded.
router.delete('/contacts/:id', requireRole('admin'), asyncH(async (req, res) => {
  const cur = await loadRow('contacts', idParam(req));
  if (!cur) throw notFound('Contact not found');

  const refs = await pool.query(
    `SELECT s.id, s.name, s.venue FROM show_contacts sc JOIN shows s ON s.id = sc.show_id
     WHERE sc.contact_id=$1 ORDER BY s.id`, [cur.id]);
  if (refs.rows.length) {
    const names = refs.rows.map((s) => s.name || s.venue || `show ${s.id}`);
    throw badRequest(
      `${cur.name} is on ${refs.rows.length === 1 ? 'a show' : refs.rows.length + ' shows'} — ` +
      `${names.join(', ')}. Unlink them first, or archive the contact instead ` +
      `(archiving keeps the record and always works).`,
      { shows: refs.rows.map((s) => ({ id: s.id, name: s.name })) });
  }

  await withTx(async (c) => {
    // belt and braces: the refusal above means this deletes zero rows
    await c.query('DELETE FROM show_contacts WHERE contact_id=$1', [cur.id]);
    await c.query('DELETE FROM contacts WHERE id=$1', [cur.id]);
    await logActivity(c, { actor: req.actor, action: 'contact.delete', detail: cur.name });
  });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// SHOW ↔ CONTACT LINKS — "People on this show"
// ────────────────────────────────────────────────────────────────────────────
// The link write gate mirrors the crew/schedule family: pm floor on the route,
// the FOLDER-ownership half asked in the body — who is on a show is the
// show-runner's call, exactly like who is on the crew.
// ════════════════════════════════════════════════════════════════════════════

async function assertCanEditShow(req, show, q = pool) {
  const project = await loadProject(show.project_id, q);
  if (!canEditProject(req.session, project)) {
    throw forbidden('This show belongs to a folder you do not own — pm (owner) or manager+ required');
  }
  return project;
}

router.get('/shows/:id/contacts', asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  const r = await pool.query(
    `SELECT sc.*, row_to_json(c.*) AS contact
     FROM show_contacts sc JOIN contacts c ON c.id = sc.contact_id
     WHERE sc.show_id=$1 ORDER BY sc.id ASC`, [show.id]);
  res.json(r.rows.map((row) => dbToShowContact(row, row.contact)));
}));

// Link a contact (or correct their role — one row per (show, contact), so a
// second link with a new role is a role edit, not a duplicate).
router.post('/shows/:id/contacts', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  await assertCanEditShow(req, show);

  const b = req.body || {};
  const contactId = parseInt(pick(b, 'contact_id'), 10);
  if (!Number.isFinite(contactId) || contactId <= 0) throw badRequest('contact_id required');
  const contact = await loadRow('contacts', contactId);
  if (!contact) throw notFound('Contact not found');
  const role = String(pick(b, 'role') || '').trim();

  const out = await withTx(async (c) => {
    const existing = await c.query(
      'SELECT * FROM show_contacts WHERE show_id=$1 AND contact_id=$2', [show.id, contactId]);
    if (existing.rows.length) {
      const r = await c.query(
        'UPDATE show_contacts SET role=$1 WHERE id=$2 RETURNING *', [role, existing.rows[0].id]);
      if ((existing.rows[0].role || '') !== role) {
        await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
          action: 'show.contact.role',
          detail: `${contact.name} · ${existing.rows[0].role || '—'} → ${role || '—'}` });
      }
      return { row: r.rows[0], already: true };
    }
    const r = await c.query(
      `INSERT INTO show_contacts (show_id, contact_id, role, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`, [show.id, contactId, role, req.actor]);
    await logActivity(c, { projectId: show.project_id, showId: show.id, actor: req.actor,
      action: 'show.contact.link',
      detail: `${contact.name}${role ? ' · ' + role : ''}` });
    return { row: r.rows[0], already: false };
  });
  res.json({ ...dbToShowContact(out.row, contact), already: out.already });
}));

router.delete('/shows/:id/contacts/:contactId', requireRole('pm'), asyncH(async (req, res) => {
  const show = await loadShow(idParam(req));
  if (!show) throw notFound('Show not found');
  await assertCanEditShow(req, show);
  const contactId = idParam(req, 'contactId');
  const contact = await loadRow('contacts', contactId);

  const r = await pool.query(
    'DELETE FROM show_contacts WHERE show_id=$1 AND contact_id=$2 RETURNING id',
    [show.id, contactId]);
  if (!r.rows.length) throw notFound('That contact is not on this show');
  await logActivity(pool, { projectId: show.project_id, showId: show.id, actor: req.actor,
    action: 'show.contact.unlink', detail: contact ? contact.name : `contact ${contactId}` });
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════════════════════════════
// absorbFlexContact — the cheap half of the Rosetta stone
// ────────────────────────────────────────────────────────────────────────────
// Called by the Flex event-folder create flow (routes/files.js) AFTER
// flexResolveContact matched or created a Flex-side contact. Two rules, both
// conservative:
//   · a rolodex row with the SAME NAME and NO flex id gets the id BACK-FILLED;
//     a row that already carries a DIFFERENT id is left alone — overwriting a
//     held ref on a name coincidence is how two venues become one.
//   · no rolodex row at all -> create one, kind guessed from which slot it
//     filled (client/venue), created_by 'system' so the row says who typed it.
// Name matching is the SAME key lib/flex.js uses against the Flex directory
// (case-insensitive, whitespace-collapsed, still EXACT) — one rule, two sides.
// Never throws: the folder create must not fail over a directory nicety.
async function absorbFlexContact(q, { name, flexId, kind }) {
  try {
    const wanted = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (!wanted || !flexId) return { outcome: 'skipped' };
    const hit = await (q || pool).query(
      `SELECT * FROM contacts
       WHERE LOWER(TRIM(regexp_replace(name, '\\s+', ' ', 'g'))) = LOWER($1)
       ORDER BY id ASC LIMIT 1`, [wanted]);
    if (hit.rows.length) {
      const row = hit.rows[0];
      if (row.flex_contact_id) {
        return { outcome: row.flex_contact_id === String(flexId) ? 'held' : 'kept', id: row.id };
      }
      await (q || pool).query(
        'UPDATE contacts SET flex_contact_id=$1, updated_at=NOW() WHERE id=$2',
        [String(flexId), row.id]);
      return { outcome: 'backfilled', id: row.id };
    }
    const ins = await (q || pool).query(
      `INSERT INTO contacts (name, kind, flex_contact_id, created_by)
       VALUES ($1,$2,$3,'system') RETURNING id`,
      [wanted, oneOf(kind, CONTACT_KINDS, 'other'), String(flexId)]);
    return { outcome: 'created', id: ins.rows[0].id };
  } catch (e) {
    console.warn('[contacts] flex absorb failed for', name + ':', e.message);
    return { outcome: 'failed', error: e.message };
  }
}

module.exports = router;
module.exports.absorbFlexContact = absorbFlexContact;
