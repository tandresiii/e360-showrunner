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
   MEETINGS — the season's meeting summaries
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

   The summary is MARKDOWN and it is a PASTE, so it goes through
   components.js mdHTML() — which escapes the whole source FIRST and transforms
   second. Nothing out of a digest can become markup. See that function's header
   for the argument; persona-walk §52 walks a hostile digest through this
   section and asserts the output is inert.
   ========================================================================== */

/* the chips on a meeting row: which show it was about, and the transcript it
   was written from. Both optional, both silent when absent. */
function meetingChips(m) {
  var out = '';
  var show = m.show_id ? SHOWS_BY_ID[m.show_id] : null;
  if (show) out += '<span class="mini dep">' + esc(show.name) + '</span>';
  var f = m.transcript_file_id ? FILES_BY_ID[m.transcript_file_id] : null;
  if (f) {
    out += '<span class="mini" title="' + esc('Written from ' + f.name + ' — the transcript the ' +
      'unattended reader filed. Deleting that document would unpick this link and leave the ' +
      'summary standing.') + '">' + inlineIcon('file') + ' transcript</span>';
  }
  return out;
}
/* one row. A DIV, not a button, because it carries its own Edit/Delete buttons
   and a button inside a button is invalid — the delegated listener's
   closest('[data-act]') gives the inner controls priority either way. */
function meetingRow(m, canEdit) {
  var when = m.held_at ? fmtDateFull(m.held_at) + (m.held_time ? ' · ' + m.held_time : '') : 'no date';
  var meta = [when, m.attendees || 'attendees not recorded'].join(' · ');
  var prev = mdPreview(m.summary_md, 190);
  return '<div class="mtg-row" ' + act('openMeeting', m.id) + '>' +
    '<div class="mtg-ic">' + icon('users') + '</div>' +
    '<div class="mtg-tx"><b>' + esc(m.title) + '</b>' +
    '<span class="mtg-meta">' + esc(meta) + ' ' + meetingChips(m) + '</span>' +
    (prev ? '<span class="mtg-prev">' + esc(prev) + '</span>' : '') + '</div>' +
    (canEdit
      ? '<div class="mtg-acts">' +
        '<button class="iconbtn" title="Edit this meeting" ' + act('editMeeting', m.id) + '>' + icon('pencil') + '</button>' +
        '<button class="iconbtn" title="Delete this meeting" ' + act('deleteMeeting', m.id) + '>' + icon('trash') + '</button>' +
        '</div>'
      : '') +
    '</div>';
}
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
/* The digest, rendered as a document. Lives here rather than in app.js so the
   walk can render it headless, the same way it renders the season dashboard. */
function meetingDetailHTML(m) {
  var when = m.held_at ? fmtDateFull(m.held_at) + (m.held_time ? ' · ' + m.held_time : '') : 'No date recorded';
  var show = m.show_id ? SHOWS_BY_ID[m.show_id] : null;
  var f = m.transcript_file_id ? FILES_BY_ID[m.transcript_file_id] : null;
  var head = '<div class="mtg-meta" style="margin:0 0 10px;white-space:normal">' +
    esc(when) + ' · <b>' + esc(m.attendees || 'attendees not recorded') + '</b>' +
    (show ? ' · ' + esc(show.name) : '') +
    (m.created_by ? ' · filed by ' + esc(userName(m.created_by)) : '') + '</div>';
  var src = f
    ? '<div class="hint" style="margin:0 0 12px">' + icon('file') + '<span>Written from <b>' +
      esc(f.name) + '</b>. That transcript is an <b>internal</b> document; deleting it would ' +
      'unpick this link and leave the summary standing.</span></div>'
    : '';
  var body = mdHTML(m.summary_md) ||
    '<div class="empty">No summary was written for this meeting.</div>';
  return head + src + '<div class="mtg-body">' + body + '</div>';
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

  /* the show grid */
  var rows = perShow.map(function (x) {
    var s = x.s;
    var job = s.default_job_id ? JOBS_BY_ID[s.default_job_id] : null;
    var overrides = s.bookings.filter(function (b) { return b.job_id && b.job_id !== s.default_job_id; }).length;
    /* quiet photo count (photo pass) — the gallery is filling in */
    var phN = photoCount(s.id);
    var phChip = phN ? '<span class="ph-count" title="' + phN + ' event photo' + (phN === 1 ? '' : 's') + ' on this show">' + inlineIcon('cam') + phN + '</span>' : '';
    return '<tr class="rowlink' + (s.archived_at ? ' archived' : '') + '" ' + act('openShow', s.id) + '>' +
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
  }).join('');

  var showTable = '<div class="card"><div class="card-h"><h3>Shows in this folder</h3><span class="pill idle">' + shows.length + ' shows · sorted by date</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Show</th><th>Date</th><th>Scope</th><th>Health</th><th>Next milestone</th><th>Job</th><th>On-site</th><th>Progress</th></tr></thead>' +
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
