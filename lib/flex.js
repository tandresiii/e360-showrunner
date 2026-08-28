// ════════════════════════════════════════════════════════════════════════════
// lib/flex.js — the Flex Rental Solutions API client
// ────────────────────────────────────────────────────────────────────────────
// A PORT of the staffing app's inline client (`e360-staffing3/server.js:26-363`),
// not a re-derivation. INTEGRATIONS_SPEC.md §3 is the workbook; every bug
// workaround below is load-bearing and was paid for once already.
//
// env:  FLEX_BASE_URL  (public: https://e360sport.flexrentalsolutions.com)
//       FLEX_API_KEY   (secret; lives in the e360-staffing3 Railway env store)
// With no key EVERY function throws a 501-shaped error. Never a silent noop —
// a Flex client that quietly returns `[]` is indistinguishable from "the gear
// list is empty", which is exactly BUG 5's failure mode.
//
// THE SIX BUGS (§3.3), all worked around here:
//   BUG 1  every real URL needs a `/f5` prefix; without it Apache answers 403
//          as HTML and res.json() throws a parse error that hides the cause.
//   BUG 2  the date parser rejects ±HH:MM offsets. ISO-8601 with `Z` only.
//   BUG 3  UTC midnight renders as the PREVIOUS day in Flex's UI. Send noon
//          Central expressed as UTC, and let Luxon handle the DST boundary.
//   BUG 4  GET /api/eqlist-line-item/node-list/{id} returns [] for every parent
//          strategy, forever. Use the flat /api/line-item/{id}/row-data/.
//   BUG 5  `codeList` is REQUIRED, its values are ignored, and `codeList=`
//          (empty) returns 200 + [] — an empty gear list with no error.
//   BUG 6  `quantity` is null on serial-tracked items and the NAME carries the
//          serial. Strip the trailing parenthetical; never trust quantity.
//
// Showrunner-specific improvements over the staffing original (§3.6):
//   · the current-user cache has a TTL and a reset (staffing's never expires —
//     R19: a rotated key needs a process restart)
//   · flexFindGearListsUnder is depth-capped and throttled (R17: the original
//     is a serial N+1 storm against a BETA API)
//   · flexEnrichWithStatus surfaces `statusUnavailable` instead of swallowing
//     the error the way the original does (R18)
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { DateTime } = require('luxon');

// ── constants, verbatim from staffing/server.js:34-38 ───────────────────────
const FLEX_EVENT_FOLDER_DEF_ID = '358f312c-b051-11df-b8d5-00e08175e43e';
const FLEX_PULL_SHEET_DEF_ID   = 'a220432c-af33-11df-b8d5-00e08175e43e';
const FLEX_MANIFEST_DEF_ID     = '9945d54c-af32-11df-b8d5-00e08175e43e';
const FLEX_GEAR_LIST_CODELIST  = ['name', 'quantity', 'note'];
const FLEX_TIMEZONE            = 'America/Chicago';

// R17 guards. A deep Event Folder walked naively is one /identity call per
// node, serially, against an API Flex itself calls BETA.
const TREE_MAX_DEPTH  = parseInt(process.env.FLEX_TREE_MAX_DEPTH || '4', 10);
const TREE_MAX_NODES  = parseInt(process.env.FLEX_TREE_MAX_NODES || '200', 10);
const IDENTITY_BATCH  = parseInt(process.env.FLEX_IDENTITY_BATCH || '5', 10);
const CURRENT_USER_TTL_MS = parseInt(process.env.FLEX_USER_CACHE_MS || String(30 * 60 * 1000), 10);
const FLEX_TIMEOUT_MS = parseInt(process.env.FLEX_TIMEOUT_MS || '20000', 10);

// ── configuration errors are 501s, not 500s ─────────────────────────────────
// The distinction matters to a caller: 501 means "this deployment is not wired
// for Flex", which is an ops answer, not a bug report.
function notConfigured(which) {
  const e = new Error(
    `Flex is not configured: ${which} is unset. Copy FLEX_BASE_URL and FLEX_API_KEY from the ` +
    `e360-staffing3 service's environment (INTEGRATIONS_SPEC.md §8 item 1) into Showrunner's, ` +
    `then restart. No Flex call can succeed without them.`
  );
  e.status = 501;
  e.code = 'FLEX_NOT_CONFIGURED';
  return e;
}

// 1/15
function flexBaseUrl() {
  const raw = process.env.FLEX_BASE_URL;
  if (!raw) throw notConfigured('FLEX_BASE_URL');
  return String(raw).replace(/\/+$/, '');          // staffing/server.js:45
}
// 2/15
function flexApiKey() {
  const key = process.env.FLEX_API_KEY;
  if (!key) throw notConfigured('FLEX_API_KEY');
  return String(key);
}
// True when both env vars are present. Route handlers use this to answer 501
// BEFORE doing work, so the error names the missing var rather than surfacing
// as a failed fetch three frames deep.
function flexConfigured() {
  return !!(process.env.FLEX_BASE_URL && process.env.FLEX_API_KEY);
}

// ── 3/15  flexFetch — the one door ──────────────────────────────────────────
// BUG 1: the /f5 prefix is added HERE and nowhere else. A caller that passes a
// path already containing /f5 gets a clear error rather than a 403 HTML page.
async function flexFetch(apiPath, options = {}) {
  const base = flexBaseUrl();
  const key = flexApiKey();
  const cleanPath = String(apiPath).startsWith('/') ? apiPath : '/' + apiPath;
  if (/^\/f5\//.test(cleanPath)) {
    throw new Error(`flexFetch path must NOT include the /f5 prefix — it is added here. Got: ${apiPath}`);
  }
  const url = base + '/f5' + cleanPath;                    // staffing/server.js:56

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLEX_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        // NOT `Authorization: Bearer` — Flex wants its own header.
        'X-Auth-Token': key,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(
      e && e.name === 'AbortError'
        ? `Flex request timed out after ${FLEX_TIMEOUT_MS}ms: ${apiPath}`
        : `Flex request failed: ${e && e.message ? e.message : e}`);
    err.status = 502;
    throw err;
  }
  clearTimeout(timer);

  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }

  if (!res.ok) {
    // staffing/server.js:69-77 — exceptionMessage, then message, then 200 chars
    // of raw text (which is how a BUG-1 403 HTML page shows itself).
    const msg = (body && (body.exceptionMessage || body.message)) ||
                (typeof body === 'string' ? body.slice(0, 200) : '') ||
                res.statusText || 'unknown error';
    const err = new Error(`Flex API ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── 4/15  flexGetCurrentUser — cached, but WITH a TTL (R19) ─────────────────
let _currentUser = null;
let _currentUserAt = 0;
async function flexGetCurrentUser(force) {
  if (!force && _currentUser && Date.now() - _currentUserAt < CURRENT_USER_TTL_MS) return _currentUser;
  const raw = await flexFetch('/api/user-profile/current-user');    // staffing/server.js:81-90
  const user = {
    userId:    raw && (raw.userId || raw.id || null),
    contactId: raw && (raw.contactId || (raw.contact && raw.contact.id) || null),
    name:      raw && (raw.name || raw.displayName || raw.username || ''),
    raw
  };
  _currentUser = user;
  _currentUserAt = Date.now();
  return user;
}
// The reset path staffing never had. Call it after rotating FLEX_API_KEY.
function flexResetUserCache() { _currentUser = null; _currentUserAt = 0; }

// ── 5/15  flexSanitizeName ──────────────────────────────────────────────────
// Flex silently strips em-dashes. Do this before EVERY POST so the name that
// comes back matches the name that went in. staffing/server.js:92-94.
function flexSanitizeName(s) {
  return String(s == null ? '' : s).replace(/[–—―−]/g, '-');
}

// ── 6/15  flexDateToUtcInstant — BUG 2 + BUG 3 together ─────────────────────
// BUG 2: `2026-05-29T12:00:00-05:00` is rejected — only a `Z` suffix parses.
// BUG 3: `2026-05-29T00:00:00Z` DISPLAYS as 5/28 7:00 PM in Flex's Central UI.
// So: build noon in America/Chicago, convert to UTC, emit with Z. Luxon knows
// where the DST boundary is; a hand-rolled ±5/±6 does not.
function flexDateToUtcInstant(dateStr, timeStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  const t = /^\d{1,2}:\d{2}/.test(String(timeStr || '')) ? String(timeStr) : '12:00';
  const [hh, mm] = t.split(':');
  const dt = DateTime.fromISO(String(dateStr), { zone: FLEX_TIMEZONE })
    .set({ hour: parseInt(hh, 10) || 0, minute: parseInt(mm, 10) || 0, second: 0, millisecond: 0 });
  if (!dt.isValid) return null;
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

// ── 7/15  flexShiftDate — YYYY-MM-DD ± n days, no timezone drift ────────────
function flexShiftDate(dateStr, days) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  const dt = DateTime.fromISO(String(dateStr), { zone: 'utc' }).plus({ days: Number(days) || 0 });
  return dt.isValid ? dt.toISODate() : null;
}

// ── 8/15  flexGetElement ────────────────────────────────────────────────────
// NOTE (§3.4): the response's plannedStartDate comes back WITHOUT the Z it was
// sent with, and `elementNumber` is absent on Event Folders. Callers coerce.
async function flexGetElement(id) {
  if (!id) throw new Error('flexGetElement: id required');
  return flexFetch(`/api/element/${encodeURIComponent(id)}/identity`);
}

// ── 9/15  flexGetElementTree ────────────────────────────────────────────────
// Tree nodes carry `nodeId` (NOT `id`), `name`, `documentNumber`, `parentId`,
// `leaf`, `domainId`, `children` (null on leaves). The root's nodeId is the
// folder's own id.
async function flexGetElementTree(id) {
  if (!id) throw new Error('flexGetElementTree: id required');
  return flexFetch(`/api/element/${encodeURIComponent(id)}/tree`);
}

// ── 10/15  flexGetRowData — BUG 4 + BUG 5 ───────────────────────────────────
// BUG 4: the documented node-list endpoint returns {content:[],totalElements:0}
//        for EVERY parent strategy. This flat endpoint returns the whole nested
//        tree in one call and is the only thing that works.
// BUG 5: codeList is required; omitting it is a 400, passing it EMPTY is a 200
//        with []. Always send the shipped three codes plus node=root, and treat
//        an empty array as SUSPICIOUS rather than authoritative.
async function flexGetRowData(id) {
  if (!id) throw new Error('flexGetRowData: id required');
  const qs = FLEX_GEAR_LIST_CODELIST.map((c) => `codeList=${encodeURIComponent(c)}`).join('&');
  const rows = await flexFetch(`/api/line-item/${encodeURIComponent(id)}/row-data/?${qs}&node=root`);
  return Array.isArray(rows) ? rows : [];
}

// ── 11/15  flexFindGearListsUnder — depth-capped + throttled (R17) ──────────
// Walks an Event Folder's tree looking for pull sheets and manifests. The
// staffing original issues one /identity per node, serially, with no cap. This
// one caps depth and node count and batches the identity lookups.
async function flexFindGearListsUnder(folderId, { maxDepth = TREE_MAX_DEPTH, maxNodes = TREE_MAX_NODES } = {}) {
  const tree = await flexGetElementTree(folderId);
  const candidates = [];
  let visited = 0;
  let truncated = false;

  (function walk(node, depth) {
    if (!node || depth > maxDepth) return;
    if (visited >= maxNodes) { truncated = true; return; }
    visited += 1;
    const nodeId = node.nodeId || node.id;
    // Skip the root itself; everything below it is a candidate list.
    if (nodeId && String(nodeId) !== String(folderId)) {
      candidates.push({ id: nodeId, name: node.name || '', documentNumber: node.documentNumber || '' });
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const k of kids) walk(k, depth + 1);
  })(tree, 0);

  // Identity tells us the definitionId, which is the only way to know whether a
  // node is a pull sheet or a manifest. Batched rather than serial.
  const out = [];
  for (let i = 0; i < candidates.length; i += IDENTITY_BATCH) {
    const slice = candidates.slice(i, i + IDENTITY_BATCH);
    const results = await Promise.all(slice.map(async (c) => {
      try { return { c, ident: await flexGetElement(c.id) }; }
      catch { return { c, ident: null }; }        // a node we cannot identify is not a gear list
    }));
    for (const { c, ident } of results) {
      if (!ident) continue;
      const type = ident.definitionId === FLEX_PULL_SHEET_DEF_ID ? 'pull-sheet'
                 : ident.definitionId === FLEX_MANIFEST_DEF_ID   ? 'manifest'
                 : null;
      if (!type) continue;
      out.push({ id: c.id, name: ident.name || c.name,
                 documentNumber: ident.documentNumber || c.documentNumber || '', type });
    }
  }
  if (truncated) out.truncated = true;
  return out;
}

// ── 12/15  flexEnrichWithStatus — R18: say so when it fails ─────────────────
// The staffing original console.warns and returns the items unenriched, which
// is indistinguishable from "genuinely no workflow state". This one stamps
// statusUnavailable:true so a UI can say "status unknown" instead of "none".
async function flexEnrichWithStatus(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const qs = list.map((i) => `elementIds=${encodeURIComponent(i.id)}`).join('&');
  try {
    const states = await flexFetch(`/api/element/current-workflow-state?${qs}`);
    const byId = new Map();
    const rows = Array.isArray(states) ? states : (states && Array.isArray(states.content) ? states.content : []);
    for (const s of rows) {
      const id = s && (s.elementId || s.id);
      if (id) byId.set(String(id), s.currentStatus || s.status || s.name || '');
    }
    return list.map((i) => ({ ...i, status: byId.get(String(i.id)) || '' }));
  } catch (e) {
    console.warn('[flex] workflow-state lookup failed:', e.message);
    return list.map((i) => ({ ...i, status: '', statusUnavailable: true }));
  }
}

// ── 13/15  flexCleanItemName — BUG 6 ────────────────────────────────────────
// "2024 P10 Perimeter (6858)" -> "2024 P10 Perimeter". Each physical unit has
// its own resourceId, so the cleaned name is the ONLY stable "same item type"
// key. staffing/server.js:186-188.
function flexCleanItemName(name) {
  return String(name == null ? '' : name).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// ── 14/15  flexFetchGearList — the normalization worth copying verbatim ─────
// Two row grammars behind one envelope (§3.5):
//   pull-sheet: top-level rows with group===true; their children are items.
//   manifest:   leaf===true rows are loose items (one 'loose' group, UNSHIFTED
//               to the front); leaf===false rows are containers.
// ⚠ R21: the pull-sheet branch has NO probe evidence — every saved probe
//   response is a manifest. It is written from the spec. Validate it against a
//   real pull sheet before trusting gear-list grouping.
async function flexFetchGearList(gearListId, gearListType) {
  const type = gearListType === 'pull-sheet' ? 'pull-sheet' : 'manifest';
  const [ident, rows] = await Promise.all([
    flexGetElement(gearListId).catch(() => ({})),
    flexGetRowData(gearListId)
  ]);
  const envelope = {
    type,
    name: (ident && ident.name) || '',
    documentNumber: (ident && ident.documentNumber) || '',
    groups: [],
    // BUG 5: an empty array is suspicious, not authoritative. Say so out loud.
    empty: rows.length === 0,
    rowCount: rows.length
  };

  // BUG 6: sum by CLEANED name, and never trust `quantity` directly — it is
  // null on every serial-tracked row.
  const addItems = (children) => {
    const acc = new Map();
    for (const c of (Array.isArray(children) ? children : [])) {
      if (c && c.isNote) continue;
      const clean = flexCleanItemName(c && c.name);
      if (!clean) continue;
      const addQty = typeof c.quantity === 'number' && c.quantity > 0 ? c.quantity : 1;
      const prev = acc.get(clean);
      if (prev) prev.qty += addQty;
      else acc.set(clean, { name: clean, qty: addQty, resourceId: (c && c.resourceId) || '' });
    }
    return [...acc.values()];
  };

  if (type === 'pull-sheet') {
    for (const row of rows) {
      if (!row || row.group !== true) continue;
      envelope.groups.push({
        name: flexCleanItemName(row.name) || 'Items',
        type: 'category',
        items: addItems(row.children)
      });
    }
    // A pull sheet with no group rows still has gear; fall back to the flat set
    // rather than reporting an empty list (BUG 5's failure mode, again).
    if (!envelope.groups.length && rows.length) {
      envelope.groups.push({ name: 'Items', type: 'loose', items: addItems(rows) });
      envelope.groupingFellBack = true;
    }
  } else {
    const loose = [];
    for (const row of rows) {
      if (!row) continue;
      if (row.leaf === true) { loose.push(row); continue; }
      envelope.groups.push({
        name: flexCleanItemName(row.name) || 'Container',
        type: 'container',
        containerSerial: row.serial || row.barcode || '',
        items: addItems(row.children)
      });
    }
    if (loose.length) {
      // UNSHIFT — loose gear reads first on a manifest. staffing/server.js:223-258.
      envelope.groups.unshift({ name: 'Loose Items', type: 'loose', items: addItems(loose) });
    }
  }
  return envelope;
}

// ════════════════════════════════════════════════════════════════════════════
// CONTACTS — the directory, the local match, and the (unprobed) create
// ────────────────────────────────────────────────────────────────────────────
// Flex's Event Folder form has a Client and a Venue / Site field, each an FK
// into the contact directory. The staffing app NEVER sends either, because it
// has no lookup flow. Showrunner has one, built from three observations made
// against the live tenant on 2026-08-27:
//
//   C1  GET /api/contact returns a Spring page envelope
//       {content:[…], totalElements:24, totalPages:2, size:20, number:0, last}
//       and each row is the IDENTITY projection only:
//       {id, name, preferredDisplayString, barcode, deleted, shortName,
//        domainId:'contact', className:'CONTACT', shortNameOrName}.
//   C2  EVERY filter parameter probed is IGNORED — `searchText=`, `name=` and
//       `query=` all return the same unfiltered page. `size=` IS honoured.
//       So the match happens HERE, locally, over the whole directory. Never
//       trust a server-side filter you have watched being ignored.
//   C3  GET /api/contact/{id} returns the FULL record. An organisation-type
//       contact (e.g. "Kansas City Municipal") carries
//       {name, organization:true, company:'<same name>', addresses:[…]} —
//       which is where flexCreateContact's minimal payload comes from.
//
// ⚠ The contact WRITE has never been executed. OPTIONS /f5/api/contact answers
//   `Allow: POST,GET,HEAD,OPTIONS`, so the verb exists; the BODY shape below is
//   inferred from C3 and nothing more. Every caller must treat a failed create
//   as "omit the field and say so", never as a failed folder create.
// ════════════════════════════════════════════════════════════════════════════

// 16/21  the whole directory, paged.
// One call with size=200 covers today's 24 records; the loop is the guard for
// the day it outgrows that. Dedupe by id — with `size` honoured and `page`
// apparently not, the same row can arrive twice.
async function flexListContacts({ pageSize = 200, maxPages = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const body = await flexFetch(`/api/contact?page=${page}&size=${pageSize}`);
    const rows = Array.isArray(body) ? body
      : (body && Array.isArray(body.content) ? body.content : []);
    for (const r of rows) {
      const id = r && r.id;
      if (!id || seen.has(String(id)) || r.deleted === true) continue;
      seen.add(String(id));
      out.push({ id: String(id), name: String(r.name || r.shortNameOrName || '') });
    }
    const totalPages = body && typeof body.totalPages === 'number' ? body.totalPages : 1;
    if (!rows.length || body === null || body.last === true || page + 1 >= totalPages) break;
  }
  return out;
}

// 17/21  the match key. Case-insensitive, whitespace-collapsed, trimmed —
// because the real directory holds "Hard Rock  Stadium" and "Allegiant " with
// the spacing typed by a human. It is still an EXACT match: no prefix, no
// fuzzy, no "contains". "Citrus Sports Group" and "Citrus Sports group  Co"
// stay two different contacts, which is correct — they are.
function flexContactKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}
function flexMatchContact(name, contacts) {
  const key = flexContactKey(name);
  if (!key) return null;
  for (const c of (Array.isArray(contacts) ? contacts : [])) {
    if (flexContactKey(c && c.name) === key) return c;
  }
  return null;
}

// 18/21  flexCreateContact — THE UNPROBED WRITE.
// Payload mirrors what a real organisation contact carries (C3). Defensive on
// the way out: any of four plausible id keys is accepted, and a 2xx that
// carries no id at all is an ERROR, not a silent success — a folder linked to
// `undefined` is worse than a folder with no client.
async function flexCreateContact(name, { organization = true } = {}) {
  const clean = flexSanitizeName(name).trim();
  if (!clean) {
    const e = new Error('flexCreateContact: a name is required');
    e.status = 400;
    throw e;
  }
  const payload = { name: clean, organization: !!organization };
  if (organization) payload.company = clean;
  const raw = await flexFetch('/api/contact', { method: 'POST', body: JSON.stringify(payload) });
  const id = raw && (raw.id || raw.contactId || raw.elementId || (raw.contact && raw.contact.id));
  if (!id) {
    const e = new Error('Flex accepted the contact but returned no id — refusing to guess one');
    e.status = 502;
    e.body = raw;
    throw e;
  }
  return { id: String(id), name: (raw && raw.name) || clean, raw };
}

// 19/21  flexResolveContact — match → create → omit, and SAY WHICH.
// Returns { id, outcome:'matched'|'created'|'omitted', name, reason }. It never
// throws: an unreadable directory, a name that matches nothing, a create that
// fails — all three are `omitted` with a reason a human can act on. The caller
// then simply does not send the field, which is Flex's own default and the
// staffing app's proven behaviour.
async function flexResolveContact(name, { directory = null, create = false, label = 'contact' } = {}) {
  const wanted = String(name == null ? '' : name).trim();
  if (!wanted) return { id: null, outcome: 'omitted', name: '', reason: `no ${label} name on this show` };

  let dir = directory;
  if (!dir) {
    try { dir = await flexListContacts(); }
    catch (e) {
      return { id: null, outcome: 'omitted', name: wanted,
               reason: `the Flex contact directory could not be read (${e.message})` };
    }
  }
  const hit = flexMatchContact(wanted, dir);
  if (hit) return { id: hit.id, outcome: 'matched', name: hit.name, reason: '' };

  if (!create) {
    return { id: null, outcome: 'omitted', name: wanted,
             reason: `no exact match in the Flex contact directory, and "create missing contacts" was off` };
  }
  try {
    const made = await flexCreateContact(wanted);
    return { id: made.id, outcome: 'created', name: made.name, reason: '' };
  } catch (e) {
    return { id: null, outcome: 'omitted', name: wanted,
             reason: `no exact match, and creating it in Flex failed (${e.message})`, error: e.message };
  }
}

// 20/21  flexTimesNote — the times the form cannot hold.
// The Event Folder definition has NINETEEN fields (probe artifact
// `eventfolder-fields.json`) and not one of them takes a clock time: loadInDate
// and loadOutDate are both `timeAssociated:false`. Doors and show time are
// exactly the facts a warehouse needs, so they ride in `notes`, which prints.
// Empty parts are omitted rather than rendered as "Doors —".
function flexTimesNote({ eventDate, doorsTime, showTime, strikeTime } = {}) {
  const hhmm = (t) => {
    const m = String(t == null ? '' : t).match(/^(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
  };
  const parts = [];
  if (eventDate && /^\d{4}-\d{2}-\d{2}$/.test(String(eventDate))) parts.push(`Event: ${eventDate}`);
  if (hhmm(doorsTime)) parts.push(`Doors ${hhmm(doorsTime)}`);
  if (hhmm(showTime)) parts.push(`Show ${hhmm(showTime)}`);
  if (hhmm(strikeTime)) parts.push(`Strike ${hhmm(strikeTime)}`);
  return parts.join(' · ');
}

// 21/21  flexOmittedNote — a second notes line, ONLY when a field was dropped.
// If the venue could not be linked, the venue NAME still belongs in the folder;
// otherwise the fact leaves Showrunner and lands nowhere. Silent omission is
// the failure mode this whole pass exists to remove.
function flexOmittedNote(contacts) {
  const dropped = [];
  for (const [label, r] of Object.entries(contacts || {})) {
    if (r && r.outcome === 'omitted' && r.name) {
      dropped.push(`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${r.name} (not linked in Flex)`);
    }
  }
  return dropped.join(' · ');
}

// ── 15/15  flexCreateEventFolder ────────────────────────────────────────────
// Date derivation, verbatim from staffing/server.js:277-289:
//   plannedStartDate = (shipOutDate || setup)      − 3 days
//   plannedEndDate   = (shipReturnDate || breakdown) + 7 days, else plannedStart
//   loadInDate       = setup (with setupTime when it matches HH:MM)
//   loadOutDate      = breakdown
// loadInDate/loadOutDate are OMITTED when null — never sent as null.
//
// NEVER SEND (§3.4): secondaryClientId, billToId, secondaryVenueId,
// facilityId, locationId, currencyId, statusId, any customField*Value,
// salesPersonId, accountExecutiveId.
//
// CHANGED 2026-08-27 (Tom): `clientId` and `venueId` LEFT that list. They are
// still never GUESSED — the caller resolves them through flexResolveContact and
// passes an id only when it holds a real one, so an unresolved contact is an
// absent key, exactly as before. That is the whole difference: the field is now
// sendable, never inventable.
async function flexCreateEventFolder({ event, notes = '', setup, setupTime, breakdown,
                                       shipOutDate, shipReturnDate,
                                       clientId, venueId } = {}) {
  const startSource = shipOutDate || setup;
  const endSource = shipReturnDate || breakdown;
  if (!startSource) {
    // M7: this is the failure the staffing app surfaces as an opaque 502.
    const e = new Error('Cannot create Flex folder: event has no Setup or Ship Out date');
    e.status = 400;
    throw e;
  }
  const plannedStart = flexDateToUtcInstant(flexShiftDate(startSource, -3));
  const plannedEnd = flexDateToUtcInstant(flexShiftDate(endSource, 7)) || plannedStart;
  const loadIn = setup ? flexDateToUtcInstant(setup, setupTime) : null;
  const loadOut = breakdown ? flexDateToUtcInstant(breakdown) : null;

  const user = await flexGetCurrentUser();
  const payload = {
    definitionId: FLEX_EVENT_FOLDER_DEF_ID,
    name: flexSanitizeName(event),
    notes: flexSanitizeName(notes || ''),
    printNotes: true,
    plannedStartDate: plannedStart,
    plannedEndDate: plannedEnd,
    assignedToUserId: user.userId || undefined,
    personResponsibleId: user.contactId || undefined
  };
  if (loadIn) payload.loadInDate = loadIn;
  if (loadOut) payload.loadOutDate = loadOut;
  // Only ever present when the caller RESOLVED one. `undefined` is not a value
  // here — an unresolved contact must leave the key absent, not null.
  if (clientId) payload.clientId = String(clientId);
  if (venueId) payload.venueId = String(venueId);

  const raw = await flexFetch('/api/element', { method: 'POST', body: JSON.stringify(payload) });
  return {
    payload,
    // elementNumber is ALWAYS null on Event Folders (definitionNumberingEnabled
    // is false). Coerce to '' — never build UI expecting a friendly number.
    elementId: (raw && raw.elementId) || null,
    elementNumber: (raw && raw.elementNumber) || '',
    raw
  };
}

// ── flexIsFabricatedElementId — recognising the prototype's lies ────────────
// Before 2026-08-27 the "Create Flex Folder" button hashed an id out of the
// show number in the BROWSER (`modeledUuid` in public/data.js), stored it, and
// toasted success. Every one of those ids ends in the same constant tail, and
// rows carrying them are still in the database marked `linked`. Recognising the
// shape is what lets a real create REPLACE one instead of 409-ing forever, and
// what lets the UI say "not really linked" instead of offering a dead link.
const MODELED_ELEMENT_SUFFIX = /-b1cc-4e90-83ce-bbd69eb3e4fa$/i;
function flexIsFabricatedElementId(id) {
  return !!id && MODELED_ELEMENT_SUFFIX.test(String(id));
}

// Deep link into the Flex SPA. Note the `#` marker; if it ever 404s, append
// '/view/simple-element/header'.
function flexElementUrl(elementId) {
  if (!elementId) return '';
  return `${flexBaseUrl()}/f5/ui/#element/${elementId}`;
}

module.exports = {
  // constants
  FLEX_EVENT_FOLDER_DEF_ID, FLEX_PULL_SHEET_DEF_ID, FLEX_MANIFEST_DEF_ID,
  FLEX_GEAR_LIST_CODELIST, FLEX_TIMEZONE,
  // the 15
  flexBaseUrl, flexApiKey, flexFetch, flexGetCurrentUser, flexSanitizeName,
  flexDateToUtcInstant, flexShiftDate, flexGetElement, flexGetElementTree,
  flexGetRowData, flexFindGearListsUnder, flexEnrichWithStatus, flexCleanItemName,
  flexFetchGearList, flexCreateEventFolder,
  // the contact-resolution six (Showrunner-only; staffing never sent a contact)
  flexListContacts, flexContactKey, flexMatchContact, flexCreateContact,
  flexResolveContact, flexTimesNote, flexOmittedNote,
  // Showrunner extras
  flexConfigured, flexResetUserCache, flexElementUrl, notConfigured,
  flexIsFabricatedElementId
};
