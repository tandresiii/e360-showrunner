/* ============================================================================
   e360 SHOWRUNNER — SHEET IMPORTER, the PURE half (Tom, 2026-09-10)
   ----------------------------------------------------------------------------
   "we need some means to upload a spreadsheet or something and then track
   deliverables in any bucket from it." Clients send content lists as
   Excel/CSV — "here are the 47 pieces you owe us" — and until this module
   somebody retyped them. This file is every piece of import logic that does
   NOT touch the DOM, the seam or the network: the CSV parser, the dims
   parser, the header/mapping guesser, the source-bucket resolver, the row
   builder and the dry-run preview arithmetic. app.js owns the modal around
   it; api.importContent() owns the write.

   Kept PURE on purpose: the suites load this byte-for-byte file headless
   (the walk in a vm, smoke via the module guard at the bottom) and drive it
   against the committed fixture CSVs — the same characters a client's export
   will contain, not a hand-mocked grid.

   PARSING STAYS CLIENT-SIDE. The server accepts structured rows and never
   grows a spreadsheet dependency; CSV is first-class and hand-rolled here
   (works everywhere, file:// demo included); XLSX is best-effort via a
   lazy-loaded pinned SheetJS in app.js, API mode only, with an honest
   failure path — never a silent hang.
   ========================================================================== */

/* ── the CSV parser — hand-rolled, RFC-4180-shaped ──────────────────────────
   Quoted fields, embedded commas, doubled ("") escaped quotes, embedded
   NEWLINES inside quotes, CRLF and LF endings, a UTF-8 BOM, and a trailing
   newline that must not become a phantom empty row. No library: the format
   is small, the failure modes of a half-right split(',') are not. */
function csvParse(text) {
  var t = String(text == null ? '' : text);
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  var rows = [], row = [], cur = '', inQ = false, i = 0, ch;
  while (i < t.length) {
    ch = t[i];
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cur += '"'; i += 2; continue; }   /* "" → literal quote */
        inQ = false; i += 1; continue;
      }
      cur += ch; i += 1; continue;                                 /* commas + newlines ride along */
    }
    if (ch === '"') { inQ = true; i += 1; continue; }
    if (ch === ',') { row.push(cur); cur = ''; i += 1; continue; }
    if (ch === '\r') {
      if (t[i + 1] === '\n') i += 1;                               /* CRLF is one ending, not two */
      row.push(cur); rows.push(row); row = []; cur = ''; i += 1; continue;
    }
    if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i += 1; continue; }
    cur += ch; i += 1;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); } /* last line, no trailing \n */
  return rows;
}

/* ── the combined-dims parser ───────────────────────────────────────────────
   "3840x96", "3840 × 96", "3840X96", "3840 × 96 px", "11,520x96", "1920*1080"
   — the shapes real sheets carry. Numbers may wear comma thousands
   separators; the separator is x/X/×/✕/*; an optional px/pixels rides the
   tail. PARSE AS WRITTEN: "96x3840" is 96 wide — never a helpful swap,
   because a guessed orientation is exactly the silent lie the spec checker
   exists to catch. Anything else ("big", "48 ft × 8 ft") is null, and the
   caller keeps the raw string so the refusal can name it. */
function cpDimsParse(s) {
  var m = /^\s*(\d[\d,]*)\s*[x×X✕*]\s*(\d[\d,]*)\s*(?:px|pixels)?\.?\s*$/i
    .exec(String(s == null ? '' : s));
  if (!m) return null;
  var w = parseInt(m[1].replace(/,/g, ''), 10);
  var h = parseInt(m[2].replace(/,/g, ''), 10);
  if (!w || !h) return null;                                       /* a 0-px canvas is not a canvas */
  return { w: w, h: h };
}

/* a lone integer cell — separate Width / Height columns. Same comma + px
   tolerance as the combined parser; anything else is null and the raw
   string travels with the row so the server can refuse it by name. */
function cpIntParse(s) {
  var m = /^\s*(\d[\d,]*)\s*(?:px|pixels)?\s*$/i.exec(String(s == null ? '' : s));
  if (!m) return null;
  var n = parseInt(m[1].replace(/,/g, ''), 10);
  return n > 0 ? n : null;
}

/* ── the source-bucket resolver ─────────────────────────────────────────────
   A mapped source column overrides the picker's default, fuzzily but NEVER
   silently: "us"/"e360"/"internal" family → e360 · anything saying "client"
   → client · any OTHER non-empty value → third_party with the raw value
   kept (the caller writes it into notes and the preview shows the resolved
   bucket, so "Acme Printing" is visible twice, not guessed once). Empty →
   null: the picker's default applies. */
function cpSourceResolve(raw) {
  var t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  var l = t.toLowerCase();
  if (l.indexOf('e360') >= 0 || l.indexOf('e-360') >= 0 ||
      ['us', 'we', 'ours', 'internal', 'in house', 'in-house', 'in_house', 'inhouse', 'house'].indexOf(l) >= 0) {
    return { source: 'e360', note: '' };
  }
  if (l.indexOf('client') >= 0) return { source: 'client', note: '' };
  return { source: 'third_party', note: t };
}

/* kind, from a type/format column. Family words, resolved; an unknown
   non-empty value lands as 'other' WITH the raw kept for notes — same
   never-silent rule as source. Empty → null (server defaults 'video'). */
function cpKindResolve(raw) {
  var t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  var l = t.toLowerCase();
  if (/vid|anim|motion|loop|mp4|mov|render/.test(l)) return { kind: 'video', note: '' };
  if (/still|static|image|img|graphic|jpg|jpeg|png|photo/.test(l)) return { kind: 'still', note: '' };
  if (/print|vinyl|banner|backdrop|wrap|signage|poster/.test(l)) return { kind: 'print', note: '' };
  if (l === 'other') return { kind: 'other', note: '' };
  return { kind: 'other', note: t };
}

/* a due-date cell. ISO passes through; the two US shapes a sheet exports
   (M/D/YYYY, M/D/YY) normalize; anything else is null and the caller keeps
   the raw in notes rather than nuking a good row over "ASAP". */
function cpDateParse(raw) {
  var t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  var m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2}|\d{4})$/.exec(t);
  if (!m) return null;
  var mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
  var y = parseInt(m[3], 10); if (m[3].length === 2) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

/* ── the mapping guesser ────────────────────────────────────────────────────
   One field key (or null = ignored) per column, guessed from the header
   text. RULES RUN IN ORDER — the specific ones (size, width, height) before
   the greedy ones (name), so "Pixel size" is size and never name — and each
   field is claimed AT MOST ONCE: a second "notes" column stays visibly
   unmapped rather than silently shadowing the first. Every guess is a
   dropdown the human can correct; this is a head start, not an authority. */
var CP_IMP_FIELDS = ['name', 'surface', 'kind', 'size', 'spec_w', 'spec_h',
                     'duration_spec', 'due_date', 'source', 'notes'];
var CP_IMP_GUESS = [
  ['size',          /resolution|dimension|pixel|(^|[^a-z])size$|^dims?$|^res$|^px$|w\s*[x×]\s*h/],
  ['spec_w',        /^w$|width/],
  ['spec_h',        /^h$|height/],
  ['duration_spec', /duration|runtime|run ?time|^length$|^len$|^dur$|^secs?$|seconds|^time$/],
  ['due_date',      /due|deadline|needed by|\bdate\b/],
  ['kind',          /^(type|kind|format|media)$|[ _-](type|kind|format)$/],
  ['source',        /^(source|producer|provider|who|supplier|responsible|builder)$|source$|producer$|provided by|supplied by/],
  ['surface',       /surface|screen|zone|location|display|placement|board|wall/],
  ['notes',         /^notes?$|comments?$|remarks?$|description|^details?$/],
  ['name',          /name|title|piece|deliverable|asset|item|content/]
];
function cpGuessMapping(headers) {
  var taken = {};
  return (headers || []).map(function (hRaw) {
    var h = String(hRaw == null ? '' : hRaw).trim().toLowerCase();
    if (!h) return null;
    for (var i = 0; i < CP_IMP_GUESS.length; i++) {
      var field = CP_IMP_GUESS[i][0];
      if (taken[field]) continue;
      if (CP_IMP_GUESS[i][1].test(h)) { taken[field] = true; return field; }
    }
    return null;
  });
}

/* Is the first row headers? YES when it reads like labels (the guesser
   recognizes it) and like no data (nothing in it parses as dims, a bare
   number or a date). Auto-detected here, ALWAYS overridable by the toggle —
   this is a default, not a verdict. */
function cpDetectHeader(grid) {
  if (!grid || !grid.length) return false;
  var row0 = grid[0];
  var dataish = row0.some(function (c) {
    var t = String(c == null ? '' : c).trim();
    return !!(cpDimsParse(t) || cpDateParse(t) || /^\d+$/.test(t));
  });
  if (dataish) return false;
  var guessed = cpGuessMapping(row0).filter(function (f) { return f !== null; }).length;
  return guessed >= Math.min(2, row0.length);
}

/* ── the row builder — grid + mapping + defaults → structured rows ──────────
   Row numbers are SHEET row numbers (1-based, header counted) — "row 12"
   here is row 12 in the person's own Excel, because that is the row they
   will go fix. Fully-empty lines are skipped silently (a trailing blank is
   not an invalid row). A dims cell that will not parse rides along RAW as
   `size_raw` — the row still travels, and the SERVER refuses it by name
   (per-row, never blocking its neighbours); the preview mirrors the same
   verdict. Unparseable dates and unknown kinds degrade to notes instead:
   the examples the feature was specced against treat a bad SIZE as invalid
   and everything softer as a visible footnote. */
function cpBuildRows(grid, mapping, opts) {
  opts = opts || {};
  var bucket = opts.bucket || 'e360';
  var start = opts.headerRow ? 1 : 0;
  var cols = {};
  (mapping || []).forEach(function (f, i) { if (f && cols[f] === undefined) cols[f] = i; });
  function cell(row, field) {
    var i = cols[field];
    return i === undefined ? '' : String(row[i] == null ? '' : row[i]).trim();
  }
  var out = [];
  for (var g = start; g < grid.length; g++) {
    var raw = grid[g];
    if (raw.every(function (c) { return String(c == null ? '' : c).trim() === ''; })) continue;
    var r = { row_n: g + 1, name: cell(raw, 'name'), surface: cell(raw, 'surface'),
              spec_w: null, spec_h: null, duration_spec: cell(raw, 'duration_spec'),
              due_date: '', source: bucket, notes: cell(raw, 'notes') };
    var extra = [];

    var kindRaw = cell(raw, 'kind');
    var k = cpKindResolve(kindRaw);
    if (k) { r.kind = k.kind; if (k.note) extra.push('kind: ' + k.note); }

    var sizeRaw = cell(raw, 'size');
    if (sizeRaw) {
      var d = cpDimsParse(sizeRaw);
      if (d) { r.spec_w = d.w; r.spec_h = d.h; }
      else r.size_raw = sizeRaw;                 /* the server's refusal names it */
    }
    var wRaw = cell(raw, 'spec_w'), hRaw = cell(raw, 'spec_h');
    if (wRaw) { var wN = cpIntParse(wRaw); if (wN) r.spec_w = wN; else r.size_raw = r.size_raw || wRaw; }
    if (hRaw) { var hN = cpIntParse(hRaw); if (hN) r.spec_h = hN; else r.size_raw = r.size_raw || hRaw; }

    var dueRaw = cell(raw, 'due_date');
    if (dueRaw) {
      var iso = cpDateParse(dueRaw);
      if (iso) r.due_date = iso; else extra.push('due: ' + dueRaw);
    }
    var srcRaw = cell(raw, 'source');
    var s = cpSourceResolve(srcRaw);
    if (s) { r.source = s.source; if (s.note) extra.push('source: ' + s.note); }

    if (extra.length) r.notes = (r.notes ? r.notes + ' · ' : '') + extra.join(' · ');
    out.push(r);
  }
  return out;
}

/* ── the dry-run preview — the summary a person confirms against ────────────
   MIRRORS the server's per-row walk (routes/content.js import) so the
   counts shown before the click equal the results echoed after it: no name
   / unparseable size → invalid; a name already on the show OR already
   earlier in this sheet (case/trim-insensitive, the idempotency key) →
   skip; everything else → create. The mirror is convenience — the server
   re-checks every row and is the only gate. */
function cpPreviewCounts(rows, existingNames) {
  var seen = {};
  (existingNames || []).forEach(function (n) {
    seen[String(n == null ? '' : n).trim().toLowerCase()] = 'show';
  });
  var creates = [], skips = [], invalids = [];
  (rows || []).forEach(function (r) {
    if (!r.name) { invalids.push({ row_n: r.row_n, reason: 'no name' }); return; }
    if (r.size_raw && r.spec_w == null && r.spec_h == null) {
      invalids.push({ row_n: r.row_n, reason: "unparseable size '" + r.size_raw + "'" }); return;
    }
    var key = r.name.trim().toLowerCase();
    if (seen[key]) {
      skips.push({ row_n: r.row_n, name: r.name,
                   reason: seen[key] === 'show' ? 'already on this show' : 'duplicate of an earlier row' });
      return;
    }
    seen[key] = 'sheet';
    creates.push(r);
  });
  return { creates: creates, skips: skips, invalids: invalids };
}

/* the suites load this file headless — a browser never sees this branch */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { csvParse: csvParse, cpDimsParse: cpDimsParse, cpIntParse: cpIntParse,
    cpSourceResolve: cpSourceResolve, cpKindResolve: cpKindResolve, cpDateParse: cpDateParse,
    cpGuessMapping: cpGuessMapping, cpDetectHeader: cpDetectHeader,
    cpBuildRows: cpBuildRows, cpPreviewCounts: cpPreviewCounts,
    CP_IMP_FIELDS: CP_IMP_FIELDS };
}
