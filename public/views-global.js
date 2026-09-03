/* ============================================================================
   e360 SHOWRUNNER — GLOBAL VIEWS
   My Tasks · Calendar · Team & Roles · Files library · Templates · Settings ·
   Multimedia Viewer.
   ========================================================================== */

/* ============================================================================
   MY TASKS — everything assigned to CURRENT_USER, across every show
   ========================================================================== */
/* F2 — the show reports THIS person still owes, rendered above the task table.
   TEAM_FEEDBACK: "nags in My Tasks + bell until submitted". It sits at the top
   because it is the one thing here that is REQUIRED rather than assigned, and
   because a nag buried under twenty steps is not a nag. */
function myReportsBlock(owed) {
  if (!owed || !owed.length) return '';
  var rows = owed.map(function (r) {
    var s = r.show || SHOWS_BY_ID[r.show_id];
    var late = r.due_date && r.due_date < TODAY_ISO;
    var age = r.due_date ? dayAge(r.due_date) : null;
    return '<div class="next-item" ' + act('openReport', r.show_id) + ' style="cursor:pointer">' +
      '<div class="txt">Show report — ' + esc(s ? showLabel(s) : 'show ' + r.show_id) +
      '<span>' + esc(r.role_on_site || 'crew') +
      (r.due_date ? ' · due ' + esc(fmtDate(r.due_date)) +
        (late && age ? ' · ' + age + 'd late' : '') : '') +
      (r.nag_count ? ' · asked ' + r.nag_count + '×' : '') + '</span></div>' +
      '<span class="pill ' + (late ? 'crit' : 'warn') + '"><span class="dot"></span>' +
      (late ? 'Overdue' : 'Required') + '</span>' +
      '<button class="btn sm primary" ' + act('openReport', r.show_id) + '>' + icon('pencil') + 'Write it</button>' +
      '</div>';
  }).join('');
  return '<div class="panel report-nag"><h3>' + inlineIcon('alert') + ' Show reports you owe · ' +
    owed.length + '</h3><div class="next-list">' + rows + '</div>' +
    '<div class="perm-note">' + inlineIcon('lock') + ' Required after every show you crew. Write it in ' +
    'the app or attach the document you already have — it lands in the event folder’s files. Nobody ' +
    'signs it off; filing it is what clears it.</div></div>';
}

function viewMyTasks(mine, owedReports) {
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

  var owed = owedReports || reportsOwedBy(ME);
  return '<div class="page-h"><div><h1>My Tasks</h1><div class="sub">Everything assigned to you, across every show and every lane set — plus anything you owe after a show.</div></div></div>' +
    '<div class="stats" style="grid-template-columns:repeat(4,1fr)">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Assigned to me</div><div class="v">' + mine.length + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Due within 10d</div><div class="v" style="color:var(--warn)">' + dueSoon + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--crit)"></div><div class="k">Overdue</div><div class="v" style="color:var(--crit)">' + over + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:' + (owed.length ? 'var(--crit)' : 'var(--go)') + '"></div><div class="k">Show reports owed</div><div class="v" style="color:' + (owed.length ? 'var(--crit)' : 'var(--go)') + '">' + owed.length + '</div></div></div>' +
    myReportsBlock(owed) +
    '<div class="card"><div class="card-h"><h3>Open tasks — ' + esc(CURRENT_USER.name) + '</h3></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Task</th><th>Show</th><th>Lane</th><th>Status</th><th>Due</th></tr></thead><tbody>' + list + '</tbody></table></div></div>';
}

/* ============================================================================
   CALENDAR — milestones across every show; lane-agnostic
   ========================================================================== */
function viewCalendar(shows) {
  var items = [];
  shows.forEach(function (s) {
    var taken = {};
    (s.milestones || []).forEach(function (m) {
      if (m.date) taken[m.date] = 1;
      items.push({ show: s, label: m.label, date: m.date });
    });
    /* The production dates live ON the show row, not in milestones — so a show
       created through the product (which seeds no milestone rows) left the
       Calendar empty while its load-in bore down. Fold them in. A milestone
       already marking the same day wins: it is the richer row, and the demo
       seeds "Load-in"/"Show" milestones on those exact dates. */
    var anchor = typeDef(s.type).anchor || 'Event';
    [['load_in_date', 'Load-in'], ['event_date', anchor], ['strike_date', 'Strike']]
      .forEach(function (pair) {
        var d = s[pair[0]];
        if (d && !taken[d]) { taken[d] = 1; items.push({ show: s, label: pair[1], date: d }); }
      });
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
    /* the same cell + chip the folder's Files tab uses, so the Download
       affordance is in both grids and not just the one somebody walked */
    return '<div class="file-cell"><button class="file" ' + act('openViewer', x.f.id) + '>' +
      '<div class="thumb">' + icon(fileIcon(x.f)) + '<span class="ext">' + esc(x.f.ext) + '</span></div>' +
      '<div class="fb"><b>' + esc(x.f.name) + '</b><span>' + esc(where) + '</span></div></button>' +
      fileDownloadChip(x.f) + fileDeleteChip(x.f) + '</div>';
  }).join('');
  var seg = '<div class="seg">' +
    [['docs', 'Documents', docs.length], ['photos', 'Photos', photos.length], ['all', 'All', all.length]].map(function (m) {
      return '<button class="' + (mode === m[0] ? 'on' : '') + '" ' + act('filesMode', null, m[0]) + '>' +
        esc(m[1]) + ' <span class="sc">' + m[2] + '</span></button>';
    }).join('') + '</div>';
  return '<div class="page-h"><div><h1>Files</h1><div class="sub">Every spec, proof, contract, confirmation — and the event photo galleries — metadata here, bytes on the e360 NAS. A file with bytes behind it opens in the viewer as the document itself — streamed from the NAS through the app — and downloads straight off its card.</div></div>' + seg + '</div>' +
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
   TEAM & ROLES — the roster, the permission matrix, and people admin
   ----------------------------------------------------------------------------
   "I want to be able to create and manage users and permissions… people come
   and go" (Tom). Everything an admin needs to run the roster lives on this one
   screen: add a person, change what they can do, reset a password they lost,
   and switch somebody off when they leave.

   DEACTIVATE, NEVER DELETE. A person who goes still owns steps, wrote notes,
   filed reports and shows up all over the activity trail. Deleting the row
   would orphan every one of those; deactivating refuses their login, ends
   their sessions and takes them off every picker while leaving their name on
   their work. That is why the inactive people are still ON this page, in their
   own section — they are part of the record, not a mistake to be tidied away.
   ========================================================================== */
function teamCanAdmin() { return CURRENT_USER.role === 'admin'; }

function teamRowActions(u) {
  if (!teamCanAdmin()) return '';
  var isMe = u.username === CURRENT_USER.username;
  return '<td class="team-acts">' +
    '<button class="btn sm ghost" ' + act('userEdit', u.id) + ' title="Role, finance capability and profile">' +
      icon('pencil') + 'Edit</button>' +
    '<button class="btn sm ghost" ' + act('userReset', u.id) + ' title="Mint a new temporary password">' +
      icon('lock') + 'Reset password</button>' +
    (u.active === false
      ? '<button class="btn sm ghost" ' + act('userActivate', u.id) + '>' + icon('check') + 'Reactivate</button>'
      : '<button class="btn sm ghost" ' + act('userDeactivate', u.id) +
        (isMe ? ' title="This would sign you out of your own account"' : '') + '>' +
        icon('x') + 'Deactivate</button>') +
    '</td>';
}

/* The address, as the roster sees it — and the EMPTY one is the interesting
   case, which is why it gets a chip rather than a blank cell. With no address
   every notification this person is owed is marked "skipped — no email address
   on file" and only ever reaches the bell; a blank cell reads as "nothing to
   see here", and that is the opposite of true. */
function teamEmailCell(u) {
  /* Admin-only, and the whole column disappears for everybody else rather than
     filling with dashes — which is exactly the server's own disclosure rule
     (the `email` key is simply ABSENT from a non-admin's roster read, so there
     would be nothing to put in the cells anyway). */
  if (!teamCanAdmin()) return '';
  if (!u.email) {
    return '<td><span class="pill idle" title="Notifications for this person are marked ' +
      '&quot;skipped — no email address on file&quot; and only reach the bell.">no email</span></td>';
  }
  return '<td class="mono" style="font-size:11.5px;word-break:break-all">' +
    '<a href="mailto:' + esc(u.email) + '" style="color:var(--text-2)">' + esc(u.email) + '</a>' +
    (u.staffing_name
      ? '<div style="color:var(--muted);font-size:10.5px;margin-top:2px" ' +
        'title="The name the staffing app knows them by — used to match travel, hotels and crew on push.">' +
        'staffing: ' + esc(u.staffing_name) + '</div>'
      : '') +
    '</td>';
}

function teamRow(u, load, dim) {
  var can = roleDefOf(u.role).can;
  var canChips = can.length
    ? '<div class="can-chips">' + can.map(function (c) { return rolePill(c); }).join('') + '</div>'
    : '<span class="pill idle">— cannot assign</span>';
  return '<tr' + (dim ? ' class="team-off"' : '') + '>' +
    '<td><div class="ev-name"><span class="avatar" style="width:34px;height:34px;background:' + esc(u.color) + '">' +
      esc(u.initials) + '</span><div><b>' + esc(u.name) + '</b><span>' + esc(u.title || u.username) + '</span></div></div></td>' +
    teamEmailCell(u) +
    '<td>' + rolePill(u.role) +
      (u.finance ? ' <span class="tag fin" title="The finance capability — accounting rights without the admin role. Margin is visible to admins AND finance.">finance</span>' : '') +
      (u.must_change ? ' <span class="tag" title="Still on the temporary password the server minted — they will be asked to change it when they sign in.">temp password</span>' : '') +
      '</td>' +
    '<td>' + typeTag(u.discipline) + '</td>' +
    '<td>' + canChips + '</td>' +
    '<td class="mono" style="color:var(--text-2)">' + (load[u.username] || 0) + '</td>' +
    teamRowActions(u) + '</tr>';
}

function viewTeam(shows) {
  /* "shows" column is computed now: how many shows each person owns a step on.
     Computed for EVERYONE, active or not: somebody who left this month still
     owned steps on shows that are still running, and blanking that column
     would be the first place the record quietly stopped telling the truth. */
  var load = {};
  USERS.forEach(function (u) { load[u.username] = 0; });
  shows.forEach(function (s) {
    var seen = {};
    s.steps.forEach(function (st) { if (st.owner && !seen[st.owner]) { seen[st.owner] = 1; load[st.owner] = (load[st.owner] || 0) + 1; } });
    [s.owner, s.on_site_poc].forEach(function (u) { if (u && !seen[u]) { seen[u] = 1; load[u] = (load[u] || 0) + 1; } });
  });

  /* USERS holds whoever the read-through cache has seen. Split it here, and
     count the STATS off the active list only — "4 admins" has to mean four
     people who can actually sign in, or the number is worse than useless. */
  var active = USERS.filter(function (u) { return u.active !== false; });
  var inactive = USERS.filter(function (u) { return u.active === false; });
  var countBy = function (role) { return active.filter(function (u) { return u.role === role; }).length; };
  var admin = teamCanAdmin();
  var demo = api.isDemo();

  var cols = 5 + (admin ? 2 : 0);
  var head = '<tr><th>Person</th>' + (admin ? '<th>Email</th>' : '') +
    '<th>Role</th><th>Discipline</th><th>Can assign</th><th>Shows</th>' +
    (admin ? '<th>Manage</th>' : '') + '</tr>';
  var rows = active.map(function (u) { return teamRow(u, load, false); }).join('') ||
    '<tr><td colspan="' + cols + '"><div class="empty">Nobody on the roster.</div></td></tr>';
  var offRows = inactive.map(function (u) { return teamRow(u, load, true); }).join('');

  return '<div class="page-h"><div><h1>Team &amp; Roles</h1><div class="sub">Who’s on the roster, what they can do, and who can assign whom. Mirrors the e360 scheduler roster.</div></div>' +
    (admin
      ? '<button class="btn primary" ' + act('userAdd') + '>' + icon('plus') + 'Add person</button>'
      : '') + '</div>' +
    (admin && demo
      ? '<div class="callout"><div class="ci">' + icon('layers') + '</div><div><b>Demo data — these controls are a simulation</b>' +
        '<p>No Showrunner server answered on boot, so adding a person, changing a role or resetting a password ' +
        'happens only in this browser tab and is gone on reload. The rules are the real ones — the same username ' +
        'validation, the same refusal to strand the last admin — so what you learn here is what the server does.</p></div></div>'
      : '') +
    '<div class="stats">' +
    '<div class="stat accent"><div class="rail-c" style="background:var(--accent)"></div><div class="k">People</div><div class="v">' + active.length + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--accent)"></div><div class="k">Admins</div><div class="v">' + countBy('admin') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--info)"></div><div class="k">Managers</div><div class="v" style="color:var(--info)">' + countBy('manager') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--go)"></div><div class="k">PMs</div><div class="v" style="color:var(--go)">' + countBy('pm') + '</div></div>' +
    '<div class="stat"><div class="rail-c" style="background:var(--warn)"></div><div class="k">Techs</div><div class="v" style="color:var(--warn)">' + countBy('tech') + '</div></div>' +
    '</div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Roster</h3><span class="pill idle">' + countBy('viewer') + ' read-only viewer</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div></div>' +

    /* The inactive section only exists when somebody is in it — an empty
       "Inactive" header on a company that has never lost anyone is noise. */
    (offRows
      ? '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Inactive</h3>' +
        '<span class="pill idle">' + inactive.length + ' no longer signing in</span></div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead>' + head + '</thead><tbody>' + offRows + '</tbody></table></div>' +
        '<div class="perm-note">' + inlineIcon('lock') + ' Nothing was deleted. These people cannot sign in and ' +
        'do not appear in owner pickers, crew lists or @mentions — but every step they owned, note they wrote and ' +
        'report they filed still carries their name, everywhere in the app.' +
        (admin ? ' Reactivate puts somebody straight back on the roster; they keep their old password unless you reset it.' : '') +
        '</div></div>'
      : '') +

    '<div class="ov" style="grid-template-columns:1.1fr 1fr">' +
    '<div class="panel"><h3>Who can assign whom</h3>' + assignMatrix() +
    '<div class="perm-note">Rows are the person assigning; columns are the role being assigned. Assignment flows down the chain — a PM can hand work to techs and viewers on their own events, but never to a manager or admin.</div></div>' +
    '<div class="panel"><h3>Roles</h3><div class="role-defs">' + ROLE_ORDER.map(roleDef).join('') +
    (admin
      ? '<div class="perm-note" style="margin-top:12px">' + inlineIcon('lock') + ' <b>finance</b> is a capability, ' +
        'not a rank: it grants margin visibility and PO approval without making somebody an admin. That is how ' +
        'Candice approves purchase orders while staying a manager.</div>'
      : '') +
    '</div></div>' +
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
   ----------------------------------------------------------------------------
   THE EDITOR IS REAL NOW. Every button here used to be a toast while the grid
   rendered fully-styled inputs over rows nothing could save — the audit's
   sharpest "fake affordance" finding after the season buttons. The grid stages
   its edits in the DOM (rename inline, remove a row, add a row) and Save
   commits the WHOLE grid in one PUT, so a half-saved SOP cannot exist.

   Which template is "the" template: GET /templates/:type answers the type's
   OLDEST row — the same one createEvent and Seed-pipeline seed from — so Save
   edits the live SOP in place and the hint's promise ("every show seeded from
   this template inherits the change") is finally true. "Bank a copy" POSTs a
   snapshot; the versions list names every row of the type and lets a manager
   delete one (deleting the live SOP promotes the next-oldest).
   ========================================================================== */
var curTpl = 'led';
/* the shaped records the seam answered — the editor reads and writes THESE,
   never TEMPLATE_STEPS directly, so demo and API render one code path */
var TPL_CACHE = { list: [], versions: {} };
function tplFolderCount(projects, type) { return projects.filter(function (p) { return p.type === type; }).length; }
function tplByType(type) {
  var hit = null;
  (TPL_CACHE.list || []).forEach(function (t) { if (t.event_type === type) hit = t; });
  return hit;
}
/* the client mirror of the three routes' requireRole('manager') floor */
function canEditTemplates() {
  return CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'manager';
}

function viewTemplates(projects, tpls) {
  TPL_CACHE.list = tpls || [];
  if (!tplByType(curTpl) && TPL_CACHE.list.length) curTpl = TPL_CACHE.list[0].event_type;
  var cards = TPL_CACHE.list.map(function (t) {
    var d = t.def || typeDef(t.event_type);
    var nSteps = (d.lanes || []).reduce(function (a, l) { return a + ((t.steps && t.steps[l.key]) || []).length; }, 0);
    return '<button class="tpl-card ' + (t.event_type === curTpl ? 'on' : '') + '" ' + act('selectTpl', null, t.event_type) + '>' +
      '<div class="ti">' + icon(d.icon) + '</div><b>' + esc(d.label) + ' template</b><div class="td">' + esc((t.meta && t.meta.desc) || 'Custom event type.') + '</div>' +
      '<div class="tm">' + typeTag(t.event_type) + '<span><b>' + (d.lanes || []).length + '</b> lanes</span><span><b>' + nSteps + '</b> steps</span><span><b>' + tplFolderCount(projects, t.event_type) + '</b> folders</span></div>' +
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
  var idx = (TPL_CACHE.list || []).map(function (t) { return t.event_type; }).indexOf(type);
  var cards = $('#scroll').querySelectorAll('.tpl-card');
  if (cards[idx]) cards[idx].classList.add('on');
  $('#tplEditor').innerHTML = tplEditor(type, projects);
}
/* the role column is DISPLAY: template roles are planning slugs from
   templates.json ('lead_tech', …), not the five login roles, and offering the
   login-role picker here would write a vocabulary the seed never speaks.
   Editing the slug set is a deliberate cut this wave — the chevron that
   implied a dropdown is gone rather than kept as a lie. */
function roleSelHTML(role) {
  var r = roleDefOf(role);
  return '<span class="role-sel" title="' + esc('Owner-role slug: ' + (role || 'unassigned') + ' — carried through Save unchanged') + '"><span class="rdot" style="background:' + r.col + '"></span><span class="rlbl">' + esc(r.name) + '</span></span>';
}
function offsetHTML(off) {
  var after = off < 0;
  return '<div class="offset"><span class="tp">T' + (after ? '+' : '−') + '</span><input class="off-in" type="number" value="' + Math.abs(off) + '" aria-label="T-minus days"><span class="du">d</span></div>';
}
/* one editable grid row. The inputs carry what a person edits (name, offset
   magnitude); the data- attributes carry the row's full fidelity — owner_role,
   evidence_type, auto_source, depends_on_title, the offset SIGN — so a Save
   can never silently strip the flex automation off an event type. */
function tplRowHTML(s) {
  var flag = s.flag === 'auto' ? '<span class="mini auto">auto-gen</span>' : s.flag === 'dep' ? '<span class="mini dep">depends</span>' : '';
  var signed = s.off_signed !== undefined ? s.off_signed : -(Number(s.off) || 0);
  var canEdit = canEditTemplates();
  return '<div class="grid-row" data-tplrow="1"' +
    ' data-role="' + esc(s.role || '') + '"' +
    ' data-sign="' + (signed > 0 ? '+' : '-') + '"' +
    ' data-ev="' + esc(s.evidence_type || (s.flag === 'auto' ? 'file' : 'none')) + '"' +
    ' data-auto="' + esc(s.auto_source || (s.flag === 'auto' ? 'auto' : 'none')) + '"' +
    ' data-dep="' + esc(s.depends_on_title || (s.flag === 'dep' ? '·' : '')) + '">' +
    '<div class="grip">' + icon('grip') + '</div>' +
    '<input class="cell-in" value="' + esc(s.name) + '" aria-label="Step name"' + (canEdit ? '' : ' disabled') + '>' +
    roleSelHTML(s.role) + offsetHTML(Math.abs(Number(s.off) || 0) * (signed > 0 ? -1 : 1)) + '<div>' + flag + '</div>' +
    (canEdit
      ? '<button class="rowdel" title="Remove step — staged until Save" ' + act('tplRowDel') + '>' + icon('trash') + '</button>'
      : '<span></span>') + '</div>';
}
function tplEditor(type, projects) {
  var rec = tplByType(type);
  var t = (rec && rec.def) || typeDef(type);
  var anchor = t.anchor || 'Event';
  var steps = (rec && rec.steps) || {};
  var meta = (rec && rec.meta) || {};
  var nSteps = (t.lanes || []).reduce(function (a, l) { return a + ((steps[l.key]) || []).length; }, 0);
  var used = tplFolderCount(projects, type);
  var canEdit = canEditTemplates();
  var lanesHTML = (t.lanes || []).map(function (l) {
    var laneSteps = steps[l.key] || [];
    var rows = laneSteps.map(tplRowHTML).join('') ||
      '<div class="grid-row" style="grid-template-columns:1fr"><span class="lane-empty">no steps' + (canEdit ? ' — add one below' : '') + '</span></div>';
    return '<div class="lane-edit" data-lane="' + esc(l.key) + '"><div class="leh"><span class="ld" style="background:' + esc(l.color) + '"></span><b>' + esc(l.label) + '</b><span class="cnt">' + laneSteps.length + ' steps</span></div>' +
      '<div class="grid-head"><span></span><span>Step</span><span>Owner role</span><span>Offset</span><span>Flag</span><span></span></div>' + rows +
      (canEdit
        ? '<button class="addstep" ' + act('tplAddStep', null, l.key) + '>' + icon('plus') + 'Add step to ' + esc(l.label) + '</button>'
        : '') + '</div>';
  }).join('');

  /* versions: every template row of this type, live-marked, deletable.
     A server fact — the demo says so instead of inventing a history. */
  var versions = TPL_CACHE.versions[type] || [];
  /* live = oldest id, the server's own seed-pick rule; the sorted list's head */
  var liveId = versions.length ? versions[0].id : (meta.id || null);
  var versionsHTML = '';
  if (api.isDemo()) {
    versionsHTML = '<div class="perm-note" style="margin-top:14px">' + inlineIcon('layers') +
      ' Versions live on the server — the demo has only its built-in config, and Save rewrites it in this tab only.</div>';
  } else if (versions.length) {
    versionsHTML = '<div class="panel" style="margin-top:16px"><h3>Versions of the ' + esc(t.label) + ' SOP · ' + versions.length + '</h3>' +
      versions.map(function (v) {
        var isLive = v.id === liveId;
        return '<div class="set-row"><span class="k" style="text-transform:none;letter-spacing:0">' + esc(v.name) + '</span>' +
          '<span class="v" style="display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap">' +
          '<span class="mini">' + v.steps + ' steps · ' + esc(fmtDate(String(v.created_at || '').slice(0, 10))) + '</span>' +
          (isLive ? '<span class="pill go"><span class="dot"></span>live — seeds new shows</span>' : '<span class="pill idle">banked</span>') +
          (canEdit ? '<button class="btn sm ghost" ' + act('tplDelete', v.id, type) + '>' + icon('trash') + 'Delete</button>' : '') +
          '</span></div>';
      }).join('') +
      '<div class="perm-note">' + inlineIcon('bolt') + ' The OLDEST version is the live SOP — it is what New Event and Seed pipeline copy from. Deleting it promotes the next one; instantiation copies rows, so shows already seeded keep their steps either way.</div></div>';
  }

  return '<div class="ed-head"><div class="et"><div class="ti" style="width:36px;height:36px;border-radius:9px;background:var(--surface-3);display:grid;place-items:center;color:var(--accent)">' + icon(t.icon) + '</div>' +
    '<div><h2>' + esc(t.label) + ' template</h2><div class="sub" style="color:var(--muted);font-size:12.5px;margin-top:2px">' + typeTag(type) + ' &nbsp; ' + (t.lanes || []).length + ' lanes · ' + nSteps + ' steps · anchored to <b style="color:var(--text-2)">' + esc(anchor) + '</b> · used by ' + used + ' folder' + (used === 1 ? '' : 's') +
    (meta.name ? ' · <b style="color:var(--text-2)">' + esc(meta.name) + '</b>' : '') + '</div></div></div>' +
    (canEdit
      ? '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
        '<button class="btn ghost" ' + act('tplBank', null, type) + ' title="POST a snapshot copy of this grid as a banked version — the live SOP is untouched">' + icon('layers') + 'Bank a copy</button>' +
        '<button class="btn primary" ' + act('tplSave', null, type) + '>' + icon('check') + 'Save template</button></div>'
      : '<div class="perm-note" style="margin:0">' + inlineIcon('lock') + ' The SOP is manager+ to change — the grid is readable by everyone.</div>') +
    '</div>' +
    '<div class="hint" style="margin:0 0 16px">' + icon('bolt') + 'Offsets are <b>T-minus days from ' + esc(anchor) + '</b>. Edit names and offsets inline, remove or add rows — nothing is written until <b>Save</b> commits the whole grid' + (canEdit ? '' : '') + '. Every show seeded from this template after a save inherits the change; shows already seeded keep their steps.</div>' +
    lanesHTML +
    (canEdit
      ? '<button class="addlane" ' + toastAttrs('Lanes are the event type’s config',
          'A lane set belongs to the TYPE (EVENT_TYPES + lanes), not to one template — adding a lane is a config change, and this wave did not build that editor. The rows above are real; this button is honest about not being.') + '>' +
        icon('plus') + 'Add lane to ' + esc(t.label) + '</button>'
      : '') +
    versionsHTML;
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
        row('Password', CURRENT_USER.must_change
          ? '<span style="color:var(--warn)">temporary — change it</span>'
          : '<span style="color:var(--go)">yours</span>') +
        '<div class="set-row"><span class="k">Session</span><span class="v" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">' +
        '<button class="btn sm ghost" ' + act('changePw') + '>' + icon('lock') + 'Change password</button>' +
        '<button class="btn sm ghost" ' + act('logout') + '>' + icon('lock') + 'Sign out</button>' +
        '</span></div>')) +
    /* ══ AGENT_API §1 · API KEYS — the agent roadmap's front door ═══════════
       The routes (self-or-admin list, show-once mint, revoke-not-delete) sat
       finished with no card. Self-scoped like the session card: these are YOUR
       keys, acting as you. */
    card('bolt', 'API keys · your agent', (function () {
      if (demo) {
        return '<p>A key lets <b>your agent</b> — the M365 watcher, a script, an MCP server — act as you ' +
          'against the live API. It inherits your role on every request and is shown exactly once at mint.</p>' +
          row('Keys', '<span style="color:var(--warn)">demo — no credential store</span>') +
          '<div class="perm-note" style="margin-top:10px">' + inlineIcon('lock') +
          ' A key is a real credential, so the demo will not pretend at one. Sign in against the live ' +
          'server to mint yours.</div>';
      }
      var keys = ctx.keys || [];
      var rows2 = keys.map(function (k) {
        var revoked = !!k.revoked_at;
        return '<div class="set-row"><span class="k mono" style="text-transform:none;letter-spacing:0">' +
          esc(k.key_prefix) + '…</span>' +
          '<span class="v" style="display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap">' +
          (k.label ? '<span style="color:var(--text-2);font-size:12px">' + esc(k.label) + '</span>' : '') +
          (revoked
            ? '<span class="pill idle">revoked ' + esc(fmtDate(String(k.revoked_at).slice(0, 10))) + '</span>'
            : '<span class="pill go"><span class="dot"></span>active</span>' +
              '<button class="btn sm ghost" ' + act('keyRevoke', k.id) + '>' + icon('x') + 'Revoke</button>') +
          '</span></div>';
      }).join('') || '<div class="empty" style="padding:12px">No keys yet — mint one for your agent.</div>';
      return '<p>A key lets <b>your agent</b> act as you: it inherits your role live on every request, so a ' +
        'role change changes its powers immediately, and it can never escalate itself.</p>' + rows2 +
        '<div class="set-row"><span class="k">Mint</span><span class="v">' +
        '<button class="btn sm ghost" ' + act('keyMint') + '>' + icon('plus') + 'New key</button></span></div>' +
        '<div class="perm-note" style="margin-top:10px">' + inlineIcon('lock') +
        ' Shown <b>once</b> at mint; the server keeps a hash. Keys are <b>revoked, never deleted</b> — a ' +
        'credential’s history is part of the record.</div>';
    })()) +
    card('gear', 'Workspace', '<p>e360 Sport control-room workspace.</p>' + row('Organization', 'E360 Sport') + row('Members', activeUsers().length) + row('Event types', Object.keys(EVENT_TYPES).length) +
      '<div class="set-row"><span class="k">Theme</span><span class="switch' + (isLight ? '' : ' on') + '" id="setTheme" ' + act('toggleTheme') + '><i></i></span></div>') +
    /* ══ 36 · THE NAS CARD READS THE PROBE ══════════════════════════════════
       This card printed a hardcoded green "reachable" through the whole day
       the NAS could not be reached at all — the exact false comfort
       /api/health's own comments warn about. Now it renders what the probe
       actually knows: config, and the last time this process really talked to
       the store. The demo says "modeled", because a fictional NAS does not
       get a live status. */
    card('server', 'E360 NAS', (function () {
      var h = ctx.health || null;
      if (demo || !h) {
        return '<p>Source files + heavy binaries. The DB stores a path + cached render; bytes stream ' +
          'through the app.</p>' +
          row('Mount', '\\\\e360-nas\\showrunner') +
          row('Status', demo
            ? '<span style="color:var(--warn)">modeled — no live probe in demo</span>'
            : '<span style="color:var(--crit)">health probe did not answer</span>') +
          row('Convention', 'P{id}-{slug}\\S{id}-{slug}\\{kind}');
      }
      var status;
      if (!h.storageReady) {
        status = '<span style="color:var(--warn)">not configured — uploads register metadata only</span>';
      } else if (h.storageError) {
        status = '<span style="color:var(--crit)">' + esc(String(h.storageError).slice(0, 80)) + '</span>';
      } else if (h.storageLastContact && h.storageLastContact.ok) {
        status = '<span style="color:var(--go)">answered ' + esc(fmtAgo(h.storageLastContact.at)) + ' ago</span>';
      } else if (h.storageLastContact) {
        status = '<span style="color:var(--crit)">did NOT answer ' + esc(fmtAgo(h.storageLastContact.at)) + ' ago</span>';
      } else {
        /* config says ready; no byte has moved this boot — say exactly that,
           never upgrade config into evidence (the 2026-08-28 lesson) */
        status = '<span style="color:var(--warn)">configured — no contact yet this boot</span>';
      }
      return '<p>Source files + heavy binaries. The DB stores a path; bytes stream through the app. ' +
        '<b>Status is measured</b>: config from the env, liveness from the last real byte moved.</p>' +
        row('Driver', esc(h.storage || '—')) +
        row('Target', '<span class="mono" style="font-size:11px;word-break:break-all">' + esc(h.storageTarget || h.nasRoot || '—') + '</span>') +
        row('Status', status) +
        (h.storageLiveness
          ? row('Liveness', '<span style="font-size:11px;color:var(--muted)">' + esc(String(h.storageLiveness).slice(0, 120)) + '</span>') : '') +
        (h.storageEphemeralRisk
          ? row('Risk', '<span style="color:var(--crit)">ephemeral disk — bytes die with the deploy</span>') : '');
    })()) +
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
        '<div class="perm-note" style="margin-top:10px">' + inlineIcon('lock') + ' Over ' + esc(fmtMoney(PO_APPROVAL_THRESHOLD)) + ', approval sits with the admins — <b>Tom, Tony, Jim</b> — plus <b>Candice</b> via her finance capability. Tom’s confirmed rule.</div>';
    })()) +
    /* ══ F3 · NOTIFICATIONS — the user's own card ═══════════════════════════
       Tony's rule made a setting. The BELL is not on this card and never will
       be: the actor already chose to notify you, and you always see it in the
       app. What is adjustable is the SECOND channel — whether that same event
       also reaches your inbox, and how fast. */
    card('bell', 'Notifications', (function () {
      var prefs = ctx.notifyPrefs || notifyPrefsFor(ME);
      var mail = ctx.mail || { driver: MAIL_DRIVER, configured: MAIL_CONFIGURED,
                               queued: notifyQueuedCount(ME) };
      var kinds = ['assignment', 'mention', 'notify', 'report_nag'];
      var rows2 = kinds.map(function (k) {
        var cur = prefs[k] || NOTIFY_DEFAULT_MODE[k];
        var seg = NOTIFY_MODES.map(function (m) {
          return '<button class="' + (cur === m ? 'on' : '') + '" ' + act('notifPref', null, k + ':' + m) +
            ' title="' + esc(m === 'off'
              ? 'Bell only — it still reaches you in the app, it just does not leave the building.'
              : m === 'immediate' ? 'As it happens.' : 'Batched into a digest.') + '">' +
            esc(NOTIFY_MODE_LABEL[m]) + '</button>';
        }).join('');
        return '<div class="set-row notif-row"><span class="k">' + esc(NOTIFY_KIND_LABEL[k]) + '</span>' +
          '<span class="v"><span class="seg sm">' + seg + '</span></span></div>';
      }).join('');
      var q = mail.queued || 0;
      return '<p>Every notification reaches you in the <b>bell</b> — that never changes and cannot be ' +
        'switched off here. These control the <b>second channel</b>: whether the same event also lands ' +
        'in your inbox, and how quickly.</p>' + rows2 +
        row('Delivery', mail.configured
          ? '<span style="color:var(--go)">' + esc(mail.driver) + '</span>' +
            (mail.driver === 'log' ? ' <small style="color:var(--muted)">recorded, not mailed</small>' : '')
          : '<span style="color:var(--warn)">not configured — items stay queued</span>') +
        row('Waiting for you', q ? '<span style="color:var(--warn)">' + q + ' queued</span>'
                                 : '<span style="color:var(--go)">nothing queued</span>') +
        '<div class="set-row"><span class="k">Your queue</span><span class="v">' +
        '<button class="btn sm ghost" ' + act('openOutbox') + '>' + icon('mail') + 'See what was sent</button>' +
        '</span></div>' +
        '<div class="perm-note" style="margin-top:10px">' + inlineIcon('bolt') +
        ' Defaults are assignments and @mentions right away, everything else digested. ' +
        '<b>Bell only</b> silences the email, never the app. A message you already read in-app is ' +
        'skipped rather than mailed. There is no scheduler here yet, so digests flush when someone ' +
        'asks — an honest gap, not a hidden cron.</div>';
    })()) +
    /* ══ F6 · the operator's card — the sweep and the archive ══════════════ */
    (CURRENT_USER.role === 'admin' ? card('box', 'Archive &amp; the sweep', (function () {
      /* the counts come from the caller when there is a server to ask (the
         route hands them in); the local computation is the demo's own answer */
      var arch = ctx.archivedCount != null ? ctx.archivedCount : archivedProjects().length;
      var owed = ctx.owedReports != null ? ctx.owedReports
        : TECH_REPORTS.filter(function (r) { return r.status === 'owed'; }).length;
      return '<p>Closeout is machine-checked: <b>recap sent</b> + <b>every show report filed</b> + ' +
        '<b>no money waiting on paperwork</b>. ' + ARCHIVE_AFTER_DAYS + ' days after all three hold, ' +
        'the folder leaves the working set.</p>' +
        row('Archived folders', String(arch)) +
        row('Show reports outstanding', owed
          ? '<span style="color:var(--warn)">' + owed + '</span>' : '<span style="color:var(--go)">none</span>') +
        row('Auto-archive after', ARCHIVE_AFTER_DAYS + ' days') +
        '<div class="set-row"><span class="k">Run it now</span><span class="v">' +
        '<button class="btn sm ghost" ' + act('runSweep') + '>' + icon('refresh') + 'Sweep</button>' +
        '</span></div>' +
        '<div class="perm-note" style="margin-top:10px">' + inlineIcon('alert') +
        ' <b>There is no scheduler.</b> The sweep runs once on boot and whenever an admin asks — it ' +
        'strikes overdue shows, creates and re-sends the reports their crews owe, re-checks every ' +
        'closeout, archives what is ripe and flushes the queue. It is idempotent, so running it twice ' +
        'costs nothing. A real daily job needs Railway cron or the per-user agents.</div>';
    })()) : '') +
    card('users', 'Roles &amp; access', '<p>Five canonical roles gate edit + assignment rights across the workspace.</p>' + row('Roles', 'admin · manager · pm · tech · viewer') + row('Default', 'viewer')) +
    '</div>';
}

/* ============================================================================
   F3 · THE OUTBOX — "what was actually sent, and what wasn't"
   ----------------------------------------------------------------------------
   A notification you cannot audit is a notification you cannot trust. Every row
   says which channel, which preference applied, and — when it did NOT go out —
   why: read in-app first, preference off, no address, or still queued because
   the mail layer is not configured yet. That last one is the honest one: the
   item is not lost, it is waiting.
   ========================================================================== */
function viewOutbox(rows) {
  var list = (rows || []).map(function (n) {
    var m = NOTIFY_STATUS_META[n.status] || NOTIFY_STATUS_META.queued;
    var why = n.status === 'skipped' ? n.skipped_reason
      : n.status === 'failed' ? n.last_error
      : n.status === 'queued' ? (n.mode === 'digest' ? 'in your digest — flushes when a scheduler exists'
                                                      : 'waiting for the next flush')
      : (n.driver === 'log' ? 'recorded in the activity trail' : 'delivered by ' + (n.driver || 'mail'));
    return '<tr' + (n.show_id ? ' class="rowlink" ' + act('openShow', n.show_id) : '') + '>' +
      '<td><b style="font-weight:600">' + esc(n.subject) + '</b>' +
      '<div class="mini" style="margin-top:2px">' + esc(String(n.body || '').slice(0, 110)) + '</div></td>' +
      '<td><span class="tag">' + esc(NOTIFY_KIND_LABEL[n.kind] || n.kind) + '</span></td>' +
      '<td><span class="mini">' + esc(NOTIFY_MODE_LABEL[n.mode] || n.mode) + '</span></td>' +
      '<td><span class="pill ' + esc(m.pill) + '"><span class="dot"></span>' + esc(m.label) + '</span>' +
      '<div class="mini" style="margin-top:3px">' + esc(why || '') + '</div></td>' +
      '<td class="mono" style="font-size:12px">' + esc(fmtDate(String(n.queued_at || '').slice(0, 10))) + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="5"><div class="empty">Nothing has been queued for you.</div></td></tr>';

  return '<div class="page-h"><div><h1>My notifications</h1><div class="sub">The second channel, audited. ' +
    'Everything here also reached you in the bell — this is the record of what left the building, what ' +
    'was deliberately skipped, and what is still waiting.</div></div>' +
    '<button class="btn ghost" ' + act('gotoTab', null, 'settings') + '>' + icon('gear') + 'Notification settings</button></div>' +
    '<div class="card"><div class="card-h"><h3>Outbox</h3><span class="pill idle">newest first</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Message</th><th>Kind</th><th>Preference</th>' +
    '<th>Outcome</th><th>Queued</th></tr></thead><tbody>' + list + '</tbody></table></div></div>' +
    '<div class="hint">' + icon('lock') + '<span>Yours alone — nobody else can read your queue. ' +
    '<b>Skipped</b> is a deliberate outcome, not a failure: a message you had already read in the app ' +
    'is not mailed to you afterwards.</span></div>';
}

/* ============================================================================
   MULTIMEDIA VIEWER — bind a spec/proof to a show -> view + print.
   Navigates by FILE ID (not array index) so mutations can't shift the target.
   ========================================================================== */
/* `max` is the full-width toggle: it drops the file strip and the meta panel and
   gives the whole row to the document. It is deliberately a VIEW preference and
   not a per-file one — it survives paging, because somebody who wanted the big
   window for page 1 wants it for page 2. */
var VIEWER = { showId: null, fileId: null, max: false };
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
  /* THE HEADER IS CHROME AND THE DOCUMENT IS THE POINT.
     This used to be a full page-h: a 26px title over a two-line paragraph
     explaining the viewer to somebody already standing in it, costing ~95px of
     the exact vertical space a portrait PDF page needs. One compact line now,
     and .v-head fixes its height so `--viewer-chrome` below can be a number
     rather than a guess. */
  return '<div class="page-h v-head"><div><h1>Multimedia Viewer</h1>' +
    '<div class="sub">' + esc(title) + ' · ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '</div></div>' +
    '<button class="btn ghost" ' + act('openShow', show.id) + '>' + icon('folder') + 'Back to folder</button></div>' +
    '<div class="viewer-shell' + (VIEWER.max ? ' max' : '') + '" id="vShell">' +
    '<div class="vstrip"><div class="vsh"><b>' + esc(title) + '</b><span class="n">' + files.length + '</span></div>' + strip + '</div>' +
    '<div class="stage" id="vStage"></div>' +
    '<div class="vmeta" id="vMeta"></div>' +
    '</div>' +
    /* BELOW THE FOLD, on purpose. When the document itself is on the stage the
       white record sheet is reference material, not the main event — it was
       stealing half the height from the thing Tom came to read. It keeps its
       own mount so printFile() and the no-preview path are untouched. */
    '<div class="vrecord" id="vRecord"></div>';
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
  /* EVERY navigation path lands here — openViewer -> render, vSet from the
     strip, vGo from the arrows and the keyboard. So this is the one place the
     previous file's object URL can be released, and one flip cannot leak. */
  vPrevRelease();
  var isPhoto = f.kind === 'photo';
  var prevKind = filePreviewKind(f);
  var hasBytes = fileHasBytes(f);
  var nav = viewerNavList(show), ni = 0;
  nav.forEach(function (x, k) { if (x.id === f.id) ni = k; });
  document.querySelectorAll('.vfile').forEach(function (b, bi) { b.classList.toggle('on', bi === i); });
  var stitle = isPhoto
    ? '<b>' + esc(f.caption || f.name) + '</b><span>.' + esc(f.ext) + ' · ' + esc(fmtTs(f.taken_at)) + ' · ' + esc(f.dim) + '</span>'
    : '<b>' + esc(f.name) + '</b><span>.' + esc(f.ext) + ' · ' + esc(f.ver) + ' · ' + esc(f.dim) + '</span>';
  /* THE STAGE IS THE DOCUMENT.
     v1 of this pass stacked the preview ON TOP OF the white record sheet inside
     a scrolling canvas, which is how Tom ended up at 40% zoom panning around a
     spec sheet: two full-size things were splitting one column. Now, whenever
     there are bytes to show, the canvas holds the document and NOTHING else,
     and the record sheet moves to #vRecord below the fold. A photo is the one
     exception — photoSheet() puts #vPrev inside its own gallery frame, so it
     must not be given a second one. */
  var live = !!prevKind;
  var sheet = sheetHTML(show, f, show.gear);
  $('#vStage').innerHTML = '<div class="stage-bar"><div class="stitle">' + stitle + '</div>' +
    '<div class="pagenav"><button class="iconbtn" title="Previous" ' + act('vGo', -1) + '>' + icon('chevL') + '</button>' +
    '<span class="mono" style="font-size:11px;color:var(--muted);padding:0 6px">' + (ni + 1) + ' / ' + nav.length + (isPhoto ? ' photos' : '') + '</span>' +
    '<button class="iconbtn" title="Next" ' + act('vGo', 1) + '>' + icon('chevR') + '</button></div>' +
    (live ? '<button class="iconbtn" title="' + (VIEWER.max ? 'Exit full width' : 'Full width') + '" ' +
      act('vMax') + '>' + icon(VIEWER.max ? 'collapse' : 'expand') + '</button>' : '') +
    '<button class="btn sm primary" ' + act('printFile') + '>' + icon('print') + 'Print</button></div>' +
    '<div class="stage-canvas' + (live && !isPhoto ? ' doc' : '') + '">' +
      (live && !isPhoto ? '<div class="vprev" id="vPrev">' + previewLoadingHTML() + '</div>' : sheet) +
    '</div>';
  /* The record, demoted. It is still rendered — it is the file's own facts and
     the print path draws the same sheet — just no longer competing with the
     document for the fold. Cleared, never left stale, when the stage owns it. */
  var rec = $('#vRecord');
  if (rec) {
    rec.innerHTML = (live && !isPhoto)
      ? '<div class="vrec-h">' + icon('file') + '<b>Document record</b>' +
        '<span>the file’s own metadata — the document itself is above</span></div>' + sheet
      : '';
  }
  if (live) drawPreview(f, prevKind);

  var title = show.project.single ? show.project.name : show.name;
  if (isPhoto) { drawPhotoMeta(show, f, title, hasBytes); return; }
  /* financial docs carry money metadata + (for proposals) the review actions */
  var isFin = !!FIN_KINDS[f.kind];
  var finJob = isFin ? JOBS_BY_ID[fileJobId(f)] : null;
  var finRows = isFin
    ? metaRow('Vendor', f.vendor || '—') + metaRow('Amount', fmtMoney(f.amount)) +
      metaRow('Doc date', fmtDateFull(f.doc_date || f.created_at)) +
      metaRow('Billed to', finJob ? finJob.qb_job_number + (finJob.deal_type ? ' · ' + finJob.deal_type : '') : '—') +
      metaRow('Status', f.status === 'proposed' ? 'Proposed — awaiting review' : 'Filed') +
      metaRow('Filed by', f.provenance ? actorLabel(null, f.provenance) + ' · ' + Math.round(f.provenance.confidence) + '%' : uploaderName(f))
    : '';
  /* E5. This used to be `isFin && f.status === 'proposed'`, so a proposed
     transcript, spec, contract, recording or report had confirm/reject nowhere
     except the one bell row — which was itself broken and capped at 8. The
     financial-ness of a document decides what METADATA it shows, never whether
     a human may act on it. */
  var reviewActs = f.status === 'proposed'
    ? '<button class="btn primary" ' + act('confirmDoc', f.id) + '>' + icon('check') + 'Confirm — file it</button>' +
      '<button class="btn ghost" ' + act('rejectDoc', f.id) + '>' + icon('x') + 'Reject proposal</button>'
    : '';
  $('#vMeta').innerHTML = '<div class="mh"><b>File details</b></div>' +
    '<div class="bound"><div class="bi">' + icon('pin') + '</div><div class="bt"><span>Bound to</span><b>' + esc(title) + '</b></div></div>' +
    /* the byteless truth, ABOVE the metadata it qualifies — this panel is the
       screen that finally told Brendon, and now it says so before the rows
       instead of leaving a download error to break the news */
    (fileIsByteless(f) ? '<div style="margin:2px 0 10px">' + fileBytelessFlag(f) + '</div>' : '') +
    metaRow('Type', fileTypeLabel(f, show)) +
    finRows +
    metaRow('Version', f.ver) + metaRow('Size', fmtSize(f.size)) + metaRow('Dimensions', f.dim) +
    (isFin ? '' : metaRow('Uploaded by', uploaderName(f))) + metaRow('Uploaded', fmtDateFull(f.created_at)) +
    (!isFin && show.job ? metaRow('Job', show.job.qb_job_number) : '') +
    '<div class="acts">' + reviewActs + '<button class="btn primary" ' + act('printFile') + '>' + icon('print') + 'Print this file</button>' +
    /* The two byte affordances, spelled out. They appear for ANY row with real
       bytes — including the .xlsx and .dwg the browser cannot preview, which is
       precisely when a person needs them most. */
    (hasBytes ? '<button class="btn" ' + act('vOpenTab', f.id) + '>' + icon('link') + 'Open in new tab</button>' : '') +
    /* the recovery, where the flag is: re-run the byte half of the two-tier
       upload onto THIS row — same gate as the original attach */
    (fileIsByteless(f) && canDeleteFile(f, show)
      ? '<button class="btn" ' + act('uploadMissingBytes', f.id) + '>' + icon('upload') +
        'Upload the missing document</button>'
      : '') +
    '<button class="btn" ' + act('downloadFile', f.id) + '>' + icon('download') + 'Download</button>' +
    /* THE DELETE, where a person is already looking at the thing they want
       gone. The viewer is the screen that TOLD Brendon the bytes were missing,
       and until now it was also the screen with no way to act on that. Offered
       to the uploader or to pm+/manager on the folder (canDeleteFile — the
       mirror of the route's gate); it takes a plain confirm on the way out. */
    /* 27. THE RENAME, beside the delete, for the same people. PUT /files/:id
       has taken name + kind since the wiring pass ("canEditProject OR the
       uploader" — canDeleteFile's exact predicate); no list anywhere offered
       it, so a typo'd name or a receipt filed as "other" was permanent. */
    (canDeleteFile(f, show) ? '<button class="btn" ' + act('editFile', f.id) + '>' +
      icon('pencil') + 'Rename / re-kind</button>' : '') +
    (canDeleteFile(f, show) ? '<button class="btn danger" ' + act('deleteFile', f.id) + '>' +
      icon('trash') + 'Delete file</button>' : '') +
    '<button class="btn ghost" ' + toastAttrs('Bound', 'Spec re-bound to ' + title) + '>' + icon('link') + 'Re-bind to folder</button></div>' +
    '<div class="note-meta-lock">' + icon('lock') + '<span>Bound to ' + esc(title) + ' — ' + esc(show.venue) + '. Anyone with folder access can view and print; the approved version stays locked.</span></div>' +
    /* the file's anchored thread (notes pass) — agents read it when filing */
    '<div class="vnotes"><div class="vh">Notes' + (noteCount('file', f.id) ? ' · ' + noteCount('file', f.id) : '') + '</div>' +
    notesThread('file', f.id) + '</div>';
}

/* ---- photo meta panel (photo pass): taken/shot-by/tags · inline caption
   edit (pm+ or the uploader) · NAS path · provenance · confirm/reject on
   proposals · the recap-pick toggle. Notes thread mounts exactly as for docs. */
function drawPhotoMeta(show, f, title, hasBytes) {
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
  /* tags were read-only chips while PUT /photos/:id accepted `tags` all along
     (caption + tags are its WHOLE whitelist). Same predicate as the caption:
     curation is pm+ or the person who shot it. The × removes one chip; the +
     prompt adds one — each write sends the full corrected array, which is what
     the route replaces. */
  var tagChips = (f.tags || []).map(function (t) {
    return '<span class="tag">' + esc(t) +
      (canCap ? '<button class="n-act" style="padding:0 0 0 4px;min-width:0" title="Remove tag" ' +
        act('phTagDel', f.id, t) + '>×</button>' : '') + '</span>';
  }).join('');
  var tagRow = (tagChips || canCap)
    ? '<div class="ph-tagrow">' + tagChips +
      (canCap ? '<button class="n-act" title="Add a tag" ' + act('phTagAdd', f.id) + '>' +
        inlineIcon('plus') + 'tag</button>' : '') + '</div>'
    : '';
  var rows = metaRow('Type', 'Event photo') +
    metaRow('Taken', fmtTs(f.taken_at)) +
    metaRow('Shot by', f.shot_by ? userName(f.shot_by) : '—') +
    metaRow('Dimensions', (f.width && f.height) ? f.width + ' × ' + f.height + ' px' : f.dim) +
    metaRow('Size', fmtSize(f.size)) +
    metaRow('Filed by', f.provenance ? actorLabel(null, f.provenance) + ' · ' + Math.round(f.provenance.confidence) + '%' : uploaderName(f)) +
    metaRow('Status', f.status === 'proposed' ? 'Proposed — awaiting review' : 'Filed' + (f.recap_pick ? ' · recap pick' : ''));
  var acts = [];
  if (f.status === 'proposed') {
    acts.push('<button class="btn primary" ' + act('photoConfirm', f.id) + '>' + icon('check') + 'Confirm — file it</button>');
    acts.push('<button class="btn ghost" ' + act('photoReject', f.id) + '>' + icon('x') + 'Reject proposal</button>');
  } else if (PH_EDIT_ROLES[CURRENT_USER.role]) {
    acts.push('<button class="btn ' + (f.recap_pick ? '' : 'primary') + '" ' + act('photoPick', f.id) + '>' + icon('star') +
      (f.recap_pick ? 'Recap pick — remove' : 'Star for the recap') + '</button>');
  }
  if (hasBytes) acts.push('<button class="btn" ' + act('vOpenTab', f.id) + '>' + icon('link') + 'Open in new tab</button>');
  /* same byteless recovery as documents — a photo is a files row like any other */
  if (fileIsByteless(f) && canDeleteFile(f, show)) {
    acts.push('<button class="btn" ' + act('uploadMissingBytes', f.id) + '>' + icon('upload') +
      'Upload the missing document</button>');
  }
  acts.push('<button class="btn" ' + act('downloadFile', f.id) + '>' + icon('download') + 'Download original</button>');
  /* A photo is a `files` row like any other and gets the same retraction — the
     wrong frame lands in a show's gallery exactly as often as the wrong PDF
     lands in its financials. Same predicate, same confirm, same route. */
  if (canDeleteFile(f, show)) {
    acts.push('<button class="btn danger" ' + act('deleteFile', f.id) + '>' + icon('trash') + 'Delete photo</button>');
  }
  var provNote = f.provenance
    ? 'Organized by ' + actorLabel(null, f.provenance) + ' from ' + (f.provenance.source_label || 'a camera-roll sync') +
      ' — proposals ride the same review flow as documents.'
    /* Two different sentences because they are two different facts. With bytes
       on the NAS the frame above IS the photograph; without them the record is
       metadata and a generated placeholder, and saying "a thumbnail" over a
       real photo would be the same small lie in the other direction. */
    : 'Uploaded by ' + uploaderName(f) + '. ' + (hasBytes
        ? 'The frame above is the original, streamed from the NAS through the app.'
        : 'The original lives on the NAS; the record here is metadata + a thumbnail.');
  $('#vMeta').innerHTML = '<div class="mh"><b>Photo details</b></div>' +
    '<div class="bound"><div class="bi">' + icon('cam') + '</div><div class="bt"><span>Tagged to</span><b>' + esc(title) + '</b></div></div>' +
    (fileIsByteless(f) ? '<div style="margin:2px 0 10px">' + fileBytelessFlag(f) + '</div>' : '') +
    capBlock + tagRow + rows +
    '<div class="ph-nas">' + icon('server') + '<span>' + esc(f.nas_path || '') + '</span></div>' +
    '<div class="acts">' + acts.join('') + '</div>' +
    '<div class="note-meta-lock">' + icon(f.provenance ? 'bolt' : 'lock') + '<span>' + esc(provNote) + '</span></div>' +
    '<div class="vnotes"><div class="vh">Notes' + (noteCount('file', f.id) ? ' · ' + noteCount('file', f.id) : '') + '</div>' +
    notesThread('file', f.id) + '</div>';
}

/* ============================================================================
   THE INLINE PREVIEW — the bytes, on the stage  (2026-08-28)
   ----------------------------------------------------------------------------
   Tom uploaded a real PDF to Show 1, opened it in the viewer, and got the
   honest metadata card and nothing else — while GET /api/files/:id/content was
   already serving those bytes. The card was not wrong; it was alone, and alone
   it reads as "there is no way to see this from here."

   Why it cannot be a plain <embed src="/api/files/1/content">: this app
   authenticates with an `x-auth-token` HEADER, not a cookie (SR.bytes(), see
   api.js). A naive iframe/embed src arrives unauthenticated and comes back
   401 — a blank grey frame with no explanation, which is worse than the card.
   So the bytes are FETCHED with the session in hand and handed to the browser
   as an object URL, exactly as downloadFile() already does.

   ONE object URL is alive at a time. VPREV holds it, drawViewer() releases it
   before every navigation, and renderView() releases it on the way out of the
   viewer, so paging fourteen photos does not strand fourteen blobs.
   ========================================================================== */
var VPREV = { gen: 0, url: null, blob: null, fileId: null };

/* Release whatever the stage is currently holding. Safe to call when it holds
   nothing, and it BUMPS the generation — so a fetch still in flight for the
   file we just left resolves into a stale check and drops its result instead
   of drawing over the new one. */
function vPrevRelease() {
  VPREV.gen += 1;
  if (VPREV.url) { try { URL.revokeObjectURL(VPREV.url); } catch (_) {} }
  VPREV.url = null; VPREV.blob = null; VPREV.fileId = null;
}

/* Paint the transfer. Determinate when the server told us how big the file is,
   indeterminate when it did not — the `sweep` class IS the difference, and it
   is removed the moment a real denominator arrives. Writes straight to the two
   nodes rather than re-rendering the block, so the spinner does not restart on
   every chunk. */
function vPrevProgress(loaded, total) {
  var bar = $('#vPrevBar'), note = $('#vPrevNote');
  if (bar && bar.firstChild) {
    if (total > 0) {
      var pct = Math.max(2, Math.min(100, Math.round((loaded / total) * 100)));
      bar.firstChild.className = '';
      bar.firstChild.style.width = pct + '%';
    } else {
      bar.firstChild.className = 'sweep';
      bar.firstChild.style.width = '';
    }
  }
  if (note) {
    note.textContent = total > 0
      ? fmtBytes(loaded) + ' of ' + fmtBytes(total)
      : (loaded > 0 ? fmtBytes(loaded) + ' so far' : 'Opening the document');
  }
}

async function drawPreview(f, kind) {
  var gen = VPREV.gen;                       /* the ticket this run holds */
  var host = $('#vPrev');
  if (!host) return;
  var stale = function () { return gen !== VPREV.gen; };
  try {
    /* Ask the deployment before asking the NAS. A server with no storage
       configured answers this from a cached GET /api/config, so the honest
       sentence costs nothing and the pointless 502 never happens. */
    var canStore = await api.uploadsEnabled();
    if (stale()) return;
    if (!canStore) {
      host.innerHTML = previewFailHTML('This server has no NAS storage configured, so nothing can serve the bytes.');
      return;
    }
    /* PERCEIVED SPEED. Three honest seconds felt like twenty dead ones because
       nothing on screen moved. The bar is fed by the real transfer — bytes and
       the server's Content-Length — so it is a measurement, not a placebo, and
       when there is no Content-Length it stays an indeterminate sweep instead
       of inventing a denominator. */
    var blob = await api.downloadFileBytes(f.id, {
      onProgress: function (loaded, total) {
        if (stale()) return;
        vPrevProgress(loaded, total);
      }
    });
    /* Navigated away mid-transfer. Return BEFORE createObjectURL: a URL that
       is never minted is a URL that cannot leak. */
    if (stale()) return;
    var url = URL.createObjectURL(blob);
    VPREV.url = url; VPREV.blob = blob; VPREV.fileId = f.id;
    host.innerHTML = kind === 'img'
      ? '<img class="vprev-img" src="' + esc(url) + '" alt="' + esc(f.caption || f.name || '') + '">'
      /* <embed>, not <iframe>: it is the element browsers hand straight to the
         built-in PDF viewer, and it is not subject to the frame-ancestors and
         sandbox rules a framed document inherits. */
      : '<embed class="vprev-frame" type="application/pdf" src="' + esc(url) + '">';
  } catch (e) {
    if (stale()) return;
    host.innerHTML = previewFailHTML(e && e.message ? e.message : e);
  }
}

/* "Open in new tab". If the stage already holds these bytes the URL is minted
   and the window opened SYNCHRONOUSLY inside the click — which is the only way
   a browser will not treat it as a pop-up. Only a file we have not fetched yet
   pays the async round trip, and if the pop-up blocker eats that one we say so
   rather than leaving a button that appears to do nothing.

   Its object URL is deliberately NOT the stage's: the new tab owns its copy and
   keeps it after the viewer has paged on. It is revoked on a timer, long after
   the tab has finished loading — the same trade downloadFile() makes. */
var VPREV_TAB_MS = 60000;
function viewerFileName(f) {
  return String((f && f.name) || 'file') + (f && f.ext ? '.' + String(f.ext).replace(/^\./, '') : '');
}
function vPrevOpenBlob(blob, f) {
  var url = URL.createObjectURL(blob);
  var w = null;
  /* NOT window.open(url, '_blank', 'noopener'). Per spec, a features string
     carrying `noopener` makes open() return NULL — on success as well as on a
     blocked pop-up — so the two outcomes become indistinguishable and every
     successful open would toast "your browser blocked it". The handle is what
     tells them apart, so it is asked for and then severed by hand. */
  try {
    w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch (_) {} }
  } catch (_) { w = null; }
  setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, VPREV_TAB_MS);
  if (w) toast('Opened in a new tab', viewerFileName(f));
  else toast('Your browser blocked the new tab', 'Allow pop-ups for Showrunner, or use Download.', 'err');
  return !!w;
}
async function vOpenTab(fileId) {
  var f = await api.getFile(fileId);
  if (!f) return;
  if (VPREV.blob && VPREV.fileId === f.id) return vPrevOpenBlob(VPREV.blob, f);
  try {
    var blob = await api.downloadFileBytes(f.id);
    vPrevOpenBlob(blob, f);
  } catch (e) {
    /* the server's own sentence, verbatim — same rule as downloadFile() */
    toast('Could not open ' + viewerFileName(f), String(e && e.message || e), 'err');
  }
}
