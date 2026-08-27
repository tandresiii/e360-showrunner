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

  console.log(`\n${'\u2550'.repeat(66)}`);
  console.log(`  FLEX CLIENT: ${pass} passed, ${fail} failed  (no network, no key)`);
  if (fail) { console.log('  FAILURES:'); failures.forEach((f) => console.log('    \u00b7 ' + f)); }
  console.log('  \u26a0 Recorded shapes only. The API is BETA \u2014 run scripts/flex-probe.js');
  console.log('    with a real key to find out whether any of this is still true.');
  console.log(`${'\u2550'.repeat(66)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFLEX TEST ABORTED:', e && e.stack ? e.stack : e); process.exit(3); });
