// ════════════════════════════════════════════════════════════════════════════
// lib/speccheck.js — the stack-aware spec-chain consistency checker (D7)
//                    + the .e360 logo MIME gate (D8)
//                    + the type sniff that keeps the chain from being corrupted
// ────────────────────────────────────────────────────────────────────────────
// TOM'S RULE, and it governs everything below (INTEGRATIONS_SPEC.md §5 addendum):
//
//     Report a QUESTION, never an ERROR. "Verify stacking", never "spec error".
//
// Two shipped, correct specs already disagree numerically, and neither is wrong.
// The VNL Chicago wall is ONE wall with THREE legitimate numbers (§9.2.4):
//     .e360 fields.totalCabinets   144   ← hand-typed into a text box
//     .e360 Σ complexSections.count 120  ← 34+24+4+24+34, single-height positions
//     .nsf  stack-aware cxPathTotal 124  ← same 5 sections; "Section 3" (count 4,
//                                           north) was marked doubleStacked
//                                           INSIDE NovaSpec, because the .e360's
//                                           `zones` array was EMPTY
// A naive "sum the zones and compare to the total" check calls that a 24-cabinet
// error. It is not an error. It is three artifacts, three questions, zero bugs.
//
// WHERE STACKING LIVES — differently at every node, and dropped at the last one:
//   .e360  zones[]           {name,color,first,last,doubleStacked}, keyed by
//                            CABINET RANGE. complexSections[] has NO such field.
//                            total += z.doubleStacked ? count*2 : count,
//                            count = last − first + 1.
//   .nsf   complexSections[] doubleStacked + stackFlow ('snake' | 'parallel').
//                            cxPathTotal() = Σ (doubleStacked ? n*2 : n).
//   .pcfg  NOWHERE.          sections[] is {name,side,cabType,count,gapBefore}
//                            and buildGeometry counts sec.count flat. A .pcfg
//                            count is a single-row FOOTPRINT, not a physical
//                            cabinet count, whenever anything upstream stacked.
//
// ⚠ PROVISIONAL. INTEGRATIONS_SPEC.md §5-addendum and §9.5 ops-prereq 4 both ask
//   for ONE real stacked-zone spec walked through with Tom before this ships as
//   anything but questions. Every result carries `provisional: true` so the UI
//   can say so out loud.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ── type sniff ──────────────────────────────────────────────────────────────
// The staffing app never opens the JSON — it checks `type` is one of three and
// that svg starts with '<svg'. That is how a .nsf gets filed as a .e360 and the
// chain silently corrupts. These are the producers' OWN load-time guards:
//   e360 → applyProjectData throws 'Invalid file' unless p.version      (tools/e360:3267)
//   nsf  → applyNsfData throws unless data._app === 'NovaSpec'          (tools/novaspec:2128)
//   pcfg → parseConfig checks _app === 'e360_power_cabling'             (tools/powerspec:314)
function detectSpecType(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json._app === 'NovaSpec') return 'nsf';
  if (json._app === 'e360_power_cabling') return 'pcfg';
  // .e360 has NO _app key at all, and uses `version`, not `_version`.
  if (json.version && !json._app) return 'e360';
  return null;
}
// Returns null when the document matches its declared type, or a human sentence
// naming BOTH types when it does not.
function typeMismatch(declared, json) {
  const detected = detectSpecType(json);
  if (detected === declared) return null;
  if (!detected) {
    return `This does not look like a ${declared} document. A .e360 must carry a truthy \`version\`; ` +
           'a .nsf must carry `_app: "NovaSpec"`; a .pcfg must carry `_app: "e360_power_cabling"`. ' +
           'None of those markers is present.';
  }
  return `Declared type "${declared}" but the document identifies itself as "${detected}" ` +
         `(${detected === 'nsf' ? '_app: "NovaSpec"' :
             detected === 'pcfg' ? '_app: "e360_power_cabling"' : 'a top-level `version` and no `_app`'}). ` +
         'Binding it would corrupt the chain silently, so it is refused.';
}

// ── D8. the .e360 client-logo MIME gate ─────────────────────────────────────
// Copied from tools/e360:3322, which exists specifically to stop a malicious
// .e360 smuggling `data:image/svg+xml,<svg onload=…>` into whatever renders it.
// A stored .e360 is attacker-influenced input the moment anyone can upload one,
// so the gate belongs on OUR render paths too, not just in the tool.
const LOGO_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;
function isSafeLogoDataUrl(s) {
  return typeof s === 'string' && LOGO_DATA_URL.test(s);
}
// Returns { json, stripped } — never throws. A bad logo must not fail an
// otherwise-good bind; it must simply not survive into a render path.
function sanitizeSpecJson(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { json, stripped: false };
  const logo = json.clientLogoDataUrl;
  if (logo == null || logo === '') return { json, stripped: false };
  if (isSafeLogoDataUrl(logo)) return { json, stripped: false };
  return { json: { ...json, clientLogoDataUrl: null }, stripped: true };
}

// ── coercion ────────────────────────────────────────────────────────────────
// Every value in .e360/.nsf `fields` is a STRING (read straight off a DOM
// .value); .pcfg carries real numbers. Coerce before comparing or "150" !== 150
// generates a question on every clean chain.
function n(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).trim());
  return Number.isFinite(x) ? x : null;
}
function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}
function sameStr(a, b) { return s(a).toLowerCase() === s(b).toLowerCase(); }

// ── per-node readers ────────────────────────────────────────────────────────

// .e360 — layoutMode selects which geometry key is AUTHORITATIVE. Any consumer
// must branch on it first ('u' → sideStates+zones, 'complex' → complexSections,
// 'modular' → modularConfig; applyProjectData defaults it to 'u').
function readE360(json) {
  const f = (json && json.fields) || {};
  const zones = Array.isArray(json && json.zones) ? json.zones : [];
  const sections = Array.isArray(json && json.complexSections) ? json.complexSections : [];

  // Rule 3: the stack-aware zone total, with the ×2 rule and count = last−first+1.
  let zoneTotal = null;
  let zoneStacked = false;
  if (zones.length) {
    zoneTotal = 0;
    for (const z of zones) {
      const first = n(z && z.first);
      const last = n(z && z.last);
      if (first == null || last == null) continue;
      const count = Math.max(0, last - first + 1);
      if (z && z.doubleStacked) { zoneStacked = true; zoneTotal += count * 2; }
      else zoneTotal += count;
    }
  }
  return {
    type: 'e360',
    layoutMode: s(json && json.layoutMode) || 'u',
    cabinetType: s(f.cabinetType),
    fieldLength: n(f.fieldLength),
    fieldWidth: n(f.fieldWidth),
    compassBearing: n(json && json.compassBearing),
    // Rule 1: DECLARED, never authoritative. Free text, hand-typed, never computed.
    declaredTotal: n(f.totalCabinets),
    // single-height positions; complexSections has no stacking field at all
    sectionTotal: sections.length
      ? sections.reduce((acc, x) => acc + (n(x && x.count) || 0), 0) : null,
    sections: sections.map((x) => ({ name: s(x && x.name), count: n(x && x.count) })),
    zoneTotal,
    zoneStacked,
    // Rule 2: zones:[] means the file carries NO stacking information at all.
    hasStackingData: zones.length > 0,
    zoneCount: zones.length
  };
}

// .nsf — stacking lives on complexSections, and cxPathTotal is the stack-aware
// number (tools/novaspec:454).
function readNsf(json) {
  const f = (json && json.fields) || {};
  const sections = Array.isArray(json && json.complexSections) ? json.complexSections : [];
  let stackAware = 0;
  let flat = 0;
  let anyStacked = false;
  for (const x of sections) {
    const c = n(x && x.count) || 0;
    flat += c;
    if (x && x.doubleStacked) { anyStacked = true; stackAware += c * 2; }
    else stackAware += c;
  }
  return {
    type: 'nsf',
    cabinetType: s(f.cabType),
    fieldLength: n(f.fieldLength),
    fieldWidth: n(f.fieldWidth),
    compassBearing: n(json && json.compassBearing),
    sectionTotal: sections.length ? flat : null,
    stackAwareTotal: sections.length ? stackAware : null,
    anyStacked,
    stackedSections: sections.filter((x) => x && x.doubleStacked)
      .map((x) => ({ name: s(x.name), count: n(x.count), stackFlow: s(x.stackFlow) || 'snake' })),
    sections: sections.map((x) => ({ name: s(x && x.name), count: n(x && x.count),
                                     doubleStacked: !!(x && x.doubleStacked) })),
    hasStackingData: true
  };
}

// .pcfg — no stacking anywhere. parseConfig maps complexSections → sections with
// count: parseInt(cs.count) and never reads doubleStacked or zones.
function readPcfg(json) {
  const sections = Array.isArray(json && json.sections) ? json.sections : [];
  const cabTypes = [...new Set(sections.map((x) => s(x && x.cabType)).filter(Boolean))];
  return {
    type: 'pcfg',
    clientName: s(json && json.clientName),
    cabinetType: cabTypes.length === 1 ? cabTypes[0] : '',
    cabinetTypes: cabTypes,
    sectionTotal: sections.length ? sections.reduce((a, x) => a + (n(x && x.count) || 0), 0) : null,
    sections: sections.map((x) => ({ name: s(x && x.name), count: n(x && x.count) })),
    wattsPerCab: n(json && json.wattsPerCab),
    hasStackingData: false
  };
}

function readSpec(specType, json) {
  if (specType === 'e360') return readE360(json);
  if (specType === 'nsf') return readNsf(json);
  if (specType === 'pcfg') return readPcfg(json);
  return null;
}

// ── the checker ─────────────────────────────────────────────────────────────
// `docs` is { e360?: json, nsf?: json, pcfg?: json } — whatever is bound. Every
// finding is a QUESTION with an `ask` sentence a human can answer, and every
// one names the numbers it is asking about.
function q(id, ask, detail, values) {
  return { id, kind: 'question', ask, detail, values: values || {} };
}

function checkChain(docs) {
  const present = {};
  for (const t of ['e360', 'nsf', 'pcfg']) {
    if (docs && docs[t]) present[t] = readSpec(t, docs[t]);
  }
  const e = present.e360 || null;
  const nf = present.nsf || null;
  const p = present.pcfg || null;
  const questions = [];

  // ── within the .e360: declared vs geometry (Rule 1) ───────────────────────
  if (e) {
    const geometry = e.layoutMode === 'complex' ? e.sectionTotal : e.zoneTotal;
    if (e.declaredTotal != null && geometry != null && e.declaredTotal !== geometry) {
      questions.push(q('e360.declared-vs-geometry',
        `The spec sheet declares ${e.declaredTotal} cabinets; its ${e.layoutMode === 'complex' ? 'sections' : 'zones'} ` +
        `describe ${geometry}. Which is right?`,
        'fields.totalCabinets is a hand-typed text box — it is never computed from the geometry, so a ' +
        'difference here is a question about the spec sheet, not evidence of an error. It is also the ' +
        'number PowerSpec falls back to when a spec has no complexSections.',
        { declared: e.declaredTotal, geometry, layoutMode: e.layoutMode }));
    }
    if (e.layoutMode === 'complex' && e.sectionTotal != null && e.zoneTotal != null
        && e.sectionTotal !== e.zoneTotal && e.hasStackingData) {
      questions.push(q('e360.zones-vs-sections',
        `Zones total ${e.zoneTotal} cabinets (stack-aware) but the sections total ${e.sectionTotal} ` +
        '(single-height positions). Is a zone double-stacked across a section boundary?',
        'complexSections carries no doubleStacked field; stacking lives only in zones[], keyed by ' +
        'cabinet range. The two numbers are expected to differ exactly by the stacked cabinets.',
        { zoneTotal: e.zoneTotal, sectionTotal: e.sectionTotal, zoneStacked: e.zoneStacked }));
    }
    if (e.layoutMode === 'modular') {
      questions.push(q('e360.modular-layout',
        'This spec is in modular layout mode — cabinet counts here are not comparable to the ' +
        'section/zone geometry the rest of the chain uses. Confirm the downstream artifacts were ' +
        'built from the modular config.',
        'modularConfig is the authoritative geometry when layoutMode is "modular", and the tool\'s own ' +
        'top-down render returns a placeholder for it.',
        { layoutMode: 'modular' }));
    }
  }

  // ── .e360 ↔ .nsf ──────────────────────────────────────────────────────────
  if (e && nf) {
    if (e.cabinetType && nf.cabinetType && !sameStr(e.cabinetType, nf.cabinetType)) {
      questions.push(q('cabtype.e360-nsf',
        `Cabinet type is "${e.cabinetType}" on the spec sheet and "${nf.cabinetType}" on the cabling sheet. ` +
        'Which one is the gear that is going out?',
        'The two files carry the same value under different key names (fields.cabinetType vs fields.cabType), ' +
        'so a difference means somebody changed it in one tool and not the other.',
        { e360: e.cabinetType, nsf: nf.cabinetType }));
    }
    for (const [label, key] of [['length', 'fieldLength'], ['width', 'fieldWidth']]) {
      if (e[key] != null && nf[key] != null && e[key] !== nf[key]) {
        questions.push(q(`field${label}.e360-nsf`,
          `Field ${label} is ${e[key]} on the spec sheet and ${nf[key]} on the cabling sheet. Which is current?`,
          'This is the single-field drift a checker should surface — the Unified Events pair differs by ' +
          '225 vs 222 for exactly this reason, and that one was a real operator edit.',
          { e360: e[key], nsf: nf[key] }));
      }
    }
    if (e.compassBearing != null && nf.compassBearing != null && e.compassBearing !== nf.compassBearing) {
      questions.push(q('bearing.e360-nsf',
        `Compass bearing is ${e.compassBearing}° on the spec sheet and ${nf.compassBearing}° on the cabling sheet.`,
        'Bearing drives which side of the field the sections are drawn on.',
        { e360: e.compassBearing, nsf: nf.compassBearing }));
    }

    // ── the stacking comparison, done properly ──────────────────────────────
    // Rule 2: a .e360 with zones:[] carries NO stacking data. NovaSpec's
    // importE360() cross-references zones to recover stacking, and when there
    // are no zones it recovers nothing — so the operator sets doubleStacked in
    // NovaSpec, and that flag NEVER existed upstream. That is NORMAL. Not drift.
    if (nf.anyStacked && e && !e.hasStackingData) {
      questions.push(q('stacking.nsf-only',
        `The cabling sheet marks ${nf.stackedSections.length} section` +
        `${nf.stackedSections.length === 1 ? '' : 's'} double-stacked ` +
        `(${nf.stackedSections.map((x) => `${x.name || 'unnamed'}×${x.count}`).join(', ')}), ` +
        'and the spec sheet carries no zone data to compare against. This is normal — just confirm the ' +
        'stacking is intended.',
        'The .e360 zones[] array is empty, so it carries no stacking information at all. Stacking added ' +
        'in NovaSpec with no upstream counterpart is expected, NOT drift, and must never be reported as ' +
        'a mismatch.',
        { stackedSections: nf.stackedSections, e360Zones: e.zoneCount,
          nsfFlat: nf.sectionTotal, nsfStackAware: nf.stackAwareTotal }));
    } else if (nf.anyStacked && e && e.hasStackingData && !e.zoneStacked) {
      questions.push(q('stacking.nsf-not-in-zones',
        'The cabling sheet marks sections double-stacked, but the spec sheet has zones and none of them ' +
        'is stacked. Was the stacking decided after the spec sheet was written?',
        'When the .e360 DOES carry zones, a stacked .nsf section with no stacked zone counterpart is ' +
        'worth a look — unlike the zones:[] case, there was somewhere upstream to record it.',
        { stackedSections: nf.stackedSections, e360ZoneTotal: e.zoneTotal }));
    }

    // Rule 3: compare STACK-AWARE totals, and only when both sides actually
    // have stacking information. Otherwise compare like with like.
    const eGeom = e.layoutMode === 'complex' ? e.sectionTotal : e.zoneTotal;
    if (e.hasStackingData && e.zoneTotal != null && nf.stackAwareTotal != null
        && e.zoneTotal !== nf.stackAwareTotal) {
      questions.push(q('total.stack-aware',
        `Stack-aware cabinet totals differ: ${e.zoneTotal} from the spec sheet's zones, ` +
        `${nf.stackAwareTotal} from the cabling sheet. Verify the stacking on both.`,
        'Both numbers already account for double-stacking, so this is a genuine geometry question rather ' +
        'than a units mismatch.',
        { e360ZoneTotal: e.zoneTotal, nsfStackAware: nf.stackAwareTotal, nsfFlat: nf.sectionTotal }));
    } else if (!e.hasStackingData && eGeom != null && nf.sectionTotal != null
               && eGeom !== nf.sectionTotal) {
      // Compare the SINGLE-HEIGHT numbers, because the .e360 has no other kind.
      questions.push(q('total.single-height',
        `Single-height positions differ: ${eGeom} on the spec sheet, ${nf.sectionTotal} on the cabling sheet. ` +
        'Were sections added or removed in NovaSpec?',
        'The spec sheet carries no stacking data, so this compares flat section counts on both sides — the ' +
        "cabling sheet's stack-aware total is deliberately NOT used here.",
        { e360: eGeom, nsfFlat: nf.sectionTotal, nsfStackAware: nf.stackAwareTotal }));
    }
  }

  // ── → .pcfg. Rule 4: a .pcfg count is a FOOTPRINT, not a cabinet count. ───
  if (p) {
    const upstream = nf || e;
    if (upstream) {
      const upFlat = upstream.sectionTotal != null ? upstream.sectionTotal
                   : (e ? e.zoneTotal : null);
      if (upFlat != null && p.sectionTotal != null && upFlat !== p.sectionTotal) {
        questions.push(q('total.pcfg-footprint',
          `The power sheet plans for ${p.sectionTotal} cabinets; the ${upstream.type === 'nsf' ? 'cabling' : 'spec'} ` +
          `sheet describes ${upFlat} single-height positions. Confirm the power plan covers the right wall.`,
          'PowerSpec imports complexSections with count: parseInt(cs.count) and never reads doubleStacked ' +
          'or zones, so its counts are a single-row footprint by construction.',
          { pcfg: p.sectionTotal, upstream: upFlat, upstreamType: upstream.type }));
      }
    }
    // The power-planning consequence, stated as the question §9.2.4 flags for Tom.
    if (nf && nf.anyStacked && p.sectionTotal != null && nf.stackAwareTotal != null
        && p.sectionTotal < nf.stackAwareTotal) {
      const gap = nf.stackAwareTotal - p.sectionTotal;
      const watts = p.wattsPerCab != null ? gap * p.wattsPerCab : null;
      questions.push(q('power.stacking-blind',
        `The power sheet counts ${p.sectionTotal} cabinets but the cabling sheet's stack-aware total is ` +
        `${nf.stackAwareTotal}` +
        (watts != null ? ` — a ${gap}-cabinet, ${(watts / 1000).toFixed(1)} kW difference.` : ` — ${gap} cabinets.`) +
        ' Were the PowerSpec counts hand-corrected after import?',
        'PowerSpec drops stacking entirely (totalPower = totalCabs × wattsPerCab over the flat counts). It ' +
        'may be that operators correct the counts by hand after importing, in which case nothing is wrong ' +
        '— which is exactly why this is a question and not a defect report.',
        { pcfgCount: p.sectionTotal, nsfStackAware: nf.stackAwareTotal, gap,
          wattsPerCab: p.wattsPerCab, wattGap: watts }));
    }
    if (upstream && upstream.cabinetType && p.cabinetType && !sameStr(upstream.cabinetType, p.cabinetType)) {
      questions.push(q('cabtype.pcfg',
        `Cabinet type is "${p.cabinetType}" on the power sheet and "${upstream.cabinetType}" upstream. ` +
        'Which cabinet is being powered?',
        'Watts per cabinet is a per-model figure, so a cabinet-type difference changes the load directly.',
        { pcfg: p.cabinetType, upstream: upstream.cabinetType, upstreamType: upstream.type }));
    }
    if (p.cabinetTypes.length > 1) {
      questions.push(q('cabtype.pcfg-mixed',
        `The power sheet mixes cabinet types (${p.cabinetTypes.join(', ')}). Confirm that is intended.`,
        'wattsPerCab is a single number applied to every section, so a mixed-model wall is under- or ' +
        'over-planned unless the counts were adjusted.',
        { cabinetTypes: p.cabinetTypes, wattsPerCab: p.wattsPerCab }));
    }
  }

  return {
    provisional: true,
    note: 'These are QUESTIONS, not errors. Two of E360\'s own banked specs disagree numerically and ' +
          'neither is wrong — stacking is recorded differently at every node of the chain and dropped ' +
          'entirely at the last one. Walk one real stacked-zone spec with Tom before treating any of ' +
          'this as a rule (INTEGRATIONS_SPEC.md §5 addendum, §9.5 ops prereq 4).',
    bound: Object.keys(present),
    questions,
    facts: present
  };
}

module.exports = {
  detectSpecType, typeMismatch,
  isSafeLogoDataUrl, sanitizeSpecJson, LOGO_DATA_URL,
  readSpec, readE360, readNsf, readPcfg,
  checkChain
};
