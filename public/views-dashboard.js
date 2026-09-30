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
    /* F4 — a folder's scope line is its shows' scope. One show: print it. Many:
       print the first that HAS one and say how many more are scoped, because a
       season's true total is a sum nobody has agreed on yet. */
    var scoped = p.shows.filter(function (s) { return hasScope(s); });
    var scopeCell = !scoped.length ? '<span class="mini">—</span>'
      : scopeChip(scoped[0]) + (scoped.length > 1
        ? ' <span class="mini">+' + (scoped.length - 1) + ' more scoped</span>' : '');
    return '<tr class="rowlink" ' + act('openFolder', p.id) + '>' +
      '<td><div class="ev-name"><div class="ic">' + icon(typeDef(p.type).icon) + '</div><div><b>' + esc(p.name) + '</b><span>' + esc(p.client) + '</span></div>' + archivedChip(p) + '</div></td>' +
      '<td>' + typeTag(p.type) + '</td>' +
      '<td>' + scopeCell + '</td>' +
      '<td>' + lifecycleChip(p) + '</td>' +
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
    /* it.p can be THIN (absorbed without .shows — see showLabel); unknown
       count reads as the show's own name */
    var where = show ? ((it.p.shows || []).length > 1 ? show.name : (it.p.shows ? it.p.name : show.name)) : it.p.name;
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

  /* F6 — the Archive door. 9/16, Tom, live: it used to render only when the
     LOADED rows contained something archived — but boot fetches active
     folders only, so the door existed right after archiving (the row was
     still in memory), vanished on refresh, and reappeared when any by-id
     fetch happened to merge an archived row back in. A door that flaps with
     navigation history is broken: it renders ALWAYS now, count-free, and the
     view behind it fetches the archived list from the server (its "Nothing
     is archived yet" empty state already reads fine). */
  var archBtn = '<button class="btn ghost" ' + act('goArchive') + ' title="' +
      esc('Archived folders are out of the working set — still fully searchable and browsable.') +
      '">' + icon('box') + 'Archive</button>';

  return '<div class="page-h"><div><h1>Projects</h1><div class="sub">Every event folder, from the sales call to strike — one place. Status rolls up from every show inside the folder, whatever lane set its type uses. Segment the portfolio by division below.</div></div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' + archBtn +
    '<button class="btn primary" ' + act('openNew') + '>' + icon('plus') + 'New Event</button></div></div>' +
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
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Event folder</th><th>Type</th><th>Scope</th><th>Stage</th><th>Status</th><th>Next date</th><th>Lead</th><th>Progress</th></tr></thead>' +
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
   MEETINGS — the season's meeting summaries, as the WHOLE-SEASON roll-up
   ----------------------------------------------------------------------------
   Tom, 2026-09-21, verbatim: "we should definitely add a meeting summary
   feature to projects... we can add these summaries."

   The team runs several client planning calls a week and every one of them
   produces a digest — headings, bold action items, bullets, and a verbatim
   quoted receipt under each decision. Those digests used to live in a chat
   window or somebody's Documents folder, which is to say nowhere: the 9/18
   reader files the TRANSCRIPT (a `files` row, real bytes, fully audited), and
   nobody has ever browsed a vtt. This is the readable layer over it — one row
   per meeting on the folder, newest first, and the digest rendered as a
   document when you open it.

   THIS PANEL IS THE ROLL-UP — every meeting on the folder, season-wide calls
   and venue-specific ones together, each venue-specific one wearing the chip
   that says which show it was about. The per-show half lives on the show's own
   Meetings tab (views-folder.js tabMeetings), because Tom, 2026-09-21: "That
   was a Salt Lake–specific meeting, and it's filed under the whole season.
   We'll have like 9 more of those. Shouldn't it be attached to Salt Lake
   specifically?" — with ~10 team calls incoming, the roll-up alone becomes a
   pile. BOTH SURFACES DRAW THE SAME ROW: meetingRow() lives in components.js
   and neither file has its own copy, so a change to how a meeting reads is one
   edit in one place.
   ========================================================================== */
function meetingsPanel(project) {
  var rows = meetingsForProject(project.id);
  var canEdit = canEditFolder(project);
  var addBtn = canEdit
    ? '<button class="btn sm ghost" style="margin-left:auto" ' + act('addMeeting', project.id) + '>' +
      icon('plus') + 'Add meeting</button>'
    : '';
  var body = rows.length
    ? rows.map(function (m) { return meetingRow(m, canEdit); }).join('')
    : '<div class="empty">No meetings filed on this season yet. ' +
      (canEdit ? 'Paste a digest into <b>Add meeting</b> — title, date, who was on it, and the summary.'
               : 'A pm on this folder files them.') + '</div>';
  return '<div class="panel"><h3 style="display:flex;align-items:center;gap:9px">Meetings · ' +
    rows.length + addBtn + '</h3>' +
    '<div class="mtg-list">' + body + '</div>' +
    '<div class="perm-note">' + inlineIcon('bolt') + ' One record per planning call: what it was ' +
    'called, when, who was on it, and the <b>digest</b> — action items and the verbatim quotes ' +
    'they came from. Written by hand today; the transcript reader files the recording beside it. ' +
    'Meeting summaries are <b>internal</b> — the client-recap generator can never read one.</div></div>';
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
    '<div class="ef-title"><h1>' + esc(project.name) + '</h1>' + typeTag(project.type) + jobsChip(project.jobs) + ragPill(r.rag) + lifecycleChip(project) + archivedChip(project) +
    /* 9/11 — the season folder's own missing-NAS-folder warning */
    storageFolderChip(project) + '</div>' +
    '<div class="ef-sub"><span>' + icon('users') + ' <b>' + esc(project.client) + '</b></span>' +
    '<span>' + icon('pin') + ' <b>Multi-city · ' + shows.length + ' shows</b></span>' +
    '<span>Lead <b>' + esc(userName(project.owner)) + '</b></span>' +
    '<span>Upcoming <b>' + upcoming.length + ' of ' + shows.length + '</b></span>' +
    /* A3. PUT /api/projects/:id was unreachable, so a client renaming their
       programme was unrecordable. Same shape as the show header's pencil, so
       the two stay isomorphic. */
    (canEditFolder(project)
      ? '<span><button class="lnk-btn" ' + act('editFolder', project.id) + '>' + inlineIcon('pencil') +
        'Edit folder</button></span>' : '') +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    /* A season could not gain a show: LOVB got one at create and the other
       five could not exist. The primary act on a season dashboard is now the
       one the entity actually needs. */
    (canEditFolder(project)
      ? '<button class="btn primary" ' + act('addShow', project.id) + '>' + icon('plus') + 'Add show</button>'
      : '') +
    /* 9/16 — the folder-level file door. Agents could file a season-wide
       document against the folder (projectId, no show) since the agent pass;
       a person could not: api.addFile hard-set show_id and nothing rendered
       an Add-file control outside a show. Same dialog, the folder as target,
       bytes into the folder's _project NAS directory. Rendered like the show
       Files tab's own door (no client gate); the server floor is tech+. */
    '<button class="btn ghost" ' + act('addProjectFile', project.id) +
    ' title="File a season-wide document against this folder — no single show. Lands in the folder’s _project NAS directory.">' +
    icon('plus') + 'Add file</button>' +
    /* The season-wide fan-outs stay honestly not-built — but the toast now
       points at Seed pipeline, a control that exists (the old copy sent people
       hunting for a per-show seed button that was never rendered). */
    '<button class="btn ghost" ' + toastAttrs('Not built yet',
      'Applying a template across a season is a per-show fan-out — open a show and use Seed pipeline on its Pipeline tab, which is real') + '>' +
      icon('layers') + 'Apply to all shows</button>' +
    '<button class="btn ghost" ' + toastAttrs('Not built yet',
      'Pushing a whole season is a per-show fan-out — open a show and use Push to Scheduler, which is real') + '>' +
      icon('send') + 'Push season</button>' +
    /* A15's other half: ACTIONS.archiveProject existed and rendered nowhere,
       so the admin path into the archive was auto-sweep or nothing. It sits
       beside Delete because it is Delete's honest alternative — out of the
       working set, nothing lost. Admin-only, the same floor as the route. */
    (canArchive() && !project.archived_at
      ? '<button class="btn ghost" ' + act('archiveProject', project.id) +
        ' title="Move this folder and every show in it out of the working set — nothing is deleted, and the Archive view still opens it">' +
        icon('box') + 'Archive</button>'
      : '') +
    /* the honest, typed way out — deleteProjectAct owns the confirm that
       names the cascade, so the button itself stays quiet */
    (canEditFolder(project)
      ? '<button class="btn ghost" ' + act('deleteFolder', project.id) +
        ' title="Delete this folder and everything in it — a typed confirm names exactly what goes">' +
        icon('trash') + 'Delete</button>'
      : '') +
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

  /* the show grid — grouped under MARKET header rows when the folder has
     markets (Tom, 2026-09-30), and EXACTLY the old flat table when it has
     none: seasonShowRows() returns the pre-market bytes for a market-less
     folder, which the walk holds against the 154586f original verbatim. */
  var groups = marketsOf({ shows: shows });
  var rows = seasonShowRows(perShow, groups);

  var showTable = '<div class="card"><div class="card-h"><h3>Shows in this folder</h3><span class="pill idle">' + shows.length + ' shows · ' +
    (groups.length ? groups.length + ' ' + marketNoun(groups.length, true) + ' · ' : '') + 'sorted by date</span></div>' +
    SEASON_SHOW_THEAD +
    '<tbody>' + rows + '</tbody></table></div></div>';

  /* upcoming shows list */
  var upNext = (upcoming.length ? upcoming : shows).slice(0, 5).map(function (s) {
    var rr = rollup(s), d = daysUntil(s.event_date);
    return '<div class="next-item" ' + act('openShow', s.id) + ' style="cursor:pointer"><div class="txt">' + esc(s.name) +
      '<span>' + esc(s.city) + ' · ' + esc(fmtDate(s.event_date)) + (d != null && d >= 0 ? ' · T−' + d + 'd' : '') + '</span></div>' + ragPill(rr.rag) + ownerChip(s.on_site_poc) + '</div>';
  }).join('') || '<div class="empty">No shows scheduled.</div>';

  /* jobs panel — the commercial dimension, now live with budget burn */
  var jobRows = (project.jobs || []).map(function (j) { return jobPanelRow(j, shows); }).join('') ||
    '<div class="empty">No jobs on this folder yet.</div>';

  var summary = project.summary || project.description || '';

  /* C5. The second deal finally has a door — the LOVB league-vs-team-buy case
     that three UI explainers describe. The server floor is pm + ownership. */
  var addJobBtn = canEditFolder(project)
    ? '<button class="btn sm ghost" style="margin-left:auto" ' + act('addJob', project.id) + '>' +
      icon('plus') + 'Add job</button>'
    : '';

  return head + stats + finSeasonStrip(project) +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    '<div style="display:flex;flex-direction:column;gap:16px">' + showTable +
    '<div class="panel"><h3 style="display:flex;align-items:center;gap:9px">Jobs on this folder · ' + (project.jobs || []).length + addJobBtn + '</h3><div class="next-list">' + jobRows + '</div>' +
    '<div class="perm-note">' + inlineIcon('scale') + ' A <b>job</b> is one commercial deal — one client, one QuickBooks job number, one budget. <b>rental</b> = league deal, E360 keeps the gear; <b>sale</b> = individual team agreement, hardware as cost-of-goods. Shows carry a default job; any cost-bearing item can override it, so one show can bill across two deals.</div></div>' +
    /* the season's meeting record — under the commercial panel, in the wide
       column, because a digest preview needs the room */
    meetingsPanel(project) +
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

/* ============================================================================
   THE SEASON ROW, THE JOB ROW — shared by the season dashboard and the market
   hub. Lifted out of viewSeason() verbatim so the hub draws the SAME row
   rather than a second copy that drifts; the walk renders a market-less
   folder against the pre-market original and demands identical bytes.
   ========================================================================== */
var SEASON_SHOW_THEAD = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Show</th><th>Date</th><th>Scope</th><th>Health</th><th>Next milestone</th><th>Job</th><th>On-site</th><th>Progress</th></tr></thead>';
/* x = { s: show, r: rollup(s), next: showNext(s) } — viewSeason's perShow */
function seasonShowRow(x, inMarket) {
  var s = x.s;
  var job = s.default_job_id ? JOBS_BY_ID[s.default_job_id] : null;
  var overrides = (s.bookings || []).filter(function (b) { return b.job_id && b.job_id !== s.default_job_id; }).length;
  /* quiet photo count (photo pass) — the gallery is filling in */
  var phN = photoCount(s.id);
  var phChip = phN ? '<span class="ph-count" title="' + phN + ' event photo' + (phN === 1 ? '' : 's') + ' on this show">' + inlineIcon('cam') + phN + '</span>' : '';
  return '<tr class="rowlink' + (s.archived_at ? ' archived' : '') + (inMarket ? ' in-mkt' : '') + '" ' + act('openShow', s.id) + '>' +
    '<td><div class="ev-name"><div class="ic">' + icon(typeDef(s.type).icon) + '</div><div><b>' + esc(s.name) + '</b><span>' + esc(s.venue) + '</span></div>' + phChip + contentSeasonChip(s) + recapGlyph(s) + archivedChip(s) + '</div></td>' +
    '<td class="mono" style="font-size:12.5px">' + esc(fmtDate(s.event_date)) + '</td>' +
    /* F4 — the season row carries the scope line, so a season dashboard
       answers "how much LED is Madison" without a drill-in. */
    '<td>' + (hasScope(s) ? scopeChip(s) : '<span class="mini">—</span>') + '</td>' +
    '<td>' + ragPill(x.r.rag) + poSeasonFlag(s) + '</td>' +
    '<td><div class="mono" style="font-size:12.5px"><span style="color:var(--muted)">' + esc(x.next.k) + '</span> ' + esc(x.next.v) + '</div></td>' +
    '<td>' + (job ? '<span class="tag">' + esc(job.qb_job_number) + '</span>' : '') + (overrides ? ' <span class="mini dep">+' + overrides + ' split</span>' : '') + '</td>' +
    '<td><div class="who-cell">' + av(s.on_site_poc) + '<span>' + esc(firstName(s.on_site_poc)) + '</span></div></td>' +
    '<td><div class="prog"><div class="bar"><div class="fill" style="width:' + x.r.pct + '%"></div></div><div class="num">' + x.r.pct + '%</div></div></td>' +
    '</tr>';
}
/* MARKETS — the season table's body. No markets: the flat rows, byte for
   byte what shipped before. Markets: each market's header row (name · the
   worst show's RAG · show count · progress — the door to its hub), its shows
   under it in date order, then every market-less show after the grouped
   ones behind a quiet divider. Groups arrive in the order the season meets
   them (marketsOf: earliest show first). */
function seasonShowRows(perShow, groups) {
  if (!groups || !groups.length) return perShow.map(function (x) { return seasonShowRow(x); }).join('');
  var out = '';
  groups.forEach(function (g) {
    var mine = perShow.filter(function (x) { return marketKey(x.s.market) === g.key; });
    out += marketHeaderRow(g) + mine.map(function (x) { return seasonShowRow(x, true); }).join('');
  });
  var loose = perShow.filter(function (x) { return !marketKey(x.s.market); });
  if (loose.length) {
    out += '<tr class="mkt-row loose"><td colspan="8"><div class="mkt-h"><span class="mini">Not in a ' +
      esc(marketNoun(1, true)) + ' · ' + loose.length + '</span></div></td></tr>' +
      loose.map(function (x) { return seasonShowRow(x); }).join('');
  }
  return out;
}
function marketHeaderRow(g) {
  var mr = marketRollup(g.shows);
  var n = g.shows.length;
  return '<tr class="rowlink mkt-row" ' + act('openMarket', g.shows[0].id) + ' title="' +
    esc('Open the ' + g.name + ' ' + marketNoun(1, true) + ' — its shows, meetings, tasks, files and job in one place') + '">' +
    '<td colspan="8"><div class="mkt-h">' + icon('pin') + '<b>' + esc(g.name) + '</b>' +
    '<span class="mini">' + esc(MARKET_LABEL) + ' · ' + n + ' show' + (n === 1 ? '' : 's') + '</span>' +
    ragPill(mr.rag) +
    '<span class="mini">' + mr.pct + '% done</span>' +
    '<span class="mkt-go">Open ' + esc(marketNoun(1, true)) + ' →</span></div></td></tr>';
}
/* one job on a jobs panel; `shows` scopes the "N shows" count (the whole
   folder on the season dashboard, the market's shows on its hub) */
function jobPanelRow(j, shows) {
  var jf = financeForJob(j.id);
  var defaults = shows.filter(function (s) { return s.default_job_id === j.id; }).length;
  var extras = 0;
  shows.forEach(function (s) { (s.bookings || []).forEach(function (b) { if (b.job_id === j.id && s.default_job_id !== j.id) extras++; }); });
  return '<div class="next-item" ' + act('openJob', j.id) + ' style="cursor:pointer"><div class="txt">' + esc(j.client) + '<span>' + esc(j.description) + '</span></div>' +
    '<span class="tag">' + esc(j.qb_job_number) + '</span>' + tempBadge(j) + dealTag(j) +
    '<span class="mono" style="font-size:12px;color:var(--text-2)">' + esc(fmtMoney(j.contract_value)) + '</span>' +
    burnBar(jf ? jf.actual : 0, jf ? jf.budget_total : 0) +
    '<span class="mini">' + (defaults ? defaults + ' show' + (defaults === 1 ? '' : 's') : extras + ' item' + (extras === 1 ? '' : 's')) + '</span></div>';
}

/* ============================================================================
   SHAREABLE PANELS — built for the market hub, shaped for any page that holds
   a SET OF SHOWS (a market today; the season page is expected to adopt them).
   Each takes the shows it is about plus an options bag and returns one panel;
   none reads a page global, none knows it is on the hub.
     showsTableCard(perShow, o)   the season table's card over any show set
     openTasksList(shows)         the open steps across shows, soonest first
     openTasksPanel(shows, o)     …as a compact panel (owner · due · status)
     showJobsPanel(shows, o)      the distinct DEFAULT jobs the shows bill to
     meetingsListPanel(rows, o)   meetings through the shared meetingRow()
     showFilesPanel(shows, byId)  documents grouped by show, through fileCard()
   ========================================================================== */
var TASKS_PANEL_MAX = 25;
function showsTableCard(perShow, o) {
  o = o || {};
  var n = perShow.length;
  return '<div class="card"><div class="card-h"><h3>' + esc(o.title || 'Shows') + '</h3>' +
    '<span class="pill idle">' + n + ' show' + (n === 1 ? '' : 's') + ' · sorted by date</span></div>' +
    SEASON_SHOW_THEAD + '<tbody>' +
    perShow.map(function (x) { return seasonShowRow(x); }).join('') +
    '</tbody></table></div></div>';
}
function openTasksList(shows) {
  var out = [];
  (shows || []).forEach(function (s) {
    allSteps(s).forEach(function (p) {
      var st = normStatus(p.step.status);
      if (st !== 'done' && st !== 'na') out.push({ step: p.step, lane: p.lane, show: s });
    });
  });
  return out.sort(function (a, b) {
    return String(a.step.due_date || '9999').localeCompare(String(b.step.due_date || '9999'));
  });
}
/* o.max caps the rows (the rest are one click away on each show); o.empty is
   the sentence for none. A row opens the show the task lives on. */
function openTasksPanel(shows, o) {
  o = o || {};
  var max = o.max || TASKS_PANEL_MAX;
  var list = openTasksList(shows);
  var rows = list.slice(0, max).map(function (t) {
    var s = t.step;
    return '<div class="next-item" ' + act('openShow', t.show.id) + ' style="cursor:pointer"><div class="txt">' + esc(s.title) +
      '<span>' + esc(t.show.name) + ' · ' + esc((t.lane && t.lane.label) || s.lane || '') + ' · due ' + esc(fmtDate(s.due_date)) + '</span></div>' +
      (s.risk ? '<span class="pill warn"><span class="dot"></span>At risk</span>' : statusPill(s.status)) +
      ownerChip(s.owner) + '</div>';
  }).join('');
  return '<div class="panel"><h3>Open tasks · ' + list.length + '</h3><div class="next-list">' +
    (rows || '<div class="empty">' + esc(o.empty || 'Nothing open on these shows.') + '</div>') + '</div>' +
    (list.length > max ? '<div class="perm-note">Showing the ' + max + ' soonest — open a show for the rest.</div>' : '') +
    '</div>';
}
/* NO MAPPING TABLE: the job a set of shows DEFAULTS to is its commercial
   face. One common job → one row; shows that disagree → each job, listed as
   it stands, never a "primary" the data does not say. Rows are the season's
   own jobPanelRow(), so each opens the job page (#/jobs/:id). */
function showJobsPanel(shows, o) {
  o = o || {};
  var noun = o.noun || 'folder';
  var ids = [], noJob = 0;
  (shows || []).forEach(function (s) {
    if (!s.default_job_id) { noJob++; return; }
    if (ids.indexOf(s.default_job_id) < 0) ids.push(s.default_job_id);
  });
  var rows = ids.map(function (id) {
    var j = JOBS_BY_ID[id];
    return j ? jobPanelRow(j, shows)
      : '<div class="next-item"><div class="txt">Job #' + Number(id) + '<span>not loaded — open the season to read it</span></div></div>';
  }).join('');
  return '<div class="panel shows-jobs"><h3>' + (ids.length > 1 ? 'Jobs · ' + ids.length : 'Job') + '</h3>' +
    '<div class="next-list">' + (rows || '<div class="empty">No show in this ' + esc(noun) + ' bills to a job yet.</div>') + '</div>' +
    (ids.length > 1
      ? '<div class="perm-note">' + inlineIcon('scale') + ' These shows bill to <b>different jobs</b> — each one is listed as it stands, with how many of this ' + esc(noun) + '’s shows default to it.</div>'
      : '') +
    (noJob ? '<div class="perm-note">' + noJob + ' show' + (noJob === 1 ? ' has' : 's have') + ' no default job.</div>' : '') +
    '</div>';
}
/* o = { canEdit, from (the rows' origin k), addProjectId, empty, note } —
   `empty` and `note` are HTML the CALLER has already escaped */
function meetingsListPanel(rows, o) {
  o = o || {};
  return '<div class="panel"><h3 style="display:flex;align-items:center;gap:9px">Meetings · ' + rows.length +
    (o.canEdit && o.addProjectId
      ? '<button class="btn sm ghost" style="margin-left:auto" ' + act('addMeeting', o.addProjectId, o.from) + '>' + icon('plus') + 'Add meeting</button>'
      : '') +
    '</h3><div class="mtg-list">' +
    (rows.length ? rows.map(function (m) { return meetingRow(m, o.canEdit, o.from); }).join('')
      : '<div class="empty">' + (o.empty || 'No meetings yet.') + '</div>') +
    '</div>' + (o.note ? '<div class="perm-note">' + inlineIcon('bolt') + ' ' + o.note + '</div>' : '') + '</div>';
}
/* documents only, grouped by show. `fullById` maps show id → the show as a
   files-carrying read returned it (listShows); a show missing from it falls
   back to itself, and a show with no .files reads as none — never a throw. */
function showFilesPanel(shows, fullById) {
  fullById = fullById || {};
  var blocks = (shows || []).map(function (s0) {
    var s = fullById[s0.id] || s0;
    var docs = (s.files || []).filter(function (f) { return f.kind !== 'photo'; });
    return '<div class="mkt-files"><div class="files-head"><h3>' + esc(s0.name) + ' · ' + docs.length + '</h3>' +
      '<button class="btn sm ghost" ' + act('openShow', s0.id) + '>Open show</button></div>' +
      (docs.length ? '<div class="file-grid">' + docs.map(fileCard).join('') + '</div>'
        : '<div class="empty">No documents on this show yet.</div>') + '</div>';
  }).join('');
  return '<div class="card" style="padding:14px"><div class="card-h" style="padding:0 0 10px"><h3>Files</h3></div>' + blocks + '</div>';
}

/* ============================================================================
   THE MARKET HUB — the umbrella (Tom, 2026-09-30)
   ----------------------------------------------------------------------------
   "Grand Rapids lives in the MLV project folder. but has a system install and
   scrimmage show - which arent as connected under a grand rapids umbrella as
   i would like." This is the umbrella: for folder P + market M, one page with
   the market's shows, its meetings (anchored to it AND pinned to its shows),
   the open tasks across its shows, their files, and the JOB(S) they bill to.

   The page is a FRAME over the shareable panels above plus the season's own
   rows (seasonShowRow, jobPanelRow) and the shared meetingRow / fileCard —
   the only markup of its own is the header and the stat strip.

   STUB-SAFE: every collection is `|| []`-guarded and the folder is always the
   project passed in — no inline show.project read.

   `market` arrives as the group marketOf() found (canonical name + shows);
   `full` is the folder's shows as listShows() returns them (files attached),
   read by id — the season dashboard's embedded shows carry no files.
   ========================================================================== */
function viewMarket(project, market, full) {
  var byId = {};
  (full || []).forEach(function (s) { if (s) byId[s.id] = s; });
  var shows = (market.shows || []).slice();
  var perShow = shows.map(function (s) { return { s: s, r: rollup(s), next: showNext(s) }; });
  var mr = marketRollup(shows);
  var canEdit = canEditFolder(project);
  var from = 'mkt:' + shows[0].id;
  var noun = marketNoun(1, true);
  var upcoming = shows.filter(function (s) { return s.event_date >= TODAY_ISO; });
  var open = openTasksList(shows);
  var lateN = open.filter(function (t) { return isOverdue(t.step); }).length;

  var head = '<div class="ef-head"><div class="ef-top"><div>' +
    '<div class="ef-title"><h1>' + esc(market.name) + '</h1>' +
    '<span class="tag">' + esc(MARKET_LABEL) + '</span>' + ragPill(mr.rag) + '</div>' +
    '<div class="ef-sub">' +
    '<span>' + icon('folder') + ' <button class="lnk-btn" ' + act('openFolder', project.id) + '>' + esc(project.name) + '</button></span>' +
    '<span>' + icon('users') + ' <b>' + esc(project.client || '') + '</b></span>' +
    '<span>' + icon('pin') + ' <b>' + shows.length + ' show' + (shows.length === 1 ? '' : 's') + '</b></span>' +
    '<span>Upcoming <b>' + upcoming.length + ' of ' + shows.length + '</b></span>' +
    '</div></div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    (canEdit
      ? '<button class="btn primary" ' + act('addMeeting', project.id, from) + '>' + icon('plus') + 'Add meeting</button>' +
        '<button class="btn ghost" ' + act('addShow', project.id, from) + '>' + icon('plus') + 'Add show</button>'
      : '') +
    '<button class="btn ghost" ' + act('openFolder', project.id) + '>' + icon('folder') + 'Season dashboard</button>' +
    '</div></div></div>';

  var stats = '<div class="stats">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Shows</div><div class="v">' + shows.length + '<small>/' + upcoming.length + ' ahead</small></div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Open tasks</div><div class="v">' + open.length + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Overdue</div><div class="v" style="color:' + (lateN ? 'var(--crit)' : 'var(--text-2)') + '">' + lateN + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">Progress</div><div class="v">' + mr.pct + '<small>%</small></div></div>' +
    '</div>';

  var mtgPanel = meetingsListPanel(meetingsForMarket(project.id, market.name), {
    canEdit: canEdit, from: from, addProjectId: project.id,
    empty: 'No meetings on ' + esc(market.name) + ' yet. A call about the whole ' + esc(noun) +
      ' goes here — it shows on every ' + esc(market.name) + ' show’s Meetings tab.',
    note: 'Calls filed on the <b>' + esc(noun) + '</b> appear on every one of its shows; calls pinned to ' +
      'one show appear here too, wearing that show’s name. Meeting summaries are <b>internal</b>.'
  });

  return head + stats +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
      showsTableCard(perShow, { title: 'Shows in this ' + noun }) + mtgPanel + showFilesPanel(shows, byId) + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
      showJobsPanel(shows, { noun: noun }) + openTasksPanel(shows, { empty: 'Nothing open on these shows.' }) + '</div></div>';
}

/* ============================================================================
   F6 · THE ARCHIVE VIEW — "we don't want 300 in our normal area in a year"
   ----------------------------------------------------------------------------
   Archiving hides a folder from the WORKING SET, not from the app. Everything
   still resolves: the rows below open the same folder view, with the same tabs,
   the same files and the same money. Season rollups were never touched, because
   a folder's own show list keeps every show it has ever had.

   Manual unarchive is an ADMIN act (Tom's rule); everyone else can browse.
   ========================================================================== */
function viewArchive(projects) {
  var rows = projects.slice().sort(function (a, b) {
    return String(b.archived_at || '').localeCompare(String(a.archived_at || ''));
  }).map(function (p) {
    var shows = p.shows || [];
    var span = shows.length
      ? fmtDate(shows.map(function (s) { return s.event_date; }).sort()[0]) +
        (shows.length > 1 ? ' – ' + fmtDate(shows.map(function (s) { return s.event_date; }).sort().slice(-1)[0]) : '')
      : '—';
    var scoped = shows.filter(function (s) { return hasScope(s); });
    var value = (p.jobs || []).reduce(function (a, j) { return a + (j.contract_value || 0); }, 0);
    return '<tr class="rowlink" ' + act('openFolder', p.id) + '>' +
      '<td><div class="ev-name"><div class="ic">' + icon(typeDef(p.type).icon) + '</div>' +
      '<div><b>' + esc(p.name) + '</b><span>' + esc(p.client) + '</span></div></div></td>' +
      '<td>' + typeTag(p.type) + '</td>' +
      '<td>' + (scoped.length ? scopeChip(scoped[0]) : '<span class="mini">—</span>') + '</td>' +
      '<td class="mono" style="font-size:12.5px">' + esc(span) + '</td>' +
      '<td class="mono" style="font-size:12.5px">' + esc(fmtDate(String(p.archived_at || '').slice(0, 10))) +
        '<span class="mini" style="display:block">' +
        esc(p.archived_by === 'system' ? 'automatically' : 'by ' + (userName(p.archived_by) || p.archived_by || '—')) +
        '</span></td>' +
      '<td class="money" style="font-size:12.5px">' + esc(canSeeFinance() ? fmtMoney(value) : '—') + '</td>' +
      '<td>' + (canArchive()
        ? '<button class="btn sm ghost" ' + act('unarchiveProject', p.id) + '>' + icon('refresh') + 'Restore</button>'
        : '<span class="mini">admins restore</span>') + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="7"><div class="empty">Nothing is archived yet. A folder lands here ' +
    ARCHIVE_AFTER_DAYS + ' days after its closeout completes — recap sent, every show report filed, ' +
    'and no money left waiting on paperwork.</div></td></tr>';

  return '<div class="page-h"><div><h1>Archive</h1><div class="sub">Folders that closed out and left the ' +
    'working set. Nothing here is deleted: every folder still opens with all of its files, money and ' +
    'history, and search still finds it. A folder auto-archives ' + ARCHIVE_AFTER_DAYS +
    ' days after closeout completes — applied the next time the sweep runs: on boot, or when an ' +
    'admin presses Sweep in Settings.</div></div>' +
    '<button class="btn ghost" ' + act('goProjects') + '>' + icon('grid') + 'Back to Projects</button></div>' +
    '<div class="card"><div class="card-h"><h3>Archived folders</h3>' +
    '<span class="pill idle">' + projects.length + ' folder' + (projects.length === 1 ? '' : 's') +
    ' · newest first</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Event folder</th><th>Type</th><th>Scope</th>' +
    '<th>Ran</th><th>Archived</th><th>Contract</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="hint">' + icon('bolt') + '<span>Closeout is machine-checked, never a box somebody ticks: ' +
    '<b>recap sent</b> + <b>every tech show report filed</b> + <b>no money waiting on paperwork</b>. ' +
    'The ' + ARCHIVE_AFTER_DAYS + '-day clock runs from the moment all three hold — and stops again if ' +
    'any of them comes undone.</span></div>';
}
