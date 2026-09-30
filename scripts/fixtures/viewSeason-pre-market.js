// ════════════════════════════════════════════════════════════════════════════
// scripts/fixtures/viewSeason-pre-market.js — THE REGRESSION ORACLE (walk §57)
// ────────────────────────────────────────────────────────────────────────────
// viewSeason() EXACTLY as it shipped at 154586f, the commit before markets
// (Tom, 2026-09-30), renamed so it can sit beside the live one in the walk's
// demo tab. The markets pass promised that a folder with NO markets renders
// BYTE-IDENTICALLY to before — this file is "before", verbatim. Never edit
// it to make the gate pass: a diff against it IS the regression.
// ════════════════════════════════════════════════════════════════════════════
function viewSeason__preMarket(project) {
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
