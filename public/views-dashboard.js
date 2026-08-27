/* ============================================================================
   e360 SHOWRUNNER — DASHBOARDS
     · viewProjects()  — the portfolio (folders, division split, RAG rollup)
     · viewSeason()    — the Season/Program dashboard for a MULTI-SHOW folder
   Both are lane-agnostic and built from existing components only.
   ========================================================================== */

/* ============================================================================
   PROJECTS DASHBOARD — rows are FOLDERS now, rolled up across their shows.
   division = project TYPE (LED / Print / Both).
   ========================================================================== */
var DIV_FILTER = 'all';

function divRoll(projects, type) {
  var ps = projects.filter(function (p) { return type === 'all' || p.type === type; });
  var o = { n: ps.length, go: 0, warn: 0, crit: 0, idle: 0 };
  ps.forEach(function (p) { o[projectRollup(p).rag]++; });
  return o;
}
function divCard(projects, type, label, ic) {
  var d = divRoll(projects, type), on = DIV_FILTER === type;
  var seg = function (k, col) { return d[k] ? '<i style="width:' + (d[k] / d.n * 100) + '%;background:' + col + '"></i>' : ''; };
  var bar = d.n ? (seg('go', 'var(--go)') + seg('warn', 'var(--warn)') + seg('crit', 'var(--crit)') + seg('idle', 'var(--idle)')) : '';
  var leg = function (k, col, lbl) { return '<span class="rl"><b style="background:' + col + '"></b>' + lbl + ' ' + d[k] + '</span>'; };
  return '<button class="divcard ' + (on ? 'on' : '') + '" ' + act('setDiv', null, type) + '>' +
    '<div class="dh"><div class="di">' + icon(ic) + '</div><b>' + esc(label) + '</b>' + (on ? '<span class="dt pill acc" style="padding:2px 8px;font-size:10px">viewing</span>' : '') + '</div>' +
    '<div class="dv">' + d.n + '<small>folder' + (d.n === 1 ? '' : 's') + '</small></div>' +
    '<div class="rag-bar">' + bar + '</div>' +
    '<div class="rag-legend">' + leg('go', 'var(--go)', 'On') + leg('warn', 'var(--warn)', 'Risk') + leg('crit', 'var(--crit)', 'Late') + (d.idle ? leg('idle', 'var(--idle)', 'Sales') : '') + '</div></button>';
}

function viewProjects(projects, exceptions) {
  exceptions = exceptions || [];
  var shown = projects.filter(function (p) { return DIV_FILTER === 'all' || p.type === DIV_FILTER; });
  var rolls = shown.map(function (p) { return { p: p, r: projectRollup(p), next: projectNext(p) }; });

  /* the table header claims "sorted by soonest milestone" — now it is true */
  rolls.sort(function (a, b) {
    var ad = a.next.date || '9999-12-31', bd = b.next.date || '9999-12-31';
    return ad < bd ? -1 : ad > bd ? 1 : a.p.name.localeCompare(b.p.name);
  });

  var active = shown.length;
  var on = rolls.filter(function (x) { return x.r.rag === 'go'; }).length;
  var risk = rolls.filter(function (x) { return x.r.rag === 'warn'; }).length;
  var late = rolls.filter(function (x) { return x.r.rag === 'crit'; }).length;
  var openTasks = 0, totalTasks = 0;
  rolls.forEach(function (x) { openTasks += (x.r.total - x.r.done); totalTasks += x.r.total; });

  var rows = rolls.map(function (x) {
    var p = x.p, r = x.r, d = x.next, n = p.shows.length;
    return '<tr class="rowlink" ' + act('openFolder', p.id) + '>' +
      '<td><div class="ev-name"><div class="ic">' + icon(typeDef(p.type).icon) + '</div><div><b>' + esc(p.name) + '</b><span>' + esc(p.client) + '</span></div></div></td>' +
      '<td>' + typeTag(p.type) + '</td>' +
      '<td>' + stagePill(p.stage) + '</td>' +
      '<td>' + ragPill(r.rag) + '</td>' +
      '<td><div class="mono" style="font-size:12.5px"><span style="color:var(--muted)">' + esc(d.k) + '</span> ' + esc(d.v) + '</div></td>' +
      '<td><div class="who-cell">' + av(p.owner) + '<span>' + esc(firstName(p.owner)) + '</span>' + (n > 1 ? '<span class="mini">' + n + ' shows</span>' : '') + '</div></td>' +
      '<td><div class="prog"><div class="bar"><div class="fill" style="width:' + r.pct + '%"></div></div><div class="num">' + r.pct + '%</div></div></td>' +
      '</tr>';
  }).join('');

  /* "what's late" — flattened across every show of every folder */
  var lateItems = [];
  rolls.forEach(function (x) { x.r.late.forEach(function (pair) { lateItems.push({ p: x.p, pair: pair }); }); });
  lateItems.sort(function (a, b) {
    var av2 = normStatus(a.pair.step.status) === 'blocked' ? 0 : (a.pair.step.risk ? 1 : 2);
    var bv = normStatus(b.pair.step.status) === 'blocked' ? 0 : (b.pair.step.risk ? 1 : 2);
    return av2 - bv;
  });
  var attn = lateItems.slice(0, 7).map(function (it) {
    var s = it.pair.step, show = it.pair.show;
    var why = normStatus(s.status) === 'blocked' ? '<span class="pill crit"><span class="dot"></span>Blocked</span>'
      : (s.risk ? '<span class="pill warn"><span class="dot"></span>At risk</span>' : '<span class="pill crit"><span class="dot"></span>Overdue</span>');
    var where = show ? (it.p.shows.length > 1 ? show.name : it.p.name) : it.p.name;
    return '<div class="next-item" ' + act('openShow', show ? show.id : null) + ' style="cursor:pointer"><div class="txt">' + esc(s.title) +
      '<span>' + esc(where) + ' · ' + esc(it.pair.lane.label) + ' · due ' + esc(fmtDate(s.due_date)) + '</span></div>' + why + ownerChip(s.owner) + '</div>';
  }).join('') || '<div class="empty">Nothing flagged — every lane is on track.</div>';

  /* finance exceptions ride the same panel — money with no paperwork is
     "needs attention" exactly like a blocked step is */
  var finAttn = '';
  if (exceptions.length) {
    finAttn = '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:700;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px">Finance · waiting on paperwork' +
      '<span class="pill warn" style="padding:1px 8px;font-size:10px"><span class="dot"></span>' + exceptions.length + '</span></div>' +
      exceptions.slice(0, 3).map(function (x) {
        /* Not every exception has a show: 'po' and 'job_number' (POLISH_LIST
           #5) are both show-less, and a temp job number is brand new, so it
           sorts into this top-3 the moment one exists. Build the sub from the
           parts that are actually there — same treatment as excRow(). */
        var parts = [];
        if (x.show) parts.push(showLabel(x.show));
        parts.push((x.kind === 'job_number' ? 'needs ' : 'no ') + x.missing);
        if (x.age != null) parts.push(x.age + 'd');
        return '<div class="next-item" ' + act('goFinance') + ' style="cursor:pointer"><div class="txt">' + esc(x.label) +
          '<span>' + esc(parts.join(' · ')) + '</span></div>' +
          '<span class="money" style="font-size:12px">' + esc(x.amount != null ? fmtMoney(x.amount) : '—') + '</span>' + ownerChip(x.chase) + '</div>';
      }).join('') +
      '<div style="margin-top:8px"><span class="lnk" style="cursor:pointer;color:var(--accent);font-size:12px;font-weight:600" ' + act('goFinance') + '>Open Finance →</span></div>';
  }

  return '<div class="page-h"><div><h1>Projects</h1><div class="sub">Every event folder, from the sales call to strike — one place. Status rolls up from every show inside the folder, whatever lane set its type uses. Segment the portfolio by division below.</div></div>' +
    '<button class="btn primary" ' + act('openNew') + '>' + icon('plus') + 'New Event</button></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap"><h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;font-family:var(--font-body)">Division split · where are we as a company</h3>' +
    (DIV_FILTER !== 'all'
      ? '<span class="pill acc"><span class="dot"></span>Filtered to ' + esc(typeLabel(DIV_FILTER)) + ' · ' + active + ' folder' + (active === 1 ? '' : 's') + ' — <span style="cursor:pointer;text-decoration:underline" ' + act('setDiv', null, 'all') + '>clear</span></span>'
      : '<span class="pill idle">Click a division to segment the portfolio</span>') + '</div>' +
    '<div class="divsplit">' + divCard(projects, 'all', 'Overall', 'grid') + divCard(projects, 'led', 'LED', 'led') + divCard(projects, 'print', 'Print', 'print') + divCard(projects, 'both', 'LED + Print', 'layers') + '</div>' +
    '<div class="stats">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Active folders</div><div class="v">' + active + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">On track</div><div class="v" style="color:var(--go)">' + on + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">At risk</div><div class="v" style="color:var(--warn)">' + risk + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Late</div><div class="v" style="color:var(--crit)">' + late + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Open tasks</div><div class="v">' + openTasks + '<small>/' + totalTasks + '</small></div></div>' +
    '</div>' +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    '<div class="card"><div class="card-h"><h3>' + (DIV_FILTER === 'all' ? 'All folders' : esc(typeLabel(DIV_FILTER)) + ' folders') + '</h3><span class="pill idle">Sorted by soonest milestone</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Event folder</th><th>Type</th><th>Stage</th><th>Status</th><th>Next date</th><th>Lead</th><th>Progress</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="panel"><h3>Needs attention</h3><div class="next-list">' + attn + '</div>' + finAttn +
    '<div class="perm-note">' + inlineIcon('bolt') + ' Aggregated from step status across every show and every lane — a blocked or at-risk step surfaces here no matter which lane set the event uses. Money missing its paperwork surfaces the same way.</div></div>' +
    '</div>';
}

/* ---- season row: a tiny closeout glyph (recap pass) ------------------------
   Renders when a recap exists, and — for a show whose date has passed with no
   recap — as a muted "closeout still open" mark. Future shows with nothing to
   close out stay clean. */
function recapGlyph(s) {
  var rec = recapForShow(s.id);
  if (!rec) {
    if (s.event_date >= TODAY_ISO) return '';
    return '<span class="rc-glyph due" title="Show has passed · no client recap drafted yet">' + inlineIcon('send') + '</span>';
  }
  var m = recapStatusMeta(rec);
  var tip = rec.status === 'draft' ? 'Client recap drafted by ' + actorName(rec.generated_by) + ' — awaiting review'
    : rec.status === 'approved' ? 'Client recap approved by ' + userName(rec.approved_by) + ' — ready to send'
    : 'Client recap sent ' + fmtDate(rec.sent_at) + (rec.sent_to ? ' to ' + rec.sent_to : '');
  return '<span class="rc-glyph ' + esc(rec.status) + '" title="' + esc(tip) + '">' +
    inlineIcon(rec.status === 'sent' ? 'send' : rec.status === 'approved' ? 'checkC' : 'bolt') +
    esc(m.short) + '</span>';
}

/* ============================================================================
   SEASON / PROGRAM DASHBOARD — a folder that holds MORE THAN ONE show.
   Built from .card / .tbl / .pill / .stat / .next-list so it reads native.
   Single-show folders never reach here (they auto-collapse to viewShow).
   ========================================================================== */
function viewSeason(project) {
  var r = projectRollup(project);
  var shows = project.shows.slice().sort(function (a, b) { return a.event_date.localeCompare(b.event_date); });

  var metas = (project.milestones || []).map(function (m, i) {
    return '<div class="m"><div class="k">' + esc(m.label) + '</div><div class="val ' + (i === 0 ? 'tick' : '') + '">' + esc(fmtDate(m.date)) + '</div></div>';
  }).join('');

  var upcoming = shows.filter(function (s) { return s.event_date >= TODAY_ISO; });
  var head = '<div class="ef-head">' +
    '<div class="ef-top"><div>' +
    '<div class="ef-title"><h1>' + esc(project.name) + '</h1>' + typeTag(project.type) + jobsChip(project.jobs) + ragPill(r.rag) + stagePill(project.stage) + '</div>' +
    '<div class="ef-sub"><span>' + icon('users') + ' <b>' + esc(project.client) + '</b></span>' +
    '<span>' + icon('pin') + ' <b>Multi-city · ' + shows.length + ' shows</b></span>' +
    '<span>Lead <b>' + esc(userName(project.owner)) + '</b></span>' +
    '<span>Upcoming <b>' + upcoming.length + ' of ' + shows.length + '</b></span></div>' +
    '</div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    '<button class="btn ghost" ' + toastAttrs('Season template', 'Apply the LED template to every show in this folder') + '>' + icon('layers') + 'Apply to all shows</button>' +
    '<button class="btn primary" ' + toastAttrs('Push season', project.name + ' → e360 staffing app (per-show dry run)') + '>' + icon('send') + 'Push season</button>' +
    '</div></div>' +
    '<div class="ef-meta">' + metas + '</div></div>';

  /* season-level rollups */
  var perShow = shows.map(function (s) { return { s: s, r: rollup(s), next: showNext(s) }; });
  var onN = perShow.filter(function (x) { return x.r.rag === 'go'; }).length;
  var riskN = perShow.filter(function (x) { return x.r.rag === 'warn'; }).length;
  var lateN = perShow.filter(function (x) { return x.r.rag === 'crit'; }).length;
  var stats = '<div class="stats">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Shows</div><div class="v">' + shows.length + '<small>/' + upcoming.length + ' ahead</small></div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">On track</div><div class="v" style="color:var(--go)">' + onN + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">At risk</div><div class="v" style="color:var(--warn)">' + riskN + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Late</div><div class="v" style="color:var(--crit)">' + lateN + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Season progress</div><div class="v">' + r.pct + '<small>%</small></div></div>' +
    '</div>';

  /* the show grid */
  var rows = perShow.map(function (x) {
    var s = x.s;
    var job = s.default_job_id ? JOBS_BY_ID[s.default_job_id] : null;
    var overrides = s.bookings.filter(function (b) { return b.job_id && b.job_id !== s.default_job_id; }).length;
    /* quiet photo count (photo pass) — the gallery is filling in */
    var phN = photoCount(s.id);
    var phChip = phN ? '<span class="ph-count" title="' + phN + ' event photo' + (phN === 1 ? '' : 's') + ' on this show">' + inlineIcon('cam') + phN + '</span>' : '';
    return '<tr class="rowlink" ' + act('openShow', s.id) + '>' +
      '<td><div class="ev-name"><div class="ic">' + icon(typeDef(s.type).icon) + '</div><div><b>' + esc(s.name) + '</b><span>' + esc(s.venue) + '</span></div>' + phChip + recapGlyph(s) + '</div></td>' +
      '<td class="mono" style="font-size:12.5px">' + esc(fmtDate(s.event_date)) + '</td>' +
      '<td>' + ragPill(x.r.rag) + poSeasonFlag(s) + '</td>' +
      '<td><div class="mono" style="font-size:12.5px"><span style="color:var(--muted)">' + esc(x.next.k) + '</span> ' + esc(x.next.v) + '</div></td>' +
      '<td>' + (job ? '<span class="tag">' + esc(job.qb_job_number) + '</span>' : '') + (overrides ? ' <span class="mini dep">+' + overrides + ' split</span>' : '') + '</td>' +
      '<td><div class="who-cell">' + av(s.on_site_poc) + '<span>' + esc(firstName(s.on_site_poc)) + '</span></div></td>' +
      '<td><div class="prog"><div class="bar"><div class="fill" style="width:' + x.r.pct + '%"></div></div><div class="num">' + x.r.pct + '%</div></div></td>' +
      '</tr>';
  }).join('');

  var showTable = '<div class="card"><div class="card-h"><h3>Shows in this folder</h3><span class="pill idle">' + shows.length + ' shows · sorted by date</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Show</th><th>Date</th><th>Health</th><th>Next milestone</th><th>Job</th><th>On-site</th><th>Progress</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';

  /* upcoming shows list */
  var upNext = (upcoming.length ? upcoming : shows).slice(0, 5).map(function (s) {
    var rr = rollup(s), d = daysUntil(s.event_date);
    return '<div class="next-item" ' + act('openShow', s.id) + ' style="cursor:pointer"><div class="txt">' + esc(s.name) +
      '<span>' + esc(s.city) + ' · ' + esc(fmtDate(s.event_date)) + (d != null && d >= 0 ? ' · T−' + d + 'd' : '') + '</span></div>' + ragPill(rr.rag) + ownerChip(s.on_site_poc) + '</div>';
  }).join('') || '<div class="empty">No shows scheduled.</div>';

  /* jobs panel — the commercial dimension, now live with budget burn */
  var jobRows = (project.jobs || []).map(function (j) {
    var jf = financeForJob(j.id);
    var defaults = shows.filter(function (s) { return s.default_job_id === j.id; }).length;
    var extras = 0;
    shows.forEach(function (s) { s.bookings.forEach(function (b) { if (b.job_id === j.id && s.default_job_id !== j.id) extras++; }); });
    return '<div class="next-item" ' + act('openJob', j.id) + ' style="cursor:pointer"><div class="txt">' + esc(j.client) + '<span>' + esc(j.description) + '</span></div>' +
      '<span class="tag">' + esc(j.qb_job_number) + '</span>' + tempBadge(j) + dealTag(j) +
      '<span class="mono" style="font-size:12px;color:var(--text-2)">' + esc(fmtMoney(j.contract_value)) + '</span>' +
      burnBar(jf ? jf.actual : 0, jf ? jf.budget_total : 0) +
      '<span class="mini">' + (defaults ? defaults + ' show' + (defaults === 1 ? '' : 's') : extras + ' item' + (extras === 1 ? '' : 's')) + '</span></div>';
  }).join('') || '<div class="empty">No jobs on this folder yet.</div>';

  var summary = project.summary || project.description || '';

  return head + stats + finSeasonStrip(project) +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    '<div style="display:flex;flex-direction:column;gap:16px">' + showTable +
    '<div class="panel"><h3>Jobs on this folder · ' + (project.jobs || []).length + '</h3><div class="next-list">' + jobRows + '</div>' +
    '<div class="perm-note">' + inlineIcon('scale') + ' A <b>job</b> is one commercial deal — one client, one QuickBooks job number, one budget. <b>rental</b> = league deal, E360 keeps the gear; <b>sale</b> = individual team agreement, hardware as cost-of-goods. Shows carry a default job; any cost-bearing item can override it, so one show can bill across two deals.</div></div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
    '<div class="panel summary"><div class="sig">' + icon('bolt') + 'AI summary</div><p>' + esc(summary) + '</p><div class="src">' + esc(project.source || 'Season plan') + '</div></div>' +
    '<div class="panel"><h3>Upcoming shows</h3><div class="next-list">' + upNext + '</div></div>' +
    '<div class="panel"><h3>Season at a glance</h3><div class="glance">' +
    '<div class="g"><span class="k">Overall</span>' + ragPill(r.rag) + '</div>' +
    '<div class="g"><span class="k">Steps done</span><span class="mono">' + r.done + ' / ' + r.total + ' (' + r.pct + '%)</span></div>' +
    '<div class="g"><span class="k">Blocked</span><span class="mono" style="color:' + (r.blocked.length ? 'var(--crit)' : 'var(--text-2)') + '">' + r.blocked.length + '</span></div>' +
    '<div class="g"><span class="k">At risk</span><span class="mono" style="color:' + (r.risk.length ? 'var(--warn)' : 'var(--text-2)') + '">' + r.risk.length + '</span></div>' +
    '<div class="g"><span class="k">Contract value</span><span class="mono">' + esc(fmtMoney((project.jobs || []).reduce(function (a, j) { return a + (j.contract_value || 0); }, 0))) + '</span></div>' +
    (function () {
      /* procurement: hardware on order across this folder's jobs */
      var onOrder = 0;
      (project.jobs || []).forEach(function (j) { var cm = committedForJob(j.id); onOrder += cm.total + cm.capex; });
      return onOrder ? '<div class="g"><span class="k">Hardware on order</span><span class="mono" style="color:var(--warn)">' + esc(fmtMoney(onOrder)) + '</span></div>' : '';
    })() +
    '<div class="g"><span class="k">Next milestone</span><span class="mono">' + esc(projectNext(project).v) + '</span></div>' +
    '</div></div>' +
    /* folder-level thread — season-wide notes (notes pass) */
    notesPanel('project', project.id, { title: 'Season notes', collapse: 2 }) +
    '</div></div>';
}
