/* ============================================================================
   e360 SHOWRUNNER — ?bind-spec=1  ·  THE SPEC-BIND POPUP
   ----------------------------------------------------------------------------
   INTEGRATIONS_SPEC.md §9.3.3 (delta D5). A spec tool (Spec Sheet Generator,
   NovaSpec, PowerSpec) opens THIS page in a popup and posts its render bundle
   in. The tool never holds a credential and never calls the API: the popup is
   a first-party Showrunner page carrying the operator's own session, and it
   performs the write. That is the whole point of the pattern (§9.3.1), and it
   is also why no CORS_ORIGINS change is needed — there is zero cross-origin
   XHR anywhere in this flow.

     TOOL                                   THIS PAGE
     ────                                   ─────────
     window.open('/?bind-spec=1
                  &specType=e360')     ──▶  boot -> bindSpecBoot()
                                            login gate (session = x-auth-token)
                              ◀────         {type:'bind-popup-ready', specType}
     postMessage(
       {type:'bind-spec-data',
        json, svg, png, pageHtml, …})  ──▶  ORIGIN CHECK, then the show picker
                                            confirm -> POST /shows/:id/spec-bind
                              ◀────         {type:'bind-complete', showId, …}
                                            window.close() after ~1.2 s

   THE THREE DEFECTS WE DO NOT INHERIT (§9.1.5):
     T1  the staffing dashboard accepts `bind-spec-data` from ANY origin. Here
         every inbound message is checked against TOOLS_ORIGINS, which the
         BACKEND serves (env-driven, never hardcoded in public/). No allowlist
         configured means nothing is accepted — fail closed, and say so.
     T2  it labels a .pcfg as ".nsf" via a two-branch ternary. Here the
         extension comes out of SPEC_MAP, so a fourth tool cannot mislabel.
     T3  it hides past shows, and a spec is very often bound after load-in.
         Here past shows are IN by default; the toggle hides them.
   ========================================================================== */

/* specType -> where it lands. One table, read by every label in this file.
   `label` and `what` are UI copy and live only here. `ext` and `node` are
   CONTRACT — the server owns them (lib/enums.js EXT_FOR_SPEC_TYPE /
   SPEC_NODE_FOR_TYPE, served as specExt / specNode on GET /api/config) — so
   the values below are a boot-time fallback that bindAdoptServerSpecMap()
   overwrites with the served ones. Three independent copies of a map is how a
   .pcfg gets labelled ".nsf" (T2); this makes the server the single source. */
var SPEC_MAP = {
  e360: { ext: '.e360', node: 'content', label: 'Spec Sheet Generator', what: 'LED content layout' },
  nsf:  { ext: '.nsf',  node: 'cabling', label: 'NovaSpec',             what: 'data cabling' },
  pcfg: { ext: '.pcfg', node: 'power',   label: 'PowerSpec',            what: 'power configuration' }
};

/* Overlay the served maps onto SPEC_MAP. A spec type the server knows about
   and this file does not still gets an entry, so a fourth tool works without a
   front-end release; a type the server has dropped is removed. Anything the
   server does not send is left exactly as it is above. */
function bindAdoptServerSpecMap(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  var ext = cfg.specExt || {}, node = cfg.specNode || {};
  Object.keys(ext).concat(Object.keys(node)).forEach(function (k) {
    if (!SPEC_MAP[k]) SPEC_MAP[k] = { ext: '.' + k, node: k, label: k, what: k };
    if (ext[k]) SPEC_MAP[k].ext = ext[k];
    if (node[k]) SPEC_MAP[k].node = node[k];
  });
  var known = cfg.specTypes;
  if (Object.prototype.toString.call(known) === '[object Array]' && known.length) {
    Object.keys(SPEC_MAP).forEach(function (k) { if (known.indexOf(k) < 0) delete SPEC_MAP[k]; });
  }
}

var BIND = {
  specType: null,
  origins: [],          /* the served TOOLS_ORIGINS allowlist */
  toolOrigin: null,     /* pinned the moment a valid bundle arrives */
  bundle: null,
  shows: [],
  q: '',
  showPast: true,       /* T3: a spec is often bound after load-in */
  pick: null,
  busy: false,
  done: false,
  cancelled: false      /* the tool has been told this popup gave up */
};

function bindSpecRequested() {
  try {
    return /[?&]bind-spec=1(&|$)/.test(String(location.search || ''));
  } catch (_) { return false; }
}
function bindParam(name) {
  try {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(String(location.search || ''));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  } catch (_) { return null; }
}

/* ---- the shell ----------------------------------------------------------- */
function bindEl() {
  var el = document.getElementById('bindScreen');
  if (!el) {
    el = document.createElement('div');
    el.className = 'bind-screen'; el.id = 'bindScreen';
    document.body.appendChild(el);
  }
  return el;
}
function bindHead() {
  var m = SPEC_MAP[BIND.specType] || {};
  return '<div class="bind-head"><div class="logo">e</div>' +
    '<div><h1>Bind to a Showrunner show</h1>' +
      '<div class="sub">' + esc((m.label || 'A spec tool') + ' · ' + (m.what || 'spec') +
        ' → the ' + (m.node || '—') + ' node of the derivation chain') + '</div></div>' +
    '<span class="spec-chip">' + esc(m.ext || BIND.specType || '?') + '</span></div>';
}
function bindStatus(kind, html) {
  return '<div class="bind-status ' + kind + '">' + inlineIcon(
    kind === 'crit' ? 'alert' : kind === 'ok' ? 'checkC' : kind === 'warn' ? 'alert' : 'bolt') +
    '<span>' + html + '</span></div>';
}
function bindPaint(inner) { bindEl().innerHTML = '<div class="bind-wrap">' + bindHead() + inner + '</div>'; }

function bindWaiting() {
  bindPaint(bindStatus('', 'Waiting for the spec from ' +
      esc((SPEC_MAP[BIND.specType] || {}).label || 'the tool') + '…') +
    '<div class="bind-foot">' + inlineIcon('lock') +
    'This window holds your session. The tool never sees a credential.</div>');
}
function bindFail(msg, detail) {
  BIND.done = true;
  bindPaint(bindStatus('crit', '<b>' + esc(msg) + '</b>') +
    (detail ? '<div class="bind-foot">' + esc(detail) + '</div>' : ''));
}

/* ---- the picker ---------------------------------------------------------- */
function bindShowRows() {
  var today = TODAY_ISO;
  var q = String(BIND.q || '').toLowerCase().trim();
  var rows = BIND.shows.filter(function (s) {
    var past = String(s.event_date || s.strike_date || '') < today;
    if (past && !BIND.showPast) return false;
    if (!q) return true;
    var hay = [s.name, s.venue, s.city, (s.project && s.project.name) || '',
               (s.project && s.project.client) || '', s.event_date].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  });
  if (!rows.length) {
    return '<div class="bind-status">' + inlineIcon('search') + '<span>No show matches “' + esc(BIND.q) + '”.</span></div>';
  }
  return rows.map(function (s) {
    var p = PROJECTS_BY_ID[s.project_id] || s.project || {};
    var past = String(s.event_date || s.strike_date || '') < today;
    var sub = [p.client || '', s.venue || '', s.city || ''].filter(Boolean).join(' · ');
    return '<button class="bind-row' + (past ? ' past' : '') + '" ' + act('bindPick', s.id) + '>' +
      '<span><span class="br-n">' + esc(p.name && p.name !== s.name ? p.name + ' — ' + s.name : (s.name || p.name || 'Untitled show')) + '</span>' +
      '<span class="br-s">' + esc(sub || 'no venue on file') + '</span></span>' +
      '<span class="br-d">' + esc(s.event_date || '—') + (past ? ' · past' : '') + '</span></button>';
  }).join('');
}
function bindPicker(note) {
  var m = SPEC_MAP[BIND.specType] || {};
  bindPaint(
    (note || bindStatus('ok', 'Spec received from <b>' + esc(BIND.toolOrigin || 'the tool') + '</b>. Pick the show it belongs to.')) +
    '<input class="bind-search" id="bindQ" placeholder="Filter by show, client, venue or date…" autocomplete="off">' +
    '<div class="bind-list" id="bindList">' + bindShowRows() + '</div>' +
    '<div class="bind-foot">' +
      '<button class="btn sm ghost" ' + act('bindPast') + '>' + icon(BIND.showPast ? 'eye' : 'grid') +
        (BIND.showPast ? 'Hide past shows' : 'Show past shows') + '</button>' +
      '<span>' + esc(BIND.shows.length) + ' shows · binding writes the ' + esc(m.node || '') +
      ' node and marks everything downstream stale.</span></div>');
  var q = document.getElementById('bindQ');
  if (q) {
    q.value = BIND.q;
    q.oninput = function () {
      BIND.q = q.value;
      var l = document.getElementById('bindList');
      if (l) l.innerHTML = bindShowRows();
    };
    try { q.focus(); } catch (_) {}
  }
}

function bindConfirmView() {
  var s = BIND.pick, m = SPEC_MAP[BIND.specType] || {};
  var p = PROJECTS_BY_ID[s.project_id] || s.project || {};
  /* T2: the extension is looked up, never derived from a two-branch ternary */
  var existing = (s.files || []).filter(function (f) {
    return f.chain_key === m.node && f.status === 'filed';
  });
  var chain = s.chain && s.chain[m.node];
  return bindStatus('', 'Confirm the bind. Nothing is written until you do.') +
    '<div class="bind-confirm">' +
      '<h3>' + esc((p.name ? p.name + ' — ' : '') + (s.name || '')) + '</h3>' +
      '<p>' + esc([s.venue, s.city, s.event_date].filter(Boolean).join(' · ')) + '</p>' +
      '<p>Filing a <b>' + esc(m.ext) + '</b> onto the <b>' + esc(m.node) + '</b> node' +
        (chain && chain.gen ? ' (currently v' + esc(chain.rev) + ')' : ' (nothing bound yet)') + '.</p>' +
      (existing.length
        ? '<p style="color:var(--warn)">' + inlineIcon('alert') + ' ' + existing.length + ' file already on this node will be <b>superseded</b> — kept as a record, not deleted.</p>'
        : '') +
      '<p style="color:var(--muted)">Everything downstream of ' + esc(m.node) +
        ' becomes stale until it is re-bound. That is the chain doing its job.</p>' +
      '<div class="bc-btns">' +
        '<button class="btn primary" ' + act('bindGo') + '>' + icon('check') + 'Bind to this show</button>' +
        '<button class="btn ghost" ' + act('bindBack') + '>Choose a different show</button>' +
      '</div>' +
    '</div>';
}

/* ---- the write ----------------------------------------------------------- */
async function bindCommit() {
  if (BIND.busy || !BIND.pick || !BIND.bundle) return;
  BIND.busy = true;
  var s = BIND.pick, m = SPEC_MAP[BIND.specType] || {}, b = BIND.bundle;
  bindPaint(bindStatus('', 'Filing the spec and updating the chain…'));
  try {
    var r = await api.specBind(s.id, {
      specType: BIND.specType,
      json: b.json,
      svg: b.svg || '',
      pageHtml: b.pageHtml || '',
      png: b.png || '',
      suggestedName: b.suggestedName || s.name || '',
      toolVersion: b.toolVersion || '',
      sourceUrl: b.sourceUrl || ''
    });
    var node = (r && r.node) || m.node;
    var rev = r && r.rev;
    var stale = [];
    /* the server sends both a {node:bool} map and the recomputed chain */
    var staleSrc = (r && r.stale) || (r && r.chain) || {};
    Object.keys(staleSrc).forEach(function (k) {
      var v = staleSrc[k];
      if (v === true || (v && v.stale)) stale.push(k);
    });
    /* §9.3.5 draws the tool showing "⚠ cabling and power are now stale", and
       the tool never sees the 200 — this message is the only way that fact
       reaches it. `stale` is the array of node names, so an older tool that
       does not read the field is unaffected. */
    bindReply({ type: 'bind-complete', showId: s.id, showName: (r && r.showName) || s.name || '',
                node: node, rev: rev, stale: stale.slice() });
    BIND.done = true;
    /* D7: the stack-aware checker reports QUESTIONS, never errors — so they
       render as questions and never block a bind that already succeeded.
       lib/speccheck.js marks every result `provisional` and asks the UI to say
       so out loud, which is what the note under the list is for. */
    var chk = (r && r.check) || {};
    var qs = chk.questions || [];
    bindPaint(bindStatus('ok', 'Bound to <b>' + esc(s.name || '') + '</b> — ' + esc(node) +
        (rev != null ? ' v' + esc(rev) : '') + '.') +
      (stale.length ? bindStatus('warn', esc(stale.join(' and ')) + ' ' +
        (stale.length === 1 ? 'is' : 'are') + ' now stale until re-bound.') : '') +
      (r && r.logoStripped ? bindStatus('warn', 'A logo in the spec was not an image and was dropped.') : '') +
      (qs.length ? '<div class="bind-confirm"><h3>' + qs.length + ' question' + (qs.length === 1 ? '' : 's') +
          ' about the numbers</h3>' +
          qs.map(function (q) {
            /* a speech bubble, not the alert triangle — these are questions */
            return '<p>' + inlineIcon('chat') + ' ' + esc(q.ask) +
              (q.detail ? '<br><span style="color:var(--muted)">' + esc(q.detail) + '</span>' : '') + '</p>';
          }).join('') +
          '<p style="color:var(--muted)">These are questions, not errors — the bind is filed either way.' +
          (chk.provisional ? ' They read only what the specs declare, so treat every one as provisional.' : '') +
          '</p></div>'
        : '') +
      '<div class="bind-foot">' + inlineIcon('check') + 'This window closes on its own.</div>');
    setTimeout(function () { try { window.close(); } catch (_) {} }, qs.length ? 6000 : 1400);
  } catch (e) {
    BIND.busy = false;
    bindPaint(bindStatus('crit', '<b>Not bound.</b> ' + esc(String((e && e.message) || e))) +
      '<div class="bind-confirm"><div class="bc-btns">' +
        '<button class="btn primary" ' + act('bindGo') + '>' + icon('bolt') + 'Try again</button>' +
        '<button class="btn ghost" ' + act('bindBack') + '>Choose a different show</button>' +
      '</div></div>');
  }
}

/* ---- postMessage, in both directions ------------------------------------- */
function bindReply(msg) {
  if (!window.opener) return;
  try { window.opener.postMessage(msg, BIND.toolOrigin || '*'); } catch (_) {}
}
/* The READY handshake must target '*': we do not know the tool's origin until
   it answers. It carries no data — only the invitation to send some. Every
   INBOUND message is checked, which is where the real guarantee lives. */
function bindAnnounceReady() {
  if (!window.opener) return;
  try { window.opener.postMessage({ type: 'bind-popup-ready', specType: BIND.specType }, '*'); } catch (_) {}
}
/* A popup that is closed without binding must SAY so. The tool put its UI into
   a waiting state on `bind-popup-ready`; with no message back it waits there
   forever, and the operator's only tell is that nothing happened. Carries no
   data, so the '*' fallback (when the tool never sent us a bundle and we have
   no origin to pin) leaks nothing. Fires once, and never after a bind landed —
   `bind-complete` is the terminal message when there is one. */
function bindAnnounceCancelled() {
  if (BIND.done || BIND.cancelled) return;
  BIND.cancelled = true;
  bindReply({ type: 'bind-cancelled', specType: BIND.specType });
}

function bindOriginAllowed(origin) {
  if (!origin) return false;
  var here = '';
  try { here = location.origin; } catch (_) {}
  if (origin === here) return true;               /* a tool served from here */
  return BIND.origins.indexOf(origin) >= 0;
}

async function bindOnMessage(e) {
  if (BIND.done) return;
  var msg = e && e.data;
  if (!msg || typeof msg !== 'object' || !msg.type) return;
  if (msg.type !== 'bind-spec-data' && msg.type !== 'bind-source-error') return;

  /* T1, our side. An unrecognised origin is refused loudly — silence here is
     what made the staffing bug hard to see. */
  if (!bindOriginAllowed(e.origin)) {
    bindFail('That message came from an origin Showrunner does not trust: ' + String(e.origin || 'unknown'),
      BIND.origins.length
        ? 'Allowed: ' + BIND.origins.join(', ') + '. Add the tool host to TOOLS_ORIGINS on the server if this is legitimate.'
        : 'No TOOLS_ORIGINS allowlist is configured on the server, so nothing is accepted. That is a server setting, not something this page can override.');
    return;
  }
  BIND.toolOrigin = e.origin;

  if (msg.type === 'bind-source-error') {
    bindFail('The tool could not produce the spec.', String(msg.error || ''));
    return;
  }
  if (!msg.json || typeof msg.json !== 'object') {
    bindFail('That bundle carried no spec document.', 'The tool sent a `bind-spec-data` message with no `json` object.');
    return;
  }
  if (msg.specType && SPEC_MAP[msg.specType]) BIND.specType = msg.specType;
  BIND.bundle = msg;
  await bindLoadShows();
  bindPicker();
}

async function bindLoadShows() {
  try {
    BIND.shows = await api.listShows();
    BIND.shows.sort(function (a, b) {
      var ad = String(a.event_date || ''), bd = String(b.event_date || '');
      return ad < bd ? 1 : ad > bd ? -1 : b.id - a.id;      /* newest first */
    });
  } catch (e) {
    BIND.shows = [];
  }
}

/* ---- boot ---------------------------------------------------------------- */
async function bindSpecBoot() {
  var st = bindParam('specType');
  BIND.specType = SPEC_MAP[st] ? st : 'e360';

  /* the bind writes through the human surface, so it needs a real session */
  if (!api.isDemo()) {
    var me = null;
    try { me = await api.currentUser(); } catch (_) { me = null; }
    if (!me) {
      bindPaint(bindStatus('', 'Sign in to bind this spec — this window carries your session, the tool never does.'));
      openLogin(null, function () { return bindSpecBoot(); });
      return;
    }
    closeLogin();
  } else {
    bindFail('Binding a spec needs the live Showrunner server.',
      'This window is running the demo dataset — there is nothing real to bind to.');
    return;
  }

  bindEl();
  bindWaiting();

  /* actions land on the app's one delegated listener */
  ACTIONS.bindPick = function (t, id) {
    var s = null;
    for (var i = 0; i < BIND.shows.length; i++) if (BIND.shows[i].id === Number(id)) s = BIND.shows[i];
    if (!s) return;
    /* the confirm names the node and what it supersedes, so load the detail */
    return api.getShow(s.id).then(function (full) {
      BIND.pick = full || s;
      bindPaint(bindConfirmView());
    }, function () { BIND.pick = s; bindPaint(bindConfirmView()); });
  };
  ACTIONS.bindGo = function () { return bindCommit(); };
  ACTIONS.bindBack = function () { BIND.pick = null; BIND.busy = false; bindPicker(); };
  ACTIONS.bindPast = function () { BIND.showPast = !BIND.showPast; bindPicker(); };

  /* the allowlist AND the spec-type maps come from the BACKEND (D4).
     Never hardcoded here — one fetch, both answers. */
  var configured = true;
  try {
    var cfg = await SR.serverConfig();
    bindAdoptServerSpecMap(cfg);
    if (!SPEC_MAP[BIND.specType]) BIND.specType = Object.keys(SPEC_MAP)[0] || 'e360';
    BIND.origins = await SR.toolsOrigins();
    /* HARDENING 13. features.specBind is the server SAYING whether TOOLS_ORIGINS
       is set, rather than us inferring it from an empty array — an empty array
       is also what a failed fetch leaves behind, and those are different
       problems. Older servers do not send the flag; treat its absence as
       "cannot tell" and fall back to the array, so this stays additive. */
    configured = (cfg && cfg.features && typeof cfg.features.specBind === 'boolean')
      ? cfg.features.specBind
      : BIND.origins.length > 0;
  } catch (_) { BIND.origins = []; configured = false; }

  /* Refusing every bundle is the correct behaviour with no allowlist. Doing it
     without a word is not: the tool looks broken, and the actual fix is an env
     var on the server. Say it up front, before anything is sent. */
  if (!configured) {
    /* Tell the tool first — bindFail() sets BIND.done, after which the cancel
       announcement is a no-op and the tool would wait forever. Same rule as
       closing the window: a popup that will not bind must say so. */
    bindAnnounceCancelled();
    bindFail('Spec binding is not configured on this server.',
      'No TOOLS_ORIGINS allowlist is set, so Showrunner will refuse every spec bundle a tool sends — ' +
      'nothing this window or the tool can do will change that. Ask whoever deploys Showrunner to set ' +
      'TOOLS_ORIGINS to the tool’s origin, then open this window again.');
    return;
  }

  window.addEventListener('message', function (e) {
    Promise.resolve(bindOnMessage(e)).catch(function (err) {
      bindFail('That bind could not be read.', String((err && err.message) || err));
    });
  });
  /* Closing the window IS the cancel gesture — there is no Cancel button to
     press, so `pagehide` is where the tool gets told. */
  window.addEventListener('pagehide', bindAnnounceCancelled);

  bindAnnounceReady();

  /* a tool that never answers should say so rather than spin forever */
  setTimeout(function () {
    if (BIND.bundle || BIND.done) return;
    bindPaint(bindStatus('warn', 'No spec arrived from the tool.') +
      '<div class="bind-foot">Go back to the tool window and press the bind button again. ' +
      'If it keeps failing, the tool may be on an origin that is not in TOOLS_ORIGINS.</div>');
  }, 30000);
}
