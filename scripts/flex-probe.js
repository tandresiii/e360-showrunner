#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/flex-probe.js — READ-ONLY reconnaissance against the real Flex API
// ────────────────────────────────────────────────────────────────────────────
//   FLEX_BASE_URL=https://e360sport.flexrentalsolutions.com \
//   FLEX_API_KEY=<the key from the e360-staffing3 Railway env> \
//   node scripts/flex-probe.js [elementId …]
//
// FOR TOM TO RUN. Nothing in this repo has ever made a Flex call — the key does
// not exist here (INTEGRATIONS_SPEC.md §8 item 1), so lib/flex.js is written
// entirely from the staffing app's shipped code and the May-13 probe output and
// is UNVERIFIED against a live tenant.
//
// EVERY PROBE BELOW IS A GET. Nothing is created, updated or deleted. The one
// write path (flexCreateEventFolder) is deliberately NOT exercised — two
// abandoned `TEST -` elements from the last probe round are still live in the
// tenant (R25) and this script will not add a third.
//
// WHAT IT ANSWERS, in order of what it would change:
//   1  Does the key work at all, and who does Flex think we are?  (whoami)
//   2  Is the /f5 prefix still required?             — BUG 1 regression check
//   3  Does row-data still need a non-empty codeList, and does an EMPTY one
//      still return 200 + [] rather than an error?   — BUG 5, the silent one
//   4  Is the documented node-list endpoint still a dead end?  — BUG 4
//   5  On a REAL PULL SHEET, do any rows carry `group === true`?
//      ⭐ THE OPEN QUESTION. Every saved probe artifact is a MANIFEST, so the
//      pull-sheet branch of flexFetchGearList is written from the spec and has
//      never seen a real response (R21, §8 item 6). This is the single finding
//      most likely to change lib/flex.js.
//   6  Is `quantity` still null on serial-tracked rows, with the serial in the
//      name?                                          — BUG 6
//   7  Are the dates still returned without the Z they were sent with, and is
//      elementNumber still null on Event Folders?     — §3.4 shape check
//
// Output: a findings block on stdout, plus the raw JSON of every response under
// scripts/flex-probe-output/ so the next person argues from artifacts, not
// memory. Paste the findings block back into INTEGRATIONS_SPEC.md §3.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const flex = require('../lib/flex');

const OUT_DIR = path.join(__dirname, 'flex-probe-output');
const findings = [];
const notes = [];

function bank(name, data) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, name + '.json'),
      typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { notes.push(`could not bank ${name}: ${e.message}`); }
}
function finding(id, verdict, detail) {
  findings.push({ id, verdict, detail });
  const mark = verdict === 'CONFIRMED' ? '✓' : verdict === 'CHANGED' ? '⚠' : '·';
  console.log(`  ${mark} ${id}: ${verdict}${detail ? ' — ' + detail : ''}`);
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`); }

(async function main() {
  if (!process.env.FLEX_API_KEY || !process.env.FLEX_BASE_URL) {
    console.error('FLEX_BASE_URL and FLEX_API_KEY must both be set.');
    console.error('They live ONLY in the e360-staffing3 Railway environment (§8 item 1);');
    console.error('this repo has never held the key. Nothing was probed.');
    process.exit(2);
  }
  const ids = process.argv.slice(2);
  console.log(`Flex probe — READ-ONLY — ${flex.flexBaseUrl()}`);
  console.log(`elements to inspect: ${ids.length ? ids.join(', ') : '(none supplied)'}`);

  // ── 1. whoami ─────────────────────────────────────────────────────────────
  section('1. auth + identity');
  let user = null;
  try {
    user = await flex.flexGetCurrentUser(true);
    bank('01-current-user', user.raw);
    finding('AUTH', 'CONFIRMED',
      `key accepted; userId=${user.userId || '(none)'} contactId=${user.contactId || '(none)'} ` +
      `name=${user.name || '(none)'}`);
    if (!user.userId) {
      notes.push('current-user returned no userId — flexCreateEventFolder omits assignedToUserId, ' +
                 'which may make Flex reject or silently unassign the element. Worth checking.');
    }
  } catch (e) {
    finding('AUTH', 'FAILED', e.message);
    console.error('\nNothing else can be probed without a working key. Stopping.');
    printSummary();
    process.exit(1);
  }

  // ── 2. BUG 1: the /f5 prefix ──────────────────────────────────────────────
  section('2. BUG 1 — is the /f5 prefix still required?');
  try {
    const res = await fetch(flex.flexBaseUrl() + '/api/user-profile/current-user',
      { headers: { 'X-Auth-Token': flex.flexApiKey(), Accept: 'application/json' } });
    const text = await res.text();
    bank('02-no-f5-prefix', { status: res.status, contentType: res.headers.get('content-type'),
                              body: text.slice(0, 500) });
    if (res.ok) {
      finding('BUG1', 'CHANGED',
        `the SAME path WITHOUT /f5 returned ${res.status} — Flex may have fixed this. ` +
        'lib/flex.js can keep the prefix either way, but §3.3 should be updated.');
    } else {
      finding('BUG1', 'CONFIRMED',
        `without /f5: ${res.status} (${res.headers.get('content-type') || 'no content-type'}). ` +
        (/html/i.test(res.headers.get('content-type') || '') ? 'Still HTML, as documented.' : ''));
    }
  } catch (e) { finding('BUG1', 'INCONCLUSIVE', e.message); }

  if (!ids.length) {
    section('element probes SKIPPED');
    console.log('  Pass one or more element ids to probe row-data and gear lists, e.g.');
    console.log('    node scripts/flex-probe.js <a-manifest-uuid> <a-PULL-SHEET-uuid>');
    console.log('  ⭐ A REAL PULL SHEET is the one artifact that has never been captured (R21).');
    printSummary();
    return;
  }

  for (const id of ids) {
    section(`element ${id}`);

    // ── 7. identity shape ───────────────────────────────────────────────────
    let ident = null;
    try {
      ident = await flex.flexGetElement(id);
      bank(`identity-${id}`, ident);
      const kind = ident.definitionId === flex.FLEX_PULL_SHEET_DEF_ID ? 'PULL SHEET'
                 : ident.definitionId === flex.FLEX_MANIFEST_DEF_ID ? 'manifest'
                 : ident.definitionId === flex.FLEX_EVENT_FOLDER_DEF_ID ? 'event folder'
                 : 'unknown (' + ident.definitionId + ')';
      finding(`IDENTITY:${id}`, 'CONFIRMED', `${kind} — "${ident.name}" (${ident.documentNumber || 'no doc#'})`);
      const start = String(ident.plannedStartDate || '');
      if (start && !start.endsWith('Z')) {
        finding(`SHAPE:${id}`, 'CONFIRMED',
          `plannedStartDate comes back WITHOUT the Z it was sent with ("${start}") — §3.4 still holds.`);
      } else if (start) {
        finding(`SHAPE:${id}`, 'CHANGED', `plannedStartDate now ends with Z ("${start}").`);
      }
      if ('elementNumber' in ident) {
        notes.push(`element ${id} DOES carry elementNumber (${ident.elementNumber}) — §3.4 says it is ` +
                   'absent on Event Folders.');
      }
    } catch (e) { finding(`IDENTITY:${id}`, 'FAILED', e.message); continue; }

    // ── 3. BUG 5: the codeList parameter ────────────────────────────────────
    const base = `/api/line-item/${encodeURIComponent(id)}/row-data/`;
    try {
      const r = await fetch(flex.flexBaseUrl() + '/f5' + base + '?node=root',
        { headers: { 'X-Auth-Token': flex.flexApiKey(), Accept: 'application/json' } });
      const t = await r.text();
      bank(`bug5-omitted-${id}`, { status: r.status, body: t.slice(0, 400) });
      finding(`BUG5-omitted:${id}`, r.status === 400 ? 'CONFIRMED' : 'CHANGED',
        `omitting codeList → ${r.status}` + (r.status === 400 ? " (400 'codeList … not present', as documented)" : ''));
    } catch (e) { finding(`BUG5-omitted:${id}`, 'INCONCLUSIVE', e.message); }

    try {
      const r = await fetch(flex.flexBaseUrl() + '/f5' + base + '?codeList=&node=root',
        { headers: { 'X-Auth-Token': flex.flexApiKey(), Accept: 'application/json' } });
      const t = await r.text();
      let parsed = null; try { parsed = JSON.parse(t); } catch { /* not json */ }
      bank(`bug5-empty-${id}`, { status: r.status, body: t.slice(0, 400) });
      const silentlyEmpty = r.status === 200 && Array.isArray(parsed) && parsed.length === 0;
      finding(`BUG5-empty:${id}`, silentlyEmpty ? 'CONFIRMED' : 'CHANGED',
        silentlyEmpty
          ? 'codeList= (empty) still returns 200 + [] — an empty gear list with NO error. This is the ' +
            'dangerous one: it reads as "this pull sheet has no gear".'
          : `codeList= (empty) returned ${r.status} with ${Array.isArray(parsed) ? parsed.length + ' rows' : 'a non-array body'}.`);
    } catch (e) { finding(`BUG5-empty:${id}`, 'INCONCLUSIVE', e.message); }

    // ── 4. BUG 4: the documented dead end ───────────────────────────────────
    try {
      const r = await fetch(
        flex.flexBaseUrl() + `/f5/api/eqlist-line-item/node-list/${encodeURIComponent(id)}?equipmentListId=${encodeURIComponent(id)}`,
        { headers: { 'X-Auth-Token': flex.flexApiKey(), Accept: 'application/json' } });
      const t = await r.text();
      let parsed = null; try { parsed = JSON.parse(t); } catch { /* not json */ }
      bank(`bug4-nodelist-${id}`, { status: r.status, body: t.slice(0, 600) });
      const dead = parsed && (parsed.totalElements === 0 || parsed.empty === true ||
                              (Array.isArray(parsed.content) && parsed.content.length === 0));
      finding(`BUG4:${id}`, dead ? 'CONFIRMED' : 'CHANGED',
        dead ? 'node-list still returns an empty page — keep using row-data.'
             : `node-list returned data (${r.status}). If it is real, §3.3 BUG 4 can be retired.`);
    } catch (e) { finding(`BUG4:${id}`, 'INCONCLUSIVE', e.message); }

    // ── 5 + 6. the real row grammar ─────────────────────────────────────────
    let rows = [];
    try {
      rows = await flex.flexGetRowData(id);
      bank(`row-data-${id}`, rows);
    } catch (e) { finding(`ROWDATA:${id}`, 'FAILED', e.message); continue; }

    const groupRows = rows.filter((r) => r && r.group === true);
    const leaves = rows.filter((r) => r && r.leaf === true);
    const containers = rows.filter((r) => r && r.leaf === false);
    const isPullSheet = ident.definitionId === flex.FLEX_PULL_SHEET_DEF_ID;

    finding(`ROWDATA:${id}`, 'CONFIRMED',
      `${rows.length} rows — ${groupRows.length} group=true, ${leaves.length} leaves, ${containers.length} containers`);

    if (isPullSheet) {
      // ⭐ THE OPEN QUESTION (R21 / §8 item 6).
      if (groupRows.length) {
        finding('R21-PULLSHEET', 'CONFIRMED',
          `A REAL PULL SHEET has ${groupRows.length} rows with group===true. The pull-sheet branch of ` +
          'flexFetchGearList is CORRECT as written. Bank scripts/flex-probe-output/row-data-' + id +
          '.json into the spec — it is the first pull-sheet artifact that has ever existed.');
      } else {
        finding('R21-PULLSHEET', 'CHANGED',
          'A REAL PULL SHEET has ZERO rows with group===true — the pull-sheet branch of ' +
          'flexFetchGearList would produce NO groups and fall back to a flat list. THE SPEC IS WRONG ' +
          'AND lib/flex.js MUST BE REWRITTEN against this artifact. This is the highest-value finding ' +
          'in the run.');
      }
    } else if (groupRows.length) {
      notes.push(`element ${id} is not a pull sheet but has ${groupRows.length} group rows — unexpected.`);
    }

    // BUG 6
    const serialTracked = rows.filter((r) => r && r.quantity === null && r.isUnit);
    const withParens = rows.filter((r) => r && /\([^)]*\)\s*$/.test(String(r.name || '')));
    finding(`BUG6:${id}`, serialTracked.length ? 'CONFIRMED' : 'INCONCLUSIVE',
      `${serialTracked.length}/${rows.length} rows have quantity===null with isUnit — ` +
      `${withParens.length} names end in a parenthetical (the serial). ` +
      (serialTracked.length ? 'Never trust quantity; sum by cleaned name.' : 'No serial-tracked rows in this list.'));

    // and what the client actually produces from it
    try {
      const env = await flex.flexFetchGearList(id, isPullSheet ? 'pull-sheet' : 'manifest');
      bank(`gearlist-${id}`, env);
      finding(`NORMALIZED:${id}`, 'CONFIRMED',
        `${env.groups.length} groups, ${env.groups.reduce((a, g) => a + g.items.length, 0)} distinct items` +
        (env.groupingFellBack ? ' (⚠ grouping FELL BACK to a flat list)' : ''));
    } catch (e) { finding(`NORMALIZED:${id}`, 'FAILED', e.message); }

    // the tree walk, depth-capped (R17)
    if (ident.definitionId === flex.FLEX_EVENT_FOLDER_DEF_ID) {
      try {
        const t0 = Date.now();
        const lists = await flex.flexFindGearListsUnder(id);
        bank(`gear-lists-under-${id}`, lists);
        finding(`TREEWALK:${id}`, 'CONFIRMED',
          `${lists.length} gear lists found in ${Date.now() - t0}ms` +
          (lists.truncated ? ' (⚠ TRUNCATED at the depth/node cap — raise FLEX_TREE_MAX_* if this folder is real)' : ''));
      } catch (e) { finding(`TREEWALK:${id}`, 'FAILED', e.message); }
    }
  }

  printSummary();
})().catch((e) => { console.error('\nProbe aborted:', e); process.exit(3); });

function printSummary() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  FINDINGS');
  console.log('══════════════════════════════════════════════════════════════════');
  const changed = findings.filter((f) => f.verdict === 'CHANGED');
  const failed = findings.filter((f) => f.verdict === 'FAILED');
  for (const f of findings) console.log(`  [${f.verdict}] ${f.id}\n      ${f.detail}`);
  if (notes.length) {
    console.log('\n  NOTES');
    for (const n of notes) console.log('   · ' + n);
  }
  console.log(`\n  ${findings.length} checks — ${changed.length} CHANGED, ${failed.length} FAILED.`);
  if (changed.length) {
    console.log('  ⚠ Anything marked CHANGED means the Flex API moved under a documented workaround.');
    console.log('    Update INTEGRATIONS_SPEC.md §3.3 and lib/flex.js before trusting either.');
  }
  console.log(`  Raw responses banked in ${OUT_DIR}`);
  console.log('  The API is officially BETA — re-run this after any Flex upgrade.');
}
