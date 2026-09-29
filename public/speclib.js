/* ============================================================================
   e360 SHOWRUNNER — ?spec-library=1  ·  THE SPEC LIBRARY PICKER
   ----------------------------------------------------------------------------
   Tom, 2026-09-29: "We do a lot of similar shows — it's nice to start a new
   spec with an e360 file that has the same layout as a previous show… every
   spec sheet at our fingertips for editing or starting a new one."

   Every Bind to PM Show ALREADY banks the .e360 on the show's NAS folder, so
   the library is a query (GET /api/spec-library) over what the bind wrote, and
   the bytes come from the existing GET /api/files/:id/content. This page is
   the door the Spec Sheet Generator opens in a popup ("LOAD FROM SHOWRUNNER"):

     TOOL                                    THIS PAGE
     ────                                    ─────────
     window.open('/?spec-library=1',
                 'spec-library-<ts>')   ──▶  boot -> specLibBoot()
                                             login gate (session = x-auth-token)
                               ◀────         {type:'spec-library-ready'}
                                             searchable list, operator clicks
                                             GET /api/files/:id/content
                               ◀────         {type:'spec-library-pick', text, name,
                                              fileId, showId, showName, rev}
                                             window.close()
                               ◀────         {type:'spec-library-cancelled'}
                                             (pagehide, only if nothing was picked)

   The tool loads `text` through its own LOAD PROJECT path (JSON.parse ->
   applyProjectData), so a library sheet is simply a loaded sheet.

   SEPARATE FROM THE BIND POPUP (bind.js) ON PURPOSE. Its own URL flag, its own
   screen element, its own message types — it never sends a bind-* message, so
   an open bind session in the same tool cannot mistake this window's death for
   its own (the 9/11 retry-ghost lesson).

   THIS PAGE ACCEPTS NO INBOUND MESSAGE AT ALL — nothing to spoof. What leaves
   it is a spec, so it only ever leaves toward a TRUSTED origin: every outbound
   post names a TOOLS_ORIGINS entry (served by the backend, same allowlist as
   the bind) or this page's own origin as its targetOrigin — never '*'. The
   browser drops a post whose target does not match the real opener, so an
   untrusted site that opens this window receives nothing. No allowlist means
   nothing can be delivered: fail closed, and say so.
   ========================================================================== */

var SPECLIB = {
  origins: [],        /* the served TOOLS_ORIGINS allowlist */
  specs: [],
  loaded: false,
  q: '',
  busy: false,
  done: false,
  cancelled: false,
  wired: false
};

function specLibRequested() {
  try {
    return /[?&]spec-library=1(&|$)/.test(String(location.search || ''));
  } catch (_) { return false; }
}

/* ---- the pure half (the walk executes these) ----------------------------- */
function specLibDate(v) {
  var s = String(v == null ? '' : v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
/* case-insensitive across name / show / folder — the same three the server's
   ?q= reads, so a client-side filter never disagrees with a server-side one */
function specLibFilter(specs, q) {
  var needle = String(q || '').toLowerCase().trim();
  var list = specs || [];
  if (!needle) return list.slice();
  return list.filter(function (s) {
    var hay = [s.name, s.showName, s.projectName].join(' \u0001 ').toLowerCase();
    return hay.indexOf(needle) >= 0;
  });
}
function specLibRowsHTML(specs, q) {
  var all = specs || [];
  if (!all.length) {
    return '<div class="bind-status">' + inlineIcon('grid') +
      '<span><b>No bound specs yet.</b> Every sheet bound with “Bind to PM Show” lands here.</span></div>';
  }
  var rows = specLibFilter(all, q);
  if (!rows.length) {
    return '<div class="bind-status">' + inlineIcon('search') +
      '<span>No bound spec matches “' + esc(q) + '”.</span></div>';
  }
  return rows.map(function (s) {
    var where = [s.projectName, s.showName].filter(Boolean);
    /* a folder and show that share a name are said once */
    if (where.length === 2 && where[0] === where[1]) where = [where[0]];
    var ver = s.rev != null ? 'v' + s.rev : (s.ver || '');
    return '<button class="bind-row" ' + act('specLibPick', s.fileId) + '>' +
      '<span><span class="br-n">' + esc((s.name || 'Untitled spec') + (s.ext || '.e360')) + '</span>' +
      '<span class="br-s">' + esc(where.join(' · ') || 'no show on file') + '</span></span>' +
      '<span class="br-d">' + esc([ver, specLibDate(s.createdAt)].filter(Boolean).join(' · ')) +
      '</span></button>';
  }).join('');
}

/* ---- the shell ----------------------------------------------------------- */
function specLibEl() {
  var el = document.getElementById('specLibScreen');
  if (!el) {
    el = document.createElement('div');
    el.className = 'bind-screen'; el.id = 'specLibScreen';
    document.body.appendChild(el);
  }
  return el;
}
function specLibStatus(kind, html) {
  return '<div class="bind-status ' + kind + '">' + inlineIcon(
    kind === 'crit' ? 'alert' : kind === 'ok' ? 'checkC' : kind === 'warn' ? 'alert' : 'bolt') +
    '<span>' + html + '</span></div>';
}
function specLibPaint(inner) {
  specLibEl().innerHTML = '<div class="bind-wrap">' +
    '<div class="bind-head"><div class="logo">e</div>' +
      '<div><h1>Spec library</h1>' +
      '<div class="sub">Every sheet bound to a Showrunner show — open one to edit it, or to start a new show from its layout</div></div>' +
      '<span class="spec-chip">.e360</span></div>' +
    inner + '</div>';
}
function specLibFail(msg, detail) {
  specLibPaint(specLibStatus('crit', '<b>' + esc(msg) + '</b>') +
    (detail ? '<div class="bind-foot">' + esc(detail) + '</div>' : ''));
}
function specLibPicker(note) {
  specLibPaint((note || '') +
    '<input class="bind-search" id="specLibQ" placeholder="Filter by spec name, show or folder…" autocomplete="off">' +
    '<div class="bind-list" id="specLibList">' + specLibRowsHTML(SPECLIB.specs, SPECLIB.q) + '</div>' +
    '<div class="bind-foot">' + inlineIcon('lock') +
      '<span>' + esc(SPECLIB.specs.length) + ' bound spec' + (SPECLIB.specs.length === 1 ? '' : 's') +
      ' · opening one loads it into the tool; nothing here changes the show it came from.</span></div>');
  var q = document.getElementById('specLibQ');
  if (q) {
    q.value = SPECLIB.q;
    q.oninput = function () {
      SPECLIB.q = q.value;
      var l = document.getElementById('specLibList');
      if (l) l.innerHTML = specLibRowsHTML(SPECLIB.specs, SPECLIB.q);
    };
    try { q.focus(); } catch (_) {}
  }
}

/* ---- postMessage, OUTBOUND ONLY ------------------------------------------ */
function specLibTargets() {
  var t = [];
  (SPECLIB.origins || []).forEach(function (o) {
    if (typeof o === 'string' && o && o !== '*' && t.indexOf(o) < 0) t.push(o);
  });
  try { if (location.origin && t.indexOf(location.origin) < 0) t.push(location.origin); } catch (_) {}
  return t;
}
function specLibPost(msg) {
  if (!window.opener) return false;
  specLibTargets().forEach(function (o) {
    /* a non-matching target is silently dropped by the browser — that drop
       IS the guarantee an untrusted opener gets nothing */
    try { window.opener.postMessage(msg, o); } catch (_) {}
  });
  return true;
}
/* Closing the window without picking IS the cancel gesture. Fires once, never
   after a pick — the pick is the terminal message when there is one. */
function specLibAnnounceCancelled() {
  if (SPECLIB.done || SPECLIB.cancelled) return;
  SPECLIB.cancelled = true;
  specLibPost({ type: 'spec-library-cancelled' });
}

/* ---- the pick ------------------------------------------------------------ */
async function specLibPick(fileId) {
  if (SPECLIB.busy || SPECLIB.done) return;
  var s = null;
  for (var i = 0; i < SPECLIB.specs.length; i++) if (SPECLIB.specs[i].fileId === Number(fileId)) s = SPECLIB.specs[i];
  if (!s) return;
  if (!window.opener) {
    specLibPicker(specLibStatus('warn', 'No spec tool is waiting on this window. ' +
      'Open the library from the Spec Sheet Generator’s <b>LOAD FROM SHOWRUNNER</b> button.'));
    return;
  }
  SPECLIB.busy = true;
  specLibPaint(specLibStatus('', 'Opening <b>' + esc((s.name || 'spec') + (s.ext || '.e360')) + '</b>…'));
  try {
    var blob = await api.downloadFileBytes(s.fileId);
    var text = await blob.text();
    /* the tool validates again with its own loader; this only catches a bad
       file HERE, where the operator can still pick another one */
    var doc = null;
    try { doc = JSON.parse(text); } catch (_) { doc = null; }
    if (!doc || typeof doc !== 'object' || !doc.version) {
      throw new Error('That file is not a readable .e360 sheet.');
    }
    SPECLIB.done = true;
    specLibPost({
      type: 'spec-library-pick',
      text: text,
      name: (s.name || 'spec') + (s.ext || '.e360'),
      fileId: s.fileId, showId: s.showId, showName: s.showName || '', rev: s.rev
    });
    specLibPaint(specLibStatus('ok', 'Sent <b>' + esc((s.name || 'spec') + (s.ext || '.e360')) +
      '</b> to the tool.') + '<div class="bind-foot">' + inlineIcon('check') + 'This window closes on its own.</div>');
    setTimeout(function () { try { window.close(); } catch (_) {} }, 900);
  } catch (e) {
    SPECLIB.busy = false;
    specLibPicker(specLibStatus('crit', '<b>Could not open that spec.</b> ' + esc(String((e && e.message) || e))));
  }
}

/* ---- boot ---------------------------------------------------------------- */
async function specLibBoot() {
  if (api.isDemo()) {
    specLibFail('The spec library needs the live Showrunner server.',
      'This window is running the demo dataset — there are no bound specs to open.');
    return;
  }
  var me = null;
  try { me = await api.currentUser(); } catch (_) { me = null; }
  if (!me) {
    specLibPaint(specLibStatus('', 'Sign in to open the spec library — this window carries your session, the tool never does.'));
    openLogin(null, function () { return specLibBoot(); });
    return;
  }
  closeLogin();
  specLibPaint(specLibStatus('', 'Loading the spec library…'));

  ACTIONS.specLibPick = function (t, id) { return specLibPick(Number(id)); };

  var configured = true;
  try {
    var cfg = await SR.serverConfig();
    SPECLIB.origins = await SR.toolsOrigins();
    configured = (cfg && cfg.features && typeof cfg.features.specBind === 'boolean')
      ? cfg.features.specBind
      : SPECLIB.origins.length > 0;
  } catch (_) { SPECLIB.origins = []; configured = false; }
  if (!configured) {
    specLibFail('The spec library cannot reach the tool from this server.',
      'No TOOLS_ORIGINS allowlist is set, so Showrunner will not hand a spec to any tool window. ' +
      'Ask whoever deploys Showrunner to set TOOLS_ORIGINS to the tool’s origin, then open this window again.');
    return;
  }

  if (!SPECLIB.wired) {
    SPECLIB.wired = true;
    window.addEventListener('pagehide', specLibAnnounceCancelled);
    specLibPost({ type: 'spec-library-ready' });
  }

  try {
    var r = await api.specLibrary();
    SPECLIB.specs = (r && r.specs) || [];
    SPECLIB.loaded = true;
  } catch (e) {
    specLibFail('The spec library could not be read.', String((e && e.message) || e));
    return;
  }
  specLibPicker(window.opener ? '' : specLibStatus('warn',
    'Opened on its own — no spec tool is waiting. Browse here, or open the library from the tool to load a sheet.'));
}
