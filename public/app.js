/* ============================================================================
   e360 SHOWRUNNER — ROUTER · DELEGATED ACTIONS · BOOT
   ----------------------------------------------------------------------------
   The router awaits api.* for the data a route needs, then hands PLAIN OBJECTS
   to the pure (synchronous) renderers in views-*.js. Nothing below reads the
   mock store directly except the boot warm-up.

   Every interactive element in the app is wired through ONE delegated click
   listener keyed on data-act. That is what lets inline handlers carry numeric
   ids only — no template ever interpolates a stringy value into JS.
   ========================================================================== */

var CUR = { view: 'projects', projectId: null, showId: null, jobId: null, poId: null };

/* ---------------------------------------------------------------- theme --- */
var THEME_KEY = 'showrunner.theme';
function loadTheme() { try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; } }
function saveTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* private mode / file:// */ } }
function applyTheme(t) {
  var r = document.documentElement;
  if (t === 'light') r.setAttribute('data-theme', 'light'); else r.removeAttribute('data-theme');
  var btn = $('#themeBtn'); if (btn) btn.innerHTML = icon(t === 'light' ? 'sun' : 'moon');
  var sw = $('#setTheme'); if (sw) sw.classList.toggle('on', t !== 'light');
}
function toggleTheme() {
  var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next); saveTheme(next);
}

/* ---------------------------------------------------------------- crumbs -- */
function crumb(parts) {
  $('#crumb').innerHTML = parts.map(function (p, i) {
    var sep = i ? '<span class="sep">/</span>' : '';
    return sep + (p.act ? '<span class="lnk" ' + p.act + '>' + esc(p.t) + '</span>' : '<b>' + esc(p.t) + '</b>');
  }).join('');
}

/* ================================================================= ROUTER ==
   render() is the shell: a loading treatment for a fetch that is taking long
   enough to notice, and an error state that offers a way forward instead of
   dead-ending. renderView() below is the route table itself — in demo mode
   every await resolves in the same tick, so neither state ever paints.
   ========================================================================== */
var SKEL_MS = 220;
function skeletonHTML() {
  var bar = '<div class="sk-bar"></div>';
  return '<div class="skel" aria-busy="true" aria-label="Loading">' +
    '<div class="sk-head"><div class="sk-t"></div><div class="sk-s"></div></div>' +
    '<div class="sk-stats">' + bar + bar + bar + bar + '</div>' +
    '<div class="sk-card"><div class="sk-r"></div><div class="sk-r"></div><div class="sk-r"></div>' +
      '<div class="sk-r"></div><div class="sk-r"></div></div></div>';
}
function errorHTML(e) {
  var status = e && e.status;
  var offline = !status;
  var msg = String((e && e.message) || e || 'Unknown error');
  return '<div class="err-state">' +
    '<div class="es-ic">' + icon(offline ? 'bolt' : status === 403 ? 'lock' : 'alert') + '</div>' +
    '<b>' + esc(offline ? 'Can’t reach the server' : status === 403 ? 'You don’t have access to that'
      : status === 404 ? 'That isn’t here any more' : 'That didn’t load') + '</b>' +
    '<span>' + esc(msg) + '</span>' +
    '<div class="es-btns">' +
      '<button class="btn primary" data-act="netRetry">' + icon('bolt') + 'Try again</button>' +
      '<button class="btn ghost" data-act="goProjects">' + icon('grid') + 'Back to Projects</button>' +
    '</div></div>';
}

async function render(view, arg) {
  var s = $('#scroll');
  var timer = setTimeout(function () { if (s) s.innerHTML = skeletonHTML(); }, SKEL_MS);
  try {
    return await renderView(view, arg);
  } catch (e) {
    if (e && e.status === 401) return;        /* the login screen has the floor */
    console.error(e);
    if (s) s.innerHTML = errorHTML(e);
    crumb([{ t: 'Something went wrong' }]);
  } finally {
    clearTimeout(timer);
  }
}

async function renderView(view, arg) {
  closeRosterPicker();
  setNavOpen(false);                       /* mobile drawer closes on navigate */
  var s = $('#scroll'); s.scrollTop = 0;
  window.__view = view; CUR.view = view;
  document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('on', a.dataset.view === view); });

  if (view === 'projects') {
    var projects = await api.listProjects();
    s.innerHTML = viewProjects(projects, await api.listExceptions());
    crumb([{ t: 'Projects' }]);

  } else if (view === 'finance') {
    var fin = await api.getFinanceOverview();
    s.innerHTML = viewFinance(fin);
    crumb([{ t: 'Finance' }]);

  } else if (view === 'job') {
    var jf = await api.getJobFinance(arg);
    await api.listNotes('job', jf.job.id);
    CUR.jobId = jf.job.id;
    s.innerHTML = viewJobFinance(jf);
    crumb([{ t: 'Finance', act: act('goFinance') }, { t: jf.job.qb_job_number + ' · ' + jf.job.client }]);
    navOn('finance');

  } else if (view === 'purchasing') {
    var pov = await api.getPurchasingOverview();
    s.innerHTML = viewPurchasing(pov);
    crumb([{ t: 'Purchasing' }]);

  } else if (view === 'po') {
    var po = await api.getPO(arg);
    await api.listNotes('po', po.id);
    CUR.poId = po.id;
    s.innerHTML = viewPO(po);
    crumb([{ t: 'Purchasing', act: act('goPurchasing') }, { t: po.po_number + ' · ' + po.vendor }]);
    navOn('purchasing');

  } else if (view === 'folder') {
    /* MULTI-SHOW folder -> season dashboard. (Single-show never lands here —
       openFolder auto-collapses it straight into the show view.) */
    var project = await api.getProject(arg);
    await api.listNotes('project', project.id);   /* notesPanel reads the index */
    CUR.projectId = project.id;
    s.innerHTML = viewSeason(project);
    crumb([{ t: 'Projects', act: act('goProjects') }, { t: project.name }]);
    navOn('projects');

  } else if (view === 'show') {
    var show = await api.getShow(arg);
    await api.listNotes('show', show.id);
    CUR.showId = show.id; CUR.projectId = show.project_id;
    s.innerHTML = viewShow(show);
    if (show.project.single) crumb([{ t: 'Projects', act: act('goProjects') }, { t: show.project.name }]);
    else crumb([{ t: 'Projects', act: act('goProjects') }, { t: show.project.name, act: act('openFolder', show.project_id) }, { t: show.name }]);
    bindFolder(show);
    navOn('projects');

  } else if (view === 'mytasks') {
    /* F2 — the two things a person owes: assigned steps, and show reports. */
    var mine = await api.myOpenSteps();
    var owed = await api.myReports();
    s.innerHTML = viewMyTasks(mine, owed);
    crumb([{ t: 'My Tasks' }]);

  } else if (view === 'archive') {
    /* F6 — the only place archived folders are listed. */
    s.innerHTML = viewArchive(await api.listArchivedProjects());
    crumb([{ t: 'Projects', act: act('goProjects') }, { t: 'Archive' }]);
    navOn('projects');

  } else if (view === 'outbox') {
    /* F3 — a person's own notification record. */
    s.innerHTML = viewOutbox(await api.myNotifications());
    crumb([{ t: 'Settings', act: act('gotoTab', null, 'settings') }, { t: 'My notifications' }]);
    navOn('settings');

  } else if (view === 'calendar') {
    s.innerHTML = viewCalendar(await api.listShows());
    crumb([{ t: 'Calendar' }]);

  } else if (view === 'team') {
    /* THE ONE VIEW that asks for the people who have left as well. Everywhere
       else reads the working roster; here an admin has to be able to see, and
       reactivate, somebody who is switched off. Non-admins get the server's
       default (active only) whatever they send, so the flag is not a gate. */
    if (CURRENT_USER.role === 'admin') await api.listUsers({ all: true });
    s.innerHTML = viewTeam(await api.listShows());
    crumb([{ t: 'Team' }]);

  } else if (view === 'files') {
    s.innerHTML = viewFiles(await api.listShows());
    crumb([{ t: 'Files' }]);

  } else if (view === 'viewer') {
    var vshow = await api.getShow(VIEWER.showId);
    s.innerHTML = viewViewer(vshow);
    crumb([{ t: 'Files', act: act('goFiles') }, { t: (vshow.project.single ? vshow.project.name : vshow.name) + ' · Viewer' }]);
    drawViewer(vshow);
    navOn('files');

  } else if (view === 'templates') {
    s.innerHTML = viewTemplates(await api.listProjects());
    crumb([{ t: 'Templates' }]);

  } else if (view === 'settings') {
    var fov = await api.getFinanceOverview();
    var pov = await api.getPurchasingOverview();
    /* F3 — the notification card reads live prefs + the mail layer's real
       posture, so it can say "queued, nothing configured" instead of implying
       mail that will never arrive. */
    var np = await api.notificationPrefs();
    var ms = await api.mailStatus().catch(function () { return null; });
    /* F6 — the admin card's two counts. Asked for, never assumed: in API mode
       the demo store holds nothing to count. */
    var arch = CURRENT_USER.role === 'admin'
      ? await api.listArchivedProjects().catch(function () { return []; }) : [];
    s.innerHTML = viewSettings({ fin: fov.stats, pur: pov.stats, jobs: fov.jobs,
                                 notifyPrefs: np && np.prefs, mail: ms,
                                 archivedCount: arch.length });
    crumb([{ t: 'Settings' }]);
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  }
}
function navOn(v) { var a = document.querySelector('#nav a[data-view="' + v + '"]'); if (a) a.classList.add('on'); }

/* the auto-collapse rule: a folder with exactly one show opens AS that show */
async function openFolder(projectId) {
  var f = await api.resolveFolder(projectId);
  if (f.single) return render('show', f.show.id);
  return render('folder', f.project.id);
}
async function openShow(showId) { return render('show', showId); }

/* re-render just the active tab of the show currently on screen */
async function refreshShowTab(showId, forceTab) {
  var show = await api.getShow(showId);
  drawShowTab(show, forceTab || activeShowTab());
  return show;
}
async function updateMineCount() {
  var mine = await api.myOpenSteps();
  var c = $('#c-mine'); if (c) c.textContent = mine.length;
}
/* the Finance rail badge = open "waiting on me" exceptions */
async function updateFinCount() {
  var exc = await api.listExceptions();
  var c = $('#c-fin');
  if (c) { c.textContent = exc.length; c.style.color = exc.length ? 'var(--warn)' : ''; }
}
/* the Purchasing rail badge = POs needing a human (approval / risk / invoice).
   The overview is one call in both modes AND it warms the PO index the
   purchasing renderers read synchronously (poTotal, committedForJob). */
async function updatePoCount() {
  var ps;
  try { ps = (await api.getPurchasingOverview()).stats; } catch (_) { return; }
  var c = $('#c-po');
  if (c) { c.textContent = ps.needsAction; c.style.color = ps.needsAction ? 'var(--warn)' : ''; }
}
/* rail footer identity — repainted on boot and on "View as" */
function paintMe() {
  var meAv = $('#meAvatar');
  if (!meAv) return;
  meAv.style.background = CURRENT_USER.color;
  meAv.textContent = CURRENT_USER.initials;
  $('#meName').textContent = CURRENT_USER.name;
  $('#meRole').textContent = (CURRENT_USER.username === 'tandres' ? 'Owner · ' : '') +
    roleName(CURRENT_USER.role) + (CURRENT_USER.finance ? ' · Finance' : '');
}

/* ============================================================================
   MUTATIONS — every one goes through api.*, then re-renders from fresh data
   ========================================================================== */
async function toggleStep(stepId) {
  var st = await api.getStep(stepId);
  if (!st) return;
  var next = normStatus(st.status) === 'done' ? 'todo' : 'done';
  await api.setStepStatus(stepId, next);
  await refreshShowTab(st.show_id, 'pipeline');
  toast(next === 'done' ? 'Task complete' : 'Reopened', st.title);
  updateMineCount();
}
async function assignStepTo(stepId, userId) {
  var u = USERS_BY_ID[Number(userId)] || null;
  var st = await api.assignStep(stepId, u ? u.username : null);
  /* notify-picker: the roster pop OFFERED to ping the assignee (pre-checked,
     removable). Only the assignee is ever pinged here — never the room — and
     assigning yourself is always silent. */
  var ping = !!(u && ROSTER_NOTIFY.on && u.username !== ME);
  closeRosterPicker();
  if (ping) {
    var s = SHOWS_BY_ID[st.show_id];
    await api.notify({ to: [u.username], anchor_type: 'step', anchor_id: st.id,
      text: 'assigned you: ' + st.title + (s ? ' — ' + showLabel(s) : '') });
  }
  toast(u ? 'Task assigned' : 'Task unassigned',
    st.title + ' → ' + (u ? u.name : 'Unassigned') + (ping ? ' · notified' : ''));
  if (CUR.view === 'show') await refreshShowTab(st.show_id);
  updateMineCount();
}

/* ============================================================================
   NOTIFY-PICKER — Tony's rule made a control (TEAM_FEEDBACK "Notification
   control"): on a significant action the ACTOR picks exactly who hears about
   it — one, several, or nobody. Defaults to NOBODY selected; routine edits
   never show the row and never ping. Delivery rides api.notify → the bell.
   One selection for the one open modal; every notifyRow() render resets it.
   ========================================================================== */
var NOTIFY_SEL = [];
function notifyRow(pre) {
  NOTIFY_SEL = (pre || []).slice();
  /* also drop anything a previous modal parked on the seam — an abandoned or
     failed commit must never leave a list that rides the NEXT mutation */
  api.stageNotify([]);
  closeNotifyPop();
  return '<div class="notify-row" id="notifyRow">' + notifyRowInner() + '</div>';
}
function notifyRowInner() {
  var chips = NOTIFY_SEL.map(function (un) {
    var u = ROSTER[un];
    return '<button class="nchip" type="button" title="' + esc('Remove ' + u.name) + '" ' + act('notifyToggle', u.id) + '>' +
      av(un) + esc(firstName(un)) + icon('x') + '</button>';
  }).join('');
  return '<span class="nr-lbl">' + inlineIcon('bell') + 'Notify</span>' + chips +
    '<button class="nchip add" type="button" ' + act('notifyPick') + '>' + icon('plus') +
    (NOTIFY_SEL.length ? 'add' : 'nobody — pick people') + '</button>' +
    '<span class="nr-hint">' + (NOTIFY_SEL.length
      ? NOTIFY_SEL.length + ' inbox ping' + (NOTIFY_SEL.length === 1 ? '' : 's') + ' on save'
      : 'optional — this stays silent unless you choose someone') + '</span>';
}
function repaintNotifyRow() {
  var r = document.getElementById('notifyRow');
  if (r) r.innerHTML = notifyRowInner();
}
function notifyPopInner() {
  return '<div class="rp-h">Notify · lands in their inbox</div>' +
    activeUsers().filter(function (u) { return u.username !== ME; }).map(function (u) {
      var on = NOTIFY_SEL.indexOf(u.username) >= 0;
      return '<button class="rp-opt ' + (on ? 'on' : '') + '" ' + act('notifyToggle', u.id) + '>' + av(u.username) +
        '<span class="ri2"><span class="rn">' + esc(u.name) + '</span><span class="rr">' + esc(roleName(u.role) + ' · ' + u.title) + '</span></span>' +
        '<span class="chk">' + icon('check') + '</span></button>';
    }).join('');
}
function openNotifyPop(anchor) {
  if (document.getElementById('notifyPop')) { closeNotifyPop(); return; }
  var pop = document.createElement('div');
  pop.className = 'roster-pop notify-pop'; pop.id = 'notifyPop';
  pop.innerHTML = notifyPopInner();
  document.body.appendChild(pop);
  try {
    var rc = anchor.getBoundingClientRect(), vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var left = rc.left, top = rc.bottom + 6;
    if (left + 240 > vw) left = vw - 246; if (left < 8) left = 8;
    if (top + 340 > vh) top = Math.max(8, rc.top - 346);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  } catch (_) { pop.style.left = '80px'; pop.style.top = '80px'; }
  setTimeout(function () { document.addEventListener('mousedown', notifyPopOutside); }, 0);
}
function notifyPopOutside(ev) {
  var p = document.getElementById('notifyPop');
  if (!p) return;
  var t = ev.target;
  if (p.contains(t)) return;
  if (t && t.closest && t.closest('#notifyRow')) return;  /* row clicks manage themselves */
  closeNotifyPop();
}
function closeNotifyPop() {
  var p = document.getElementById('notifyPop');
  if (p) p.remove();
  document.removeEventListener('mousedown', notifyPopOutside);
}
function notifyToggleAct(userId) {
  var u = USERS_BY_ID[Number(userId)];
  if (!u || u.username === ME) return;
  var i = NOTIFY_SEL.indexOf(u.username);
  if (i >= 0) NOTIFY_SEL.splice(i, 1); else NOTIFY_SEL.push(u.username);
  repaintNotifyRow();
  var p = document.getElementById('notifyPop');
  if (p) p.innerHTML = notifyPopInner();
}
/* Call BEFORE the mutation. In API mode the selection is parked so the next
   mutating request can carry it as `notify:[…]` — the server then writes the
   note and the mention rows in the SAME transaction as the change. Inert in
   demo mode, where sendNotifies() does the delivery locally. */
function stageNotifies() { api.stageNotify(NOTIFY_SEL); }

/* fire AFTER the mutation lands; returns a toast suffix ('' when silent).
   In API mode every route this app stages a notify before now implements
   `notify:[…]` server-side — files and expenses included, as of the backend's
   notify pass — so the staged list is normally consumed inside the mutation's
   own transaction and this function only writes the toast suffix.
   The `already` guard still earns its place twice over: DEMO MODE has no
   server to consume the list (delivery happens here, locally), and a route
   that ever loses notify support degrades to a late anchored ping rather than
   a silent loss. Either way it happens exactly once. */
async function sendNotifies(anchorType, anchorId, text) {
  if (!NOTIFY_SEL.length) { api.stageNotify([]); return ''; }
  var names = NOTIFY_SEL.map(firstName).join(', ');
  var already = api.notifyConsumed();
  api.stageNotify([]);
  if (!already) {
    await api.notify({ to: NOTIFY_SEL.slice(), anchor_type: anchorType, anchor_id: Number(anchorId), text: text });
  }
  NOTIFY_SEL = [];
  closeNotifyPop();
  return ' · notified ' + names;
}

/* ════════════════════════════════════════════════════════════════════════════
   THE FABRICATION LINE  (2026-08-27, after Show 1)
   ────────────────────────────────────────────────────────────────────────────
   Showrunner grew up as a prototype whose whole job was to LOOK finished, so a
   dozen actions manufacture plausible data: a content spec with a canned pixel
   map, a pull sheet with invented flight cases, a Flex element id hashed out of
   the show number. In DEMO mode that is the product. In API mode it is a lie
   that gets WRITTEN TO THE DATABASE — Tom opened Show 1's Specs & Chain tab in
   production and the app filed a fabricated .e360 under his real job number.

   THE RULE, and it has no exceptions:
     in API mode nothing is ever created except from real user input or a real
     integration response.

   `demoOnly()` is the gate. Every fabricator calls it FIRST and returns if it
   answers true. It is deliberately loud: a person who pressed a button gets
   told why nothing happened and what the real path is, because a button that
   silently does nothing is the second-worst outcome after one that lies.
   ══════════════════════════════════════════════════════════════════════════ */
function apiMode() { return typeof SR !== 'undefined' && SR.isApi(); }
function demoOnly(title, detail) {
  if (!apiMode()) return false;
  toast(title, detail);
  return true;
}

/* ---- spec derivation chain ------------------------------------------------ */
async function bindChainFile(show, key) {
  /* Belt and braces. specGen() already refuses in API mode; this is the second
     lock, on the function that actually writes the row. */
  if (apiMode()) return;
  var n = show.chain[key];
  if (key === 'content') {
    var ex = show.files.filter(function (f) { return f.kind === 'spec' && (!f.spec_type || f.spec_type === 'e360'); })[0];
    if (ex) { ex.ver = 'v' + n.rev; ex.chain_key = 'content'; ex.meta = 'content layout · cached render in DB · rev ' + n.rev; return; }
    await api.addFile(show.id, { name: show.name + ' — LED Content Spec (.e360)', ext: 'e360', kind: 'spec', spec_type: 'e360',
      ver: 'v' + n.rev, size: 421888, dim: 'content layout', by: n.by, meta: 'content layout · cached render in DB', chain_key: 'content', unshift: true });
    return;
  }
  var map = {
    cabling: { ext: 'nsf', spec: 'nsf', nm: ' — Data Cabling', dim: 'cabinet cabling + data runs', size: 98304, up: '.e360' },
    power:   { ext: 'pcfg', spec: 'pcfg', nm: ' — Power Config', dim: '3-phase feeder + amperage', size: 90112, up: '.nsf' }
  };
  var m = map[key]; if (!m) return;
  await api.replaceChainFile(show.id, key, { name: show.name + m.nm + ' (.' + m.ext + ')', ext: m.ext, kind: 'spec', spec_type: m.spec,
    ver: 'v' + n.rev, size: m.size, dim: m.dim, by: n.by, meta: 'derived from ' + m.up + ' · cached render in DB' });
}
async function bindGearFiles(show) {
  if (apiMode()) return;              /* second lock — see THE FABRICATION LINE */
  var g = show.gear;
  show.files = show.files.filter(function (f) { return f.chain_key !== 'pull' && f.chain_key !== 'manifest'; });
  await api.addFile(show.id, { name: show.name + ' — Flex Pull Sheet', ext: 'pdf', kind: 'other', artifact: 'pullsheet',
    ver: 'v1', size: 0, dim: g.kit.pull.length + ' categories', by: 'dvargas', meta: 'Flex ' + g.docNumber + ' · gear list', chain_key: 'pull' });
  await api.addFile(show.id, { name: show.name + ' — Case Manifest', ext: 'pdf', kind: 'other', artifact: 'manifest',
    ver: 'v1', size: 0, dim: g.kit.manifest.length + ' cases', by: 'dvargas', meta: 'flight-case manifest · logistics', chain_key: 'manifest' });
}
async function specGen(showId, key) {
  /* THE ONE THAT BIT TOM. In API mode this used to POST a files row carrying a
     canned .e360 — 10mm pitch, two MX40s, a placeholder pixel map — against a
     real job. Showrunner does not own a spec generator; the three desktop tools
     do, and they push a real bundle into the ?bind-spec=1 popup. */
  if (demoOnly('Nothing generated — and that is the fix',
      'Showrunner cannot author a spec. Generate it in E360 Spec / NovaSpec / PowerSpec and bind it from there; the bound file lands here.')) return;
  var show = await api.getShow(showId);
  var chain = show.chain, up = CHAIN_UP[key];
  if (up && !chain[up].gen) { toast('Generate upstream first', CHAIN_LABEL[up] + ' is required'); return; }
  var first = !chain[key].gen;
  await api.updateChainNode(showId, key, {
    gen: true, rev: (chain[key].rev || 0) + 1, derivedRev: up ? chain[up].rev : 0,
    by: ME, when: TODAY_ISO
  });
  await bindChainFile(show, key);
  toast((first ? 'Generated & bound ' : 'Regenerated ') + CHAIN_LABEL[key],
    first ? 'Cached render bound to ' + show.name + ' — open in viewer to print' : 'Downstream specs flagged stale');
  var fresh = await refreshShowTab(showId, 'specs');
  refreshSpecTabBadge(fresh);
}
async function openChainFile(showId, key) {
  var show = await api.getShow(showId);
  var f = show.files.filter(function (x) { return x.chain_key === key; })[0];
  if (!f && key === 'content') f = show.files.filter(function (x) { return x.kind === 'spec'; })[0];
  if (!f && key === 'pull') f = show.files.filter(function (x) { return x.artifact === 'pullsheet'; })[0];
  if (!f && key === 'manifest') f = show.files.filter(function (x) { return x.artifact === 'manifest'; })[0];
  if (!f) { toast('Not generated yet', 'Generate or pull it first'); return; }
  return openViewer(f.id);
}
async function printChainFile(showId, key) {
  var show = await api.getShow(showId);
  var f = show.files.filter(function (x) { return x.chain_key === key; })[0];
  if (!f && key === 'content') f = show.files.filter(function (x) { return x.kind === 'spec'; })[0];
  if (!f && key === 'pull') f = show.files.filter(function (x) { return x.artifact === 'pullsheet'; })[0];
  if (!f && key === 'manifest') f = show.files.filter(function (x) { return x.artifact === 'manifest'; })[0];
  if (!f) { toast('Not generated yet', 'Generate or pull it first'); return; }
  printSheet(show, f, show.gear);
}

/* ════════════════════════════════════════════════════════════════════════════
   FLEX — real in API mode, simulated in demo, never the two confused
   ══════════════════════════════════════════════════════════════════════════ */

/* Tom's default: create the client / venue contacts in Flex when they are not
   already in the directory, so the folder lands fully populated. Remembered for
   the session only — a per-user preference is a later, real decision. */
var FLEX_CREATE_CONTACTS = true;
function flexToggleContacts(showId) {
  FLEX_CREATE_CONTACTS = !FLEX_CREATE_CONTACTS;
  toast(FLEX_CREATE_CONTACTS ? 'Missing contacts will be created' : 'Missing contacts will be skipped',
    FLEX_CREATE_CONTACTS
      ? 'A client or venue with no exact match in Flex gets created, then linked.'
      : 'A client or venue with no exact match is left blank on the folder.');
  return refreshShowTab(showId, 'gear');
}

/* one line of plain English per contact, for the toast and the panel */
function flexContactLine(contacts) {
  if (!contacts) return '';
  var bits = [];
  ['client', 'venue'].forEach(function (k) {
    var c = contacts[k];
    if (!c) return;
    if (c.outcome === 'matched') bits.push(k + ' linked');
    else if (c.outcome === 'created') bits.push(k + ' created in Flex');
    else bits.push(k + ' LEFT BLANK');
  });
  return bits.join(' · ');
}

async function flexCreate(showId) {
  var show = await api.getShow(showId), g = show.gear;

  /* DEMO: keep the toy, label it as one. */
  if (!apiMode()) {
    if (g.linked) { toast('Already linked (demo)', 'Simulated Event Folder ' + (g.elementId || '').slice(0, 8) + '… exists'); return; }
    var fake = g.elementId || demoModeledUuid(showId);
    await api.updateGear(showId, { linked: true, elementId: fake });
    toast('DEMO SIMULATION — no folder was created',
      'Nothing was sent to Flex. Element ' + fake.slice(0, 8) + '… is generated locally so the screens have something to show.');
    await refreshShowTab(showId, 'gear');
    return;
  }

  /* API: the server has to be wired for Flex at all. */
  var cfg = await SR.serverConfig();
  if (!(cfg && cfg.features && cfg.features.flex)) {
    toast('Flex is not configured on this server',
      'FLEX_BASE_URL and FLEX_API_KEY are unset. Nothing was created — ask for them to be set, then try again.');
    return;
  }
  if (g.linked && g.elementId && !g.fabricated) {
    toast('Already linked', 'Flex Event Folder ' + g.elementId + ' — open it with View in Flex.');
    return;
  }

  var r;
  try {
    r = await api.flexCreateElement(showId, { createContacts: FLEX_CREATE_CONTACTS });
  } catch (e) {
    var msg = String((e && e.message) || e);
    toast(e && e.status === 501 ? 'Flex is not configured' : 'Flex folder NOT created', msg);
    return;
  }
  var line = flexContactLine(r && r.contacts);
  toast('Flex Event Folder created — ' + (r.name || ''),
    'Element ' + r.elementId + (line ? ' · ' + line : ''));
  /* An omitted contact is not a footnote: the folder is live and incomplete. */
  ['client', 'venue'].forEach(function (k) {
    var c = r.contacts && r.contacts[k];
    if (c && c.outcome === 'omitted' && c.name) {
      toast('Flex ' + k + ' left blank', c.name + ' — ' + c.reason);
    }
  });
  await refreshShowTab(showId, 'gear');
}

async function flexLink(showId) {
  /* DEMO keeps the modeled link. API mode asks for a REAL id — pasting the
     folder's deep link is the normal way anyone has one to hand. */
  if (!apiMode()) {
    var show = await api.getShow(showId), g = show.gear;
    var eid = g.elementId || demoModeledUuid(showId);
    await api.updateGear(showId, { linked: true, elementId: eid });
    toast('DEMO SIMULATION — nothing was verified', 'A local id stands in for a real Event Folder.');
    await refreshShowTab(showId, 'gear');
    return;
  }
  PENDING_FLEX_LINK = Number(showId);
  openModal('Link an existing Flex Event Folder',
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">Paste the folder’s <b>element id</b>, or the whole <span class="mono">/f5/ui/#element/…</span> link out of your browser. Showrunner stores the id — it creates nothing.</p>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Flex element id or link',
      '<input id="flexeid" class="cell-in" placeholder="4b0b74e9-6480-43b3-821f-247f3adf45d2">') + '</div>' +
    '<div class="hint" style="margin:6px 0 12px">' + icon('alert') + 'Only an id you can actually see in Flex. A guessed id points this show at somebody else’s folder.</div>' +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('flexLinkSave') + '>' + icon('link') + 'Link</button></div>');
}
var PENDING_FLEX_LINK = null;
async function flexLinkSave() {
  var showId = PENDING_FLEX_LINK;
  if (!showId) return;
  var el = document.getElementById('flexeid');
  var raw = String((el && el.value) || '').trim();
  var m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) { toast('That is not a Flex element id', 'Expected a UUID, or a link containing one. Nothing was linked.'); return; }
  closeM();
  PENDING_FLEX_LINK = null;
  await api.updateGear(showId, { linked: true, element_id: m[0], elementId: m[0] });
  toast('Linked to Flex', 'Element ' + m[0] + ' — Showrunner stored the id you gave it.');
  await refreshShowTab(showId, 'gear');
}

/* ── THE READ PATH (2026-08-28) ────────────────────────────────────────────
   What a fetched pull sheet is, and where it lives: FLEX_SHEETS[showId] is
   VIEW STATE, deliberately. It is never written to the show, never written to
   the database, and never persisted across a reload. A gear list that lives in
   a cache is a gear list that is wrong the moment somebody scans a case in the
   warehouse — so it is re-read from Flex every time a human asks, and the
   screen stamps the time it was read.

   Each entry is one of four honest states:
     {loading:true}                        a read is in flight
     {error:'…'}                           the read failed, and why
     {empty:true, message, lists:[]}       the FOLDER has no equipment lists
     {sheet, listing, lists, folderDeepLink, at}   a real pull sheet
*/
var FLEX_SHEETS = {};

/* '2026-05-19T20:35:50' -> 'May 19 · 8:35 PM'. fmtTs already does exactly this;
   this wrapper exists so a null timestamp reads as an em-dash, not ''. */
function flexWhen(ts) { return ts ? (fmtTs(ts) || String(ts)) : '—'; }

async function flexPull(showId) {
  var show = await api.getShow(showId), g = show.gear, chain = show.chain;

  /* DEMO: keep the simulation, and say the word. buildKit()'s categories and
     flight cases are invented locally so the screens have something to show. */
  if (!apiMode()) {
    if (!g.linked) { toast('Link a Flex folder first', 'Create or link the Event Folder, then pull'); return; }
    await api.updateGear(showId, { pulled: true, gearListId: g.gearListId || ('a220432c-s' + showId + '-gl'), gearListType: 'pull-sheet' });
    await api.updateChainNode(showId, 'pull', {
      gen: true, rev: (chain.pull.rev || 0) + 1, derivedRev: chain.power.gen ? chain.power.rev : 0,
      by: 'dvargas', when: TODAY_ISO
    });
    await bindGearFiles(show);
    toast('DEMO SIMULATION — nothing was read from Flex',
      g.kit.pull.length + ' categories · ' + g.kit.manifest.length + ' cases are generated locally. Against a real server this button reads the folder’s real equipment lists.');
    var fresh = await refreshShowTab(showId, 'gear');
    refreshSpecTabBadge(fresh);
    return;
  }

  /* API: the folder has to be REAL before there is anything to read. */
  if (!g.linked || !g.elementId) {
    toast('Link a Flex folder first', 'Create or link the Event Folder, then load its gear lists.');
    return;
  }
  if (g.fabricated) {
    toast('That link is not a real Flex folder',
      'Element ' + g.elementId + ' was generated by the prototype and exists in no Flex tenant. Create the real folder first.');
    return;
  }
  var cfg = await SR.serverConfig();
  if (!(cfg && cfg.features && cfg.features.flex)) {
    toast('Flex is not configured on this server',
      'FLEX_BASE_URL and FLEX_API_KEY are unset. Nothing was read — ask for them to be set, then try again.');
    return;
  }

  FLEX_SHEETS[showId] = { loading: true };
  await refreshShowTab(showId, 'gear');
  var r;
  try {
    r = await api.flexGearLists(showId);
  } catch (e) {
    FLEX_SHEETS[showId] = { error: String((e && e.message) || e) };
    toast(e && e.status === 501 ? 'Flex is not configured' : 'Could not read the Flex folder',
      String((e && e.message) || e));
    await refreshShowTab(showId, 'gear');
    return;
  }

  /* A folder with no equipment lists is a FACT about the folder, not a
     failure here — the newly created Wrigley folder is in exactly this state. */
  if (r.empty) {
    FLEX_SHEETS[showId] = { empty: true, message: r.message, lists: [], folderDeepLink: r.folderDeepLink, at: new Date().toISOString() };
    toast('No equipment lists in that Flex folder yet', r.message);
    await refreshShowTab(showId, 'gear');
    return;
  }
  if (r.lists.length === 1) return flexLoadSheet(showId, r.lists[0].id, r);
  flexPickList(showId, r);
}

/* More than one list under the folder: ASK. Picking for the human would be
   picking between a pull sheet and its prep manifest, which are different
   documents that happen to share a name. */
function flexPickList(showId, r) {
  var rows = r.lists.map(function (l) {
    return '<button class="btn ghost" style="width:100%;justify-content:flex-start;text-align:left;margin-bottom:8px" ' +
      act('flexPickSheet', showId, l.id) + '>' + icon('box') +
      '<span><b style="font-weight:600">' + esc(l.name || 'Untitled list') + '</b>' +
      '<span style="display:block;font-family:var(--font-mono);font-size:11px;color:var(--muted)">' +
      esc(l.docNumber || 'no doc number') + ' · ' + esc(l.id.slice(0, 8)) + '… · depth ' + l.depth + '</span></span></button>';
  }).join('');
  FLEX_PICK_CTX[showId] = r;
  openModal('Which gear list?',
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">Flex folder <b>' + esc(r.folderName || '') + '</b> holds ' + r.lists.length +
    ' equipment lists. Showrunner cannot tell a pull sheet from a prep manifest out of the folder tree — that costs a call per list — so pick the one you want and it will say which it is once it is open.</p>' +
    rows);
}
var FLEX_PICK_CTX = {};
function flexPickSheet(showId, listId) {
  closeM();
  return flexLoadSheet(showId, listId, FLEX_PICK_CTX[showId] || null);
}

/* The read itself. One route call; the server spends a tree, a header and a
   row-data on it, and nothing is written anywhere. */
async function flexLoadSheet(showId, listId, listCtx) {
  FLEX_SHEETS[showId] = { loading: true, lists: (listCtx && listCtx.lists) || [] };
  await refreshShowTab(showId, 'gear');
  var r;
  try {
    r = await api.flexPullSheet(showId, listId);
  } catch (e) {
    FLEX_SHEETS[showId] = { error: String((e && e.message) || e), lists: (listCtx && listCtx.lists) || [] };
    toast('Could not read that gear list', String((e && e.message) || e));
    await refreshShowTab(showId, 'gear');
    return;
  }
  var s = r.sheet;
  FLEX_SHEETS[showId] = {
    sheet: s, listing: r.listing, folderDeepLink: r.folderDeepLink,
    lists: (listCtx && listCtx.lists) || [r.listing], at: s.fetchedAt
  };
  /* BUG 5's dangerous half, surfaced: Flex answers 200 with [] for a request
     it did not like, which is indistinguishable from an empty list. Say which
     one we cannot tell rather than reporting "0 items" as a fact. */
  if (s.empty) {
    toast('Flex returned no line items for ' + (s.docNumber || s.name),
      'That is either a genuinely empty list or a request Flex did not like — it answers 200 with an empty array for both. Open it in Flex to tell them apart.');
  } else {
    toast('Read from Flex — ' + (s.docNumber || s.name),
      s.totals.groups + ' groups · ' + s.totals.lines + ' line items · ' + s.totals.units + ' units · read live, nothing was stored.');
  }
  await refreshShowTab(showId, 'gear');
}

/* Print the fetched sheet through the SAME printable renderer the demo pull
   sheet uses — no bound `files` row required, because a live read never
   creates one. */
async function flexPrintSheet(showId) {
  var st = FLEX_SHEETS[showId];
  if (!st || !st.sheet) { toast('Nothing to print', 'Load the gear list from Flex first.'); return; }
  var show = await api.getShow(showId);
  printFlexSheet(show, st.sheet);
}
async function gearView(showId, which) {
  await api.updateGear(showId, { view: which });
  await refreshShowTab(showId, 'gear');
}

/* ---- add file (modeled upload / dropzone / in-context attach) -------------- */
var ADD_TYPES = [
  { label: 'PDF document',           desc: 'brief · packet · plan',       ext: 'pdf',  kind: 'other',    ic: 'file', size: 327680,  dim: '—' },
  { label: 'Proof',                  desc: 'client proof for approval',   ext: 'pdf',  kind: 'proof',    ic: 'img',  size: 6710886, dim: '2160 x 864' },
  { label: 'Contract / confirmation', desc: 'signed paperwork',           ext: 'pdf',  kind: 'contract', ic: 'file', size: 245760,  dim: '—' },
  { label: 'Image / render',         desc: 'concept or photo',            ext: 'jpg',  kind: 'other',    ic: 'img',  size: 5033165, dim: '3840 x 1080', artifact: 'image' },
  { label: 'Spec',                   desc: 'content / layout spec',       ext: 'e360', kind: 'spec',     ic: 'led',  size: 421888,  dim: 'content layout', spec_type: 'e360' }
];
var PENDING_ADD = null;
async function openAddFile(showId, ctx) {
  PENDING_ADD = { showId: Number(showId), ctx: ctx || null };
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  var ctxLine = ctx && ctx.label
    ? '<div class="callout" style="margin-bottom:14px"><div class="ci">' + icon('link') + '</div><div><b>Attaching in context</b><p>Lands on <b>' + esc(ctx.label) + '</b> and also shows in this show’s Files tab.</p></div></div>'
    : '';

  /* ══════════════════════════════════════════════════════════════════════
     API MODE — a REAL file picker, because there is now a real place to put
     the bytes. The prototype's "pick a type to model an upload" card grid is
     kept for DEMO mode and only for demo mode: with a server attached, a
     button that invents a 6.7 MB proof nobody uploaded is exactly the disease
     HARDENING 21 was about.
     ══════════════════════════════════════════════════════════════════════ */
  if (apiMode()) {
    var canStore = await api.uploadsEnabled();
    var kinds = ['other', 'spec', 'proof', 'contract', 'invoice', 'receipt', 'quote', 'photo'];
    var kindOpts = kinds.map(function (k) {
      return '<option value="' + k + '">' + esc(fileKindLabel(k)) + '</option>';
    }).join('');
    /* Fail LOUD and fail EARLY. Collecting a file the server has nowhere to
       put, and only saying so after the person waited for the transfer, is
       worse than refusing at the top. */
    var storageNote = canStore
      ? '<div class="hint" style="margin-top:12px">' + icon('server') +
        'Bytes go to the e360 NAS: <span class="mono">\\\\e360-nas\\showrunner\\P{id}-{slug}\\S{id}-{slug}\\{kind}</span>. ' +
        'The record here is metadata; the file itself lives there.</div>'
      : '<div class="callout" style="margin:12px 0 0"><div class="ci">' + icon('alert') + '</div><div>' +
        '<b>No storage on this server</b><p>This Showrunner has no NAS connection configured, so the ' +
        'file can be <b>registered</b> — name, type, folder, who filed it — but the bytes stay on your ' +
        'machine. Ask Tom to finish the storage wiring.</p></div></div>';
    openModal('Add file' + (ctx && ctx.label ? ' · ' + ctx.label : ''),
      ctxLine +
      '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">Uploads to <b>' + esc(title) + '</b>. ' +
      'The file name, extension and size are read from the file itself — nothing here is typed in twice.</p>' +
      '<div class="fin-inputs" style="grid-template-columns:1fr">' +
      finLabelWrap('File', '<input type="file" id="upFile" class="cell-in">') + '</div>' +
      '<div class="fin-inputs">' +
      finLabelWrap('Type', '<select id="upKind" class="cell-in">' + kindOpts + '</select>') +
      finLabelWrap('Name', '<input id="upName" class="cell-in" placeholder="leave blank to use the file name">') +
      '</div>' +
      notifyRow() + storageNote +
      '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:12px">' +
      '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
      '<button class="btn primary" id="upGo" ' + act('commitUpload') + '>' + icon('send') +
      (canStore ? 'Upload' : 'Register (no bytes)') + '</button></div>');
    /* pre-select the type from the extension the moment a file is chosen */
    var inp = $('#upFile');
    if (inp && inp.addEventListener) {
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        var g = guessFileKind(f.name);
        var sel = $('#upKind');
        if (sel) sel.value = g.kind;
      });
    }
    return;
  }

  var opts = ADD_TYPES.map(function (t, i) {
    return '<button class="tpl-card" style="text-align:left" ' + act('commitAddFile', i) + '><div class="ti">' + icon(t.ic) + '</div><b>' + esc(t.label) + '</b><div class="td">.' + esc(t.ext) + ' · ' + esc(t.desc) + '</div></button>';
  }).join('');
  openModal('Add file' + (ctx && ctx.label ? ' · ' + ctx.label : ''), ctxLine +
    (ctx && ctx.label ? '' : '<p style="margin:0 0 14px;color:var(--text-2);font-size:13px">Pick a file type to model an upload. It binds to <b>' + esc(title) + '</b>, appears in the Files grid, and opens in the viewer.</p>') +
    notifyRow() +
    '<div class="tpl-cards" style="margin:0">' + opts + '</div>' +
    '<div class="hint" style="margin-top:14px">' + icon('server') + 'Modeled — no upload backend. Bytes store on the e360 NAS: <span class="mono">\\\\e360-nas\\showrunner\\P{id}-{slug}\\S{id}-{slug}\\{kind}</span>.</div>');
}

/* ════════════════════════════════════════════════════════════════════════
   THE REAL UPLOAD — one function, used by the picker AND by drag-and-drop
   ------------------------------------------------------------------------
   Two calls, in this order, and the order is the contract:
     1. POST /api/files            metadata. The server derives nas_path; a
                                   client that could name its own path could
                                   write into somebody else's folder.
     2. PUT  /api/files/:id/content bytes, to the row that already exists.
   If (2) fails the row survives and says so. That is deliberately not a
   rollback: the person can retry the bytes, and a metadata row with no bytes
   is a visible, fixable state — a silently discarded upload is not.

   NOTHING here invents a number. `size` is not sent at all (the server sets
   it from what actually arrived) and `dim` is sent only when the image was
   really decoded and measured.
   ══════════════════════════════════════════════════════════════════════ */
var FILE_KIND_LABELS = {
  other: 'Document', spec: 'Spec', proof: 'Proof', contract: 'Contract / confirmation',
  invoice: 'Invoice', receipt: 'Receipt', quote: 'Quote', photo: 'Photo'
};
function fileKindLabel(k) { return FILE_KIND_LABELS[k] || k; }

/* Everything derivable from a real filename, and nothing that is not. */
function guessFileKind(fileName) {
  var nm = String(fileName || '');
  var ext = (nm.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  ext = ext.toLowerCase();
  var out = { ext: ext, kind: 'other', spec_type: null, artifact: null,
              base: nm.replace(/\.[a-z0-9]+$/i, '') || nm || 'Untitled' };
  if (/^(jpg|jpeg|png|gif|webp|heic|bmp|tif|tiff)$/.test(ext)) out.artifact = 'image';
  if (/^(e360|nsf|pcfg)$/.test(ext)) { out.kind = 'spec'; out.spec_type = ext; }
  return out;
}

/* Real pixels or nothing. Resolves to null for anything that is not an image
   the browser can actually decode — a .heic on a desktop Chrome, say. */
function measureImage(file) {
  return new Promise(function (resolve) {
    if (!file || !/^image\//.test(String(file.type || ''))) return resolve(null);
    if (typeof createImageBitmap !== 'function' || typeof URL === 'undefined') return resolve(null);
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 4000);
    createImageBitmap(file).then(function (bmp) {
      if (done) return;
      done = true; clearTimeout(t);
      resolve({ w: bmp.width, h: bmp.height });
      try { bmp.close(); } catch (_) {}
    }, function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
  });
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/* The one place bytes actually go up. Returns the file row either way; the
   caller decides what to say about it. */
async function uploadRealFile(showId, file, opts) {
  opts = opts || {};
  var g = guessFileKind(file.name);
  var kind = opts.kind || g.kind;
  var dims = await measureImage(file);
  var f = await api.addFile(showId, {
    name: opts.name || g.base,
    ext: g.ext,
    kind: kind,
    spec_type: g.spec_type,
    artifact: g.artifact,
    ver: 'v1',
    /* NO size, NO dim — the server owns both once real bytes land */
    meta: '',
    attached_to: opts.attachedTo || null
  });
  var canStore = await api.uploadsEnabled();
  if (!canStore) return { file: f, stored: false, reason: 'not-configured' };
  try {
    var r = await api.uploadFileBytes(f.id, file, dims);
    return { file: f, stored: true, size: r && r.size, sha256: r && r.sha256 };
  } catch (e) {
    return { file: f, stored: false, reason: e && e.message ? e.message : 'upload failed' };
  }
}

async function commitUpload() {
  if (!PENDING_ADD) return;
  var showId = PENDING_ADD.showId, ctx = PENDING_ADD.ctx;
  var inp = $('#upFile');
  var file = inp && inp.files && inp.files[0];
  if (!file) { toast('Pick a file first', 'Nothing was selected.'); return; }
  var btn = $('#upGo');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Uploading…'; }
  var kind = ($('#upKind') && $('#upKind').value) || null;
  var name = ($('#upName') && $('#upName').value || '').trim() || null;
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  stageNotifies();
  var res;
  try {
    res = await uploadRealFile(showId, file, {
      kind: kind, name: name || (ctx && ctx.name) || null,
      attachedTo: ctx ? ctx.attachedTo : null
    });
  } catch (e) {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Upload'; }
    toast('Upload failed', String(e && e.message || e));
    return;
  }
  closeM();
  var suffix = await sendNotifies('file', res.file.id, 'added a file: ' + res.file.name + ' — ' + title);
  if (res.stored) {
    toast('File uploaded', res.file.name + ' → ' + title + ' · ' + fmtBytes(res.size) + suffix);
  } else if (res.reason === 'not-configured') {
    toast('Registered — bytes not stored',
      res.file.name + ' is on the record, but this server has no NAS storage configured.');
  } else {
    /* The row exists and the bytes did not land. Say BOTH halves. */
    toast('Filed, but the bytes did not land', res.file.name + ' — ' + res.reason);
  }
  return openViewer(res.file.id);
}

/* Pull a file back down through the app and hand it to the browser. */
async function downloadFile(fileId) {
  var f = await api.getFile(fileId);
  if (!f) return;
  if (!apiMode()) {
    toast('Download', (f.name || 'file') + '.' + (f.ext || '') + ' from the NAS');
    return;
  }
  var name = String(f.name || 'file') + (f.ext ? '.' + String(f.ext).replace(/^\./, '') : '');
  try {
    var blob = await api.downloadFileBytes(fileId);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    /* revoke on a tick — revoking synchronously races the download in Safari */
    setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (_) {} }, 2000);
    toast('Downloading', name);
  } catch (e) {
    /* the server's message, verbatim: "the NAS is unreachable" is the answer */
    toast('Could not download ' + name, String(e && e.message || e));
  }
}
async function commitAddFile(i) {
  if (!PENDING_ADD) return;
  var showId = PENDING_ADD.showId, ctx = PENDING_ADD.ctx, td = ADD_TYPES[Number(i)];
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  var name = ctx && ctx.name ? ctx.name : (td.label + ' — ' + title.split(' ')[0]);
  var meta = ctx && ctx.label ? ('attached to ' + ctx.label + ' · added ' + fmtDate(TODAY_ISO)) : ('uploaded ' + fmtDate(TODAY_ISO) + ' · modeled');
  stageNotifies();
  var f = await api.addFile(showId, { name: name, ext: td.ext, kind: td.kind, spec_type: td.spec_type, artifact: td.artifact,
    ver: 'v1', size: td.size, dim: td.dim, by: ME, meta: meta, attached_to: ctx ? ctx.attachedTo : null });
  closeM();
  var suffix = await sendNotifies('file', f.id, 'added a file: ' + name + ' — ' + title);
  toast('File added', name + ' → ' + title + suffix);
  return openViewer(f.id);
}
async function attachToStep(stepId) {
  var st = await api.getStep(stepId); if (!st) return;
  return openAddFile(st.show_id, { label: st.title, name: st.title, attachedTo: st.title });
}
/* booking paperwork IS a financial doc — route it through the finance flow
   so attaching it clears the booking's "waiting on me" exception */
async function attachToBooking(bookingId) {
  var b = await api.getBooking(bookingId); if (!b) return;
  return openAddFinDoc(b.show_id, { bookingId: b.id });
}
/* Drag-and-drop. `dropped` is the real File the browser handed us in API mode
   (the drop listener passes the File object, not just its name) — so a drop is
   a genuine upload and not a differently-shaped fabricator. In DEMO mode there
   are no bytes to send and the modeled row is kept, as everywhere else.
   The (showId, "name.pdf") signature still works: a string means demo. */
async function dropFile(showId, dropped) {
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  var isFile = dropped && typeof dropped === 'object' && typeof dropped.name === 'string';

  if (apiMode() && isFile) {
    var res = await uploadRealFile(showId, dropped, {});
    if (res.stored) {
      toast('File uploaded', res.file.name + ' → ' + title + ' · ' + fmtBytes(res.size));
    } else if (res.reason === 'not-configured') {
      toast('Registered — bytes not stored',
        res.file.name + ' is on the record, but this server has no NAS storage configured.');
    } else {
      toast('Filed, but the bytes did not land', res.file.name + ' — ' + res.reason);
    }
    if (CUR.view === 'show') await refreshShowTab(showId, 'files');
    return;
  }
  if (apiMode()) {
    /* a drop the browser gave us no File for — nothing real to file */
    toast('Nothing to upload', 'The browser did not hand over a file. Use “Add file” instead.');
    return;
  }

  var nm = (isFile ? dropped.name : dropped) || 'Dropped file.pdf';
  var g = guessFileKind(nm);
  await api.addFile(showId, { name: g.base, ext: g.ext || 'pdf', kind: g.kind,
    spec_type: g.spec_type, artifact: g.artifact,
    ver: 'v1', size: 0, dim: '—', by: ME, meta: 'dropped ' + fmtDate(TODAY_ISO) + ' · modeled' });
  toast('File added', g.base + ' → ' + title);
  if (CUR.view === 'show') await refreshShowTab(showId, 'files');
}

/* ---- viewer --------------------------------------------------------------- */
async function openViewer(fileId) {
  var f = await api.getFile(fileId);
  if (!f) return;
  VIEWER = { showId: f.show_id, fileId: f.id };
  return render('viewer');
}
async function vSet(fileId) {
  VIEWER.fileId = Number(fileId);
  drawViewer(await api.getShow(VIEWER.showId));
}
async function vGo(d) {
  var show = await api.getShow(VIEWER.showId);
  /* when a photo is up, prev/next pages the photo set only (photo pass) */
  var list = viewerNavList(show), n = list.length;
  if (!n) return;
  var i = 0;
  list.forEach(function (x, k) { if (x.id === VIEWER.fileId) i = k; });
  VIEWER.fileId = list[(i + Number(d) + n) % n].id;
  drawViewer(show);
}
async function printFile() {
  var show = await api.getShow(VIEWER.showId);
  var f = show.files.filter(function (x) { return x.id === VIEWER.fileId; })[0] || show.files[0];
  if (f) printSheet(show, f, show.gear);
}

/* ---- misc modeled actions (toast-only — scope discipline) ------------------ */
async function pushSched(showId) {
  var r = await api.pushToScheduler(showId);
  toast('Pushed to Scheduler', r.show + ' → e360 staffing app (dry run)');
}
/* ============================================================================
   F1 · NEW EVENT — the last mock button in the app, made real
   ----------------------------------------------------------------------------
   Two steps, because the type choice CHANGES the form (a print event has no
   cabinet count and an LED one has no piece count), and because picking a type
   is the one decision that determines everything downstream: the lane set, the
   template, and which half of the scope line you are asked for.

     step 1  pick the event type          -> seeds its lanes + T-minus pipeline
     step 2  the details + the NOTIFY ROW  -> one call, one transaction

   THE NOTIFY ROW IS THE POINT OF THIS BEING REBUILT. Tom, 2026-08-27, about
   his own blind spot in the staffing app: "I can email itineraries, but when I
   add an event I should have the option of letting people know about it."
   Default is nobody — creating an event does not spam the company — and one
   click adds everyone.
   ========================================================================== */
var NEW_EVENT = { type: 'led' };

function openNew() {
  NEW_EVENT = { type: 'led' };
  openModal('New event · pick a type',
    '<p style="margin:0 0 14px;color:var(--text-2);font-size:13px">The type decides the lane set and the ' +
    'T-minus pipeline that gets seeded, and which scope numbers you are asked for. Types are extensible ' +
    '— adding one is a config entry, not a deploy.</p>' +
    '<div class="tpl-cards" style="margin:0">' + Object.keys(EVENT_TYPES).map(function (type) {
      var t = typeDef(type);
      var n = Object.keys(TEMPLATE_STEPS[type] || {}).reduce(function (a, k) {
        return a + (TEMPLATE_STEPS[type][k] || []).length; }, 0);
      return '<button class="tpl-card" ' + act('newEventType', null, type) + '><div class="ti">' + icon(t.icon) + '</div><b>' + esc(t.label) + '</b><div class="td">' + t.lanes.length + ' lanes · ' + n + ' steps · anchored to ' + esc(t.anchor) + '</div></button>';
    }).join('') + '</div>');
}

function newEventForm(type) {
  NEW_EVENT = { type: type };
  var t = typeDef(type);
  var isLed = type === 'led' || type === 'both';
  var isPrint = type === 'print' || type === 'both';
  /* a pm always owns what they create; manager+ may hand it to someone else —
     the same rule the server enforces in POST /api/events */
  var canPickOwner = CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'manager';
  var ownerOpts = (canPickOwner ? activeUsers() : [CURRENT_USER])
    .filter(function (u) { return u.role !== 'viewer'; })
    .map(function (u) {
      return '<option value="' + esc(u.username) + '"' + (u.username === ME ? ' selected' : '') + '>' +
        esc(u.name + ' · ' + roleName(u.role)) + '</option>';
    }).join('');

  openModal('New ' + t.label + ' event',
    '<div class="hint" style="margin:0 0 12px">' + icon(t.icon) + '<span>Opens a <b>folder</b>, its first ' +
    '<b>show</b>, and a <b>job</b> on a temporary number — one act, one transaction. The ' +
    esc(t.label) + ' template seeds ' + t.lanes.length + ' lanes of T-minus steps off the event date. ' +
    'The real QuickBooks number lands when you confirm the deal.</span></div>' +

    '<div class="fin-inputs" style="grid-template-columns:1.6fr 1fr">' +
    finLabelWrap('Event name', '<input id="neName" class="cell-in" placeholder="what we call it — e.g. LOVB Madison — Match 1">') +
    finLabelWrap('Client', '<input id="neClient" class="cell-in" placeholder="who is paying">') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1.6fr 1fr">' +
    finLabelWrap('Venue', '<input id="neVenue" class="cell-in" placeholder="Fiserv Forum — Milwaukee, WI">') +
    finLabelWrap('Owner', '<select id="neOwner" class="cell-in">' + ownerOpts + '</select>') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr 1fr 1fr">' +
    finLabelWrap('Load-in', '<input id="neLoadIn" class="cell-in" type="date">') +
    finLabelWrap(t.anchor, '<input id="neEvent" class="cell-in" type="date">') +
    finLabelWrap('Strike', '<input id="neStrike" class="cell-in" type="date">') +
    '</div>' +

    /* F4 — the scope line is offered AT CREATION, because this is the one
       moment somebody definitely knows what was sold. Every field optional:
       most events are opened before the numbers are firm. */
    '<div class="ne-scope"><div class="ne-sh">' + inlineIcon('ruler') + 'Scope — what we are delivering ' +
    '<i>optional, and editable later</i></div>' +
    (isLed ? '<div class="fin-inputs" style="grid-template-columns:1fr 1fr 1fr 1fr">' +
      finLabelWrap('Linear feet', '<input id="neFeet" class="cell-in" type="number" min="0" placeholder="800">') +
      finLabelWrap('Cabinets', '<input id="neCabs" class="cell-in" type="number" min="0" placeholder="144">') +
      finLabelWrap('Cabinet type', '<input id="neCabType" class="cell-in" placeholder="BP2V2">') +
      finLabelWrap('Pitch', '<input id="nePitch" class="cell-in" placeholder="P10">') +
      '</div>' : '') +
    (isPrint ? '<div class="fin-inputs" style="grid-template-columns:1fr 1fr">' +
      finLabelWrap('Pieces', '<input id="nePieces" class="cell-in" type="number" min="0" placeholder="12">') +
      finLabelWrap('Square feet', '<input id="neSqft" class="cell-in" type="number" min="0" placeholder="3400">') +
      '</div>' : '') +
    '</div>' +

    notifyRow() +
    '<div class="hint" style="margin-top:2px">' + inlineIcon('bell') + '<span>Nobody is notified unless you ' +
    'pick them. <span class="lnk-btn" ' + act('notifyAll') + '>Notify everyone on the team</span> if this ' +
    'is one the whole room needs to know about.</span></div>' +
    '<div style="display:flex;justify-content:space-between;gap:9px;margin-top:12px">' +
    '<button class="btn ghost" ' + act('openNew') + '>' + icon('chevL') + 'Back</button>' +
    '<span style="display:flex;gap:9px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('commitNewEvent') + '>' + icon('plus') + 'Create event</button>' +
    '</span></div>');
}

async function commitNewEvent() {
  var v = function (id) { var el2 = document.getElementById(id); return el2 ? String(el2.value || '').trim() : ''; };
  var name = v('neName');
  if (!name) { toast('An event needs a name', 'Type what we call it, or cancel'); return; }
  var num2 = function (id) { var s = v(id); return s === '' ? null : Number(s); };
  var scope = { kind: NEW_EVENT.type,
                linear_feet: num2('neFeet'), cabinet_count: num2('neCabs'),
                cabinet_type: v('neCabType') || null, pitch: v('nePitch') || null,
                print_pieces: num2('nePieces'), print_sqft: num2('neSqft') };
  var anyScope = ['linear_feet', 'cabinet_count', 'cabinet_type', 'pitch', 'print_pieces', 'print_sqft']
    .some(function (k) { return scope[k] !== null && scope[k] !== ''; });

  stageNotifies();
  var r;
  try {
    r = await api.createEvent({
      name: name, type: NEW_EVENT.type, client: v('neClient'), venue: v('neVenue'),
      owner: v('neOwner') || ME,
      load_in_date: v('neLoadIn'), event_date: v('neEvent'), strike_date: v('neStrike'),
      cabinets: num2('neCabs') || 0,
      scope: anyScope ? scope : undefined
    });
  } catch (e) {
    toast('Not created', String(e && e.message || e));
    return;
  }
  closeM();
  var suffix = await sendNotifies('show', r.show.id,
    'opened the event “' + name + '”' + (r.show.venue ? ' at ' + r.show.venue : '') + ' —');
  toast('Opened ' + name,
    (r.instantiated_steps || 0) + ' steps seeded · job ' + (r.job ? r.job.qb_job_number : '—') +
    ' (temporary until it is confirmed)' + suffix);
  await updateMineCount();
  return render('show', r.show.id);
}
async function proofAction(proofId, approve) {
  var show = await api.getShow(CUR.showId);
  var p = show.proofs.filter(function (x) { return x.id === Number(proofId); })[0];
  if (!p) return;
  if (approve) toast('Approved', p.name + ' marked approved');
  else toast('Changes requested', 'New round opened for ' + p.code);
}

/* ============================================================================
   FINANCE ACTIONS — confirm/reject proposals · add expense · attach doc ·
   the "View as" visibility demo. Every mutation goes through api.* and
   re-renders from fresh data, same as everything else.
   ========================================================================== */
async function refreshFinanceUI() {
  await updateFinCount();
  updatePoCount();
  updateBellBadge();
  if (CUR.view === 'finance') return render('finance');
  if (CUR.view === 'job') return render('job', CUR.jobId);
  if (CUR.view === 'purchasing') return render('purchasing');
  if (CUR.view === 'po') return render('po', CUR.poId);
  if (CUR.view === 'viewer') return render('viewer');
  if (CUR.view === 'show') return refreshShowTab(CUR.showId);
  if (CUR.view === 'projects') return render('projects');
  if (CUR.view === 'folder') return render('folder', CUR.projectId);
  if (CUR.view === 'settings') return render('settings');
}
async function openShowFin(showId) {
  await openShow(showId);
  setFolderTab('financials');
}
async function confirmDocAct(fileId) {
  var f = await api.confirmDoc(fileId);
  var job = JOBS_BY_ID[fileJobId(f)];
  toast('Confirmed & filed', (f.vendor || f.name) + ' · ' + fmtMoney(f.amount) + (job ? ' → job ' + job.qb_job_number : ''));
  refreshBellPanel();                     /* the bell lists pending proposals */
  return refreshFinanceUI();
}
async function rejectDocAct(fileId) {
  var f = await api.getFile(fileId);
  if (!f) return;
  var showId = f.show_id;
  var r = await api.rejectDoc(fileId);
  toast('Proposal rejected', r.name + ' removed — nothing landed in the record');
  refreshBellPanel();
  if (CUR.view === 'viewer') { await updateFinCount(); updateBellBadge(); return openShowFin(showId); }
  return refreshFinanceUI();
}
async function excAttach(id, kind) {
  if (kind === 'booking') {
    var b = await api.getBooking(id);
    if (b) return openAddFinDoc(b.show_id, { bookingId: b.id });
  } else if (kind === 'po') {
    return poAttachInvoice(id);
  } else if (kind === 'job_number') {
    /* POLISH_LIST #5: this row's "missing paperwork" is the QB number itself */
    return openJobNumber(id);
  } else {
    var e = EXPENSES_BY_ID[Number(id)];
    if (e) return openAddFinDoc(e.show_id, { expenseId: e.id });
  }
}

/* ---- confirm a QuickBooks job number (POLISH_LIST #5) ----------------------
   The job has been running on a TEMP placeholder. Accounting — the three
   admins plus Candice, the same set the server enforces — types the real
   number in. Nothing re-links: every reference is on the internal job id, so
   this is a relabel, not a migration. */
var PENDING_JOBNUM = null;
async function openJobNumber(jobId) {
  var job = await api.getJob(jobId);
  if (!job) return;
  if (!canSeeFinance()) {
    toast('Accounting owns the job number', 'Candice and the admins cut QuickBooks numbers — ask her to confirm this one');
    return;
  }
  PENDING_JOBNUM = { jobId: Number(jobId), was: job.qb_job_number };
  openModal('Job number · ' + job.client,
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">' +
    (isTempJob(job)
      ? 'This job is running on the placeholder <b>' + esc(job.qb_job_number) + '</b>. Type the QuickBooks number Candice created and it becomes the real one — costs, POs and budget lines all stay attached, because they link by job id, never by the number.'
      : 'Editing the QuickBooks number on <b>' + esc(job.qb_job_number) + '</b>. Everything stays attached — links are on the job id.') +
    '</p>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('QuickBooks job number', '<input id="jobNumIn" class="cell-in" value="' +
      esc(isTempJob(job) ? '' : job.qb_job_number) + '" placeholder="26-1241">') + '</div>' +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('commitJobNumber') + '>' + icon('check') + 'Confirm number</button></div>');
}
async function commitJobNumber() {
  if (!PENDING_JOBNUM) return;
  var num = String((document.getElementById('jobNumIn') || {}).value || '').trim();
  if (!num) { toast('A number is required', 'Type the QuickBooks job number, or cancel'); return; }
  var was = PENDING_JOBNUM.was;
  try {
    var j = await api.confirmJobNumber(PENDING_JOBNUM.jobId, num);
    closeM();
    PENDING_JOBNUM = null;
    toast('Job number confirmed', j.qb_job_number + ' — was ' + was + '. Nothing re-linked.');
    await updateFinCount();
    return refreshFinanceUI();
  } catch (e) {
    toast('Could not set the job number', (e && e.message) || 'the server refused that change');
  }
}

/* ============================================================================
   PURCHASING ACTIONS — advance / approve (the gate) / attach docs / new PO
   ========================================================================== */
async function poAdvance(poId) {
  var po = await api.getPO(poId);
  var next = PO_STATUSES[PO_STATUSES.indexOf(po.status) + 1];
  if (!next || next === 'reconciled') return;
  try {
    var upd = await api.updatePOStatus(poId, next);
    var lbl = (PO_STATUS_META[upd.status] || {}).label;
    toast(upd.po_number + ' → ' + lbl,
      upd.status === 'ordered' ? fmtMoney(poTotal(upd)) + ' now committed against its jobs'
      : upd.status === 'received' ? 'Cogs lines landed as actuals' + (upd.invoice_file_id ? ' — reconciled (invoice was on file)' : ' — attach the invoice to reconcile')
      : upd.status === 'reconciled' ? 'Invoice on file — closed out'
      : upd.vendor);
  } catch (e) {
    toast('Blocked', String(e && e.message || e));
    return;
  }
  return refreshFinanceUI();
}
async function poApprove(poId) {
  try {
    var po = await api.approvePO(poId);
    toast('Approved ' + po.po_number, fmtMoney(poTotal(po)) + ' · cleared to order — logged to activity');
  } catch (e) {
    toast('Not approved', String(e && e.message || e));
    return;
  }
  return refreshFinanceUI();
}
async function poAttachInvoice(poId) {
  var po = await api.getPO(poId);
  var s = poPrimaryShow(po);
  if (!s) return;
  return openAddFinDoc(s.id, { poId: po.id, poKindHint: 'invoice' });
}
async function poAttachQuote(poId) {
  var po = await api.getPO(poId);
  var s = poPrimaryShow(po);
  if (!s) return;
  return openAddFinDoc(s.id, { poId: po.id, poKindHint: 'quote' });
}

/* ---- new PO ---- */
async function openNewPO() {
  var projects = await api.listProjects();
  var projOpts = projects.map(function (p) {
    return '<option value="' + Number(p.id) + '"' + (CUR.projectId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }).join('');
  openModal('New purchase order',
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">Opens in <b>needed</b> — add lines, quote it out, then order. Over $5,000 needs sign-off from an admin — Tom, Tony or Jim — or Candice before it can be ordered.</p>' +
    '<div class="fin-inputs" style="grid-template-columns:1.4fr 1fr">' +
    finLabelWrap('Vendor', '<input id="poVendor" class="cell-in" placeholder="who we’re buying from (or TBD)">') +
    finLabelWrap('Folder', '<select id="poProject" class="cell-in">' + projOpts + '</select>') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Memo', '<input id="poMemo" class="cell-in" placeholder="what this order is for">') + '</div>' +
    notifyRow() +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('commitNewPO') + '>' + icon('cart') + 'Open PO</button></div>');
}
async function commitNewPO() {
  var projId = Number((document.getElementById('poProject') || {}).value);
  var p = await api.getProject(projId).catch(function () { return null; });
  if (!p) { toast('Pick a folder', 'A PO lives inside an event folder'); return; }
  var defJob = (p.jobs && p.jobs[0]) ? p.jobs[0].id : null;
  stageNotifies();
  var po = await api.createPO({
    vendor: (document.getElementById('poVendor') || {}).value || 'TBD',
    project_id: projId, job_id: defJob,
    memo: (document.getElementById('poMemo') || {}).value || ''
  });
  closeM();
  var suffix = await sendNotifies('po', po.id, 'opened ' + po.po_number + ' — ' + po.vendor + ' · ' + p.name);
  toast('Opened ' + po.po_number, po.vendor + ' · needed — add lines, then quote it out' + suffix);
  updatePoCount();
  return render('po', po.id);
}

/* ---- add PO line ---- */
var PENDING_PO_LINE = null;
async function openAddPOLine(poId) {
  var po = await api.getPO(poId);
  PENDING_PO_LINE = { poId: po.id };
  var p = PROJECTS_BY_ID[po.project_id];
  var jobOpts = ((p && p.jobs) || ALL_JOBS).map(function (j) {
    return '<option value="' + Number(j.id) + '"' + (j.id === po.job_id ? ' selected' : '') + '>' +
      esc(j.qb_job_number + ' · ' + j.client + (j.deal_type ? ' · ' + j.deal_type : '')) + '</option>';
  }).join('');
  var showOpts = '<option value="">season-wide</option>' + ((p && p.shows) || []).map(function (s) {
    return '<option value="' + Number(s.id) + '">' + esc(showLabel(s)) + '</option>';
  }).join('');
  var catOpts = BUDGET_CAT_ORDER.map(function (c) {
    return '<option value="' + esc(c) + '"' + (c === 'gear' ? ' selected' : '') + '>' + esc(BUDGET_CATS[c]) + '</option>';
  }).join('');
  openModal('Add line · ' + po.po_number,
    '<div class="fin-inputs" style="grid-template-columns:1.6fr 84px 110px">' +
    finLabelWrap('Item', '<input id="plItem" class="cell-in" placeholder="what we’re buying">') +
    finLabelWrap('Qty', '<input id="plQty" class="cell-in" type="number" min="1" value="1">') +
    finLabelWrap('Unit $', '<input id="plUnit" class="cell-in" type="number" min="0" placeholder="0">') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr 1fr">' +
    finLabelWrap('Category', '<select id="plCat" class="cell-in">' + catOpts + '</select>') +
    finLabelWrap('Ownership', '<select id="plOwn" class="cell-in"><option value="">auto — from the job’s deal type</option><option value="cogs">cogs — cost on the job</option><option value="inventory">inventory — E360 keeps it</option></select>') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr 1fr">' +
    finLabelWrap('Bills to', '<select id="plJob" class="cell-in">' + jobOpts + '</select>') +
    finLabelWrap('Show', '<select id="plShow" class="cell-in">' + showOpts + '</select>') +
    '</div>' +
    '<div class="hint" style="margin-top:4px">' + icon('scale') + '<span><b>auto</b> derives ownership from the allocated job: rental → E360 inventory, sale → COGS. Override per line when the deal says otherwise.</span></div>' +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:12px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('commitAddPOLine') + '>' + icon('check') + 'Add line</button></div>');
}
async function commitAddPOLine() {
  if (!PENDING_PO_LINE) return;
  var item = (document.getElementById('plItem') || {}).value;
  var qty = Number((document.getElementById('plQty') || {}).value);
  if (!item || !(qty > 0)) { toast('Item + quantity required', 'Name the thing and how many'); return; }
  try {
    var l = await api.addPOLine(PENDING_PO_LINE.poId, {
      item: item, qty: qty,
      unit_cost: Number((document.getElementById('plUnit') || {}).value) || 0,
      category: (document.getElementById('plCat') || {}).value || 'gear',
      job_id: Number((document.getElementById('plJob') || {}).value) || null,
      show_id: Number((document.getElementById('plShow') || {}).value) || null,
      ownership: (document.getElementById('plOwn') || {}).value || null
    });
    closeM();
    PENDING_PO_LINE = null;
    toast('Line added', l.item + ' · ' + l.qty + ' × ' + fmtMoney(l.unit_cost) + ' · ' + l.ownership);
  } catch (e) {
    toast('Could not add line', String(e && e.message || e));
    return;
  }
  return refreshFinanceUI();
}

/* ---- attach financial doc (receipt / invoice / po / confirmation) ---------- */
var FIN_DOC_KINDS = [
  { kind: 'receipt', label: 'Receipt', desc: 'paid — proof of spend', ic: 'dollar' },
  { kind: 'invoice', label: 'Invoice', desc: 'billed — awaiting payment', ic: 'file' },
  { kind: 'po', label: 'Purchase order', desc: 'ordered — committed spend', ic: 'box' },
  { kind: 'confirmation', label: 'Confirmation', desc: 'booked — reservation held', ic: 'checkC' }
];
var PENDING_FIN = null;
/* `hint` is optional helper text under the field. It has to undo the label's
   own uppercase/tracking/weight — the label is a caps micro-heading and a
   sentence set in it is unreadable — which is the same little reset the Add-a-
   person username field writes inline. One place now, not two. */
function finLabelWrap(text, inner, hint) {
  return '<label style="display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600">' + text + inner +
    (hint
      ? '<span style="text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;color:var(--muted)">' +
        hint + '</span>'
      : '') +
    '</label>';
}
function guessCategory(label) {
  var s = String(label || '').toLowerCase();
  if (/freight|truck|ship/.test(s)) return 'freight';
  if (/travel|lodging|hotel|flight/.test(s)) return 'travel';
  if (/stagehand|labor|crew|install/.test(s)) return 'labor';
  if (/print|wrap/.test(s)) return 'print';
  if (/led|gear|forklift|rental|hardware/.test(s)) return 'gear';
  return 'misc';
}
async function openAddFinDoc(showId, link) {
  link = link || {};
  PENDING_FIN = { showId: Number(showId), link: link };
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  var pre = { vendor: '', amount: '', category: 'misc' }, ctxLine = '';
  if (link.expenseId) {
    var e = EXPENSES_BY_ID[Number(link.expenseId)];
    if (e) { pre.vendor = e.vendor; pre.amount = e.amount; pre.category = e.budget_line_category; }
    ctxLine = '<div class="callout" style="margin-bottom:14px"><div class="ci">' + icon('link') + '</div><div><b>Attaching paperwork to a recorded cost</b><p>Files against the existing expense — its “waiting on me” flag clears the moment this lands.</p></div></div>';
  } else if (link.bookingId) {
    var b = await api.getBooking(link.bookingId);
    if (b) { pre.vendor = b.vendor; pre.amount = b.amount == null ? '' : b.amount; pre.category = guessCategory(b.category); }
    ctxLine = '<div class="callout" style="margin-bottom:14px"><div class="ci">' + icon('link') + '</div><div><b>Attaching paperwork to a booking</b><p>' + esc(b ? b.category : 'Booking') + ' — clears its “waiting on me” flag and records the cost.</p></div></div>';
  } else if (link.poId) {
    var lpo = POS_BY_ID[Number(link.poId)];
    if (lpo) {
      pre.vendor = lpo.vendor; pre.amount = poTotal(lpo);
      var l0 = (PO_LINES_BY_PO[lpo.id] || [])[0];
      pre.category = l0 ? l0.category : 'gear';
      ctxLine = '<div class="callout" style="margin-bottom:14px"><div class="ci">' + icon('cart') + '</div><div><b>Attaching paperwork to ' + esc(lpo.po_number) + '</b><p>' +
        (link.poKindHint === 'invoice'
          ? 'Pick <b>Invoice</b> to reconcile — it evidences the PO’s cost lines and clears the chase-list flag. No duplicate expense is created; the PO already owns its costs.'
          : 'Pick the doc type — a vendor quote backs the quoted stage; the invoice reconciles it later.') + '</p></div></div>';
    }
  }
  var catOpts = BUDGET_CAT_ORDER.map(function (c) {
    return '<option value="' + esc(c) + '"' + (c === pre.category ? ' selected' : '') + '>' + esc(BUDGET_CATS[c]) + '</option>';
  }).join('');
  var inputs = '<div class="fin-inputs">' +
    finLabelWrap('Vendor', '<input id="fdVendor" class="cell-in" value="' + esc(pre.vendor) + '" placeholder="who billed us">') +
    finLabelWrap('Amount $', '<input id="fdAmount" class="cell-in" type="number" min="0" value="' + esc(pre.amount) + '" placeholder="0">') +
    (link.expenseId ? '' : finLabelWrap('Category', '<select id="fdCat" class="cell-in">' + catOpts + '</select>')) +
    '</div>';
  var cards = FIN_DOC_KINDS.map(function (t, i) {
    return '<button class="tpl-card" style="text-align:left" ' + act('commitFinDoc', i) + '><div class="ti">' + icon(t.ic) + '</div><b>' + esc(t.label) + '</b><div class="td">' + esc(t.desc) + '</div></button>';
  }).join('');
  openModal('Attach financial doc · ' + title, ctxLine +
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">Vendor and amount, then pick the doc type to file it. With an amount it also lands as an expense on the job — budget burn updates immediately.</p>' +
    inputs + notifyRow() + '<div class="tpl-cards" style="margin:0">' + cards + '</div>' +
    '<div class="hint" style="margin-top:14px">' + icon('bolt') + 'Your M365 agent does this filing automatically from your inbox — high-confidence matches file themselves; uncertain ones land as <b>proposed</b> for review.</div>');
}
async function commitFinDoc(i) {
  if (!PENDING_FIN) return;
  var t = FIN_DOC_KINDS[Number(i)];
  if (!t) return;
  var vEl = document.getElementById('fdVendor'), aEl = document.getElementById('fdAmount'), cEl = document.getElementById('fdCat');
  stageNotifies();
  var f = await api.addFinancialDoc(PENDING_FIN.showId, {
    kind: t.kind,
    vendor: vEl && vEl.value ? vEl.value : null,
    amount: aEl && aEl.value !== '' ? Number(aEl.value) : null,
    category: cEl ? cEl.value : null,
    expenseId: PENDING_FIN.link.expenseId || null,
    bookingId: PENDING_FIN.link.bookingId || null,
    poId: PENDING_FIN.link.poId || null
  });
  closeM();
  PENDING_FIN = null;
  var fs2 = SHOWS_BY_ID[f.show_id];
  var suffix = await sendNotifies('file', f.id, 'filed a ' + t.label.toLowerCase() + ': ' + (f.vendor || f.name) +
    (f.amount ? ' · ' + fmtMoney(f.amount) : '') + (fs2 ? ' — ' + showLabel(fs2) : ''));
  toast(t.label + ' filed', (f.vendor || '') + (f.amount ? ' · ' + fmtMoney(f.amount) : '') + ' → Accounting’s feed' + suffix);
  await updateFinCount();
  if (CUR.view === 'show') return refreshShowTab(CUR.showId, 'financials');
  return refreshFinanceUI();
}

/* ---- add expense ----------------------------------------------------------- */
var PENDING_EXP = null;
async function openAddExpense(showId) {
  PENDING_EXP = { showId: Number(showId) };
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  var jobOpts = (show.project.jobs || []).map(function (j) {
    return '<option value="' + Number(j.id) + '"' + (j.id === show.default_job_id ? ' selected' : '') + '>' +
      esc(j.qb_job_number + ' · ' + j.client + (j.deal_type ? ' · ' + j.deal_type : '') + (j.id === show.default_job_id ? ' (default)' : '')) + '</option>';
  }).join('');
  var catOpts = BUDGET_CAT_ORDER.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(BUDGET_CATS[c]) + '</option>';
  }).join('');
  openModal('Add expense · ' + title,
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">Records a cost against a job — budget burn updates immediately, and it sits on Accounting’s “waiting on me” list until its receipt lands.</p>' +
    '<div class="fin-inputs">' +
    finLabelWrap('Vendor', '<input id="exVendor" class="cell-in" placeholder="who we paid">') +
    finLabelWrap('Amount $', '<input id="exAmount" class="cell-in" type="number" min="0" placeholder="0">') +
    finLabelWrap('Category', '<select id="exCat" class="cell-in">' + catOpts + '</select>') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Bills to', '<select id="exJob" class="cell-in">' + jobOpts + '</select>') + '</div>' +
    notifyRow() +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('commitAddExpense') + '>' + icon('check') + 'Record expense</button></div>');
}
async function commitAddExpense() {
  if (!PENDING_EXP) return;
  var v = (document.getElementById('exVendor') || {}).value;
  var a = (document.getElementById('exAmount') || {}).value;
  if (!v || !(Number(a) > 0)) { toast('Vendor + amount required', 'Give the cost a vendor and a dollar amount'); return; }
  var show = await api.getShow(PENDING_EXP.showId);
  var jid = Number((document.getElementById('exJob') || {}).value) || null;
  stageNotifies();
  var e = await api.addExpense(PENDING_EXP.showId, {
    vendor: v, amount: Number(a),
    category: (document.getElementById('exCat') || {}).value || 'misc',
    job_id: jid && jid !== show.default_job_id ? jid : null
  });
  closeM();
  PENDING_EXP = null;
  var job = JOBS_BY_ID[e.job_id || show.default_job_id];
  var suffix = await sendNotifies('show', show.id, 'recorded an expense: ' + v + ' · ' + fmtMoney(e.amount) + ' — ' + showLabel(show));
  toast('Expense recorded', v + ' · ' + fmtMoney(e.amount) + (job ? ' → job ' + job.qb_job_number : '') + ' — awaiting its receipt' + suffix);
  await updateFinCount();
  if (CUR.view === 'show') return refreshShowTab(CUR.showId, 'financials');
  return refreshFinanceUI();
}

/* ---- "View as" — the visibility gate, demonstrable -------------------------
   DEMO ONLY. With a real server the identity IS the session: role, finance
   capability and every gate are read live from `users` on every request, so
   pretending to be someone else in the browser would show you a lie. Signing
   in as them is the real thing, and it is one click away in Settings. */
async function viewAs(userId) {
  if (!api.isDemo()) {
    toast('Not in a live session', 'Roles come from the server — sign in as that person to see their view');
    return;
  }
  var u = USERS_BY_ID[Number(userId)];
  if (!u || u.username === CURRENT_USER.username) return;
  CURRENT_USER = u; ME = u.username;
  paintMe();
  toast('Viewing as ' + u.name, canSeeFinance(u) ? 'Finance visibility ON — margin renders' : 'Margin hidden — budgets still visible');
  closeBellPanel();                       /* the inbox is personal — swap it */
  updateBellBadge();
  await updateMineCount();
  var arg = CUR.view === 'show' ? CUR.showId : CUR.view === 'job' ? CUR.jobId
    : CUR.view === 'folder' ? CUR.projectId : CUR.view === 'po' ? CUR.poId : undefined;
  return render(CUR.view, arg);
}

/* ============================================================================
   SCHEDULE ACTIONS — day select · my-day · print/preview · add/edit item
   (call-sheet pass). Mutations go through api.* (which enforces the pm+
   gate server-side) and re-render the tab from fresh data.
   ========================================================================== */
async function schedSetDay(showId, day) {
  SCHED_UI.day[Number(showId)] = day;
  return refreshShowTab(showId, 'schedule');
}
async function schedToggleMy(showId) {
  SCHED_UI.my = !SCHED_UI.my;
  return refreshShowTab(showId, 'schedule');
}
async function schedPrintAct(showId) {
  var show = await api.getShow(showId);
  printCallSheet(show);
}
async function schedPreviewAct(showId) {
  var show = await api.getShow(showId);
  var title = show.project.single ? show.project.name : show.name;
  openModal('Call sheet · ' + title,
    '<div style="display:flex;justify-content:flex-end;margin-bottom:12px"><button class="btn sm primary" ' + act('schedPrint', show.id) + '>' + icon('print') + 'Print</button></div>' +
    '<div style="display:grid;place-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:16px">' + callSheetSheet(show) + '</div>');
}
var PENDING_SCHED = null;
async function openSchedItem(showId, itemId) {
  var show = await api.getShow(showId);
  var it = itemId ? SCHEDULE_BY_ID[Number(itemId)] : null;
  PENDING_SCHED = { showId: Number(showId), itemId: it ? it.id : null };
  var days = scheduleDays(show.id);
  [show.load_in_date, show.event_date, show.strike_date].forEach(function (d) { if (d && days.indexOf(d) < 0) days.push(d); });
  days.sort();
  var defDay = it ? it.day : (SCHED_UI.day[show.id] || days[0]);
  var dayOpts = days.map(function (d) {
    var tag = schedDayTag(show, d);
    return '<option value="' + esc(d) + '"' + (d === defDay ? ' selected' : '') + '>' + esc(fmtDayDate(d) + (tag ? ' · ' + tag : '')) + '</option>';
  }).join('');
  var kindOpts = SCHED_KIND_ORDER.map(function (k) {
    return '<option value="' + esc(k) + '"' + (it && it.kind === k ? ' selected' : '') + '>' + esc(SCHED_KINDS[k].label) + '</option>';
  }).join('');
  /* who: all crew · one crew member · techs-as-a-role (encoded, decoded on save) */
  var whoVal = !it || it.who === 'all' ? 'all'
    : Object.prototype.toString.call(it.who) === '[object Array]' ? (it.who.length === 1 ? 'u:' + it.who[0] : 'all') : 'r:' + it.who;
  var whoOpts = '<option value="all"' + (whoVal === 'all' ? ' selected' : '') + '>All crew</option>' +
    crewForShow(show.id).filter(function (c) { return c.username; }).map(function (c) {
      var v = 'u:' + c.username;
      return '<option value="' + esc(v) + '"' + (whoVal === v ? ' selected' : '') + '>' + esc(userName(c.username)) + '</option>';
    }).join('') +
    '<option value="r:tech"' + (whoVal === 'r:tech' ? ' selected' : '') + '>Techs (role)</option>';
  openModal((it ? 'Edit' : 'Add') + ' schedule item · ' + (show.project.single ? show.project.name : show.name),
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Title', '<input id="rsTitle" class="cell-in" value="' + esc(it ? it.title : '') + '" placeholder="what happens">') + '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1.4fr 96px 96px">' +
    finLabelWrap('Day', '<select id="rsDay" class="cell-in">' + dayOpts + '</select>') +
    finLabelWrap('Start', '<input id="rsStart" class="cell-in mono" value="' + esc(it ? it.start_time : '') + '" placeholder="HH:MM">') +
    finLabelWrap('End', '<input id="rsEnd" class="cell-in mono" value="' + esc(it && it.end_time ? it.end_time : '') + '" placeholder="—">') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr 1fr 1fr">' +
    finLabelWrap('Kind', '<select id="rsKind" class="cell-in">' + kindOpts + '</select>') +
    finLabelWrap('Who', '<select id="rsWho" class="cell-in">' + whoOpts + '</select>') +
    finLabelWrap('Location', '<input id="rsLoc" class="cell-in" value="' + esc(it ? it.location : '') + '" placeholder="dock · court · office">') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Detail', '<input id="rsDetail" class="cell-in" value="' + esc(it ? it.detail : '') + '" placeholder="the note under the line (optional)">') + '</div>' +
    /* notify only on ADD — editing a time or caption is routine and silent */
    (it ? '' : notifyRow()) +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">' +
    (it ? '<button class="btn ghost" style="color:var(--crit);margin-right:auto" ' + act('schedDelete', it.id) + '>' + icon('trash') + 'Remove</button>' : '') +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('schedSave') + '>' + icon('check') + (it ? 'Save' : 'Add to schedule') + '</button></div>');
}
function _schedWhoDecode(v) {
  if (!v || v === 'all') return 'all';
  if (v.indexOf('u:') === 0) return [v.slice(2)];
  if (v.indexOf('r:') === 0) return v.slice(2);
  return 'all';
}
async function schedSaveAct() {
  if (!PENDING_SCHED) return;
  var body = {
    title: (document.getElementById('rsTitle') || {}).value || '',
    day: (document.getElementById('rsDay') || {}).value || '',
    start_time: (document.getElementById('rsStart') || {}).value || '',
    end_time: (document.getElementById('rsEnd') || {}).value || null,
    kind: (document.getElementById('rsKind') || {}).value || 'work',
    who: _schedWhoDecode((document.getElementById('rsWho') || {}).value),
    location: (document.getElementById('rsLoc') || {}).value || '',
    detail: (document.getElementById('rsDetail') || {}).value || ''
  };
  try {
    var wasEdit = !!PENDING_SCHED.itemId;
    if (!wasEdit) stageNotifies();          /* edits stay silent */
    var it = wasEdit
      ? await api.updateScheduleItem(PENDING_SCHED.itemId, body)
      : await api.addScheduleItem(PENDING_SCHED.showId, body);
    closeM();
    SCHED_UI.day[PENDING_SCHED.showId] = it.day;         /* land on the day you touched */
    var suffix = '';
    if (!wasEdit) {                                      /* edits stay silent */
      var ns = SHOWS_BY_ID[PENDING_SCHED.showId];
      suffix = await sendNotifies('show', PENDING_SCHED.showId,
        'added to the schedule: ' + it.title + ' · ' + fmtDayDate(it.day) + ' ' + fmtHM(it.start_time) +
        (ns ? ' — ' + showLabel(ns) : ''));
    }
    toast(wasEdit ? 'Schedule updated' : 'Added to the schedule', it.title + ' · ' + fmtHM(it.start_time) + suffix);
    var sid = PENDING_SCHED.showId;
    PENDING_SCHED = null;
    if (CUR.view === 'show') return refreshShowTab(sid, 'schedule');
  } catch (e) {
    toast('Not saved', String(e && e.message || e));
  }
}
async function schedDeleteAct(itemId) {
  try {
    var r = await api.removeScheduleItem(itemId);
    closeM();
    PENDING_SCHED = null;
    toast('Removed from the schedule', 'The call sheet updates everywhere it renders');
    if (CUR.view === 'show') return refreshShowTab(r.show_id, 'schedule');
  } catch (e) {
    toast('Not removed', String(e && e.message || e));
  }
}

/* ============================================================================
   EVENT PHOTO ACTIONS — recap-pick toggle · confirm/reject proposals ·
   tag filter · inline caption edit · global-files mode (photo pass).
   Every mutation goes through api.* then re-renders from fresh data.
   ========================================================================== */
async function photoPickAct(fileId) {
  var cur = await api.getFile(fileId);
  if (!cur) return;
  try {
    var f = await api.setRecapPick(fileId, !cur.recap_pick);
    toast(f.recap_pick ? 'Starred for the recap' : 'Removed from the recap picks',
      String(f.caption || f.name).slice(0, 64));
  } catch (e) {
    toast('Not starred', String(e && e.message || e));
    return;
  }
  if (CUR.view === 'viewer') return drawViewer(await api.getShow(VIEWER.showId));
  if (CUR.view === 'show') return refreshShowTab(CUR.showId);
  if (CUR.view === 'files') return render('files');
}
async function photoConfirmAct(fileId) {
  try {
    var f = await api.confirmPhoto(fileId);
    toast('Photo confirmed & filed', String(f.caption || f.name).slice(0, 64));
  } catch (e) {
    toast('Not confirmed', String(e && e.message || e));
    return;
  }
  refreshBellPanel();
  updateBellBadge();
  if (CUR.view === 'viewer') return drawViewer(await api.getShow(VIEWER.showId));
  if (CUR.view === 'show') return refreshShowTab(CUR.showId);
  if (CUR.view === 'files') return render('files');
}
async function photoRejectAct(fileId) {
  var f = await api.getFile(fileId);
  if (!f) return;
  var showId = f.show_id;
  try {
    await api.rejectPhoto(fileId);
    toast('Proposal rejected', 'Nothing landed — the NAS quarantine copy is discarded');
  } catch (e) {
    toast('Not rejected', String(e && e.message || e));
    return;
  }
  refreshBellPanel();
  updateBellBadge();
  if (CUR.view === 'viewer') { await openShow(showId); return setFolderTab('photos'); }
  if (CUR.view === 'show') return refreshShowTab(showId);
  if (CUR.view === 'files') return render('files');
}
async function phTagAct(showId, tag) {
  var cur = PH_UI.tag[Number(showId)] || null;
  PH_UI.tag[Number(showId)] = (tag === '*' || tag === cur) ? null : tag;
  return refreshShowTab(showId, 'photos');
}
async function phCapEditAct(fileId) {
  PH_UI.editCap = Number(fileId);
  drawViewer(await api.getShow(VIEWER.showId));
  var ta = document.getElementById('phCapIn');
  if (ta && ta.focus) ta.focus();
}
async function phCapSaveAct(fileId) {
  var ta = document.getElementById('phCapIn');
  try {
    var f = await api.updatePhoto(fileId, { caption: ta ? ta.value : '' });
    PH_UI.editCap = null;
    toast('Caption updated', String(f.caption).slice(0, 64));
  } catch (e) {
    toast('Not saved', String(e && e.message || e));
    return;
  }
  return drawViewer(await api.getShow(VIEWER.showId));
}
async function phCapCancelAct() {
  PH_UI.editCap = null;
  return drawViewer(await api.getShow(VIEWER.showId));
}
async function filesModeAct(mode) {
  FILES_UI.mode = mode === 'photos' || mode === 'all' ? mode : 'docs';
  return render('files');
}

/* ============================================================================
   CLIENT RECAP ACTIONS — generate · edit in place · approve · mark sent ·
   reopen · preview/print the client sheet  (recap pass)

   Every mutation goes through api.*, which owns the role gate, the draft-only
   rule and the client-facing content firewall. A refusal surfaces verbatim in
   the toast — when the firewall blocks an edit, the person reads exactly what
   tripped it. NOTHING here sends: rcMarkSent records a human's act.
   ========================================================================== */
async function refreshRecap(showId) {
  updateBellBadge();
  refreshBellPanel();
  if (CUR.view === 'show') return refreshShowTab(showId, 'recap');
  if (CUR.view === 'folder') return render('folder', CUR.projectId);
  return refreshFinanceUI();
}
async function rcGenerateAct(showId) {
  var had = await api.getRecap(showId);
  try {
    var rec = await api.generateRecap(showId);
    RECAP_UI.edit = null;
    var rb = rec.body || {};
    toast(had ? 'Draft regenerated' : 'Recap drafted',
      (rb.highlights || []).length + ' highlights · ' + (rb.photo_ids || []).length + ' photos — review it before anything goes out');
  } catch (e) {
    toast('Not generated', String(e && e.message || e));
    return;
  }
  return refreshRecap(showId);
}
function rcEditAct(showId, key) {
  RECAP_UI.edit = key;
  return refreshShowTab(showId, 'recap').then(function () {
    var i = document.getElementById('rcIn');
    if (i && i.focus) i.focus();
  });
}
async function rcCancelAct() {
  RECAP_UI.edit = null;
  if (CUR.view === 'show') return refreshShowTab(CUR.showId, 'recap');
}
/* one save path for every section — key is 'headline' | 'closing' | 'n:i' |
   'h:i' | 's:i', so the patch is always a whole-section replacement */
async function rcSaveAct(showId, key) {
  var rec = await api.getRecap(showId);
  if (!rec) return;
  var v = (document.getElementById('rcIn') || {}).value;
  var v2 = (document.getElementById('rcIn2') || {}).value;
  var patch = null, k = String(key || '');
  if (k === 'headline') patch = { headline: v };
  else if (k === 'closing') patch = { closing: v };
  else if (k.indexOf('n:') === 0) {
    var narr = (rec.body.narrative || []).slice();
    narr[Number(k.slice(2))] = v;
    patch = { narrative: narr };
  } else if (k.indexOf('h:') === 0) {
    var hl = (rec.body.highlights || []).slice();
    hl[Number(k.slice(2))] = v;
    patch = { highlights: hl };
  } else if (k.indexOf('s:') === 0) {
    var st = (rec.body.stats || []).map(function (x) { return { label: x.label, value: x.value }; });
    st[Number(k.slice(2))] = { label: v, value: v2 };
    patch = { stats: st };
  }
  if (!patch) return;
  try {
    await api.updateRecap(showId, patch);
    RECAP_UI.edit = null;
    toast('Recap updated', 'Saved to the draft — still nothing sent');
  } catch (e) {
    /* the content firewall speaks here, in the person's own words */
    toast('Not saved', String(e && e.message || e));
    return;
  }
  return refreshRecap(showId);
}
async function rcAddAct(showId, what) {
  var rec = await api.getRecap(showId);
  if (!rec) return;
  var patch = null, key = null;
  if (what === 'narrative') {
    var narr = (rec.body.narrative || []).slice();
    narr.push('New paragraph.');
    patch = { narrative: narr }; key = 'n:' + (narr.length - 1);
  } else if (what === 'highlight') {
    var hl = (rec.body.highlights || []).slice();
    hl.push('New highlight');
    patch = { highlights: hl }; key = 'h:' + (hl.length - 1);
  } else if (what === 'stat') {
    var st = (rec.body.stats || []).map(function (x) { return { label: x.label, value: x.value }; });
    st.push({ label: 'New stat', value: '—' });
    patch = { stats: st }; key = 's:' + (st.length - 1);
  }
  if (!patch) return;
  try { await api.updateRecap(showId, patch); } catch (e) { toast('Not added', String(e && e.message || e)); return; }
  return rcEditAct(showId, key);
}
async function rcDelAct(showId, key) {
  var rec = await api.getRecap(showId);
  if (!rec) return;
  var k = String(key || ''), i = Number(k.slice(2)), patch = null;
  if (k.indexOf('n:') === 0) patch = { narrative: (rec.body.narrative || []).filter(function (_, j) { return j !== i; }) };
  else if (k.indexOf('h:') === 0) patch = { highlights: (rec.body.highlights || []).filter(function (_, j) { return j !== i; }) };
  else if (k.indexOf('s:') === 0) patch = { stats: (rec.body.stats || []).filter(function (_, j) { return j !== i; }) };
  if (!patch) return;
  try {
    await api.updateRecap(showId, patch);
    RECAP_UI.edit = null;
    toast('Removed from the draft', 'The recap updates everywhere it renders');
  } catch (e) { toast('Not removed', String(e && e.message || e)); return; }
  return refreshRecap(showId);
}
async function rcPhotoAct(fileId, how) {
  var f = await api.getFile(fileId);
  if (!f) return;
  try {
    if (how === 'remove') await api.removeRecapPhoto(f.show_id, f.id);
    else if (how === 'add') await api.addRecapPhoto(f.show_id, f.id);
    else await api.reorderRecapPhoto(f.show_id, f.id, how === 'up' ? -1 : 1);
  } catch (e) { toast('Not changed', String(e && e.message || e)); return; }
  return refreshRecap(f.show_id);
}
async function rcApproveAct(showId) {
  try {
    var rec = await api.approveRecap(showId);
    RECAP_UI.edit = null;
    toast('Recap approved', 'Locked for send by ' + userName(rec.approved_by) + ' — sending is still a human act');
  } catch (e) { toast('Not approved', String(e && e.message || e)); return; }
  return refreshRecap(showId);
}
async function rcReopenAct(showId) {
  try {
    await api.reopenRecap(showId);
    toast('Reopened for edits', 'Back to draft — it cannot be marked sent until it is approved again');
  } catch (e) { toast('Not reopened', String(e && e.message || e)); return; }
  return refreshRecap(showId);
}
/* the mock. Records a send a person performed; performs no send. */
async function rcMarkSentAct(showId) {
  var show = await api.getShow(showId);
  var poc = show.client_poc ? show.client_poc.name : (show.job ? show.job.client : show.project.client);
  openModal('Mark the recap sent · ' + (show.project.single ? show.project.name : show.name),
    '<div class="callout" style="margin-bottom:14px"><div class="ci">' + icon('lock') + '</div><div><b>This does not send anything</b>' +
    '<p>Showrunner has no outbound path — not for you and not for any agent (that is the “file, don’t fire” rule the whole agent surface is built on). Send the approved recap from your own mail, then record it here so the folder knows it went.</p></div></div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Sent to', '<input id="rcSentTo" class="cell-in" value="' + esc(poc || '') + '" placeholder="the client contact who received it">') + '</div>' +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('rcCommitSent', show.id) + '>' + icon('check') + 'Record it as sent</button></div>');
}
async function rcCommitSentAct(showId) {
  var to = (document.getElementById('rcSentTo') || {}).value;
  try {
    var rec = await api.markSent(showId, to);
    closeM();
    toast('Recorded as sent', 'Recap sent to ' + rec.sent_to + ' — logged to the folder’s activity');
  } catch (e) { toast('Not recorded', String(e && e.message || e)); return; }
  return refreshRecap(showId);
}
async function rcPreviewAct(showId) {
  var show = await api.getShow(showId);
  var rec = await api.getRecap(showId);
  if (!rec) { toast('No recap yet', 'Generate a draft first'); return; }
  var title = show.project.single ? show.project.name : show.name;
  openModal('Client recap · ' + title,
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:9px;margin-bottom:12px;flex-wrap:wrap">' +
    '<span class="pill ' + esc(recapStatusMeta(rec).pill) + '"><span class="dot"></span>' + esc(recapStatusMeta(rec).label) + '</span>' +
    '<button class="btn sm primary" ' + act('rcPrint', show.id) + '>' + icon('print') + 'Print</button></div>' +
    '<div style="display:grid;place-items:center;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:16px">' +
    recapSheet(show, rec) + '</div>');
}
async function rcPrintAct(showId) {
  var show = await api.getShow(showId);
  var rec = await api.getRecap(showId);
  if (!rec) { toast('No recap yet', 'Generate a draft first'); return; }
  printRecapSheet(show, rec);
}
/* bell row -> straight to the recap tab of the show it belongs to */
async function rcReviewAct(showId) {
  closeBellPanel();
  RECAP_UI.edit = null;
  await openShow(showId);
  setFolderTab('recap');
}

/* ============================================================================
   MOBILE NAV DRAWER — ≤760px the rail becomes a slide-in drawer behind a
   topbar hamburger (call-sheet pass; the audit's #1 UX issue). State lives
   here; the slide itself is CSS on body.nav-open.
   ========================================================================== */
var MOBILE_NAV = { open: false };
function setNavOpen(open) {
  MOBILE_NAV.open = !!open;
  if (document.body && document.body.classList) document.body.classList.toggle('nav-open', MOBILE_NAV.open);
  var sc = document.getElementById('navScrim');
  if (sc && sc.classList) sc.classList.toggle('on', MOBILE_NAV.open);
}
function toggleNavDrawer() { setNavOpen(!MOBILE_NAV.open); }

/* ============================================================================
   NOTES + MENTIONS ACTIONS — post / reply / edit / read / deep-link. Every
   mutation goes through api.* then re-renders the current view from fresh
   data (refreshFinanceUI is the app's generic "repaint whatever is on
   screen" helper — notes ride it too).
   ========================================================================== */
async function postNoteFrom(el2) {
  var box = el2 && el2.classList && el2.classList.contains('note-composer')
    ? el2 : (el2 && el2.closest ? el2.closest('.note-composer') : null);
  if (!box) return;
  var ta = box.querySelector('.note-in');
  var body = ta && ta.value ? ta.value.trim() : '';
  if (!body) { toast('Nothing to post', 'Write the note first'); return; }
  var n = await api.addNote({
    anchor_type: box.getAttribute('data-anchor-type'),
    anchor_id: Number(box.getAttribute('data-anchor-id')),
    parent_id: Number(box.getAttribute('data-parent')) || null,
    body: body
  });
  NOTES_UI.replyTo = null;
  closeMentionPop();
  toast('Note posted', n.mentions.length ? 'Pinged ' + n.mentions.map(firstName).join(', ') : 'On the record, anchored here');
  await refreshFinanceUI();
  flashNote(n.id);
}
async function noteReplyAct(id) {
  var n = NOTES_BY_ID[Number(id)];
  if (!n) return;
  NOTES_UI.replyTo = n.parent_id || n.id;
  NOTES_UI.expanded[n.anchor_type + ':' + n.anchor_id] = 1;
  if (n.anchor_type === 'step') NOTES_UI.openSteps[n.anchor_id] = 1;
  await refreshFinanceUI();
  var ta = document.querySelector('.note-composer[data-parent="' + NOTES_UI.replyTo + '"] .note-in');
  if (ta && ta.focus) ta.focus();
}
async function noteEditAct(id) {
  NOTES_UI.editing = Number(id);
  await refreshFinanceUI();
  var ta = document.querySelector('.note-edit-in[data-note="' + Number(id) + '"]');
  if (ta && ta.focus) ta.focus();
}
async function noteEditSaveAct(id) {
  var ta = document.querySelector('.note-edit-in[data-note="' + Number(id) + '"]');
  var body = ta && ta.value ? ta.value.trim() : '';
  try {
    var n = await api.editNote(id, body);
    NOTES_UI.editing = null;
    toast('Note updated', 'Edited marker set' + (n.mentions.length ? ' · mentions re-parsed' : ''));
  } catch (e) {
    toast('Not saved', String(e && e.message || e));
    return;
  }
  return refreshFinanceUI();
}
async function noteEditCancelAct() {
  NOTES_UI.editing = null;
  return refreshFinanceUI();
}
async function noteToggleStepAct(stepId) {
  NOTES_UI.openSteps[stepId] = !NOTES_UI.openSteps[stepId];
  if (CUR.view === 'show') return refreshShowTab(CUR.showId, 'pipeline');
  return refreshFinanceUI();
}
async function noteExpandAct(key) {
  NOTES_UI.expanded[key] = 1;
  return refreshFinanceUI();
}
async function bellMarkAllAct() {
  await api.markAllNotesRead();
  updateBellBadge();
  refreshBellPanel();
  toast('Inbox cleared', 'Every mention and reply marked read');
}
/* deep link: bell row -> the anchored thing, thread open, note flashed */
async function openNoteAct(noteId) {
  var n = NOTES_BY_ID[Number(noteId)];
  if (!n) return;
  await api.markNotesRead([n.id]);
  closeBellPanel();
  updateBellBadge();
  NOTES_UI.expanded[n.anchor_type + ':' + n.anchor_id] = 1;
  if (n.anchor_type === 'show') await render('show', n.anchor_id);
  else if (n.anchor_type === 'step') {
    var st = STEPS_BY_ID[n.anchor_id];
    if (!st) return;
    NOTES_UI.openSteps[st.id] = 1;
    await render('show', st.show_id);
    setFolderTab('pipeline');
  } else if (n.anchor_type === 'file') {
    var f = FILES_BY_ID[n.anchor_id];
    if (!f) return;
    await openViewer(f.id);
  } else if (n.anchor_type === 'po') await render('po', n.anchor_id);
  else if (n.anchor_type === 'job') await render('job', n.anchor_id);
  else if (n.anchor_type === 'project') await openFolder(n.anchor_id);
  flashNote(n.id);
}

/* ============================================================================
   F5 · CONFIRM — the explicit act, and the QuickBooks moment it creates
   ----------------------------------------------------------------------------
   Confirming is not a stage dropdown. It records that the client committed, it
   is datestamped and logged, and it is the moment two other things become
   possible: the scheduler push unlocks, and Candice can cut the real QB number
   for a job that has been running on a placeholder. So the flow hands off
   straight into the existing job-number dialog rather than leaving a toast the
   person has to act on later.
   ========================================================================== */
async function confirmShowAct(showId) {
  var show = await api.getShow(showId);
  if (!show) return;
  var r;
  try {
    r = await api.confirmShow(showId);
  } catch (e) {
    toast('Not confirmed', String(e && e.message || e));
    return;
  }
  toast('Confirmed', showLabel(show) + ' — the client committed. Scheduler push is unlocked.');
  await refreshFinanceUI();
  if (r && r.qb_prompt) {
    /* the natural moment for the real number, per Tom's spec — offered, not
       forced: a pm who cannot cut QB numbers gets told who can. */
    return openJobNumber(r.qb_prompt.job_id);
  }
}

/* ============================================================================
   F4 · SCOPE — edit by hand, or fill from the bound spec
   ----------------------------------------------------------------------------
   Divergence between the sold scope and a bound spec is a QUESTION, never an
   error and never a silent overwrite — the same rule the chain checker lives
   by, and for the same reason: two correct documents can legitimately disagree.
   ========================================================================== */
var PENDING_SCOPE = null;
async function openScopeEditor(showId) {
  var show = await api.getShow(showId);
  if (!show) return;
  var sc = await api.getScope(showId);
  PENDING_SCOPE = { showId: Number(showId) };
  var kind = (sc.scope && sc.scope.kind) || (show.type === 'print' ? 'print' : show.type);
  var isLed = kind === 'led' || kind === 'both';
  var isPrint = kind === 'print' || kind === 'both';
  var val = function (k) {
    var v = sc.scope ? sc.scope[k] : null;
    return v === null || v === undefined ? '' : String(v);
  };
  var kindOpts = SCOPE_KINDS.map(function (k) {
    return '<option value="' + esc(k) + '"' + (k === kind ? ' selected' : '') + '>' + esc(SCOPE_LABEL[k]) + '</option>';
  }).join('');

  var qBlock = (sc.questions || []).map(function (q) {
    return '<div class="scope-q">' + inlineIcon('alert') + '<div><b>' + esc(q.ask) + '</b>' +
      '<span>' + esc(q.detail) + '</span></div></div>';
  }).join('');
  var specBlock = sc.spec && sc.spec.available
    ? '<div class="hint" style="margin-top:2px">' + icon('layers') + '<span>The bound ' +
      esc(sc.spec.count_source || 'spec') + ' counts <b>' + esc(String(sc.spec.cabinet_count)) +
      '</b> cabinets' + (sc.spec.stack_aware ? ' (stack-aware)' : '') +
      (sc.spec.cabinet_type ? ' of <b>' + esc(sc.spec.cabinet_type) + '</b>' : '') + '. ' +
      '<span class="lnk-btn" ' + act('scopeFromSpec', Number(showId)) + '>Fill from the spec</span> — ' +
      'linear feet and pitch stay hand-entered, because no node of the chain records them.</span></div>'
    : '<div class="hint" style="margin-top:2px">' + icon('layers') + '<span>Nothing bound to this show can ' +
      'answer for the scope yet. Bind a .e360, .nsf or .pcfg and the cabinet count fills itself — ' +
      'stack-aware.</span></div>';

  openModal('Scope · ' + showLabel(show),
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px">What we are delivering, structured. ' +
    'It prints on the show header, the season row, the projects table and the call sheet — and it is ' +
    'client-safe, so it feeds the recap’s stats.</p>' +
    qBlock +
    '<div class="fin-inputs" style="grid-template-columns:1fr"> ' +
    finLabelWrap('Kind', '<select id="scKind" class="cell-in">' + kindOpts + '</select>') + '</div>' +
    (isLed ? '<div class="fin-inputs" style="grid-template-columns:1fr 1fr 1fr 1fr">' +
      finLabelWrap('Linear feet', '<input id="scFeet" class="cell-in" type="number" min="0" value="' + esc(val('linear_feet')) + '">') +
      finLabelWrap('Cabinets', '<input id="scCabs" class="cell-in" type="number" min="0" value="' + esc(val('cabinet_count')) + '">') +
      finLabelWrap('Cabinet type', '<input id="scCabType" class="cell-in" value="' + esc(val('cabinet_type')) + '">') +
      finLabelWrap('Pitch', '<input id="scPitch" class="cell-in" value="' + esc(val('pitch')) + '">') +
      '</div>' : '') +
    (isPrint ? '<div class="fin-inputs" style="grid-template-columns:1fr 1fr">' +
      finLabelWrap('Pieces', '<input id="scPieces" class="cell-in" type="number" min="0" value="' + esc(val('print_pieces')) + '">') +
      finLabelWrap('Square feet', '<input id="scSqft" class="cell-in" type="number" min="0" value="' + esc(val('print_sqft')) + '">') +
      '</div>' : '') +
    specBlock +
    notifyRow() +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:12px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('commitScope') + '>' + icon('check') + 'Save scope</button></div>');
}
async function commitScope() {
  if (!PENDING_SCOPE) return;
  var v = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };
  var num2 = function (id) { var s = v(id); return s === '' ? null : Number(s); };
  var patch = {
    kind: v('scKind') || null,
    linear_feet: num2('scFeet'), cabinet_count: num2('scCabs'),
    cabinet_type: v('scCabType') || null, pitch: v('scPitch') || null,
    print_pieces: num2('scPieces'), print_sqft: num2('scSqft'),
    source: 'manual'
  };
  stageNotifies();
  var show;
  try {
    show = await api.setScope(PENDING_SCOPE.showId, patch);
  } catch (e) {
    toast('Scope not saved', String(e && e.message || e));
    return;
  }
  closeM();
  var suffix = await sendNotifies('show', PENDING_SCOPE.showId,
    'set the scope to ' + (scopeLine(show) || '—') + ' —');
  toast('Scope saved', (scopeLine(show) || 'cleared') + suffix);
  PENDING_SCOPE = null;
  return render('show', show.id || CUR.showId);
}
async function scopeFromSpecAct(showId) {
  try {
    var show = await api.scopeFromSpec(showId);
    closeM();
    toast('Filled from the bound spec', scopeLine(show) + ' — stack-aware where the spec records stacking');
    return render('show', Number(showId));
  } catch (e) {
    toast('Nothing to fill from', String(e && e.message || e));
  }
}

/* ============================================================================
   F2 · TECH SHOW REPORTS — write mine · review theirs · nag
   ----------------------------------------------------------------------------
   A pm has exactly three levers here and none of them writes: nag, read, mark
   reviewed. A report attributed to somebody who did not write it is worse than
   a missing one, so there is no affordance anywhere for writing someone else's.
   ========================================================================== */
async function markStruckAct(showId) {
  try {
    var r = await api.markStruck(showId);
    toast('Marked struck', r.created
      ? r.created + ' show report' + (r.created === 1 ? '' : 's') + ' now owed — the crew has been asked'
      : 'nobody on the crew has a login, so no report is owed');
  } catch (e) {
    toast('Not marked', String(e && e.message || e));
    return;
  }
  await updateBellBadge();
  return refreshShowTab(Number(showId), 'reports');
}
async function repEditAct(id) {
  REPORT_UI.editing = Number(id);
  await refreshShowTab(CUR.showId, 'reports');
  var ta = document.getElementById('repIn' + Number(id));
  if (ta && ta.focus) ta.focus();
}
async function repCancelAct() {
  REPORT_UI.editing = null;
  return refreshShowTab(CUR.showId, 'reports');
}
async function repSaveAct(id) {
  var ta = document.getElementById('repIn' + Number(id));
  var body = ta ? String(ta.value || '').trim() : '';
  if (!body) { toast('Nothing to file', 'Write the report first, or attach a document'); return; }
  var rep = REPORTS_BY_ID[Number(id)];
  var showId = rep ? rep.show_id : CUR.showId;
  var r;
  try {
    r = await api.fileTechReport(showId, { body: body });
  } catch (e) {
    toast('Not filed', String(e && e.message || e));
    return;
  }
  REPORT_UI.editing = null;
  toast('Report filed', r.summary && r.summary.owed
    ? 'In the folder’s files. Still waiting on ' + r.summary.owed + ' other' + (r.summary.owed === 1 ? '' : 's') + '.'
    : 'In the folder’s files — every report on this show is now in.');
  await updateBellBadge();
  await updateMineCount();
  return refreshShowTab(showId, 'reports');
}
async function repReviewAct(id) {
  try { await api.reviewTechReport(id); toast('Marked reviewed', 'Optional bookkeeping — filing was what cleared it'); }
  catch (e) { toast('Not reviewed', String(e && e.message || e)); return; }
  return refreshShowTab(CUR.showId, 'reports');
}
async function repReopenAct(id) {
  try { await api.reopenTechReport(id); toast('Reopened', 'Back to filed — they can revise it'); }
  catch (e) { toast('Not reopened', String(e && e.message || e)); return; }
  return refreshShowTab(CUR.showId, 'reports');
}
async function repNagAct(id) {
  var rep = REPORTS_BY_ID[Number(id)];
  if (!rep) return;
  try {
    await api.nagTechReports(rep.show_id, rep.username);
    toast('Nudged ' + (firstName(rep.username) || rep.username), 'Bell + their chosen channel');
  } catch (e) { toast('Not sent', String(e && e.message || e)); return; }
  await updateBellBadge();
  return refreshShowTab(rep.show_id, 'reports');
}
async function repNagAllAct(showId) {
  try {
    var r = await api.nagTechReports(showId, null);
    toast('Nudged everyone still out', r.nagged + ' reminder' + (r.nagged === 1 ? '' : 's') + ' sent');
  } catch (e) { toast('Not sent', String(e && e.message || e)); return; }
  await updateBellBadge();
  return refreshShowTab(Number(showId), 'reports');
}
/* the My Tasks / bell deep link: open the show, land on Reports, open my editor */
async function openReportAct(showId) {
  var rep = reportFor(Number(showId), ME);
  REPORT_UI.editing = rep ? rep.id : null;
  await render('show', Number(showId));
  setFolderTab('reports');
  var ta = rep ? document.getElementById('repIn' + rep.id) : null;
  if (ta && ta.focus) ta.focus();
}

/* ============================================================================
   F6 · ARCHIVING — admin only, and reversible in one click
   ========================================================================== */
async function archiveShowAct(showId) {
  try {
    var r = await api.archiveShow(showId);
    toast(r.already ? 'Already archived' : 'Archived',
      'Out of the working set — nothing deleted, and the Archive view still opens it');
  } catch (e) { toast('Not archived', String(e && e.message || e)); return; }
  return render('show', Number(showId));
}
async function unarchiveShowAct(showId) {
  try {
    await api.unarchiveShow(showId);
    toast('Back in the working set', 'It appears in the normal lists again');
  } catch (e) { toast('Not restored', String(e && e.message || e)); return; }
  return render('show', Number(showId));
}
async function archiveProjectAct(projectId) {
  try {
    await api.archiveProject(projectId);
    toast('Folder archived', 'Every show inside it went with it');
  } catch (e) { toast('Not archived', String(e && e.message || e)); return; }
  return render('projects');
}
async function unarchiveProjectAct(projectId) {
  try {
    await api.unarchiveProject(projectId);
    toast('Folder restored', 'Back in the portfolio');
  } catch (e) { toast('Not restored', String(e && e.message || e)); return; }
  return render('archive');
}

/* ============================================================================
   F3 · NOTIFICATION PREFERENCES + the sweep
   ========================================================================== */
async function notifPrefAct(spec) {
  var parts = String(spec || '').split(':');
  if (parts.length !== 2) return;
  var patch = {};
  patch[parts[0]] = parts[1];
  try {
    await api.setNotificationPrefs(patch);
  } catch (e) { toast('Not saved', String(e && e.message || e)); return; }
  toast(NOTIFY_KIND_LABEL[parts[0]] || parts[0],
    parts[1] === 'off' ? 'Bell only — it still reaches you in the app'
      : parts[1] === 'immediate' ? 'You will hear about these right away'
      : 'Batched into your digest');
  return render('settings');
}
async function runSweepAct() {
  var r;
  try { r = await api.sweep(); }
  catch (e) { toast('Sweep refused', String(e && e.message || e)); return; }
  var bits = [];
  if (r.struck) bits.push(r.struck + ' struck');
  if (r.reports_created) bits.push(r.reports_created + ' reports created');
  if (r.nagged) bits.push(r.nagged + ' nagged');
  if (r.closeout_complete) bits.push(r.closeout_complete + ' closed out');
  if (r.archived) bits.push(r.archived + ' archived');
  if (r.notifications && r.notifications.sent) bits.push(r.notifications.sent + ' notifications sent');
  toast('Sweep done', bits.length ? bits.join(' · ') : 'nothing was due — it is idempotent, so that is the normal answer');
  await updateBellBadge();
  await updateMineCount();
  return render('settings');
}

/* ============================================================================
   PEOPLE ADMIN — add · edit · reset · deactivate/reactivate
   ----------------------------------------------------------------------------
   Every mutation goes through api.* (which is gated server-side, and simulates
   locally in demo mode) and re-renders Team from fresh data. The refusals are
   surfaced verbatim: when the server says "this is the only active admin", the
   toast says that, not "Something went wrong".
   ========================================================================== */
var PENDING_USER = null;      /* the id the open edit dialog belongs to */
var TEMP_REVEAL = null;       /* {username, password} — held only while shown */

function roleOptions(sel) {
  return ROLE_ORDER.map(function (r) {
    return '<option value="' + esc(r) + '"' + (r === sel ? ' selected' : '') + '>' +
      esc(roleName(r)) + '</option>';
  }).join('');
}
function personFields(u) {
  u = u || {};
  return '<div class="fin-inputs" style="grid-template-columns:1.4fr 1fr">' +
    finLabelWrap('Full name', '<input id="puName" class="cell-in" value="' + esc(u.name || '') + '" placeholder="Devin Vargas">') +
    finLabelWrap('Initials', '<input id="puInitials" class="cell-in" maxlength="4" value="' + esc(u.initials || '') + '" placeholder="auto">') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr 1fr">' +
    finLabelWrap('Role', '<select id="puRole" class="cell-in">' + roleOptions(u.role || 'viewer') + '</select>') +
    finLabelWrap('Discipline', '<select id="puDiscipline" class="cell-in">' +
      ['', 'led', 'print', 'both'].map(function (d) {
        return '<option value="' + esc(d) + '"' + (d === (u.discipline || '') ? ' selected' : '') + '>' +
          esc(d ? (typeDef(d) ? typeDef(d).label : d) : '—') + '</option>';
      }).join('') + '</select>') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1.4fr 1fr">' +
    finLabelWrap('Title', '<input id="puTitle" class="cell-in" value="' + esc(u.title || '') + '" placeholder="Gear / Prep Tech">') +
    finLabelWrap('Phone', '<input id="puPhone" class="cell-in" value="' + esc(u.phone || '') + '" placeholder="(414) 555-0100">') +
    '</div>' +
    /* Optional, and the helper text says WHY you want it anyway: with no
       address every notification this person is owed is marked "skipped — no
       email address on file" and only ever reaches the bell. */
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Email',
      '<input id="puEmail" class="cell-in" type="email" autocapitalize="off" spellcheck="false" ' +
        'value="' + esc(u.email || '') + '" placeholder="dvargas@e360sport.com">',
      'Optional — but needed for email notifications, and it is a second thing they can sign in with. ' +
      'Two active people cannot share one.') +
    '</div>' +
    /* The identity link to the staffing app. Its roster, its travel keys and
       its crew lists are all keyed on a DISPLAY NAME, so a person the two
       systems spell differently silently gets no packet on a push. */
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Name in staffing app',
      '<input id="puStaffingName" class="cell-in" value="' + esc(u.staffing_name || '') + '" ' +
        'placeholder="' + esc(u.name || 'same as their name above') + '">',
      'Only if it differs from their name here — used to match travel, hotels and crew on push.') +
    '</div>' +
    '<label class="pu-cap"><input type="checkbox" id="puFinance"' + (u.finance ? ' checked' : '') + '>' +
    '<span><b>Finance capability</b> — sees margin and approves purchase orders, without being an admin. ' +
    'This is how accounting gets accounting rights.</span></label>';
}
function personFromForm() {
  var v = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  var c = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };
  return { name: v('puName'), initials: v('puInitials'), role: v('puRole'),
           discipline: v('puDiscipline'), title: v('puTitle'), phone: v('puPhone'),
           email: v('puEmail'), staffing_name: v('puStaffingName'),
           finance: c('puFinance') };
}

/* ---- the one-time reveal ------------------------------------------------ */
/* The ONLY moment this password exists anywhere a human can read it. It is not
   in the roster record, not in the activity trail, not returned by any GET, and
   not recoverable — losing it costs one click on Reset, which is exactly the
   trade we want. Held in TEMP_REVEAL only so the Copy button has something to
   read, and dropped the moment the dialog closes. */
function revealTempPassword(title, username, temp, lead) {
  TEMP_REVEAL = { username: username, password: temp };
  openModal(title,
    '<p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.6">' + lead + '</p>' +
    '<div class="temp-pw"><div class="tp-k">' + esc(username) + '</div>' +
    '<div class="tp-v mono" id="tempPwVal">' + esc(temp) + '</div>' +
    '<button class="btn sm" ' + act('copyTempPw') + '>' + icon('doc') + 'Copy</button></div>' +
    '<div class="hint" style="margin-top:12px">' + inlineIcon('lock') + '<span><b>Shown once.</b> Nothing stores ' +
    'it and no screen will show it again — if it gets lost, reset the password and read out a new one. ' +
    'They will be asked to change it the first time they sign in.' +
    (api.isDemo() ? ' <b>Demo mode: this is a simulated password for a simulated person.</b>' : '') +
    '</span></div>' +
    '<div style="display:flex;justify-content:flex-end;margin-top:14px">' +
    '<button class="btn primary" ' + act('closeModal') + '>Done</button></div>');
}
async function copyTempPwAct() {
  if (!TEMP_REVEAL) return;
  var txt = TEMP_REVEAL.password;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(txt);
      toast('Copied', 'The temporary password is on your clipboard');
      return;
    }
  } catch (_) { /* fall through to the selection fallback */ }
  /* No clipboard API (an insecure origin, or an older browser): select the
     text so ctrl-C still works, and say so rather than claiming a copy. */
  try {
    var el = document.getElementById('tempPwVal');
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    toast('Selected — press Ctrl-C', 'This browser will not let a page write to the clipboard');
  } catch (_) {
    toast('Copy it by hand', 'This browser will not let a page write to the clipboard');
  }
}

/* ---- add ---------------------------------------------------------------- */
function openAddPerson() {
  if (CURRENT_USER.role !== 'admin') { toast('Admins add people', 'Ask Tom, Tony or Jim'); return; }
  PENDING_USER = null;
  openModal('Add a person',
    '<div class="hint" style="margin:0 0 12px">' + icon('users') + '<span>Creates the account and mints a ' +
    '<b>temporary password</b>, shown once on the next screen. Read it out; they are asked to replace it the ' +
    'first time they sign in.' + (api.isDemo() ? ' <b>Demo mode — nothing is created on a server.</b>' : '') +
    '</span></div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr"><label style="display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600">Username' +
    '<input id="puUsername" class="cell-in" autocapitalize="off" spellcheck="false" placeholder="dvargas">' +
    '<span style="text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;color:var(--muted)">' +
    'Their @mention handle, and one of the two things they can sign in with (the other is their email). ' +
    '2–32 characters: a letter, then letters, digits, _ . or - · it cannot be changed later, because every ' +
    'step, note and activity line points at it.' +
    '</span></label></div>' +
    personFields({ role: 'tech' }) +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:14px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('userAddCommit') + '>' + icon('plus') + 'Create account</button></div>');
}
async function commitAddPerson() {
  var uEl = document.getElementById('puUsername');
  var username = uEl ? String(uEl.value || '').toLowerCase().trim() : '';
  if (!username) { toast('A username is required', 'It is what they type to sign in'); return; }
  var body = personFromForm();
  body.username = username;
  var r;
  try { r = await api.createUser(body); }
  catch (e) { toast('Not created', String((e && e.message) || e)); return; }
  var who = (r.user && (r.user.name || r.user.username)) || username;
  revealTempPassword('Account created · ' + who, username, r.temp_password,
    '<b>' + esc(who) + '</b> can sign in now with this temporary password. It is the only time it is shown.');
  await hydrateSession();
  return render('team');
}

/* ---- edit --------------------------------------------------------------- */
function openEditPerson(userId) {
  var u = USERS_BY_ID[Number(userId)];
  if (!u) return;
  if (CURRENT_USER.role !== 'admin') { toast('Admins manage the roster', 'Ask Tom, Tony or Jim'); return; }
  PENDING_USER = u.id;
  openModal('Edit · ' + u.name,
    '<div class="hint" style="margin:0 0 12px">' + icon('users') + '<span>Signs in as <b>' + esc(u.username) +
    '</b> — a username never changes, because every step, note and activity line points at it.</span></div>' +
    personFields(u) +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:14px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('userEditCommit') + '>' + icon('check') + 'Save changes</button></div>');
}
async function commitEditPerson() {
  if (!PENDING_USER) return;
  var id = PENDING_USER;
  try { await api.updateUser(id, personFromForm()); }
  catch (e) { toast('Not saved', String((e && e.message) || e)); return; }
  closeM();
  PENDING_USER = null;
  toast('Saved', 'Their role and permissions take effect on their next request');
  /* their role may have changed — including possibly OUR own */
  await api.currentUser().catch(function () { return null; });
  await hydrateSession();
  return render('team');
}

/* ---- reset a password --------------------------------------------------- */
function openResetPassword(userId) {
  var u = USERS_BY_ID[Number(userId)];
  if (!u) return;
  openModal('Reset password · ' + u.name,
    '<p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.6">' +
    'This replaces <b>' + esc(u.name) + '</b>’s password with a new temporary one and shows it to you once. ' +
    'Every device they are currently signed in on is signed out, and any agent key they hold is revoked — ' +
    'a reset is also what you do when you think an account has been got at, and one that left the intruder ' +
    'signed in would be theatre.</p>' +
    '<div style="display:flex;justify-content:flex-end;gap:9px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('userResetCommit', u.id) + '>' + icon('lock') + 'Reset it</button></div>');
}
async function commitResetPassword(userId) {
  var u = USERS_BY_ID[Number(userId)];
  var r;
  try { r = await api.resetUserPassword(userId); }
  catch (e) { toast('Not reset', String((e && e.message) || e)); return; }
  revealTempPassword('Password reset · ' + ((u && u.name) || r.username), r.username, r.temp_password,
    'Read this to <b>' + esc((u && u.name) || r.username) + '</b>. Their old password no longer works and ' +
    'they have been signed out everywhere.');
  return render('team');
}

/* ---- deactivate / reactivate -------------------------------------------- */
function openDeactivate(userId) {
  var u = USERS_BY_ID[Number(userId)];
  if (!u) return;
  var isMe = u.username === CURRENT_USER.username;
  openModal('Deactivate · ' + u.name,
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px;line-height:1.6">' +
    '<b>' + esc(u.name) + '</b> will not be able to sign in, and disappears from owner pickers, crew lists ' +
    'and @mentions. Anyone signed in as them right now is signed out.</p>' +
    '<p style="margin:0 0 12px;color:var(--text-2);font-size:13px;line-height:1.6">' +
    '<b>Nothing is deleted.</b> Every step they own, note they wrote and report they filed keeps their name ' +
    'on it, and the activity trail is untouched. This is how somebody leaves — you can switch them back on ' +
    'any time and they pick up where they were.</p>' +
    (isMe ? '<div class="hint" style="margin:0 0 12px">' + icon('alert') + '<span>This is <b>your own account</b>. ' +
      'You will be signed out immediately and will need another admin to let you back in.</span></div>' : '') +
    '<div style="display:flex;justify-content:flex-end;gap:9px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Keep them active</button>' +
    '<button class="btn primary" ' + act('userDeactivateCommit', u.id) + '>' + icon('x') + 'Deactivate</button></div>');
}
async function commitSetActive(userId, on) {
  var u = USERS_BY_ID[Number(userId)];
  var isMe = !!(u && u.username === CURRENT_USER.username);
  try { await api.setUserActive(userId, on); }
  catch (e) { toast(on ? 'Not reactivated' : 'Not deactivated', String((e && e.message) || e)); return; }
  closeM();
  if (!on && isMe && !api.isDemo()) {
    /* We just switched off the account this window is holding. Say it plainly
       and go to the login screen rather than letting the next request 401 into
       a confusing "your session expired". */
    api.logout();
    toast('Your account is deactivated', 'Another admin has to switch it back on');
    openLogin('This account has been deactivated. Ask an admin to turn it back on.', null);
    return;
  }
  toast(on ? 'Back on the roster' : 'Deactivated',
    on ? ((u && u.name) || 'They') + ' can sign in again and appears in pickers'
       : ((u && u.name) || 'They') + ' can no longer sign in — nothing was deleted');
  await hydrateSession();
  return render('team');
}

/* ============================================================================
   PASSWORDS — the forced change, and the voluntary one
   ----------------------------------------------------------------------------
   `must_change` rides the login response and GET /api/auth/me. It gates
   nothing server-side (a session is a session) — it is the app insisting,
   before it renders anything, that nobody keeps living on a password an admin
   read off their screen. The overlay reuses the login screen's own chrome
   because it IS the same moment: you are not in yet.
   ========================================================================== */
var PWGATE = { open: false, busy: false };

function pwGateHTML(msg, forced) {
  return '<div class="login-card">' +
    '<div class="login-brand"><div class="logo">e</div>' +
      '<div><b>Showrunner</b><span>e360 Sport</span></div></div>' +
    '<h1>' + (forced ? 'Choose a password' : 'Change your password') + '</h1>' +
    '<p class="login-sub">' + (forced
      ? 'You are signed in on a temporary password. Pick one only you know before you go any further.'
      : 'Changing it signs you out on every other device. This one stays signed in.') + '</p>' +
    '<form id="pwForm" autocomplete="on">' +
      '<label class="login-f"><span>' + (forced ? 'Temporary password' : 'Current password') + '</span>' +
        '<input id="pwCur" type="password" autocomplete="current-password" required></label>' +
      '<label class="login-f"><span>New password</span>' +
        '<input id="pwNew" type="password" autocomplete="new-password" minlength="8" required></label>' +
      '<label class="login-f"><span>New password again</span>' +
        '<input id="pwNew2" type="password" autocomplete="new-password" minlength="8" required></label>' +
      '<div class="login-err" id="pwErr"' + (msg ? '' : ' style="display:none"') + '>' + esc(msg || '') + '</div>' +
      '<button class="btn primary login-go" id="pwGo" type="submit">' + icon('check') + '<span>Set my password</span></button>' +
    '</form>' +
    '<div class="login-foot">' + inlineIcon('lock') +
      'At least 8 characters. It is hashed with bcrypt — nobody, including an admin, can read it back.</div>' +
  '</div>';
}
function openPwGate(msg) {
  if (PWGATE.open) return;
  PWGATE.open = true;
  closeM(); closeBellPanel(); closeNotifyPop(); closeRosterPicker();
  var el = document.getElementById('pwScreen');
  if (!el) {
    el = document.createElement('div');
    el.className = 'login-screen'; el.id = 'pwScreen';
    document.body.appendChild(el);
  }
  el.innerHTML = pwGateHTML(msg, true);
  el.style.display = '';
  var form = document.getElementById('pwForm');
  if (form) form.onsubmit = function (e) { e.preventDefault(); return submitPwGate(); };
  var c = document.getElementById('pwCur');
  if (c && c.focus) { try { c.focus(); } catch (_) {} }
}
function closePwGate() {
  PWGATE.open = false;
  var el = document.getElementById('pwScreen');
  if (el) el.style.display = 'none';
}
async function submitPwGate() {
  if (PWGATE.busy) return;
  var v = function (id) { var el = document.getElementById(id); return el ? String(el.value || '') : ''; };
  var errEl = document.getElementById('pwErr');
  var go = document.getElementById('pwGo');
  function showErr(m) { if (errEl) { errEl.textContent = m; errEl.style.display = ''; } }
  var cur = v('pwCur'), a = v('pwNew'), b = v('pwNew2');
  if (a !== b) { showErr('The two new passwords do not match.'); return; }
  PWGATE.busy = true;
  if (go) { go.classList.add('busy'); go.disabled = true; }
  try {
    await api.changeMyPassword(cur, a);
    closePwGate();
    toast('Password set', 'You are signed out on every other device');
    await hydrateSession();
    await render('projects');
  } catch (e) {
    showErr(String((e && e.message) || e));
  } finally {
    PWGATE.busy = false;
    if (go) { go.classList.remove('busy'); go.disabled = false; }
  }
}

/* The voluntary one, from Settings → Your session. Same fields, in a modal,
   because here you are already inside the app. */
function openChangePassword() {
  if (api.isDemo()) {
    toast('Demo data — no account to change', 'This window is running the modeled dataset; there is no password behind it');
    return;
  }
  openModal('Change your password',
    '<p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.6">' +
    'Your current password proves it is you sitting here. Changing it signs you out on every <b>other</b> ' +
    'device; this one stays signed in.</p>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr">' +
    finLabelWrap('Current password', '<input id="cpCur" class="cell-in" type="password" autocomplete="current-password">') +
    '</div>' +
    '<div class="fin-inputs" style="grid-template-columns:1fr 1fr">' +
    finLabelWrap('New password', '<input id="cpNew" class="cell-in" type="password" autocomplete="new-password">') +
    finLabelWrap('New password again', '<input id="cpNew2" class="cell-in" type="password" autocomplete="new-password">') +
    '</div>' +
    '<div class="hint" style="margin-top:10px">' + inlineIcon('lock') + '<span>At least 8 characters, and different ' +
    'from the current one. Stored as a bcrypt hash — nobody can read it back, which is also why an admin resetting ' +
    'it mints a new one rather than telling you the old one.</span></div>' +
    '<div style="display:flex;justify-content:flex-end;gap:9px;margin-top:14px">' +
    '<button class="btn ghost" ' + act('closeModal') + '>Cancel</button>' +
    '<button class="btn primary" ' + act('changePwCommit') + '>' + icon('check') + 'Change password</button></div>');
}
async function commitChangePassword() {
  var v = function (id) { var el = document.getElementById(id); return el ? String(el.value || '') : ''; };
  if (v('cpNew') !== v('cpNew2')) { toast('They do not match', 'Type the new password the same way twice'); return; }
  try { await api.changeMyPassword(v('cpCur'), v('cpNew')); }
  catch (e) { toast('Not changed', String((e && e.message) || e)); return; }
  closeM();
  toast('Password changed', 'You are signed out on every other device');
  return render('settings');
}

/* ============================================================================
   ONE DELEGATED LISTENER — every data-act in the app lands here
   ========================================================================== */
var ACTIONS = {
  goProjects:    function () { return render('projects'); },
  goFiles:       function () { return render('files'); },
  goFinance:     function () { return render('finance'); },
  goPurchasing:  function () { return render('purchasing'); },
  openJob:       function (t, id) { return render('job', id); },
  openPO:        function (t, id) { return render('po', id); },
  poAdvance:     function (t, id) { return poAdvance(id); },
  poApprove:     function (t, id) { return poApprove(id); },
  poAttachInvoice: function (t, id) { return poAttachInvoice(id); },
  poAttachQuote: function (t, id) { return poAttachQuote(id); },
  openNewPO:     function () { return openNewPO(); },
  commitNewPO:   function () { return commitNewPO(); },
  openAddPOLine: function (t, id) { return openAddPOLine(id); },
  commitAddPOLine: function () { return commitAddPOLine(); },
  openShowFin:   function (t, id) { return openShowFin(id); },
  confirmDoc:    function (t, id) { return confirmDocAct(id); },
  rejectDoc:     function (t, id) { return rejectDocAct(id); },
  excAttach:     function (t, id, k) { return excAttach(id, k); },
  openJobNumber: function (t, id) { return openJobNumber(id); },
  commitJobNumber: function () { return commitJobNumber(); },
  addFinDoc:     function (t, id) { return openAddFinDoc(id); },
  commitFinDoc:  function (t, id) { return commitFinDoc(id); },
  openAddExpense: function (t, id) { return openAddExpense(id); },
  commitAddExpense: function () { return commitAddExpense(); },
  viewAs:        function (t, id) { return viewAs(id); },
  logout:        function () { return logoutAct(); },
  netRetry:      function () { return netRetry(); },
  openFolder:    function (t, id) { return openFolder(id); },
  openShow:      function (t, id) { return openShow(id); },
  openViewer:    function (t, id) { return openViewer(id); },
  vSet:          function (t, id) { return vSet(id); },
  vGo:           function (t, id) { return vGo(id); },
  printFile:     function () { return printFile(); },
  toggleStep:    function (t, id) { return toggleStep(id); },
  openRoster:    function (t, id) { openRosterPicker(t, id); },
  assignStep:    function (t, id, k) { return assignStepTo(id, k); },
  attachStep:    function (t, id) { return attachToStep(id); },
  attachBooking: function (t, id) { return attachToBooking(id); },
  addFile:       function (t, id) { return openAddFile(id); },
  commitAddFile: function (t, id) { return commitAddFile(id); },
  commitUpload:  function () { return commitUpload(); },
  downloadFile:  function (t, id) { return downloadFile(id); },
  specGen:       function (t, id, k) { return specGen(id, k); },
  openChainFile: function (t, id, k) { return openChainFile(id, k); },
  printChainFile: function (t, id, k) { return printChainFile(id, k); },
  flexCreate:    function (t, id) { return flexCreate(id); },
  flexLink:      function (t, id) { return flexLink(id); },
  flexLinkSave:  function () { return flexLinkSave(); },
  flexToggleContacts: function (t, id) { return flexToggleContacts(id); },
  flexPull:      function (t, id) { return flexPull(id); },
  flexPickSheet: function (t, id, k) { return flexPickSheet(id, k); },
  flexReload:    function (t, id, k) { return flexLoadSheet(id, k || null, { lists: (FLEX_SHEETS[id] || {}).lists || [] }); },
  flexPrintSheet: function (t, id) { return flexPrintSheet(id); },
  gearView:      function (t, id, k) { return gearView(id, k); },
  gotoTab:       function (t, id, k) { setFolderTab(k); },
  /* schedule (call-sheet pass) */
  schedDay:        function (t, id, k) { return schedSetDay(id, k); },
  schedMyDay:      function (t, id) { return schedToggleMy(id); },
  schedPrint:      function (t, id) { return schedPrintAct(id); },
  schedPreview:    function (t, id) { return schedPreviewAct(id); },
  schedAdd:        function (t, id) { return openSchedItem(id, null); },
  schedEdit:       function (t, id) { var st = SCHEDULE_BY_ID[Number(id)]; return st ? openSchedItem(st.show_id, id) : null; },
  schedSave:       function () { return schedSaveAct(); },
  schedDelete:     function (t, id) { return schedDeleteAct(id); },
  /* event photos (photo pass) */
  photoPick:     function (t, id) { return photoPickAct(id); },
  photoConfirm:  function (t, id) { return photoConfirmAct(id); },
  photoReject:   function (t, id) { return photoRejectAct(id); },
  phTag:         function (t, id, k) { return phTagAct(id, k); },
  phCapEdit:     function (t, id) { return phCapEditAct(id); },
  phCapSave:     function (t, id) { return phCapSaveAct(id); },
  phCapCancel:   function () { return phCapCancelAct(); },
  filesMode:     function (t, id, k) { return filesModeAct(k); },
  /* client recap (recap pass) */
  rcGenerate:    function (t, id) { return rcGenerateAct(id); },
  rcEdit:        function (t, id, k) { return rcEditAct(id, k); },
  rcSave:        function (t, id, k) { return rcSaveAct(id, k); },
  rcCancel:      function () { return rcCancelAct(); },
  rcAdd:         function (t, id, k) { return rcAddAct(id, k); },
  rcDel:         function (t, id, k) { return rcDelAct(id, k); },
  rcPhotoMove:   function (t, id, k) { return rcPhotoAct(id, k); },
  rcPhotoRemove: function (t, id) { return rcPhotoAct(id, 'remove'); },
  rcPhotoAdd:    function (t, id) { return rcPhotoAct(id, 'add'); },
  rcApprove:     function (t, id) { return rcApproveAct(id); },
  rcReopen:      function (t, id) { return rcReopenAct(id); },
  rcMarkSent:    function (t, id) { return rcMarkSentAct(id); },
  rcCommitSent:  function (t, id) { return rcCommitSentAct(id); },
  rcPreview:     function (t, id) { return rcPreviewAct(id); },
  rcPrint:       function (t, id) { return rcPrintAct(id); },
  rcReview:      function (t, id) { return rcReviewAct(id); },
  /* mobile nav drawer (call-sheet pass) */
  toggleNav:     function () { toggleNavDrawer(); },
  closeNav:      function () { setNavOpen(false); },
  pushSched:     function (t, id) { return pushSched(id); },
  proofApprove:  function (t, id) { return proofAction(id, true); },
  proofRevise:   function (t, id) { return proofAction(id, false); },
  setDiv:        async function (t, id, k) { DIV_FILTER = (DIV_FILTER === k && k !== 'all') ? 'all' : k; await render('projects'); },
  selectTpl:     async function (t, id, k) { selectTpl(k, await api.listProjects()); },
  addEventType:  function () { addEventType(); },
  openNew:       function () { openNew(); },
  /* F1 — the last mock button in the app is real: picking a type now opens the
     form that creates the folder, the show and the job. */
  newEventType:  function (t, id, k) { newEventForm(EVENT_TYPES[k] ? k : 'led'); },
  commitNewEvent: function () { return commitNewEvent(); },
  /* the notify-picker's "everyone" shortcut — Tom's one-click on the event
     flow. Never the default; always one deliberate click. */
  notifyAll:     function () {
    NOTIFY_SEL = activeUsers().filter(function (u) { return u.username !== ME; })
      .map(function (u) { return u.username; });
    repaintNotifyRow();
    var p = document.getElementById('notifyPop');
    if (p) p.innerHTML = notifyPopInner();
  },
  /* F5 */
  confirmShow:   function (t, id) { return confirmShowAct(id); },
  /* F4 */
  editScope:     function (t, id) { return openScopeEditor(id); },
  commitScope:   function () { return commitScope(); },
  scopeFromSpec: function (t, id) { return scopeFromSpecAct(id); },
  /* F2 */
  markStruck:    function (t, id) { return markStruckAct(id); },
  repEdit:       function (t, id) { return repEditAct(id); },
  repCancel:     function () { return repCancelAct(); },
  repSave:       function (t, id) { return repSaveAct(id); },
  repReview:     function (t, id) { return repReviewAct(id); },
  repReopen:     function (t, id) { return repReopenAct(id); },
  repNag:        function (t, id) { return repNagAct(id); },
  repNagAll:     function (t, id) { return repNagAllAct(id); },
  openReport:    function (t, id) { return openReportAct(id); },
  /* F6 */
  goArchive:     function () { return render('archive'); },
  archiveShow:   function (t, id) { return archiveShowAct(id); },
  unarchiveShow: function (t, id) { return unarchiveShowAct(id); },
  archiveProject: function (t, id) { return archiveProjectAct(id); },
  unarchiveProject: function (t, id) { return unarchiveProjectAct(id); },
  /* F3 */
  notifPref:     function (t, id, k) { return notifPrefAct(k); },
  openOutbox:    function () { return render('outbox'); },
  runSweep:      function () { return runSweepAct(); },
  /* people admin — the Team view's controls (admin-only, server-enforced) */
  userAdd:              function () { return openAddPerson(); },
  userAddCommit:        function () { return commitAddPerson(); },
  userEdit:             function (t, id) { return openEditPerson(id); },
  userEditCommit:       function () { return commitEditPerson(); },
  userReset:            function (t, id) { return openResetPassword(id); },
  userResetCommit:      function (t, id) { return commitResetPassword(id); },
  userDeactivate:       function (t, id) { return openDeactivate(id); },
  userDeactivateCommit: function (t, id) { return commitSetActive(id, false); },
  userActivate:         function (t, id) { return commitSetActive(id, true); },
  copyTempPw:           function () { return copyTempPwAct(); },
  /* passwords */
  changePw:       function () { return openChangePassword(); },
  changePwCommit: function () { return commitChangePassword(); },
  closeModal:    function () { closeM(); closeNotifyPop(); },
  toggleTheme:   function () { toggleTheme(); },
  /* notes + mentions (notes pass) */
  toggleBell:    function (t) { toggleBellPanel(t); },
  bellMarkAll:   function () { return bellMarkAllAct(); },
  openNote:      function (t, id) { return openNoteAct(id); },
  notePost:      function (t) { return postNoteFrom(t); },
  noteReply:     function (t, id) { return noteReplyAct(id); },
  noteEdit:      function (t, id) { return noteEditAct(id); },
  noteEditSave:  function (t, id) { return noteEditSaveAct(id); },
  noteEditCancel: function () { return noteEditCancelAct(); },
  noteToggleStep: function (t, id) { return noteToggleStepAct(id); },
  noteExpand:    function (t, id, k) { return noteExpandAct(k); },
  /* notify-picker (Tony's notification rule) */
  notifyPick:    function (t) { openNotifyPop(t); },
  notifyToggle:  function (t, id) { notifyToggleAct(id); },
  rosterNotify:  function (t) { toggleRosterNotify(t); },
  toast:         function (t) { toast(t.getAttribute('data-toast') || '', t.getAttribute('data-toast-sub') || ''); }
};

/* HARDENING 12. THE BOOT GATE.
   SR.probe() decides which world we are in — demo fixture or live API — and it
   is allowed up to 2.5s to do it. The shell is in index.html at parse time, so
   for that whole window the rail, the New button and every data-act in the
   static chrome were clickable, and a click landed in render()/openNew() before
   api.mode() had an answer. In API mode that meant a view rendered against the
   demo fixture and then had real rows merged into it by id — the exact
   fictional/real fusion resetStore() exists further down in boot() to prevent.
   It is a narrow window but it is the FIRST 2.5 seconds, which is precisely
   when an impatient person clicks.

   One flag, consulted by the one delegated listener and by the three direct
   handlers boot() wires. `.is-booting` on <html> does the visual half (app.css)
   — but the flag, not the CSS, is the gate: pointer-events cannot stop a
   keyboard activation. */
var BOOTING = true;
function bootGate() { return BOOTING; }
function endBootGate() {
  BOOTING = false;
  try { document.documentElement.classList.remove('is-booting'); } catch (_) {}
}

document.addEventListener('click', function (ev) {
  var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
  if (!t) return;
  if (bootGate()) { ev.preventDefault(); return; }
  var fn = ACTIONS[t.getAttribute('data-act')];
  if (!fn) return;
  ev.stopPropagation();
  var idAttr = t.getAttribute('data-id');
  var id = idAttr === null || idAttr === '' ? null : Number(idAttr);
  var r = fn(t, id, t.getAttribute('data-k'));
  if (r && r.catch) r.catch(function (e) { console.error(e); toast('Something went wrong', String(e && e.message || e)); });
});

/* ---- dropzone (modeled) ---- */
document.addEventListener('dragover', function (ev) {
  var dz = ev.target && ev.target.closest ? ev.target.closest('[data-drop]') : null;
  if (!dz) return;
  ev.preventDefault(); dz.classList.add('drag');
});
document.addEventListener('dragleave', function (ev) {
  var dz = ev.target && ev.target.closest ? ev.target.closest('[data-drop]') : null;
  if (dz) dz.classList.remove('drag');
});
document.addEventListener('drop', function (ev) {
  var dz = ev.target && ev.target.closest ? ev.target.closest('[data-drop]') : null;
  if (!dz) return;
  ev.preventDefault(); ev.stopPropagation();
  dz.classList.remove('drag');
  /* Hand dropFile() the FILE, not its name. In API mode that is the whole
     difference between a real upload and a modeled row. */
  var dropped = null;
  try { if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) dropped = ev.dataTransfer.files[0]; } catch (_) {}
  dropFile(Number(dz.getAttribute('data-drop')), dropped);
});

/* ============================================================================
   SESSION — the login screen, the offline banner, the demo badge
   ----------------------------------------------------------------------------
   API mode only. The screen is the same control room as the app: the same
   tokens, the same surfaces, both themes, and no second design language. It
   is a full-bleed overlay rather than a route, so it can also come back
   mid-session when a 401 lands — the view underneath survives and re-renders
   the moment the new session is in hand.
   ========================================================================== */
var LOGIN = { open: false, resume: null, busy: false };

function loginHTML(msg) {
  return '<div class="login-card">' +
    '<div class="login-brand"><div class="logo">e</div>' +
      '<div><b>Showrunner</b><span>e360 Sport</span></div></div>' +
    '<h1>Sign in</h1>' +
    '<p class="login-sub">Your Showrunner account. Sessions last 12 hours and survive a redeploy.</p>' +
    '<form id="loginForm" autocomplete="on">' +
      /* Either one. The server decides which lookup to run on the '@' — a
         username can never contain one — so the person signing in does not
         have to remember which of the two we decided to call their identity. */
      '<label class="login-f"><span>Username or email</span>' +
        '<input id="loginUser" name="username" autocomplete="username" autocapitalize="off" ' +
          'spellcheck="false" placeholder="username or email" required></label>' +
      '<label class="login-f"><span>Password</span>' +
        '<input id="loginPass" name="password" type="password" autocomplete="current-password" required></label>' +
      '<div class="login-err" id="loginErr"' + (msg ? '' : ' style="display:none"') + '>' + esc(msg || '') + '</div>' +
      '<button class="btn primary login-go" id="loginGo" type="submit">' + icon('check') + '<span>Sign in</span></button>' +
    '</form>' +
    '<div class="login-foot">' + inlineIcon('lock') + 'Role and finance capability are read live from the server on every request.</div>' +
  '</div>';
}

function openLogin(msg, resume) {
  if (LOGIN.open) return;
  LOGIN.open = true;
  if (resume) LOGIN.resume = resume;
  closeM(); closeBellPanel(); closeNotifyPop(); closeRosterPicker();
  var el = document.getElementById('loginScreen');
  if (!el) {
    el = document.createElement('div');
    el.className = 'login-screen'; el.id = 'loginScreen';
    document.body.appendChild(el);
  }
  el.innerHTML = loginHTML(msg);
  el.style.display = '';
  var form = document.getElementById('loginForm');
  if (form) form.onsubmit = function (e) { e.preventDefault(); return submitLogin(); };
  var u = document.getElementById('loginUser');
  if (u && u.focus) { try { u.focus(); } catch (_) {} }
}
function closeLogin() {
  LOGIN.open = false;
  var el = document.getElementById('loginScreen');
  if (el) el.style.display = 'none';
}
async function submitLogin() {
  if (LOGIN.busy) return;
  var u = (document.getElementById('loginUser') || {}).value || '';
  var p = (document.getElementById('loginPass') || {}).value || '';
  var errEl = document.getElementById('loginErr');
  var go = document.getElementById('loginGo');
  function showErr(m) {
    if (!errEl) return;
    errEl.textContent = m; errEl.style.display = '';
  }
  if (!String(u).trim() || !p) { showErr('A username or email, and a password, are both required.'); return; }
  LOGIN.busy = true;
  if (go) { go.classList.add('busy'); go.disabled = true; }
  try {
    var me = await api.login(String(u).trim(), p);
    closeLogin();
    /* A temp password gets you a session and no further. The overlay goes up
       BEFORE anything is hydrated or rendered, so nobody works a whole day on
       a password an admin read off their screen. */
    if (me && me.must_change) { openPwGate(null); return; }
    await hydrateSession();
    var r = LOGIN.resume; LOGIN.resume = null;
    if (r) await r(); else await render('projects');
  } catch (e) {
    showErr(String((e && e.message) || e));
  } finally {
    LOGIN.busy = false;
    if (go) { go.classList.remove('busy'); go.disabled = false; }
  }
}
async function logoutAct() {
  await api.logout();
  toast('Signed out', 'Your session on this device is closed');
  openLogin(null, null);
}

/* everything that depends on WHO is signed in — run after login and on boot */
async function hydrateSession() {
  await api.listUsers();          /* the roster drives pickers + @mentions */
  paintMe();
  var projects = await api.listProjects();
  var c = $('#c-proj'); if (c) c.textContent = projects.length;
  await updateMineCount();
  await updateFinCount();
  await updatePoCount();
  await updateBellBadge();
}

/* a non-blocking banner, not a dialog — a dropped request must never eat the
   screen the operator is reading */
function netBanner(online, e) {
  var el = document.getElementById('netBanner');
  if (online) { if (el) el.remove(); return; }
  if (el) return;
  el = document.createElement('div');
  el.className = 'net-banner'; el.id = 'netBanner';
  el.innerHTML = inlineIcon('bolt') +
    '<span>Can’t reach the Showrunner server — showing the last data loaded.</span>' +
    '<button class="btn sm ghost" data-act="netRetry">Retry</button>';
  document.body.appendChild(el);
}
async function netRetry() {
  var el = document.getElementById('netBanner');
  if (el) el.remove();
  var arg = CUR.view === 'show' ? CUR.showId : CUR.view === 'job' ? CUR.jobId
    : CUR.view === 'folder' ? CUR.projectId : CUR.view === 'po' ? CUR.poId : undefined;
  return render(CUR.view, arg);
}

/* the demo badge — small, in the topbar, never in the way, and only when the
   data really is fictional */
function paintModeBadge() {
  if (api.mode() !== 'demo') return;
  var bar = document.querySelector('.topbar');
  if (!bar || document.getElementById('demoBadge')) return;
  var b = document.createElement('span');
  b.className = 'demo-badge'; b.id = 'demoBadge';
  b.title = 'No Showrunner server answered — this is the modeled demo dataset. Nothing here is real.';
  b.innerHTML = inlineIcon('layers') + 'Demo data';
  /* sits just left of the theme toggle, after the flexible spacer */
  var anchor = document.getElementById('themeBtn');
  if (anchor && anchor.parentNode === bar) bar.insertBefore(b, anchor);
  else bar.appendChild(b);
}

/* ================================================================== BOOT === */
async function boot() {
  applyTheme(loadTheme());
  /* the shell is interactive from parse time; hold it until probe() answers */
  try { document.documentElement.classList.add('is-booting'); } catch (_) {}

  /* icons in the static shell */
  document.querySelectorAll('[data-ic]').forEach(function (el) { el.innerHTML = icon(el.dataset.ic); });

  /* nav */
  document.querySelectorAll('#nav a').forEach(function (a) {
    a.onclick = function (e) { e.preventDefault(); if (bootGate()) return; render(a.dataset.view); };
  });
  $('#newBtn').onclick = function () { if (bootGate()) return; openNew(); };
  /* the theme toggle reads and writes nothing but localStorage, so it stays
     live through the probe — there is no world it could get wrong. */
  $('#themeBtn').onclick = toggleTheme;
  $('#overlay').onclick = function (e) { if (e.target === $('#overlay')) { closeM(); closeNotifyPop(); } };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeM(); closeRosterPicker(); closeNotifyPop(); }
    if (window.__view === 'viewer') { if (e.key === 'ArrowLeft') vGo(-1); if (e.key === 'ArrowRight') vGo(1); }
  });

  /* WHICH WORLD ARE WE IN? One probe, once, before any data is asked for. */
  /* try/finally, not a bare await: probe() resolves on both branches today, but
     a gate that only opens on the happy path is one refactor away from a shell
     that is permanently dead. Releasing it is unconditional (hardening 12). */
  try {
    await SR.probe();
  } finally {
    endBootGate();
  }
  SR.on('unauthorized', function () {
    var arg = CUR.view === 'show' ? CUR.showId : CUR.view === 'job' ? CUR.jobId
      : CUR.view === 'folder' ? CUR.projectId : CUR.view === 'po' ? CUR.poId : undefined;
    var view = CUR.view;
    openLogin('Your session expired. Sign in to pick up where you left off.',
              function () { return render(view, arg); });
  });
  SR.on('network', netBanner);
  SR.on('busy', function (n) {
    var s = $('#scroll');
    if (s && s.classList) s.classList.toggle('is-busy', n > 0);
  });

  /* data.js builds its full demo fixture at PARSE time, in both modes — that is
     what lets file:// work. In API mode those rows are not a starting point to
     merge into, they are a different world: demo ids 1–11 collide with real
     ones, and the store's keep() merges by id and never deletes, so a server
     project would fuse with a fictional one and inherit whatever the server
     row omits. resetStore() was only ever reached through login(), so the
     returning-user boot (valid token, no login screen) skipped it entirely.
     Clear once, here, before any real row can land — and before the bind popup
     branches off, so its show picker never lists a fictional show either. */
  if (api.mode() === 'api') SR.resetStore();

  /* the ?bind-spec=1 popup is its own shell — no rail, no router
     (INTEGRATIONS_SPEC §9.3.3 / D5) */
  if (typeof bindSpecRequested === 'function' && bindSpecRequested()) return bindSpecBoot();

  paintModeBadge();

  if (api.mode() === 'api') {
    var me = null;
    try { me = await api.currentUser(); } catch (_) { me = null; }
    if (!me) { openLogin(null, null); return; }
    /* A returning visit never passes through the login form, so the forced
       change has to be re-asserted here or reloading the page skips it. */
    if (me.must_change) { openPwGate(null); return; }
    await hydrateSession();
    return render('projects');
  }

  /* ---- demo mode: the mock store IS the world ---- */
  paintMe();
  /* any show seeded as already pulled from Flex gets its cached gear-list
     artifacts bound up front (the original did this lazily in ensureGear).
     This is a MOCK artifact-binding step: live, the server owns those rows. */
  var shows = await api.listShows();
  for (var i = 0; i < shows.length; i++) {
    if (shows[i].gear && shows[i].gear.pulled) await bindGearFiles(shows[i]);
  }
  await hydrateSession();
  await render('projects');
}
boot();
