#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/flex-test.js — lib/flex.js against RECORDED responses. No network.
// ────────────────────────────────────────────────────────────────────────────
//   node scripts/flex-test.js
//
// No database, no Flex key, no live call — global fetch is stubbed and every
// response below is the shape INTEGRATIONS_SPEC.md §3.4/§3.3 records from the
// May-13 probe output. This proves the six workarounds are actually IN the
// client, not merely described in a comment:
//
//   BUG 1  the /f5 prefix is added exactly once, and the X-Auth-Token header
//          (not Authorization: Bearer) carries the key
//   BUG 2  dates go out as ...Z, never with a ±HH:MM offset
//   BUG 3  a date-only field goes out as NOON CENTRAL expressed in UTC, and
//          the CDT/CST boundary is handled by Luxon rather than by hand
//   BUG 4  row-data is used; the dead node-list endpoint is never called
//   BUG 5  codeList is always sent non-empty, with node=root
//   BUG 6  a serial-tracked row's quantity (null) is treated as 1, and the
//          trailing "(6858)" is stripped so units aggregate by item type
//
// plus the three Showrunner-specific hardenings (a TTL on the user cache, a
// capped tree walk, statusUnavailable instead of a swallowed error) and the
// contract that a MISSING KEY is a loud 501, never a silent empty result.
//
// This is NOT a substitute for scripts/flex-probe.js. These are recorded
// shapes; only the probe can tell you whether the live BETA API still behaves
// this way. See R21 in particular: the pull-sheet grammar has never been
// observed and the test below encodes the SPEC, not evidence.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  \u2713 ${name}`); }
  else {
    fail += 1; failures.push(name);
    console.log(`  \u2717 ${name}${extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  }
}
function section(t) { console.log(`\n\u2500\u2500 ${t} ${'\u2500'.repeat(Math.max(0, 58 - t.length))}`); }

// ── the recorded fixtures (§3.4) ────────────────────────────────────────────
const IDENTITY_MANIFEST = {
  id: '7bde0d38-0000-0000-0000-000000000001',
  name: 'Dallas Renegades  (Hosting in Fort Hood TX)',
  documentNumber: '07CTI',
  definitionId: '9945d54c-af32-11df-b8d5-00e08175e43e',       // manifest
  // NOTE: comes back WITHOUT the Z it was sent with.
  plannedStartDate: '2026-05-13T17:00:00',
  plannedEndDate: '2026-05-25T17:00:00',
  deleted: false, domainId: 'equipment-list',
  displayName: 'Dallas Renegades  (Hosting in Fort Hood TX) (07CTI)'
};
const IDENTITY_PULLSHEET = { ...IDENTITY_MANIFEST, id: 'pull-0001', name: 'Pull Sheet A',
  documentNumber: '08PS', definitionId: 'a220432c-af33-11df-b8d5-00e08175e43e' };
const IDENTITY_FOLDER = { ...IDENTITY_MANIFEST, id: 'folder-0001', name: 'Event Folder',
  definitionId: '358f312c-b051-11df-b8d5-00e08175e43e' };

// BUG 6: serial-tracked units come back as N rows of quantity null, each with
// its own resourceId and the serial baked into the name.
const ROWDATA_MANIFEST = [
  { id: 'r1', leaf: true, group: false, resourceId: 'res-a', name: '2024 P10 Perimeter (6858)',
    barcode: 'A6B600000000000000006858', serial: '6858', isUnit: true, quantity: null, note: null, isNote: false },
  { id: 'r2', leaf: true, group: false, resourceId: 'res-b', name: '2024 P10 Perimeter (6859)',
    barcode: 'A6B600000000000000006859', serial: '6859', isUnit: true, quantity: null, note: null, isNote: false },
  { id: 'r3', leaf: true, group: false, resourceId: 'res-c', name: 'Data Cable 25ft',
    quantity: 12, isUnit: false, isNote: false },
  { id: 'r4', leaf: true, group: false, name: 'REMEMBER THE SPARES', isNote: true, quantity: null },
  { id: 'c1', leaf: false, group: false, name: 'Fabulux Quarter Pack (FQ007)', serial: 'FQ007',
    children: [
      { id: 'c1a', leaf: true, resourceId: 'res-d', name: 'Fabulux Tile (1101)', quantity: null, isUnit: true },
      { id: 'c1b', leaf: true, resourceId: 'res-e', name: 'Fabulux Tile (1102)', quantity: null, isUnit: true }
    ] },
  { id: 'c2', leaf: false, group: false, name: 'VT Mini Rack (VB-mini-6)', barcode: 'VB-mini-6',
    children: [{ id: 'c2a', leaf: true, resourceId: 'res-f', name: 'Novastar MX40 Pro', quantity: 1 }] }
];
// ⚠ R21: NO probe artifact of a pull sheet exists anywhere. This encodes the
// SPEC's claim (top-level rows with group===true whose children are items).
// scripts/flex-probe.js exists largely to find out whether it is true.
const ROWDATA_PULLSHEET = [
  { id: 'g1', group: true, leaf: false, name: 'LED',
    children: [{ id: 'g1a', leaf: true, resourceId: 'res-a', name: '2024 P10 Perimeter (6858)', quantity: null },
               { id: 'g1b', leaf: true, resourceId: 'res-b', name: '2024 P10 Perimeter (6859)', quantity: null }] },
  { id: 'g2', group: true, leaf: false, name: 'Processing',
    children: [{ id: 'g2a', leaf: true, resourceId: 'res-f', name: 'Novastar MX40 Pro', quantity: 2 }] }
];
const CURRENT_USER = { userId: 'user-uuid-1', contactId: 'contact-uuid-1', name: 'Tom Andres' };
const TREE = {
  nodeId: 'folder-0001', name: 'Event Folder', leaf: false, domainId: 'event-folder',
  children: [
    { nodeId: 'pull-0001', name: 'Pull Sheet A', documentNumber: '08PS', leaf: true, children: null },
    { nodeId: '7bde0d38-0000-0000-0000-000000000001', name: 'Manifest', documentNumber: '07CTI',
      leaf: true, children: null },
    { nodeId: 'other-0001', name: 'A Quote', documentNumber: 'Q1', leaf: true, children: null }
  ]
};

// ── the fetch stub ──────────────────────────────────────────────────────────
const calls = [];
let handler = null;
global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const res = handler ? handler(String(url), options) : null;
  if (!res) throw new Error('no stub for ' + url);
  return {
    ok: res.status === undefined || (res.status >= 200 && res.status < 300),
    status: res.status || 200,
    statusText: res.statusText || 'OK',
    headers: { get: () => 'application/json' },
    text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body))
  };
};
function route(url) {
  if (/\/user-profile\/current-user$/.test(url)) return { body: CURRENT_USER };
  if (/\/element\/pull-0001\/identity$/.test(url)) return { body: IDENTITY_PULLSHEET };
  if (/\/element\/folder-0001\/identity$/.test(url)) return { body: IDENTITY_FOLDER };
  if (/\/element\/other-0001\/identity$/.test(url)) return { body: { id: 'other-0001', definitionId: 'zzz' } };
  if (/\/element\/[^/]+\/identity$/.test(url)) return { body: IDENTITY_MANIFEST };
  if (/\/element\/folder-0001\/tree$/.test(url)) return { body: TREE };
  if (/\/line-item\/pull-0001\/row-data\//.test(url)) return { body: ROWDATA_PULLSHEET };
  if (/\/line-item\/[^/]+\/row-data\//.test(url)) return { body: ROWDATA_MANIFEST };
  if (/current-workflow-state/.test(url)) {
    return { body: [{ elementId: 'pull-0001', currentStatus: 'Prepped' }] };
  }
  if (/\/api\/element$/.test(url)) {
    return { body: { elementId: '6fe1b084-new', elementNumber: null, elementName: 'X',
                     definitionName: 'Event Folder', plannedStartDate: '2026-05-29T17:00:00' } };
  }
  return null;
}

(async function main() {
  console.log('lib/flex.js against recorded responses \u2014 NO network, NO key');

  // ── the unconfigured contract ─────────────────────────────────────────────
  section('unconfigured: a LOUD 501, never a silent empty result');
  delete process.env.FLEX_BASE_URL;
  delete process.env.FLEX_API_KEY;
  const flex = require('../lib/flex');
  ok('flexConfigured() is false with no env', flex.flexConfigured() === false);
  for (const fn of ['flexBaseUrl', 'flexApiKey']) {
    let e = null;
    try { flex[fn](); } catch (err) { e = err; }
    ok(`${fn}() throws`, !!e && e.status === 501 && /FLEX_/.test(e.message), e && e.message);
  }
  for (const fn of ['flexGetCurrentUser', 'flexGetElement', 'flexGetElementTree', 'flexGetRowData',
                    'flexFindGearListsUnder', 'flexFetchGearList']) {
    let e = null;
    try { await flex[fn]('x'); } catch (err) { e = err; }
    ok(`${fn}() throws 501, does not return []`,
       !!e && (e.status === 501 || /required/.test(e.message)), e && e.message);
  }
  let createErr = null;
  try { await flex.flexCreateEventFolder({ event: 'x', setup: '2026-05-01' }); }
  catch (e) { createErr = e; }
  ok('flexCreateEventFolder() throws 501', !!createErr && createErr.status === 501, createErr && createErr.message);
  ok('...and the message names BOTH env vars and where to get them',
     /FLEX_BASE_URL|FLEX_API_KEY/.test(createErr.message) && /staffing/.test(createErr.message),
     createErr.message);

  // ── configure and stub ────────────────────────────────────────────────────
  process.env.FLEX_BASE_URL = 'https://e360sport.flexrentalsolutions.com/';   // trailing slash on purpose
  process.env.FLEX_API_KEY = 'test-key-abc';
  flex.flexResetUserCache();
  handler = route;

  section('BUG 1 \u2014 the /f5 prefix and the X-Auth-Token header');
  ok('the trailing slash on FLEX_BASE_URL is stripped',
     flex.flexBaseUrl() === 'https://e360sport.flexrentalsolutions.com', flex.flexBaseUrl());
  calls.length = 0;
  const user = await flex.flexGetCurrentUser(true);
  ok('the URL is base + /f5 + path, with the prefix added exactly once',
     calls[0].url === 'https://e360sport.flexrentalsolutions.com/f5/api/user-profile/current-user',
     calls[0].url);
  ok('the key rides in X-Auth-Token, NOT Authorization: Bearer',
     calls[0].options.headers['X-Auth-Token'] === 'test-key-abc'
     && !calls[0].options.headers.Authorization, calls[0].options.headers);
  ok('flexGetCurrentUser normalizes {userId, contactId, name}',
     user.userId === 'user-uuid-1' && user.contactId === 'contact-uuid-1'
     && user.name === 'Tom Andres', user);
  let prefixErr = null;
  try { await flex.flexFetch('/f5/api/element'); } catch (e) { prefixErr = e; }
  ok('a caller who passes a path already containing /f5 gets a CLEAR error, not a 403 HTML page',
     !!prefixErr && /must NOT include the \/f5/.test(prefixErr.message), prefixErr && prefixErr.message);

  section('error shape (\u00a73.1)');
  handler = () => ({ status: 400, body: { exceptionMessage: 'Text could not be parsed at index 19' } });
  let apiErr = null;
  try { await flex.flexGetElement('x'); } catch (e) { apiErr = e; }
  ok('a non-2xx throws Error("Flex API <status>: <msg>") with .status and .body',
     !!apiErr && apiErr.message === 'Flex API 400: Text could not be parsed at index 19'
     && apiErr.status === 400 && !!apiErr.body, apiErr && apiErr.message);
  handler = () => ({ status: 403, body: '<html><body>Forbidden</body></html>' });
  let htmlErr = null;
  try { await flex.flexGetElement('x'); } catch (e) { htmlErr = e; }
  ok('a BUG-1-style HTML 403 surfaces its body instead of a JSON parse error',
     !!htmlErr && /403/.test(htmlErr.message) && /Forbidden/.test(htmlErr.message),
     htmlErr && htmlErr.message);
  handler = route;

  section('BUG 2 + BUG 3 \u2014 dates');
  const cdt = flex.flexDateToUtcInstant('2026-05-29');
  ok('a date-only value becomes NOON CENTRAL expressed as UTC (CDT: 17:00Z)',
     cdt === '2026-05-29T17:00:00Z', cdt);
  const cst = flex.flexDateToUtcInstant('2026-01-15');
  ok('...and 18:00Z in CST \u2014 Luxon handles the DST boundary, not a hand-rolled offset',
     cst === '2026-01-15T18:00:00Z', cst);
  ok('BUG 2: the output always ends in Z, never a \u00b1HH:MM offset',
     /Z$/.test(cdt) && !/[+-]\d\d:\d\d$/.test(cdt), cdt);
  ok('an explicit HH:MM time is honoured',
     flex.flexDateToUtcInstant('2026-05-29', '07:30') === '2026-05-29T12:30:00Z',
     flex.flexDateToUtcInstant('2026-05-29', '07:30'));
  ok('a non-HH:MM time falls back to noon (staffing/server.js:98)',
     flex.flexDateToUtcInstant('2026-05-29', 'lunchtime') === '2026-05-29T17:00:00Z');
  ok('a junk date is null, not an Invalid Date string',
     flex.flexDateToUtcInstant('not-a-date') === null
     && flex.flexDateToUtcInstant('') === null && flex.flexDateToUtcInstant(null) === null);
  ok('flexShiftDate is timezone-safe across a month boundary',
     flex.flexShiftDate('2026-03-01', -3) === '2026-02-26'
     && flex.flexShiftDate('2026-12-30', 7) === '2027-01-06',
     [flex.flexShiftDate('2026-03-01', -3), flex.flexShiftDate('2026-12-30', 7)]);
  ok('flexShiftDate spans the US DST change without drifting a day',
     flex.flexShiftDate('2026-03-07', 3) === '2026-03-10', flex.flexShiftDate('2026-03-07', 3));

  section('flexSanitizeName');
  ok('em/en dashes and friends all become hyphens',
     flex.flexSanitizeName('VNL \u2014 Chicago \u2013 Night \u2015 1 \u2212 A')
       === 'VNL - Chicago - Night - 1 - A',
     flex.flexSanitizeName('VNL \u2014 Chicago \u2013 Night \u2015 1 \u2212 A'));
  ok('null/undefined sanitize to an empty string',
     flex.flexSanitizeName(null) === '' && flex.flexSanitizeName(undefined) === '');

  section('BUG 4 + BUG 5 \u2014 row-data, not node-list');
  calls.length = 0;
  await flex.flexGetRowData('abc');
  ok('BUG 4: the flat /api/line-item/{id}/row-data/ endpoint is used',
     /\/f5\/api\/line-item\/abc\/row-data\//.test(calls[0].url), calls[0].url);
  ok('BUG 4: the dead /eqlist-line-item/node-list/ endpoint is NEVER called',
     !calls.some((c) => /eqlist-line-item/.test(c.url)), calls.map((c) => c.url));
  ok('BUG 5: codeList is sent NON-EMPTY, all three shipped codes',
     /codeList=name/.test(calls[0].url) && /codeList=quantity/.test(calls[0].url)
     && /codeList=note/.test(calls[0].url) && !/codeList=&/.test(calls[0].url), calls[0].url);
  ok('BUG 5: node=root is sent too', /[?&]node=root/.test(calls[0].url), calls[0].url);

  section('BUG 6 \u2014 quantity is null on serial-tracked units');
  const man = await flex.flexFetchGearList('abc', 'manifest');
  ok('the envelope reports type, name and documentNumber',
     man.type === 'manifest' && man.documentNumber === '07CTI', man);
  const loose = man.groups.find((g) => g.type === 'loose');
  ok('loose items are UNSHIFTED to the front of the group list',
     man.groups[0].type === 'loose', man.groups.map((g) => g.type));
  const perimeter = loose.items.find((i) => i.name === '2024 P10 Perimeter');
  ok('BUG 6: the trailing "(6858)" serial is stripped from the name',
     !!perimeter, loose.items.map((i) => i.name));
  ok('BUG 6: two quantity-null unit rows aggregate to qty 2, not 0 and not 1',
     perimeter.qty === 2, perimeter);
  const cable = loose.items.find((i) => i.name === 'Data Cable 25ft');
  ok('an untracked row with a real quantity keeps it', cable.qty === 12, cable);
  ok('isNote rows are not counted as gear',
     !loose.items.some((i) => /REMEMBER THE SPARES/.test(i.name)), loose.items.map((i) => i.name));
  const containers = man.groups.filter((g) => g.type === 'container');
  ok('non-leaf rows become containers with their serial/barcode',
     containers.length === 2 && containers[0].containerSerial === 'FQ007'
     && containers[1].containerSerial === 'VB-mini-6', containers.map((c) => c.containerSerial));
  ok('the container NAME is cleaned too', containers[0].name === 'Fabulux Quarter Pack',
     containers[0].name);
  ok('container contents aggregate by cleaned name (2 tiles, quantity null each)',
     containers[0].items.length === 1 && containers[0].items[0].qty === 2, containers[0].items);

  section('the pull-sheet grammar (\u26a0 R21 \u2014 SPEC ONLY, never observed)');
  const ps = await flex.flexFetchGearList('pull-0001', 'pull-sheet');
  ok('group===true rows become category groups',
     ps.groups.length === 2 && ps.groups.every((g) => g.type === 'category'),
     ps.groups.map((g) => [g.name, g.type]));
  ok('their children are the items, serials stripped and aggregated',
     ps.groups[0].items.length === 1 && ps.groups[0].items[0].qty === 2, ps.groups[0].items);
  handler = (url) => (/row-data/.test(url) ? { body: ROWDATA_MANIFEST } : route(url));
  const psFallback = await flex.flexFetchGearList('pull-0001', 'pull-sheet');
  ok('a pull sheet with NO group rows falls back to a flat list and SAYS SO',
     psFallback.groupingFellBack === true && psFallback.groups.length === 1,
     psFallback.groups.map((g) => g.type));
  handler = route;

  section('BUG 5\u2019s dangerous half \u2014 an empty list is SUSPICIOUS, not authoritative');
  handler = (url) => (/row-data/.test(url) ? { body: [] } : route(url));
  const empty = await flex.flexFetchGearList('abc', 'manifest');
  ok('an empty row-data response is flagged empty:true with rowCount 0',
     empty.empty === true && empty.rowCount === 0 && empty.groups.length === 0, empty);
  handler = route;

  section('R17/R18/R19 \u2014 the Showrunner hardenings');
  calls.length = 0;
  const lists = await flex.flexFindGearListsUnder('folder-0001');
  ok('only pull sheets and manifests are returned; unknown definitions are dropped',
     lists.length === 2 && lists.map((l) => l.type).sort().join(',') === 'manifest,pull-sheet',
     lists);
  ok('each carries id, name, documentNumber and type',
     lists.every((l) => l.id && l.name && l.type), lists);
  ok('R17: the walk is capped \u2014 the tree is fetched once, not once per node',
     calls.filter((c) => /\/tree$/.test(c.url)).length === 1,
     calls.filter((c) => /\/tree$/.test(c.url)).length);
  const enriched = await flex.flexEnrichWithStatus([{ id: 'pull-0001' }, { id: 'nope' }]);
  ok('flexEnrichWithStatus attaches the workflow state it finds',
     enriched[0].status === 'Prepped' && enriched[1].status === '', enriched);
  handler = (url) => (/current-workflow-state/.test(url) ? { status: 500, body: { message: 'boom' } } : route(url));
  const unenriched = await flex.flexEnrichWithStatus([{ id: 'pull-0001' }]);
  ok('R18: a failed status lookup sets statusUnavailable instead of silently looking like "no status"',
     unenriched[0].statusUnavailable === true && unenriched[0].status === '', unenriched[0]);
  handler = route;
  calls.length = 0;
  await flex.flexGetCurrentUser();
  ok('R19: the current-user result is cached (no second HTTP call)',
     calls.filter((c) => /current-user/.test(c.url)).length === 0, calls.map((c) => c.url));
  flex.flexResetUserCache();
  await flex.flexGetCurrentUser();
  ok('R19: ...and there IS a reset path for a rotated key \u2014 staffing has none',
     calls.filter((c) => /current-user/.test(c.url)).length === 1);

  section('flexCreateEventFolder \u2014 the payload (\u00a73.4)');
  calls.length = 0;
  const made = await flex.flexCreateEventFolder({
    event: 'VNL \u2014 Chicago', notes: '', setup: '2026-09-01', setupTime: '07:00',
    breakdown: '2026-09-05', shipOutDate: '2026-08-29', shipReturnDate: '2026-09-08' });
  const post = calls.find((c) => c.options.method === 'POST');
  const body = JSON.parse(post.options.body);
  ok('definitionId is the Event Folder definition',
     body.definitionId === '358f312c-b051-11df-b8d5-00e08175e43e', body.definitionId);
  ok('the name is sanitized (em-dash -> hyphen)', body.name === 'VNL - Chicago', body.name);
  ok('plannedStartDate = (shipOutDate) \u2212 3 days, at Central noon in UTC',
     body.plannedStartDate === '2026-08-26T17:00:00Z', body.plannedStartDate);
  ok('plannedEndDate = (shipReturnDate) + 7 days',
     body.plannedEndDate === '2026-09-15T17:00:00Z', body.plannedEndDate);
  ok('loadInDate carries the setup TIME when it matches HH:MM (07:00 CDT = 12:00Z)',
     body.loadInDate === '2026-09-01T12:00:00Z', body.loadInDate);
  ok('loadOutDate is the breakdown date at Central noon',
     body.loadOutDate === '2026-09-05T17:00:00Z', body.loadOutDate);
  ok('assignedToUserId / personResponsibleId come from the current user',
     body.assignedToUserId === 'user-uuid-1' && body.personResponsibleId === 'contact-uuid-1', body);
  ok('printNotes is true', body.printNotes === true);
  const FORBIDDEN = ['clientId', 'secondaryClientId', 'billToId', 'venueId', 'secondaryVenueId',
                     'facilityId', 'locationId', 'currencyId', 'statusId', 'salesPersonId',
                     'accountExecutiveId'];
  ok('none of the eleven NEVER-SEND fields is present',
     FORBIDDEN.every((k) => !(k in body)), Object.keys(body));
  ok('no customField*Value is sent', !Object.keys(body).some((k) => /^customField/.test(k)));
  ok('elementNumber (always null on Event Folders) is coerced to an empty string',
     made.elementNumber === '' && made.elementId === '6fe1b084-new', made);

  calls.length = 0;
  const noDates = await flex.flexCreateEventFolder({ event: 'X', setup: '2026-09-01' })
    .then(() => JSON.parse(calls.find((c) => c.options.method === 'POST').options.body));
  ok('loadOutDate is OMITTED entirely, never sent as null, when there is no breakdown',
     !('loadOutDate' in noDates), Object.keys(noDates));
  ok('plannedEndDate falls back to plannedStartDate when there is no end source',
     noDates.plannedEndDate === noDates.plannedStartDate, noDates);
  let m7 = null;
  try { await flex.flexCreateEventFolder({ event: 'X' }); } catch (e) { m7 = e; }
  ok('M7: no setup AND no shipOut is a 400 naming the problem, not an opaque 502',
     !!m7 && m7.status === 400 && /Setup or Ship Out/.test(m7.message), m7 && m7.message);

  section('deep link');
  ok('the element URL carries the # SPA marker',
     flex.flexElementUrl('abc-123')
       === 'https://e360sport.flexrentalsolutions.com/f5/ui/#element/abc-123',
     flex.flexElementUrl('abc-123'));

  // ════════════════════════════════════════════════════════════════════════
  // CONTACTS — the directory, the match, the (unprobed) create, the omit
  // ────────────────────────────────────────────────────────────────────────
  // Fixtures are the REAL 24 names read from the live tenant on 2026-08-27
  // (probe: flex-probe/contact-page0.json), plus one deleted row that must
  // never match. Note what is NOT in the list: "Big Ten Conference" and
  // "Wrigley Field" — Show 1's client and venue. That absence is the whole
  // reason the create-contacts option exists.
  // ════════════════════════════════════════════════════════════════════════
  const DIRECTORY_NAMES = [
    'Camping World Stadium Orlando', 'Unified Events', 'e360Sport', 'Citrus Sports group  Co',
    'Hard Rock  Stadium', 'Athletico Dallas', 'E360 Sport', 'Larry  Farkos', 'Flex Support',
    'LOVB', 'Razorback Stadium', 'Citrus Sports Group', 'Northwest Stadium', 'Tom Andres',
    'UFL', 'Andrew Dallas', 'Chris Stein', 'Ethan Klohr', 'Allegiant ', 'Kansas City Municipal',
    'Orange Bowl Committee', 'Big Ten Network', 'SEC Network', 'Wrigley Rooftops'
  ];
  const DIRECTORY = DIRECTORY_NAMES.map((n, i) => ({
    id: 'contact-' + String(i).padStart(2, '0'), name: n, preferredDisplayString: null,
    barcode: null, deleted: false, shortName: null, domainId: 'contact',
    className: 'CONTACT', shortNameOrName: n
  }));
  // A DELETED row bearing exactly the name we will search for. If the client
  // ever matches this, a folder gets linked to a contact nobody can see.
  DIRECTORY.push({ id: 'contact-deleted', name: 'Wrigley Field', deleted: true,
                   domainId: 'contact', className: 'CONTACT' });

  let contactPostMode = 'ok';        // 'ok' | 'fail' | 'noid'
  let contactPosts = [];
  function contactPage(url) {
    const size = parseInt((url.match(/[?&]size=(\d+)/) || [])[1] || '20', 10);
    const page = parseInt((url.match(/[?&]page=(\d+)/) || [])[1] || '0', 10);
    const totalPages = Math.max(1, Math.ceil(DIRECTORY.length / size));
    const from = Math.min(page * size, DIRECTORY.length);
    const content = DIRECTORY.slice(from, from + size);
    return { body: { content, totalElements: DIRECTORY.length, totalPages, size,
                     number: page, last: page + 1 >= totalPages, first: page === 0,
                     numberOfElements: content.length, empty: !content.length } };
  }
  function contactRoute(url, options) {
    if (/\/api\/contact\b/.test(url) && options && options.method === 'POST') {
      contactPosts.push(JSON.parse(options.body));
      if (contactPostMode === 'fail') return { status: 403, body: { exceptionMessage: 'not permitted' } };
      if (contactPostMode === 'noid') return { body: { name: 'whatever', organization: true } };
      return { body: { id: 'contact-NEW', name: JSON.parse(options.body).name, organization: true } };
    }
    if (/\/api\/contact\?/.test(url) || /\/api\/contact$/.test(url)) return contactPage(url);
    return route(url);
  }

  section('contacts — the directory read (C1/C2)');
  handler = contactRoute;
  calls.length = 0;
  const dir = await flex.flexListContacts();
  ok('the whole directory comes back, not one page',
     dir.length === DIRECTORY_NAMES.length, dir.length);
  ok('the page envelope is unwrapped to {id,name} rows',
     dir.every((c) => typeof c.id === 'string' && typeof c.name === 'string'), dir[0]);
  ok('a DELETED contact is dropped — a folder must not link to one nobody can see',
     !dir.some((c) => c.id === 'contact-deleted'), dir.filter((c) => /deleted/.test(c.id)));
  ok('one call suffices when size covers the directory (24 rows, size=200)',
     calls.filter((c) => /\/api\/contact/.test(c.url)).length === 1,
     calls.map((c) => c.url));
  calls.length = 0;
  const paged = await flex.flexListContacts({ pageSize: 10 });
  ok('...and it really pages when the page is smaller than the directory',
     paged.length === DIRECTORY_NAMES.length &&
     calls.filter((c) => /\/api\/contact/.test(c.url)).length === 3, {
       got: paged.length, calls: calls.length });
  ok('every page carries BOTH page and size — `size` is the only one Flex honours',
     calls.every((c) => /[?&]page=\d+/.test(c.url) && /[?&]size=\d+/.test(c.url)),
     calls.map((c) => c.url));

  section('contacts — the local match is EXACT, never fuzzy');
  ok('an exact name matches',
     (flex.flexMatchContact('Kansas City Municipal', dir) || {}).name === 'Kansas City Municipal');
  ok('case does not matter',
     (flex.flexMatchContact('kansas city MUNICIPAL', dir) || {}).name === 'Kansas City Municipal');
  ok('the double space a human typed does not matter ("Hard Rock  Stadium")',
     (flex.flexMatchContact('Hard Rock Stadium', dir) || {}).name === 'Hard Rock  Stadium');
  ok('a trailing space does not matter ("Allegiant ")',
     (flex.flexMatchContact('Allegiant', dir) || {}).name === 'Allegiant ');
  ok('a PREFIX is not a match — "Citrus Sports Group" is not "Citrus Sports group  Co"',
     (flex.flexMatchContact('Citrus Sports Group', dir) || {}).id === 'contact-11',
     flex.flexMatchContact('Citrus Sports Group', dir));
  ok('a substring is not a match ("Big Ten Conference" vs "Big Ten Network")',
     flex.flexMatchContact('Big Ten Conference', dir) === null,
     flex.flexMatchContact('Big Ten Conference', dir));
  ok('"Wrigley Field" matches NOTHING — the live directory really has no venue for Show 1',
     flex.flexMatchContact('Wrigley Field', dir) === null);
  ok('an empty name never matches anything',
     flex.flexMatchContact('', dir) === null && flex.flexMatchContact(null, dir) === null);

  section('contacts — resolve: matched / created / omitted, and it SAYS WHICH');
  const rMatched = await flex.flexResolveContact('LOVB', { directory: dir, create: true });
  ok('a match reports `matched` and sends the directory id',
     rMatched.outcome === 'matched' && rMatched.id === dir.find((c) => c.name === 'LOVB').id, rMatched);
  ok('...and never POSTs a duplicate when a match exists',
     contactPosts.length === 0, contactPosts);

  const rOff = await flex.flexResolveContact('Wrigley Field', { directory: dir, create: false });
  ok('no match with creation OFF is `omitted` with a null id',
     rOff.outcome === 'omitted' && rOff.id === null, rOff);
  ok('...and the reason names both facts a human needs',
     /no exact match/i.test(rOff.reason) && /create missing contacts/i.test(rOff.reason), rOff.reason);
  ok('...and the NAME survives, so the caller can still put it in the notes',
     rOff.name === 'Wrigley Field', rOff);

  contactPosts = [];
  contactPostMode = 'ok';
  const rMade = await flex.flexResolveContact('Wrigley Field', { directory: dir, create: true });
  ok('no match with creation ON creates it and reports `created`',
     rMade.outcome === 'created' && rMade.id === 'contact-NEW', rMade);
  ok('the create payload mirrors a real organisation contact (C3): name + organization + company',
     contactPosts.length === 1 && contactPosts[0].name === 'Wrigley Field' &&
     contactPosts[0].organization === true && contactPosts[0].company === 'Wrigley Field',
     contactPosts[0]);
  ok('the created name is SANITIZED like every other Flex write',
     (await flex.flexResolveContact('Big Ten — SEC', { directory: dir, create: true }))
       && contactPosts[contactPosts.length - 1].name === 'Big Ten - SEC',
     contactPosts[contactPosts.length - 1]);

  contactPosts = [];
  contactPostMode = 'fail';
  const rFailed = await flex.flexResolveContact('Wrigley Field', { directory: dir, create: true });
  ok('a FAILED create falls back to `omitted` — it never throws, never invents an id',
     rFailed.outcome === 'omitted' && rFailed.id === null, rFailed);
  ok('...and the reason carries what Flex actually said',
     /creating it in Flex failed/i.test(rFailed.reason) && /403|not permitted/i.test(rFailed.reason),
     rFailed.reason);

  contactPostMode = 'noid';
  const rNoId = await flex.flexResolveContact('Wrigley Field', { directory: dir, create: true });
  ok('a 200 with NO id is a failure, not a success — refusing to guess is the point',
     rNoId.outcome === 'omitted' && /returned no id/i.test(rNoId.reason), rNoId);
  contactPostMode = 'ok';

  contactPosts = [];
  const rNoName = await flex.flexResolveContact('  ', { directory: dir, create: true, label: 'venue' });
  ok('a show with no venue name omits, and POSTs nothing',
     rNoName.outcome === 'omitted' && rNoName.id === null && contactPosts.length === 0, rNoName);
  ok('...and says so in words a PM can act on',
     /no venue name on this show/i.test(rNoName.reason), rNoName.reason);

  handler = (url, options) => (/\/api\/contact/.test(url) && (!options || options.method !== 'POST')
    ? { status: 500, body: { exceptionMessage: 'directory exploded' } }
    : contactRoute(url, options));
  const rDirDown = await flex.flexResolveContact('LOVB', { create: false });
  ok('an unreadable directory omits with the reason — it does NOT fail the folder create',
     rDirDown.outcome === 'omitted' && /directory could not be read/i.test(rDirDown.reason), rDirDown);
  handler = contactRoute;

  section('the notes line — the times the Event Folder form cannot hold');
  ok('all four parts render in order',
     flex.flexTimesNote({ eventDate: '2026-09-06', doorsTime: '17:30', showTime: '19:00', strikeTime: '23:00' })
       === 'Event: 2026-09-06 · Doors 17:30 · Show 19:00 · Strike 23:00',
     flex.flexTimesNote({ eventDate: '2026-09-06', doorsTime: '17:30', showTime: '19:00', strikeTime: '23:00' }));
  ok('empty times are OMITTED, never rendered as a dash (Show 1 has none)',
     flex.flexTimesNote({ eventDate: '2026-09-06', doorsTime: null, showTime: '', strikeTime: undefined })
       === 'Event: 2026-09-06',
     flex.flexTimesNote({ eventDate: '2026-09-06' }));
  ok('a Postgres TIME value (HH:MM:SS) is trimmed to HH:MM',
     flex.flexTimesNote({ eventDate: '2026-09-06', showTime: '19:00:00' })
       === 'Event: 2026-09-06 · Show 19:00');
  ok('a single-digit hour is padded', flex.flexTimesNote({ doorsTime: '7:05' }) === 'Doors 07:05');
  ok('no date and no times is an EMPTY string, not the word undefined',
     flex.flexTimesNote({}) === '' && flex.flexTimesNote() === '');
  ok('a malformed date is dropped rather than passed through',
     flex.flexTimesNote({ eventDate: 'next Tuesday', showTime: '19:00' }) === 'Show 19:00');

  ok('an omitted contact gets its own notes line, so the fact lands SOMEWHERE',
     flex.flexOmittedNote({ client: { outcome: 'matched', name: 'LOVB' },
                            venue: { outcome: 'omitted', name: 'Wrigley Field' } })
       === 'Venue: Wrigley Field (not linked in Flex)',
     flex.flexOmittedNote({ venue: { outcome: 'omitted', name: 'Wrigley Field' } }));
  ok('...and nothing is said when both landed',
     flex.flexOmittedNote({ client: { outcome: 'created', name: 'A' }, venue: { outcome: 'matched', name: 'B' } }) === '');

  section('the folder payload with contacts — sent only when RESOLVED');
  calls.length = 0;
  const withContacts = await flex.flexCreateEventFolder({
    event: 'Big Ten vs. SEC Challenge — Wrigley Field',
    notes: 'Event: 2026-09-06',
    setup: '2026-09-05', breakdown: '2026-09-07',
    clientId: 'contact-CLIENT', venueId: 'contact-VENUE'
  });
  const bodyC = JSON.parse(calls.find((c) => c.options.method === 'POST').options.body);
  ok('clientId and venueId ride along when the caller resolved them',
     bodyC.clientId === 'contact-CLIENT' && bodyC.venueId === 'contact-VENUE', bodyC);
  ok('Show 1’s em-dash is a hyphen by the time it reaches Flex',
     bodyC.name === 'Big Ten vs. SEC Challenge - Wrigley Field', bodyC.name);
  ok('the notes line is carried verbatim', bodyC.notes === 'Event: 2026-09-06', bodyC.notes);
  ok('the payload is returned to the caller for the audit trail',
     withContacts.payload && withContacts.payload.name === bodyC.name, withContacts.payload);

  calls.length = 0;
  await flex.flexCreateEventFolder({ event: 'X', setup: '2026-09-05' });
  const bodyN = JSON.parse(calls.find((c) => c.options.method === 'POST').options.body);
  ok('an UNRESOLVED contact leaves the key ABSENT — not null, not empty string',
     !('clientId' in bodyN) && !('venueId' in bodyN), Object.keys(bodyN));
  const STILL_NEVER = ['secondaryClientId', 'billToId', 'secondaryVenueId', 'facilityId',
                       'locationId', 'currencyId', 'statusId', 'salesPersonId', 'accountExecutiveId'];
  ok('the other NINE never-send fields are still never sent',
     STILL_NEVER.every((k) => !(k in bodyC) && !(k in bodyN)), Object.keys(bodyC));

  section('recognising the prototype’s fabricated ids');
  ok('a modeled uuid is recognised',
     flex.flexIsFabricatedElementId('1a2b3c4d-b1cc-4e90-83ce-bbd69eb3e4fa') === true);
  ok('a real Flex id is not',
     flex.flexIsFabricatedElementId('4b0b74e9-6480-43b3-821f-247f3adf45d2') === false);
  ok('null / empty are not ids at all',
     flex.flexIsFabricatedElementId(null) === false && flex.flexIsFabricatedElementId('') === false);

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // THE READ PATH \u2014 fixtures are the REAL live responses, not the spec
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Everything above this line for the pull-sheet grammar carried R21: "no
  // probe evidence, written from the spec". This section retires that warning
  // for the read path. Every fixture below is copied out of a read-only GET
  // made against the live tenant on 2026-08-28 \u2014
  //   folder 257e6ba3-0ced-4ab0-9af4-976bb21c99c6 (Track Town Residency)
  //   pull sheet 2e63b247-62e3-47b1-8460-88a9bb32bfba (TT_26_1)
  // \u2014 including the nested container rows the first flat probe print had
  // hidden, which are the whole reason flexNormalizePullSheet looks the way
  // it does.
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  section('the READ path \u2014 fixtures captured LIVE 2026-08-28');

  const TT_FOLDER = '257e6ba3-0ced-4ab0-9af4-976bb21c99c6';
  const TT_LIST = '2e63b247-62e3-47b1-8460-88a9bb32bfba';
  const TT_CHILD = 'd0a53187-799e-4f57-bdcb-b3fe41632a9e';
  const TT_USER = '21ad5aca-11d8-4e8c-952a-fd10c5ad77d0';

  // verbatim /api/element/{folder}/tree
  const TT_TREE = {
    nodeId: TT_FOLDER, name: 'Track Town Residency', documentNumber: null, parentId: 'root',
    leaf: false, domainId: 'simple-project-element',
    children: [{
      nodeId: TT_LIST, name: 'Track Town Residency', documentNumber: 'TT_26_1',
      parentId: TT_FOLDER, leaf: false, domainId: 'equipment-list',
      children: [{
        nodeId: TT_CHILD, name: 'Track Town Residency', documentNumber: '5FAXQ',
        parentId: TT_LIST, leaf: true, domainId: 'equipment-list', children: null,
        displayName: 'Track Town Residency (5FAXQ)'
      }],
      displayName: 'Track Town Residency (TT_26_1)'
    }],
    displayName: 'Track Town Residency'
  };

  // the interesting 40 of /api/equipment-list/{id}'s 127 keys
  const TT_HEADER = {
    id: TT_LIST, name: 'Track Town Residency', documentNumber: 'TT_26_1',
    definitionId: 'a220432c-af33-11df-b8d5-00e08175e43e',   // pull sheet
    domainId: 'equipment-list', deleted: false, locked: false, open: true,
    plannedStartDate: '2026-05-19T05:00:00', plannedEndDate: '2026-07-10T04:00:00',
    loadInDate: '2026-05-26T13:00:00', loadOutDate: '2026-07-04T21:00:00',
    preparedDate: null, weight: 0, clientId: null, venueId: null,
    prepCompleted: true, deprepCompleted: false, returnCompleted: false,
    shipCompleted: false, receiveCompleted: false, subrentalReturnCompleted: false,
    prepCompletedUserId: TT_USER, deprepCompletedUserId: null, returnCompletedUserId: null,
    shipCompletedUserId: null, receiveCompletedUserId: null, subrentalReturnCompletedUserId: null,
    prepCompletedTimestamp: '2026-05-19T20:35:50', deprepCompletedTimestamp: null,
    returnCompletedTimestamp: null, shipCompletedTimestamp: null,
    receiveCompletedTimestamp: null, subrentalReturnCompletedTimestamp: null,
    prepManifestId: TT_CHILD, deprepManifestId: null, shipManifestId: null,
    returnManifestId: null, receiveManifestId: null, subrentalReturnManifestId: null,
    displayName: 'Track Town Residency (TT_26_1)'
  };

  // three of the nine real top-level rows. The Fiber Spools group is the one
  // that matters: two of its three children are `container:true` rows that
  // carry their OWN resourceId, barcode and quantity AND hold a breakout.
  const TT_ROWDATA = [
    { id: 'row-led', rootLineId: 'row-led', ordinal: 0, leaf: false, resourceId: null,
      name: 'Modular LED Cabinets', group: true, isNote: false, quantity: 0,
      serial: null, barcode: null,
      children: [
        { id: 'it-led', rootLineId: 'row-led', ordinal: 0, container: false, leaf: true,
          resourceId: '38b461bc-371a-4714-9407-49210f6bf3af',
          name: '3.9 blackface - 500mm x 500mm', group: false, note: '', isNote: false,
          quantity: 48, serial: null, barcode: '00009' }
      ] },
    { id: 'row-soca', rootLineId: 'row-soca', ordinal: 1, leaf: false, resourceId: null,
      name: 'Socapex Cables', group: true, isNote: false, quantity: 0, serial: null, barcode: null,
      children: [
        { id: 'it-fan', rootLineId: 'row-soca', ordinal: 0, container: false, leaf: true,
          resourceId: 'c7646df0-174e-415d-8b86-f15e922ac7eb',
          name: "Soca to True 1 Fanout - 6'", group: false, note: null, isNote: false,
          quantity: 7, serial: null, barcode: '00026' },
        { id: 'it-100', rootLineId: 'row-soca', ordinal: 1, container: false, leaf: true,
          resourceId: '37036f66-077e-44b3-b625-884c53107c35',
          name: 'Socapex  Power Cable 100ft - 100ft', group: false, note: null, isNote: false,
          quantity: 3, serial: null, barcode: '00016' }
      ] },
    { id: 'row-fiber', rootLineId: 'row-fiber', ordinal: 5, leaf: false, resourceId: null,
      name: 'Fiber Spools', group: true, isNote: false, quantity: 0, serial: null, barcode: null,
      children: [
        { id: 'it-300', rootLineId: 'row-fiber', ordinal: 0, container: true, leaf: false,
          resourceId: '5eab37ab-acd1-4f34-9989-6734fdff708d',
          name: 'Mediacom 300m 12 Channel fiber spool', group: false, note: null, isNote: false,
          quantity: 1, serial: null, barcode: '00068',
          children: [
            { id: 'it-bo1', rootLineId: 'row-fiber', ordinal: 0, container: false, leaf: true,
              resourceId: '88cb63de-2eac-4538-b437-acc17f1fc8d6',
              name: 'Media Com Breakout', group: false, note: null, isNote: false,
              quantity: 2, serial: null, barcode: '00059' }
          ] },
        { id: 'it-see', rootLineId: 'row-fiber', ordinal: 1, container: false, leaf: true,
          resourceId: 'b2321c3e-add5-46a8-8a8b-ec790a8cc1f1',
          name: 'Seetronic 300m 4-channel LC spool - 300 meters', group: false, note: null,
          isNote: false, quantity: 3, serial: null, barcode: '00057' }
      ] }
  ];
  const TT_USER_PROFILE = { id: TT_USER, name: 'Tom Andres', userName: 'tandres',
                            emailAddress: 'tom@e360sport.com', deleted: false };

  let userProfileCalls = 0;
  function readRoute(url, options) {
    if (options && options.method && options.method !== 'GET') {
      return { status: 405, body: { exceptionMessage: 'WRITE ATTEMPTED on the read path: ' + url } };
    }
    if (new RegExp(`/element/${TT_FOLDER}/tree$`).test(url)) return { body: TT_TREE };
    if (new RegExp(`/equipment-list/${TT_LIST}$`).test(url)) return { body: TT_HEADER };
    if (new RegExp(`/equipment-list/${TT_CHILD}$`).test(url)) {
      return { body: { ...TT_HEADER, id: TT_CHILD, documentNumber: '5FAXQ',
                       definitionId: '9945d54c-af32-11df-b8d5-00e08175e43e' } };  // manifest
    }
    if (new RegExp(`/line-item/${TT_LIST}/row-data/`).test(url)) return { body: TT_ROWDATA };
    if (/\/user-profile\/current-user$/.test(url)) return { body: CURRENT_USER };
    if (/\/user-profile\/[0-9a-f-]{36}$/.test(url)) { userProfileCalls += 1; return { body: TT_USER_PROFILE }; }
    return route(url, options);
  }
  handler = readRoute;
  flex.flexResetUserNameCache();

  // \u2500\u2500 the picker: ONE tree call, no identity storm \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  calls.length = 0;
  const found = await flex.flexListEquipmentListsUnder(TT_FOLDER);
  ok('flexListEquipmentListsUnder spends exactly ONE call \u2014 the tree',
     calls.length === 1 && /\/tree$/.test(calls[0].url), calls.map((c) => c.url));
  ok('...and NO /identity call: the tree already says which nodes are gear lists',
     !calls.some((c) => /identity/.test(c.url)), calls.map((c) => c.url));
  ok('both equipment lists come back \u2014 the pull sheet AND its nested prep manifest',
     found.lists.length === 2 && found.lists[0].docNumber === 'TT_26_1'
     && found.lists[1].docNumber === '5FAXQ', found.lists.map((l) => l.docNumber));
  ok('the FOLDER itself is not offered as a gear list',
     !found.lists.some((l) => l.id === TT_FOLDER), found.lists.map((l) => l.id));
  ok('each list carries id, name, docNumber, domainId, parentId and depth',
     found.lists.every((l) => l.id && l.name && l.domainId === 'equipment-list' && l.parentId)
     && found.lists[0].depth === 1 && found.lists[1].depth === 2, found.lists[1]);
  ok('the deep link ends in /view/equipmentlist/header, not the bare element url',
     found.lists[0].deepLink ===
       `https://e360sport.flexrentalsolutions.com/f5/ui/#element/${TT_LIST}/view/equipmentlist/header`,
     found.lists[0].deepLink);
  ok('`type` is NULL, not guessed \u2014 the tree cannot tell a pull sheet from a manifest',
     found.lists.every((l) => l.type === null), found.lists.map((l) => l.type));
  ok('empty is false and the folder NAME rides along for the honest message',
     found.empty === false && found.folderName === 'Track Town Residency', found.folderName);

  handler = (url, o) => (/\/tree$/.test(url)
    ? { body: { nodeId: 'bare', name: 'Wrigley Field Folder', leaf: true,
                domainId: 'simple-project-element', children: null } }
    : readRoute(url, o));
  const bare = await flex.flexListEquipmentListsUnder('bare');
  ok('a folder with NO children reports empty:true and an empty list \u2014 the new Wrigley folder\u2019s state',
     bare.empty === true && bare.lists.length === 0 && bare.folderName === 'Wrigley Field Folder', bare);
  handler = readRoute;

  // \u2500\u2500 the read: header + row-data, and the status block \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  calls.length = 0;
  userProfileCalls = 0;
  const sheet = await flex.flexReadPullSheet(TT_LIST);
  ok('flexReadPullSheet reads the equipment-list HEADER (not /identity)',
     calls.some((c) => new RegExp(`/f5/api/equipment-list/${TT_LIST}$`).test(c.url))
     && !calls.some((c) => /identity/.test(c.url)), calls.map((c) => c.url));
  ok('...and the line items through row-data, with codeList non-empty and node=root',
     calls.some((c) => /\/line-item\/.+\/row-data\/\?/.test(c.url) && /codeList=name/.test(c.url)
                       && /[?&]node=root/.test(c.url)), calls.map((c) => c.url));
  ok('...and NEVER the dead node-list endpoint',
     !calls.some((c) => /eqlist-line-item/.test(c.url)), calls.map((c) => c.url));
  ok('EVERY call on the read path is a GET \u2014 nothing here can write to Flex',
     calls.every((c) => !c.options.method || c.options.method === 'GET'),
     calls.map((c) => (c.options.method || 'GET') + ' ' + c.url));
  ok('the type comes from the header\u2019s definitionId \u2014 pull-sheet, for free',
     sheet.type === 'pull-sheet' && sheet.docNumber === 'TT_26_1', { type: sheet.type, doc: sheet.docNumber });
  ok('all six workflow stages are reported, done or not, in job order',
     sheet.status.stages.length === 6
     && sheet.status.stages.map((s) => s.key).join(',') === 'prep,deprep,ship,return,receive,subrentalReturn',
     sheet.status.stages.map((s) => s.key));
  const prep = sheet.status.stages[0];
  ok('the prep stage carries done + when + who, resolved to a NAME',
     prep.done === true && prep.at === '2026-05-19T20:35:50' && prep.by === 'Tom Andres'
     && prep.byUserId === TT_USER, prep);
  ok('...and the manifest Flex generated for that stage',
     prep.manifestId === TT_CHILD, prep.manifestId);
  ok('an INCOMPLETE stage is done:false with a null timestamp \u2014 never absent',
     sheet.status.stages.slice(1).every((s) => s.done === false && s.at === null && s.by === ''),
     sheet.status.stages[2]);
  ok('exactly ONE user-profile lookup for the one distinct completing user',
     userProfileCalls === 1, userProfileCalls);
  userProfileCalls = 0;
  await flex.flexReadPullSheet(TT_LIST);
  ok('...and a second read spends ZERO \u2014 the name cache is process-wide',
     userProfileCalls === 0, userProfileCalls);
  ok('the dates block carries all four, verbatim (no Z on the way BACK \u2014 \u00a73.4)',
     sheet.dates.plannedStart === '2026-05-19T05:00:00' && sheet.dates.loadIn === '2026-05-26T13:00:00'
     && sheet.dates.loadOut === '2026-07-04T21:00:00', sheet.dates);
  ok('locked / open / weight ride along', sheet.locked === false && sheet.open === true, sheet);
  ok('the sheet knows WHEN it was read \u2014 nothing here is cached, so the time matters',
     /^\d{4}-\d{2}-\d{2}T/.test(sheet.fetchedAt), sheet.fetchedAt);

  // \u2500\u2500 the normalization: the nested container row is the whole point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  ok('every group row (group===true) becomes a group; three of them',
     sheet.groups.filter((g) => g.type === 'category').length === 3,
     sheet.groups.map((g) => [g.path, g.type]));
  const fiber = sheet.groups.find((g) => g.path === 'Fiber Spools');
  ok('a CONTAINED row is still an ITEM \u2014 the Mediacom spool keeps its qty and barcode',
     !!fiber && fiber.items.length === 2
     && fiber.items[0].name === 'Mediacom 300m 12 Channel fiber spool'
     && fiber.items[0].qty === 1 && fiber.items[0].barcode === '00068',
     fiber && fiber.items.map((i) => [i.name, i.qty]));
  ok('...and it says how many things are inside it',
     fiber.items[0].contains === 1 && fiber.items[1].contains === 0,
     fiber.items.map((i) => i.contains));
  const inner = sheet.groups.find((g) => g.path === 'Fiber Spools / Mediacom 300m 12 Channel fiber spool');
  ok('...AND opens a path-named sub-group for its contents',
     !!inner && inner.type === 'container' && inner.items.length === 1
     && inner.items[0].name === 'Media Com Breakout' && inner.items[0].qty === 2, inner);
  ok('the container sub-group carries the container\u2019s own barcode',
     inner.containerSerial === '00068', inner.containerSerial);
  ok('a HEADING is never counted as gear \u2014 no item is named after a group',
     !sheet.groups.some((g) => g.items.some((i) => i.name === 'Fiber Spools')),
     sheet.groups.map((g) => g.items.map((i) => i.name)));
  // 48 cabinets + 7 fanouts + 3 socapex + 1 spool + 3 seetronic + 2 breakouts.
  // The spool's own 1 is the unit the first version of the normalizer dropped.
  ok('totals count the contained spool: 4 groups, 6 lines, 64 units',
     sheet.totals.groups === 4 && sheet.totals.lines === 6 && sheet.totals.units === 64,
     sheet.totals);
  ok('rows are NOT aggregated by name \u2014 every line keeps its own barcode',
     sheet.groups.find((g) => g.path === 'Socapex Cables').items
       .map((i) => i.barcode).join(',') === '00026,00016',
     sheet.groups.find((g) => g.path === 'Socapex Cables').items.map((i) => i.barcode));
  ok('a real quantity is never flagged as assumed',
     sheet.groups.every((g) => g.items.every((i) => i.qtyAssumed === false)),
     sheet.groups.map((g) => g.items.map((i) => i.qtyAssumed)));

  // \u2500\u2500 the OTHER grammar, and BUG 6, through the same normalizer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const mixed = flex.flexNormalizePullSheet(ROWDATA_MANIFEST);
  ok('manifest grammar: top-level leaves become a Loose Items group, UNSHIFTED first',
     mixed.groups[0].type === 'loose' && mixed.groups[0].name === 'Loose Items',
     mixed.groups.map((g) => [g.name, g.type]));
  ok('a bare case (children, NO resourceId) stays a heading \u2014 it is not gear',
     !mixed.groups[0].items.some((i) => /Fabulux Quarter Pack/.test(i.name)),
     mixed.groups[0].items.map((i) => i.name));
  ok('...and still becomes its own container group carrying its serial',
     mixed.groups.some((g) => g.name === 'Fabulux Quarter Pack' && g.containerSerial === 'FQ007'),
     mixed.groups.map((g) => [g.name, g.containerSerial]));
  const serialed = mixed.groups[0].items.filter((i) => i.name === '2024 P10 Perimeter');
  ok('BUG 6: two serial-tracked rows stay TWO lines here \u2014 the aggregation was the lossy part',
     serialed.length === 2, serialed.map((i) => i.serial));
  ok('BUG 6: the trailing "(6858)" is stripped from the name and LIFTED into serial',
     serialed[0].serial === '6858' && serialed[1].serial === '6859'
     && serialed[0].rawName === '2024 P10 Perimeter (6858)', serialed);
  ok('BUG 6: a null quantity counts as 1 and SAYS SO with qtyAssumed',
     serialed[0].qty === 1 && serialed[0].qtyAssumed === true, serialed[0]);
  ok('...while a real quantity is not flagged',
     mixed.groups[0].items.find((i) => i.name === 'Data Cable 25ft').qty === 12
     && mixed.groups[0].items.find((i) => i.name === 'Data Cable 25ft').qtyAssumed === false);
  ok('isNote rows are still not gear',
     !mixed.groups.some((g) => g.items.some((i) => /REMEMBER THE SPARES/.test(i.name))),
     mixed.groups.map((g) => g.items.map((i) => i.name)));

  // \u2500\u2500 BUG 5's dangerous half on the read path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  handler = (url, o) => (/row-data/.test(url) ? { body: [] } : readRoute(url, o));
  const emptyRead = await flex.flexReadPullSheet(TT_LIST);
  ok('BUG 5: an empty row-data answer is flagged empty:true with rowCount 0, not reported as a fact',
     emptyRead.empty === true && emptyRead.rowCount === 0 && emptyRead.groups.length === 0,
     { empty: emptyRead.empty, rows: emptyRead.rowCount });
  ok('...and the HEADER is still fully reported, so the status line survives an empty read',
     emptyRead.docNumber === 'TT_26_1' && emptyRead.status.stages[0].done === true, emptyRead.docNumber);
  handler = readRoute;

  // \u2500\u2500 fail-soft: a cosmetic lookup must never fail a pull-sheet read \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  flex.flexResetUserNameCache();
  handler = (url, o) => (/\/user-profile\/[0-9a-f-]{36}$/.test(url)
    ? { status: 500, body: { exceptionMessage: 'user service down' } } : readRoute(url, o));
  const noName = await flex.flexReadPullSheet(TT_LIST);
  ok('R18-style: an unresolvable user leaves `by` empty and the READ STILL SUCCEEDS',
     noName.status.stages[0].done === true && noName.status.stages[0].by === ''
     && noName.status.stages[0].byUserId === TT_USER && noName.groups.length === 4,
     noName.status.stages[0]);
  handler = readRoute;
  flex.flexResetUserNameCache();

  // \u2500\u2500 the unconfigured contract holds for the new functions too \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const savedUrl = process.env.FLEX_BASE_URL, savedKey = process.env.FLEX_API_KEY;
  delete process.env.FLEX_BASE_URL;
  delete process.env.FLEX_API_KEY;
  for (const fn of ['flexGetEquipmentList', 'flexListEquipmentListsUnder', 'flexReadPullSheet']) {
    let e = null;
    try { await flex[fn]('x'); } catch (err) { e = err; }
    ok(`${fn}() throws 501 with no key \u2014 never a silent empty sheet`,
       !!e && e.status === 501, e && e.message);
  }
  ok('flexEquipmentListUrl() throws rather than returning a half-built link',
     (() => { try { flex.flexEquipmentListUrl('x'); return false; } catch (e) { return e.status === 501; } })());
  ok('flexGetUserName() is the ONE exception \u2014 it is cosmetic, so it degrades to \'\'',
     (await flex.flexGetUserName('x')) === '');
  process.env.FLEX_BASE_URL = savedUrl;
  process.env.FLEX_API_KEY = savedKey;
  flex.flexResetUserNameCache();
  ok('flexEquipmentListUrl builds the header view once configured',
     flex.flexEquipmentListUrl('abc') ===
       'https://e360sport.flexrentalsolutions.com/f5/ui/#element/abc/view/equipmentlist/header',
     flex.flexEquipmentListUrl('abc'));
  ok('...and an empty id is an empty string, not a link to nowhere',
     flex.flexEquipmentListUrl('') === '' && flex.flexEquipmentListUrl(null) === '');

  console.log(`\n${'\u2550'.repeat(66)}`);
  console.log(`  FLEX CLIENT: ${pass} passed, ${fail} failed  (no network, no key)`);
  if (fail) { console.log('  FAILURES:'); failures.forEach((f) => console.log('    \u00b7 ' + f)); }
  console.log('  \u26a0 Recorded shapes only. The API is BETA \u2014 run scripts/flex-probe.js');
  console.log('    with a real key to find out whether any of this is still true.');
  console.log(`${'\u2550'.repeat(66)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFLEX TEST ABORTED:', e && e.stack ? e.stack : e); process.exit(3); });
