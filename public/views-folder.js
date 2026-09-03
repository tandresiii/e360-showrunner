/* ============================================================================
   e360 SHOWRUNNER — SHOW VIEW (the tabbed per-show folder) + its tabs
   ----------------------------------------------------------------------------
   Renders whatever lanes the show's project TYPE declares — nothing here is
   hardcoded to a lane set. A single-show folder auto-collapses straight into
   this view (see app.js openFolder), so it reads exactly as the flat folder did.
   ========================================================================== */

/* ---------------------------------------------------------------- header -- */
function viewShow(show, opts) {
  opts = opts || {};
  var p = show.project, r = rollup(show), chain = show.chain, gear = show.gear;
  var single = p.single;
  var title = single ? p.name : show.name;

  /* 8/H7. The strip always rendered milestones; nothing wrote one. The pencil
     opens the editor for whoever can edit the folder — same predicate as every
     other write on this header. */
  var metas = (show.milestones || []).map(function (m, i) {
    return '<div class="m"><div class="k">' + esc(m.label) + '</div><div class="val ' + (i === 0 ? 'tick' : '') + '">' + esc(fmtDate(m.date)) + '</div></div>';
  }).join('') +
    (canEditFolderOf(show)
      ? '<div class="m"><button class="lnk-btn" ' + act('editMilestones', show.id) + '>' + inlineIcon('pencil') +
        ((show.milestones || []).length ? 'Milestones' : 'Add milestones') + '</button></div>'
      : '');

  /* proofs tab for print/both when proof data exists; bookings tab otherwise */
  /* P3, corrected. Both of these tabs used to appear only once the entity they
     manage already existed — and neither entity could be created anywhere else,
     so on a real database the tab that makes the first proof and the tab that
     makes the first booking were both unreachable. A tab that the show's TYPE
     calls for is shown whether or not it has rows yet; its empty state does the
     explaining. */
  var hasProofLane = typeDef(show.type).lanes.some(function (l) { return l.key === 'proof'; });
  var nProofs = (show.proofs || []).length;
  var nBookings = (show.bookings || []).length;
  var thirdTab = (hasProofLane
      ? '<button data-t="proofs">Proofs &amp; Approval' + (nProofs ? ' <span class="n">' + nProofs + '</span>' : '') + '</button>'
      : '') +
    '<button data-t="bookings">Bookings' + (nBookings ? ' <span class="n">' + nBookings + '</span>' : '') + '</button>';
  var hasDeliv = typeDef(show.type).lanes.some(function (l) { return l.key === 'deliverables'; });
  var hasGear = typeDef(show.type).lanes.some(function (l) { return l.key === 'gear'; });
  var specTab = hasDeliv ? '<button data-t="specs">Specs &amp; Chain' + (chainAnyStale(chain) ? ' <span class="n" style="color:var(--crit)">stale</span>' : '') + '</button>' : '';
  var gearTab = hasGear ? '<button data-t="gear">Gear' + (gear.pulled ? ' <span class="n">' + gear.kit.pull.length + '</span>' : ' <span class="n">Flex</span>') + '</button>' : '';

  /* the commercial dimension: which deal does this show bill to? */
  var jobTag = jobChip(show.job);

  /* money on this show: financial docs + expenses (the Financials tab) */
  var finCount = show.files.filter(function (f) { return FIN_KINDS[f.kind]; }).length +
    (show.expenses || []).length;
  var finTab = '<button data-t="financials">Financials' + (finCount ? ' <span class="n">' + finCount + '</span>' : '') + '</button>';

  /* photos live on their own tab (photo pass); Files counts documents only */
  var phN = photoCount(show.id);
  var phTab = '<button data-t="photos">Photos' + (phN ? ' <span class="n">' + phN + '</span>' : '') + '</button>';
  var docN = show.files.filter(function (f) { return f.kind !== 'photo'; }).length;

  /* the post-strike closeout deliverable (recap pass) — badge = its status */
  var rec = recapForShow(show.id);
  var recTab = '<button data-t="recap">Recap' + (rec
    ? ' <span class="n"' + (rec.status === 'draft' ? ' style="color:var(--warn)"' : '') + '>' + esc(recapStatusMeta(rec).short) + '</span>'
    : '') + '</button>';

  var firstFile = show.files.length ? show.files[0].id : null;

  /* schedule — the onsite call sheet; badge = how many scheduled days */
  var schedDaysN = (show.schedule_items || []).length ? scheduleDays(show.id).length : 0;
  var schedTab = '<button data-t="schedule">Schedule' + (schedDaysN ? ' <span class="n">' + schedDaysN + 'd</span>' : '') + '</button>';

  /* F2 — show reports. The badge is the OWED count, because that is the number
     the show owner is chasing; a show nobody owes anything on shows no badge.
     A tech with nothing owed still gets the tab: their own filed report is
     theirs to re-read. */
  var repSum = reportSummary(show.id);
  var myRep = reportFor(show.id, ME);
  var repTab = (repSum.total || myRep)
    ? '<button data-t="reports">Reports' +
      (repSum.owed ? ' <span class="n" style="color:var(--warn)">' + repSum.owed + '</span>'
                   : ' <span class="n">' + repSum.filed + '</span>') + '</button>'
    : '';

  /* F5 — the explicit Confirm button. It appears only when there is something
     to confirm AND this person may do it; a dead button that explains itself is
     still a dead button. */
  var confirmBtn = (!isConfirmed(show) && canConfirmShow(show))
    ? '<button class="btn primary" ' + act('confirmShow', show.id) + ' title="' +
      esc('Record that the client committed — signed or PO\'d. Datestamped and logged, and it ' +
          'unlocks the scheduler push.') + '">' + icon('checkC') + 'Confirm</button>'
    : '';
  /* push v2 — the push affordance reads the show's scheduler state. Unlinked:
     one button that opens the create-vs-link choice. Linked: "Push updates"
     (with a warn dot when the show changed after the last push), the deep link
     into the staffing app, and unlink for whoever may edit. The provenance
     line under the header sub answers "did this reach staffing, when, by
     whom" without opening anything. */
  var schedLinked = !!show.scheduler_event_id;
  var pushBtn = schedLinked
    ? '<button class="btn primary" ' + act('pushSched', show.id) + ' title="' +
      esc('Re-sync staffing event #' + show.scheduler_event_id + ' — you choose whether hand-entered ' +
          'staffing rows are kept (default) or replaced.') + '">' + icon('send') + 'Push updates' +
      (show.scheduler_stale ? ' <span class="n" style="color:var(--warn)">●</span>' : '') + '</button>'
    : '<button class="btn primary" ' + act('pushSched', show.id) + '>' + icon('send') + 'Push to Scheduler</button>';
  var schedBtns = schedLinked
    ? '<button class="btn ghost" ' + act('viewInScheduler', show.id) + '>' + icon('link') + 'View in Scheduler</button>' +
      (canEditFolderOf(show)
        ? '<button class="btn ghost" ' + act('unlinkSched', show.id) + ' title="' +
          esc('Clears the link here only — nothing is deleted in the staffing app.') + '">' +
          icon('x') + 'Unlink</button>'
        : '')
    : '';
  var schedLine = schedLinked
    ? '<span>' + icon('send') + ' ' +
      (show.scheduler_pushed_at
        ? 'Pushed <b>' + esc(fmtAgo(show.scheduler_pushed_at)) + ' ago</b> by <b>' +
          esc(userName(show.scheduler_pushed_by) || show.scheduler_pushed_by || '—') +
          '</b> · event #' + esc(show.scheduler_event_id) +
          (show.scheduler_stale
            ? ' <b style="color:var(--warn)">· changed since — push updates</b>' : '')
        : 'Linked to staffing event <b>#' + esc(show.scheduler_event_id) + '</b> · nothing pushed yet') +
      '</span>'
    : '';
  /* F6 — archived shows announce themselves and offer the way back */
  var archBanner = show.archived_at
    ? '<div class="arch-banner">' + icon('box') +
      '<div><b>This show is archived.</b><span>Archived ' +
      esc(fmtDate(String(show.archived_at).slice(0, 10))) +
      (show.archived_by ? ' by ' + esc(userName(show.archived_by) || show.archived_by) : '') +
      ' — it is out of the working set but nothing has been deleted, and every tab below still works.</span></div>' +
      (canArchive() ? '<button class="btn sm ghost" ' + act('unarchiveShow', show.id) + '>' +
        icon('refresh') + 'Put it back</button>' : '') + '</div>'
    : '';

  return archBanner + '<div class="ef-head">' +
    '<div class="ef-top"><div>' +
    '<div class="ef-title"><h1>' + esc(title) + '</h1>' + typeTag(show.type) + jobTag + ragPill(r.rag) +
    /* 9's last mile: rag_override rode the PUT whitelist from the start and no
       control anywhere set it. The pencil lives ON the health pill it governs;
       an overridden pill says so, because a hand-set green must never read as
       a derived one. Server gate: canEditProject (manager+ / pm-owner). */
    (show.rag_override
      ? '<span class="mini" title="Health is overridden by hand — the pipeline-derived status is ignored until the override is cleared">by hand</span>'
      : '') +
    (canEditFolderOf(show)
      ? '<button class="iconbtn" style="width:24px;height:24px" title="Set or clear a health override" ' +
        act('ragOverride', show.id) + '>' + icon('pencil') + '</button>'
      : '') +
      lifecycleChip(show) + archivedChip(show) + '</div>' +
    /* F4 — the scope line sits directly under the title: "what we're
       delivering" belongs next to what we're calling it. */
    '<div class="ef-scope">' + scopeChip(show, { empty: canEditFolderOf(show) }) +
      (canEditFolderOf(show) && RECAP_EDIT_ROLES[CURRENT_USER.role]
        ? '<button class="lnk-btn" ' + act('editScope', show.id) + '>' + inlineIcon('pencil') +
          (hasScope(show) ? 'Edit scope' : 'Set scope') + '</button>' : '') +
      confirmChip(show) + '</div>' +
    '<div class="ef-sub"><span>' + icon('users') + ' <b>' + esc(show.job ? show.job.client : p.client) + '</b></span>' +
    '<span>' + icon('pin') + ' <b>' + esc(show.venue) + '</b></span>' +
    '<span>Lead <b>' + esc(userName(show.owner)) + '</b></span>' +
    '<span>On-site <b>' + esc(userName(show.on_site_poc)) + '</b></span>' +
    /* A2. PUT /api/shows/:id accepted sixteen fields and recomputed the whole
       back-schedule on a date change, and had no api method and no data-act —
       so a venue change or a date move was impossible through the product on
       the app's most-used object. An edit pencil belongs everywhere Tom sees
       data he created. */
    (canEditFolderOf(show)
      ? '<span><button class="lnk-btn" ' + act('editShow', show.id) + '>' + inlineIcon('pencil') +
        'Edit event</button></span>' : '') +
    schedLine +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    (single ? '' : '<button class="btn ghost" ' + act('openFolder', p.id) + '>' + icon('folder') + 'Back to season</button>') +
    (firstFile != null ? '<button class="btn ghost" ' + act('openViewer', firstFile) + '>' + icon('img') + 'Open in Viewer</button>' : '') +
    schedBtns +
    confirmBtn +
    pushBtn +
    /* the honest way out — deleteShowAct owns the typed confirm that names
       the cascade, so the button itself stays quiet */
    (canEditFolderOf(show)
      ? '<button class="btn ghost" ' + act('deleteShow', show.id) +
        ' title="Delete this show and everything on it — a typed confirm names exactly what goes">' +
        icon('trash') + 'Delete</button>'
      : '') +
    '</div></div>' +
    stageTimeline(show) +
    '<div class="ef-meta">' + metas + '</div>' +
    '</div>' +
    '<div class="tabs" id="ftabs">' +
    '<button data-t="overview" class="on">' + icon('grid') + 'Overview</button>' +
    schedTab +
    '<button data-t="pipeline">Pipeline <span class="n">' + r.total + '</span></button>' +
    specTab + gearTab +
    '<button data-t="files">Files <span class="n">' + docN + '</span></button>' +
    phTab +
    repTab +
    recTab +
    finTab +
    thirdTab +
    '<button data-t="activity">Activity</button>' +
    '</div>' +
    '<div id="ftab"></div>';
}

function drawShowTab(show, t) {
  var ft = $('#ftab'); if (!ft) return;
  ft.innerHTML = t === 'overview' ? tabOverview(show)
    : t === 'schedule' ? tabSchedule(show)
    : t === 'pipeline' ? tabPipeline(show)
    : t === 'specs' ? tabSpecs(show)
    : t === 'gear' ? tabGear(show)
    : t === 'files' ? tabFiles(show)
    : t === 'photos' ? tabPhotos(show)
    : t === 'reports' ? tabReports(show)
    : t === 'recap' ? tabRecap(show)
    : t === 'financials' ? tabFinancials(show)
    : t === 'proofs' ? tabProofs(show)
    : t === 'bookings' ? tabBookings(show)
    : tabActivity(show);
}
function bindFolder(show) {
  drawShowTab(show, 'overview');
  document.querySelectorAll('#ftabs button').forEach(function (b) {
    b.onclick = function () {
      document.querySelectorAll('#ftabs button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      drawShowTab(show, b.dataset.t);
    };
  });
}
function activeShowTab() { var b = document.querySelector('#ftabs button.on'); return b ? b.dataset.t : 'overview'; }
function setFolderTab(tabKey) { var b = document.querySelector('#ftabs button[data-t="' + tabKey + '"]'); if (b) b.click(); }
function refreshSpecTabBadge(show) {
  var b = document.querySelector('#ftabs button[data-t="specs"]');
  if (b) b.innerHTML = 'Specs &amp; Chain' + (chainAnyStale(show.chain) ? ' <span class="n" style="color:var(--crit)">stale</span>' : '');
}

/* -------------------------------------------------------------- overview -- */
function tabOverview(show) {
  var r = rollup(show);
  var laneStat = laneSteps(show).map(function (x) {
    var total = x.steps.length, d = x.steps.filter(function (s) { return normStatus(s.status) === 'done'; }).length;
    var segs = total ? x.steps.map(function (s) { return '<i style="width:' + (100 / total) + '%;background:' + segColor(s) + '"></i>'; }).join('') : '<i style="width:100%;background:var(--surface-3)"></i>';
    return '<div class="ls-row"><div class="nm">' + esc(x.lane.label) + '</div><div class="bar">' + segs + '</div><div class="frac">' + d + '/' + total + '</div></div>';
  }).join('');

  var openSteps = allSteps(show).filter(function (p) {
    var s = normStatus(p.step.status); return s !== 'done' && s !== 'na';
  }).sort(function (a, b) { return (a.step.due_date || '9999').localeCompare(b.step.due_date || '9999'); });

  var nextOne = openSteps[0] || null;
  var next = openSteps.slice(0, 5).map(function (p) {
    return '<div class="next-item"><div class="txt">' + esc(p.step.title) + '<span>' + esc(p.lane.label) + ' · due ' + esc(fmtDate(p.step.due_date)) + '</span></div>' + statusPill(p.step.status) + ownerChip(p.step.owner) + '</div>';
  }).join('') || '<div class="empty">All steps complete.</div>';

  var biggest = r.blocked.length ? r.blocked[0] : (r.risk.length ? r.risk[0] : null);
  var ragCol = { go: 'var(--go)', warn: 'var(--warn)', crit: 'var(--crit)', idle: 'var(--idle)' }[r.rag];

  var health = '<div class="health"><div class="hrag" style="background:' + ragCol + '"></div>' +
    '<div class="hbig">' + ragPill(r.rag) + '<div class="hp" style="color:' + ragCol + '">' + r.pct + '%</div><div class="hsub">' + r.done + ' / ' + r.total + ' steps done</div></div>' +
    '<div class="hmet">' +
    '<div class="hm"><div class="k">Blocked</div><div class="v" style="color:' + (r.blocked.length ? 'var(--crit)' : 'var(--text-2)') + '">' + r.blocked.length + '</div></div>' +
    '<div class="hm"><div class="k">Late / overdue</div><div class="v" style="color:' + (r.late.length ? 'var(--warn)' : 'var(--text-2)') + '">' + r.late.length + '</div></div>' +
    '<div class="hm"><div class="k">Next up</div><div class="v sm">' + (nextOne ? esc(nextOne.step.title) + ' <span style="color:var(--muted);font-weight:500">· ' + esc(fmtDate(nextOne.step.due_date)) + '</span>' : '—') + '</div></div>' +
    '<div class="hm"><div class="k">Biggest risk</div><div class="v sm" style="color:' + (biggest ? 'var(--crit)' : 'var(--text-2)') + '">' + (biggest ? esc(biggest.step.title) : 'None — on track') + '</div></div>' +
    '</div></div>';

  var lateList = r.late.length ? '<div class="panel"><h3>Blocked &amp; late · ' + r.late.length + '</h3><div class="next-list">' +
    r.late.slice(0, 6).map(function (p) {
      var why = normStatus(p.step.status) === 'blocked' ? '<span class="pill crit"><span class="dot"></span>Blocked</span>'
        : (p.step.risk ? '<span class="pill warn"><span class="dot"></span>At risk</span>' : '<span class="pill crit"><span class="dot"></span>Overdue</span>');
      return '<div class="next-item"><div class="txt">' + esc(p.step.title) + '<span>' + esc(p.lane.label) + ' · due ' + esc(fmtDate(p.step.due_date)) + '</span></div>' + why + ownerChip(p.step.owner) + '</div>';
    }).join('') + '</div></div>' : '';

  var nx = showNext(show);
  /* budget burn for the show's job — visible to everyone (margin is not) */
  var jfin = show.default_job_id ? financeForJob(show.default_job_id) : null;
  var burnRow = jfin && jfin.budget_total
    ? '<div class="g"><span class="k">Job budget burn</span><span class="mono" style="color:' + burnColor(jfin.burnPct) + '">' +
      Math.round(jfin.burnPct) + '% · ' + esc(fmtMoney(jfin.actual)) + '</span></div>'
    : '';
  var glance = '<div class="glance">' +
    '<div class="g"><span class="k">Overall</span>' + ragPill(r.rag) + '</div>' +
    /* F4 — "what we're delivering" belongs in the at-a-glance list, above the
       process numbers: it is the one line that says what the job IS. */
    (hasScope(show) ? '<div class="g"><span class="k">Scope</span>' + scopeChip(show) + '</div>' : '') +
    /* F5 — the commercial fact, next to the operational ones */
    '<div class="g"><span class="k">Commercial</span>' + confirmChip(show) + '</div>' +
    '<div class="g"><span class="k">Steps done</span><span class="mono">' + r.done + ' / ' + r.total + ' (' + r.pct + '%)</span></div>' +
    '<div class="g"><span class="k">Blocked</span><span class="mono" style="color:' + (r.blocked.length ? 'var(--crit)' : 'var(--text-2)') + '">' + r.blocked.length + '</span></div>' +
    '<div class="g"><span class="k">At risk</span><span class="mono" style="color:' + (r.risk.length ? 'var(--warn)' : 'var(--text-2)') + '">' + r.risk.length + '</span></div>' +
    '<div class="g"><span class="k">Biggest risk</span><span style="color:var(--crit);font-weight:600;text-align:right;max-width:150px">' + (biggest ? esc(biggest.step.title) : '—') + '</span></div>' +
    '<div class="g"><span class="k">Next milestone</span><span class="mono">' + esc(nx.v) + '</span></div>' +
    '<div class="g"><span class="k">Billed to</span><span class="mono">' + esc(show.job ? show.job.qb_job_number : '—') + '</span>' + dealTag(show.job) + '</div>' +
    burnRow +
    '</div>';

  var summary = show.summary || show.project.summary || '';
  var source = show.source || show.project.source || '';

  return health + poRiskStrip(show) + '<div class="ov">' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
    '<div class="panel"><h3>Status by lane · ' + esc(typeLabel(show.type)) + '</h3><div class="lane-status">' + laneStat + '</div></div>' +
    lateList +
    '<div class="panel"><h3>Next up</h3><div class="next-list">' + next + '</div></div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
    '<div class="panel summary"><div class="sig">' + icon('bolt') + 'AI summary</div><p>' + esc(summary) + '</p><div class="src">' + esc(source) + '</div></div>' +
    photoStrip(show) +
    recapOverviewLine(show) +
    closeoutPanel(show) +
    '<div class="panel"><h3>At a glance</h3>' + glance + '</div>' +
    /* the show's conversation layer — anchored notes (notes pass) */
    notesPanel('show', show.id, { collapse: 2 }) +
    '</div>' +
    '</div>';
}

/* ============================================================ schedule --
   The onsite call sheet, live: day-by-day schedule timeline · crew with
   flights + hotels · phone-ready POCs · "my day" filter · print path.
   Phone-first: everything here must survive a 390px screen at 6am.
   ========================================================================== */
var SCHED_UI = { day: {}, my: false };

function schedSelectedDay(show, days) {
  var pick = SCHED_UI.day[show.id];
  if (pick && days.indexOf(pick) >= 0) return pick;
  if (days.indexOf(TODAY_ISO) >= 0) return TODAY_ISO;
  var up = days.filter(function (d) { return d >= TODAY_ISO; });
  return up[0] || days[days.length - 1];
}
function schedWhoChips(item) {
  var w = item.who;
  if (w === 'all' || w == null) return '<span class="sched-who">' + inlineIcon('users') + 'All crew</span>';
  if (Object.prototype.toString.call(w) === '[object Array]') {
    return w.map(function (u) {
      return ROSTER[u] ? '<span class="sched-who">' + av(u) + esc(firstName(u)) + '</span>' : '<span class="sched-who">' + esc(u) + '</span>';
    }).join('');
  }
  return '<span class="sched-who">' + inlineIcon('bolt') + esc(ROLES[w] ? ROLES[w].name + 's' : String(w)) + '</span>';
}
function schedItemHTML(item, editable, nowHM, isToday) {
  var k = SCHED_KINDS[item.kind] || SCHED_KINDS.work;
  var past = isToday && nowHM && item.start_time < nowHM;
  var edit = editable
    ? '<button class="iconbtn sched-edit" title="Edit item" ' + act('schedEdit', item.id) + '>' + icon('pencil') + '</button>' : '';
  return '<div class="sched-item' + (past ? ' past' : '') + '">' +
    '<div class="sched-time">' + esc(fmtHM(item.start_time)) + (item.end_time ? '<span>–' + esc(fmtHM(item.end_time)) + '</span>' : '') + '</div>' +
    '<span class="sched-dot" style="background:' + esc(k.color) + '" title="' + esc(k.label) + '"></span>' +
    '<div class="sched-body"><div class="sched-tt"><b>' + esc(item.title) + '</b>' + edit + '</div>' +
    (item.detail ? '<div class="sched-detail">' + esc(item.detail) + '</div>' : '') +
    '<div class="sched-meta">' + schedWhoChips(item) +
    (item.location ? '<span class="sched-loc">' + inlineIcon('pin') + esc(item.location) + '</span>' : '') +
    '</div></div></div>';
}
function schedPocCard(kind, name, sub, phone) {
  return '<div class="poc-card"><div class="poc-t"><span>' + esc(kind) + '</span><b>' + esc(name) + '</b>' +
    (sub ? '<i>' + esc(sub) + '</i>' : '') + '</div>' +
    (phone ? '<a class="btn sm poc-tel" href="' + esc(telHref(phone)) + '">' + icon('phone') + esc(phone) + '</a>' : '') + '</div>';
}
function schedCrewCard(c, show) {
  var t = c.travel;
  var isMe = c.username === ME;
  var head = '<div class="cc-h">' +
    (c.username ? av(c.username) : '<span class="avatar" style="background:var(--surface-3);color:var(--text-2)">' + esc((c.name || '?').split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase()) + '</span>') +
    '<div class="cc-n"><b>' + esc(crewName(c)) + (isMe ? ' <span class="mini auto">you</span>' : '') + '</b><span>' + esc(c.role_on_site) + (c.username ? '' : ' · local') + '</span></div>' +
    '<span class="cc-call" title="Call time">' + inlineIcon('clock') + esc(fmtHM(c.call_time)) + '</span></div>';
  var rows = '';
  if (t) {
    rows += '<div class="cc-row">' + inlineIcon('send') + '<div><b>In</b> ' + esc(legLine(t.out)) +
      (t.out && t.out.record_locator ? ' <span class="mono cc-conf">' + esc(t.out.record_locator) + '</span>' : '') + '</div></div>';
    rows += '<div class="cc-row">' + inlineIcon('send') + '<div><b>Out</b> ' + esc(legLine(t.back)) +
      (t.back && t.back.record_locator ? ' <span class="mono cc-conf">' + esc(t.back.record_locator) + '</span>' : '') + '</div></div>';
    if (t.hotel) rows += '<div class="cc-row">' + inlineIcon('moon') + '<div><b>' + esc(t.hotel.name) + '</b> · conf <span class="mono cc-conf">' + esc(t.hotel.conf) + '</span>' +
      '<span class="cc-sub">' + esc(t.hotel.address) + ' · ' + esc(fmtDate(t.hotel.checkin)) + '–' + esc(fmtDate(t.hotel.checkout)) + '</span></div></div>';
  } else {
    rows += '<div class="cc-row cc-localrow">' + inlineIcon('pin') + '<div>Local crew — no travel booked</div></div>';
  }
  var ph = crewPhone(c);
  if (ph) rows += '<div class="cc-row"><a class="cc-tel" href="' + esc(telHref(ph)) + '">' + inlineIcon('phone') + esc(ph) + '</a></div>';
  /* B1. The edit affordance goes where the data is, the same way schedItemHTML
     carries one. `k` carries the show id because the crew route is keyed on the
     ASSIGNMENT id and the dialog needs both. */
  var pen = canEditSchedule(show)
    ? '<button class="iconbtn sched-edit" title="Edit this crew line" ' +
      act('crewEdit', c.id, String(show.id)) + '>' + icon('pencil') + '</button>'
    : '';
  return '<div class="crewcard' + (isMe ? ' me' : '') + '">' + head + pen + rows + '</div>';
}

/* B1 · THE CREW PANEL — the single most load-bearing affordance in this pass.
   `crew_assignments` had exactly ONE write site in the repository and no way to
   reach it, so in production the call sheet's crew cards, the travel panel, the
   tech-report obligation, closeout's "every report filed" condition and the
   push's staff list were all permanently empty — and every one of them had
   passing tests. This panel renders whether or not there is crew, because the
   thing missing was never the table; it was the button.

   `only` narrows the cards (the "my day" filter) without narrowing the counts. */
function crewPanelFor(show, editable, only) {
  var crew = crewForShow(show.id);
  var shown = only || crew;
  var withLogin = crew.filter(function (c) { return !!c.username; }).length;
  var locals = crew.length - withLogin;
  return '<div class="panel" style="margin-top:16px"><h3>Crew on site' +
    (crew.length ? ' · ' + shown.length + (only ? ' of ' + crew.length : '') : '') +
    '<span style="flex:1"></span>' +
    (editable ? '<button class="btn sm ghost" ' + act('crewAdd', show.id) + '>' + icon('plus') +
      'Add crew</button>' : '') + '</h3>' +
    (crew.length
      ? '<div class="sched-crew">' + shown.map(function (c) { return schedCrewCard(c, show); }).join('') + '</div>' +
        '<div class="perm-note">' + inlineIcon('send') + ' ' + withLogin + ' with a login' +
        (locals ? ' · ' + locals + ' local hire' + (locals === 1 ? '' : 's') : '') +
        '. Only the ones with a login owe a show report after strike, and only they hear about changes ' +
        'to this show — a local hire has the printed call sheet and nothing else, which is exactly why ' +
        'their phone number is on it.</div>'
      : '<div class="empty" style="padding:22px;line-height:1.6">Nobody is on this show yet.<br>' +
        '<span style="color:var(--muted);font-size:12px">Crew is what fills the call sheet, the travel ' +
        'panel and the show reports owed after strike — and it is what the scheduler push sends as staff. ' +
        'Add someone from the roster, or a local hire by name and phone.</span></div>') +
    '</div>';
}

function tabSchedule(show) {
  var editable = canEditSchedule(show);
  var items = scheduleForShow(show.id), days = scheduleDays(show.id), crew = crewForShow(show.id);
  var poc = ROSTER[show.on_site_poc] || null;
  var title = showLabel(show);

  /* ---- empty state — most shows start here ------------------------------- */
  if (!items.length) {
    return '<div class="gear-empty">' + icon('cal') +
      '<div style="font-weight:600;font-size:14px">No schedule yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:460px;margin-left:auto;margin-right:auto;line-height:1.5">The day-by-day call sheet for onsite crew — load-in times, everyone’s flights and hotels, POCs and the schedule. Generate a starting point from the ' + esc(typeLabel(show.type)) + ' template, or build it by hand.</div>' +
      '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px;flex-wrap:wrap">' +
      '<button class="btn primary" ' + toastAttrs('Generate from template', 'Seeds load-in / show / strike days from the ' + typeLabel(show.type) + ' template — modeled') + '>' + icon('bolt') + 'Generate from template</button>' +
      (editable ? '<button class="btn ghost" ' + act('schedAdd', show.id) + '>' + icon('plus') + 'Add first item</button>' : '') +
      (editable ? '<button class="btn ghost" ' + act('editCallSheet', show.id) + '>' + icon('pencil') + 'Set the call sheet header</button>' : '') +
      '</div>' +
      /* B1. A show with no schedule can still have crew — and usually gets crew
         FIRST. The empty state used to be a dead end for the one thing that
         matters most on this tab. The rolodex links render here too, for the
         same reason. */
      crewPanelFor(show, editable) + showContactsPanel(show, editable) + '</div>';
  }

  var day = schedSelectedDay(show, days);
  var isToday = day === TODAY_ISO;
  var nowHM = null;
  if (isToday) { var nd = new Date(); nowHM = (nd.getHours() < 10 ? '0' : '') + nd.getHours() + ':' + (nd.getMinutes() < 10 ? '0' : '') + nd.getMinutes(); }

  /* ---- header strip: the four times + radio + dress ---------------------- */
  var strip = '<div class="gtotals sched-strip">' +
    [['Load-in', show.load_in_time], ['Doors', show.doors_time], ['Show', show.event_time], ['Strike', show.strike_time]].map(function (t) {
      return '<div class="gt"><div class="k">' + esc(t[0]) + '</div><div class="v mono">' + esc(fmtHM(t[1])) + '</div></div>';
    }).join('') +
    (show.radio_channel ? '<div class="gt"><div class="k">Radio</div><div class="v" style="font-size:15px;padding-top:5px">' + esc(show.radio_channel) + '</div></div>' : '') +
    (show.dress_code ? '<div class="gt"><div class="k">Dress</div><div class="v" style="font-size:13px;padding-top:7px;font-family:var(--font-body);font-weight:600">' + esc(show.dress_code) + '</div></div>' : '') +
    '</div>';
  var venueLine = '<div class="hint" style="margin:-6px 0 14px">' + icon('pin') + '<span><b>' + esc(show.venue) + '</b>' +
    (show.venue_address ? ' — ' + esc(show.venue_address) : '') +
    (show.parking_notes ? ' · ' + esc(show.parking_notes) : '') +
    /* F4 — the call sheet header carries the scope line: the crew arriving at
       6am should be able to read what they are putting up without opening
       another tab. */
    (hasScope(show) ? '</span></div><div class="hint sched-scope" style="margin:-8px 0 14px">' +
      icon('ruler') + '<span><b>' + esc(scopeLine(show)) + '</b> — what we are delivering' : '') +
    '</span></div>';

  /* ---- day chips + my-day + actions -------------------------------------- */
  var chips = days.map(function (d) {
    var tag = schedDayTag(show, d);
    return '<button class="daychip' + (d === day ? ' on' : '') + (d === TODAY_ISO ? ' today' : '') + '" ' + act('schedDay', show.id, d) + '>' +
      '<b>' + esc(fmtDayDate(d)) + '</b>' + (tag ? '<span>' + esc(tag) + '</span>' : '') +
      (d === TODAY_ISO ? '<span class="td-dot"></span>' : '') + '</button>';
  }).join('');
  var bar = '<div class="sched-bar">' +
    '<div class="daychips">' + chips + '</div>' +
    '<span style="flex:1"></span>' +
    /* B2. Ten fields rendered on this strip, on the printed call sheet and in
       the push payload, and written by nothing until now. */
    (editable ? '<button class="btn sm ghost" ' + act('editCallSheet', show.id) + ' title="Times, address, parking, radio, dress, POCs">' +
      icon('pencil') + 'Call sheet</button>' : '') +
    '<button class="btn sm ' + (SCHED_UI.my ? 'primary' : 'ghost') + '" ' + act('schedMyDay', show.id) + ' title="Just my items + my travel">' + icon('check') + 'My day</button>' +
    (editable ? '<button class="btn sm ghost" ' + act('schedAdd', show.id) + '>' + icon('plus') + 'Add item</button>' : '') +
    '<button class="btn sm ghost" ' + act('schedPreview', show.id) + '>' + icon('eye') + 'Sheet</button>' +
    '<button class="btn sm primary" ' + act('schedPrint', show.id) + '>' + icon('print') + 'Print call sheet</button>' +
    '</div>';

  /* ---- timeline for the selected day ------------------------------------- */
  var dayItems = items.filter(function (it) { return it.day === day; });
  if (SCHED_UI.my) dayItems = dayItems.filter(function (it) { return schedItemFor(it, ME); });
  var tl = '';
  var nowPlaced = !isToday;
  dayItems.forEach(function (it) {
    if (!nowPlaced && it.start_time >= nowHM) {
      tl += '<div class="sched-now"><span>Now · ' + esc(fmtHM(nowHM)) + '</span></div>';
      nowPlaced = true;
    }
    tl += schedItemHTML(it, editable, nowHM, isToday);
  });
  if (!nowPlaced) tl += '<div class="sched-now"><span>Now · ' + esc(fmtHM(nowHM)) + '</span></div>';
  if (!dayItems.length) tl = '<div class="empty" style="padding:24px">' + (SCHED_UI.my ? 'Nothing on your sheet for this day — you’re clear.' : 'Nothing scheduled this day yet.') + '</div>';
  var legend = SCHED_KIND_ORDER.map(function (k) {
    return '<span class="rl"><b style="background:' + esc(SCHED_KINDS[k].color) + '"></b>' + esc(SCHED_KINDS[k].label) + '</span>';
  }).join('');
  var tag = schedDayTag(show, day);
  var tlPanel = '<div class="panel"><h3>' + esc(fmtDayDate(day)) + (tag ? ' · ' + esc(tag) : '') +
    (SCHED_UI.my ? ' · <span style="color:var(--accent)">my day</span>' : '') + '</h3>' +
    '<div class="sched-list">' + tl + '</div>' +
    '<div class="rag-legend" style="margin-top:14px">' + legend + '</div></div>';

  /* ---- right rail: my call · POCs · weather ------------------------------ */
  var mine = crewFor(show.id, ME);
  var myCard = mine
    ? '<div class="panel sched-me"><h3>Your day</h3><div class="glance">' +
      '<div class="g"><span class="k">Call time</span><span class="mono" style="color:var(--accent);font-weight:600">' + esc(fmtHM(mine.call_time)) + '</span></div>' +
      '<div class="g"><span class="k">Role on site</span><span style="font-weight:600">' + esc(mine.role_on_site) + '</span></div>' +
      (mine.travel ? '<div class="g"><span class="k">In</span><span class="mono" style="font-size:11.5px;text-align:right">' + esc(legLine(mine.travel.out)) + '</span></div>' +
        '<div class="g"><span class="k">Out</span><span class="mono" style="font-size:11.5px;text-align:right">' + esc(legLine(mine.travel.back)) + '</span></div>' +
        (mine.travel.hotel ? '<div class="g"><span class="k">Hotel</span><span style="font-size:12px;text-align:right">' + esc(mine.travel.hotel.name) + ' · <span class="mono">' + esc(mine.travel.hotel.conf) + '</span></span></div>' : '')
        : '<div class="g"><span class="k">Travel</span><span style="color:var(--muted)">local — no travel</span></div>') +
      '</div></div>'
    : '';
  var pocPanel = '<div class="panel"><h3>Points of contact</h3><div class="poc-list">' +
    (poc ? schedPocCard('On-site lead', poc.name, poc.title, poc.phone) : '') +
    (show.venue_poc ? schedPocCard('Venue', show.venue_poc.name, show.venue_poc.title, show.venue_poc.phone) : '') +
    (show.client_poc ? schedPocCard('Client', show.client_poc.name, show.client_poc.title, show.client_poc.phone) : '') +
    '</div><div class="perm-note">' + inlineIcon('phone') + ' Tap a number to call — this panel is the 6am problem-solver.</div></div>' +
    /* the rolodex's structured half — the POC cards above stay free text and
       print on the sheet; these links are what let a contact's own card answer
       "which shows was I on" */
    showContactsPanel(show, editable);
  var weather = '<div class="hint" style="margin-top:0">' + icon('sun') + '<span><b>Weather</b> — forecast lands with the live backend; check radar before an outdoor load-in.</span></div>';

  /* ---- crew grid ----------------------------------------------------------
     B1. This panel used to render only when `crew.length` — which, since
     crew_assignments had exactly one write site in the repository and no way to
     reach it, meant NEVER in production. It now always renders, because the
     thing a PM needs most on this tab is the button that puts a person on the
     show. Everything downstream — the call sheet, travel, the tech-report
     obligation, closeout integrity, the push's staff list — hangs off it. */
  var crewPanel = crewPanelFor(show, editable, SCHED_UI.my && mine ? [mine] : null);

  return strip + venueLine + bar +
    '<div class="ov sched-ov">' + tlPanel +
    '<div style="display:flex;flex-direction:column;gap:16px">' + myCard + pocPanel + weather + '</div></div>' +
    crewPanel;
}

/* -------------------------------------------------------------- pipeline -- */
var ATTACH_LANES = { deliverables: 1, proof: 1, approval: 1, design: 1, production: 1, tracking: 1 };
function taskCard(lane, s) {
  var isDone = normStatus(s.status) === 'done';
  var flag = s.auto_source && s.auto_source !== 'none' ? 'auto' : (s.depends_on ? 'dep' : '');
  var mini = flag ? '<span class="mini ' + flag + '">' + (flag === 'auto' ? 'auto-gen' : 'depends') + '</span>' : '';
  var lateCls = (normStatus(s.status) === 'blocked' || s.risk || isOverdue(s)) ? 'late' : '';
  var pill = isDone ? '' : (s.risk ? '<span class="pill warn"><span class="dot"></span>At risk</span>' : statusPill(s.status));
  var attach = ATTACH_LANES[lane.key] ? '<button class="attachbtn" title="Attach a file to this step" ' + act('attachStep', s.id) + '>' + icon('link') + '</button>' : '';
  /* anchored thread on the step (notes pass): count chip -> inline expand */
  var nN = noteCount('step', s.id);
  var noteBtn = '<button class="cchip' + (nN ? ' has' : '') + '" title="' + (nN ? nN + ' note' + (nN === 1 ? '' : 's') + ' on this step' : 'Add a note to this step') + '" ' +
    act('noteToggleStep', s.id) + '>' + icon('chat') + (nN ? '<span>' + nN + '</span>' : '') + '</button>';
  var thread = NOTES_UI.openSteps[s.id]
    ? '<div class="task-thread">' + notesThread('step', s.id) + '</div>' : '';
  /* D3/B4. The only status control anywhere was the done<->todo checkbox, so
     nothing in the product could set `blocked` — the input the RAG derivation
     treats as crit, the thing the Overview's "biggest risk" reads, and the
     field signal the whole health model is built on. The person standing in
     front of the problem could not report it. A tech who OWNS the step may set
     it (the server's canUpdateStepStatus admits them); a pm+ on the project may
     also re-date, re-lane and re-title it. */
  var canStat = SHOW_FOR_TASKS && (canEditFolderOf(SHOW_FOR_TASKS) || s.owner === ME);
  var canEditTask = SHOW_FOR_TASKS && canEditFolderOf(SHOW_FOR_TASKS);
  var stNow = normStatus(s.status);
  var statBtns = canStat
    ? (stNow === 'blocked'
        ? '<button class="cchip has" title="Unblock — back to in progress" ' +
          act('stepStatus', s.id, 'in_progress') + '>' + icon('lock') + '<span>blocked</span></button>'
        : '<button class="cchip" title="Mark blocked — tells the show owner and the folder owner" ' +
          act('stepStatus', s.id, 'blocked') + '>' + icon('lock') + '</button>')
    : '';
  var editBtn = canEditTask
    ? '<button class="cchip" title="Edit · re-date · re-lane · re-assign" ' +
      act('editTask', s.id, String(SHOW_FOR_TASKS.id)) + '>' + icon('pencil') + '</button>'
    : '';
  return '<div class="task ' + (isDone ? 'done' : '') + '">' +
    '<div class="tt"><div class="chk" ' + act('toggleStep', s.id) + '>' + icon('check') + '</div><div class="txt">' + esc(s.title) + '</div></div>' +
    '<div class="tm">' + pill + '<span class="due ' + lateCls + '">' + esc(fmtDate(s.due_date)) + '</span>' + mini + noteBtn + attach + statBtns + editBtn + '<span style="flex:1"></span>' + assignableOwner(s) +
    '</div>' + thread + '</div>';
}
/* taskCard() is called without the show in scope. Rather than thread it through
   every call site, the board publishes it the same way SCHED_UI / PH_UI /
   RECAP_UI publish their per-tab state. */
var SHOW_FOR_TASKS = null;
function tabPipeline(show) {
  SHOW_FOR_TASKS = show;
  var editable = canEditFolderOf(show);
  var lanes = laneSteps(show).map(function (x) {
    var done = x.steps.filter(function (s) { return normStatus(s.status) === 'done'; }).length;
    var body = x.steps.length ? x.steps.map(function (s) { return taskCard(x.lane, s); }).join('') : '<div class="lane-empty">no steps yet</div>';
    return '<div class="lane"><div class="lane-h"><span class="ld" style="background:' + esc(x.lane.color) + '"></span><b>' + esc(x.lane.label) + '</b><span class="frac">' + done + '/' + x.steps.length + '</span></div><div class="lane-b">' + body + '</div></div>';
  }).join('');
  /* B3. Every step in the system came from a template; a PM could not add
     "chase the venue about the rigging plot". */
  var bar = '<div class="sched-bar" style="margin-bottom:12px"><span style="flex:1"></span>' +
    (editable ? '<button class="btn sm primary" ' + act('addTask', show.id) + '>' + icon('plus') +
      'Add task</button>' : '') + '</div>';
  /* An EMPTY pipeline used to be a dead end with bad directions: the only
     advice anywhere was a season-dashboard toast pointing at a per-show seed
     control that did not exist. This is that control. The template seeds the
     full T-minus lane set off the event date; Add task stays the one-at-a-time
     alternative beside it. */
  var seedBlock = '';
  if (editable && !allSteps(show).length) {
    seedBlock = '<div class="gear-empty" style="margin-bottom:14px">' + icon('layers') +
      '<div style="font-weight:600;font-size:14px">No pipeline on this show yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:470px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      'Seed the ' + esc(typeDef(show.type).label) + ' template — every lane’s T-minus steps, back-scheduled off ' +
      (show.event_date ? 'the event date' : 'the event date once one is set') + ' — or add tasks one at a time.</div>' +
      '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px;flex-wrap:wrap">' +
      '<button class="btn primary" ' + act('seedPipeline', show.id) + '>' + icon('bolt') + 'Seed pipeline</button>' +
      '<button class="btn ghost" ' + act('addTask', show.id) + '>' + icon('plus') + 'Add task</button></div></div>';
  }
  return seedBlock + bar + '<div class="lanes">' + lanes + '</div>';
}

/* --------------------------------------------------- specs & chain tab ---- */
function chainStrip(show) {
  var chain = show.chain;
  var live = typeof SR !== 'undefined' && SR.isApi();
  var nodes = [{ k: 'content', cx: '.e360', cn: 'Content spec', tool: 'Spec Sheet Gen' },
    { k: 'cabling', cx: '.nsf', cn: 'Data cabling', tool: 'NovaSpec' },
    { k: 'power', cx: '.pcfg', cn: 'Power', tool: 'PowerSpec' },
    { k: 'pull', cx: 'pull sheet', cn: 'Flex gear list', tool: 'Flex' }];
  var html = nodes.map(function (nd, i) {
    var n = chain[nd.k], up = CHAIN_UP[nd.k], upgen = up ? chain[up].gen : true, stale = isStale(chain, nd.k);
    var cls = !n.gen ? 'ungen' : (stale || n.outdated ? 'stale' : '');
    /* FIX (was '<span class="cs">awaiting '+st[up]+'</span>' -> [object Object]) */
    var status = !n.gen
      ? (upgen ? '<span class="cs">ready to generate</span>' : '<span class="cs">awaiting ' + esc(CHAIN_LABEL[up]) + '</span>')
      : stale
        ? '<span class="stale-chip">' + icon('alert') + 'stale · built vs rev ' + n.derivedRev + ', upstream ' + chain[up].rev + '</span>'
        : '<span class="fresh-chip">in sync · rev ' + n.rev + '</span>';
    /* the lifecycle flag, beside (not instead of) the derived staleness: a pm
       STATING "the design changed" and the chain COMPUTING "built against an
       old parent" are different facts, and a node can carry both. */
    if (n.gen && n.outdated) {
      status += ' <span class="stale-chip" title="' +
        esc('Flagged by ' + (firstName(n.outdatedBy) || n.outdatedBy || 'a pm') +
            (n.outdatedNote ? ' — ' + n.outdatedNote : '') +
            '. The spec stays bound and viewable; binding a replacement clears this.') + '">' +
        icon('alert') + 'OUTDATED — new spec pending</span>';
    }
    var meta = n.gen ? ('v' + n.rev + ' · ' + firstName(n.by) + ' · ' + fmtDate(n.when)) : (upgen ? 'not generated' : 'blocked upstream');
    var btns;
    if (nd.k === 'pull') {
      btns = '<button class="btn sm ghost" ' + act('gotoTab', null, 'gear') + '>' + icon('box') + (n.gen ? 'Gear tab' : 'Pull in Gear') + '</button>';
    } else if (live) {
      /* API MODE: Showrunner does not author specs. The three desktop tools do,
         and they push a real bundle into the ?bind-spec=1 popup. Offering a
         "Generate" button here is what filed a fabricated .e360 against a real
         job on 2026-08-27 — so the button is gone, not merely discouraged. */
      btns = n.gen
        ? '<button class="btn sm ghost" ' + act('openChainFile', show.id, nd.k) + '>' + icon('eye') + 'View</button>'
        : '<span class="cs">bind from ' + esc(nd.tool) + '</span>';
    } else if (!n.gen) {
      btns = upgen ? '<button class="btn sm primary" ' + act('specGen', show.id, nd.k) + '>' + icon('bolt') + 'Generate</button>' : '<span class="cs">generate upstream first</span>';
    } else {
      btns = '<button class="btn sm ' + (stale ? 'primary' : 'ghost') + '" ' + act('specGen', show.id, nd.k) + '>' + icon('refresh') + (stale ? 'Regenerate' : 'Regen') + '</button>' +
        '<button class="btn sm ghost" ' + act('openChainFile', show.id, nd.k) + '>' + icon('eye') + 'View</button>';
    }
    /* the manual lifecycle — pm+ on a folder they may edit, spec nodes only.
       The pull node's lifecycle IS the Flex link on the gear tab; a second
       door here would be the same room with a different lock. */
    if (nd.k !== 'pull' && n.gen && canEditFolderOf(show)) {
      btns += n.outdated
        ? '<button class="btn sm ghost" ' + act('specOutdateClear', show.id, nd.k) +
          ' title="Withdraw the outdated flag — the spec reads as current again">' + icon('refresh') + 'Un-flag</button>'
        : '<button class="btn sm ghost" ' + act('specOutdate', show.id, nd.k) +
          ' title="The design changed and nothing new is bound yet — mark the record known-stale">' + icon('alert') + 'Outdated</button>';
      btns += '<button class="btn sm ghost" ' + act('specUnbind', show.id, nd.k) +
        ' title="Detach from the show — the file stays in Files, every version stays in Spec history">' + icon('x') + 'Unbind</button>';
    }
    var arrow = i < nodes.length - 1 ? '<div class="carrow">' + icon('chevR') + '</div>' : '';
    return '<div class="cnode ' + cls + '"><div class="ct"><span class="cx">' + esc(nd.cx) + '</span><span class="cn">' + esc(nd.cn) + '</span></div>' +
      '<div class="cs">' + esc(nd.tool) + ' · ' + esc(meta) + '</div><div>' + status + '</div><div class="cbtns">' + btns + '</div></div>' + arrow;
  }).join('');
  return '<div class="chain">' + html + '</div>';
}
function tabSpecs(show) {
  var stale = chainAnyStale(show.chain);
  var live = typeof SR !== 'undefined' && SR.isApi();
  var head = live
    ? '<div class="callout"><div class="ci">' + icon('layers') + '</div><div><b>Bind a spec from the tool that made it</b>' +
      '<p>Showrunner stores specs; it does not author them. Open the drawing in <b>E360 Spec Sheet Gen</b>, <b>NovaSpec</b> or <b>PowerSpec</b> and bind from there — the tool pushes its real render bundle into this folder and the node below fills in. Nothing on this tab creates a file on its own.</p></div></div>'
    : '<div class="callout"><div class="ci">' + icon('layers') + '</div><div><b>Generate a spec, and it binds to this folder</b>' +
      '<p>The three generators produce a <b>derivation chain</b>: content <code>.e360</code> derives cabling <code>.nsf</code>, which derives power <code>.pcfg</code>, which derives the Flex <b>pull sheet</b>. Each generated spec caches a render bundle to the DB (viewable + printable by anyone) with the source file on the NAS. <b>Demo — the contents are generated locally.</b></p></div></div>';
  /* the lifecycle banner: a pm STATED the design changed. Louder than a
     checker question (it is a decision, not a divergence) and quieter than
     stale-crit (nothing is broken — the record is just known-old). */
  var outdatedNodes = ['content', 'cabling', 'power'].filter(function (k) {
    return show.chain[k] && show.chain[k].gen && show.chain[k].outdated; });
  return head +
    (outdatedNodes.length ? '<div class="hint" style="margin:-6px 0 16px;color:var(--warn)">' + icon('alert') +
      '<b>Flagged outdated</b> — ' + esc(outdatedNodes.map(function (k) { return CHAIN_LABEL[k]; }).join(', ')) +
      ' ' + (outdatedNodes.length === 1 ? 'is' : 'are') + ' marked as no longer matching the design. ' +
      'The record stands and stays viewable; binding a replacement clears the flag.</div>' : '') +
    (stale ? '<div class="hint" style="margin:-6px 0 16px;color:var(--crit)">' + icon('alert') + '<b>Stale downstream specs</b> — an upstream spec was regenerated. Re-generate the flagged nodes so cabling / power / pull sheet match the current content revision.</div>' : '') +
    '<div class="panel" style="margin-bottom:16px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
    '<h3 style="flex:1">Derivation chain — content → cabling → power → pull sheet</h3>' +
    /* the versions door. Binding a new spec retires the old one automatically;
       this is where every retired one stays reachable. */
    '<button class="btn sm ghost" ' + act('specHistory', show.id) + ' title="Every version ever bound — superseded and unbound ones included, all viewable">' +
      icon('layers') + 'Spec history</button></div>' + chainStrip(show) +
    '<div class="perm-note">' + inlineIcon('bolt') + ' Regenerating any upstream spec bumps its revision, which flags every downstream artifact <b>stale</b> until re-generated. Binding a new spec <b>supersedes</b> the old one automatically — superseded versions are kept, never deleted, and live under Spec history.</div></div>' +
    '<div class="panel"><h3>Two-tier storage</h3>' + twoTier(show) + '</div>';
}

/* ------------------------------------------------------------- gear tab --- */
function tabGear(show) {
  var g = show.gear, chain = show.chain;
  var live = typeof SR !== 'undefined' && SR.isApi();
  /* A link created by the old modeled path is NOT a link. The server flags it;
     say so here rather than offering a "View in Flex" that leads nowhere. */
  var fabricated = !!g.fabricated;
  var realLink = !!(g.linked && g.elementId && !fabricated);

  var linkState = fabricated
    ? '<b>Not really linked</b><span>element <span class="mono">' + esc(g.elementId || '') + '</span> was generated by the prototype and exists in no Flex tenant — create the real folder to replace it</span>'
    : g.linked
      ? '<b>Linked · Flex Event Folder</b><span>element <span class="mono">' + esc(g.elementId || '') + '</span> · ' + esc(g.pulled ? ('gear list ' + g.docNumber + ' attached') : 'no gear list attached') + '</span>'
      : '<b>Not linked to Flex</b><span>Create or link an Event Folder, then pull its Pull Sheet + Manifest</span>';

  /* THE ANCHOR. A real <a target="_blank"> to the id Flex returned, built from
     the server-derived deep link — never from a string glued together here. */
  var viewBtn = !realLink ? ''
    : g.deepLink
      ? '<a class="btn ghost" href="' + esc(g.deepLink) + '" target="_blank" rel="noopener noreferrer">' + icon('link') + 'View in Flex</a>'
      : live
        ? '<button class="btn ghost" ' + toastAttrs('No Flex address to open', 'This server has no FLEX_BASE_URL, so there is nowhere to send you.') + '>' + icon('link') + 'View in Flex</button>'
        : '<button class="btn ghost" ' + toastAttrs('Demo — there is nothing to open', 'This element id was generated locally and exists in no Flex tenant.') + '>' + icon('link') + 'View in Flex</button>';

  /* Tom's toggle: default ON, remembered for the session. */
  var mkOn = typeof FLEX_CREATE_CONTACTS === 'undefined' ? true : FLEX_CREATE_CONTACTS;
  var contactToggle = '<button class="btn sm ghost" ' + act('flexToggleContacts', show.id) + ' title="Client and venue are contacts in Flex. With this on, one that has no exact match is created and linked; with it off the field is left blank.">' +
    icon(mkOn ? 'check' : 'x') + (mkOn ? 'Create missing contacts' : 'Skip missing contacts') + '</button>';

  var sheetState = (typeof FLEX_SHEETS !== 'undefined' && FLEX_SHEETS[show.id]) || null;
  var loadLabel = live
    ? ((sheetState && sheetState.sheet) ? 'Re-read from Flex' : 'Load from Flex')
    : (g.pulled ? 'Re-pull from Flex' : 'Pull from Flex');
  var actions = realLink
    ? viewBtn + '<button class="btn primary" ' + act('flexPull', show.id) + '>' + icon('download') + loadLabel + '</button>'
    : contactToggle +
      '<button class="btn ghost" ' + act('flexLink', show.id) + '>' + icon('link') + 'Link existing</button>' +
      '<button class="btn primary" ' + act('flexCreate', show.id) + '>' + icon('folder') + (fabricated ? 'Create the real folder' : 'Create Flex Folder') + '</button>';

  var flexbar = '<div class="flexbar"><div class="fi">' + icon('box') + '</div><div class="fx">' + linkState + '</div><div class="fa">' + actions + '</div></div>';
  var note = live
    ? '<div class="hint" style="margin:-4px 0 14px">' + icon('bolt') + '<b>Create and read are both live.</b> Create POSTs a real Event Folder to <span class="mono">/f5/api/element</span> (auth <span class="mono">X-Auth-Token</span>, UTC-<span class="mono">Z</span> dates) and stores the id Flex returns; doors / show / strike times ride in the folder’s <b>notes</b>, since its form has no field for a clock time. <b>Load from Flex</b> reads the folder’s equipment lists and one list’s real line items — every time, live. <b>Nothing on this tab is cached and nothing here writes to Flex.</b></div>'
    : '<div class="hint" style="margin:-4px 0 14px">' + icon('bolt') + '<b>Demo — nothing here reaches Flex.</b> Element ids, gear lists and flight cases on this screen are generated locally so the screens have something to show. Against a real server the same buttons call <span class="mono">create-element</span> and read the real pull sheet.</div>';

  /* API MODE owns its own body. `pulled` is a demo flag over a demo kit; in API
     mode the gear on screen is whatever the last live read returned, or an
     honest statement that nothing has been read yet. */
  /* the look-back panel rides EVERY state of this tab, linked or not: the
     whole point of a banked snapshot is that it outlives the link, the list
     and Flex's own memory of the job. */
  var hist = gearHistPanel(show);

  if (live) {
    if (!realLink) {
      return flexbar + note + poGearStrip(show) + '<div class="gear-empty">' + icon('box') +
        '<div style="font-weight:600;font-size:14px">No Flex folder to read</div>' +
        '<div style="font-size:12.5px;margin-top:7px;max-width:460px;margin-left:auto;margin-right:auto;line-height:1.5">' +
        (fabricated
          ? 'This show carries an element id the prototype generated in a browser. It exists in no Flex tenant, so there is nothing to read. <b>Create the real folder</b> to replace it.'
          : 'Create the Event Folder — or link an existing one by its element id — and then <b>Load from Flex</b> will list the equipment lists inside it.') +
        '</div></div>' + hist;
    }
    return flexbar + note + poGearStrip(show) + flexSheetBody(show, sheetState) + hist;
  }

  if (!g.pulled) {
    return flexbar + note + poGearStrip(show) + '<div class="gear-empty">' + icon('box') + '<div style="font-weight:600;font-size:14px">No gear list pulled yet</div><div style="font-size:12.5px;margin-top:7px;max-width:440px;margin-left:auto;margin-right:auto;line-height:1.5">Once the Flex Event Folder is linked, <b>Pull from Flex</b> walks the folder tree, identifies the Pull Sheet + Manifest by definition ID, and caches them here — viewable and printable by anyone with folder access.</div></div>' + hist;
  }
  var vk = g.view === 'manifest' ? 'manifest' : 'pull';
  var toggle = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px"><div class="gear-toggle">' +
    '<button class="' + (g.view === 'pull-sheet' ? 'on' : '') + '" ' + act('gearView', show.id, 'pull-sheet') + '>' + icon('box') + 'Pull Sheet</button>' +
    '<button class="' + (g.view === 'manifest' ? 'on' : '') + '" ' + act('gearView', show.id, 'manifest') + '>' + icon('truck') + 'Manifest</button></div>' +
    '<span style="flex:1"></span>' +
    '<button class="btn sm ghost" ' + act('gearSnapSave', show.id) + ' title="Bank the sheet on screen as a dated record on this show">' + icon('download') + 'Save snapshot</button>' +
    '<button class="btn sm ghost" ' + act('openChainFile', show.id, vk) + '>' + icon('eye') + 'Open in Viewer</button>' +
    '<button class="btn sm primary" ' + act('printChainFile', show.id, vk) + '>' + icon('print') + 'Print</button></div>';
  var pd = chain.power.gen
    ? (isStale(chain, 'pull') ? '<span class="stale-chip">' + icon('alert') + 'stale vs .pcfg — re-pull</span>' : '<span class="fresh-chip">in sync with .pcfg</span>')
    : '<span class="cs">not yet derived from a .pcfg power spec</span>';
  var deriveLine = '<div class="perm-note" style="margin:0 0 12px">' + inlineIcon('server') + ' Gear count derives from the power layout — ' + pd + '</div>';
  var body = g.view === 'manifest' ? manifestBody(g) : pullBody(g);
  return flexbar + note + poGearStrip(show) + toggle + deriveLine + body + hist;
}

/* ── GEAR HISTORY — the banked snapshots (Tom, 2026-08-28) ──────────────────
   Renders from GEAR_HIST[showId] (app.js view state; the tab arms the load on
   first paint). A snapshot is the one thing on this tab that is STORAGE by
   design: the parsed sheet a human chose to keep, listed cheap (counts only)
   and opened read-only with its stored groups/lines. */
function gearHistPanel(show) {
  var st = (typeof GEAR_HIST !== 'undefined') ? GEAR_HIST[show.id] : null;
  if (!st) {
    /* first paint: arm the one load. gearHistLoad writes {loading:true}
       synchronously, so a re-render cannot arm it twice. */
    if (typeof gearHistLoad === 'function') gearHistLoad(show.id);
    st = { loading: true };
  }
  var head = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h3 style="flex:1">Gear history — banked snapshots</h3>' +
    '<span class="cs" style="font-size:11px">what actually went out, kept even after Flex moves on</span></div>';
  var body;
  if (st.loading) {
    body = '<div class="cs" style="padding:10px 2px">Reading the banked snapshots…</div>';
  } else if (st.open) {
    body = gearSnapshotDetail(show, st.open);
  } else if (st.error) {
    body = '<div class="hint" style="color:var(--crit)">' + icon('alert') + esc(st.error) + '</div>';
  } else if (!(st.list || []).length) {
    body = '<div class="cs" style="padding:10px 2px;line-height:1.5">No snapshots banked yet. ' +
      'Read a pull sheet or manifest and press <b>Save snapshot</b> — the parsed document is kept on this ' +
      'show as a dated record, so "what gear did we send last year" has an answer even after the Flex ' +
      'folder changes or archives.</div>';
  } else {
    body = st.list.map(function (g2) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid var(--border);flex-wrap:wrap">' +
        '<span class="fresh-chip" title="' + esc(g2.kind || 'kind unknown — labeled from the list name') + '">' + esc(g2.doc_label || 'Sheet') + '</span>' +
        '<span class="mono" style="font-size:11px">' + esc(g2.doc_number || '—') + '</span>' +
        '<span style="font-size:12.5px;font-weight:600">' + esc(g2.name || '') + '</span>' +
        '<span class="cs" style="font-size:11.5px">saved ' + esc(fmtDate(String(g2.created_at || '').slice(0, 10))) +
          ' · ' + esc(userName(g2.saved_by) || g2.saved_by || '—') + '</span>' +
        '<span style="flex:1"></span>' +
        '<span class="cs" style="font-family:var(--font-mono);font-size:11px">' +
          g2.lines_count + ' lines · ' + g2.units_count + ' units</span>' +
        '<button class="btn sm ghost" ' + act('gearSnapOpen', g2.id) + '>' + icon('eye') + 'Open</button>' +
        (canEditFolderOf(show)
          ? '<button class="btn sm ghost" ' + act('gearSnapDelete', g2.id) + ' title="Delete the banked record (plain confirm) — Flex is untouched">' + icon('trash') + '</button>'
          : '') +
        '</div>';
    }).join('');
  }
  return '<div class="panel" style="margin-top:16px">' + head + body + '</div>';
}
/* the read-only detail: the STORED groups/lines, rendered in the same visual
   language as the live sheet (.gtotals / .gcat / .gitem) because it is the
   same document — only its tense changed from "is" to "was". */
function gearSnapshotDetail(show, snap) {
  var s = snap.sheet || { groups: [], totals: { groups: 0, lines: 0, units: 0 } };
  var bar = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0">' +
    '<button class="btn sm ghost" ' + act('gearSnapBack', show.id) + '>' + icon('chevL') + 'All snapshots</button>' +
    '<b style="font-family:var(--font-display);font-size:14px">' + esc(snap.doc_label || 'Sheet') +
      (snap.doc_number ? ' · ' + esc(snap.doc_number) : '') + '</b>' +
    '<span class="cs" style="font-family:var(--font-mono);font-size:11px">read from Flex ' +
      esc(fmtTs(snap.fetched_at) || '—') + ' · banked by ' + esc(userName(snap.saved_by) || snap.saved_by || '—') + '</span>' +
    '<span style="flex:1"></span>' +
    (canEditFolderOf(show)
      ? '<button class="btn sm ghost" ' + act('gearSnapDelete', snap.id) + '>' + icon('trash') + 'Delete snapshot</button>'
      : '') + '</div>';
  var t = s.totals || { groups: 0, lines: 0, units: 0 };
  var totals = '<div class="gtotals">' +
    '<div class="gt"><div class="k">Groups</div><div class="v">' + (t.groups || 0) + '</div></div>' +
    '<div class="gt"><div class="k">Line items</div><div class="v">' + (t.lines || 0) + '</div></div>' +
    '<div class="gt"><div class="k">Total units</div><div class="v">' + (t.units || 0) + '</div></div>' +
    '<div class="gt"><div class="k">' + esc(snap.doc_label || 'Sheet') + '</div><div class="v" style="font-size:15px">' + esc(snap.doc_number || '—') + '</div></div></div>';
  var cats = (s.groups || []).map(function (c) {
    var items = (c.items || []).map(function (it) {
      var tag = it.barcode || (it.resourceId ? String(it.resourceId).slice(0, 8) : '');
      return '<div class="gitem"><span class="gnm">' + esc(it.name) +
        (it.serial ? ' <span class="ser">s/n ' + esc(it.serial) + '</span>' : '') +
        (it.note ? '<span style="display:block;color:var(--muted);font-size:11.5px">' + esc(it.note) + '</span>' : '') +
        '</span>' +
        (tag ? '<span class="gid">' + esc(tag) + '</span>' : '') +
        '<span class="gqty">× ' + esc(it.qty) + '</span></div>';
    }).join('');
    return '<div class="gcat"><div class="gch"><b>' + esc(c.path || c.name || '') + '</b>' +
      (c.containerSerial ? '<span class="ser">' + esc(c.containerSerial) + '</span>' : '') +
      '<span class="gn">' + (c.items || []).length + ' line' + ((c.items || []).length === 1 ? '' : 's') + '</span></div>' + items + '</div>';
  }).join('');
  return bar +
    '<div class="perm-note" style="margin:0 0 12px">' + inlineIcon('lock') +
    ' Read-only record — this is what the sheet said when it was banked, not what Flex says now. ' +
    'For the live list, use Load from Flex above.</div>' +
    totals + '<div style="margin-top:12px">' + cats + '</div>';
}
/* ── the LIVE gear body (2026-08-28) ────────────────────────────────────────
   Same visual language as pullBody() — .gtotals / .gcat / .gitem — because it
   is the same document; only the source changed from buildKit() to Flex. The
   differences are all things the demo has no equivalent for: the pack-status
   row, the read timestamp, the per-line barcode, and the four honest states
   this can be in before there is a sheet at all. */
function flexSheetBody(show, st) {
  if (!st) {
    return '<div class="gear-empty">' + icon('box') +
      '<div style="font-weight:600;font-size:14px">Nothing read from Flex yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:460px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      '<b>Load from Flex</b> reads this folder’s equipment lists, then one list’s real line items — groups, quantities, barcodes and the prep / ship / return status Flex holds. It is read live on every click and stored nowhere, so what you see is what the warehouse sees.</div></div>';
  }
  if (st.loading) {
    return '<div class="gear-empty">' + icon('download') +
      '<div style="font-weight:600;font-size:14px">Reading from Flex…</div>' +
      '<div style="font-size:12.5px;margin-top:7px">One folder tree, one list header, one row-data call.</div></div>';
  }
  if (st.error) {
    return '<div class="gear-empty" style="border-color:var(--crit)">' + icon('alert') +
      '<div style="font-weight:600;font-size:14px">Flex could not be read</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      esc(st.error) + '</div>' +
      '<div style="margin-top:14px"><button class="btn sm ghost" ' + act('flexPull', show.id) + '>' + icon('download') + 'Try again</button></div></div>';
  }
  if (st.empty) {
    return '<div class="gear-empty">' + icon('box') +
      '<div style="font-weight:600;font-size:14px">This Flex folder has no equipment lists</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:480px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      esc(st.message || '') + '</div>' +
      '<div style="margin-top:14px;display:flex;gap:9px;justify-content:center;flex-wrap:wrap">' +
      (st.folderDeepLink ? '<a class="btn sm ghost" href="' + esc(st.folderDeepLink) + '" target="_blank" rel="noopener noreferrer">' + icon('link') + 'Open the folder in Flex</a>' : '') +
      '<button class="btn sm ghost" ' + act('flexPull', show.id) + '>' + icon('download') + 'Check again</button></div></div>';
  }

  var s = st.sheet;
  var typeLabel = s.type === 'pull-sheet' ? 'Pull Sheet' : s.type === 'manifest' ? 'Manifest' : 'Equipment list';

  /* pack status — all six stages, in job order, done or not stated either way.
     A stage nobody has completed is a dash, never an absence. */
  var chips = (s.status.stages || []).map(function (x) {
    if (!x.done) return '<span class="cs" style="font-family:var(--font-mono);font-size:10px">' + esc(x.label) + ' —</span>';
    return '<span class="fresh-chip" title="' + esc(x.at || '') + (x.by ? ' · ' + esc(x.by) : '') + '">' +
      esc(x.label) + ' ✓ ' + esc(flexWhen(x.at)) + (x.by ? ' · ' + esc(x.by) : '') + '</span>';
  }).join('<span style="color:var(--border-strong)">·</span>');
  var statusRow = '<div class="perm-note" style="margin:0 0 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    inlineIcon('truck') + ' <b style="font-weight:600">Pack status</b> ' + chips + '</div>';

  /* switcher — only when the folder really holds more than one list */
  var others = (st.lists || []).filter(function (l) { return l.id !== s.listId; });
  var switcher = others.length
    ? '<div class="hint" style="margin:0 0 12px">' + icon('layers') + 'Also in this folder: ' +
      others.map(function (l) {
        /* the tree exposes no document kind (type:null, on purpose — see
           lib/flex.js), so the label is guessed from the NAME and keeps its
           "?" — flexDocKindLabel says which world each label came from */
        return '<button class="btn sm ghost" ' + act('flexPickSheet', show.id, l.id) + '>' +
          esc(l.docNumber || l.name || l.id.slice(0, 8)) +
          ' <span class="cs" style="font-size:10px">' + esc(flexDocKindLabel(l)) + '</span></button>';
      }).join(' ') + '</div>'
    : '';

  var totals = '<div class="gtotals">' +
    '<div class="gt"><div class="k">Groups</div><div class="v">' + s.totals.groups + '</div></div>' +
    '<div class="gt"><div class="k">Line items</div><div class="v">' + s.totals.lines + '</div></div>' +
    '<div class="gt"><div class="k">Total units</div><div class="v">' + s.totals.units + '</div></div>' +
    '<div class="gt"><div class="k">' + esc(typeLabel) + '</div><div class="v" style="font-size:15px">' + esc(s.docNumber || '—') + '</div></div></div>';

  var bar = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0">' +
    '<b style="font-family:var(--font-display);font-size:14px">' + esc(s.name || 'Untitled list') + '</b>' +
    '<span class="cs" style="font-family:var(--font-mono);font-size:11px">read ' + esc(flexWhen(s.fetchedAt)) + ' · live, not cached</span>' +
    '<span style="flex:1"></span>' +
    (s.deepLink ? '<a class="btn sm ghost" href="' + esc(s.deepLink) + '" target="_blank" rel="noopener noreferrer">' + icon('link') + 'Open in Flex</a>' : '') +
    /* the look-back's front door: bank THIS sheet, exactly as read, on the
       show. Explicit save only — a read stays a read. */
    '<button class="btn sm ghost" ' + act('gearSnapSave', show.id) + ' title="Bank this sheet as a dated record on the show — the copy survives whatever happens to the list in Flex">' +
      icon('download') + 'Save snapshot</button>' +
    '<button class="btn sm primary" ' + act('flexPrintSheet', show.id) + '>' + icon('print') + 'Print</button></div>';

  /* BUG 5's dangerous half. 200 + [] is what Flex answers both for an empty
     list and for a request it silently disliked; the screen must not turn that
     into the confident sentence "this pull sheet is empty". */
  if (s.empty || !s.groups.length) {
    return statusRow + switcher + bar +
      '<div class="gear-empty">' + icon('alert') +
      '<div style="font-weight:600;font-size:14px">Flex returned no line items</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      'That is either a genuinely empty list or a request Flex did not like — its row-data endpoint answers <span class="mono">200</span> with an empty array for both, so Showrunner cannot tell them apart. Open it in Flex to find out.</div></div>';
  }

  var cats = s.groups.map(function (c) {
    var items = c.items.map(function (it) {
      var tag = it.barcode || (it.resourceId ? it.resourceId.slice(0, 8) : '');
      return '<div class="gitem"><span class="gnm">' + esc(it.name) +
        (it.serial ? ' <span class="ser">s/n ' + esc(it.serial) + '</span>' : '') +
        (it.contains ? ' <span class="ser">+' + it.contains + ' inside</span>' : '') +
        (it.note ? '<span style="display:block;color:var(--muted);font-size:11.5px">' + esc(it.note) + '</span>' : '') +
        '</span>' +
        (tag ? '<span class="gid">' + esc(tag) + '</span>' : '') +
        '<span class="gqty">× ' + esc(it.qty) + (it.qtyAssumed ? '<span title="Flex reported no quantity on this line — counted as 1">?</span>' : '') + '</span></div>';
    }).join('');
    return '<div class="gcat"><div class="gch"><b>' + esc(c.path) + '</b>' +
      (c.containerSerial ? '<span class="ser">' + esc(c.containerSerial) + '</span>' : '') +
      '<span class="gn">' + c.items.length + ' line' + (c.items.length === 1 ? '' : 's') + '</span></div>' + items + '</div>';
  }).join('');

  return statusRow + switcher + bar + totals + '<div style="margin-top:12px">' + cats + '</div>';
}

function pullBody(g) {
  var lines = g.kit.pull.reduce(function (a, c) { return a + c.items.length; }, 0);
  var units = g.kit.pull.reduce(function (a, c) { return a + c.items.reduce(function (x, i) { return x + i.qty; }, 0); }, 0);
  var totals = '<div class="gtotals"><div class="gt"><div class="k">Categories</div><div class="v">' + g.kit.pull.length + '</div></div>' +
    '<div class="gt"><div class="k">Line items</div><div class="v">' + lines + '</div></div>' +
    '<div class="gt"><div class="k">Total units</div><div class="v">' + units + '</div></div>' +
    '<div class="gt"><div class="k">Gear list</div><div class="v" style="font-size:15px">' + esc(g.docNumber) + '</div></div></div>';
  var cats = g.kit.pull.map(function (c) {
    var items = c.items.map(function (it) { return '<div class="gitem"><span class="gnm">' + esc(it.name) + '</span><span class="gid">' + esc(it.resourceId) + '</span><span class="gqty">× ' + esc(it.qty) + '</span></div>'; }).join('');
    return '<div class="gcat"><div class="gch"><b>' + esc(c.cat) + '</b><span class="gn">' + c.items.length + ' line' + (c.items.length > 1 ? 's' : '') + '</span></div>' + items + '</div>';
  }).join('');
  return totals + '<div style="margin-top:12px">' + cats + '</div>';
}
function manifestBody(g) {
  var rows = g.kit.manifest.map(function (m) {
    return '<tr><td><b style="font-weight:600">' + esc(m.case) + '</b>' + (m.loose ? ' <span class="ser">loose</span>' : '') + '</td><td class="mono">' + esc(m.size) + '</td><td class="mono">' + esc(m.weight) + ' lb</td><td style="color:var(--muted)">' + esc(m.contents) + '</td></tr>';
  }).join('');
  var totW = g.kit.manifest.reduce(function (a, m) { return a + m.weight; }, 0);
  var heaviest = g.kit.manifest.reduce(function (a, m) { return Math.max(a, m.weight); }, 0);
  return '<div class="gtotals" style="margin-top:0;margin-bottom:12px"><div class="gt"><div class="k">Flight cases</div><div class="v">' + g.kit.manifest.length + '</div></div>' +
    '<div class="gt"><div class="k">Total weight</div><div class="v">' + esc(totW.toLocaleString()) + ' <small style="font-size:12px;color:var(--muted)">lb</small></div></div>' +
    '<div class="gt"><div class="k">Heaviest case</div><div class="v">' + heaviest + ' lb</div></div>' +
    '<div class="gt"><div class="k">Cabinet cases</div><div class="v">' + g.kit.cabCases + '</div></div></div>' +
    '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Flight case</th><th>Dimensions</th><th>Weight</th><th>Contents</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="hint">' + icon('bolt') + 'Case manifest for logistics + storage planning — the count owed on calls like the STL manifest. On push it rides the packet as the Flex Manifest gear list.</div>';
}

/* ------------------------------------------------------------- files tab -- */
/* ONE FILE CARD.
   Two things landed here on 2026-08-28. First, a real uploaded file is created
   with `meta: ''` (uploadRealFile) — nothing invents a caption for it — so the
   card's second line was simply BLANK for every genuine upload while the demo
   fixtures, which carry a hand-written meta, looked fine. Who filed it and when
   are facts the row already holds; they are printed when there is nothing
   better to say. Second, the seam pass wired the `downloadFile` action and put
   the button in the viewer only, so getting a file out meant opening it first.

   The card stays a <button> for the keyboard — there is no generic Enter/Space
   handler on data-act, so demoting it to a div would silently drop keyboard
   access — and the Download control is a SIBLING inside the cell rather than a
   nested button, which the HTML parser would hoist straight back out. */
function fileCard(f) {
  var line = f.meta || (uploaderName(f) !== '—'
    ? 'Filed by ' + uploaderName(f) + ' · ' + fmtDate(f.created_at)
    : fmtDate(f.created_at));
  return '<div class="file-cell">' +
    '<button class="file" ' + act('openViewer', f.id) + '>' +
    '<div class="thumb">' + icon(fileIcon(f)) + '<span class="ext">' + esc(f.ext) + '</span></div>' +
    '<div class="fb"><b>' + esc(f.name) + '</b><span>' + esc(line) + '</span>' +
    fileBytelessFlag(f) + '</div></button>' +
    fileDownloadChip(f) + fileUploadChip(f) + fileDeleteChip(f) + '</div>';
}
/* documents only — photos have their own gallery tab next door (photo pass) */
function tabFiles(show) {
  var docs = show.files.filter(function (f) { return f.kind !== 'photo'; });
  var phN = photoCount(show.id);
  var cards = docs.map(fileCard).join('');
  return recapFilesBlock(show) +
    '<div class="files-head"><h3>Files · ' + docs.length + '</h3>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    (phN ? '<button class="btn ghost" ' + act('gotoTab', null, 'photos') + '>' + icon('cam') + phN + ' photo' + (phN === 1 ? '' : 's') + '</button>' : '') +
    '<button class="btn primary" ' + act('addFile', show.id) + '>' + icon('plus') + 'Add file</button></div></div>' +
    '<div class="dz" ' + act('addFile', show.id) + ' data-drop="' + show.id + '">' +
    /* "modeled" was true of the whole grid once and is now true only of demo
       mode: with a server attached a drop is a genuine PUT of genuine bytes
       (dropFile -> uploadRealFile). Saying "modeled" over a real upload is the
       same small lie as inventing a size, pointed the other way. */
    '<div class="dzi">' + icon('download') + '</div><b>Drop files here or click to browse</b><span>PDF · proof · contract · image · spec — ' +
    (typeof SR !== 'undefined' && SR.isApi() ? 'uploaded to the e360 NAS' : 'modeled, stored on the e360 NAS') + '</span></div>' +
    '<div class="file-grid">' + cards +
    '<button class="file" ' + act('addFile', show.id) + ' style="border-style:dashed"><div class="thumb">' + icon('plus') + '</div><div class="fb"><b>Add file</b><span>click to browse</span></div></button></div>' +
    '<div class="hint">' + icon('bolt') + 'Click any file to open it in the Multimedia Viewer. Files also land here when attached in context — from a Bookings row or a Deliverables / Proof step.</div>';
}

/* ---------------------------------------------------------- bookings tab -- */
/* A booking is cost-bearing, so it can OVERRIDE the show's default job — a
   single show can split across two deals (league LED + a team's own buy). */
function tabBookings(show) {
  var rows = show.bookings.map(function (b) {
    var s = normStatus(b.status);
    var lbl = s === 'done' ? 'Confirmed' : s === 'in_progress' ? 'Pending' : s === 'blocked' ? 'Blocked' : 'Needed';
    var override = b.job_id && b.job_id !== show.default_job_id ? JOBS_BY_ID[b.job_id] : null;
    /* The attached confirmation, checked for SUBSTANCE, not just presence —
       Brendon's Rhino doc had a file_id and zero bytes, and this row looked
       exactly like a booking whose paperwork was done. */
    var bkFile = b.file_id ? FILES_BY_ID[b.file_id] : null;
    return '<tr><td><b style="font-weight:600">' + esc(b.category) + '</b>' +
      (override ? ' <span class="tag" title="' + esc(override.client + ' · ' + override.description) + '">Job ' + esc(override.qb_job_number) + '</span>' : '') +
      (bkFile ? ' ' + fileBytelessFlag(bkFile) : '') + '</td>' +
      '<td>' + esc(b.vendor) + '</td>' +
      '<td><span class="pill ' + esc(STATUS[s].pill) + '"><span class="dot"></span>' + esc(lbl) + '</span></td>' +
      '<td style="text-align:right"><span style="display:inline-flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">' +
      /* "Attach" named the mechanism; this names the DOCUMENT, which is what
         the person is holding. One flow behind it: pick the file → it uploads →
         the booking's file_id is set → the exception clears → the toast names
         what landed. Once the paperwork is on, the button says so. */
      '<button class="btn sm ghost" ' + act('attachBooking', b.id) + '>' + icon('link') +
      (b.file_id ? 'Replace confirmation' : 'Attach confirmation') + '</button>' +
      /* the byteless record's one-click recovery: the SAME PUT the original
         attach uses, aimed at the row that already exists */
      (bkFile && fileIsByteless(bkFile) && canDeleteFile(bkFile, show)
        ? '<button class="btn sm ghost" ' + act('uploadMissingBytes', bkFile.id) + '>' +
          icon('upload') + 'Upload the missing document</button>'
        : '') +
      /* The two buttons that used to sit here — "Paperwork" and "Assign" — were
         toastAttrs fakes, on a table of rows that could not be created in the
         first place. One real edit affordance replaces both. */
      (canEditFolderOf(show)
        ? '<button class="btn sm ghost" ' + act('editBooking', b.id, String(show.id)) + '>' +
          icon('pencil') + 'Edit</button>'
        : '') +
      /* DELETE, at PARITY WITH EDIT — same row, same gate, same rank. It used
         to live only inside the edit modal, so cancelling a booking meant
         opening the correction dialog for a row you did not want to correct.
         The server floor moved from manager to pm to match (routes/files.js
         DELETE /bookings/:id): the pm who owns the folder books the truck and
         is the one who cancels it. */
      (canEditFolderOf(show)
        ? '<button class="btn sm ghost" ' + act('bkDelete', b.id) + '>' +
          icon('trash') + 'Delete</button>'
        : '') +
      '</span></td></tr>';
  }).join('');
  var split = show.bookings.some(function (b) { return b.job_id && b.job_id !== show.default_job_id; });
  var bkHead = '<div class="files-head"><h3>Bookings \u00b7 ' + show.bookings.length + '</h3>' +
    (canEditFolderOf(show)
      ? '<button class="btn primary" ' + act('addBooking', show.id) + '>' + icon('plus') + 'Book a vendor</button>'
      : '') + '</div>';
  if (!show.bookings.length) {
    return bkHead + '<div class="gear-empty">' + icon('truck') +
      '<div style="font-weight:600;font-size:14px">Nothing booked yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:470px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      'Trucking, forklift, feeder cable, install and strike labour, hotels \u2014 the logistics lane\u2019s ' +
      'substance, and the rows the scheduler push maps onto staffing <b>/api/bookings</b>. A booking with an ' +
      'amount and no paperwork lands on accounting\u2019s chase list until the confirmation is attached.</div>' +
      (canEditFolderOf(show)
        ? '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px">' +
          '<button class="btn primary" ' + act('addBooking', show.id) + '>' + icon('plus') +
          'Book a vendor</button></div>'
        : '') + '</div>' +
      /* the rooming list renders below the empty state too — a crew usually
         has beds before the first vendor row lands, and the bulk button is
         what fills it */
      roomingSection(show);
  }
  return bkHead + '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Booking</th><th>Vendor</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="hint">' + icon('bolt') + 'Every confirmed booking keeps its paperwork here — so anyone can pick up the event and see exactly what’s locked. On push, these map to staffing <b>/api/bookings</b>.</div>' +
    (split ? '<div class="hint">' + icon('scale') + 'Rows tagged with a different <b>job number</b> bill to another deal in this folder — this show’s costs split across two jobs.</div>' : '') +
    roomingSection(show);
}

/* -------------------------------------------------------- rooming list -- */
/* TEAM_FEEDBACK "Rooming lists": a hotel booking is ONE row for a whole block,
   so who actually sleeps in it lived in somebody's head. This table is the
   per-person half — person · hotel · room · conf # · nights — right under the
   bookings it can link to. Anyone signed in reads it (a tech checks their own
   hotel here); writes are the folder's edit gate, same rank+ownership pair as
   the booking rows above. */
function roomingSection(show) {
  var rooms = roomingForShow(show.id);
  var editable = canEditFolderOf(show);
  var head = '<div class="files-head" style="margin-top:22px"><h3>Rooming · ' + rooms.length + '</h3>' +
    (editable
      ? '<span style="display:inline-flex;gap:8px">' +
        /* the bulk affordance: every crew member gets a row in one click —
           the six-techs-one-booking gap is exactly what this closes */
        '<button class="btn ghost" ' + act('roomSeedCrew', show.id) + ' title="' +
        esc('One row per person on the crew — anyone already listed is skipped.') + '">' +
        icon('users') + 'Add crew</button>' +
        '<button class="btn primary" ' + act('roomAdd', show.id) + '>' + icon('plus') + 'Add person</button>' +
        '</span>'
      : '') + '</div>';
  if (!rooms.length) {
    return head + '<div class="gear-empty">' + icon('moon') +
      '<div style="font-weight:600;font-size:14px">No rooming list yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:470px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      'Who sleeps where: one row per person — hotel, room type, confirmation number and nights. ' +
      'A hotel booking above covers the whole block; this list covers the people in it, and it prints on ' +
      'the call sheet so nobody stands at a front desk at midnight without a confirmation number.</div>' +
      (editable
        ? '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px">' +
          '<button class="btn primary" ' + act('roomSeedCrew', show.id) + '>' + icon('users') +
          'Add the crew</button>' +
          '<button class="btn ghost" ' + act('roomAdd', show.id) + '>' + icon('plus') + 'Add a person</button></div>'
        : '') + '</div>';
  }
  var rows = rooms.map(function (r) {
    var bk = r.booking_id ? BOOKINGS_BY_ID[r.booking_id] : null;
    var nights = (r.check_in || r.check_out)
      ? esc(fmtDate(r.check_in)) + ' – ' + esc(fmtDate(r.check_out))
      : '<span style="color:var(--muted)">—</span>';
    return '<tr><td><b style="font-weight:600">' + esc(r.person) + '</b>' +
      (r.user_username ? '' : ' <span class="mini auto" title="Not a login — free-text person">local</span>') + '</td>' +
      '<td>' + (r.hotel ? esc(r.hotel) : '<span style="color:var(--muted)">—</span>') +
      (bk ? ' <span class="tag" title="' + esc('Linked to the booking: ' + bk.category + (bk.vendor ? ' · ' + bk.vendor : '')) + '">' +
        esc(bk.vendor || bk.category) + '</span>' : '') + '</td>' +
      '<td>' + (r.room_type ? esc(r.room_type) : '<span style="color:var(--muted)">—</span>') + '</td>' +
      '<td class="mono" style="font-size:11.5px">' + (r.confirmation ? esc(r.confirmation) : '—') + '</td>' +
      '<td style="font-size:12px">' + nights + '</td>' +
      '<td style="font-size:12px;color:var(--text-2)">' + esc(r.notes || '') + '</td>' +
      '<td style="text-align:right"><span style="display:inline-flex;gap:6px;justify-content:flex-end">' +
      (editable
        ? '<button class="btn sm ghost" ' + act('roomEdit', r.id, String(show.id)) + '>' + icon('pencil') + 'Edit</button>' +
          '<button class="btn sm ghost" ' + act('roomDelete', r.id) + '>' + icon('trash') + 'Delete</button>'
        : '') +
      '</span></td></tr>';
  }).join('');
  return head + '<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    '<th>Person</th><th>Hotel</th><th>Room</th><th>Conf #</th><th>Check-in / out</th><th>Notes</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="hint">' + icon('moon') + 'One row per bed. These rows print on the call sheet when any exist; ' +
    'a linked booking’s tag ties the person back to the paperwork above — cancelling that booking ' +
    'clears the tag but never the person’s row.</div>';
}


/* ============================================================================
   F3/F4 · THE CHANGELOG — rendering the before→after
   ----------------------------------------------------------------------------
   The activity table always had 68 verbs and 128 writers. What it did not have
   was (a) a DIFF on the changes that matter — `show.update · Wrigley Field` was
   the log line for a venue change, an owner change AND a date move alike — and
   (b) any read surface but one per-show tab nobody opened.

   (a) is fixed server-side: lib/activity.js now writes a structured `changes`
   column, [{field,label,from,to}], on every material mutation. This is the
   renderer for it, used by both the per-show Activity tab and the cross-project
   feed below.
   ========================================================================== */

/* Dotted machine keys are what a filter, a digest and a changelog can key on
   (F12) — and what a person should never have to read. One map, both needs. */
var ACTION_LABELS = {
  'show.create': 'opened the show', 'show.update': 'changed the show',
  'show.struck': 'struck the show',
  'project.create': 'opened the folder', 'project.update': 'changed the folder',
  'step.create': 'added a task', 'step.update': 'changed a task',
  'step.status': 'moved a task', 'step.assign': 'assigned a task',
  'step.delete': 'deleted a task',
  'crew.add': 'added crew', 'crew.update': 'changed a crew line',
  'crew.remove': 'took someone off the crew',
  'schedule.add': 'added to the schedule', 'schedule.update': 'changed the schedule',
  'schedule.remove': 'removed from the schedule',
  'callsheet.update': 'changed the call sheet',
  'booking.add': 'made a booking', 'booking.update': 'changed a booking',
  'booking.delete': 'cancelled a booking',
  'rooming.add': 'added to the rooming list', 'rooming.update': 'changed a room',
  'rooming.remove': 'removed a room',
  'budget.line.add': 'set an allotment', 'budget.line.update': 'changed an allotment',
  'budget.line.delete': 'removed an allotment',
  'job.create': 'opened a job', 'job.update': 'changed the job',
  'job.number.confirm': 'confirmed the job number',
  'expense.add': 'recorded a cost', 'expense.update': 'corrected a cost',
  'expense.delete': 'voided a cost',
  'po.update': 'changed a PO', 'po.status': 'moved a PO',
  'need.add': 'added a needs-list item', 'need.update': 'changed a needs-list item',
  'need.status': 'checked the needs list', 'need.delete': 'removed a needs-list item',
  'need.seed': 'seeded the needs list',
  'proof.add': 'added a proof', 'proof.update': 'changed a proof',
  'proof.round.add': 'opened a proof round', 'proof.delete': 'deleted a proof',
  'milestone.create': 'added a milestone', 'milestone.update': 'changed a milestone',
  'milestone.delete': 'removed a milestone',
  'template.instantiate': 'seeded the pipeline',
  'key.create': 'minted an API key', 'key.revoke': 'revoked an API key',
  'agent.proposal.confirm': 'confirmed an agent proposal',
  'agent.proposal.reject': 'rejected an agent proposal',
  'notification.sent': 'sent a notification'
};
function actionLabel(a) {
  var k = String(a || '');
  if (ACTION_LABELS[k]) return ACTION_LABELS[k];
  /* a dotted key nobody has named yet reads better as words than as a key */
  return k.indexOf('.') > 0 ? k.replace(/\./g, ' ').replace(/_/g, ' ') : k;
}

/* One diff row: label, the old value struck through, the new one. `—` stands
   for "nothing was there", which is a real and different answer from blank. */
function changeChips(changes) {
  if (!changes || !changes.length) return '';
  return '<div class="chg-list">' + changes.map(function (c) {
    return '<div class="chg"><span class="chg-f">' + esc(c.label || c.field) + '</span>' +
      '<span class="chg-a">' + esc(c.from == null ? '—' : c.from) + '</span>' +
      '<span class="chg-x">' + inlineIcon('chevR') + '</span>' +
      '<span class="chg-b">' + esc(c.to == null ? '—' : c.to) + '</span></div>';
  }).join('') + '</div>';
}

/* The per-show Activity tab, now with the diffs rendered under each line. */
function tabActivity(show) {
  var items = show.activity.map(function (a) {
    var line = (a.actor ? '<b>' + esc(actorName(a.actor)) + '</b> ' : '') + esc(actionLabel(a.action)) +
      (a.detail && !(a.changes && a.changes.length)
        ? ' <span style="color:var(--muted)">· ' + esc(a.detail) + '</span>' : '');
    return '<div class="tl-item ' + (a.accent ? 'accent' : '') + '"><div class="node"></div>' +
      '<div class="a-t">' + line + changeChips(a.changes) + '</div>' +
      '<div class="a-m">' + esc(fmtTs(a.ts)) + '</div></div>';
  }).join('');
  return '<div class="panel"><div class="timeline">' + (items ||
    '<div class="empty">Nothing has happened on this show yet.</div>') + '</div></div>';
}

/* ── the cross-project feed ────────────────────────────────────────────────── */
/* per-view state, declared beside its view — the same device as SCHED_UI,
   PH_UI, RECAP_UI and NOTES_UI. app.js owns the ACTIONS that mutate it. */
var CHANGES_UI = { scope: 'mine', action: '' };
var CHANGE_FILTERS = [
  { k: 'show.', label: 'Dates & venue' },
  { k: 'step.', label: 'Tasks' },
  { k: 'crew.', label: 'Crew' },
  { k: 'callsheet.', label: 'Call sheet' },
  { k: 'schedule.', label: 'Schedule' },
  { k: 'booking.', label: 'Bookings' },
  { k: 'rooming.', label: 'Rooming' },
  { k: 'budget.', label: 'Budget' },
  { k: 'po.', label: 'Purchasing' }
];
function viewChanges(rows) {
  rows = rows || [];
  var scope = CHANGES_UI.scope;
  var chips = CHANGE_FILTERS.map(function (f) {
    return '<button class="btn sm ' + (CHANGES_UI.action === f.k ? 'primary' : 'ghost') + '" ' +
      act('changesFilter', null, f.k) + '>' + esc(f.label) + '</button>';
  }).join('');

  var byShow = {};
  var order = [];
  rows.forEach(function (a) {
    var key = a.show_id ? 'show:' + a.show_id : (a.project_id ? 'proj:' + a.project_id : 'other');
    if (!byShow[key]) { byShow[key] = []; order.push(key); }
    byShow[key].push(a);
  });

  var groups = order.map(function (key) {
    var list = byShow[key];
    var label = 'Elsewhere', goAct = '';
    if (key.indexOf('show:') === 0) {
      var sh = SHOWS_BY_ID[Number(key.slice(5))];
      label = sh ? showLabel(sh) : 'Show ' + key.slice(5);
      goAct = act('openShow', Number(key.slice(5)));
    } else if (key.indexOf('proj:') === 0) {
      var pr = PROJECTS_BY_ID[Number(key.slice(5))];
      label = pr ? pr.name : 'Folder ' + key.slice(5);
      goAct = act('openFolder', Number(key.slice(5)));
    }
    var items = list.map(function (a) {
      return '<div class="tl-item ' + (a.accent ? 'accent' : '') + '"><div class="node"></div>' +
        '<div class="a-t"><b>' + esc(actorName(a.actor)) + '</b> ' + esc(actionLabel(a.action)) +
        changeChips(a.changes) + '</div>' +
        '<div class="a-m">' + esc(fmtTs(a.ts)) + '</div></div>';
    }).join('');
    return '<div class="panel" style="margin-bottom:16px"><h3>' +
      (goAct ? '<span class="lnk" style="cursor:pointer" ' + goAct + '>' + esc(label) + '</span>'
             : esc(label)) +
      ' <span class="frac">' + list.length + '</span></h3>' +
      '<div class="timeline">' + items + '</div></div>';
  }).join('');

  return '<div class="page-h"><div><h1>What changed</h1>' +
    '<div class="sub">Every material change — a date, a venue, a call time, a task, an allotment, a ' +
    'delivery — with what it was and what it is now. This is the same set of events the app ' +
    '<b>tells people about</b>; here it is as a list you can read.</div></div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    '<button class="btn ' + (scope === 'mine' ? 'primary' : 'ghost') + '" ' +
      act('changesScope', null, 'mine') + '>' + icon('users') + 'My shows</button>' +
    (canViewAllChanges()
      ? '<button class="btn ' + (scope === 'all' ? 'primary' : 'ghost') + '" ' +
        act('changesScope', null, 'all') + '>' + icon('grid') + 'Everything</button>'
      : '') +
    '</div></div>' +
    '<div class="sched-bar" style="margin-bottom:14px"><div class="daychips" style="gap:7px">' + chips +
    '</div></div>' +
    (rows.length ? groups
      : '<div class="gear-empty">' + icon('bolt') +
        '<div style="font-weight:600;font-size:14px">Nothing has changed' +
        (scope === 'mine' ? ' on your shows' : '') + '</div>' +
        '<div style="font-size:12.5px;margin-top:7px;max-width:460px;margin-left:auto;margin-right:auto;line-height:1.5">' +
        (scope === 'mine'
          ? 'You are on a show the moment you own it, own a task on it, or are put on its crew — and from then on ' +
            'every material change to it lands here and in your inbox.'
          : 'A change with a before and an after shows up here. Routine edits — a typo in a detail line — stay ' +
            'out of it on purpose.') +
        '</div></div>');
}
/* Company-wide is a manager/admin question; a tech's feed is their own shows.
   Mirrors nothing on the server (the route is session-only by design, like the
   rest of the activity feed) — this is about what is USEFUL, not what is
   permitted, and the honest scope for one person is the shows they are on. */
function canViewAllChanges() {
  var r = CURRENT_USER.role;
  return r === 'admin' || r === 'manager';
}


/* ------------------------------------------------------ proofs & approval --
   HOUSE RULE, APPLIED: no fabrication reachable in API mode.

   This tab used to render a HARDCODED six-stage approval flow with invented
   attributions — Design/jhawk, Internal QC/lfarkos, "Sent to client · R2",
   "Approved · e-sign" — for EVERY show, regardless of what was in `proofs` /
   `proof_rounds`. Approve and Request-changes fired a toast and called no API.
   It was the print persona's core workflow rendered as a screenshot, and it is
   the same disease HARDENING_TODO 21 swept everywhere else.

   What is here now is the real thing: rows from `proofs`, rounds from
   `proof_rounds`, an approve that writes and a request-changes that opens the
   next round. The stage strip is DERIVED from the proof's own rounds rather
   than asserted, so a show with one round shows one round.
   -------------------------------------------------------------------------- */
function proofFlow(p) {
  /* the stages a proof has actually been through, read off its rounds */
  var rounds = (p.rounds || []).slice();
  var steps = [{ k: 'Drafted', ic: 'pencil', sub: rounds.length ? 'R1' : 'not sent yet',
                 st: rounds.length ? 'done' : 'active' }];
  rounds.forEach(function (r, i) {
    steps.push({ k: r.status === 'markup' ? 'Client markup' : 'Sent to client',
                 ic: r.status === 'markup' ? 'mail' : 'send',
                 sub: (r.round || 'R' + (i + 1)) + (r.date ? ' · ' + fmtDate(r.date) : ''),
                 st: 'done' });
  });
  steps.push({ k: p.status === 'approved' ? 'Approved' : 'Awaiting approval',
               ic: p.status === 'approved' ? 'lock' : 'clock',
               sub: p.status === 'approved' ? 'locked' : 'open',
               st: p.status === 'approved' ? 'done' : 'active' });
  return '<div class="flow">' + steps.map(function (f, i) {
    var sep = i < steps.length - 1 ? '<span class="fsep">' + icon('chevR') + '</span>' : '';
    return '<div class="fstep ' + f.st + '"><div class="fi">' + icon(f.ic) + '</div>' +
      '<div class="ft"><b>' + esc(f.k) + '</b><span>' + esc(f.sub) + '</span></div></div>' + sep;
  }).join('') + '</div>';
}

function tabProofs(show) {
  var editable = canEditFolderOf(show);
  var list = show.proofs || [];
  var head = '<div class="files-head"><h3>Proofs · ' + list.length + '</h3>' +
    (editable ? '<button class="btn primary" ' + act('addProof', show.id) + '>' + icon('plus') +
      'New proof</button>' : '') + '</div>';

  if (!list.length) {
    return head + '<div class="gear-empty">' + icon('palette') +
      '<div style="font-weight:600;font-size:14px">No proofs on this show yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:480px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      'A proof is one printed piece going out for client sign-off. Each trip to the client and back is a ' +
      '<b>round</b>; the last one that comes back approved is what releases to the print floor. Attach the ' +
      'artwork on the Files tab and it opens in the Viewer from here.</div>' +
      (editable
        ? '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px">' +
          '<button class="btn primary" ' + act('addProof', show.id) + '>' + icon('plus') +
          'New proof</button></div>'
        : '') + '</div>';
  }

  var approvedFile = show.files.filter(function (f) { return f.kind === 'proof'; })[0];
  var proofs = list.map(function (p) {
    var rounds = (p.rounds || []).map(function (r) {
      return '<div class="round"><div class="rn">' + esc(r.round) + '</div><div class="rc">' +
        '<div class="rnote">' + esc(r.note || '') + '</div>' +
        '<div class="rd">' + psPill(r.status) + (r.date ? ' sent ' + esc(fmtDate(r.date)) : '') +
        '</div></div></div>';
    }).join('') || '<div class="empty" style="padding:14px">No rounds yet — nothing has gone to the client.</div>';
    var actions = p.status === 'approved'
      ? (approvedFile
          ? '<button class="btn sm ghost" ' + act('openViewer', approvedFile.id) + '>' + icon('eye') +
            'View approved proof</button>' : '')
      : (editable
          ? '<button class="btn sm" ' + act('proofApprove', p.id) + '>' + icon('check') + 'Approve</button>' +
            '<button class="btn sm ghost" ' + act('proofRevise', p.id) + '>' + icon('pencil') +
            'Request changes</button>'
          : '');
    var pen = editable
      ? '<button class="iconbtn" title="Edit proof" ' + act('editProof', p.id, String(show.id)) + '>' +
        icon('pencil') + '</button>'
      : '';
    return '<div class="proof"><div class="proof-h"><div class="pth">' + proofThumbSVG() + '</div>' +
      '<div class="pn"><b>' + esc(p.name) + '</b><span>' + esc((p.code || '') + (p.client ? ' · ' + p.client : '')) +
      '</span></div>' + psPill(p.status) + pen + '</div>' +
      proofFlow(p) +
      '<div class="rounds">' + rounds + '</div>' +
      '<div class="proof-foot"><span class="who">' + icon('clock') + ' ' + (p.rounds || []).length +
      ' round' + ((p.rounds || []).length === 1 ? '' : 's') + '</span><span class="sp"></span>' +
      actions + '</div></div>';
  }).join('');

  return head +
    '<div class="hint" style="margin:0 0 14px">' + icon('lock') + '<span>Once a proof is approved it is ' +
    'locked and versioned — the approved file is what releases to the print floor, and it is what the ' +
    'Viewer prints. Approving it tells everyone on this show.</span></div>' +
    '<div class="proofs">' + proofs + '</div>';
}

/* ============================================================= photos tab --
   The per-show gallery (photo pass): masonry grid in day groups (the call
   sheet's day language — Load-in · Show day · Strike), tag filter chips,
   recap-pick stars (pm+ curation the recap pass consumes), inline confirm /
   reject on agent proposals. Clicking any photo opens the Viewer lightbox.
   ========================================================================== */
var PH_UI = { tag: {}, editCap: null };   /* per-show filter · viewer caption edit */

function phNasHint(show) {
  return '\\\\e360-nas\\showrunner\\P' + show.project_id + '-' + show.project.slug +
    '\\S' + show.id + '-' + show.slug + '\\photo\\';
}
function phTakenHM(f) { return fmtHM(String(f.taken_at || '').slice(11, 16)); }
/* the quiet bolt that says "an agent filed this" — full story in the title */
function photoAgentMark(f) {
  if (!f.provenance) return '';
  return '<span class="ph-agent" title="' + esc('organized by ' + actorLabel(null, f.provenance) + ' · ' +
    (f.provenance.source_label || 'camera-roll sync') + ' · ' + Math.round(f.provenance.confidence) + '% match') + '">' +
    inlineIcon('bolt') + '</span>';
}
function photoStarBtn(f) {
  if (PH_EDIT_ROLES[CURRENT_USER.role]) {
    return '<button class="ph-star' + (f.recap_pick ? ' on' : '') + '" title="' +
      (f.recap_pick ? 'Recap pick — click to remove' : 'Star for the client recap') + '" ' +
      act('photoPick', f.id) + '>' + icon('star') + '</button>';
  }
  return f.recap_pick ? '<span class="ph-star on static" title="Recap pick">' + icon('star') + '</span>' : '';
}

function photoCard(f) {
  var w = Number(f.width) || 3, h = Number(f.height) || 2;
  var proposed = f.status === 'proposed';
  var review = proposed
    ? '<div class="ph-rev"><button class="btn sm primary" ' + act('photoConfirm', f.id) + '>' + icon('check') + 'Confirm</button>' +
      '<button class="btn sm ghost" ' + act('photoReject', f.id) + '>' + icon('x') + 'Reject</button></div>'
    : '';
  return '<div class="ph-card' + (proposed ? ' proposed' : '') + '" ' + act('openViewer', f.id) + '>' +
    '<div class="ph-fig" style="aspect-ratio:' + w + '/' + h + '">' +
    '<img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '" loading="lazy">' +
    (proposed ? '<span class="pill warn ph-prop"><span class="dot"></span>Proposed' +
      (f.provenance ? ' · ' + Math.round(f.provenance.confidence) + '%' : '') + '</span>' : '') +
    photoStarBtn(f) + '</div>' +
    '<div class="ph-cap"><b>' + esc(f.caption || f.name) + '</b>' +
    '<span class="ph-sub">' + esc(phTakenHM(f) + (f.shot_by ? ' · ' + firstName(f.shot_by) : '')) + photoAgentMark(f) + '</span>' +
    review + '</div></div>';
}

function tabPhotos(show) {
  var photos = photosForShow(show.id);

  /* ---- empty state — quiet; the agent fills this in ----------------------- */
  if (!photos.length) {
    return '<div class="gear-empty">' + icon('cam') +
      '<div style="font-weight:600;font-size:14px">Photos land here when your agent syncs them</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:480px;margin-left:auto;margin-right:auto;line-height:1.5">Shoot the show — each teammate’s agent sorts, names and tags their camera roll into this event’s NAS folder and the gallery fills in by itself. Confident matches file directly; uncertain ones wait as <b>proposed</b> for a human eye.</div>' +
      '<div class="mono" style="margin-top:14px;font-size:11px;color:var(--muted);word-break:break-all">' + esc(phNasHint(show)) + '</div></div>';
  }

  var picksN = photos.filter(function (f) { return f.recap_pick; }).length;
  var propN = photos.filter(function (f) { return f.status === 'proposed'; }).length;
  var cur = PH_UI.tag[show.id] || null;

  /* ---- filter chips: all · ★ picks · every tag with its count ------------- */
  var chips = '<button class="ph-chip' + (!cur ? ' on' : '') + '" ' + act('phTag', show.id, '*') + '>All <span class="n">' + photos.length + '</span></button>';
  if (picksN) {
    chips += '<button class="ph-chip pick' + (cur === '★' ? ' on' : '') + '" title="Recap picks — what the client recap will lead with" ' +
      act('phTag', show.id, '★') + '>' + inlineIcon('star') + 'Picks <span class="n">' + picksN + '</span></button>';
  }
  chips += photoTagCounts(photos).map(function (t) {
    return '<button class="ph-chip' + (cur === t.tag ? ' on' : '') + '" ' + act('phTag', show.id, t.tag) + '>' +
      esc(t.tag) + ' <span class="n">' + t.n + '</span></button>';
  }).join('');
  var bar = '<div class="ph-bar">' + chips + '<span style="flex:1"></span>' +
    (propN ? '<span class="pill warn"><span class="dot"></span>' + propN + ' proposed</span>' : '') +
    '</div>';

  /* ---- apply the filter --------------------------------------------------- */
  var shown = photos.filter(function (f) {
    if (!cur) return true;
    if (cur === '★') return !!f.recap_pick;
    return (f.tags || []).indexOf(cur) >= 0;
  });

  /* ---- day groups — the call sheet's day language ------------------------- */
  var byDay = {}, days = [];
  shown.forEach(function (f) {
    var d = String(f.taken_at || '').slice(0, 10);
    if (!byDay[d]) { byDay[d] = []; days.push(d); }
    byDay[d].push(f);
  });
  days.sort();
  var groups = days.map(function (d) {
    var tag = schedDayTag(show, d);
    return '<div class="ph-day"><div class="ph-dh"><b>' + esc(fmtDayDate(d)) + '</b>' +
      (tag ? '<span class="ph-dtag">' + esc(tag) + '</span>' : '') +
      '<span class="ph-dn">' + byDay[d].length + ' photo' + (byDay[d].length === 1 ? '' : 's') + '</span></div>' +
      '<div class="ph-masonry">' + byDay[d].map(photoCard).join('') + '</div></div>';
  }).join('') || '<div class="empty">Nothing matches that filter.</div>';

  return bar + groups +
    '<div class="hint">' + icon('server') + '<span>Originals live on the NAS — <span class="mono">' + esc(phNasHint(show)) +
    '</span> — the app holds metadata + a thumbnail. The ★ picks feed the post-event client recap.</span></div>';
}

/* ---- overview strip: recap picks / latest, linking into the gallery ------- */
function photoStrip(show) {
  var photos = photosForShow(show.id);
  if (!photos.length) return '';
  var picksN = photos.filter(function (f) { return f.recap_pick; }).length;
  var thumbs = recapStripPhotos(show.id, 5).map(function (f) {
    return '<button class="ph-th" ' + act('openViewer', f.id) + ' title="' + esc(f.caption || f.name) + '">' +
      '<img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '" loading="lazy">' +
      (f.recap_pick ? '<span class="st">' + icon('star') + '</span>' : '') + '</button>';
  }).join('');
  return '<div class="panel"><h3>Photos · ' + photos.length + (picksN ? ' <span style="color:var(--warn)">· ' + picksN + ' picks</span>' : '') + '</h3>' +
    '<div class="ph-strip">' + thumbs + '</div>' +
    '<button class="n-more" ' + act('gotoTab', null, 'photos') + '>' + inlineIcon('cam') + ' Open the photo gallery</button></div>';
}

/* ============================================================== recap tab --
   The post-event client recap (recap pass): the closeout deliverable, drafted
   by the show owner's agent from the folder's own record and held DRAFT-FIRST
   until a human edits and approves it. Rendered as a live document — every
   section edits in place while it is a draft, using the photo-caption editor's
   pattern (one open editor at a time, Save / Cancel, api.* does the guarding).

   The tab never composes client text itself: it renders recap.body, which the
   content firewall in data.js already guaranteed is client-safe.
   ========================================================================== */
var RECAP_UI = { edit: null };     /* 'headline' | 'closing' | 'n:<i>' | 'h:<i>' | 's:<i>' */

function rcPen(show, key, title) {
  return '<button class="iconbtn rc-pen" title="' + esc(title) + '" ' + act('rcEdit', show.id, key) + '>' + icon('pencil') + '</button>';
}
function rcDel(show, key, title) {
  return '<button class="iconbtn rc-pen" title="' + esc(title) + '" ' + act('rcDel', show.id, key) + '>' + icon('trash') + '</button>';
}
/* one open editor at a time — #rcIn (+ #rcIn2 for a stat's value) */
function rcEditor(show, key, value, rows, second) {
  return '<div class="rc-ed">' +
    (second == null
      ? '<textarea id="rcIn" class="note-in" rows="' + Number(rows || 2) + '">' + esc(value) + '</textarea>'
      : '<div class="rc-ed2"><input id="rcIn" class="cell-in" value="' + esc(value) + '" placeholder="label">' +
        '<input id="rcIn2" class="cell-in" value="' + esc(second) + '" placeholder="value"></div>') +
    '<div class="rc-edbtns"><span class="rc-edhint">' + inlineIcon('lock') + ' Client-facing — internal numbers are refused</span>' +
    '<button class="btn sm ghost" ' + act('rcCancel') + '>Cancel</button>' +
    '<button class="btn sm primary" ' + act('rcSave', show.id, key) + '>' + icon('check') + 'Save</button></div></div>';
}

function recapBanner(show, rec) {
  var m = recapStatusMeta(rec);
  var who = actorName(rec.generated_by);
  if (rec.status === 'draft') {
    return '<div class="rc-banner draft"><div class="rcb-i">' + icon('bolt') + '</div>' +
      '<div class="rcb-t"><b>Draft — awaiting review</b>' +
      '<span>Drafted by ' + esc(who) + ' ' + esc(fmtTs(rec.generated_at)) +
      (rec.edited_by ? ' · edited by ' + esc(firstName(rec.edited_by)) + ' ' + esc(fmtTs(rec.edited_at)) : '') +
      ' · nothing leaves until a human approves it.</span>' + provBadge(rec.provenance) + '</div>' +
      '<span class="pill ' + esc(m.pill) + '"><span class="dot"></span>' +
      esc(canApproveRecap(show) ? 'Waiting on you' : 'Waiting on ' + (firstName(show.owner) || 'the owner')) +
      '</span></div>';
  }
  if (rec.status === 'approved') {
    return '<div class="rc-banner approved"><div class="rcb-i">' + icon('checkC') + '</div>' +
      '<div class="rcb-t"><b>Approved by ' + esc(userName(rec.approved_by)) + '</b>' +
      '<span>' + esc(fmtTs(rec.approved_at)) + ' · locked for send. Drafted by ' + esc(who) + '.</span></div>' +
      '<span class="pill go"><span class="dot"></span>Approved</span></div>';
  }
  return '<div class="rc-banner sent"><div class="rcb-i">' + icon('send') + '</div>' +
    '<div class="rcb-t"><b>Sent to ' + esc(rec.sent_to || 'the client') + '</b>' +
    '<span>' + esc(fmtTs(rec.sent_at)) + ' · recorded by hand — this app has no outbound path.</span></div>' +
    '<span class="pill idle">Sent</span></div>';
}

function recapActionBar(show, rec) {
  var editable = canEditRecap(show) && rec.status === 'draft';
  var approver = canApproveRecap(show);
  var b = [];
  if (rec.status === 'draft') {
    if (canEditRecap(show)) b.push('<button class="btn sm ghost" ' + act('rcGenerate', show.id) + ' title="Replaces this draft — including your edits — from the folder’s current record">' + icon('refresh') + 'Regenerate</button>');
    if (approver) b.push('<button class="btn sm primary" ' + act('rcApprove', show.id) + '>' + icon('checkC') + 'Approve</button>');
  } else if (rec.status === 'approved') {
    if (canEditRecap(show)) b.push('<button class="btn sm primary" ' + act('rcMarkSent', show.id) + '>' + icon('send') + 'Mark sent</button>');
    if (approver) b.push('<button class="btn sm ghost" ' + act('rcReopen', show.id) + '>' + icon('pencil') + 'Reopen for edits</button>');
  }
  b.push('<button class="btn sm ghost" ' + act('rcPreview', show.id) + '>' + icon('eye') + 'View sheet</button>');
  b.push('<button class="btn sm ghost" ' + act('rcPrint', show.id) + '>' + icon('print') + 'Print</button>');
  return '<div class="rc-bar">' +
    '<span class="rc-barlbl">' + (editable ? inlineIcon('pencil') + ' Editing the draft in place' : inlineIcon('lock') + ' Read-only') + '</span>' +
    '<span style="flex:1"></span>' + b.join('') + '</div>';
}

function recapPhotoStrip(show, rec, editable) {
  var photos = recapPhotos(rec);
  var cards = photos.map(function (f, i) {
    var ctrl = editable
      ? '<div class="rcp-ctl">' +
        '<button class="iconbtn" title="Move earlier" ' + act('rcPhotoMove', f.id, 'up') + '>' + icon('chevL') + '</button>' +
        '<button class="iconbtn" title="Move later" ' + act('rcPhotoMove', f.id, 'down') + '>' + icon('chevR') + '</button>' +
        '<button class="iconbtn" title="Remove from the recap" ' + act('rcPhotoRemove', f.id) + '>' + icon('x') + '</button></div>'
      : '';
    return '<div class="rc-ph"><div class="rcp-fig"><img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '" loading="lazy">' +
      '<span class="rcp-n">' + (i + 1) + '</span>' + ctrl + '</div>' +
      '<div class="rcp-cap">' + esc(f.caption || f.name) + '</div></div>';
  }).join('') || '<div class="empty" style="padding:18px">No photos on this recap yet.</div>';
  var pool = editable ? recapPhotoPool(rec, show.id) : [];
  var add = pool.length
    ? '<div class="rc-add"><span class="rc-addl">' + inlineIcon('plus') + ' Add from this show’s gallery</span>' +
      pool.slice(0, 8).map(function (f) {
        return '<button class="rc-addth" title="' + esc(f.caption || f.name) + '" ' + act('rcPhotoAdd', f.id) + '>' +
          '<img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '" loading="lazy">' +
          (f.recap_pick ? '<span class="st">' + icon('star') + '</span>' : '') + '</button>';
      }).join('') + '</div>'
    : '';
  return '<div class="rc-blk"><div class="rc-lbl">Photos · ' + photos.length +
    '<span class="rc-lsub">the ★ recap picks, in the order the client sees them</span></div>' +
    '<div class="rc-phs">' + cards + '</div>' + add + '</div>';
}

function tabRecap(show) {
  var rec = recapForShow(show.id);

  /* ---- empty state — the closeout step nobody has taken yet -------------- */
  if (!rec) {
    return '<div class="gear-empty">' + icon('send') +
      '<div style="font-weight:600;font-size:14px">No recap yet — generate a draft from this show’s data</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:500px;margin-left:auto;margin-right:auto;line-height:1.5">' +
      'The post-strike closeout: the show owner’s agent writes what happened, the highlights and the show stats out of this folder’s own record, and pulls in the photos someone starred as recap picks. You edit it, you approve it, and only then can it be marked sent — the app has no way to send anything by itself.</div>' +
      (canEditRecap(show)
        ? '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px;flex-wrap:wrap">' +
          '<button class="btn primary" ' + act('rcGenerate', show.id) + '>' + icon('bolt') + 'Generate a draft</button>' +
          (photoCount(show.id) ? '<button class="btn ghost" ' + act('gotoTab', null, 'photos') + '>' + icon('star') + 'Star recap picks first</button>' : '') +
          '</div>'
        : '<div class="perm-note" style="margin-top:14px">Drafting a recap requires pm, manager or admin.</div>') +
      '</div>';
  }

  var b = rec.body || {};    /* api.js already guards rec.body — match it here */
  var editable = canEditRecap(show) && rec.status === 'draft';

  /* ---- headline --------------------------------------------------------- */
  var head = '<div class="rc-blk"><div class="rc-lbl">Headline</div>' +
    (RECAP_UI.edit === 'headline' && editable
      ? rcEditor(show, 'headline', b.headline, 2)
      : '<div class="rc-row"><h2 class="rc-headline">' + esc(b.headline) + '</h2>' +
        (editable ? rcPen(show, 'headline', 'Edit the headline') : '') + '</div>') + '</div>';

  /* ---- narrative --------------------------------------------------------- */
  var paras = (b.narrative || []).map(function (p, i) {
    var key = 'n:' + i;
    if (RECAP_UI.edit === key && editable) return rcEditor(show, key, p, 5);
    return '<div class="rc-row rc-para"><p>' + esc(p) + '</p>' +
      (editable ? rcPen(show, key, 'Edit this paragraph') + ((b.narrative.length > 1) ? rcDel(show, key, 'Remove this paragraph') : '') : '') + '</div>';
  }).join('');
  var narr = '<div class="rc-blk"><div class="rc-lbl">Narrative<span class="rc-lsub">what happened, in the client’s language</span></div>' +
    paras + (editable ? '<button class="rc-addbtn" ' + act('rcAdd', show.id, 'narrative') + '>' + icon('plus') + 'Add a paragraph</button>' : '') + '</div>';

  /* ---- highlights -------------------------------------------------------- */
  var hls = (b.highlights || []).map(function (h, i) {
    var key = 'h:' + i;
    if (RECAP_UI.edit === key && editable) return rcEditor(show, key, h, 2);
    return '<div class="rc-row rc-hlrow"><span class="rc-bullet"></span><span class="rc-hltx">' + esc(h) + '</span>' +
      (editable ? rcPen(show, key, 'Edit this highlight') + rcDel(show, key, 'Remove this highlight') : '') + '</div>';
  }).join('') || '<div class="empty" style="padding:14px">No highlights yet.</div>';
  var hlBlk = '<div class="rc-blk"><div class="rc-lbl">Highlights<span class="rc-lsub">from the completed lanes + the starred photos</span></div>' +
    hls + (editable ? '<button class="rc-addbtn" ' + act('rcAdd', show.id, 'highlight') + '>' + icon('plus') + 'Add a highlight</button>' : '') + '</div>';

  /* ---- stats — client-safe fields only ----------------------------------- */
  var stats = (b.stats || []).map(function (st, i) {
    var key = 's:' + i;
    if (RECAP_UI.edit === key && editable) return rcEditor(show, key, st.label, 1, st.value);
    return '<div class="rc-stcell"><span>' + esc(st.label) + '</span><b>' + esc(st.value) + '</b>' +
      (editable ? '<div class="rc-stctl">' + rcPen(show, key, 'Edit this stat') + rcDel(show, key, 'Remove this stat') + '</div>' : '') + '</div>';
  }).join('') || '<div class="empty" style="padding:14px">No stats yet.</div>';
  var statBlk = '<div class="rc-blk"><div class="rc-lbl">Show stats<span class="rc-lsub">client-safe figures only — no money ever reaches this list</span></div>' +
    '<div class="rc-stgrid">' + stats + '</div>' +
    (editable ? '<button class="rc-addbtn" ' + act('rcAdd', show.id, 'stat') + '>' + icon('plus') + 'Add a stat</button>' : '') + '</div>';

  /* ---- closing ----------------------------------------------------------- */
  var close = '<div class="rc-blk"><div class="rc-lbl">Closing</div>' +
    (RECAP_UI.edit === 'closing' && editable
      ? rcEditor(show, 'closing', b.closing, 3)
      : '<div class="rc-row rc-para"><p>' + esc(b.closing) + '</p>' +
        (editable ? rcPen(show, 'closing', 'Edit the closing') : '') + '</div>') + '</div>';

  var firewall = '<div class="hint" style="margin-top:16px">' + icon('lock') +
    '<span><b>Client-facing content firewall.</b> This document is built by one generator that can only read client-safe fields — no cost, no purchase order, no internal note is reachable from it — and every edit you type is checked on the way in. Try pasting a dollar figure into a paragraph: it will be refused, with the reason.</span></div>';
  var sendNote = '<div class="hint">' + icon('send') +
    '<span><b>“Mark sent” sends nothing.</b> It records that a person sent this recap and who it went to. No agent in this system has an outbound path, and neither does this app — the send itself happens in the owner’s own mail.</span></div>';

  return recapBanner(show, rec) + recapActionBar(show, rec) +
    '<div class="ov rc-ov"><div class="rc-doc">' + head + narr + hlBlk + statBlk +
    recapPhotoStrip(show, rec, editable) + close + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
    '<div class="panel"><h3>Sheet preview</h3>' +
    '<div class="rc-mini">' + recapSheet(show, rec) + '</div>' +
    '<button class="n-more" ' + act('rcPreview', show.id) + '>' + inlineIcon('eye') + ' Open the full sheet</button></div>' +
    notesPanel('show', show.id, { title: 'Closeout notes', collapse: 1 }) +
    '</div></div>' + firewall + sendNote;
}

/* ---- overview: the quiet closeout line when a recap exists ---------------- */
function recapOverviewLine(show) {
  var rec = recapForShow(show.id);
  if (!rec) return '';
  var m = recapStatusMeta(rec);
  var sub = rec.status === 'draft' ? 'drafted by ' + actorName(rec.generated_by) + ' · awaiting review'
    : rec.status === 'approved' ? 'approved by ' + firstName(rec.approved_by) + ' · ready to send'
    : 'sent ' + fmtDate(rec.sent_at) + (rec.sent_to ? ' to ' + rec.sent_to : '');
  return '<div class="panel rc-ovline"><h3>Closeout · client recap</h3>' +
    '<button class="rc-ovbtn" ' + act('gotoTab', null, 'recap') + '>' +
    '<span class="rc-ovi">' + icon('send') + '</span>' +
    '<span class="rc-ovt"><b>' + esc(recapPhotos(rec).length + ' photos · ' + ((rec.body || {}).highlights || []).length + ' highlights') + '</b>' +
    '<span>' + esc(sub) + '</span></span>' +
    '<span class="pill ' + esc(m.pill) + '"><span class="dot"></span>' + esc(m.short) + '</span></button></div>';
}

/* ---- files tab: an approved recap presents as a DELIVERABLE, not a doc ----
   It is deliberately not a files row — it never touches the Files or Photos
   counts. It uses the file-card visual language and opens the client sheet. */
function recapFilesBlock(show) {
  var rec = recapForShow(show.id);
  if (!rec || rec.status === 'draft') return '';
  var m = recapStatusMeta(rec);
  return '<div class="files-head" style="margin-top:0"><h3>Deliverables · 1</h3>' +
    '<span class="pill ' + esc(m.pill) + '"><span class="dot"></span>' + esc(m.label) + '</span></div>' +
    '<div class="file-grid" style="margin-bottom:18px">' +
    '<button class="file deliv" ' + act('rcPreview', show.id) + '>' +
    '<div class="thumb deliv">' + icon('send') + '<span class="ext">recap</span></div>' +
    '<div class="fb"><b>' + esc((rec.body || {}).headline) + '</b><span>' +
    esc('Client recap · ' + (rec.status === 'sent'
      ? 'sent ' + fmtDate(rec.sent_at) + (rec.sent_to ? ' to ' + rec.sent_to : '')
      : 'approved ' + fmtDate(rec.approved_at) + ' by ' + firstName(rec.approved_by))) + '</span></div></button></div>';
}

/* ---- bell row: a draft recap waiting on the person who can approve it ----- */
function recapReviewRow(rec) {
  var s = SHOWS_BY_ID[rec.show_id];
  var n = ((rec.body || {}).photo_ids || []).length;
  return '<div class="feed-item proposed">' +
    '<div class="fico">' + icon('send') + '</div>' +
    '<div class="ftx"><b>' + esc(actorName(rec.generated_by)) + '</b> drafted the client recap — ' + esc((rec.body || {}).headline) +
    '<span class="fsub">' + esc((s ? showLabel(s) : '') + ' · ' + n + ' photo' + (n === 1 ? '' : 's') + ' · nothing goes out until you approve it') + '</span>' +
    provBadge(rec.provenance) +
    '<div class="fbtns"><button class="btn sm primary" ' + act('rcReview', rec.show_id) + '>' + icon('eye') + 'Review</button></div></div></div>';
}

/* ---- bell row for a proposed photo (renderInbox delegates here) ----------- */
function photoProposalRow(f) {
  var s = SHOWS_BY_ID[f.show_id];
  return '<div class="feed-item proposed">' +
    '<div class="ph-bth"><img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '"></div>' +
    '<div class="ftx"><b>' + esc(actorLabel(f.uploaded_by, f.provenance)) + '</b> proposed a photo — ' + esc(f.caption || f.name) +
    '<span class="fsub">' + esc(s ? showLabel(s) : '') + '</span>' + provBadge(f.provenance) +
    '<div class="fbtns"><button class="btn sm primary" ' + act('photoConfirm', f.id) + '>' + icon('check') + 'Confirm</button>' +
    '<button class="btn sm ghost" ' + act('photoReject', f.id) + '>' + icon('x') + 'Reject</button>' +
    '<button class="btn sm ghost" ' + act('openViewer', f.id) + '>' + icon('eye') + 'View</button></div></div></div>';
}

/* ============================================================ reports ------
   F2 · TECH SHOW REPORTS — the obligation, and who still owes one.
   ----------------------------------------------------------------------------
   TWO AUDIENCES, ONE TAB:

     a TECH sees exactly one thing — their own report, and an editor if they
     still owe it. Not the roster, not the bodies, not who else is late. Report
     prose is candid by design ("the venue's power was wrong, we lost an hour")
     and it is not team-wide reading.

     a PM/ADMIN sees the "waiting on" list, every body, and the three levers
     they actually have: nag, read, mark reviewed. They CANNOT write one. A
     report attributed to a person who did not write it is worse than a missing
     report, so there is no affordance for it anywhere.

   Sign-off is NOT required. Filing completes the obligation and closeout counts
   FILED, never REVIEWED — requiring a signature would let an inattentive pm
   block a tech's obligation from ever clearing, which is the opposite of the
   adoption lever this is meant to be.
   ========================================================================== */
var REPORT_UI = { editing: null };   /* report id being written */

function reportStatusPill(r) {
  var m = TECH_REPORT_STATUS[r.status] || TECH_REPORT_STATUS.owed;
  return '<span class="pill ' + esc(m.pill) + '"><span class="dot"></span>' + esc(m.label) + '</span>';
}
function reportEditor(rep, show) {
  /* D4's promise, kept: three UI strings said "or attach the document you
     already have" and tech_reports.file_id sat unwritten. The chip names the
     attached doc when one exists; the button opens the picker (a file already
     on this show, or a fresh upload) — either way the write is the same
     file_id the backend always accepted. */
  var doc = rep.file_id ? FILES_BY_ID[rep.file_id] : null;
  var attachRow = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">' +
    (doc
      ? '<span class="tag" title="Filed with this report">' + inlineIcon('doc') + ' ' + esc(doc.name) + '</span>'
      : '') +
    '<button class="btn sm ghost" ' + act('repAttach', rep.id) + '>' + icon('link') +
      (doc ? 'Replace the document' : 'Attach the document you already have') + '</button></div>';
  return '<div class="rep-editor" data-report="' + Number(rep.id) + '">' +
    '<textarea class="rep-in" id="repIn' + Number(rep.id) + '" rows="7" placeholder="' +
    esc('What happened on site. Gear that failed or needs attention, venue notes worth writing into ' +
        'the next advance, hours, anything the next crew should know. Plain words are fine.') +
    '">' + esc(rep.body || '') + '</textarea>' +
    attachRow +
    '<div class="rep-erow">' +
    '<span class="rep-hint">' + inlineIcon('lock') +
      'Internal. This never reaches a client — the recap generator cannot read it.</span>' +
    (REPORT_UI.editing ? '<button class="btn sm ghost" ' + act('repCancel') + '>Cancel</button>' : '') +
    '<button class="btn sm primary" ' + act('repSave', rep.id) + '>' + icon('check') +
      (rep.status === 'owed' ? 'File my report' : 'Save changes') + '</button>' +
    '</div></div>';
}
function reportCard(rep, show, opts) {
  opts = opts || {};
  var mine = ownsReport(rep);
  var u = ROSTER[rep.username];
  var doc = rep.file_id ? FILES_BY_ID[rep.file_id] : null;
  var meta = [];
  if (rep.filed_at) meta.push('filed ' + fmtDate(String(rep.filed_at).slice(0, 10)));
  else if (rep.due_date) meta.push('due ' + fmtDate(rep.due_date));
  if (rep.reviewed_at) meta.push('reviewed by ' + (userName(rep.reviewed_by) || rep.reviewed_by));
  if (rep.status === 'owed' && rep.nag_count) meta.push(rep.nag_count + ' nag' + (rep.nag_count === 1 ? '' : 's'));

  var acts = [];
  if (mine && rep.status !== 'reviewed' && REPORT_UI.editing !== rep.id) {
    acts.push('<button class="n-act" ' + act('repEdit', rep.id) + '>' + inlineIcon('pencil') +
      (rep.status === 'owed' ? 'Write it' : 'Revise') + '</button>');
  }
  /* the pm's three levers — never a fourth one that writes */
  if (canReviewReports() && rep.status === 'filed') {
    acts.push('<button class="n-act" ' + act('repReview', rep.id) + '>' + inlineIcon('checkC') + 'Mark reviewed</button>');
  }
  if (canReviewReports() && rep.status === 'reviewed') {
    acts.push('<button class="n-act" ' + act('repReopen', rep.id) + '>' + inlineIcon('refresh') + 'Reopen</button>');
  }
  if (canReviewReports() && rep.status === 'owed' && canEditFolderOf(show)) {
    acts.push('<button class="n-act" ' + act('repNag', rep.id) + '>' + inlineIcon('bell') + 'Nag</button>');
  }
  if (doc) {
    acts.push('<button class="n-act" ' + act('openViewer', doc.id) + '>' + inlineIcon('doc') + 'Open the document</button>');
  }

  var body = '';
  if (REPORT_UI.editing === rep.id && mine && rep.status !== 'reviewed') {
    body = reportEditor(rep, show);
  } else if (rep.status === 'owed') {
    body = '<div class="rep-empty">' + (mine
      ? 'You have not filed this yet. It is required — write it here or attach the document you already have.'
      : 'Not filed yet.') + '</div>';
  } else if (canReadReport(rep)) {
    body = '<div class="rep-body">' + esc(rep.body || '(the document is attached instead)') + '</div>';
  } else {
    body = '<div class="rep-empty">Filed. The body is readable by ' + esc(firstName(rep.username) || rep.username) +
      ', and by pms and admins.</div>';
  }

  return '<div class="rep-card ' + esc(rep.status) + (mine ? ' mine' : '') + '">' +
    '<div class="rep-h">' + (av(rep.username) || '<span class="avatar" style="background:var(--surface-3)">?</span>') +
    '<div class="rep-who"><b>' + esc(u ? u.name : rep.username) + (mine ? ' · you' : '') + '</b>' +
    '<span>' + esc(rep.role_on_site || (u ? u.title : '')) + (meta.length ? ' · ' + esc(meta.join(' · ')) : '') + '</span></div>' +
    reportStatusPill(rep) + '</div>' + body +
    (acts.length ? '<div class="rep-acts">' + acts.join('') + '</div>' : '') +
    '</div>';
}

function tabReports(show) {
  var all = reportsForShow(show.id);
  var viewAll = canViewAllReports();
  var mine = reportFor(show.id, ME);
  var sum = reportSummary(show.id);
  var noLogin = reportlessCrew(show.id);

  /* nothing owed and nothing filed: the show has not struck yet (or nobody on
     the crew has a login). Say which, and offer the pm the trigger. */
  if (!all.length) {
    var canStrike = canEditFolderOf(show) && RECAP_EDIT_ROLES[CURRENT_USER.role];
    return '<div class="panel"><h3>Show reports</h3>' +
      '<div class="empty">' + (show.struck_at
        ? 'This show is struck and nobody on the crew has a login, so no report is owed. ' +
          (noLogin.length ? noLogin.length + ' local hire' + (noLogin.length === 1 ? '' : 's') + ' on the sheet.' : '')
        : 'Reports are created for every crew member the moment the show strikes — automatically when ' +
          'the strike date passes, or now if it is already over.') + '</div>' +
      (canStrike && !show.struck_at
        ? '<div style="display:flex;justify-content:center;margin-top:14px">' +
          '<button class="btn primary" ' + act('markStruck', show.id) + '>' + icon('checkC') +
          'Mark struck — ask the crew for their reports</button></div>'
        : '') +
      '</div>';
  }

  var waiting = viewAll && sum.owed
    ? '<div class="waiting-on">' + inlineIcon('alert') + '<div><b>Waiting on ' + sum.owed + ' report' +
      (sum.owed === 1 ? '' : 's') + '</b><span>' +
      esc(sum.waiting_on.map(function (u) { return userName(u) || u; }).join(', ')) +
      '</span></div>' +
      (canEditFolderOf(show)
        ? '<button class="btn sm ghost" ' + act('repNagAll', show.id) + '>' + icon('bell') + 'Nag everyone still out</button>'
        : '') + '</div>'
    : (sum.complete
      ? '<div class="waiting-on ok">' + inlineIcon('checkC') + '<div><b>Every report is in.</b>' +
        '<span>' + sum.filed + ' of ' + sum.total + ' filed — one of the three things closeout waits for.</span></div></div>'
      : '');

  var rows = (viewAll ? all : all.filter(function (r) { return ownsReport(r); }))
    .map(function (r) { return reportCard(r, show); }).join('');

  var mineFirst = (!viewAll && !mine)
    ? '<div class="empty">You are not on this show’s crew, so no report is owed from you.</div>' : '';

  var localNote = viewAll && noLogin.length
    ? '<div class="perm-note">' + inlineIcon('users') + ' ' + noLogin.length + ' local hire' +
      (noLogin.length === 1 ? '' : 's') + ' on this crew (' +
      esc(noLogin.map(function (c) { return c.name; }).join(', ')) +
      ') — no login, so nobody to ask and no report created. That is the difference between the ' +
      'crew count and the report count.</div>'
    : '';

  return '<div class="panel"><h3>Show reports · ' + sum.filed + ' of ' + sum.total + ' filed</h3>' +
    waiting +
    '<div class="rep-list">' + rows + mineFirst + '</div>' +
    localNote +
    '<div class="perm-note">' + inlineIcon('lock') + ' Required after every show. Techs write their own ' +
    'and can never sign one off; pms and admins read them all, nag for them and may mark one reviewed. ' +
    '<b>Filing is what completes the obligation</b> — closeout counts filed, not reviewed. These are ' +
    'internal: the client-recap generator has no way to read one.</div>' +
    notesPanel('show', show.id, { title: 'Notes on this show', collapse: 1 }) +
    '</div>';
}

/* ============================================================ closeout -----
   F6 · the machine-checked closeout, rendered as three conditions with a
   live answer each. It is a READ of the record, never a checklist somebody
   ticks — which is the whole point of it being machine-checked.
   ========================================================================== */
function closeoutPanel(show) {
  var st = closeoutStatus(show.id);
  var end = show.strike_date || show.event_date;
  if (!end || end > TODAY_ISO) return '';        /* nothing to close out yet */

  var line = function (ok2, label, detail) {
    return '<div class="co-line ' + (ok2 ? 'ok' : 'out') + '">' +
      inlineIcon(ok2 ? 'checkC' : 'dot') +
      '<div><b>' + esc(label) + '</b><span>' + esc(detail) + '</span></div></div>';
  };
  var days = st.closeout_complete_at
    ? dayAge(String(st.closeout_complete_at).slice(0, 10)) : null;
  var foot = st.archived_at
    ? 'Archived ' + fmtDate(String(st.archived_at).slice(0, 10)) + '.'
    : st.complete
      ? 'Closed out' + (days != null ? ' ' + days + ' day' + (days === 1 ? '' : 's') + ' ago' : '') +
        ' — auto-archives ' + (days != null
          ? (days >= ARCHIVE_AFTER_DAYS ? 'on the next sweep' : 'in ' + (ARCHIVE_AFTER_DAYS - days) + ' days')
          : 'after ' + ARCHIVE_AFTER_DAYS + ' days') + '.'
      : 'Not closed out yet. All three have to hold before the ' + ARCHIVE_AFTER_DAYS + '-day archive clock starts.';

  return '<div class="panel closeout"><h3>Closeout' +
    (st.complete ? ' <span class="pill go" style="margin-left:6px"><span class="dot"></span>complete</span>' : '') + '</h3>' +
    line(st.recap_sent, 'Client recap sent',
      st.recap_status ? 'the recap is ' + st.recap_status : 'no recap drafted yet') +
    line(st.reports_complete, 'Every show report filed',
      st.reports_total
        ? st.reports_filed + ' of ' + st.reports_total + ' in' +
          (st.reports_owed && canViewAllReports()
            ? ' — waiting on ' + st.waiting_on.map(function (u) { return firstName(u) || u; }).join(', ')
            : (st.reports_owed ? ' — ' + st.reports_owed + ' still out' : ''))
        : 'nobody on the crew owes one') +
    line(st.finance_clear, 'No money waiting on paperwork',
      st.finance_exceptions ? st.finance_exceptions + ' item' + (st.finance_exceptions === 1 ? '' : 's') +
        ' on this show still missing a document' : 'clear') +
    '<div class="co-foot">' + esc(foot) + '</div>' +
    (canArchive() && !st.archived_at
      ? '<div style="display:flex;justify-content:flex-end;margin-top:10px">' +
        '<button class="btn sm ghost" ' + act('archiveShow', show.id) + '>' + icon('box') + 'Archive it now</button></div>'
      : '') +
    '<div class="perm-note">' + inlineIcon('bolt') + ' Machine-checked against the record — there is no ' +
    'box to tick. Reopening the recap or a late expense landing un-completes it again, and the clock ' +
    'restarts, because the paperwork really did come undone.</div>' +
    '</div>';
}
