/* ============================================================================
   e360 SHOWRUNNER — PURCHASING (procurement pass)
   ----------------------------------------------------------------------------
   viewPurchasing()  — the procurement cockpit: stat strip · delivery-risk
                       panel · approval queue · pipeline board (6 stages).
   viewPO()          — one PO drilled in: status stepper w/ the approval gate,
                       lines table (allocation + ownership), totals by job,
                       linked docs, delivery outlook, activity.
   poGearStrip()     — incoming POs inside a show's Gear tab.
   poRiskStrip()     — the procurement alert on a show's Overview.
   poSeasonFlag()    — the delivery-risk flag on season dashboard rows.

   The mechanic everywhere: ordered/shipped = COMMITTED (hatched on burn
   bars) · received = ACTUAL (expenses) · reconciled = invoice on file.
   ========================================================================== */

/* ---------------------------------------------------------- shared pieces -- */
function poJobs(po) {
  var seen = {}, out = [];
  (PO_LINES_BY_PO[po.id] || []).forEach(function (l) {
    var jid = poLineJobId(l);
    if (!jid || seen[jid]) return;
    seen[jid] = 1;
    if (JOBS_BY_ID[jid]) out.push(JOBS_BY_ID[jid]);
  });
  return out;
}
function poHasInventory(po) {
  return (PO_LINES_BY_PO[po.id] || []).some(function (l) { return l.ownership === 'inventory'; });
}
function poWorstRisk(po) {
  var rs = poRisks(po);
  if (!rs.length) return null;
  return rs.filter(function (r) { return r.level === 'crit'; })[0] || rs[0];
}
/* compact chips for card contexts */
function poRiskChip(risk) {
  if (!risk) return '';
  return '<span class="pill ' + (risk.level === 'crit' ? 'crit' : 'warn') + '" style="padding:1px 8px;font-size:10px" title="' +
    esc(risk.show.name + ' — ' + risk.why + ' (load-in ' + fmtDate(risk.show.load_in_date) + ')') + '">' +
    inlineIcon('truck') + ' ' + (risk.level === 'crit' ? 'late' : 'tight') + '</span>';
}
function poApprovalChip(po) {
  if (!poNeedsApproval(po)) return '';
  /* the threshold is server config (Settings can move it), so no surface may
     hardcode $5,000 — a chip quoting a stale number teaches the wrong rule */
  return '<span class="pill warn" style="padding:1px 8px;font-size:10px" title="Over the ' +
    esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + ' threshold — needs sign-off from an admin or Candice before ordering">' +
    inlineIcon('lock') + ' approval</span>';
}
function poInvoiceChip(po) {
  if (!poUnreconciled(po)) return '';
  return '<span class="mini dep" title="No vendor invoice on file — on Accounting’s chase list">no invoice</span>';
}

/* ---------------------------------------------------------------- PO card -- */
function poCard(po) {
  var lines = PO_LINES_BY_PO[po.id] || [];
  var jobs = poJobs(po);
  var sub = lines.length + ' line' + (lines.length === 1 ? '' : 's') +
    (po.expected_date ? ' · exp ' + fmtDate(po.expected_date) : (po.received_date ? ' · in ' + fmtDate(po.received_date) : ''));
  return '<button class="po-card" ' + act('openPO', po.id) + '>' +
    '<div class="po-top"><span class="po-num">' + esc(po.po_number) + '</span><span style="flex:1"></span>' +
    poRiskChip(poWorstRisk(po)) + poApprovalChip(po) + poInvoiceChip(po) + '</div>' +
    '<b class="po-vend">' + esc(po.vendor) +
    (/^TBD\b/i.test(po.vendor)
      ? ' <span class="mini dep" title="Vendor not chosen yet — open the PO and set it">set vendor</span>' : '') +
    '</b>' +
    '<div class="po-sub">' + esc(sub) + '</div>' +
    (po.provenance ? provBadge(po.provenance) : '') +
    '<div class="po-foot"><span class="money">' + esc(fmtMoney(poTotal(po))) + '</span><span style="flex:1"></span>' + jobsChip(jobs) + '</div></button>';
}

/* ---------------------------------------------------------- pipeline board - */
function poBoard(pos) {
  var cols = PO_STATUSES.map(function (st) {
    var m = PO_STATUS_META[st];
    var here = pos.filter(function (po) { return po.status === st; });
    var amt = here.reduce(function (a, po) { return a + poTotal(po); }, 0);
    var body = here.map(poCard).join('') || '<div class="lane-empty">none</div>';
    return '<div class="po-col"><div class="po-col-h"><span class="pd" style="background:' + esc(m.dot) + '"></span>' +
      '<b>' + esc(m.label) + '</b><span class="pc">' + here.length + '</span>' +
      '<span class="pt">' + esc(amt ? fmtMoney(amt) : '') + '</span></div>' +
      '<div class="po-col-b">' + body + '</div></div>';
  }).join('');
  return '<div class="po-board">' + cols + '</div>';
}

/* ------------------------------------------------------ delivery risk panel  */
function poRiskPanel(risks) {
  var rows = risks.map(function (r) {
    var col = r.level === 'crit' ? 'var(--crit)' : 'var(--warn)';
    return '<div class="exc-item" ' + act('openPO', r.po.id) + '>' +
      '<span class="age" style="color:' + col + '">' + inlineIcon('truck') + '</span>' +
      '<div class="txt"><b>' + esc(r.po.po_number + ' · ' + r.po.vendor) + '</b> ' +
      '<span class="pill ' + (r.level === 'crit' ? 'crit' : 'warn') + '" style="padding:1px 8px;font-size:10px"><span class="dot"></span>' + esc(r.why) + '</span>' +
      '<span class="sub">' + esc(showLabel(r.show) + ' · load-in ' + fmtDate(r.show.load_in_date) +
        (r.po.expected_date ? ' · expected ' + fmtDate(r.po.expected_date) : ' · no ETA')) + '</span></div>' +
      poStatusPill(r.po.status) +
      '<span class="money" style="font-size:12.5px">' + esc(fmtMoney(poTotal(r.po))) + '</span></div>';
  }).join('') ||
    '<div class="empty" style="padding:24px">Every open PO lands clear of its load-ins.</div>';
  var crit = risks.filter(function (r) { return r.level === 'crit'; }).length;
  return '<div class="card"><div class="card-h"><h3>Delivery risk · hardware vs load-ins</h3>' +
    (risks.length
      ? '<span class="pill ' + (crit ? 'crit' : 'warn') + '"><span class="dot"></span>' + risks.length + ' flagged</span>'
      : '<span class="pill go"><span class="dot"></span>Clear</span>') + '</div>' + rows +
    '<div class="perm-note" style="padding:12px 16px;margin-top:0">' + inlineIcon('truck') +
    ' A PO expected <b>after</b> a linked show’s load-in is late hardware — a show-stopper. Within 5 days and not yet received reads as cutting it close. The same flag rides the show’s Gear tab and the season dashboard.</div></div>';
}

/* ---------------------------------------------------------- approval queue - */
function poApprovalQueue(approvals) {
  var canApprove = canApprovePOs(CURRENT_USER);
  var rows = approvals.map(function (po) {
    var btn = canApprove
      ? '<button class="btn sm primary" ' + act('poApprove', po.id) + '>' + icon('check') + 'Approve</button>'
      : '<span class="mini" title="Approval sits with the admins — Tom, Tony, Jim — and Candice (finance)">' + inlineIcon('lock') + ' admins + Candice</span>';
    return '<div class="next-item"><div class="txt"><b>' + esc(po.po_number + ' · ' + po.vendor) + '</b>' +
      '<span>' + esc('requested by ' + firstName(po.created_by) + ' · ' + (PO_LINES_BY_PO[po.id] || []).length + ' lines') + '</span></div>' +
      '<span class="money" style="font-size:12.5px">' + esc(fmtMoney(poTotal(po))) + '</span>' + btn +
      '<button class="btn sm ghost" ' + act('openPO', po.id) + '>' + icon('eye') + 'Open</button></div>';
  }).join('') || '<div class="empty" style="padding:20px">Nothing waiting — every over-threshold PO is signed off.</div>';
  return '<div class="panel"><h3>Awaiting approval · ' + approvals.length + '</h3><div class="next-list">' + rows + '</div>' +
    '<div class="perm-note">' + inlineIcon('lock') + ' POs over <b>' + esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + '</b> need sign-off from an <b>admin — Tom, Tony or Jim — or Candice</b> (finance) before <b>quoted</b> can advance to <b>ordered</b>; under the threshold auto-approves. Tom’s confirmed rule — mirrored in Settings.</div></div>';
}

/* ============================================================================
   PURCHASING — the global view
   ========================================================================== */
function viewPurchasing(o) {
  var st = o.stats;
  if (!o.pos.length) {
    return '<div class="page-h"><div><h1>Purchasing</h1><div class="sub">Purchase orders as first-class records — from needed to reconciled, allocated across jobs and shows.</div></div>' +
      '<button class="btn primary" ' + act('openNewPO') + '>' + icon('plus') + 'New PO</button></div>' +
      '<div class="gear-empty">' + icon('cart') +
      '<div style="font-weight:600;font-size:14px">No purchase orders yet</div>' +
      '<div style="font-size:12.5px;margin-top:7px;max-width:470px;margin-left:auto;margin-right:auto;line-height:1.5">Open one when hardware needs buying — ordered spend shows as <b>committed</b> on job budgets, deliveries get watched against load-ins, and received gear routes to COGS or Flex inventory per the deal.</div>' +
      '<div style="display:flex;gap:9px;justify-content:center;margin-top:16px"><button class="btn primary" ' + act('openNewPO') + '>' + icon('plus') + 'New PO</button></div></div>';
  }

  var stats = '<div class="stats">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Open POs</div><div class="v">' + st.open +
      '<small>' + esc(fmtMoney(st.pipeline)) + ' in pipeline</small></div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Committed · on order</div><div class="v" style="font-size:24px;padding-top:3px">' + esc(fmtMoney(st.committed + st.capex)) +
      '<small>' + esc(fmtMoney(st.capex)) + ' → inventory</small></div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Awaiting approval</div><div class="v" style="color:' + (st.awaiting ? 'var(--warn)' : 'var(--text)') + '">' + st.awaiting +
      (st.awaiting ? '<small>' + esc(fmtMoney(st.awaitingAmount)) + '</small>' : '') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Delivery risks</div><div class="v" style="color:' + (st.riskCrit ? 'var(--crit)' : st.risks ? 'var(--warn)' : 'var(--go)') + '">' + st.risks +
      (st.risks ? '<small>' + st.riskCrit + ' crit · ' + st.riskWarn + ' warn</small>' : '') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Unreconciled</div><div class="v" style="color:' + (st.unreconciled ? 'var(--warn)' : 'var(--go)') + '">' + st.unreconciled +
      (st.unreconciled ? '<small>' + esc(fmtMoney(st.unreconciledAmount)) + '</small>' : '') + '</div></div>' +
    '</div>';

  var boardHead = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0 12px;flex-wrap:wrap">' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;font-family:var(--font-body)">Pipeline · needed → reconciled</h3>' +
    '<span class="pill idle">ordered = committed · received = actual</span></div>';

  return '<div class="page-h"><div><h1>Purchasing</h1><div class="sub">Every purchase order from needed to reconciled. Ordered spend rides job budgets as <b>committed</b> — the tier between allotted and actual — and every delivery is watched against its show’s load-in. Rental deals route hardware to E360 inventory; sales carry it as COGS on the job.</div></div>' +
    '<button class="btn primary" ' + act('openNewPO') + '>' + icon('plus') + 'New PO</button></div>' +
    stats +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr;margin-bottom:20px">' +
    poRiskPanel(o.risks) +
    '<div style="display:flex;flex-direction:column;gap:16px">' + poApprovalQueue(o.approvals) +
    needsRollupPanel() +
    '<div class="hint" style="margin-top:0">' + icon('bolt') + '<span>Your agent can draft these — <b>PO-26-049</b> below came out of the <b>LOVB season planning</b> meeting. Once Teams transcripts go live, “derive the purchase list from this meeting” files straight onto this board as a draft.</span></div>' +
    '</div></div>' +
    boardHead + poBoard(o.pos);
}

/* ============================================================================
   PO DRILL-IN — one order, its whole story
   ========================================================================== */
function poStepper(po) {
  var idx = PO_STATUSES.indexOf(po.status);
  var gate = poNeedsApproval(po);
  var steps = PO_STATUSES.map(function (k, i) {
    var m = PO_STATUS_META[k];
    var cls = i < idx ? 'done' : i === idx ? 'active' : '';
    var sub = k === 'needed' ? 'scoped'
      : k === 'quoted' ? (po.quote_file_id ? 'quote on file' : '—')
      : k === 'ordered' ? (po.ordered_date ? fmtDate(po.ordered_date) : (gate ? 'needs approval' : '—'))
      : k === 'shipped' ? (po.tracking ? po.tracking : (i <= idx ? 'in transit' : '—'))
      : k === 'received' ? (po.received_date ? fmtDate(po.received_date) : '—')
      : (po.invoice_file_id ? 'invoice on file' : 'awaiting invoice');
    var ic = k === 'needed' ? 'pencil' : k === 'quoted' ? 'file' : k === 'ordered' ? 'cart'
      : k === 'shipped' ? 'truck' : k === 'received' ? 'box' : 'checkC';
    if (k === 'ordered' && gate && idx < 2) ic = 'lock';
    var sep = i < PO_STATUSES.length - 1 ? '<span class="fsep">' + icon('chevR') + '</span>' : '';
    return '<div class="fstep ' + cls + '"><div class="fi">' + icon(ic) + '</div><div class="ft"><b>' + esc(m.label) + '</b><span>' + esc(sub) + '</span></div></div>' + sep;
  }).join('');
  return '<div class="flow" style="margin-bottom:16px">' + steps + '</div>';
}

function poApprovalPanel(po) {
  var total = poTotal(po), a = po.approval;
  var canApprove = canApprovePOs(CURRENT_USER);
  var body;
  if (poNeedsApproval(po)) {
    body = '<div class="callout" style="margin-bottom:0;border-color:color-mix(in srgb,var(--warn) 40%,var(--border));background:linear-gradient(180deg,var(--warn-ghost),transparent)">' +
      '<div class="ci" style="color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent)">' + icon('lock') + '</div>' +
      '<div><b>Approval required — ' + esc(fmtMoney(total)) + ' is over the ' + esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + ' threshold</b>' +
      '<p>' + (po.status === 'quoted' ? 'This PO cannot advance to <b>ordered</b> until an admin or Candice signs off.' : 'It will need sign-off from an admin or Candice before it can be ordered.') + '</p>' +
      (po.status === 'quoted'
        ? (canApprove
          ? '<div style="margin-top:10px"><button class="btn sm primary" ' + act('poApprove', po.id) + '>' + icon('check') + 'Approve — clear to order</button></div>'
          : '<p style="margin-top:8px"><span class="mini">' + inlineIcon('lock') + ' admins + Candice only</span></p>')
        : '') + '</div></div>';
  } else if (a && a.approved_by) {
    body = '<div class="glance"><div class="g"><span class="k">Approved by</span><span>' + av(a.approved_by) + ' <b style="font-weight:600">' + esc(userName(a.approved_by)) + '</b></span></div>' +
      '<div class="g"><span class="k">Approved</span><span class="mono">' + esc(fmtDateFull(a.approved_at)) + '</span></div>' +
      '<div class="g"><span class="k">Why</span><span class="mono" style="font-size:11.5px">over ' + esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + ' — admin / finance sign-off</span></div></div>';
  } else if (total <= PO_APPROVAL_THRESHOLD) {
    body = '<div class="glance"><div class="g"><span class="k">Gate</span><span class="mono" style="color:var(--go)">auto-approved · under ' + esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + '</span></div></div>';
  } else {
    body = '<div class="glance"><div class="g"><span class="k">Gate</span><span class="mono" style="color:var(--warn)">will need admin / finance sign-off · over ' + esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + '</span></div></div>';
  }
  return '<div class="panel"><h3>Approval</h3>' + body + '</div>';
}

function viewPO(po) {
  var lines = PO_LINES_BY_PO[po.id] || [];
  var total = poTotal(po);
  var p = PROJECTS_BY_ID[po.project_id];
  var risks = poRisks(po);
  var received = po.status === 'received' || po.status === 'reconciled';

  /* ---- actions per stage ---- */
  var acts = [];
  var nextLabel = { needed: 'Mark quoted', quoted: 'Mark ordered', ordered: 'Mark shipped', shipped: 'Mark received' }[po.status];
  if (nextLabel) {
    var gated = po.status === 'quoted' && poNeedsApproval(po);
    acts.push('<button class="btn ' + (gated ? 'ghost' : 'primary') + '" ' + act('poAdvance', po.id) + '>' +
      icon(gated ? 'lock' : 'chevR') + nextLabel + '</button>');
  }
  if (po.status === 'quoted' && poNeedsApproval(po) && canApprovePOs(CURRENT_USER)) {
    acts.push('<button class="btn primary" ' + act('poApprove', po.id) + '>' + icon('check') + 'Approve</button>');
  }
  if (!po.invoice_file_id && (po.status === 'ordered' || po.status === 'shipped' || po.status === 'received')) {
    acts.push('<button class="btn ' + (po.status === 'received' ? 'primary' : 'ghost') + '" ' + act('poAttachInvoice', po.id) + '>' +
      icon('link') + (po.status === 'received' ? 'Attach invoice — reconcile' : 'Attach invoice') + '</button>');
  }
  if (!po.quote_file_id && (po.status === 'needed' || po.status === 'quoted')) {
    acts.push('<button class="btn ghost" ' + act('poAttachQuote', po.id) + '>' + icon('file') + 'Attach quote</button>');
  }
  /* the way out of the deliberate TBD (raise-from-needs, agent drafts) has to
     be the loudest button on the page while it lasts */
  var tbd = /^TBD\b/i.test(po.vendor);
  acts.push('<button class="btn ' + (tbd ? 'primary' : 'ghost') + '" ' + act('editPO', po.id) + '>' +
    icon('pencil') + (tbd ? 'Set vendor' : 'Edit PO') + '</button>');
  acts.push('<button class="btn ghost" ' + act('openAddPOLine', po.id) + '>' + icon('plus') + 'Add line</button>');
  if (canDeletePOs(CURRENT_USER)) {
    acts.push('<button class="btn ghost" title="Delete this PO — lines and notes go, checklist items it covers reopen, landed costs stay on the books" ' +
      act('poDelete', po.id) + '>' + icon('trash') + 'Delete</button>');
  }

  /* ---- lines table ---- */
  /* the server's LINE_EDITABLE window, drawn: correction buttons exist while
     the PO is needed/quoted and vanish at ordered — the same moment the 409
     starts. Rendering them frozen would be a guaranteed error message. */
  var linesOpen = po.status === 'needed' || po.status === 'quoted';
  var lineRows = lines.map(function (l) {
    var jid = poLineJobId(l), job = jid ? JOBS_BY_ID[jid] : null;
    var s = l.show_id ? SHOWS_BY_ID[l.show_id] : null;
    var flexHint = received && l.ownership === 'inventory'
      ? '<span class="mini auto" title="Received under a rental deal — check it into Flex as pull-able E360 gear" style="display:inline-flex;align-items:center;gap:4px;margin-top:4px">' + inlineIcon('box') + ' → Flex inventory</span>' : '';
    return '<tr><td><b style="font-weight:600">' + esc(l.item) + '</b>' +
      (l.detail ? '<span style="display:block;color:var(--muted);font-size:11px">' + esc(l.detail) + '</span>' : '') + '</td>' +
      '<td class="money" style="color:var(--text-2)">' + esc(l.qty) + '</td>' +
      '<td class="money" style="color:var(--text-2)">' + esc(fmtMoney(l.unit_cost)) + '</td>' +
      '<td class="money">' + esc(fmtMoney(poLineTotal(l))) + '</td>' +
      '<td><span class="tag">' + esc(BUDGET_CATS[l.category] || l.category) + '</span></td>' +
      '<td>' + (job ? jobChip(job) + ' ' + dealTag(job) : '<span class="mini">—</span>') + '</td>' +
      '<td style="color:var(--muted);font-size:12px">' + (s ? esc(showLabel(s)) : '<span class="mini" title="Not pinned to one show — serves the season">season</span>') + '</td>' +
      '<td>' + ownershipTag(l.ownership) + flexHint + '</td>' +
      (linesOpen
        ? '<td style="white-space:nowrap;text-align:right">' +
          '<button class="iconbtn" title="Edit this line" ' + act('poLineEdit', l.id) + '>' + icon('pencil') + '</button> ' +
          '<button class="iconbtn" title="Remove this line" ' + act('poLineDelete', l.id) + '>' + icon('trash') + '</button></td>'
        : '') + '</tr>';
  }).join('');
  var totRow = '<tr><td style="font-weight:700;border-top:2px solid var(--border-strong)">Total</td>' +
    '<td style="border-top:2px solid var(--border-strong)"></td><td style="border-top:2px solid var(--border-strong)"></td>' +
    '<td class="money" style="font-weight:700;border-top:2px solid var(--border-strong)">' + esc(fmtMoney(total)) + '</td>' +
    '<td colspan="' + (linesOpen ? 5 : 4) + '" style="border-top:2px solid var(--border-strong)"></td></tr>';
  var linesCard = '<div class="card"><div class="card-h"><h3>Lines · ' + lines.length + '</h3>' + poStatusPill(po.status) + '</div>' +
    (lines.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th class="money">Qty</th><th class="money">Unit</th><th class="money">Total</th><th>Category</th><th>Bills to</th><th>Show</th><th>Ownership</th>' +
        (linesOpen ? '<th></th>' : '') + '</tr></thead><tbody>' + lineRows + totRow + '</tbody></table></div>'
      : '<div class="empty">No lines yet — add what needs buying.</div>') +
    '<div class="perm-note" style="padding:12px 16px;margin-top:0">' + inlineIcon('scale') +
    ' <b>cogs</b> lines ride the allocated job’s budget (committed once ordered, actual once received) · <b>inventory</b> lines are E360 capex — the deal keeps the gear, so they never hit a job budget.' +
    (linesOpen ? '' : ' Lines froze when this PO was ordered — a commitment reads back exactly as placed.') +
    '</div></div>';

  /* ---- totals by job ---- */
  var byJob = {};
  lines.forEach(function (l) {
    var jid = poLineJobId(l);
    if (!jid) return;
    var b = byJob[jid] = byJob[jid] || { cogs: 0, inv: 0 };
    if (l.ownership === 'inventory') b.inv += poLineTotal(l); else b.cogs += poLineTotal(l);
  });
  var jobRows = Object.keys(byJob).map(function (jid) {
    var job = JOBS_BY_ID[jid], b = byJob[jid];
    if (!job) return '';
    return '<div class="next-item" ' + act('openJob', job.id) + ' style="cursor:pointer"><div class="txt">' + esc(job.client) +
      '<span>' + esc(job.qb_job_number) + ' · ' + esc(job.deal_type || '') + '</span></div>' +
      (b.inv ? '<span class="mini" title="capex — E360 inventory, not a job cost">' + esc(fmtMoney(b.inv)) + ' → inv</span>' : '') +
      '<span class="money" style="font-size:12.5px">' + esc(b.cogs ? fmtMoney(b.cogs) : '—') + '</span></div>';
  }).join('') || '<div class="empty">No allocations yet.</div>';
  var jobsPanel = '<div class="panel"><h3>Allocation by job</h3><div class="next-list">' + jobRows + '</div>' +
    '<div class="perm-note">' + inlineIcon('scale') + ' One order can serve many deals — each line bills its own job; the season splits exactly the way the invoices will.</div></div>';

  /* ---- linked docs ---- */
  var docIds = {}, docs = [];
  [po.quote_file_id, po.invoice_file_id].forEach(function (id) { if (id && FILES_BY_ID[id] && !docIds[id]) { docIds[id] = 1; docs.push(FILES_BY_ID[id]); } });
  lines.forEach(function (l) {
    if (!l.expense_id) return;
    var e = EXPENSES_BY_ID[l.expense_id];
    if (e && e.file_id && FILES_BY_ID[e.file_id] && !docIds[e.file_id]) { docIds[e.file_id] = 1; docs.push(FILES_BY_ID[e.file_id]); }
  });
  var docCards = docs.map(function (f) {
    var role = f.id === po.invoice_file_id ? 'invoice' : f.id === po.quote_file_id ? 'quote' : 'evidence';
    /* wrapped in .file-cell like the other doc grids, so a metadata-only row
       (size 0, no bytes on the NAS) carries its flag and its recovery chip
       here too — a PO invoice that never landed must not read as landed */
    return '<div class="file-cell"><button class="file" ' + act('openViewer', f.id) + '>' +
      '<div class="thumb">' + icon('dollar') + '<span class="ext">' + esc(f.ext) + '</span></div>' +
      '<div class="fb"><b>' + esc(f.vendor || f.name) + '</b><span>' + esc(role + (f.amount ? ' · ' + fmtMoney(f.amount) : '')) + '</span>' +
      fileBytelessFlag(f) + '</div></button>' +
      fileUploadChip(f) + '</div>';
  }).join('') || '<div class="empty" style="padding:18px">No docs yet — attach the vendor quote, then the invoice.</div>';
  var docsPanel = '<div class="panel"><h3>Linked docs · ' + docs.length + '</h3>' +
    '<div class="file-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">' + docCards + '</div>' +
    (!po.invoice_file_id && po.status !== 'needed' && po.status !== 'quoted'
      ? '<div class="perm-note">' + inlineIcon('bolt') + ' No vendor invoice on file — this PO sits on Accounting’s <b>waiting on me</b> list until it lands.</div>' : '') + '</div>';

  /* ---- delivery outlook ---- */
  var linked = poShowsLinked(po);
  var shipRows = linked.map(function (s) {
    var r = poRiskForShow(po, s);
    var d = isoDiffDays(TODAY_ISO, s.load_in_date);
    return '<div class="next-item" ' + act('openShow', s.id) + ' style="cursor:pointer"><div class="txt">' + esc(showLabel(s)) +
      '<span>' + esc('load-in ' + fmtDate(s.load_in_date) + (d != null && d >= 0 ? ' · in ' + d + 'd' : '')) + '</span></div>' +
      (r ? '<span class="pill ' + (r.level === 'crit' ? 'crit' : 'warn') + '"><span class="dot"></span>' + esc(r.why) + '</span>'
         : received ? '<span class="pill go"><span class="dot"></span>landed</span>' : '<span class="pill go"><span class="dot"></span>clear</span>') + '</div>';
  }).join('') || '<div class="empty">No shows pinned — season-wide allocation.</div>';
  var shipPanel = '<div class="panel"><h3>Delivery vs load-ins<span style="flex:1"></span>' +
    /* B8. The one screen that renders expected_date and tracking as facts, and
       the place a buyer is standing when they learn them. */
    '<button class="btn sm ghost" ' + act('editPOEta', po.id) + '>' + icon('pencil') +
    (po.expected_date ? 'Update delivery' : 'Set expected date') + '</button></h3>' +
    '<div class="glance" style="margin-bottom:10px">' +
    '<div class="g"><span class="k">Expected</span><span class="mono">' + esc(po.expected_date ? fmtDateFull(po.expected_date) : '—') + '</span></div>' +
    (po.tracking ? '<div class="g"><span class="k">Tracking</span><span class="mono">' + esc(po.tracking) + '</span></div>' : '') +
    (po.received_date ? '<div class="g"><span class="k">Received</span><span class="mono">' + esc(fmtDateFull(po.received_date)) + '</span></div>' : '') +
    '</div><div class="next-list">' + shipRows + '</div></div>';

  /* ---- activity ---- */
  var actRows = (po.activity || []).map(function (a) {
    var line = (a.actor ? '<b>' + esc(actorName(a.actor)) + '</b> ' : '') + esc(actionLabel(a.action)) +
      (a.detail && !(a.changes && a.changes.length)
        ? ' <span style="color:var(--muted)">· ' + esc(a.detail) + '</span>' : '');
    return '<div class="tl-item ' + (a.accent ? 'accent' : '') + '"><div class="node"></div>' +
      '<div class="a-t">' + line + changeChips(a.changes) + '</div>' +
      '<div class="a-m">' + esc(fmtTs(a.ts)) + '</div></div>';
  }).join('') || '<div class="empty">No activity yet.</div>';
  var actPanel = '<div class="panel"><h3>Activity</h3><div class="timeline">' + actRows + '</div></div>';

  var provLine = po.provenance
    ? '<div class="callout" style="margin-bottom:16px"><div class="ci">' + icon('bolt') + '</div><div><b>Drafted by ' +
      esc(firstName(po.provenance.agent_user) || po.provenance.agent_user) + '’s agent</b>' +
      '<p>From ' + esc(po.provenance.source_kind) + ' “' + esc(po.provenance.source_label) + '” · ' +
      esc(Math.round(po.provenance.confidence)) + '% match. Review the lines, set a vendor, and quote it out — the agent proposes, a person orders.</p></div></div>'
    : '';

  var strip = '<div class="gtotals" style="margin-top:0;margin-bottom:16px">' +
    '<div class="gt"><div class="k">Order total</div><div class="v">' + esc(fmtMoney(total)) + '</div></div>' +
    '<div class="gt"><div class="k">' + (received ? 'Landed as' : PO_COMMITTED_STATUSES[po.status] ? 'Counting as' : 'When ordered') + '</div><div class="v" style="font-size:15px;padding-top:6px">' +
      (received ? '<span style="color:var(--go)">actuals' + (poHasInventory(po) ? ' + inventory' : '') + '</span>'
        : PO_COMMITTED_STATUSES[po.status] ? '<span style="color:var(--warn)">committed</span>' : '<span style="color:var(--muted)">committed</span>') + '</div></div>' +
    '<div class="gt"><div class="k">Lines · jobs</div><div class="v">' + lines.length + '<small style="font-size:12px;color:var(--muted)"> · ' + poJobs(po).length + ' job' + (poJobs(po).length === 1 ? '' : 's') + '</small></div></div>' +
    '<div class="gt"><div class="k">Expected</div><div class="v" style="font-size:15px;padding-top:6px">' + esc(po.expected_date ? fmtDate(po.expected_date) : '—') + '</div></div>' +
    (risks.length ? '<div class="gt"><div class="k">Delivery</div><div class="v" style="font-size:15px;padding-top:6px;color:' + (risks[0].level === 'crit' ? 'var(--crit)' : 'var(--warn)') + '">' + esc(risks[0].why) + '</div></div>' : '') +
    '</div>';

  return '<div class="page-h"><div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><h1>' + esc(po.vendor) + '</h1>' +
    '<span class="tag">' + esc(po.po_number) + '</span>' + poStatusPill(po.status) + poApprovalBadge(po) + '</div>' +
    '<div class="sub">' + esc(po.memo || 'Purchase order') + (p ? ' — in folder ' + esc(p.name) + '.' : '') +
    ' Opened by ' + esc(userName(po.created_by) || po.created_by) + '.</div></div>' +
    '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
    '<button class="btn ghost" ' + act('goPurchasing') + '>' + icon('cart') + 'Back to Purchasing</button>' +
    (p ? '<button class="btn ghost" ' + act('openFolder', p.id) + '>' + icon('folder') + 'Open folder</button>' : '') +
    '</div></div>' +
    provLine + poStepper(po) + strip +
    '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:16px">' + acts.join('') + '</div>' +
    '<div class="ov" style="grid-template-columns:1.5fr 1fr">' +
    '<div style="display:flex;flex-direction:column;gap:16px">' + linesCard + jobsPanel + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' + poApprovalPanel(po) + shipPanel + docsPanel + actPanel +
    notesPanel('po', po.id, { collapse: 2 }) + '</div>' +
    '</div>';
}

/* ============================================================================
   PER-SHOW SURFACES
   ========================================================================== */
/* incoming POs inside the Gear tab — where the gear people live */
function poGearStrip(show) {
  var rows = [];
  ALL_POS.forEach(function (po) {
    if (po.status === 'reconciled') return;
    var mine = (PO_LINES_BY_PO[po.id] || []).filter(function (l) { return l.show_id === show.id; });
    if (!mine.length) return;
    var amt = mine.reduce(function (a, l) { return a + poLineTotal(l); }, 0);
    rows.push({ po: po, amt: amt, n: mine.length, risk: poRiskForShow(po, show),
      inv: mine.some(function (l) { return l.ownership === 'inventory'; }) });
  });
  if (!rows.length) return '';
  var items = rows.map(function (r) {
    var po = r.po;
    var when = po.status === 'received'
      ? '<span class="pill go"><span class="dot"></span>in' + (r.inv ? ' → Flex' : '') + '</span>'
      : r.risk
        ? '<span class="pill ' + (r.risk.level === 'crit' ? 'crit' : 'warn') + '">' + inlineIcon('truck') + ' ' + esc(r.risk.why) + '</span>'
        : po.expected_date
          ? '<span class="mini" title="expected delivery">' + esc('exp ' + fmtDate(po.expected_date)) + '</span>'
          /* B8. `expected_date` and `tracking` are the SOLE inputs to the
             delivery-risk engine — poRisks, the season-row flag, the Purchasing
             cockpit's crit/warn counters — and PUT /api/pos/:id had no client
             method, so on real data the alarm could never fire and every PO
             read "no ETA" forever. */
          : '<span class="mini dep" title="Nothing can go critical without one" ' +
            act('editPOEta', po.id) + ' style="cursor:pointer">+ set ETA</span>';
    return '<div class="next-item" ' + act('openPO', po.id) + ' style="cursor:pointer"><div class="txt">' +
      '<span class="po-num" style="margin-right:7px">' + esc(po.po_number) + '</span><b style="font-weight:600">' + esc(po.vendor) + '</b>' +
      '<span>' + esc(r.n + ' line' + (r.n === 1 ? '' : 's') + ' for this show') + '</span></div>' +
      poStatusPill(po.status) + when +
      '<span class="money" style="font-size:12.5px">' + esc(fmtMoney(r.amt)) + '</span></div>';
  }).join('');
  /* the needs chip: ancillaries pinned to THIS show and still open — a count,
     not a panel; the checklist itself lives on the job drill-in */
  var openNeeds = openNeedsForShow(show.id);
  var needsChip = openNeeds.length
    ? '<span class="pill warn" style="padding:1px 8px;font-size:10px" title="' +
      esc(openNeeds.map(function (nd) { return nd.item; }).join(' · ') + ' — open on the needs checklist') + '">' +
      openNeeds.length + ' need' + (openNeeds.length === 1 ? '' : 's') + ' open</span>'
    : '';
  return '<div class="panel" style="margin-bottom:16px"><h3>Incoming hardware · purchase orders' +
    (needsChip ? '<span style="flex:1"></span>' + needsChip : '') + '</h3><div class="next-list">' + items + '</div>' +
    '<div class="perm-note">' + inlineIcon('truck') + ' Watched against this show’s load-in (' + esc(fmtDate(show.load_in_date)) + '). Received inventory-owned gear routes to <b>Flex</b> as pull-able E360 stock.</div></div>';
}

/* the procurement alert on a show's Overview — impossible to miss, not alarmist */
function poRiskStrip(show) {
  var risks = procurementRisksForShow(show.id);
  if (!risks.length) return '';
  var worst = risks[0].level;
  var col = worst === 'crit' ? 'var(--crit)' : 'var(--warn)';
  var items = risks.map(function (r) {
    return '<span class="lnk" style="cursor:pointer;font-weight:600" ' + act('openPO', r.po.id) + '>' +
      esc(r.po.po_number) + '</span> <b>' + esc(r.po.vendor) + '</b> — ' + esc(r.why) +
      (r.po.expected_date ? ' <span style="color:var(--muted)">(expected ' + esc(fmtDate(r.po.expected_date)) + ', load-in ' + esc(fmtDate(show.load_in_date)) + ')</span>' : '');
  }).join('<br>');
  return '<div class="po-alert" style="border-color:color-mix(in srgb,' + col + ' 45%,var(--border));background:linear-gradient(180deg,color-mix(in srgb,' + col + ' 9%,transparent),transparent)">' +
    '<div class="pai" style="color:' + col + '">' + icon('truck') + '</div>' +
    '<div class="pat"><b style="color:' + col + '">Procurement · delivery risk</b><span>' + items + '</span></div>' +
    '<button class="btn sm ghost" ' + act('gotoTab', null, 'gear') + '>' + icon('box') + 'Gear tab</button></div>';
}

/* the flag on a season dashboard row */
function poSeasonFlag(show) {
  var risks = procurementRisksForShow(show.id);
  if (!risks.length) return '';
  var crit = risks.some(function (r) { return r.level === 'crit'; });
  return ' <span class="pill ' + (crit ? 'crit' : 'warn') + '" style="padding:1px 8px;font-size:10px" title="' +
    esc(risks.map(function (r) { return r.po.po_number + ' — ' + r.why; }).join(' · ')) + '">' +
    inlineIcon('truck') + ' PO</span>';
}

/* ============================================================================
   NEEDS LIST — the per-job ancillary checklist (Tom, 2026-09-02)
   ----------------------------------------------------------------------------
   "each one of those systems need all kinds of ancillary things — it would be
   really advantageous if i had a spot to check those off the list." Eight LED
   installs a season, each needing the same dozen things around the cabinets.
   needsPanel()      — the checklist on the job drill-in (views-finance.js
                       mounts it): seed · check off · n/a · add · raise a PO.
   needsRollupPanel()— the Purchasing cockpit's "Still needed": open items and
                       their est cost grouped by job, click-through to the job.
   A need is a checklist item, not money — nothing hits a budget until it is
   raised onto a PO, and the covered-by tag then links straight to the order.
   ========================================================================== */
function needEstTotal(nd) { return nd.est_cost == null ? null : (nd.qty || 1) * nd.est_cost; }

/* what stands in the "covered by" column: the PO chip, the hand-check, or the
   struck n/a decision — each carrying who and when in the title */
function needStatusCell(nd) {
  if (nd.status === 'covered') {
    var po = nd.covered_by_po_id ? POS_BY_ID[nd.covered_by_po_id] : null;
    if (po) {
      return '<button class="tag" style="cursor:pointer" title="' +
        esc('Covered by ' + po.po_number + ' · ' + po.vendor +
            (nd.checked_by ? ' — raised by ' + userName(nd.checked_by) : '')) + '" ' +
        act('openPO', po.id) + '>' + inlineIcon('cart') + ' ' + esc(po.po_number) + '</button>';
    }
    if (nd.covered_by_po_id) {
      return '<button class="tag" style="cursor:pointer" ' + act('openPO', nd.covered_by_po_id) +
        '>' + inlineIcon('cart') + ' PO #' + Number(nd.covered_by_po_id) + '</button>';
    }
    return '<span class="mini" title="' + esc('Checked off by hand — ordered or handled outside the list' +
      (nd.checked_by ? ' · ' + userName(nd.checked_by) : '')) + '">' + inlineIcon('checkC') + ' handled</span>';
  }
  if (nd.status === 'na') {
    return '<span class="mini dep" title="' + esc('Not needed on this system' +
      (nd.checked_by ? ' — ' + userName(nd.checked_by) : '')) + '">n/a</span>';
  }
  return '<span class="mini dep" title="Still needs buying or a decision">open</span>';
}

function needRow(nd) {
  var na = nd.status === 'na';
  var covered = nd.status === 'covered';
  var s = nd.show_id ? SHOWS_BY_ID[nd.show_id] : null;
  var struck = na ? 'text-decoration:line-through;color:var(--muted)' : '';
  return '<tr>' +
    '<td style="width:28px"><button class="chk' + (covered ? ' on' : '') + '" title="' +
      (covered ? 'Uncheck — this is not handled after all' : na ? 'Marked n/a — restore it below' : 'Check off — handled outside a PO') + '"' +
      (na ? ' disabled style="opacity:.35;cursor:default"' : ' ' + act('needToggle', nd.id)) + '>' +
      icon('check') + '</button></td>' +
    '<td><b style="font-weight:600;' + struck + '">' + esc(nd.item) + '</b>' +
      (nd.detail ? '<span style="display:block;color:var(--muted);font-size:11px;' + (na ? 'text-decoration:line-through' : '') + '">' + esc(nd.detail) + '</span>' : '') +
      (s ? '<span class="mini" style="margin-top:3px">' + esc(showLabel(s)) + '</span>' : '') + '</td>' +
    '<td class="money" style="color:var(--text-2)">' + esc(nd.qty) + '</td>' +
    '<td class="money" style="color:var(--text-2)">' + esc(nd.est_cost == null ? '—' : fmtMoney(needEstTotal(nd))) + '</td>' +
    '<td><span class="tag">' + esc(BUDGET_CATS[nd.category] || nd.category) + '</span></td>' +
    '<td>' + needStatusCell(nd) + '</td>' +
    '<td style="white-space:nowrap;text-align:right">' +
      '<button class="iconbtn" title="' + (na ? 'Restore — it is needed after all' : 'Not needed on this system (n/a)') + '" ' +
        act('needNa', nd.id) + '>' + icon(na ? 'plus' : 'x') + '</button> ' +
      '<button class="iconbtn" title="Edit this item" ' + act('needEdit', nd.id) + '>' + icon('pencil') + '</button> ' +
      '<button class="iconbtn" title="Delete this item" ' + act('needDelete', nd.id) + '>' + icon('trash') + '</button>' +
    '</td></tr>';
}

/* the inline add row — a checklist grows one line at a time, no modal */
function needAddRow(jobId) {
  var catOpts = BUDGET_CAT_ORDER.map(function (c) {
    return '<option value="' + esc(c) + '"' + (c === 'gear' ? ' selected' : '') + '>' + esc(BUDGET_CATS[c]) + '</option>';
  }).join('');
  return '<tr><td></td>' +
    '<td><input id="ndItem" class="cell-in" placeholder="add an item this system needs"></td>' +
    '<td><input id="ndQty" class="cell-in" type="number" min="1" value="1" style="width:56px"></td>' +
    '<td><input id="ndEst" class="cell-in" type="number" min="0" placeholder="est $" style="width:84px"></td>' +
    '<td><select id="ndCat" class="cell-in">' + catOpts + '</select></td>' +
    '<td colspan="2" style="text-align:right"><button class="btn sm ghost" ' + act('needAddCommit', jobId) + '>' +
      icon('plus') + 'Add</button></td></tr>';
}

function needsPanel(job) {
  var rows = needsForJob(job.id);
  var open = rows.filter(function (nd) { return nd.status === 'open'; });
  var openEst = open.reduce(function (a, nd) { return a + (needEstTotal(nd) || 0); }, 0);

  if (!rows.length) {
    return '<div class="card"><div class="card-h"><h3>Needs · ancillaries checklist</h3></div>' +
      '<div class="empty" style="padding:22px;line-height:1.6">Nothing listed yet.<br>' +
      '<span style="color:var(--muted);font-size:12px">Every LED system needs the same dozen things around the ' +
      'cabinets — power distro, processors, data runs, rigging, spares, freight. Seed the standard list and ' +
      'check them off, or add items one at a time below.</span>' +
      '<div style="margin-top:14px"><button class="btn primary" ' + act('needSeed', job.id) + '>' +
      icon('plus') + 'Seed LED ancillaries</button></div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><tbody>' + needAddRow(job.id) + '</tbody></table></div></div>';
  }

  return '<div class="card"><div class="card-h"><h3>Needs · ' + open.length + ' open</h3>' +
    (open.length && openEst ? '<span class="mini" title="sum of the estimates on open items">' +
      esc('~' + fmtMoney(openEst) + ' to buy') + '</span>' : '') +
    '<span style="flex:1"></span>' +
    (open.length
      ? '<button class="btn sm primary" title="Pick the items and name the vendor — one PO at needed, each item checked off against it" ' +
        act('needRaisePo', job.id) + '>' + icon('cart') + 'Raise PO from open items</button>'
      : '<span class="pill go"><span class="dot"></span>All covered</span>') + '</div>' +
    '<div class="tbl-wrap"><table class="tbl">' +
    '<thead><tr><th></th><th>Item</th><th class="money">Qty</th><th class="money">Est</th><th>Category</th><th>Covered by</th><th></th></tr></thead>' +
    '<tbody>' + rows.map(needRow).join('') + needAddRow(job.id) + '</tbody></table></div>' +
    '<div class="perm-note" style="padding:12px 16px;margin-top:0">' + inlineIcon('cart') +
    ' Check = handled outside a PO · <b>Raise PO</b> opens a picker — the checked items become one order at ' +
    '<b>needed</b>, linked back here; what you uncheck stays open for the next vendor · <b>n/a</b> keeps the ' +
    'decision on record, struck through. Estimates are planning numbers — money only moves on the PO.</div></div>';
}

/* the Purchasing cockpit's rollup: what every job still needs, at a glance */
function needsRollupPanel() {
  var groups = openNeedsByJob();
  if (!groups.length) return '';
  var items = 0, est = 0;
  groups.forEach(function (g) { items += g.count; est += g.est; });
  var rowsHtml = groups.map(function (g) {
    return '<div class="next-item" ' + act('openJob', g.job.id) + ' style="cursor:pointer"><div class="txt">' +
      esc(g.job.client) + '<span>' + esc(g.job.qb_job_number + ' · ' + g.count + ' item' + (g.count === 1 ? '' : 's') + ' open') + '</span></div>' +
      '<span class="money" style="font-size:12.5px">' + esc(g.est ? '~' + fmtMoney(g.est) : '—') + '</span></div>';
  }).join('');
  return '<div class="panel"><h3>Still needed · ' + items + ' item' + (items === 1 ? '' : 's') +
    (est ? ' <span class="mini" style="margin-left:6px">~' + esc(fmtMoney(est)) + '</span>' : '') + '</h3>' +
    '<div class="next-list">' + rowsHtml + '</div>' +
    '<div class="perm-note">' + inlineIcon('cart') + ' Open items on each job’s ancillaries checklist — ' +
    'the buying that hasn’t reached a PO yet. Click through to check off or raise the order.</div></div>';
}
