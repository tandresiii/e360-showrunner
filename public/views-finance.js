/* ============================================================================
   e360 SHOWRUNNER — FINANCE (the accounting pass)
   ----------------------------------------------------------------------------
   viewFinance()     — the cross-project money picture accounting lives in:
                       stat strip · "waiting on me" chase list · finance feed ·
                       jobs P&L table.
   viewJobFinance()  — one job drilled in: budget vs actual by category,
                       expenses, docs, shows covered.
   tabFinancials()   — the per-show Financials tab (all event types).
   finSeasonStrip()  — per-job P&L cards on the season dashboard.

   Visibility rule (TEAM_FEEDBACK): budgets render for EVERYONE; margin /
   profitability renders only when canSeeFinance() — never both paths at once.
   ========================================================================== */

/* ---------------------------------------------------------- shared pieces -- */
/* A feed row's SHOW is optional. The inbox hands us `SHOWS_BY_ID[f.show_id]`,
   which is undefined for a doc anchored on a job or a PO rather than a show
   (and for anything whose show has not hydrated yet) — same show-less class as
   the 'po' / 'job_number' exceptions. Every branch below builds its sub-line
   from the parts that are actually there, and falls back to the file's own
   drill-in when there is no show to open. */
function feedItem(ev) {
  if (ev.type === 'doc') {
    var f = ev.file, s = ev.show;
    var job = JOBS_BY_ID[fileJobId(f)];
    var proposed = f.status === 'proposed';
    var line = '<b>' + esc(actorLabel(f.uploaded_by, f.provenance)) + '</b> ' +
      (proposed ? 'proposed a ' : 'filed a ') + esc(finKindLabel(f.kind).toLowerCase()) +
      ' — ' + esc(f.vendor || f.name);
    var subParts = [];
    if (s) subParts.push(esc(showLabel(s)));
    if (job) subParts.push('Job ' + esc(job.qb_job_number));
    var sub = subParts.join(' · ');
    var btns = proposed
      ? '<div class="fbtns"><button class="btn sm primary" ' + act('confirmDoc', f.id) + '>' + icon('check') + 'Confirm</button>' +
        '<button class="btn sm ghost" ' + act('rejectDoc', f.id) + '>' + icon('x') + 'Reject</button>' +
        '<button class="btn sm ghost" ' + act('openViewer', f.id) + '>' + icon('eye') + 'View</button></div>'
      : '';
    return '<div class="feed-item' + (proposed ? ' proposed' : '') + '"' +
      (proposed ? '' : ' ' + act('openViewer', f.id) + ' style="cursor:pointer"') + '>' +
      '<div class="fico">' + icon('dollar') + '</div>' +
      '<div class="ftx">' + line + '<span class="fsub">' + sub + '</span>' + provBadge(f.provenance) + btns + '</div>' +
      '<div class="fam"><span class="money">' + esc(fmtMoney(f.amount)) + '</span><span class="fdt">' + esc(fmtDate(ev.ts)) + '</span></div></div>';
  }
  if (ev.type === 'expense') {
    var e = ev.exp, se = ev.show;
    var jobE = JOBS_BY_ID[expenseJobId(e)];
    var eParts = [];
    if (se) eParts.push(esc(showLabel(se)));
    if (jobE) eParts.push('Job ' + esc(jobE.qb_job_number));
    eParts.push(esc(BUDGET_CATS[e.budget_line_category] || e.budget_line_category));
    return '<div class="feed-item"' + (se ? ' ' + act('openShowFin', se.id) + ' style="cursor:pointer"' : '') + '>' +
      '<div class="fico">' + icon('dollar') + '</div>' +
      '<div class="ftx"><b>' + esc(e.by ? firstName(e.by) : 'Someone') + '</b> recorded a cost — ' + esc(e.vendor) +
      ' <span class="mini dep">no doc yet</span>' +
      '<span class="fsub">' + eParts.join(' · ') + '</span></div>' +
      '<div class="fam"><span class="money">' + esc(fmtMoney(e.amount)) + '</span><span class="fdt">' + esc(fmtDate(ev.ts)) + '</span></div></div>';
  }
  if (ev.type === 'booking') {
    var b = ev.bk, sb = ev.show;
    var bParts = [esc(b.vendor)];
    if (sb) bParts.push(esc(showLabel(sb)));
    return '<div class="feed-item"' + (sb ? ' ' + act('openShowFin', sb.id) + ' style="cursor:pointer"' : '') + '>' +
      '<div class="fico">' + icon('truck') + '</div>' +
      '<div class="ftx"><b>' + esc(sb ? firstName(sb.owner) : 'Someone') + '</b> confirmed a booking — ' + esc(b.category) +
      (b.file_id ? '' : ' <span class="mini dep">no confirmation</span>') +
      '<span class="fsub">' + bParts.join(' · ') + '</span></div>' +
      '<div class="fam"><span class="money">' + esc(fmtMoney(b.amount)) + '</span><span class="fdt">' + esc(fmtDate(ev.ts)) + '</span></div></div>';
  }
  if (ev.type === 'po') {
    var po = ev.po;
    var pp = PROJECTS_BY_ID[po.project_id];
    return '<div class="feed-item" ' + act('openPO', po.id) + ' style="cursor:pointer">' +
      '<div class="fico">' + icon('cart') + '</div>' +
      '<div class="ftx"><b>' + esc(firstName(po.created_by)) + '</b> ordered ' + esc(po.po_number) + ' — ' + esc(po.vendor) +
      ' <span class="mini dep">committed</span>' +
      '<span class="fsub">' + esc((pp ? pp.name : '') + ' · ' + (PO_LINES_BY_PO[po.id] || []).length + ' lines') + '</span></div>' +
      '<div class="fam"><span class="money">' + esc(fmtMoney(poTotal(po))) + '</span><span class="fdt">' + esc(fmtDate(ev.ts)) + '</span></div></div>';
  }
  /* budget-line change */
  var evb = ev.ev;
  return '<div class="feed-item" ' + act('openJob', evb.job_id) + ' style="cursor:pointer">' +
    '<div class="fico">' + icon('scale') + '</div>' +
    '<div class="ftx"><b>' + esc(firstName(evb.actor)) + '</b> ' + esc(evb.action) +
    '<span class="fsub">' + esc(evb.detail) + '</span></div>' +
    '<div class="fam"><span class="fdt">' + esc(fmtDate(ev.ts)) + '</span></div></div>';
}

/* one row on the "waiting on me" chase list. kind 'po' (procurement) opens
   the PO itself; its Attach files the vendor invoice against the order.
   kind 'job_number' (POLISH_LIST #5) is the odd one out: what is missing is
   not a document but the QuickBooks number itself, so it has no show to open,
   no amount to show, and its button confirms the number instead of attaching
   paperwork. */
function excRow(x) {
  var isJobNum = x.kind === 'job_number';
  var ageCol = x.age == null ? 'var(--muted)' : x.age > 10 ? 'var(--crit)' : 'var(--warn)';
  var sub = isJobNum
    ? (x.job ? [x.job.client, x.job.description].filter(Boolean).join(' · ') : '')
    : (x.kind === 'booking' && x.vendor ? x.vendor + ' · ' : '') + (x.show ? showLabel(x.show) : '') +
      (x.job ? ' · Job ' + x.job.qb_job_number : '') +
      (x.category ? ' · ' + (BUDGET_CATS[x.category] || x.category) : '');
  /* the fallback branch used to assume every non-jobnum/non-po kind carries a
     show. It does today — but 'po' and 'job_number' both arrived show-less
     after this row was written, so the next show-less kind must not crash the
     chase list. No show to open = no click target, not a throw. */
  var open = isJobNum ? act('openJob', x.id)
    : x.kind === 'po' ? act('openPO', x.id)
    : x.show ? act('openShowFin', x.show.id) : '';
  return '<div class="exc-item" ' + open + '>' +
    '<span class="age" style="color:' + ageCol + '">' + (x.age == null ? '—' : x.age + 'd') + '</span>' +
    '<div class="txt"><b>' + esc(x.label) + '</b> <span class="mini dep">' +
    esc((isJobNum ? 'needs ' : 'no ') + x.missing) + '</span>' +
    (x.kind === 'po' ? ' <span class="mini">po</span>' : '') +
    (isJobNum ? ' <span class="mini">temp #</span>' : '') +
    '<span class="sub">' + esc(sub) + '</span></div>' +
    '<span class="money" style="font-size:12.5px">' + esc(x.amount != null ? fmtMoney(x.amount) : '—') + '</span>' +
    ownerChip(x.chase) +
    '<button class="btn sm ghost" ' + act('excAttach', x.id, x.kind) + '>' +
    icon(isJobNum ? 'check' : 'link') + (isJobNum ? 'Confirm #' : 'Attach') + '</button></div>';
}

/* ============================================================================
   FINANCE — the global view
   ========================================================================== */
function viewFinance(fin) {
  var gate = canSeeFinance(), st = fin.stats;

  var gatePill = gate
    ? '<span class="pill acc"><span class="dot"></span>Full visibility · finance</span>'
    : '<span class="pill idle">' + inlineIcon('lock') + ' Margin hidden · budgets visible to all</span>';

  var marginStat = gate
    ? '<div class="v" style="color:' + marginColor(st.marginPct) + '">' + esc(fmtMoney(st.margin)) + '<small>' + esc(fmtPct(st.marginPct)) + '</small></div>'
    : '<div class="v" style="font-size:14px;color:var(--muted);display:flex;align-items:center;gap:7px;padding-top:9px">' + inlineIcon('lock') + ' Finance-gated</div>';

  var stats = '<div class="stats">' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Waiting on me</div><div class="v" style="color:' + (st.exceptions ? 'var(--crit)' : 'var(--go)') + '">' + st.exceptions + '<small>' + esc(fmtMoney(st.excAmount)) + '</small></div></div>' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Docs this week</div><div class="v">' + st.docsWeek + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Proposed · review</div><div class="v" style="color:' + (st.proposed ? 'var(--warn)' : 'var(--text)') + '">' + st.proposed + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Actual vs budgeted</div><div class="v" style="font-size:24px;padding-top:3px">' + esc(fmtMoney(st.actual)) + '<small>of ' + esc(fmtMoney(st.budgeted)) + (st.committed ? ' · +' + esc(fmtMoney(st.committed)) + ' committed' : '') + '</small></div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">Portfolio margin</div>' + marginStat + '</div>' +
    '</div>';

  /* --- the chase list — accounting's #1 ask, pride of place ---------------- */
  var excRows = fin.exceptions.map(excRow).join('') ||
    '<div class="empty">Nothing outstanding — every booked cost has paperwork on file.</div>';
  var excCard = '<div class="card"><div class="card-h"><h3>Waiting on me · chase list</h3>' +
    (fin.exceptions.length ? '<span class="pill warn"><span class="dot"></span>' + fin.exceptions.length + ' open · ' + esc(fmtMoney(st.excAmount)) + '</span>' : '<span class="pill go"><span class="dot"></span>Clear</span>') +
    '</div>' + excRows +
    '<div class="perm-note" style="padding:12px 16px;margin-top:0">' + inlineIcon('bolt') + ' Booked or spent with no receipt / invoice / confirmation on file — chase <b>ahead</b> of the close, not after it. Your agent watches your inbox for these.</div></div>';

  /* --- jobs table — every deal, its burn, its margin ----------------------- */
  var jobRows = fin.jobs.map(function (jf) {
    var j = jf.job, p = jf.project;
    var marginCell = !gate ? finLock()
      : jf.marginPct == null ? '<span style="color:var(--muted)">—</span>'
        : '<span style="color:' + marginColor(jf.marginPct) + '" title="' + esc(fmtMoneySigned(jf.margin)) + '">' + esc(fmtPct(jf.marginPct)) + '</span>';
    return '<tr class="rowlink" ' + act('openJob', j.id) + '>' +
      '<td><div class="ev-name"><div class="ic">' + icon('dollar') + '</div><div><b>' + esc(j.qb_job_number) + '</b>' + tempBadge(j) + '<span>' + esc(j.client) + '</span></div></div></td>' +
      '<td>' + dealTag(j) + '</td>' +
      '<td style="color:var(--muted);font-size:12.5px">' + esc(p ? p.name : '—') + '</td>' +
      '<td class="money" style="color:var(--text-2)">' + esc(jf.budget_total ? fmtMoney(jf.budget_total) : '—') + '</td>' +
      '<td class="money">' + esc(jf.actual ? fmtMoney(jf.actual) : '—') + '</td>' +
      '<td class="money" style="color:' + (jf.committed ? 'var(--warn)' : 'var(--muted)') + '"' +
        (jf.committed ? ' title="on order — POs not yet received"' : '') + '>' + esc(jf.committed ? fmtMoney(jf.committed) : '—') + '</td>' +
      '<td class="money" style="color:var(--text-2)">' + esc(jf.billed ? fmtMoney(jf.billed) : '—') + '</td>' +
      '<td class="money">' + marginCell + '</td>' +
      '<td>' + burnBar(jf.actual, jf.budget_total, jf.committed) + '</td></tr>';
  }).join('');
  var jobsCard = '<div class="card"><div class="card-h"><h3>Jobs · budget vs actual vs billed</h3><span class="pill idle">' + fin.jobs.length + ' QuickBooks jobs</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Job</th><th>Deal</th><th>Folder</th><th class="money">Budgeted</th><th class="money">Actual</th><th class="money">Committed</th><th class="money">Billed</th><th class="money">Margin</th><th>Burn</th></tr></thead>' +
    '<tbody>' + jobRows + '</tbody></table></div>' +
    '<div class="perm-note" style="padding:12px 16px;margin-top:0">' + inlineIcon('scale') + ' <b>rental</b> = league deal, E360 retains the gear · <b>sale</b> = individual team agreement, hardware carried as cost-of-goods on the job. <b>Committed</b> = ordered-but-not-received POs — the hatched tier on the burn bars; it becomes actual as hardware lands.</div></div>';

  /* --- the feed ------------------------------------------------------------ */
  var FEED_N = 14;
  var feedRows = fin.feed.slice(0, FEED_N).map(feedItem).join('') ||
    '<div class="empty">No money events yet.</div>';
  var more = fin.feed.length > FEED_N
    ? '<div class="perm-note">+' + (fin.feed.length - FEED_N) + ' earlier — the full ledger lands with the backend.</div>' : '';
  var feedPanel = '<div class="panel"><h3>Finance feed · every money event</h3><div class="fin-feed">' + feedRows + '</div>' + more +
    '<div class="perm-note">' + inlineIcon('bolt') + ' Captured as a <b>byproduct</b> of people doing normal work — docs filed, costs landing, bookings confirming, budgets moving. Agent-filed rows carry their provenance; anything <b>proposed</b> waits for a human confirm.</div></div>';

  return '<div class="page-h"><div><h1>Finance</h1><div class="sub">Every money event across every folder, tagged to its project, show and QuickBooks job — filed as a byproduct of the work, not a favor to accounting. The chase list is what hasn’t reached the record yet.</div></div>' + gatePill + '</div>' +
    stats +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    '<div style="display:flex;flex-direction:column;gap:16px">' + excCard + jobsCard + '</div>' +
    feedPanel +
    '</div>';
}

/* ============================================================================
   JOB DRILL-IN — one deal, its whole money story
   ========================================================================== */
/* The client mirror of the server's requireBudgetRights(): manager+, OR the
   finance capability. Deliberately WIDER than canSeeFinance() — a manager who
   may not read margin may still set an allotment, because a budget is
   accountability and a margin is profit (TEAM_FEEDBACK). */
function canEditBudget(user) {
  var u = user || CURRENT_USER;
  return !!u && (u.role === 'admin' || u.role === 'manager' || !!u.finance);
}

function viewJobFinance(jf) {
  var gate = canSeeFinance(), j = jf.job, p = jf.project;
  /* remaining is the honest number: allotted − actual − committed-on-POs */
  var remaining = jf.budget_total - jf.actual - (jf.committed || 0);

  var marginStat = gate
    ? '<div class="v" style="color:' + marginColor(jf.marginPct) + '">' + esc(fmtMoneySigned(jf.margin)) + '<small>' + esc(fmtPct(jf.marginPct)) + '</small></div>'
    : '<div class="v" style="font-size:14px;color:var(--muted);display:flex;align-items:center;gap:7px;padding-top:9px">' + inlineIcon('lock') + ' Finance-gated</div>';

  var stats = '<div class="stats">' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Budgeted</div><div class="v" style="font-size:24px;padding-top:3px">' + esc(jf.budget_total ? fmtMoney(jf.budget_total) : '—') + '</div></div>' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Actual · to date</div><div class="v" style="font-size:24px;padding-top:3px">' + esc(jf.actual ? fmtMoney(jf.actual) : '—') +
      (jf.committed ? '<small style="color:var(--warn)">+' + esc(fmtMoney(jf.committed)) + ' committed</small>' : (jf.proposedCount ? '<small>+' + esc(fmtMoney(jf.proposedTotal)) + ' proposed</small>' : '')) + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:' + (remaining < 0 ? 'var(--crit)' : 'var(--go)') + '"></div><div class="k">Uncommitted budget</div><div class="v" style="font-size:24px;padding-top:3px;color:' + (remaining < 0 ? 'var(--crit)' : 'var(--text)') + '"' +
      (jf.committed ? ' title="allotted − actual − committed on open POs"' : '') + '>' + esc(jf.budget_total ? (remaining < 0 ? fmtMoneySigned(remaining) : fmtMoney(remaining)) : '—') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--idle)"></div><div class="k">Billed · contract</div><div class="v" style="font-size:24px;padding-top:3px">' + esc(jf.billed ? fmtMoney(jf.billed) : '—') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">Margin · live</div>' + marginStat + '</div>' +
    '</div>';

  /* budget vs actual by category — committed rides between them */
  var catRows = jf.lines.map(function (l) {
    var rem = l.allotted - l.actual - (l.committed || 0);
    return '<tr><td><b style="font-weight:600">' + esc(l.label) + '</b>' +
      (l.notes ? '<span style="display:block;color:var(--muted);font-size:11px">' + esc(l.notes) + '</span>' : '') + '</td>' +
      '<td class="money" style="color:var(--text-2)">' + esc(fmtMoney(l.allotted)) + '</td>' +
      '<td class="money">' + esc(l.actual ? fmtMoney(l.actual) : '—') + '</td>' +
      '<td class="money" style="color:' + (l.committed ? 'var(--warn)' : 'var(--muted)') + '">' + esc(l.committed ? fmtMoney(l.committed) : '—') + '</td>' +
      '<td class="money" style="color:' + (rem < 0 ? 'var(--crit)' : 'var(--text-2)') + '">' + esc(rem < 0 ? fmtMoneySigned(rem) : fmtMoney(rem)) + '</td>' +
      '<td>' + burnBar(l.actual, l.allotted, l.committed) +
      /* C1. POST /api/jobs/:id/budget and PUT/DELETE /api/budget-lines/:id all
         existed, wrote audit rows and fed budget_total — and the client had
         listBudgetLines and nothing else. Budget-vs-actual, the confirmed
         accounting requirement, had no entry surface, so every burn bar in the
         app read against an allotted of zero. */
      (canEditBudget()
        ? ' <button class="iconbtn" title="Edit this allotment" ' +
          act('editBudget', l.id, String(jf.job.id)) + '>' + icon('pencil') + '</button>'
        : '') +
      '</td></tr>';
  }).join('');
  var unbRows = jf.unbudgeted.map(function (l) {
    return '<tr><td><b style="font-weight:600;color:var(--warn)">' + esc(l.label) + '</b><span style="display:block;color:var(--muted);font-size:11px">no allotment set</span></td>' +
      '<td class="money" style="color:var(--muted)">—</td>' +
      '<td class="money" style="color:var(--crit)">' + esc(l.actual ? fmtMoney(l.actual) : '—') + '</td>' +
      '<td class="money" style="color:' + (l.committed ? 'var(--warn)' : 'var(--muted)') + '">' + esc(l.committed ? fmtMoney(l.committed) : '—') + '</td>' +
      '<td class="money" style="color:var(--muted)">—</td>' +
      '<td><span class="mini dep">unbudgeted</span>' +
      (canEditBudget()
        ? ' <button class="iconbtn" title="Set an allotment for this category" ' +
          act('addBudget', jf.job.id) + '>' + icon('plus') + '</button>'
        : '') +
      '</td></tr>';
  }).join('');
  var totCommitted = jf.committed || 0;
  var totRow = '<tr><td style="font-weight:700;border-top:2px solid var(--border-strong)">Total</td>' +
    '<td class="money" style="font-weight:600;border-top:2px solid var(--border-strong)">' + esc(fmtMoney(jf.budget_total)) + '</td>' +
    '<td class="money" style="font-weight:600;border-top:2px solid var(--border-strong)">' + esc(jf.actual ? fmtMoney(jf.actual) : '—') + '</td>' +
    '<td class="money" style="font-weight:600;border-top:2px solid var(--border-strong);color:' + (totCommitted ? 'var(--warn)' : 'var(--muted)') + '">' + esc(totCommitted ? fmtMoney(totCommitted) : '—') + '</td>' +
    '<td class="money" style="font-weight:600;border-top:2px solid var(--border-strong);color:' + (remaining < 0 ? 'var(--crit)' : 'var(--text)') + '">' + esc(jf.budget_total ? (remaining < 0 ? fmtMoneySigned(remaining) : fmtMoney(remaining)) : '—') + '</td>' +
    '<td style="border-top:2px solid var(--border-strong)">' + burnBar(jf.actual, jf.budget_total, totCommitted) + '</td></tr>';
  var budgetCard = '<div class="card"><div class="card-h"><h3>Budget vs committed vs actual · by category</h3>' +
    (jf.burnPct != null && jf.burnPct > 100 ? '<span class="pill crit"><span class="dot"></span>Over budget</span>' : '<span class="pill idle">live — updates as costs land</span>') +
    (canEditBudget()
      ? '<span style="flex:1"></span><button class="btn sm ghost" ' + act('addBudget', jf.job.id) + '>' +
        icon('plus') + 'Add budget line</button>'
      : '') + '</div>' +
    (jf.lines.length || jf.unbudgeted.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Category</th><th class="money">Allotted</th><th class="money">Actual</th><th class="money">Committed</th><th class="money">Remaining</th><th>Burn</th></tr></thead><tbody>' + catRows + unbRows + totRow + '</tbody></table></div>'
      : '<div class="empty" style="padding:22px;line-height:1.6">No budget lines yet.<br>' +
        '<span style="color:var(--muted);font-size:12px">Allotments are what every burn bar on this job reads ' +
        'against — without them the P&amp;L computes against zero and nothing can be over budget.' +
        (canEditBudget() ? ' Add one above.' : ' Accounting sets them.') + '</span></div>') +
    (totCommitted ? '<div class="perm-note" style="padding:12px 16px;margin-top:0">' + inlineIcon('cart') + ' <b>Committed</b> = ordered-but-not-received PO lines billing this job (hatched on the burn bar). It converts to actual as hardware is received.</div>' : '') +
    (jf.capexCommitted ? '<div class="perm-note" style="padding:0 16px 12px;margin-top:0">' + inlineIcon('box') + ' Plus ' + esc(fmtMoney(jf.capexCommitted)) + ' on order routed to <b>E360 inventory</b> — capex under this deal, not a job cost.</div>' : '') + '</div>';

  /* expenses */
  /* C4. The correction path, on the row it corrects. The server gate is pm
     rank + ownership of the owning project; canEditFolder(p) is that gate's
     client mirror, with its documented permissive fallback when p is thin. */
  var canFix = canEditFolder(p);
  var expRows = jf.expenses.map(function (x) {
    var e = x.e;
    var doc = e.file_id
      ? '<button class="iconbtn" style="width:26px;height:26px" title="Open doc" ' + act('openViewer', e.file_id) + '>' + icon('eye') + '</button>'
      : '<span class="mini dep">missing</span>';
    return '<tr><td class="mono" style="font-size:12px;color:var(--text-2)">' + esc(fmtDate(e.txn_date)) + '</td>' +
      '<td style="color:var(--muted);font-size:12.5px">' + esc(showLabel(x.show)) + '</td>' +
      '<td><b style="font-weight:600">' + esc(e.vendor) + '</b>' +
      (e.status === 'proposed' ? ' <span class="pill warn" style="padding:1px 8px;font-size:10px"><span class="dot"></span>Proposed</span>' : '') + '</td>' +
      '<td><span class="tag">' + esc(BUDGET_CATS[e.budget_line_category] || e.budget_line_category) + '</span></td>' +
      '<td>' + doc + '</td>' +
      '<td class="money">' + esc(fmtMoney(e.amount)) + '</td>' +
      '<td>' + (canFix
        ? '<button class="iconbtn" style="width:26px;height:26px" title="Correct this cost" ' +
          act('editExpense', e.id) + '>' + icon('pencil') + '</button>'
        : '') + '</td></tr>';
  }).join('');
  var expCard = '<div class="card"><div class="card-h"><h3>Expenses · ' + jf.expenses.length + '</h3><span class="pill idle">newest first</span></div>' +
    (jf.expenses.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Show</th><th>Vendor</th><th>Category</th><th>Doc</th><th class="money">Amount</th><th></th></tr></thead><tbody>' + expRows + '</tbody></table></div>'
      : '<div class="empty">No costs have landed against this job yet.</div>') + '</div>';

  /* docs + shows covered */
  var docCards = jf.docs.map(function (x) {
    var f = x.f;
    /* a receipt with real bytes downloads from the card — the same cell + chip
       the two Files grids use. Accounting asked for the PDF, not a preview. */
    return '<div class="file-cell"><button class="file" ' + act('openViewer', f.id) + '>' +
      '<div class="thumb">' + icon('dollar') + '<span class="ext">' + esc(f.ext) + '</span>' +
      (f.status === 'proposed' ? '<span class="ext" style="right:auto;left:8px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)">proposed</span>' : '') + '</div>' +
      '<div class="fb"><b>' + esc(f.vendor || f.name) + '</b><span>' + esc(finKindLabel(f.kind)) + ' · ' + esc(fmtMoney(f.amount)) + '</span></div></button>' +
      fileDownloadChip(f) + fileDeleteChip(f) + '</div>';
  }).join('') || '<div class="empty" style="padding:20px">No financial docs yet.</div>';
  var docsPanel = '<div class="panel"><h3>Financial docs · ' + jf.docs.length + '</h3><div class="file-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">' + docCards + '</div></div>';

  var showRows = jf.shows.map(function (s) {
    var isDefault = s.default_job_id === j.id;
    return '<div class="next-item" ' + act('openShow', s.id) + ' style="cursor:pointer"><div class="txt">' + esc(showLabel(s)) +
      '<span>' + esc(s.city + ' · ' + fmtDate(s.event_date)) + '</span></div>' +
      (isDefault ? '<span class="mini">default job</span>' : '<span class="mini dep">per-item</span>') + '</div>';
  }).join('') || '<div class="empty">No shows bill to this job.</div>';
  var showsPanel = '<div class="panel"><h3>Shows covered · ' + jf.shows.length + '</h3><div class="next-list">' + showRows + '</div>' +
    '<div class="perm-note">' + inlineIcon('scale') + ' <b>default job</b> = the show bills here unless an item overrides; <b>per-item</b> = only tagged cost items on that show bill to this deal.</div></div>';

  /* purchase orders feeding this job (procurement pass) */
  var jobPos = posForJob(j.id);
  var posPanel = '';
  if (jobPos.length) {
    var poRows = jobPos.map(function (x) {
      var risk = poWorstRisk(x.po);
      return '<div class="next-item" ' + act('openPO', x.po.id) + ' style="cursor:pointer"><div class="txt">' +
        '<span class="po-num" style="margin-right:7px">' + esc(x.po.po_number) + '</span><b style="font-weight:600">' + esc(x.po.vendor) + '</b>' +
        '<span>' + esc(x.lines + ' line' + (x.lines === 1 ? '' : 's') + ' bill here') + '</span></div>' +
        poStatusPill(x.po.status) + poRiskChip(risk) +
        '<span class="money" style="font-size:12.5px">' + esc(fmtMoney(x.amount)) + '</span></div>';
    }).join('');
    posPanel = '<div class="panel"><h3>Purchase orders · ' + jobPos.length + '</h3><div class="next-list">' + poRows + '</div>' +
      '<div class="perm-note">' + inlineIcon('cart') + ' Ordered = committed against this budget · received = actual. Reconciled orders are fully in the books.</div></div>';
  }

  return '<div class="page-h"><div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><h1>' + esc(j.client) + '</h1><span class="tag">' + esc(j.qb_job_number) + '</span>' + tempBadge(j) + dealTag(j) + (p ? typeTag(p.type) : '') + '</div>' +
    '<div class="sub">' + esc(j.description) + (p ? ' — in folder ' + esc(p.name) + '.' : '') +
    (j.deal_type === 'sale' ? ' Sale — hardware is cost-of-goods on this job.' : j.deal_type === 'rental' ? ' Rental — E360 retains the gear.' : '') +
    ' One deal = one QuickBooks job = one budget.</div></div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    /* POLISH_LIST #5. Accounting (admins + Candice) writes the real QuickBooks
       number here. Prominent while the job is on a placeholder, quiet once the
       number is real — but always available, because numbers get retyped. */
    (canSeeFinance()
      ? '<button class="btn' + (isTempJob(j) ? ' primary' : ' ghost') + '" ' + act('openJobNumber', j.id) + '>' +
        icon('check') + (isTempJob(j) ? 'Confirm job number' : 'Edit job number') + '</button>'
      : '') +
    /* C2. `jobs.contract_value` is `billed`, and margin is billed minus actual —
       so the single most-defended number in the codebase (stripMoney,
       MONEY_FIELDS, hasFinance on six surfaces) gated a field with no
       data-entry path anywhere. Prominent while it is unset, quiet once it is
       there — the same shape as the job-number button beside it. */
    (canSeeFinance()
      ? '<button class="btn' + (j.contract_value == null ? ' primary' : ' ghost') + '" ' +
        act('editContract', j.id) + '>' + icon('dollar') +
        (j.contract_value == null ? 'Set contract value' : 'Contract value') + '</button>'
      : '') +
    '<button class="btn ghost" ' + act('goFinance') + '>' + icon('scale') + 'Back to Finance</button>' +
    (p ? '<button class="btn ghost" ' + act('openFolder', p.id) + '>' + icon('folder') + 'Open folder</button>' : '') +
    '</div></div>' +
    stats +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    /* the NEEDS checklist (views-purchasing.js) rides between budget and
       actuals — it is the buying that has not become either yet */
    '<div style="display:flex;flex-direction:column;gap:16px">' + budgetCard + needsPanel(j) + expCard + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' + posPanel + docsPanel + showsPanel +
    notesPanel('job', j.id, { collapse: 2 }) + '</div>' +
    '</div>';
}

/* ============================================================================
   FINANCIALS TAB — money on one show, for every event type
   ========================================================================== */
function budgetPanel(jf, show, gate) {
  var multi = jf.shows.length > 1;
  var rows = jf.lines.map(function (l) {
    var pct = l.allotted ? l.actual / l.allotted * 100 : 0;
    var cPct = l.allotted ? (l.committed || 0) / l.allotted * 100 : 0;
    var aw = Math.min(pct, 100), cw = Math.max(0, Math.min(cPct, 100 - aw));
    var cm = cw > 0 ? '<i class="cm" style="width:' + cw + '%;background:' + burnColor(pct + cPct) + '"></i>' : '';
    return '<div class="ls-row"' + (l.committed ? ' title="' + esc(fmtMoney(l.committed) + ' committed on POs') + '"' : '') + '><div class="nm">' + esc(l.label) + '</div>' +
      '<div class="bar"><i style="width:' + aw + '%;background:' + burnColor(pct) + '"></i>' + cm + '</div>' +
      '<div class="bfrac">' + esc((l.actual ? fmtMoney(l.actual) : '$0') + (l.committed ? '+' + fmtMoney(l.committed) : '') + ' / ' + fmtMoney(l.allotted)) + '</div></div>';
  }).join('');
  var unb = jf.unbudgeted.map(function (l) {
    return '<div class="ls-row"><div class="nm" style="color:var(--warn)">' + esc(l.label) + '</div>' +
      '<div class="bar"><i style="width:100%;background:var(--crit)"></i></div>' +
      '<div class="bfrac" style="color:var(--crit)">' + esc(fmtMoney(l.actual) + ' / —') + '</div></div>';
  }).join('');
  return '<div class="panel"><h3>Budget · job ' + esc(jf.job.qb_job_number) + '</h3>' +
    (multi ? '<div class="perm-note" style="margin:-8px 0 12px">' + inlineIcon('layers') + ' Shared across ' + jf.shows.length + ' shows — every show’s actuals land against the same allotments.</div>' : '') +
    '<div class="lane-status">' + rows + unb + '</div>' +
    '<div class="glance" style="margin-top:14px">' +
    '<div class="g"><span class="k">Allotted</span><span class="mono">' + esc(fmtMoney(jf.budget_total)) + '</span></div>' +
    '<div class="g"><span class="k">Actual to date</span><span class="mono" style="color:' + burnColor(jf.burnPct) + '">' + esc(jf.actual ? fmtMoney(jf.actual) : '$0') + (jf.burnPct != null ? ' · ' + Math.round(jf.burnPct) + '%' : '') + '</span></div>' +
    (jf.committed ? '<div class="g"><span class="k">Committed · on order</span><span class="mono" style="color:var(--warn)" title="ordered-but-not-received POs billing this job">' + esc(fmtMoney(jf.committed)) + '</span></div>' : '') +
    (gate ? '<div class="g"><span class="k">Margin to date</span><span class="mono" style="color:' + marginColor(jf.marginPct) + '">' + esc(fmtMoneySigned(jf.margin) + (jf.marginPct != null ? ' · ' + fmtPct(jf.marginPct) : '')) + '</span></div>' : '') +
    '</div>' +
    '<div class="perm-note">' + inlineIcon(gate ? 'eye' : 'lock') + ' Budgets are visible to everyone on the show — that’s the accountability. ' +
    (gate ? 'Margin shows because you have finance visibility.' : 'Margin / profitability is visible to admins and accounting only.') + '</div></div>';
}

function tabFinancials(show) {
  var gate = canSeeFinance();
  var jf = show.default_job_id ? financeForJob(show.default_job_id) : null;
  var docs = show.files.filter(function (f) { return FIN_KINDS[f.kind]; });
  var exps = (show.expenses || []).slice().sort(function (a, b) { return a.txn_date < b.txn_date ? 1 : a.txn_date > b.txn_date ? -1 : b.id - a.id; });
  var spent = 0, pending = 0;
  exps.forEach(function (e) { if (e.status === 'proposed') pending += e.amount; else spent += e.amount; });
  var proposedDocs = docs.filter(function (f) { return f.status === 'proposed'; });
  /* a 'job_number' exception (POLISH_LIST #5) carries no show — it belongs to
     the job, not to any one date on the calendar */
  var excs = srExceptions().filter(function (x) { return x.show && x.show.id === show.id; });

  /* ---- empty state — a quiet invitation, not a dead end ------------------- */
  if (!docs.length && !exps.length) {
    var budget = jf && jf.lines.length ? budgetPanel(jf, show, gate) : '';
    return '<div class="gear-empty">' + icon('dollar') +
      '<div style="font-weight:600;font-size:14px">No financials on this show yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:470px;margin-left:auto;margin-right:auto;line-height:1.5">Receipts, invoices, POs and confirmations filed here reach Accounting’s feed automatically' +
      (jf ? ' — and every cost bills to job <b>' + esc(jf.job.qb_job_number) + '</b> unless an item overrides it.' : '.') + '</div>' +
      '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px;flex-wrap:wrap">' +
      '<button class="btn primary" ' + act('addFinDoc', show.id) + '>' + icon('plus') + 'Attach a doc</button>' +
      '<button class="btn ghost" ' + act('openAddExpense', show.id) + '>' + icon('dollar') + 'Add expense</button></div></div>' +
      (budget ? '<div style="margin-top:16px;max-width:560px">' + budget + '</div>'
        : '<div class="hint">' + icon('scale') + '<span>No budget lines yet either — <b>Candice</b> sets per-category allotments on the job' + (jf ? ' (' + esc(jf.job.qb_job_number) + ')' : '') + ' once the deal firms up.</span></div>');
  }

  /* ---- top strip — travel-left is the team-facing star -------------------- */
  var travel = jf ? jf.lines.filter(function (l) { return l.category === 'travel'; })[0] : null;
  var travelLeft = travel ? travel.allotted - travel.actual : null;
  var travelCol = travel == null ? 'var(--muted)'
    : travelLeft < 0 ? 'var(--crit)' : travelLeft <= travel.allotted * 0.15 ? 'var(--warn)' : 'var(--go)';
  var strip = '<div class="gtotals" style="margin-top:0;margin-bottom:16px">' +
    '<div class="gt"><div class="k">Travel budget left</div><div class="v" style="color:' + travelCol + '">' +
    (travel ? esc(travelLeft < 0 ? fmtMoneySigned(travelLeft) : fmtMoney(travelLeft)) + ' <small style="font-size:12px;color:var(--muted)">of ' + esc(fmtMoney(travel.allotted)) + '</small>' : '—') + '</div></div>' +
    '<div class="gt"><div class="k">Spent on this show</div><div class="v">' + esc(spent ? fmtMoney(spent) : '—') +
    (pending ? ' <small style="font-size:12px;color:var(--warn)">+' + esc(fmtMoney(pending)) + ' proposed</small>' : '') + '</div></div>' +
    '<div class="gt"><div class="k">Job budget burn</div><div class="v" style="color:' + burnColor(jf ? jf.burnPct : null) + '">' +
    (jf && jf.budget_total ? Math.round(jf.burnPct) + '<small style="font-size:12px;color:var(--muted)">%</small>' : '—') + '</div></div>' +
    '<div class="gt"><div class="k">Bills to</div><div class="v" style="font-size:15px">' + (jf ? esc(jf.job.qb_job_number) + ' ' + dealTag(jf.job) : '—') +
    (jf ? ' <small style="font-size:11px;color:var(--muted)">' + esc(jf.job.client) + '</small>' : '') + '</div></div></div>';

  /* ---- proposed docs — inline review, same rows as the feed --------------- */
  var proposedBlock = proposedDocs.length
    ? '<div class="panel" style="margin-bottom:16px;border-color:color-mix(in srgb,var(--warn) 35%,var(--border))"><h3>Proposed — awaiting review · ' + proposedDocs.length + '</h3>' +
      proposedDocs.map(function (f) { return feedItem({ type: 'doc', ts: f.created_at, id: f.id, file: f, show: show }); }).join('') + '</div>'
    : '';

  /* ---- expenses table ----------------------------------------------------- */
  /* C4. The pencil the audit's headline finding names: PUT /expenses/:id and
     its seam sat finished for a week while this table stayed inert text. Gated
     the same as the rest of the tab's writes — the folder's edit predicate. */
  var canFix = canEditFolderOf(show);
  var expRows = exps.map(function (e) {
    var override = e.job_id && e.job_id !== show.default_job_id ? JOBS_BY_ID[e.job_id] : null;
    var doc = e.file_id
      ? '<button class="iconbtn" style="width:26px;height:26px" title="Open doc" ' + act('openViewer', e.file_id) + '>' + icon('eye') + '</button>'
      : '<button class="btn sm ghost" ' + act('excAttach', e.id, 'expense') + '>' + icon('link') + 'Attach</button>';
    return '<tr><td class="mono" style="font-size:12px;color:var(--text-2)">' + esc(fmtDate(e.txn_date)) + '</td>' +
      '<td><b style="font-weight:600">' + esc(e.vendor) + '</b>' +
      (e.status === 'proposed' ? ' <span class="pill warn" style="padding:1px 8px;font-size:10px"><span class="dot"></span>Proposed</span>' : '') +
      (e.memo ? '<span style="display:block;color:var(--muted);font-size:11px">' + esc(e.memo) + '</span>' : '') + '</td>' +
      '<td><span class="tag">' + esc(BUDGET_CATS[e.budget_line_category] || e.budget_line_category) + '</span></td>' +
      '<td>' + (override ? jobChip(override) : '<span class="mini" title="bills to the show’s default job">default</span>') + '</td>' +
      '<td>' + doc + '</td>' +
      '<td class="money">' + esc(fmtMoney(e.amount)) + '</td>' +
      '<td>' + (canFix
        ? '<button class="iconbtn" style="width:26px;height:26px" title="Correct this cost" ' +
          act('editExpense', e.id) + '>' + icon('pencil') + '</button>'
        : '') + '</td></tr>';
  }).join('');
  var expCard = '<div class="card"><div class="card-h"><h3>Expenses · ' + exps.length + '</h3>' +
    '<button class="btn sm primary" ' + act('openAddExpense', show.id) + '>' + icon('plus') + 'Add expense</button></div>' +
    (exps.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Bills to</th><th>Doc</th><th class="money">Amount</th><th></th></tr></thead><tbody>' + expRows + '</tbody></table></div>'
      : '<div class="empty">No expenses recorded yet.</div>') + '</div>';

  /* ---- financial docs grid ------------------------------------------------ */
  var docCards = docs.map(function (f) {
    return '<div class="file-cell"><button class="file" ' + act('openViewer', f.id) + '>' +
      '<div class="thumb">' + icon('dollar') + '<span class="ext">' + esc(f.ext) + '</span>' +
      (f.status === 'proposed' ? '<span class="ext" style="right:auto;left:8px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)">proposed</span>' : '') + '</div>' +
      '<div class="fb"><b>' + esc(f.vendor || f.name) + '</b><span>' + esc(finKindLabel(f.kind)) + ' · ' + esc(fmtMoney(f.amount)) + (f.provenance ? ' · via agent' : '') + '</span></div></button>' +
      fileDownloadChip(f) + fileDeleteChip(f) + '</div>';
  }).join('');
  var docsBlock = '<div class="files-head" style="margin-top:16px"><h3>Financial docs · ' + docs.length + '</h3>' +
    '<button class="btn primary" ' + act('addFinDoc', show.id) + '>' + icon('plus') + 'Attach doc</button></div>' +
    '<div class="file-grid">' + docCards +
    '<button class="file" ' + act('addFinDoc', show.id) + ' style="border-style:dashed"><div class="thumb">' + icon('plus') + '</div><div class="fb"><b>Attach doc</b><span>receipt · invoice · po · confirmation</span></div></button></div>';

  /* ---- right rail: budget + this show's paperwork gaps -------------------- */
  var waitPanel = excs.length
    ? '<div class="panel"><h3>Waiting on paperwork · ' + excs.length + '</h3><div class="next-list">' +
      excs.map(function (x) {
        return '<div class="next-item"><div class="txt">' + esc(x.label) +
          '<span>' + esc((x.kind === 'booking' && x.vendor ? x.vendor + ' · ' : '') + 'no ' + x.missing + (x.age != null ? ' · ' + x.age + 'd' : '')) + '</span></div>' +
          '<span class="money" style="font-size:12px">' + esc(x.amount != null ? fmtMoney(x.amount) : '—') + '</span>' +
          '<button class="btn sm ghost" ' + act('excAttach', x.id, x.kind) + '>' + icon('link') + 'Attach</button></div>';
      }).join('') + '</div>' +
      '<div class="perm-note">' + inlineIcon('bolt') + ' On Accounting’s cross-project chase list until a doc lands here.</div></div>'
    : '';

  return strip + proposedBlock +
    '<div class="ov">' +
    '<div style="display:flex;flex-direction:column;gap:0">' + expCard + docsBlock + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
    (jf ? budgetPanel(jf, show, gate) : '') + waitPanel +
    '<div class="hint" style="margin-top:0">' + icon('bolt') + '<span>Your M365 agent can do this filing — it watches your inbox, matches each doc to the right show + job, and files high-confidence matches itself. Anything uncertain lands as <b>proposed</b> above.</span></div>' +
    '</div></div>';
}

/* ============================================================================
   SEASON P&L STRIP — per-job cards on the multi-show folder dashboard
   ========================================================================== */
function finSeasonStrip(project) {
  var jobs = project.jobs || [];
  if (!jobs.length) return '';
  var gate = canSeeFinance();
  var excN = 0;
  srExceptions().forEach(function (x) { if (x.show && x.show.project_id === project.id) excN++; });
  var tB = 0, tA = 0, tBud = 0, tC = 0;
  var byDeal = { rental: { n: 0, b: 0, a: 0 }, sale: { n: 0, b: 0, a: 0 } };

  var cards = jobs.map(function (j) {
    var jf = financeForJob(j.id);
    tB += jf.billed; tA += jf.actual; tBud += jf.budget_total; tC += jf.committed || 0;
    var dd = byDeal[j.deal_type];
    if (dd) { dd.n++; dd.b += jf.billed; dd.a += jf.actual; }
    var state = !jf.billed && !jf.actual ? '<span class="pill idle">In negotiation</span>'
      : jf.margin < 0 ? '<span class="pill crit"><span class="dot"></span>Underwater</span>'
        : (jf.burnPct != null && jf.burnPct > 100) ? '<span class="pill warn"><span class="dot"></span>Over budget</span>'
          : '<span class="pill go"><span class="dot"></span>Profitable</span>';
    var marginRow = gate
      ? '<div class="plrow"><span class="k">Margin</span><span class="money" style="color:' + marginColor(jf.marginPct) + '">' + esc(fmtMoneySigned(jf.margin)) + (jf.marginPct != null ? ' · ' + esc(fmtPct(jf.marginPct)) : '') + '</span></div>'
      : '<div class="plrow"><span class="k">Margin</span>' + finLock() + '</div>';
    var nDefault = project.shows.filter(function (s) { return s.default_job_id === j.id; }).length;
    var scope = nDefault ? nDefault + ' show' + (nDefault === 1 ? '' : 's') : 'per-item buys';
    return '<button class="plcard" ' + act('openJob', j.id) + ' title="' + esc(j.description) + '">' +
      '<div class="plh"><span class="tag">' + esc(j.qb_job_number) + '</span>' + tempBadge(j) + dealTag(j) + '<b>' + esc(j.client) + '</b></div>' +
      '<div class="plrow"><span class="k">Billed</span><span class="money">' + esc(fmtMoney(j.contract_value)) + '</span></div>' +
      '<div class="plrow"><span class="k">Actual · to date</span><span class="money">' + esc(jf.actual ? fmtMoney(jf.actual) : '—') + '</span></div>' +
      (jf.committed ? '<div class="plrow"><span class="k">On order</span><span class="money" style="color:var(--warn)">' + esc(fmtMoney(jf.committed)) + '</span></div>' : '') +
      marginRow + burnBar(jf.actual, jf.budget_total, jf.committed) +
      '<div class="plfoot">' + state + '<span class="mini">' + esc(scope) + '</span></div></button>';
  }).join('');

  var sumMargin = gate
    ? '<div class="plrow"><span class="k">Margin · to date</span><span class="money" style="color:' + marginColor(tB ? (tB - tA) / tB * 100 : null) + '">' + esc(fmtMoneySigned(tB - tA)) + '</span></div>'
    : '<div class="plrow"><span class="k">Margin · to date</span>' + finLock() + '</div>';
  /* rental vs sale at a glance — the two deal economics side by side */
  var dealRows = '';
  if (byDeal.rental.n && byDeal.sale.n) {
    dealRows = gate
      ? '<div class="plrow"><span class="k">Rentals · ' + byDeal.rental.n + '</span><span class="money" style="color:' + marginColor(byDeal.rental.b ? (byDeal.rental.b - byDeal.rental.a) / byDeal.rental.b * 100 : null) + '">' + esc(fmtMoneySigned(byDeal.rental.b - byDeal.rental.a)) + '</span></div>' +
        '<div class="plrow"><span class="k">Sales · ' + byDeal.sale.n + '</span><span class="money" style="color:' + marginColor(byDeal.sale.b ? (byDeal.sale.b - byDeal.sale.a) / byDeal.sale.b * 100 : null) + '">' + esc(fmtMoneySigned(byDeal.sale.b - byDeal.sale.a)) + '</span></div>'
      : '<div class="plrow"><span class="k">Deals</span><span class="money" style="color:var(--text-2)">' + byDeal.rental.n + ' rental · ' + byDeal.sale.n + ' sale</span></div>';
  }
  var sum = '<button class="plcard sum" ' + act('goFinance') + '>' +
    '<div class="plh"><b>Season to date</b>' +
    (excN ? '<span class="pill warn"><span class="dot"></span>' + excN + ' waiting</span>' : '<span class="pill go"><span class="dot"></span>Paperwork clean</span>') + '</div>' +
    '<div class="plrow"><span class="k">Billed</span><span class="money">' + esc(fmtMoney(tB)) + '</span></div>' +
    '<div class="plrow"><span class="k">Costs landed</span><span class="money">' + esc(tA ? fmtMoney(tA) : '—') + '</span></div>' +
    (tC ? '<div class="plrow"><span class="k">On order · committed</span><span class="money" style="color:var(--warn)">' + esc(fmtMoney(tC)) + '</span></div>' : '') +
    sumMargin + dealRows + burnBar(tA, tBud, tC) +
    '<div class="plfoot"><span class="mini">' + jobs.length + ' jobs · open Finance</span></div></button>';

  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;font-family:var(--font-body)">Season P&amp;L · by job</h3>' +
    (gate ? '<span class="pill acc"><span class="dot"></span>Live — billed − costs, as costs land</span>'
      : '<span class="pill idle">' + inlineIcon('lock') + ' Margin gated · burn visible to all</span>') + '</div>' +
    '<div class="plgrid">' + sum + cards + '</div>';
}
