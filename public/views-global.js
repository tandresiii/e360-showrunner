/* ============================================================================
   e360 SHOWRUNNER — GLOBAL VIEWS
   My Tasks · Calendar · Team & Roles · Files library · Templates · Settings ·
   Multimedia Viewer.
   ========================================================================== */

/* ============================================================================
   MY TASKS — everything assigned to CURRENT_USER, across every show
   ========================================================================== */
function viewMyTasks(mine) {
  var dueSoon = mine.filter(function (m) { var d = daysUntil(m.step.due_date); return d != null && d <= 10; }).length;
  var over = mine.filter(function (m) { return isOverdue(m.step); }).length;
  var laneOf = function (m) { return LANES[m.step.lane] || { label: m.step.lane }; };

  var list = mine.slice().sort(function (a, b) {
    return (a.step.due_date || '9999').localeCompare(b.step.due_date || '9999');
  }).map(function (m) {
    var where = m.show.project.single ? m.show.project.name : m.show.name;
    return '<tr class="rowlink" ' + act('openShow', m.show.id) + '><td><b style="font-weight:600">' + esc(m.step.title) + '</b></td>' +
      '<td style="color:var(--muted)">' + esc(where) + '</td><td><span class="tag">' + esc(laneOf(m).label) + '</span></td>' +
      '<td>' + (m.step.risk ? '<span class="pill warn"><span class="dot"></span>At risk</span>' : statusPill(m.step.status)) + '</td>' +
      '<td class="mono" style="color:' + (isOverdue(m.step) ? 'var(--crit)' : 'var(--text-2)') + '">' + esc(fmtDate(m.step.due_date)) + '</td></tr>';
  }).join('') || '<tr><td colspan="5"><div class="empty">Nothing open assigned to you.</div></td></tr>';

  return '<div class="page-h"><div><h1>My Tasks</h1><div class="sub">Everything assigned to you, across every show and every lane set.</div></div></div>' +
    '<div class="stats" style="grid-template-columns:repeat(4,1fr)">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Assigned to me</div><div class="v">' + mine.length + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Due within 10d</div><div class="v" style="color:var(--warn)">' + dueSoon + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Overdue</div><div class="v" style="color:var(--crit)">' + over + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">Discipline</div><div class="v" style="font-size:20px;padding-top:6px">' + typeTag(CURRENT_USER.discipline) + '</div></div></div>' +
    '<div class="card"><div class="card-h"><h3>Open tasks — ' + esc(CURRENT_USER.name) + '</h3></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Task</th><th>Show</th><th>Lane</th><th>Status</th><th>Due</th></tr></thead><tbody>' + list + '</tbody></table></div></div>';
}

/* ============================================================================
   CALENDAR — milestones across every show; lane-agnostic
   ========================================================================== */
function viewCalendar(shows) {
  var items = [];
  shows.forEach(function (s) {
    (s.milestones || []).forEach(function (m) { items.push({ show: s, label: m.label, date: m.date }); });
  });
  items.sort(function (a, b) { return (a.date || '9999').localeCompare(b.date || '9999'); });

  var groups = {}, order = [];
  items.forEach(function (it) {
    var key = fmtMonthYear(it.date);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(it);
  });

  var html = order.map(function (key) {
    var rows = groups[key].map(function (it) {
      var d = parseISO(it.date);
      var mm = d ? MONTH_SHORT[d.getMonth()] : '', dd = d ? d.getDate() : '—';
      var where = it.show.project.single ? it.show.project.name : it.show.name;
      return '<div class="cal-item" ' + act('openShow', it.show.id) + '><div class="cal-date">' + esc(mm) + '<b>' + esc(dd) + '</b></div>' +
        '<div class="ci-b"><b>' + esc(it.label + ' · ' + where) + '</b><span>' + esc(it.show.project.client + ' · ' + it.show.venue) + '</span></div>' +
        typeTag(it.show.type) + '</div>';
    }).join('');
    return '<div class="cal-group"><h4>' + esc(key) + '</h4>' + rows + '</div>';
  }).join('');

  return '<div class="page-h"><div><h1>Calendar</h1><div class="sub">Load-ins, shows, installs and strikes across every show. Pushes to the e360 scheduler on promote.</div></div></div>' + html;
}

/* ============================================================================
   FILES — global multimedia library across every folder
   Photos integrate behind a mode toggle (photo pass): they outnumber the
   documents 2:1, so Documents stays the default and Photos is opt-in.
   ========================================================================== */
var FILES_UI = { mode: 'docs' };            /* docs | photos | all */
function filePhotoCard(f, where) {
  return '<button class="file ph" ' + act('openViewer', f.id) + '>' +
    '<div class="thumb ph"><img src="' + esc(f.thumb) + '" alt="' + esc(f.caption || f.name) + '" loading="lazy">' +
    (f.status === 'proposed' ? '<span class="ext" style="right:auto;left:8px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)">proposed</span>' : '') +
    (f.recap_pick ? '<span class="fp-star" title="Recap pick">' + icon('star') + '</span>' : '') +
    '</div>' +
    '<div class="fb"><b>' + esc(f.caption || f.name) + '</b><span>' + esc(where) + '</span></div></button>';
}
function viewFiles(shows) {
  var all = [];
  shows.forEach(function (s) { s.files.forEach(function (f) { all.push({ show: s, f: f }); }); });
  var docs = all.filter(function (x) { return x.f.kind !== 'photo'; });
  var photos = all.filter(function (x) { return x.f.kind === 'photo'; });
  var specs = docs.filter(function (x) { return x.f.kind === 'spec'; }).length;
  var proofs = docs.filter(function (x) { return x.f.kind === 'proof'; }).length;
  var mode = FILES_UI.mode === 'photos' || FILES_UI.mode === 'all' ? FILES_UI.mode : 'docs';
  var shown = mode === 'docs' ? docs : mode === 'photos' ? photos : docs.concat(photos);
  var cards = shown.map(function (x) {
    var where = x.show.project.single ? x.show.project.name : x.show.name;
    if (x.f.kind === 'photo') return filePhotoCard(x.f, where);
    return '<button class="file" ' + act('openViewer', x.f.id) + '>' +
      '<div class="thumb">' + icon(fileIcon(x.f)) + '<span class="ext">' + esc(x.f.ext) + '</span></div>' +
      '<div class="fb"><b>' + esc(x.f.name) + '</b><span>' + esc(where) + '</span></div></button>';
  }).join('');
  var seg = '<div class="seg">' +
    [['docs', 'Documents', docs.length], ['photos', 'Photos', photos.length], ['all', 'All', all.length]].map(function (m) {
      return '<button class="' + (mode === m[0] ? 'on' : '') + '" ' + act('filesMode', null, m[0]) + '>' +
        esc(m[1]) + ' <span class="sc">' + m[2] + '</span></button>';
    }).join('') + '</div>';
  return '<div class="page-h"><div><h1>Files</h1><div class="sub">Every spec, proof, contract, confirmation — and the event photo galleries — metadata here, bytes on the e360 NAS. Byte-serving from the NAS is a deferred infra dependency; the viewer renders the cached document or thumbnail.</div></div>' + seg + '</div>' +
    '<div class="stats" style="grid-template-columns:repeat(4,1fr)">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Documents</div><div class="v">' + docs.length + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Bound specs</div><div class="v">' + specs + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Proofs</div><div class="v" style="color:var(--info)">' + proofs + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">Photos</div><div class="v" style="color:var(--go)">' + photos.length + '</div></div></div>' +
    '<div class="file-grid">' + cards + '</div>' +
    (mode !== 'docs' && photos.length
      ? '<div class="hint">' + icon('cam') + '<span>Photos are organized into per-event NAS folders by each teammate’s agent — open one for its caption, tags, provenance and NAS path.</span></div>' : '');
}

/* ============================================================================
   TEAM & ROLES — permission matrix
   ========================================================================== */
function viewTeam(shows) {
  /* "shows" column is computed now: how many shows each person owns a step on */
  var load = {};
  USERS.forEach(function (u) { load[u.username] = 0; });
  shows.forEach(function (s) {
    var seen = {};
    s.steps.forEach(function (st) { if (st.owner && !seen[st.owner]) { seen[st.owner] = 1; load[st.owner] = (load[st.owner] || 0) + 1; } });
    [s.owner, s.on_site_poc].forEach(function (u) { if (u && !seen[u]) { seen[u] = 1; load[u] = (load[u] || 0) + 1; } });
  });

  var countBy = function (role) { return USERS.filter(function (u) { return u.role === role; }).length; };
  var rows = USERS.map(function (u) {
    var can = roleDefOf(u.role).can;
    var canChips = can.length ? '<div class="can-chips">' + can.map(function (c) { return rolePill(c); }).join('') + '</div>' : '<span class="pill idle">— cannot assign</span>';
    return '<tr><td><div class="ev-name"><span class="avatar" style="width:34px;height:34px;background:' + esc(u.color) + '">' + esc(u.initials) + '</span><div><b>' + esc(u.name) + '</b><span>' + esc(u.title) + '</span></div></div></td>' +
      '<td>' + rolePill(u.role) + (u.finance ? ' <span class="tag fin" title="The finance capability — accounting rights without the admin role. Margin is visible to admins AND finance.">finance</span>' : '') + '</td><td>' + typeTag(u.discipline) + '</td><td>' + canChips + '</td><td class="mono" style="color:var(--text-2)">' + (load[u.username] || 0) + '</td></tr>';
  }).join('');

  return '<div class="page-h"><div><h1>Team &amp; Roles</h1><div class="sub">Who’s on the roster, what they can do, and who can assign whom. Mirrors the e360 scheduler roster.</div></div>' +
    '<button class="btn" ' + toastAttrs('Invite', 'Send a Showrunner invite by email') + '>' + icon('mail') + 'Invite person</button></div>' +
    '<div class="stats">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">People</div><div class="v">' + USERS.length + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Admins</div><div class="v">' + countBy('admin') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Managers</div><div class="v" style="color:var(--info)">' + countBy('manager') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">PMs</div><div class="v" style="color:var(--go)">' + countBy('pm') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Techs</div><div class="v" style="color:var(--warn)">' + countBy('tech') + '</div></div>' +
    '</div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Roster</h3><span class="pill idle">' + countBy('viewer') + ' read-only viewer</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Discipline</th><th>Can assign</th><th>Shows</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="ov" style="grid-template-columns:1.1fr 1fr">' +
    '<div class="panel"><h3>Who can assign whom</h3>' + assignMatrix() +
    '<div class="perm-note">Rows are the person assigning; columns are the role being assigned. Assignment flows down the chain — a PM can hand work to techs and viewers on their own events, but never to a manager or admin.</div></div>' +
    '<div class="panel"><h3>Roles</h3><div class="role-defs">' + ROLE_ORDER.map(roleDef).join('') + '</div></div>' +
    '</div>';
}
function assignMatrix() {
  var head = '<tr><th></th>' + ROLE_ORDER.map(function (r) { return '<th>' + esc(ROLES[r].name) + '</th>'; }).join('') + '</tr>';
  var body = ROLE_ORDER.map(function (row) {
    var cells = ROLE_ORDER.map(function (col) { return ROLES[row].can.indexOf(col) >= 0 ? '<td class="yes">' + icon('check') + '</td>' : '<td class="no">·</td>'; }).join('');
    return '<tr><th>' + esc(ROLES[row].name) + '</th>' + cells + '</tr>';
  }).join('');
  return '<div class="tbl-wrap"><table class="matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}
function roleDef(role) {
  var r = roleDefOf(role);
  return '<div class="role-def"><div class="ri" style="color:' + r.col + ';background:color-mix(in srgb,' + r.col + ' 12%,transparent)">' + icon(r.ic) + '</div>' +
    '<div class="rd"><b>' + esc(r.name) + ' ' + rolePill(role) + '</b><p>' + esc(r.desc) + '</p></div></div>';
}

/* ============================================================================
   TEMPLATES ADMIN — editable per-type lane + step grid, T-minus offsets.
   Iterates typeDef(type).lanes so every event type's grid is config-driven.
   ========================================================================== */
var curTpl = 'led';
function tplFolderCount(projects, type) { return projects.filter(function (p) { return p.type === type; }).length; }

function viewTemplates(projects) {
  var cards = Object.keys(EVENT_TYPES).map(function (type) {
    var t = typeDef(type);
    var nSteps = t.lanes.reduce(function (a, l) { return a + ((TEMPLATE_STEPS[type] && TEMPLATE_STEPS[type][l.key]) || []).length; }, 0);
    var meta = TEMPLATE_META[type] || { desc: 'Custom event type.' };
    return '<button class="tpl-card ' + (type === curTpl ? 'on' : '') + '" ' + act('selectTpl', null, type) + '>' +
      '<div class="ti">' + icon(t.icon) + '</div><b>' + esc(t.label) + ' template</b><div class="td">' + esc(meta.desc) + '</div>' +
      '<div class="tm">' + typeTag(type) + '<span><b>' + t.lanes.length + '</b> lanes</span><span><b>' + nSteps + '</b> steps</span><span><b>' + tplFolderCount(projects, type) + '</b> folders</span></div>' +
      '</button>';
  }).join('');
  return '<div class="page-h"><div><h1>Templates</h1><div class="sub">The SOP for each event TYPE, encoded once. Applying a template seeds a show’s lanes, tasks and T-minus due dates.</div></div>' +
    '<button class="btn" ' + act('addEventType') + '>' + icon('plus') + 'Add event type</button></div>' +
    '<div class="callout"><div class="ci">' + icon('layers') + '</div><div><b>Event types are extensible</b>' +
    '<p>Each type owns its own lane set — LED, Print and LED + Print here. Adding a new type (e.g. <b>Motion Graphics</b>) is a single config entry in <code>EVENT_TYPES</code> plus, optionally, a <code>TEMPLATE_STEPS</code> block. Nothing in the dashboard, folder, pipeline or this grid is hardcoded to a lane — they all read the config.</p></div></div>' +
    '<div class="tpl-cards">' + cards + '<button class="tpl-card add" ' + act('addEventType') + '>' + icon('plus') + 'Add event type</button></div>' +
    '<div id="tplEditor">' + tplEditor(curTpl, projects) + '</div>';
}
function selectTpl(type, projects) {
  curTpl = type;
  document.querySelectorAll('.tpl-card').forEach(function (c) { c.classList.remove('on'); });
  var idx = Object.keys(EVENT_TYPES).indexOf(type);
  var cards = $('#scroll').querySelectorAll('.tpl-card');
  if (cards[idx]) cards[idx].classList.add('on');
  $('#tplEditor').innerHTML = tplEditor(type, projects);
}
function roleSelHTML(role) {
  var r = roleDefOf(role);
  return '<span class="role-sel" ' + toastAttrs('Assign role', 'Any role on the roster can own this step') + '><span class="rdot" style="background:' + r.col + '"></span><span class="rlbl">' + esc(r.name) + '</span>' + icon('chevD') + '</span>';
}
function offsetHTML(off) {
  var after = off < 0;
  return '<div class="offset"><span class="tp">T' + (after ? '+' : '−') + '</span><input class="off-in" type="number" value="' + Math.abs(off) + '" aria-label="T-minus days"><span class="du">d</span></div>';
}
function tplEditor(type, projects) {
  var t = typeDef(type), anchor = t.anchor;
  var nSteps = t.lanes.reduce(function (a, l) { return a + ((TEMPLATE_STEPS[type] && TEMPLATE_STEPS[type][l.key]) || []).length; }, 0);
  var used = tplFolderCount(projects, type);
  var lanesHTML = t.lanes.map(function (l) {
    var steps = (TEMPLATE_STEPS[type] && TEMPLATE_STEPS[type][l.key]) || [];
    var rows = steps.map(function (s) {
      var flag = s.flag === 'auto' ? '<span class="mini auto">auto-gen</span>' : s.flag === 'dep' ? '<span class="mini dep">depends</span>' : '';
      return '<div class="grid-row"><div class="grip">' + icon('grip') + '</div>' +
        '<input class="cell-in" value="' + esc(s.name) + '" aria-label="Step name">' +
        roleSelHTML(s.role) + offsetHTML(s.off) + '<div>' + flag + '</div>' +
        '<button class="rowdel" title="Remove step" ' + toastAttrs('Step removed', 'Template edit staged') + '>' + icon('trash') + '</button></div>';
    }).join('') || '<div class="grid-row" style="grid-template-columns:1fr"><span class="lane-empty">no steps — add one below</span></div>';
    return '<div class="lane-edit"><div class="leh"><span class="ld" style="background:' + esc(l.color) + '"></span><b>' + esc(l.label) + '</b><span class="cnt">' + steps.length + ' steps</span></div>' +
      '<div class="grid-head"><span></span><span>Step</span><span>Owner role</span><span>Offset</span><span>Flag</span><span></span></div>' + rows +
      '<button class="addstep" ' + toastAttrs('Add step', l.label + ' lane — new step row') + '>' + icon('plus') + 'Add step to ' + esc(l.label) + '</button></div>';
  }).join('');
  return '<div class="ed-head"><div class="et"><div class="ti" style="width:36px;height:36px;border-radius:9px;background:var(--surface-3);display:grid;place-items:center;color:var(--accent)">' + icon(t.icon) + '</div>' +
    '<div><h2>' + esc(t.label) + ' template</h2><div class="sub" style="color:var(--muted);font-size:12.5px;margin-top:2px">' + typeTag(type) + ' &nbsp; ' + t.lanes.length + ' lanes · ' + nSteps + ' steps · anchored to <b style="color:var(--text-2)">' + esc(anchor) + '</b> · used by ' + used + ' folder' + (used === 1 ? '' : 's') + '</div></div></div>' +
    '<div style="display:flex;gap:9px"><button class="btn ghost" ' + toastAttrs('Preview', 'Rendered T-minus schedule from ' + anchor) + '>' + icon('cal') + 'Preview schedule</button>' +
    '<button class="btn primary" ' + toastAttrs('Template saved', t.label + ' SOP updated') + '>' + icon('check') + 'Save template</button></div></div>' +
    '<div class="hint" style="margin:0 0 16px">' + icon('bolt') + 'Offsets are <b>T-minus days from ' + esc(anchor) + '</b>. Edit a step name or offset inline; every show seeded from this template inherits the change.</div>' +
    lanesHTML +
    '<button class="addlane" ' + toastAttrs('Add lane', 'New lane on the ' + t.label + ' template — add it to LANES + this type’s lane list') + '>' + icon('plus') + 'Add lane to ' + esc(t.label) + '</button>';
}
function addEventType() {
  openModal('Add event type', '<p style="margin:0 0 14px;color:var(--text-2);font-size:13px;line-height:1.6">Types are config-driven and extensible. To add one (e.g. <b>Motion Graphics</b>):</p>' +
    '<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;font-family:var(--font-mono);font-size:11.5px;line-height:1.7;color:var(--text-2);overflow:auto">' +
    '<span style="color:var(--muted)">// 1 · add any new lanes to LANES</span><br>storyboard:{key:&#39;storyboard&#39;,label:&#39;Storyboard&#39;,color:&#39;#F58BB0&#39;},<br><br>' +
    '<span style="color:var(--muted)">// 2 · one EVENT_TYPES entry</span><br>motion:{ label:&#39;Motion Graphics&#39;, tag:&#39;both&#39;, icon:&#39;play&#39;,<br>&nbsp;&nbsp;anchor:&#39;Delivery day&#39;,<br>&nbsp;&nbsp;lanes: laneset(&#39;client&#39;,&#39;storyboard&#39;,&#39;animation&#39;,&#39;render&#39;,&#39;deliverables&#39;) }</div>' +
    '<p style="margin:14px 0 0;color:var(--muted);font-size:12px;line-height:1.6">The dashboard rollup, event folder, pipeline, this grid and Calendar are all lane-agnostic — they pick up the new type automatically.</p>');
}

/* ============================================================================
   SETTINGS
   ========================================================================== */
/* ctx = {fin, pur, jobs} — the same overview payloads the money views read.
   Omitted (demo, or a direct call) it falls back to the mock computation. */
function viewSettings(ctx) {
  ctx = ctx || {};
  function card(ic, title, body) { return '<div class="set-card"><div class="sc-h"><div class="si">' + icon(ic) + '</div><b>' + esc(title) + '</b></div>' + body + '</div>'; }
  function row(k, v) { return '<div class="set-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var demo = api.isDemo();
  return '<div class="page-h"><div><h1>Settings</h1><div class="sub">Workspace, integrations and the systems Showrunner connects to.</div></div></div>' +
    '<div class="set-grid">' +
    card('users', 'Your session', (demo
      ? '<p>No Showrunner server answered on boot, so this window is running the <b>modeled demo dataset</b>. Nothing here is real and nothing you do is saved.</p>' +
        row('Mode', '<span style="color:var(--warn)">Demo data</span>') +
        row('Signed in as', esc(CURRENT_USER.name) + ' <small style="color:var(--muted)">(simulated)</small>')
      : '<p>A live session against the Showrunner API. Role and finance capability are read from the server on every request — they are never cached in this window.</p>' +
        row('Mode', '<span style="color:var(--go)">Live · API</span>') +
        row('Signed in as', esc(CURRENT_USER.name) + ' · ' + esc(CURRENT_USER.username)) +
        row('Role', esc(roleName(CURRENT_USER.role)) + (CURRENT_USER.finance ? ' · finance capability' : '')) +
        '<div class="set-row"><span class="k">Session</span><span class="v"><button class="btn sm ghost" ' + act('logout') + '>' + icon('lock') + 'Sign out</button></span></div>')) +
    card('gear', 'Workspace', '<p>e360 Sport control-room workspace.</p>' + row('Organization', 'E360 Sport') + row('Members', USERS.length) + row('Event types', Object.keys(EVENT_TYPES).length) +
      '<div class="set-row"><span class="k">Theme</span><span class="switch' + (isLight ? '' : ' on') + '" id="setTheme" ' + act('toggleTheme') + '><i></i></span></div>') +
    card('server', 'E360 NAS', '<p>Source files + heavy binaries. The DB stores a path + cached render; byte-serving is a deferred infra dependency.</p>' + row('Mount', '\\\\e360-nas\\showrunner') + row('Status', '<span style="color:var(--go)">reachable</span>') + row('Convention', 'P{id}-{slug}\\S{id}-{slug}\\{kind}')) +
    card('send', 'Staffing scheduler', '<p>Downstream system of record (e360-staffing3). Push-to-scheduler maps a show onto /api/events + child rows.</p>' + row('Base URL', 'SCHEDULER_BASE_URL') + row('Auth', 'service token') + row('Mode', 'dry-run default')) +
    card('layers', 'Flex + spec tools', '<p>Spec Sheet Generator, NovaSpec, PowerSpec + Flex. Bound artifacts derive .e360 → .nsf → .pcfg → pull sheet.</p>' + row('Chain', 'e360 · nsf · pcfg') + row('Flex', 'event folders + pull sheets') + row('Stale-flag', 'on re-bind')) +
    card('scale', 'Jobs + accounting', (function () {
      var st = ctx.fin || financeStats();
      var nJobs = ctx.jobs ? ctx.jobs.length : ALL_JOBS.length;
      var nLines = ctx.jobs
        ? ctx.jobs.reduce(function (a, jf) { return a + ((jf.lines || []).length); }, 0)
        : BUDGET_LINES.length;
      /* "View as" is a DEMO of the visibility gate. With a real server the
         identity is the session, so the row only appears in demo mode. */
      var viewAs = !demo ? '' : [ROSTER.tandres, ROSTER.jmercer, ROSTER.candice, ROSTER.bsawyer]
        .filter(Boolean).map(function (u) {
          return '<button class="va' + (u.username === CURRENT_USER.username ? ' on' : '') + '" ' + act('viewAs', u.id) +
            ' title="' + esc(u.name + ' · ' + (canSeeFinance(u) ? 'sees margin' : 'margin hidden')) + '">' +
            esc(firstName(u.username)) + (canSeeFinance(u) ? ' · fin' : '') + '</button>';
        }).join('');
      return '<p>One deal = one client = one QuickBooks job number = one budget. <b>rental</b> keeps the gear; <b>sale</b> carries hardware as COGS. Candice owns the QB numbers.</p>' +
        row('Jobs', nJobs + ' · ' + fmtMoney(st.billed) + ' billed') +
        row('Budget lines', nLines + ' · ' + fmtMoney(st.budgeted) + ' allotted') +
        row('Actuals to date', fmtMoney(st.actual)) +
        row('Waiting on paperwork', st.exceptions
          ? '<span style="color:var(--crit)">' + st.exceptions + ' items · ' + fmtMoney(st.excAmount) + '</span>'
          : '<span style="color:var(--go)">clear</span>') +
        '<div class="set-row"><span class="k">Finance view</span><span class="v"><button class="btn sm ghost" ' + act('goFinance') + '>' + icon('scale') + 'Open Finance</button></span></div>' +
        (viewAs ? '<div class="set-row"><span class="k" title="Demo of the visibility gate — margin renders only for the finance capability">View as</span><span class="viewas">' + viewAs + '</span></div>' : '');
    })()) +
    card('cart', 'Purchasing', (function () {
      var ps = ctx.pur || purchasingStats();
      return '<p>Purchase orders from needed to reconciled. Ordered = committed on job budgets; received = actual. Rental deals route hardware to Flex inventory; sales carry it as COGS.</p>' +
        row('Approval threshold', '$' + PO_APPROVAL_THRESHOLD.toLocaleString('en-US') + ' · admins + Candice') +
        row('Open POs', ps.open + ' · ' + fmtMoney(ps.committed + ps.capex) + ' committed') +
        row('Awaiting approval', ps.awaiting
          ? '<span style="color:var(--warn)">' + ps.awaiting + ' · ' + fmtMoney(ps.awaitingAmount) + '</span>'
          : '<span style="color:var(--go)">clear</span>') +
        row('Delivery risks', ps.risks
          ? '<span style="color:' + (ps.riskCrit ? 'var(--crit)' : 'var(--warn)') + '">' + ps.riskCrit + ' crit · ' + ps.riskWarn + ' warn</span>'
          : '<span style="color:var(--go)">clear</span>') +
        '<div class="set-row"><span class="k">Purchasing view</span><span class="v"><button class="btn sm ghost" ' + act('goPurchasing') + '>' + icon('cart') + 'Open Purchasing</button></span></div>' +
        '<div class="perm-note" style="margin-top:10px">' + inlineIcon('lock') + ' Over $5,000, approval sits with the admins — <b>Tom, Tony, Jim</b> — plus <b>Candice</b> via her finance capability. Tom’s confirmed rule.</div>';
    })()) +
    card('users', 'Roles &amp; access', '<p>Five canonical roles gate edit + assignment rights across the workspace.</p>' + row('Roles', 'admin · manager · pm · tech · viewer') + row('Default', 'viewer')) +
    '</div>';
}

/* ============================================================================
   MULTIMEDIA VIEWER — bind a spec/proof to a show -> view + print.
   Navigates by FILE ID (not array index) so mutations can't shift the target.
   ========================================================================== */
var VIEWER = { showId: null, fileId: null };
function viewViewer(show) {
  var files = show.files;
  if (!files.length) return '<div class="empty">No files bound to this show yet.</div>';
  if (!files.some(function (f) { return f.id === VIEWER.fileId; })) VIEWER.fileId = files[0].id;
  var strip = files.map(function (f) {
    /* photos show their real thumb + caption in the strip (photo pass) */
    var th = f.kind === 'photo'
      ? '<div class="vth ph"><img src="' + esc(f.thumb) + '" alt=""></div>'
      : '<div class="vth">' + icon(fileIcon(f)) + '</div>';
    var label = f.kind === 'photo' ? (f.caption || f.name) : f.name;
    return '<button class="vfile ' + (f.id === VIEWER.fileId ? 'on' : '') + '" ' + act('vSet', f.id) + '>' + th +
      '<div class="vt"><b>' + esc(label) + '</b><span>.' + esc(f.ext) + ' · ' + esc(fmtSize(f.size)) + '</span></div></button>';
  }).join('');
  var title = show.project.single ? show.project.name : show.name;
  return '<div class="page-h" style="margin-bottom:16px"><div><h1>Multimedia Viewer</h1><div class="sub">Any bound spec, proof, PDF or image — paged through and print-ready. Make a spec, bind it to a show, and anyone with folder access can view and print it.</div></div>' +
    '<button class="btn ghost" ' + act('openShow', show.id) + '>' + icon('folder') + 'Back to folder</button></div>' +
    '<div class="viewer-shell">' +
    '<div class="vstrip"><div class="vsh"><b>' + esc(title) + '</b><span class="n">' + files.length + '</span></div>' + strip + '</div>' +
    '<div class="stage" id="vStage"></div>' +
    '<div class="vmeta" id="vMeta"></div>' +
    '</div>';
}
function viewerIndex(show) {
  for (var i = 0; i < show.files.length; i++) if (show.files[i].id === VIEWER.fileId) return i;
  return 0;
}
/* prev/next stays INSIDE the photo set when a photo is up (photo pass) — you
   page through the gallery in taken_at order, never out into the spec sheets
   mid-lightbox. */
function viewerNavList(show) {
  var cur = null;
  show.files.forEach(function (x) { if (x.id === VIEWER.fileId) cur = x; });
  if (cur && cur.kind === 'photo') return photosForShow(show.id);
  return show.files;
}
function drawViewer(show) {
  var files = show.files;
  if (!files.length) return;
  var i = viewerIndex(show), f = files[i];
  VIEWER.fileId = f.id;
  var isPhoto = f.kind === 'photo';
  var nav = viewerNavList(show), ni = 0;
  nav.forEach(function (x, k) { if (x.id === f.id) ni = k; });
  document.querySelectorAll('.vfile').forEach(function (b, bi) { b.classList.toggle('on', bi === i); });
  var stitle = isPhoto
    ? '<b>' + esc(f.caption || f.name) + '</b><span>.' + esc(f.ext) + ' · ' + esc(fmtTs(f.taken_at)) + ' · ' + esc(f.dim) + '</span>'
    : '<b>' + esc(f.name) + '</b><span>.' + esc(f.ext) + ' · ' + esc(f.ver) + ' · ' + esc(f.dim) + '</span>';
  $('#vStage').innerHTML = '<div class="stage-bar"><div class="stitle">' + stitle + '</div>' +
    '<div class="pagenav"><button class="iconbtn" title="Previous" ' + act('vGo', -1) + '>' + icon('chevL') + '</button>' +
    '<span class="mono" style="font-size:11px;color:var(--muted);padding:0 6px">' + (ni + 1) + ' / ' + nav.length + (isPhoto ? ' photos' : '') + '</span>' +
    '<button class="iconbtn" title="Next" ' + act('vGo', 1) + '>' + icon('chevR') + '</button></div>' +
    '<button class="btn sm primary" ' + act('printFile') + '>' + icon('print') + 'Print</button></div>' +
    '<div class="stage-canvas">' + sheetHTML(show, f, show.gear) + '</div>';

  var title = show.project.single ? show.project.name : show.name;
  if (isPhoto) { drawPhotoMeta(show, f, title); return; }
  /* financial docs carry money metadata + (for proposals) the review actions */
  var isFin = !!FIN_KINDS[f.kind];
  var finJob = isFin ? JOBS_BY_ID[fileJobId(f)] : null;
  var finRows = isFin
    ? metaRow('Vendor', f.vendor || '—') + metaRow('Amount', fmtMoney(f.amount)) +
      metaRow('Doc date', fmtDateFull(f.doc_date || f.created_at)) +
      metaRow('Billed to', finJob ? finJob.qb_job_number + (finJob.deal_type ? ' · ' + finJob.deal_type : '') : '—') +
      metaRow('Status', f.status === 'proposed' ? 'Proposed — awaiting review' : 'Filed') +
      metaRow('Filed by', f.provenance ? actorLabel(null, f.provenance) + ' · ' + Math.round(f.provenance.confidence) + '%' : userName(f.uploaded_by))
    : '';
  var reviewActs = isFin && f.status === 'proposed'
    ? '<button class="btn primary" ' + act('confirmDoc', f.id) + '>' + icon('check') + 'Confirm — file it</button>' +
      '<button class="btn ghost" ' + act('rejectDoc', f.id) + '>' + icon('x') + 'Reject proposal</button>'
    : '';
  $('#vMeta').innerHTML = '<div class="mh"><b>File details</b></div>' +
    '<div class="bound"><div class="bi">' + icon('pin') + '</div><div class="bt"><span>Bound to</span><b>' + esc(title) + '</b></div></div>' +
    metaRow('Type', fileTypeLabel(f, show)) +
    finRows +
    metaRow('Version', f.ver) + metaRow('Size', fmtSize(f.size)) + metaRow('Dimensions', f.dim) +
    (isFin ? '' : metaRow('Uploaded by', userName(f.uploaded_by))) + metaRow('Uploaded', fmtDateFull(f.created_at)) +
    (!isFin && show.job ? metaRow('Job', show.job.qb_job_number) : '') +
    '<div class="acts">' + reviewActs + '<button class="btn primary" ' + act('printFile') + '>' + icon('print') + 'Print this file</button>' +
    '<button class="btn" ' + toastAttrs('Download', f.name + '.' + f.ext + ' from the NAS') + '>' + icon('download') + 'Download</button>' +
    '<button class="btn ghost" ' + toastAttrs('Bound', 'Spec re-bound to ' + title) + '>' + icon('link') + 'Re-bind to folder</button></div>' +
    '<div class="note-meta-lock">' + icon('lock') + '<span>Bound to ' + esc(title) + ' — ' + esc(show.venue) + '. Anyone with folder access can view and print; the approved version stays locked.</span></div>' +
    /* the file's anchored thread (notes pass) — agents read it when filing */
    '<div class="vnotes"><div class="vh">Notes' + (noteCount('file', f.id) ? ' · ' + noteCount('file', f.id) : '') + '</div>' +
    notesThread('file', f.id) + '</div>';
}

/* ---- photo meta panel (photo pass): taken/shot-by/tags · inline caption
   edit (pm+ or the uploader) · NAS path · provenance · confirm/reject on
   proposals · the recap-pick toggle. Notes thread mounts exactly as for docs. */
function drawPhotoMeta(show, f, title) {
  var canCap = canEditPhoto(f);
  var capBlock;
  if (PH_UI.editCap === f.id && canCap) {
    capBlock = '<div class="ph-capedit"><textarea id="phCapIn" class="note-in" rows="3">' + esc(f.caption || '') + '</textarea>' +
      '<div style="display:flex;gap:7px;justify-content:flex-end;margin-top:7px">' +
      '<button class="btn sm ghost" ' + act('phCapCancel') + '>Cancel</button>' +
      '<button class="btn sm primary" ' + act('phCapSave', f.id) + '>' + icon('check') + 'Save caption</button></div></div>';
  } else {
    capBlock = '<div class="ph-capedit"><div style="display:flex;gap:8px;align-items:flex-start">' +
      '<span style="flex:1;line-height:1.5">' + esc(f.caption || '—') + '</span>' +
      (canCap ? '<button class="iconbtn" style="width:26px;height:26px;flex:none" title="Edit caption" ' + act('phCapEdit', f.id) + '>' + icon('pencil') + '</button>' : '') +
      '</div></div>';
  }
  var tagRow = (f.tags && f.tags.length)
    ? '<div class="ph-tagrow">' + f.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>'
    : '';
  var rows = metaRow('Type', 'Event photo') +
    metaRow('Taken', fmtTs(f.taken_at)) +
    metaRow('Shot by', f.shot_by ? userName(f.shot_by) : '—') +
    metaRow('Dimensions', (f.width && f.height) ? f.width + ' × ' + f.height + ' px' : f.dim) +
    metaRow('Size', fmtSize(f.size)) +
    metaRow('Filed by', f.provenance ? actorLabel(null, f.provenance) + ' · ' + Math.round(f.provenance.confidence) + '%' : userName(f.uploaded_by)) +
    metaRow('Status', f.status === 'proposed' ? 'Proposed — awaiting review' : 'Filed' + (f.recap_pick ? ' · recap pick' : ''));
  var acts = [];
  if (f.status === 'proposed') {
    acts.push('<button class="btn primary" ' + act('photoConfirm', f.id) + '>' + icon('check') + 'Confirm — file it</button>');
    acts.push('<button class="btn ghost" ' + act('photoReject', f.id) + '>' + icon('x') + 'Reject proposal</button>');
  } else if (PH_EDIT_ROLES[CURRENT_USER.role]) {
    acts.push('<button class="btn ' + (f.recap_pick ? '' : 'primary') + '" ' + act('photoPick', f.id) + '>' + icon('star') +
      (f.recap_pick ? 'Recap pick — remove' : 'Star for the recap') + '</button>');
  }
  acts.push('<button class="btn" ' + toastAttrs('Download', f.name + '.' + f.ext + ' from the NAS') + '>' + icon('download') + 'Download original</button>');
  var provNote = f.provenance
    ? 'Organized by ' + actorLabel(null, f.provenance) + ' from ' + (f.provenance.source_label || 'a camera-roll sync') +
      ' — proposals ride the same review flow as documents.'
    : 'Uploaded by ' + userName(f.uploaded_by) + '. The original lives on the NAS; the record here is metadata + a thumbnail.';
  $('#vMeta').innerHTML = '<div class="mh"><b>Photo details</b></div>' +
    '<div class="bound"><div class="bi">' + icon('cam') + '</div><div class="bt"><span>Tagged to</span><b>' + esc(title) + '</b></div></div>' +
    capBlock + tagRow + rows +
    '<div class="ph-nas">' + icon('server') + '<span>' + esc(f.nas_path || '') + '</span></div>' +
    '<div class="acts">' + acts.join('') + '</div>' +
    '<div class="note-meta-lock">' + icon(f.provenance ? 'bolt' : 'lock') + '<span>' + esc(provNote) + '</span></div>' +
    '<div class="vnotes"><div class="vh">Notes' + (noteCount('file', f.id) ? ' · ' + noteCount('file', f.id) : '') + '</div>' +
    notesThread('file', f.id) + '</div>';
}
