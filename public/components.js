/* ============================================================================
   e360 SHOWRUNNER — SHARED RENDER HELPERS
   ----------------------------------------------------------------------------
   icons · esc() · formatters · pills/tags/chips · cards · toasts · modal ·
   roster picker · rollups · white document sheets (viewer + print).

   SAFETY RULE enforced here and in every view: EVERY interpolated data value
   goes through esc(). Inline handlers only ever carry NUMERIC ids — anything
   stringy is emitted as a data-attribute and picked up by the delegated
   listener in app.js.
   ========================================================================== */

/* ---------------- dom + escaping ---------------- */
var $ = function (s, r) { return (r || document).querySelector(s); };

/* HTML-escape. Applied to every interpolated data value in every template. */
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/* delegated-action attribute pair. id is always numeric; k is a literal key
   authored in code (never user/mock data), escaped anyway. */
function act(name, id, k) {
  return 'data-act="' + esc(name) + '"' +
    (id == null ? '' : ' data-id="' + Number(id) + '"') +
    (k == null ? '' : ' data-k="' + esc(k) + '"');
}
/* a click target that only fires a toast — kills ~15 stringy inline onclicks */
function toastAttrs(title, sub) {
  return 'data-act="toast" data-toast="' + esc(title) + '" data-toast-sub="' + esc(sub || '') + '"';
}

/* ---------------- formatters ---------------- */
var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parseISO(s) { if (!s) return null; var d = new Date(s.slice(0, 10) + 'T00:00:00'); return isNaN(d) ? null : d; }
function fmtDate(iso) { var d = parseISO(iso); return d ? MONTH_SHORT[d.getMonth()] + ' ' + d.getDate() : '—'; }
function fmtDateFull(iso) { var d = parseISO(iso); return d ? MONTH_SHORT[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : '—'; }
function fmtMonthYear(iso) { var d = parseISO(iso); return d ? d.toLocaleString('en-US', { month: 'long', year: 'numeric' }) : 'Unscheduled'; }
function fmtTs(ts) {
  if (!ts) return '';
  var d = new Date(ts.length > 10 ? ts : ts + 'T00:00:00');
  if (isNaN(d)) return '';
  var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM', hh = h % 12 || 12;
  var mm = String(d.getMinutes()); if (mm.length < 2) mm = '0' + mm;
  return MONTH_SHORT[d.getMonth()] + ' ' + d.getDate() + ' · ' + hh + ':' + mm + ' ' + ap;
}
function fmtSize(b) {
  if (b == null || b <= 0) return '—';
  if (b < 1024) return b + ' B';
  var k = b / 1024;
  if (k < 1024) return Math.round(k) + ' KB';
  return (Math.round(k / 1024 * 10) / 10) + ' MB';
}
function fmtMoney(n) {
  if (!n) return '—';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
/* signed money for margins — real minus sign, not a hyphen */
function fmtMoneySigned(n) {
  if (n == null) return '—';
  return (n < 0 ? '−' : '+') + '$' + Math.abs(Number(n)).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtPct(n) {
  if (n == null) return '—';
  var v = Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return (v < 0 ? '−' : '') + Math.abs(v) + '%';
}
function daysUntil(iso) { var d = parseISO(iso); return d ? Math.round((d - TODAY) / 86400000) : null; }
function isOverdue(step) {
  var s = normStatus(step.status);
  if (s === 'done' || s === 'na') return false;
  return !!(step.due_date && step.due_date < TODAY_ISO);
}
function firstName(username) { var u = ROSTER[username]; return u ? u.name.split(' ')[0] : ''; }
function userName(username) { var u = ROSTER[username]; return u ? u.name : ''; }

/* ---------------- icons ---------------- */
function icon(n) {
  var p = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><path d="M16 5.2A3 3 0 0 1 16 11M21 20c0-2.6-1.6-4.2-4-4.8"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.5 21a2 2 0 0 0 3 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    led: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 6v12M11 6v12M15 6v12"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M6 14h12v7H6z"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m21 15-5-5L5 21"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10.5" r="1.1"/><circle cx="12" cy="8" r="1.1"/><circle cx="15.5" cy="10.5" r="1.1"/>',
    checkC: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    truck: '<path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    box: '<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
    link: '<path d="M9 15 15 9M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    scale: '<path d="M12 3v18"/><path d="M7 7h10"/><path d="M7 7 4 14h6L7 7Z"/><path d="M17 7l-3 7h6l-3-7Z"/><path d="M8 21h8"/>',
    dollar: '<path d="M12 2.5v19"/><path d="M16.6 6.6c-.8-1.2-2.4-2-4.5-2C9.7 4.6 8 5.9 8 7.9s1.6 2.9 4 3.4c2.5.5 4.5 1.5 4.5 3.7s-2 3.5-4.4 3.5c-2.3 0-4-.9-4.8-2.2"/>',
    cart: '<circle cx="9.5" cy="20" r="1.4"/><circle cx="17.5" cy="20" r="1.4"/><path d="M3 4h2.2l2.5 12h10.1L20.5 8H6.4"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.2 0-2.4-.25-3.5-.72L4 21l1.72-5A8.5 8.5 0 1 1 21 11.5Z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    phone: '<path d="M6.5 3h3L11 7.5 9 9a13 13 0 0 0 6 6l1.5-2 4.5 1.5v3a2.5 2.5 0 0 1-2.5 2.5A15.5 15.5 0 0 1 4 5.5 2.5 2.5 0 0 1 6.5 3Z"/>',
    cam: '<path d="M4 8h3.2L9 5.5h6L16.8 8H20a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 8Z"/><circle cx="12" cy="13.5" r="3.4"/>',
    star: '<path d="m12 3.8 2.4 5 5.4.7-4 3.8 1 5.4L12 16l-4.8 2.7 1-5.4-4-3.8 5.4-.7Z"/>'
  }[n] || '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}
function inlineIcon(n) { return icon(n).replace('svg', 'svg style="width:12px;height:12px;vertical-align:-2px"'); }

/* ---------------- chips / pills / avatars ---------------- */
function av(username, cls) {
  var u = ROSTER[username];
  if (!u) return '';
  return '<span class="avatar ' + esc(cls || '') + '" style="background:' + esc(u.color) + '">' + esc(u.initials) + '</span>';
}
function ownerChip(username) {
  if (!username || !ROSTER[username]) return '<span class="owner none">' + icon('users') + 'Unassigned</span>';
  return '<span class="owner">' + av(username) + esc(firstName(username)) + '</span>';
}
function typeTag(t) { return '<span class="tag ' + esc(typeDef(t).tag) + '">' + esc(typeLabel(t)) + '</span>'; }
function rolePill(role) { var r = roleDefOf(role); return '<span class="pill ' + esc(r.cls) + '"><span class="dot"></span>' + esc(r.name) + '</span>'; }
function ragPill(r) { var a = RAG[r] || RAG.idle; return '<span class="pill ' + esc(a[0]) + '"><span class="dot"></span>' + esc(a[1]) + '</span>'; }
function stagePill(s) { return '<span class="pill idle">' + esc(stageLabel(s)) + '</span>'; }
function statusPill(s) { var a = STATUS[normStatus(s)]; return '<span class="pill ' + esc(a.pill) + '"><span class="dot"></span>' + esc(a.label) + '</span>'; }
function psPill(s) { var a = PS[s] || PS.sent; return '<span class="pill ' + esc(a[0]) + '"><span class="dot"></span>' + esc(a[1]) + '</span>'; }
function segColor(step) { if (step.risk && normStatus(step.status) !== 'done') return 'var(--warn)'; return STATUS[normStatus(step.status)].bar; }

/* the commercial dimension — one job = one deal = one qb job number.
   deal_type: 'rental' (league deal, E360 keeps the gear) | 'sale' (individual
   team agreement — hardware becomes cost-of-goods on the job). */
function dealTag(job) {
  if (!job || !job.deal_type) return '';
  var sale = job.deal_type === 'sale';
  return '<span class="tag ' + (sale ? 'sale' : 'rental') + '" title="' +
    esc(sale ? 'Sale — individual team agreement; hardware is cost-of-goods on this job'
             : 'Rental — league deal; E360 retains the gear') + '">' + (sale ? 'sale' : 'rental') + '</span>';
}
/* POLISH_LIST #5. A job can be opened, budgeted and bought against before
   Candice cuts the QuickBooks number; until then it carries a TEMP-{yy}-{seq}
   placeholder. The badge is deliberately QUIET — nothing is wrong, the number
   is simply not the QuickBooks one yet, and every link in the app is on the
   internal job id, so confirming the real number re-links nothing. */
function isTempJob(job) { return !!(job && job.qb_number_status === 'temp'); }
function tempBadge(job) {
  if (!isTempJob(job)) return '';
  return '<span class="tag temp" title="Placeholder number — accounting has not cut the QuickBooks job yet. ' +
    'Costs still book against it; nothing re-links when the real number lands.">temp</span>';
}
/* A job opened before the deal firms up can carry a temp number and no
   description yet, so the tooltip is assembled from what is present — the old
   concatenation rendered a literal "undefined" between the separators. */
function jobChip(job) {
  if (!job) return '';
  var tip = [job.client, job.description, job.deal_type].filter(Boolean).join(' · ');
  return '<span class="tag" title="' + esc(tip) + '">Job ' + esc(job.qb_job_number) + '</span>' +
    tempBadge(job);
}
function jobsChip(jobs) {
  if (!jobs || !jobs.length) return '';
  if (jobs.length === 1) return jobChip(jobs[0]);
  return '<span class="tag">' + jobs.length + ' jobs</span>';
}

/* ---------------- toast / modal ---------------- */
function toast(b, s) {
  var t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = icon('check') + '<div><b>' + esc(b) + '</b><span>' + esc(s || '') + '</span></div>';
  $('#toasts').appendChild(t);
  setTimeout(function () {
    t.style.opacity = 0; t.style.transform = 'translateX(20px)';
    setTimeout(function () { t.remove(); }, 300);
  }, 2600);
}
function openModal(title, body) {
  $('#modal').innerHTML = '<div class="modal-h"><b>' + esc(title) + '</b><button class="iconbtn" ' + act('closeModal') + '>' + icon('x') + '</button></div><div class="modal-b">' + body + '</div>';
  $('#overlay').classList.add('on');
}
function closeM() { $('#overlay').classList.remove('on'); }

/* ---------------- lane-agnostic pipeline access + RAG rollup ---------------- */
/* iterate ONLY the lanes this show's project type defines, in config order */
function laneSteps(show) {
  var byLane = {};
  show.steps.forEach(function (st) { (byLane[st.lane] = byLane[st.lane] || []).push(st); });
  return typeDef(show.type).lanes.map(function (l) { return { lane: l, steps: byLane[l.key] || [] }; });
}
function allSteps(show) {
  var out = [];
  laneSteps(show).forEach(function (x) { x.steps.forEach(function (s) { out.push({ step: s, lane: x.lane }); }); });
  return out;
}
/* aggregate STEP STATUS into one RAG + "what's late", regardless of which lanes
   the show's type declares (LED and Print roll up identically). */
function rollupSteps(pairs, stage) {
  var total = pairs.length;
  var done = pairs.filter(function (p) { return normStatus(p.step.status) === 'done'; }).length;
  var blocked = pairs.filter(function (p) { return normStatus(p.step.status) === 'blocked'; });
  var risk = pairs.filter(function (p) { return p.step.risk && normStatus(p.step.status) !== 'done'; });
  var overdue = pairs.filter(function (p) { return isOverdue(p.step); });
  var late = pairs.filter(function (p) {
    return normStatus(p.step.status) === 'blocked' || (p.step.risk && normStatus(p.step.status) !== 'done') || isOverdue(p.step);
  });
  var rag;
  if (stage === 'lead') rag = 'idle';
  else if (blocked.length >= 2) rag = 'crit';
  else if (blocked.length || risk.length || overdue.length) rag = 'warn';
  else rag = 'go';
  return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0,
           blocked: blocked, risk: risk, overdue: overdue, late: late, rag: rag };
}
function rollup(show) { return rollupSteps(allSteps(show), show.stage); }
/* folder-level rollup — every step under every show in the project */
function projectRollup(project) {
  var pairs = [];
  project.shows.forEach(function (s) {
    allSteps(s).forEach(function (p) { pairs.push({ step: p.step, lane: p.lane, show: s }); });
  });
  return rollupSteps(pairs, project.stage);
}

/* ---------------- milestones ---------------- */
/* soonest UPCOMING milestone; falls back to the latest one when all are past.
   (The projects table header claims "sorted by soonest milestone" — this is
   what makes that true, replacing the old insertion-order-first nextDate.) */
function nextMilestone(list) {
  if (!list || !list.length) return { k: '', v: '—', date: null };
  var up = list.filter(function (m) { return m.date >= TODAY_ISO; });
  var pool = up.length ? up : list;
  var pick = pool.reduce(function (a, b) {
    if (up.length) return b.date < a.date ? b : a;
    return b.date > a.date ? b : a;
  });
  return { k: pick.label, v: fmtDate(pick.date), date: pick.date };
}
function showNext(show) { return nextMilestone(show.milestones); }
function projectNext(project) {
  if (project.milestones && project.milestones.length) return nextMilestone(project.milestones);
  var all = [];
  project.shows.forEach(function (s) { (s.milestones || []).forEach(function (m) { all.push(m); }); });
  return nextMilestone(all);
}

/* ---------------- finance (gating · burn · provenance) ---------------- */
/* margin/profitability = ADMIN or the finance CAPABILITY (Tom, 2026-08-27:
   "all admins can see margins" — POLISH_LIST #4). Tom/Tony/Jim are admins;
   Candice carries the flag. Mirrors the backend's hasFinance() exactly
   (lib/auth.js: role === 'admin' || finance === true), so the front end never
   hides a number the server would have sent. Budgets and burn stay visible to
   everyone (TEAM_FEEDBACK: accountability vs. gated margin). */
function canSeeFinance(user) {
  var u = user || CURRENT_USER;
  return !!u && (u.role === 'admin' || !!u.finance);
}
function finLock() {
  return '<span class="finlock" title="Margin is visible to admins and finance">' + inlineIcon('lock') + '</span>';
}
function finKindLabel(kind) {
  return { receipt: 'Receipt', invoice: 'Invoice', po: 'Purchase order', confirmation: 'Confirmation' }[kind] || 'Document';
}
function marginColor(pct) {
  if (pct == null) return 'var(--muted)';
  return pct < 0 ? 'var(--crit)' : pct < 10 ? 'var(--warn)' : 'var(--go)';
}
function burnColor(pct) {
  if (pct == null) return 'var(--idle)';
  return pct > 100 ? 'var(--crit)' : pct >= 85 ? 'var(--warn)' : 'var(--go)';
}
/* thin, quiet budget-burn bar in the .prog/.ls-row visual language.
   committed (optional, procurement pass) renders as a hatched ghost segment
   after the solid actual fill — same token family, visually distinct. */
function burnBar(actual, allotted, committed) {
  committed = committed || 0;
  if (!allotted) {
    if (!committed) return '<div class="burn"><div class="bb"></div><span class="bt">—</span></div>';
    return '<div class="burn" title="' + esc(fmtMoney(committed) + ' committed on POs · no allotment set') + '">' +
      '<div class="bb"><i class="cm" style="width:100%;background:var(--crit)"></i></div>' +
      '<span class="bt" style="color:var(--crit)">—</span></div>';
  }
  var aPct = actual / allotted * 100, cPct = committed / allotted * 100, tPct = aPct + cPct;
  var aw = Math.min(aPct, 100), cw = Math.max(0, Math.min(cPct, 100 - aw));
  var tip = committed
    ? ' title="' + esc(Math.round(aPct) + '% spent + ' + Math.round(cPct) + '% committed on POs') + '"' : '';
  return '<div class="burn"' + tip + '><div class="bb">' +
    (aw > 0 ? '<i style="width:' + aw + '%;background:' + burnColor(aPct) + '"></i>' : '') +
    (cw > 0 ? '<i class="cm" style="width:' + cw + '%;background:' + burnColor(tPct) + '"></i>' : '') +
    '</div><span class="bt"' + (tPct > 100 ? ' style="color:var(--crit)"' : '') + '>' + Math.round(tPct) + '%</span></div>';
}
/* ---------------- purchasing (procurement pass) ---------------- */
function poStatusPill(status) {
  var m = PO_STATUS_META[status] || PO_STATUS_META.needed;
  return '<span class="pill ' + esc(m.pill) + '" title="' + esc(m.hint) + '"><span class="dot"></span>' + esc(m.label) + '</span>';
}
/* ownership: who ends up holding the hardware — E360 (Flex inventory) or the
   job (COGS). Parallels the rental/sale deal tags on purpose. */
function ownershipTag(ownership) {
  return ownership === 'inventory'
    ? '<span class="tag inv" title="E360 keeps it — lands in Flex inventory; capex, not a job cost">inventory</span>'
    : '<span class="tag cogs" title="Cost of goods on the allocated job">cogs</span>';
}
/* (poRiskBadge lived here. The procurement pass superseded it with
   poRiskChip() in views-purchasing.js, which every risk site now calls; this
   copy had no callers left and still assumed risk.show was always set.) */
function poApprovalBadge(po) {
  if (poNeedsApproval(po)) {
    return '<span class="pill warn" title="Over the $' + PO_APPROVAL_THRESHOLD.toLocaleString('en-US') +
      ' threshold — an admin or Candice must approve before this can be ordered">' + inlineIcon('lock') + ' Needs approval</span>';
  }
  return '';
}
/* "via Tom's agent · 92%" — rendered ONLY for agent-filed rows */
function provBadge(p) {
  if (!p) return '';
  var who = ROSTER[p.agent_user] ? firstName(p.agent_user) : p.agent_user;
  return '<span class="prov" title="' + esc((p.source_kind || 'email') + ' · "' + (p.source_label || '') + '"') + '">' +
    inlineIcon('bolt') + 'via ' + esc(who + '’s agent') + ' · ' + esc(Math.round(p.confidence)) + '%</span>';
}
/* who did the thing — a person, or that person's agent */
function actorLabel(username, provenance) {
  if (provenance && provenance.agent_user) {
    var w = ROSTER[provenance.agent_user] ? firstName(provenance.agent_user) : provenance.agent_user;
    return w + '’s agent';
  }
  return firstName(username) || username || '';
}
/* activity actors may arrive as 'agent:<username>' (AGENT_API attribution) */
function actorName(actor) {
  if (actor && String(actor).indexOf('agent:') === 0) {
    var u = actor.slice(6);
    return (ROSTER[u] ? firstName(u) : u) + '’s agent';
  }
  return firstName(actor);
}
/* the display name a show goes by (single-show folders collapse to the folder) */
function showLabel(s) {
  /* show-less callers exist and are legitimate — a 'po' or 'job_number'
     exception is anchored on a job, not a show. Answering '' beats throwing
     from inside a renderer and taking the whole view down with it. */
  if (!s) return '';
  var p = PROJECTS_BY_ID[s.project_id];
  return p && p.shows.length === 1 ? p.name : s.name;
}

/* ---------------- files ---------------- */
/* one place that turns (kind, spec_type, artifact) into a render class */
function fileClass(f) {
  if (f.kind === 'photo') return 'photo';
  if (f.kind === 'spec') return f.spec_type || 'e360';
  if (f.artifact === 'pullsheet' || f.artifact === 'manifest' || f.artifact === 'image') return f.artifact;
  if (FIN_KINDS[f.kind]) return 'money';
  if (f.kind === 'proof') return 'proof';
  return 'doc';
}
function fileIcon(f) {
  var c = fileClass(f);
  return (c === 'image' || c === 'proof') ? 'img'
    : c === 'photo' ? 'cam'
    : c === 'e360' ? 'led'
    : c === 'nsf' ? 'link'
    : c === 'pcfg' ? 'bolt'
    : c === 'pullsheet' ? 'box'
    : c === 'money' ? 'dollar'
    : c === 'manifest' ? 'truck' : 'file';
}
function fileTypeLabel(f, show) {
  var c = fileClass(f);
  return c === 'e360' ? 'Content spec (' + (show.type === 'print' ? 'print' : '.e360') + ')'
    : c === 'nsf' ? 'Data cabling (.nsf)'
    : c === 'pcfg' ? 'Power config (.pcfg)'
    : c === 'pullsheet' ? 'Flex pull sheet'
    : c === 'manifest' ? 'Case manifest'
    : c === 'proof' ? 'Approved proof'
    : c === 'money' ? finKindLabel(f.kind)
    : c === 'photo' ? 'Event photo'
    : c === 'image' ? 'Image' : 'Document';
}

/* ---------------- derivation-chain math ---------------- */
/* `chain` is built by data.js hydrate() in demo mode, but a show absorbed from
   an API LIST endpoint has no chain at all until it is read in detail — and the
   Specs tab badge calls chainAnyStale() straight off show.chain. No chain means
   nothing has been generated, so nothing can be stale. */
function isStale(chain, key) {
  if (!chain) return false;
  var up = CHAIN_UP[key]; if (!up) return false;
  var n = chain[key]; if (!n || !n.gen) return false;
  if (!chain[up] || !chain[up].gen) return false;
  return n.derivedRev !== chain[up].rev;
}
function chainAnyStale(chain) {
  return ['cabling', 'power', 'pull'].some(function (k) { return isStale(chain, k); });
}

/* ============================================================================
   ROSTER PICKER — assign an owner on any step. Step + user are passed as
   NUMERIC ids through data-attributes; the delegated listener does the rest.
   ========================================================================== */
function assignableOwner(step) {
  if (!step.owner) {
    return '<button class="assign-nag" title="Assign an owner" ' + act('openRoster', step.id) + '>' + icon('plus') + 'Assign</button>';
  }
  return '<button class="owner assignable" title="Reassign owner" ' + act('openRoster', step.id) + '>' +
    av(step.owner) + esc(firstName(step.owner)) + icon('chevD') + '</button>';
}
/* notify-picker (Tony's rule): assigning OFFERS to ping the assignee — the
   one person who plausibly expects it. Pre-checked, still removable; resets
   to checked every time the picker opens. Nobody else is ever pinged here. */
var ROSTER_NOTIFY = { on: true };
function toggleRosterNotify(btn) {
  ROSTER_NOTIFY.on = !ROSTER_NOTIFY.on;
  if (btn && btn.classList) btn.classList.toggle('on', ROSTER_NOTIFY.on);
}
function openRosterPicker(anchor, stepId) {
  closeRosterPicker();
  var step = STEPS_BY_ID[Number(stepId)];
  if (!step) return;
  ROSTER_NOTIFY.on = true;
  var opts = USERS.map(function (u) {
    var on = u.username === step.owner;
    return '<button class="rp-opt ' + (on ? 'on' : '') + '" ' + act('assignStep', step.id, String(u.id)) + '>' + av(u.username) +
      '<span class="ri2"><span class="rn">' + esc(u.name) + '</span><span class="rr">' + esc(roleName(u.role) + ' · ' + u.title) + '</span></span>' +
      '<span class="chk">' + icon('check') + '</span></button>';
  }).join('');
  var un = step.owner ? '<button class="rp-un" ' + act('assignStep', step.id, '0') + '>' + icon('x') + 'Unassign</button>' : '';
  var notif = '<button class="rp-notify on" title="Delivers one inbox ping to whoever you assign — uncheck for a silent assign" ' +
    act('rosterNotify') + '>' + icon('bell') + '<span>Notify the assignee</span><span class="chk">' + icon('check') + '</span></button>';
  var pop = document.createElement('div');
  pop.className = 'roster-pop'; pop.id = 'rosterPop';
  pop.innerHTML = '<div class="rp-h">Assign owner · any lane</div>' + opts + un + notif;
  document.body.appendChild(pop);
  try {
    var rc = anchor.getBoundingClientRect(), vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var left = rc.left, top = rc.bottom + 6;
    if (left + 240 > vw) left = vw - 246; if (left < 8) left = 8;
    if (top + 340 > vh) top = Math.max(8, rc.top - 346);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  } catch (_) { pop.style.left = '80px'; pop.style.top = '80px'; }
  setTimeout(function () { document.addEventListener('mousedown', rosterOutside); }, 0);
}
function rosterOutside(ev) { var p = document.getElementById('rosterPop'); if (p && !p.contains(ev.target)) closeRosterPicker(); }
function closeRosterPicker() {
  var p = document.getElementById('rosterPop');
  if (p) p.remove();
  document.removeEventListener('mousedown', rosterOutside);
}

/* ============================================================================
   WHITE DOCUMENT SHEETS — the viewer stage + the print area
   ========================================================================== */
function sheetTop(doctype) {
  return '<div class="sh-top"><div class="lg"><i>e</i>e360 SPORT</div><div class="doctype">' + esc(doctype) + '</div></div>';
}
function boundLine(show) { return '<div class="sh-bound">Bound to ' + esc(show.name) + ' · ' + esc(show.venue) + '</div>'; }
function metaRow(k, v) { return '<div class="meta-row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }

function ledSpecSheet(show, f) {
  var cells = '';
  for (var i = 0; i < 24; i++) {
    var x = 6 + (i % 12) * 52, y = 16 + Math.floor(i / 12) * 30;
    cells += '<rect x="' + x + '" y="' + y + '" width="48" height="26" rx="1.5" fill="#e9f4ef" stroke="#bcd7cb"/>';
  }
  var diagram = '<svg viewBox="0 0 636 84"><rect width="636" height="84" fill="none"/>' + cells + '<text x="318" y="80" font-size="10" text-anchor="middle" fill="#8a968f" font-family="monospace">perimeter pixel map · continuous LED run</text></svg>';
  var rows = [['Product', 'LED perimeter field-board'], ['Pixel pitch', '10 mm'], ['Resolution', f.dim || '—'],
    ['Processors', '2 × NovaStar MX40 Pro'], ['Data', '.nsf cabling map'], ['Power', '.pcfg — 3-phase feeder'],
    ['Content', 'HD-SDI + Bolt6 overlay']].map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  return '<div class="sheet">' + sheetTop('.E360 · CONTENT SPEC') + '<div class="sh-body"><div class="sh-kick">LED content spec</div><h2>' + esc(show.name) + '</h2>' + boundLine(show) + '<hr>' +
    '<table class="spec-tbl">' + rows + '</table><hr><div class="sh-diagram">' + diagram + '</div><div class="sh-cap">' + esc(f.meta) + '</div></div></div>';
}
function printSpecSheet(show, f) {
  var rects = '';
  for (var i = 0; i < 14; i++) {
    var x = 8 + i * 44;
    rects += '<rect x="' + x + '" y="16" width="40" height="48" rx="2" fill="#eef3f1" stroke="#c9d6d0"/><text x="' + (x + 20) + '" y="44" font-size="12" text-anchor="middle" fill="#54615b" font-family="monospace">' + (i + 1) + '</text>';
  }
  var diagram = '<svg viewBox="0 0 632 90"><rect width="632" height="90" fill="none"/>' + rects + '<line x1="8" y1="76" x2="628" y2="76" stroke="#b9c6c0" stroke-dasharray="3 3"/><text x="318" y="88" font-size="10" text-anchor="middle" fill="#8a968f" font-family="monospace">14 panels · continuous perimeter run · outfield wall</text></svg>';
  var chips = [['Marlins Blue', 'PMS 298 C', '#00A3E0'], ['Marlins Red', 'PMS 156 C', '#EF3340'], ['Midnight', 'Black C', '#0B0B0B'], ['Paper', 'White', '#ffffff']]
    .map(function (c) { return '<div class="pchip"><div class="sw" style="background:' + esc(c[2]) + ';' + (c[2] === '#ffffff' ? 'border-bottom:1px solid #e2e8e5' : '') + '"></div><div class="pl">' + esc(c[1]) + '<b>' + esc(c[0]) + '</b></div></div>'; }).join('');
  var rows = [['Substrate', '13oz blockout mesh'], ['Finish', 'Pole pockets + grommets @ 24"'], ['Total area', '1,240 sf'],
    ['Panels', '14 (+ dugout rail, on-deck)'], ['Largest panel', '8 ft x 3 ft'], ['Output', 'CMYK + white pass, 720 dpi @ 1:1'],
    ['Color targets', 'PMS 298 C / 156 C']].map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  return '<div class="sheet">' + sheetTop('.E360 · PRINT SPEC') + '<div class="sh-body"><div class="sh-kick">Print production spec</div><h2>Perimeter Wrap — loanDepot Park</h2>' + boundLine(show) + '<hr>' +
    '<table class="spec-tbl">' + rows + '</table><div class="pantone">' + chips + '</div><hr><div class="sh-diagram">' + diagram + '</div><div class="sh-cap">Panel layout — released to floor ' + esc(fmtDateFull(f.created_at)) + '</div></div></div>';
}
function nsfSpecSheet(show, f) {
  var svg = '<svg viewBox="0 0 636 90"><rect width="636" height="90" fill="none"/>';
  for (var r = 0; r < 4; r++) {
    var y = 12 + r * 20;
    svg += '<rect x="6" y="' + y + '" width="20" height="12" rx="1.5" fill="#dcedff" stroke="#a7c4e6"/><text x="16" y="' + (y + 9) + '" font-size="7" text-anchor="middle" fill="#4a6a8a" font-family="monospace">P' + (r + 1) + '</text>';
    for (var c = 1; c < 8; c++) {
      var x = 6 + c * 76;
      svg += '<line x1="' + (6 + (c - 1) * 76 + 20) + '" y1="' + (y + 6) + '" x2="' + x + '" y2="' + (y + 6) + '" stroke="#8ec5a9" stroke-width="1.5"/><rect x="' + x + '" y="' + y + '" width="20" height="12" rx="1.5" fill="#eef3f1" stroke="#c9d6d0"/>';
    }
  }
  svg += '<text x="318" y="86" font-size="10" text-anchor="middle" fill="#8a968f" font-family="monospace">4 data ports · daisy-chained cabinet runs</text></svg>';
  var rows = [['Port map', '4 × NovaStar output'], ['Cabinets / run', '≤ 8 (10mm field-board)'], ['Run redundancy', 'A/B looped tail'],
    ['Cat6 shielded', '50ft × 24 · 100ft × 8'], ['Fiber SM', '300ft × 2 (long throw)'], ['Derived from', '.e360 content layout']]
    .map(function (x2) { return '<tr><td>' + esc(x2[0]) + '</td><td>' + esc(x2[1]) + '</td></tr>'; }).join('');
  return '<div class="sheet">' + sheetTop('.NSF · DATA CABLING') + '<div class="sh-body"><div class="sh-kick">NovaSpec cabling map</div><h2>' + esc(show.name) + ' — Data Cabling</h2>' + boundLine(show) + '<hr><table class="spec-tbl">' + rows + '</table><hr><div class="sh-diagram">' + svg + '</div><div class="sh-cap">' + esc(f.meta) + '</div></div></div>';
}
function pcfgSpecSheet(show, f) {
  var svg = '<svg viewBox="0 0 636 96"><rect width="636" height="96" fill="none"/><rect x="10" y="30" width="70" height="40" rx="3" fill="#fff2d6" stroke="#e6c477"/><text x="45" y="54" font-size="9" text-anchor="middle" fill="#8a6d2a" font-family="monospace">200A</text>';
  var phaseC = ['#F0616B', '#F4B740', '#59A9F0'];
  for (var p = 0; p < 3; p++) {
    var y = 22 + p * 22;
    svg += '<line x1="80" y1="' + y + '" x2="150" y2="' + y + '" stroke="' + phaseC[p] + '" stroke-width="3"/>';
    for (var b = 0; b < 5; b++) {
      var x = 150 + b * 94;
      svg += '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 70) + '" y2="' + y + '" stroke="' + phaseC[p] + '" stroke-width="2"/><rect x="' + (x + 70) + '" y="' + (y - 6) + '" width="14" height="12" rx="1.5" fill="#eef3f1" stroke="#c9d6d0"/>';
    }
  }
  svg += '<text x="318" y="92" font-size="10" text-anchor="middle" fill="#8a968f" font-family="monospace">3-phase feeder · balanced across L1/L2/L3</text></svg>';
  var rows = [['Service', '3-phase 208V / 200A'], ['Feeder', '~200ft cam-lok tie-in'], ['Distro', '1 × 200A rack + 8 × PDU 20A'],
    ['Est. load', '≈ 62A / phase (balanced)'], ['Backup', '2 × UPS 1500VA (processing)'], ['Derived from', '.nsf cabling map']]
    .map(function (x2) { return '<tr><td>' + esc(x2[0]) + '</td><td>' + esc(x2[1]) + '</td></tr>'; }).join('');
  return '<div class="sheet">' + sheetTop('.PCFG · POWER') + '<div class="sh-body"><div class="sh-kick">PowerSpec distribution</div><h2>' + esc(show.name) + ' — Power Config</h2>' + boundLine(show) + '<hr><table class="spec-tbl">' + rows + '</table><hr><div class="sh-diagram">' + svg + '</div><div class="sh-cap">' + esc(f.meta) + '</div></div></div>';
}
function pullSheetSheet(show, f, gear) {
  var rows = gear.kit.pull.map(function (c) {
    var head = '<tr><td colspan="2" style="padding-top:14px;font-family:monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#0F9E68;font-weight:700;border-bottom:1px solid #d6e5dd">' + esc(c.cat) + '</td></tr>';
    var its = c.items.map(function (it) { return '<tr><td>' + esc(it.name) + ' <span style="color:#9aa8a1;font-family:monospace;font-size:9.5px">' + esc(it.resourceId) + '</span></td><td>× ' + esc(it.qty) + '</td></tr>'; }).join('');
    return head + its;
  }).join('');
  return '<div class="sheet">' + sheetTop('FLEX · PULL SHEET') + '<div class="sh-body"><div class="sh-kick">Flex gear list · ' + esc(gear.docNumber) + '</div><h2>' + esc(show.name) + ' — Pull Sheet</h2>' + boundLine(show) + '<hr><table class="spec-tbl">' + rows + '</table><div class="sh-cap">Pulled from Flex Event Folder ' + esc(gear.elementId ? gear.elementId.slice(0, 8) + '…' : '(modeled)') + ' · derives from the .pcfg power layout</div></div></div>';
}
function manifestSheet(show, f, gear) {
  var rows = gear.kit.manifest.map(function (m) {
    return '<tr><td>' + esc(m.case) + (m.loose ? ' <span style="color:#9aa8a1;font-family:monospace;font-size:9.5px">loose</span>' : '') + '</td><td>' + esc(m.size + ' · ' + m.weight + ' lb') + '</td></tr>';
  }).join('');
  var totW = gear.kit.manifest.reduce(function (a, m) { return a + m.weight; }, 0);
  rows += '<tr><td style="font-weight:700;color:#12181f;padding-top:12px;border-top:2px solid #d6e5dd">' + gear.kit.manifest.length + ' flight cases</td><td style="font-weight:700;color:#12181f;padding-top:12px;border-top:2px solid #d6e5dd">' + esc(totW.toLocaleString()) + ' lb total</td></tr>';
  return '<div class="sheet">' + sheetTop('FLEX · MANIFEST') + '<div class="sh-body"><div class="sh-kick">Flight-case manifest · logistics</div><h2>' + esc(show.name) + ' — Case Manifest</h2>' + boundLine(show) + '<hr><table class="spec-tbl">' + rows + '</table><div class="sh-cap">Case counts, sizes + weights for freight, storage + truck-pack planning</div></div></div>';
}
function proofThumbSVG() {
  return '<svg viewBox="0 0 44 34" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a2a44"/><stop offset="1" stop-color="#04121e"/></linearGradient></defs><rect width="44" height="34" fill="url(#pg)"/><rect x="4" y="20" width="36" height="6" rx="1" fill="#00A3E0"/><rect x="4" y="12" width="22" height="5" rx="1" fill="#EF3340"/><rect x="4" y="6" width="14" height="3" rx="1" fill="#ffffff" opacity=".85"/></svg>';
}
function proofSheet(show, f) {
  var art = '<svg viewBox="0 0 640 220" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="mg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b2438"/><stop offset="1" stop-color="#04121e"/></linearGradient></defs>' +
    '<rect width="640" height="220" fill="url(#mg)"/><rect x="0" y="150" width="640" height="70" fill="#00A3E0"/><rect x="0" y="150" width="640" height="8" fill="#EF3340"/>' +
    '<text x="40" y="86" font-family="Archivo, sans-serif" font-weight="800" font-size="46" fill="#ffffff" letter-spacing="1">MARLINS</text>' +
    '<text x="42" y="120" font-family="IBM Plex Mono, monospace" font-size="15" fill="#7fd4ff" letter-spacing="6">PERIMETER WRAP · 2026</text>' +
    '<circle cx="560" cy="70" r="34" fill="none" stroke="#EF3340" stroke-width="5"/><text x="560" y="80" font-family="Archivo" font-weight="800" font-size="30" fill="#ffffff" text-anchor="middle">M</text>' +
    '<text x="40" y="192" font-family="IBM Plex Mono" font-size="14" fill="#04121e" font-weight="600">loanDepot Park · panels 1–14</text></svg>';
  return '<div class="sheet">' + sheetTop('.PDF · APPROVED PROOF') + '<div class="sh-body"><div class="sh-kick">Client proof · ' + esc(f.ver) + '</div><h2>' + esc(f.name) + '</h2>' + boundLine(show) + '<hr>' +
    '<div class="proof-art">' + art + '<div class="stamp">APPROVED</div></div>' +
    '<div class="appr-row">' + icon('checkC') + '<div><b>Approved by Miami Marlins creative</b><span>' + esc(fmtDateFull(f.created_at)) + ' · e-sign · R2 · locked ' + esc(f.ver) + '</span></div></div></div></div>';
}
function imgSheet(show, f) {
  var art = '<svg viewBox="0 0 640 300" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ig" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d3b2e"/><stop offset=".5" stop-color="#0a2740"/><stop offset="1" stop-color="#1a0f38"/></linearGradient></defs><rect width="640" height="300" fill="url(#ig)"/>' +
    '<rect x="60" y="210" width="520" height="46" rx="3" fill="#00A3E0" opacity=".92"/><rect x="60" y="150" width="300" height="40" rx="3" fill="#EF3340" opacity=".9"/>' +
    '<text x="72" y="240" font-family="Archivo" font-weight="800" font-size="26" fill="#04121e">' + esc(show.name.split(' ')[0].toUpperCase()) + '</text></svg>';
  return '<div class="sheet">' + sheetTop('.' + esc(String(f.ext).toUpperCase()) + ' · ARTWORK') + '<div class="sh-body"><div class="sh-kick">Concept render</div><h2>' + esc(f.name) + '</h2>' + boundLine(show) + '<hr>' +
    '<div class="proof-art">' + art + '</div><div class="sh-cap">' + esc(f.dim) + ' · uploaded ' + esc(fmtDateFull(f.created_at)) + '</div></div></div>';
}
function docSheet(show, f) {
  var widths = [92, 80, 88, 64, 74, 90, 58, 82, 40];
  var lines = widths.map(function (w) { return '<i style="width:' + w + '%"></i>'; }).join('');
  return '<div class="sheet">' + sheetTop('.' + esc(String(f.ext).toUpperCase()) + ' · DOCUMENT') + '<div class="sh-body"><div class="sh-kick">Document</div><h2>' + esc(f.name) + '</h2>' + boundLine(show) + '<hr>' +
    '<div class="doc-lines">' + lines + '</div><hr><div style="color:#8a968f;font-size:12px;font-family:var(--font-mono)">' + esc(f.meta) + ' · ' + esc(fmtSize(f.size)) + '</div></div></div>';
}
/* financial doc — vendor + amount + job attribution + provenance, stamped */
function moneySheet(show, f) {
  var job = JOBS_BY_ID[fileJobId(f)] || null;
  var pr = f.provenance;
  var exp = null;
  (show.expenses || []).forEach(function (e) { if (e.file_id === f.id) exp = e; });
  var rows = [
    ['Vendor', f.vendor || '—'],
    ['Amount', fmtMoney(f.amount)],
    ['Doc date', fmtDateFull(f.doc_date || f.created_at)],
    ['Billed to', job ? job.qb_job_number + ' · ' + job.client : '—'],
    ['Category', exp ? (BUDGET_CATS[exp.budget_line_category] || exp.budget_line_category) : '—'],
    ['Filed by', pr ? actorLabel(null, pr) + ' · ' + Math.round(pr.confidence) + '% match' : userName(f.uploaded_by)],
    ['Status', f.status === 'proposed' ? 'Proposed — awaiting review' : 'Filed']
  ].map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  var stamp = f.status === 'proposed'
    ? '<div class="stamp" style="border-color:#B67C0C;color:#B67C0C">PROPOSED</div>'
    : '<div class="stamp">FILED</div>';
  var lines = [88, 72, 80, 54].map(function (w) { return '<i style="width:' + w + '%"></i>'; }).join('');
  var provLine = pr
    ? '<div class="sh-cap">from ' + esc(pr.source_kind || 'email') + ' “' + esc(pr.source_label || '') + '” · matched by ' + esc(actorLabel(null, pr)) + '</div>'
    : '<div class="sh-cap">' + esc(f.meta || '') + '</div>';
  return '<div class="sheet">' + sheetTop('.' + esc(String(f.ext).toUpperCase()) + ' · ' + esc(finKindLabel(f.kind).toUpperCase())) +
    '<div class="sh-body"><div class="sh-kick">' + esc(finKindLabel(f.kind)) + (job ? ' · job ' + esc(job.qb_job_number) : '') + '</div>' +
    '<h2>' + esc(f.vendor || f.name) + '</h2>' + boundLine(show) + '<hr>' +
    '<div style="position:relative">' +
    '<div style="font-family:var(--font-display);font-weight:800;font-size:34px;letter-spacing:-.02em;color:#0D1210">' + esc(fmtMoney(f.amount)) + '</div>' +
    stamp +
    '<table class="spec-tbl" style="margin-top:14px">' + rows + '</table></div>' +
    '<hr><div class="doc-lines">' + lines + '</div>' + provLine + '</div></div>';
}

/* event photo — the lightbox frame (photo pass). Unlike the white document
   sheets, a photo stages in a fixed-dark gallery frame (its own artwork, like
   .sheet hardcodes light): the image large, caption + credit beneath, the
   proposed stamp and recap star riding the frame. */
function photoSheet(show, f) {
  var w = Number(f.width) || 3, hh = Number(f.height) || 2;
  var when = f.taken_at ? fmtTs(f.taken_at) : fmtDateFull(f.created_at);
  var credit = when + (f.shot_by ? ' · ' + userName(f.shot_by) : '') +
    ' · ' + (f.width && f.height ? f.width + ' × ' + f.height : f.dim);
  return '<div class="photo-stage">' +
    '<div class="ps-frame" style="aspect-ratio:' + w + '/' + hh + '">' +
    '<img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '">' +
    (f.status === 'proposed' ? '<span class="ps-stamp">PROPOSED</span>' : '') +
    (f.recap_pick ? '<span class="ps-pick" title="Recap pick — feeds the client recap">' + icon('star') + '</span>' : '') +
    '</div>' +
    '<div class="ps-cap"><b>' + esc(f.caption || f.name) + '</b>' +
    '<span>' + esc(credit) + '</span>' +
    (f.provenance ? provBadge(f.provenance) : '') +
    '</div></div>';
}

/* gear is required only for pullsheet / manifest classes */
function sheetHTML(show, f, gear) {
  var c = fileClass(f);
  if (c === 'photo') return photoSheet(show, f);
  if (c === 'e360') return show.type === 'print' ? printSpecSheet(show, f) : ledSpecSheet(show, f);
  if (c === 'nsf') return nsfSpecSheet(show, f);
  if (c === 'pcfg') return pcfgSpecSheet(show, f);
  if (c === 'pullsheet') return pullSheetSheet(show, f, gear);
  if (c === 'manifest') return manifestSheet(show, f, gear);
  if (c === 'proof') return proofSheet(show, f);
  if (c === 'image') return imgSheet(show, f);
  if (c === 'money') return moneySheet(show, f);
  return docSheet(show, f);
}
function printSheet(show, f, gear) {
  $('#printArea').innerHTML = sheetHTML(show, f, gear) +
    '<div class="pfoot"><span>e360 Showrunner — ' + esc(show.name) + ' · ' + esc(show.venue) + '</span><span>' + esc(f.name) + ' · ' + esc(f.ver) + ' · printed from folder</span></div>';
  window.print();
  toast('Sent to print', f.name + ' · print dialog opened');
}

/* ============================================================================
   CALL SHEET — the schedule white sheet (call-sheet pass)
   The artifact that gets taped to a road case: header times, per-day schedule,
   crew grid with flights/hotels, POC block. Built to survive black-and-white:
   structure from weight + rules, never from color alone.
   ========================================================================== */
/* pm+ AND edit rights on the folder — matches editableShow() server-side
   (routes/schedule.js). Photo curation deliberately does NOT compose the
   ownership term: a pm curates picks on any show. Do not "tidy" that. */
function canEditSchedule(show) {
  return !!SCHED_EDIT_ROLES[CURRENT_USER.role] && canEditFolderOf(show);
}
/* '06:00' -> '6:00a' · '17:30' -> '5:30p' — compact, unambiguous at 6am */
function fmtHM(hm) {
  if (!hm) return '—';
  var p = String(hm).split(':'), h = Number(p[0]), m = p[1] || '00';
  if (isNaN(h)) return String(hm);
  return (h % 12 || 12) + ':' + m + (h >= 12 ? 'p' : 'a');
}
var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDayDate(iso) { var d = parseISO(iso); return d ? DAY_SHORT[d.getDay()] + ' · ' + MONTH_SHORT[d.getMonth()] + ' ' + d.getDate() : '—'; }
function telHref(phone) { return 'tel:+1' + String(phone || '').replace(/\D/g, ''); }
/* crew row identity — roster person or local hire */
function crewName(c) { return c.username ? userName(c.username) : (c.name || ''); }
function crewPhone(c) { return c.username ? (ROSTER[c.username] || {}).phone : c.phone; }
/* one B.6 leg -> a printable line: 'AA 1808 · CLT dep 5:05p → arr 7:10p' */
function legLine(l) {
  if (!l) return '—';
  var head = l.is_driving ? 'Drive · ' + l.departure_city : l.flight_num + ' · ' + l.departure_city;
  var t = l.departure_time ? ' dep ' + fmtHM(l.departure_time) : '';
  var a = l.arrival_time ? ' → arr ' + fmtHM(l.arrival_time) : '';
  return head + ' · ' + fmtDate(l.departure_date) + t + a;
}

function callSheetSheet(show) {
  var title = showLabel(show);
  var items = scheduleForShow(show.id), days = scheduleDays(show.id), crew = crewForShow(show.id);
  var poc = ROSTER[show.on_site_poc] || null;

  /* header time boxes — the 4 numbers everyone asks for */
  var times = [['LOAD-IN', show.load_in_time], ['DOORS', show.doors_time], ['SHOW', show.event_time], ['STRIKE', show.strike_time]]
    .map(function (t) { return '<div class="cs-time"><span>' + esc(t[0]) + '</span><b>' + esc(fmtHM(t[1])) + '</b></div>'; }).join('');
  var range = days.length ? (fmtDate(days[0]) + (days.length > 1 ? ' – ' + fmtDate(days[days.length - 1]) : '')) : fmtDate(show.event_date);
  var facts = [];
  if (show.radio_channel) facts.push('<b>Radio</b> ' + esc(show.radio_channel));
  if (show.dress_code) facts.push('<b>Dress</b> ' + esc(show.dress_code));
  if (show.parking_notes) facts.push('<b>Parking / access</b> ' + esc(show.parking_notes));
  var factLine = facts.length ? '<div class="cs-facts">' + facts.join('<span class="cs-sep">·</span>') + '</div>' : '';

  /* per-day schedule tables */
  var dayBlocks = days.map(function (d) {
    var rows = items.filter(function (it) { return it.day === d; }).map(function (it) {
      var who = it.who === 'all' ? 'All crew'
        : Object.prototype.toString.call(it.who) === '[object Array]'
          ? it.who.map(function (u) { return firstName(u) || u; }).join(', ')
          : (ROLES[it.who] ? roleName(it.who) + 's' : String(it.who));
      return '<tr><td class="cs-t">' + esc(fmtHM(it.start_time)) + (it.end_time ? '<span>–' + esc(fmtHM(it.end_time)) + '</span>' : '') + '</td>' +
        '<td><b>' + esc(it.title) + '</b>' + (it.detail ? '<span class="cs-d">' + esc(it.detail) + '</span>' : '') + '</td>' +
        '<td class="cs-w">' + esc(who) + '</td><td class="cs-l">' + esc(it.location || '') + '</td></tr>';
    }).join('');
    var tag = schedDayTag(show, d);
    return '<div class="cs-day"><div class="cs-dh"><b>' + esc(fmtDayDate(d)) + '</b>' + (tag ? '<span>' + esc(tag) + '</span>' : '') + '</div>' +
      '<table class="cs-tbl"><thead><tr><th>Time</th><th>What</th><th>Who</th><th>Where</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }).join('');

  /* crew grid — call · travel in/out · hotel · phone */
  var crewRows = crew.map(function (c) {
    var t = c.travel;
    var travelCell = t
      ? '<span class="cs-leg">in&nbsp;&nbsp;' + esc(legLine(t.out)) + (t.out && t.out.record_locator ? ' <i>' + esc(t.out.record_locator) + '</i>' : '') + '</span>' +
        '<span class="cs-leg">out ' + esc(legLine(t.back)) + (t.back && t.back.record_locator ? ' <i>' + esc(t.back.record_locator) + '</i>' : '') + '</span>'
      : '<span class="cs-leg cs-local">local crew</span>';
    var hotelCell = t && t.hotel
      ? '<b>' + esc(t.hotel.name) + '</b><span class="cs-d">' + esc(t.hotel.address) + ' · conf ' + esc(t.hotel.conf) + '</span>'
      : '<span class="cs-local">—</span>';
    return '<tr><td><b>' + esc(crewName(c)) + '</b><span class="cs-d">' + esc(c.role_on_site) + '</span>' +
      (crewPhone(c) ? '<span class="cs-d">' + esc(crewPhone(c)) + '</span>' : '') + '</td>' +
      '<td class="cs-t">' + esc(fmtHM(c.call_time)) + '</td>' +
      '<td>' + travelCell + '</td><td>' + hotelCell + '</td></tr>';
  }).join('');
  var crewBlock = crew.length
    ? '<div class="cs-day"><div class="cs-dh"><b>Crew · ' + crew.length + '</b><span>call times + travel</span></div>' +
      '<table class="cs-tbl cs-crew"><thead><tr><th>Who</th><th>Call</th><th>Travel</th><th>Hotel</th></tr></thead><tbody>' + crewRows + '</tbody></table></div>'
    : '';

  /* POC block — the numbers that fix problems at 6am */
  var pocs = [];
  if (poc) pocs.push(['On-site lead', poc.name, poc.phone]);
  if (show.venue_poc) pocs.push(['Venue', show.venue_poc.name + (show.venue_poc.title ? ' — ' + show.venue_poc.title : ''), show.venue_poc.phone]);
  if (show.client_poc) pocs.push(['Client', show.client_poc.name + (show.client_poc.title ? ' — ' + show.client_poc.title : ''), show.client_poc.phone]);
  var pocBlock = pocs.length
    ? '<div class="cs-pocs">' + pocs.map(function (x) {
        return '<div class="cs-poc"><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b><i>' + esc(x[2] || '') + '</i></div>';
      }).join('') + '</div>'
    : '';

  return '<div class="sheet cs-sheet">' + sheetTop('SCHEDULE · CALL SHEET') +
    '<div class="sh-body"><div class="sh-kick">Call sheet · ' + esc(range) + '</div>' +
    '<h2>' + esc(title) + '</h2>' +
    '<div class="sh-bound">' + esc(show.venue) + (show.venue_address ? ' · ' + esc(show.venue_address) : '') + '</div>' +
    '<div class="cs-times">' + times + '</div>' + factLine + '<hr>' +
    dayBlocks + crewBlock + pocBlock +
    '<div class="sh-cap">Questions on site → ' + esc(poc ? poc.name + ' ' + (poc.phone || '') : 'production office') + ' · generated from the event folder</div>' +
    '</div></div>';
}
function printCallSheet(show) {
  var title = showLabel(show);
  $('#printArea').innerHTML = callSheetSheet(show) +
    '<div class="pfoot"><span>e360 Showrunner — ' + esc(title) + ' · ' + esc(show.venue) + '</span><span>Call sheet · ' + esc(fmtDateFull(show.event_date)) + ' · printed from folder</span></div>';
  window.print();
  toast('Sent to print', 'Call sheet · ' + title);
}

/* ============================================================================
   CLIENT RECAP — the post-event white sheet (recap pass)
   The one artifact in this app a CLIENT receives, so it is the most finished
   sheet in the system: e360 header, headline, stat row, narrative, highlights,
   a printed photo grid, closing and a signature block.

   It renders ONLY recap.body. It never reads the show's money, notes, POs or
   internal steps — the firewall that kept them out of the body (data.js) is
   what keeps them off this page. A draft carries a DRAFT stamp so a preview
   can never be mistaken for the deliverable.
   ========================================================================== */
function recapStatusMeta(rec) { return (rec && RECAP_STATUS[rec.status]) || RECAP_STATUS.draft; }
function recapDateRange(show) {
  var a = show.load_in_date, b = show.strike_date || show.event_date;
  if (a && b && a !== b) return fmtDate(a) + ' – ' + fmtDateFull(b);
  return fmtDateFull(show.event_date);
}
/* who it is from / who it is for — E360 lead + the client's own contact */
function recapSignBlock(show) {
  var lead = ROSTER[show.owner] || null, site = ROSTER[show.on_site_poc] || null;
  var poc = show.client_poc || null;
  var client = (show.job ? show.job.client : null) ||
    (PROJECTS_BY_ID[show.project_id] ? PROJECTS_BY_ID[show.project_id].client : '');
  var cells = [
    ['Prepared by', lead ? lead.name : 'E360 Sport', lead ? lead.title : 'Project lead'],
    ['On site', site ? site.name : '—', site ? site.title : ''],
    ['Prepared for', poc ? poc.name : client, poc ? poc.title : client]
  ];
  return '<div class="rc-sign">' + cells.map(function (c) {
    return '<div class="rc-sg"><span>' + esc(c[0]) + '</span><b>' + esc(c[1]) + '</b>' +
      (c[2] ? '<i>' + esc(c[2]) + '</i>' : '') + '</div>';
  }).join('') + '</div>';
}
function recapSheet(show, rec) {
  if (!rec) return '<div class="empty">No recap on this show yet.</div>';
  var b = rec.body || {};          /* a recap row whose body never generated */
  var client = (show.job ? show.job.client : null) ||
    (PROJECTS_BY_ID[show.project_id] ? PROJECTS_BY_ID[show.project_id].client : '');

  var stats = (b.stats || []).map(function (st) {
    return '<div class="rc-stat"><span>' + esc(st.label) + '</span><b>' + esc(st.value) + '</b></div>';
  }).join('');
  var narr = (b.narrative || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
  var hl = (b.highlights || []).length
    ? '<div class="rc-hl"><div class="rc-hlh">Highlights</div><ul>' +
      b.highlights.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul></div>'
    : '';
  var photos = recapPhotos(rec);
  var grid = photos.length
    ? '<div class="rc-grid">' + photos.map(function (f) {
        return '<figure class="rc-fig"><img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '">' +
          '<figcaption>' + esc(f.caption || f.name) + '</figcaption></figure>';
      }).join('') + '</div>'
    : '';
  var stamp = rec.status === 'draft'
    ? '<div class="stamp rc-stamp">DRAFT</div>'
    : (rec.status === 'sent' ? '<div class="stamp rc-sent">SENT</div>' : '');

  return '<div class="sheet rc-sheet">' + sheetTop('CLIENT RECAP · POST-EVENT') +
    '<div class="sh-body"><div class="rc-head">' +
    '<div class="sh-kick">Event recap' + (client ? ' · ' + esc(client) : '') + '</div>' +
    '<h2>' + esc(b.headline) + '</h2>' +
    '<div class="sh-bound">' + esc(show.venue) + ' · ' + esc(recapDateRange(show)) + '</div>' +
    stamp + '</div>' +
    (stats ? '<div class="rc-stats">' + stats + '</div>' : '') + '<hr>' +
    '<div class="rc-narr">' + narr + '</div>' + hl + grid +
    '<div class="rc-close">' + esc(b.closing) + '</div>' +
    recapSignBlock(show) +
    '<div class="sh-cap">Prepared from the e360 Showrunner event record · ' +
    esc(rec.status === 'sent' ? 'sent ' + fmtDateFull(rec.sent_at) + (rec.sent_to ? ' to ' + rec.sent_to : '')
      : rec.status === 'approved' ? 'approved ' + fmtDateFull(rec.approved_at) + ' by ' + userName(rec.approved_by)
      : 'draft — not yet approved for send') + '</div></div></div>';
}
function printRecapSheet(show, rec) {
  var title = showLabel(show);
  $('#printArea').innerHTML = recapSheet(show, rec) +
    '<div class="pfoot"><span>e360 Sport — ' + esc(title) + ' · ' + esc(show.venue) + '</span><span>Client recap · ' +
    esc(fmtDateFull(show.event_date)) + (rec.status === 'draft' ? ' · DRAFT, not approved' : '') + '</span></div>';
  window.print();
  toast('Sent to print', 'Client recap · ' + title);
}

/* ---------------- two-tier storage panel (INTEGRATION.md) ---------------- */
function twoTier(show) {
  var nas = '\\\\e360-nas\\showrunner\\P' + show.project_id + '-' + show.project.slug + '\\S' + show.id + '-' + show.slug + '\\spec\\';
  return '<div class="two-tier">' +
    '<div class="tier"><div class="th">' + icon('server') + 'Cached render · DB</div><p>The self-contained bundle — <code style="display:inline">json · svg · html · png</code> — travels with the show. Anyone who opens the folder views + prints it with no dependency on the source tool or NAS at view time.</p></div>' +
    '<div class="tier"><div class="th">' + icon('folder') + 'Source file · E360 NAS</div><p>Editable project files + heavy assets live on the NAS; the DB keeps only a path + revision.</p><code>' + esc(nas) + '</code></div>' +
    '</div>';
}
