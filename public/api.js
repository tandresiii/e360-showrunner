/* ============================================================================
   e360 SHOWRUNNER — DATA-ACCESS LAYER (api.*)   ·   DUAL MODE
   ----------------------------------------------------------------------------
   THE SEAM. Views never touch a store directly; they call api.*. Every method
   is `async` and every SIGNATURE is identical in both modes, so no view churns
   when the mode flips.

     API MODE   — a real Showrunner server answered the boot probe. Every
                  method is one (occasionally one composite) fetch against the
                  REST surface in SCHEMA.md, authenticated with x-auth-token.
     DEMO MODE  — no server (file://, or the probe failed). The methods keep
                  their ORIGINAL mock bodies and read/write the in-memory store
                  in data.js. data.js is untouched: it is the demo engine.

   Which mode is live is decided ONCE, at boot, by SR.probe(). Everything
   downstream reads SR.isApi().

   ── API mode and the local index maps ──────────────────────────────────────
   The views (and a handful of data.js helpers they call) look records up in
   the flat maps data.js builds — SHOWS_BY_ID, FILES_BY_ID, JOBS_BY_ID,
   PO_LINES_BY_PO, ROSTER … . In API mode those maps are RESET at login and
   then maintained as a READ-THROUGH CACHE: every record a fetch returns is
   merged (by identity, never replaced) into the same map. That is what lets
   `views-*.js` stay byte-for-byte agnostic about where the data came from.

   ── Deviations from the 1:1 table (SCHEMA.md) ──────────────────────────────
     · confirmDoc(fileId) / rejectDoc(fileId) hold a FILE id; the server
       resolves a PROPOSAL. GET /api/files/:id/proposal is the hop.
     · getTemplate(type) keys by event type; the route takes a type OR an id.
     · resolveJob(), and the three recap photo-strip helpers, stay client-side
       — they compose other calls, they are not endpoints.
     · notify: the mutating routes take an optional `notify:[…]`. api.stage-
       Notify() parks the picker's selection; the NEXT mutating request carries
       it. Demo mode keeps its local bell delivery (api.notify).
   ========================================================================== */

/* ══════════════════════════════════════════════════════════════════════════
   SR — transport · session · mode · store sync
   The only thing in the front end that knows what HTTP is.
   ══════════════════════════════════════════════════════════════════════════ */
var SR = (function () {
  'use strict';

  var TOKEN_KEY = 'showrunner.token';
  var MUTATING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

  var st = {
    mode: 'demo',          /* 'demo' | 'api' — resolved once by probe()      */
    probed: false,
    token: null,
    user: null,            /* the GET /api/auth/me record, once hydrated     */
    busy: 0,
    online: true,
    notify: null,          /* one-shot notify list for the next mutation     */
    notifyUsed: false,
    exceptions: [],        /* last server exception list (sync readers)      */
    serverConfig: null,    /* GET /api/config, fetched once                  */
    toolsOrigins: null,    /* served by the backend; never hardcoded         */
    hooks: {}              /* app.js installs: unauthorized, network, busy   */
  };

  /* ---- localStorage, defensively (private mode / file:// both throw) ---- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch (_) { /* the session simply does not survive a reload — acceptable */ }
  }

  function err(msg, status) {
    var e = new Error(msg);
    e.status = status || 0;
    return e;
  }

  /* ---- one fetch, with a timeout, that never throws on an HTTP status ---- */
  function raw(method, path, payload, headers, timeoutMs) {
    var ctl = null, timer = null;
    var opts = { method: method, headers: headers || {} };
    if (payload != null) opts.body = payload;
    try {
      if (typeof AbortController === 'function') {
        ctl = new AbortController();
        opts.signal = ctl.signal;
      }
    } catch (_) { ctl = null; }

    var p = fetch(path, opts).then(function (res) {
      var ct = String(res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '');
      if (ct.indexOf('json') < 0) {
        return res.text().then(function (t) { return { status: res.status, ok: res.ok, body: t ? { error: t } : {} }; });
      }
      return res.json().then(
        function (j) { return { status: res.status, ok: res.ok, body: j }; },
        function () { return { status: res.status, ok: res.ok, body: {} }; }
      );
    });

    if (!timeoutMs) return p;
    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (_) {} }
        reject(err('The server did not answer in time', 0));
      }, timeoutMs);
      p.then(function (v) { clearTimeout(timer); resolve(v); },
             function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function bump(d) {
    st.busy = Math.max(0, st.busy + d);
    if (st.hooks.busy) { try { st.hooks.busy(st.busy); } catch (_) {} }
  }

  /* ---- the one request path every api.* method funnels through ---------- */
  function req(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (st.token && !opts.noAuth) headers['x-auth-token'] = st.token;

    var payload = null;
    var out = body;
    /* The notify passthrough is OPT-IN per call. Only the routes that really
       implement `notify:[…]` may consume the staged list — anywhere else the
       key would be silently dropped by the server's pick() and the ping would
       vanish with no trace. As of the backend's notify pass that is: core
       shows/projects · schedule · crew · call-sheet · photos · purchasing ·
       files · expenses · chain · proposal-confirm — i.e. every route this app
       stages a notify before. Calls without notifyOk leave the list staged and
       sendNotifies() delivers it as an anchored note instead; that fallback is
       kept deliberately, so a route losing its notify support degrades to a
       late ping rather than a silent loss. */
    if (MUTATING[method] && opts.notifyOk && st.notify && st.notify.length) {
      out = (out && typeof out === 'object' && !isArr(out)) ? shallow(out) : (out == null ? {} : out);
      if (out && typeof out === 'object' && !isArr(out) && out.notify === undefined) {
        out.notify = st.notify.slice();
        st.notify = null;
        st.notifyUsed = true;
      }
    }
    if (out !== undefined && out !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(out);
    }

    /* A FAILED mutation must not leave a notify list parked — it would ride
       the NEXT, unrelated mutating request and ping people about something
       that never happened. It must also not leave `notifyUsed` set, or the
       caller's fallback would think delivery already happened. Both failure
       paths (an HTTP status, and a dropped connection) go through here. */
    function dropNotify() {
      if (!MUTATING[method]) return;
      st.notify = null;
      st.notifyUsed = false;
    }

    bump(1);
    return raw(method, path, payload, headers, opts.timeout || 20000).then(function (r) {
      bump(-1);
      if (!st.online) { st.online = true; if (st.hooks.network) st.hooks.network(true); }
      if (r.status === 401) {
        dropNotify();
        setToken(null);
        if (st.hooks.unauthorized && !opts.quiet) { try { st.hooks.unauthorized(); } catch (_) {} }
        throw err((r.body && r.body.error) || 'Your session has expired — sign in again', 401);
      }
      if (!r.ok) {
        dropNotify();
        throw err((r.body && r.body.error) || ('Request failed (' + r.status + ')'), r.status);
      }
      return r.body;
    }, function (e) {
      bump(-1);
      dropNotify();
      /* a rejected fetch is a NETWORK failure, never an application error */
      st.online = false;
      if (st.hooks.network && !opts.quiet) { try { st.hooks.network(false, e); } catch (_) {} }
      throw err(e && e.status ? e.message : 'Cannot reach the Showrunner server', 0);
    });
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function shallow(o) { var c = {}; for (var k in o) if (has(o, k)) c[k] = o[k]; return c; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  /* ══ MODE ══════════════════════════════════════════════════════════════ */
  /* A server that ANSWERS AT ALL — even 503 with the database down — is a
     server, and we stay in API mode and surface the real error. Only a
     network-level failure or file:// drops us into the demo. Silently serving
     fictional data because a health check hiccuped would be much worse. */
  function probe(timeoutMs) {
    if (st.probed) return Promise.resolve(st.mode);
    st.probed = true;
    var proto = '';
    try { proto = location.protocol; } catch (_) {}
    if (proto === 'file:' || typeof fetch !== 'function') { st.mode = 'demo'; return Promise.resolve('demo'); }
    st.token = lsGet(TOKEN_KEY);
    return raw('GET', '/api/health', null, {}, timeoutMs || 2500).then(function () {
      st.mode = 'api';
      return 'api';
    }, function () {
      st.mode = 'demo';
      return 'demo';
    });
  }

  function setToken(t) { st.token = t || null; lsSet(TOKEN_KEY, t || null); }

  /* ══ STORE SYNC — the read-through index cache ═════════════════════════ */
  /* Merge, never replace: the map holds ONE object per id for the life of the
     session, so a `show` that getShow() hydrated with files keeps them when a
     later listShows() returns the thinner row. */
  function keep(map, rec) {
    if (!rec || rec.id == null) return rec;
    var cur = map[rec.id];
    if (!cur) { map[rec.id] = rec; return rec; }
    for (var k in rec) if (has(rec, k)) cur[k] = rec[k];
    return cur;
  }
  function push1(arr, rec) {
    if (!rec) return rec;
    for (var i = 0; i < arr.length; i++) if (arr[i] === rec || arr[i].id === rec.id) { arr[i] = rec; return rec; }
    arr.push(rec);
    return rec;
  }
  function clearMap(m) { Object.keys(m).forEach(function (k) { delete m[k]; }); }

  function resetStore() {
    [PROJECTS_BY_ID, SHOWS_BY_ID, STEPS_BY_ID, FILES_BY_ID, BOOKINGS_BY_ID, JOBS_BY_ID,
     EXPENSES_BY_ID, BUDGET_BY_JOB, BUDGET_BY_ID, POS_BY_ID, PO_LINES_BY_PO, PO_LINES_BY_ID,
     NOTES_BY_ID, SCHEDULE_BY_ID, CREW_BY_ID, DELIVERABLES_BY_ID, ROSTER, USERS_BY_ID,
     NOTE_READS].forEach(clearMap);
    [PROJECTS, ALL_SHOWS, ALL_JOBS, ALL_EXPENSES, ALL_POS, PO_LINES, ALL_NOTES,
     ALL_DELIVERABLES, USERS, BUDGET_LINES].forEach(function (a) { a.length = 0; });
    /* mentionLookup() memoizes name->username off USERS on first use. USERS is
       emptied above, but the cache is not derived state the maps own — so
       without this it survives the swap and @mentions keep resolving against
       whatever roster was loaded first. That is the demo roster whenever a
       session expires mid-visit and the operator signs back in: real names
       would stop resolving and '@Tom' would still point at the fixture. */
    MENTION_LOOKUP = null;
  }

  var A = {
    user: function (u) {
      if (!u || !u.username) return u;
      var cur = ROSTER[u.username];
      if (cur) { for (var k in u) if (has(u, k)) cur[k] = u[k]; u = cur; }
      else { ROSTER[u.username] = u; USERS.push(u); }
      if (u.id != null) USERS_BY_ID[u.id] = u;
      return u;
    },
    project: function (p) {
      if (!p) return p;
      /* Index the PROJECT FIRST. A.show() derives show.type by looking its
         project up in PROJECTS_BY_ID, and dbToShow does not send a type — so
         absorbing the shows before the project is in the map left every show
         from /projects with no type at all. typeDef() then falls back to LED,
         which fails silently and badly: a PRINT show renders the LED lane set,
         icon and tabs (the Proofs tab keys off it). Jobs stay ahead of shows
         because a show can carry a job reference. */
      var rec = keep(PROJECTS_BY_ID, p);
      push1(PROJECTS, rec);
      (p.jobs || []).forEach(A.job);
      (p.shows || []).forEach(A.show);
      return rec;
    },
    show: function (s) {
      if (!s) return s;
      (s.steps || []).forEach(function (st2) { st2.show_id = st2.show_id || s.id; keep(STEPS_BY_ID, st2); });
      if (s.project) A.project(s.project);
      if (s.job) A.job(s.job);
      var rec = keep(SHOWS_BY_ID, s);
      /* the views read `show.type` off the show; it lives on the project */
      if (!rec.type) {
        var p = PROJECTS_BY_ID[rec.project_id];
        if (p) rec.type = p.type;
      }
      /* every lane-agnostic renderer walks `show.steps` — a show that has not
         been read in detail yet must still be an EMPTY pipeline, not a crash.
         The same is true of every OTHER collection the views walk unguarded:
         dbToShow does not send them, so a show absorbed from a LIST endpoint
         arrives without them and `show.files.filter(...)` throws before any
         null-check in the view can help. Empty is the honest answer for "not
         read in detail yet" — and a detail fetch overwrites these via keep(). */
      if (!rec.steps) rec.steps = [];
      if (!rec.milestones) rec.milestones = [];
      if (!rec.files) rec.files = [];
      if (!rec.bookings) rec.bookings = [];
      if (!rec.proofs) rec.proofs = [];
      if (!rec.activity) rec.activity = [];
      if (!rec.expenses) rec.expenses = [];
      push1(ALL_SHOWS, rec);
      return rec;
    },
    job: function (j) { if (!j) return j; var r = keep(JOBS_BY_ID, j); push1(ALL_JOBS, r); return r; },
    step: function (s) { return keep(STEPS_BY_ID, s); },
    file: function (f) {
      if (!f) return f;
      /* `thumb_path` is a NAS path, not a URL, and nothing serves photo bytes
         over HTTP yet — so a photo gets the same deterministic placeholder the
         demo uses rather than a broken <img>. The moment a byte route exists,
         this one line is where it lands. */
      if (f.kind === 'photo' && !f.thumb) {
        var tp = String(f.thumb_path || '');
        f.thumb = /^(data:|https?:|\/)/.test(tp) ? tp
          : mkThumb(String(f.name || f.id), f.name || '',
                    (Number(f.width) || 1600) / (Number(f.height) || 1200));
      }
      return keep(FILES_BY_ID, f);
    },
    booking: function (b) { return keep(BOOKINGS_BY_ID, b); },
    expense: function (e) { if (!e) return e; var r = keep(EXPENSES_BY_ID, e); push1(ALL_EXPENSES, r); return r; },
    po: function (p) {
      if (!p) return p;
      if (p.lines) {
        /* HARDENING 11. keep() RETURNS the canonical object — the one the map
           already holds, with this payload merged into it. Throwing that return
           away and indexing the raw `l` instead left THREE different objects
           alive for one line id: the merged one in PO_LINES_BY_ID, the raw one
           in PO_LINES, and the raw one in PO_LINES_BY_PO. Editing a line
           through one of them left the other two stale, which is exactly the
           bug the read-through cache exists to prevent. The demo store puts the
           SAME object in all three (data.js addPOLine) — this now matches. */
        p.lines = p.lines.map(function (l) {
          var line = keep(PO_LINES_BY_ID, l);
          push1(PO_LINES, line);
          return line;
        });
        PO_LINES_BY_PO[p.id] = p.lines;
      }
      if (!p.activity) p.activity = [];
      var r = keep(POS_BY_ID, p);
      push1(ALL_POS, r);
      return r;
    },
    note: function (n) {
      if (!n) return n;
      var r = keep(NOTES_BY_ID, n);
      push1(ALL_NOTES, r);
      /* read state is a server column here and a local map in the demo —
         mirror it so the shared unread styling reads the same way in both */
      if (n.read && typeof markNoteRead === 'function') { try { markNoteRead(ME, r.id); } catch (_) {} }
      return r;
    },
    sched: function (i) { return keep(SCHEDULE_BY_ID, i); },
    crew: function (c) { return keep(CREW_BY_ID, c); },
    deliverable: function (d) {
      if (!d) return d;
      (d.photos || []).forEach(A.file);
      (d.pool || []).forEach(A.file);
      var r = keep(DELIVERABLES_BY_ID, d);
      push1(ALL_DELIVERABLES, r);
      return r;
    },
    budget: function (jobId, lines) {
      /* HARDENING 11. This was the one adapter that never called keep() at all:
         it pushed the raw rows and let BUDGET_BY_JOB point at them. push1()
         REPLACES by id rather than merging, so a second fetch swapped the
         object out from under anything already holding it — a budget line
         edited in the drawer kept rendering its old allotted figure in the
         job's P&L. Now it merges through the id map like every other entity,
         and the per-job array holds the SAME canonical objects. */
      var out = (lines || []).map(function (l) {
        var line = keep(BUDGET_BY_ID, l);
        push1(BUDGET_LINES, line);
        return line;
      });
      BUDGET_BY_JOB[jobId] = out;
      return out;
    },
    list: function (fn) { return function (rows) { return (rows || []).map(fn); }; }
  };

  return {
    /* mode */
    probe: probe,
    mode: function () { return st.mode; },
    isApi: function () { return st.mode === 'api'; },
    forceDemo: function () { st.mode = 'demo'; st.probed = true; },

    /* session */
    token: function () { return st.token; },
    setToken: setToken,
    user: function (u) { if (u !== undefined) st.user = u; return st.user; },

    /* hooks app.js installs at boot */
    on: function (name, fn) { st.hooks[name] = fn; },
    busy: function () { return st.busy; },
    online: function () { return st.online; },

    /* notify staging */
    stageNotify: function (list) {
      st.notify = (list && list.length) ? list.slice() : null;
      st.notifyUsed = false;
    },
    notifyConsumed: function () { return !!st.notifyUsed; },
    clearNotify: function () { st.notify = null; st.notifyUsed = false; },

    /* verbs */
    get: function (p, o) { return req('GET', p, undefined, o); },
    post: function (p, b, o) { return req('POST', p, b === undefined ? {} : b, o); },
    put: function (p, b, o) { return req('PUT', p, b === undefined ? {} : b, o); },
    del: function (p, b, o) { return req('DELETE', p, b, o); },
    qs: qs,

    /* store */
    absorb: A,
    resetStore: resetStore,

    /* the last "waiting on paperwork" list the server sent. Two renderers
       (the show finance panel and the folder card) need it synchronously and
       cannot compute it locally in API mode — the ledger is server-side. */
    exceptions: function (v) { if (v !== undefined) st.exceptions = v || []; return st.exceptions || []; },

    /* GET /api/config, fetched once and cached. Everything the SPA is allowed
       to know about how this server is deployed — the TOOLS_ORIGINS allowlist
       and the spec-type maps (specExt / specNode) among it. Fetched ONCE
       because it is env-driven and cannot change under a running page; a
       failure caches `{}` so a dead config endpoint degrades to "nothing is
       configured" (fail closed) rather than a retry storm. */
    serverConfig: function () {
      if (st.serverConfig) return Promise.resolve(st.serverConfig);
      return req('GET', '/api/config', undefined, { quiet: true }).then(function (c) {
        st.serverConfig = (c && typeof c === 'object') ? c : {};
        return st.serverConfig;
      }, function () { st.serverConfig = {}; return st.serverConfig; });
    },

    /* tools origins for the ?bind-spec=1 popup (D4/D5) — env-driven, cached.
       Unset on the server means `[]`, which the popup treats as "trust
       nothing" (D4 is fail-closed by design). */
    toolsOrigins: function () {
      if (st.toolsOrigins) return Promise.resolve(st.toolsOrigins);
      return this.serverConfig().then(function (c) {
        var v = (c && c.toolsOrigins) || [];
        st.toolsOrigins = Object.prototype.toString.call(v) === '[object Array]' ? v
          : String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        return st.toolsOrigins;
      });
    }
  };
})();


/* The "waiting on paperwork" ledger, readable SYNCHRONOUSLY.
   Two renderers need it inline (a show's finance panel, a folder card) and
   the list is derived server-side in API mode, so this reads the last list
   api.listExceptions()/getFinanceOverview() cached. In demo mode it is the
   mock's own computation, unchanged. */
function srExceptions() {
  return SR.isApi() ? SR.exceptions() : financeExceptions();
}

/* ══════════════════════════════════════════════════════════════════════════
   api.* — the seam
   ══════════════════════════════════════════════════════════════════════════ */
var api = (function () {

  function ok(v) { return Promise.resolve(v); }
  function fail(msg) { return Promise.reject(new Error(msg)); }
  function API() { return SR.isApi(); }
  var A = SR.absorb;

  /* ---- projects / shows / jobs (DEMO hydrators, unchanged) --------------- */
  function projectShows(p) { return p.shows.slice(); }

  function hydrateProject(p) {
    if (!p) return null;
    return {
      id: p.id, slug: p.slug, name: p.name, client: p.client, type: p.type,
      stage: p.stage, owner: p.owner, description: p.description,
      summary: p.summary || null, source: p.source || null,
      milestones: p.milestones || null,
      jobs: (p.jobs || []).slice(),
      shows: projectShows(p),
      single: p.shows.length === 1
    };
  }

  function hydrateShow(s) {
    if (!s) return null;
    var p = PROJECTS_BY_ID[s.project_id];
    s.project = hydrateProject(p);
    s.job = s.default_job_id ? JOBS_BY_ID[s.default_job_id] : null;
    s.type = p.type;                    /* type lives on the project */
    return s;
  }

  /* ---- API-mode normalizers --------------------------------------------
     Small, named, and few. Each one exists because the server's shape and
     the mock's shape differ by a derived field the views already read. */

  /* the money views print a human category label off every budget row */
  function withCatLabels(rows) {
    (rows || []).forEach(function (l) {
      if (l && !l.label) l.label = BUDGET_CATS[l.category] || l.category;
    });
    return rows;
  }
  function normJobFinance(jf) {
    if (!jf) return jf;
    A.job(jf.job);
    withCatLabels(jf.lines); withCatLabels(jf.unbudgeted);
    (jf.expenses || []).forEach(function (x) { A.expense(x.e); });
    (jf.docs || []).forEach(function (x) { A.file(x.f); });
    (jf.shows || []).forEach(A.show);
    /* the mock hands the view the project record; the server hands its id */
    if (!jf.project) jf.project = PROJECTS_BY_ID[jf.project_id] || null;
    return jf;
  }
  /* every recap write answers {recap, note}; every read answers the record */
  function unwrapRecap(r) {
    var rec = (r && r.recap) ? r.recap : r;
    return rec ? A.deliverable(rec) : rec;
  }
  /* the gear panel wants a kit and a view mode; flex_state stores neither.
     `kit` is a pure function of the cabinet count (GET supplies `cabinets`;
     PUT does not, so the previous value is carried forward), and `view` is
     pure UI state that must survive a round trip. */
  function normGear(showId, g) {
    g = g || {};
    var s = SHOWS_BY_ID[Number(showId)];
    var prev = (s && s.gear) || {};
    if (g.cabinets == null) g.cabinets = prev.cabinets != null ? prev.cabinets : (s && s.cabinets) || 72;
    if (!g.kit) g.kit = prev.kit && prev.cabinets === g.cabinets ? prev.kit : buildKit(g.cabinets || 72);
    if (!g.view) g.view = prev.view || 'pull-sheet';
    if (g.elementId === undefined) g.elementId = g.element_id || null;
    if (!g.gearListType) g.gearListType = g.gear_list_type || 'pull-sheet';
    /* the pull-sheet header and the Flex bar print this raw — an unset column
       rendered a literal "null" next to "gear list" */
    if (!g.docNumber) g.docNumber = g.doc_number || prev.docNumber || '—';
    return g;
  }

  /* the "waiting on me" rows print `x.job.qb_job_number` and open
     `x.show.id`; the server sends `job_id` and a 3-key show stub. */
  function normExceptions(rows) {
    (rows || []).forEach(function (x) {
      if (x.show && x.show.id && SHOWS_BY_ID[x.show.id]) x.show = SHOWS_BY_ID[x.show.id];
      if (!x.job) x.job = x.job_id ? (JOBS_BY_ID[x.job_id] || null) : null;
    });
    return rows || [];
  }
  /* the feed's five variants match 1:1; only the records inside need indexing
     so the row renderers' store lookups (PO_LINES_BY_PO, PROJECTS_BY_ID) hit */
  function normFeed(rows) {
    (rows || []).forEach(function (ev) {
      if (ev.file) A.file(ev.file);
      if (ev.exp) A.expense(ev.exp);
      if (ev.bk) A.booking(ev.bk);
      if (ev.po) A.po(ev.po);
      if (ev.show && ev.show.id && SHOWS_BY_ID[ev.show.id]) ev.show = SHOWS_BY_ID[ev.show.id];
    });
    return rows || [];
  }

  /* The $5,000 gate is CONFIG, not a constant: `poNeedsApproval()` and every
     "over the threshold" string read the global, so pull the real number once
     per session or the UI and the server can disagree about who needs to
     approve what. Server-enforced either way — this only keeps the copy true. */
  var _thresholdRead = false;
  function syncPoThreshold() {
    if (_thresholdRead) return ok(PO_APPROVAL_THRESHOLD);
    _thresholdRead = true;
    return SR.get('/api/config/po-approval-threshold', { quiet: true }).then(function (c) {
      var v = Number(c && c.value);
      if (isFinite(v) && v > 0) PO_APPROVAL_THRESHOLD = v;
      return PO_APPROVAL_THRESHOLD;
    }, function () { return PO_APPROVAL_THRESHOLD; });
  }

  /* ---- templates: the flat server rows -> the lane-keyed mock record ----- */
  var _eventTypes = null;
  function eventTypes() {
    if (_eventTypes) return ok(_eventTypes);
    return SR.get('/api/event-types').then(function (c) {
      _eventTypes = c || { lanes: [], types: [] };
      return _eventTypes;
    }, function () { _eventTypes = { lanes: [], types: [] }; return _eventTypes; });
  }
  function shapeTpl(type, row, cat) {
    var ty = ((cat && cat.types) || []).filter(function (t) { return t.key === type; })[0] || null;
    /* `lane_defs` is already the {key,label,color} array the renderer wants */
    var def = ty ? { key: ty.key, label: ty.label, tag: ty.tag, icon: ty.icon, anchor: ty.anchor,
                     lanes: ty.lane_defs || [] }
                 : typeDef(type);
    var steps = {};
    ((row && row.steps) || []).forEach(function (s) {
      (steps[s.lane] = steps[s.lane] || []).push({
        name: s.title,
        role: s.owner_role || '',
        /* the mock's `off` is a T-minus MAGNITUDE; the column is signed */
        off: Math.abs(Number(s.due_offset_days) || 0),
        flag: s.depends_on_title ? 'dep'
            : (s.auto_source && s.auto_source !== 'none' ? 'auto' : '')
      });
    });
    if (!row) steps = TEMPLATE_STEPS[type] || {};
    return {
      event_type: type, def: def, steps: steps,
      meta: { desc: (row && row.description) || (TEMPLATE_META[type] || {}).desc || 'Custom event type.',
              id: row ? row.id : null, name: row ? row.name : null }
    };
  }

  /* the composite reads. getShow() is ONE seam call and nine parallel GETs:
     the server's /shows/:id carries steps + project + job + milestones, and
     the rest of what a show view renders lives on its own endpoints. */
  function fetchShow(id) {
    var sid = Number(id);
    return Promise.all([
      SR.get('/api/shows/' + sid),
      SR.get('/api/files' + SR.qs({ show_id: sid, limit: 1000 })),
      SR.get('/api/bookings' + SR.qs({ show_id: sid })),
      SR.get('/api/proofs' + SR.qs({ show_id: sid })),
      SR.get('/api/activity' + SR.qs({ show_id: sid, limit: 80 })),
      SR.get('/api/shows/' + sid + '/chain'),
      SR.get('/api/shows/' + sid + '/gear'),
      SR.get('/api/expenses' + SR.qs({ show_id: sid })),
      SR.get('/api/shows/' + sid + '/schedule'),
      SR.get('/api/shows/' + sid + '/crew')
    ]).then(function (r) {
      var show = r[0];
      if (show.project) A.project(show.project);
      show.files = (r[1] || []).map(A.file);
      show.bookings = (r[2] || []).map(A.booking);
      show.proofs = r[3] || [];
      show.activity = r[4] || [];
      show.chain = r[5] || {};
      show.gear = normGear(sid, r[6]);
      show.expenses = (r[7] || []).map(A.expense);
      show.schedule_items = (r[8] || []).map(A.sched);
      show.crew_assignments = (r[9] || []).map(function (c) { if (c.user) A.user(c.user); return A.crew(c); });
      if (show.job) A.job(show.job);
      var rec = A.show(show);
      /* the folder header renders from the project's own shape */
      if (rec.project && rec.project.shows === undefined) {
        var p = PROJECTS_BY_ID[rec.project_id];
        rec.project.single = p && p.shows ? p.shows.length === 1 : undefined;
      }
      return rec;
    });
  }

  /* the list reads that views iterate: one call per collection, bucketed by
     show, rather than N composite reads. */
  function fetchShows(projectId) {
    var pid = projectId == null ? null : Number(projectId);
    return Promise.all([
      SR.get('/api/shows' + SR.qs({ project_id: pid })),
      SR.get('/api/files' + SR.qs({ project_id: pid, limit: 1000 })),
      SR.get('/api/steps' + SR.qs({ project_id: pid })),
      SR.get('/api/bookings' + SR.qs({ limit: 1000 })),
      pid == null ? SR.get('/api/projects') : SR.get('/api/projects/' + pid).then(function (p) { return [p]; })
    ]).then(function (r) {
      (r[4] || []).forEach(A.project);
      var byShow = {}, stepsBy = {}, bkBy = {};
      (r[1] || []).forEach(function (f) { A.file(f); (byShow[f.show_id] = byShow[f.show_id] || []).push(f); });
      (r[2] || []).forEach(function (s) { A.step(s); (stepsBy[s.show_id] = stepsBy[s.show_id] || []).push(s); });
      (r[3] || []).forEach(function (b) { A.booking(b); (bkBy[b.show_id] = bkBy[b.show_id] || []).push(b); });
      return (r[0] || []).map(function (s) {
        var rec = A.show(s);
        if (!rec.files || byShow[rec.id]) rec.files = byShow[rec.id] || [];
        if (!rec.steps || stepsBy[rec.id]) rec.steps = stepsBy[rec.id] || rec.steps || [];
        if (!rec.bookings || bkBy[rec.id]) rec.bookings = bkBy[rec.id] || [];
        if (!rec.proofs) rec.proofs = [];
        if (!rec.activity) rec.activity = [];
        if (!rec.expenses) rec.expenses = [];
        if (!rec.schedule_items) rec.schedule_items = [];
        if (!rec.chain) rec.chain = {};
        if (!rec.gear) rec.gear = { linked: false, pulled: false, elementId: null };
        rec.project = PROJECTS_BY_ID[rec.project_id] || rec.project || null;
        rec.job = rec.default_job_id ? (JOBS_BY_ID[rec.default_job_id] || null) : null;
        if (rec.project && !rec.type) rec.type = rec.project.type;
        return rec;
      });
    });
  }

  /* the file → proposal hop (DEVIATION 1). The caller holds a FILE id; the
     server resolves a PROPOSAL. One extra GET, not a refactor — and free when
     the bell already told us the proposal id. */
  function proposalIdFor(fileId) {
    var f = FILES_BY_ID[Number(fileId)];
    if (f && f.proposal_id) return ok(f.proposal_id);
    return SR.get('/api/files/' + Number(fileId) + '/proposal').then(function (p) {
      if (!p || !p.id) throw new Error('No proposal is attached to that file');
      return p.id;
    });
  }

  return {
    /* ---- mode / session (API mode only; inert in demo) ------------------ */
    mode: function () { return SR.mode(); },
    isDemo: function () { return !SR.isApi(); },
    login: function (username, password) {
      if (!API()) return fail('Demo mode has no sign-in — the roster is fictional');
      return SR.post('/api/auth/login', { username: username, password: password },
                     { noAuth: true, quiet: true, noNotify: true })
        .then(function (r) {
          SR.setToken(r.token);
          SR.resetStore();
          var u = A.user(r.user || { username: r.username, role: r.role });
          SR.user(u);
          CURRENT_USER = u; ME = u.username;
          return u;
        });
    },
    logout: function () {
      if (!API()) return ok({ ok: true });
      return SR.post('/api/auth/logout', {}, { quiet: true, noNotify: true })
        .then(function () { SR.setToken(null); return { ok: true }; },
              function () { SR.setToken(null); return { ok: true }; });
    },
    /* the notify list the picker collected rides the NEXT mutating request */
    stageNotify: function (list) { if (API()) SR.stageNotify(list); },
    notifyConsumed: function () { return API() && SR.notifyConsumed(); },

    /* ---- meta ---------------------------------------------------------- */
    currentUser: function () {
      if (!API()) return ok(CURRENT_USER);
      if (!SR.token()) return ok(null);
      return SR.get('/api/auth/me', { quiet: true }).then(function (r) {
        if (!r || r.loggedIn === false) { SR.setToken(null); return null; }
        var u = A.user(r.user);
        SR.user(u);
        CURRENT_USER = u; ME = u.username;
        return u;
      }, function (e) { if (e && e.status === 401) return null; throw e; });
    },
    listUsers: function () {
      if (!API()) return ok(USERS.slice());
      return SR.get('/api/users').then(function (rows) {
        (rows || []).forEach(A.user);
        return USERS.slice();
      });
    },
    getUser: function (username) {
      if (!API()) return ok(ROSTER[username] || null);
      if (ROSTER[username]) return ok(ROSTER[username]);
      return SR.get('/api/users/' + encodeURIComponent(username)).then(A.user, function () { return null; });
    },

    /* ---- projects ------------------------------------------------------ */
    /* The projects dashboard rolls every step under every show up into one RAG
       (components.js projectRollup), so the list read carries the steps too —
       one extra GET for the whole board rather than N per-show fetches. */
    listProjects: function () {
      if (!API()) return ok(PROJECTS.map(hydrateProject));
      return Promise.all([SR.get('/api/projects'), SR.get('/api/steps')]).then(function (r) {
        var byShow = {};
        (r[1] || []).forEach(function (s) { A.step(s); (byShow[s.show_id] = byShow[s.show_id] || []).push(s); });
        return (r[0] || []).map(function (p) {
          var rec = A.project(p);
          (rec.shows || []).forEach(function (s) { s.steps = byShow[s.id] || s.steps || []; });
          return rec;
        });
      });
    },
    getProject: function (id) {
      if (!API()) {
        var p = PROJECTS_BY_ID[Number(id)];
        return p ? ok(hydrateProject(p)) : fail('project ' + id + ' not found');
      }
      return SR.get('/api/projects/' + Number(id)).then(A.project);
    },

    /* ---- shows --------------------------------------------------------- */
    listShows: function (projectId) {
      if (!API()) {
        if (projectId == null) return ok(ALL_SHOWS.map(hydrateShow));
        var p = PROJECTS_BY_ID[Number(projectId)];
        return p ? ok(p.shows.map(hydrateShow)) : fail('project ' + projectId + ' not found');
      }
      return fetchShows(projectId);
    },
    getShow: function (id) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(id)];
        return s ? ok(hydrateShow(s)) : fail('show ' + id + ' not found');
      }
      return fetchShow(id);
    },
    /* the auto-collapse rule lives here so every caller agrees on it */
    resolveFolder: function (projectId) {
      if (!API()) {
        var p = PROJECTS_BY_ID[Number(projectId)];
        if (!p) return fail('project ' + projectId + ' not found');
        return ok({ project: hydrateProject(p), single: p.shows.length === 1,
                    show: p.shows.length === 1 ? hydrateShow(p.shows[0]) : null });
      }
      return SR.get('/api/projects/' + Number(projectId) + '/folder').then(function (f) {
        A.project(f.project);
        if (f.show) A.show(f.show);
        return f;
      });
    },

    /* ---- jobs (commercial dimension) ----------------------------------- */
    listJobs: function (projectId) {
      if (!API()) {
        if (projectId == null) return ok(ALL_JOBS.slice());
        var p = PROJECTS_BY_ID[Number(projectId)];
        return p ? ok((p.jobs || []).slice()) : fail('project ' + projectId + ' not found');
      }
      return SR.get('/api/jobs' + SR.qs({ project_id: projectId == null ? null : Number(projectId) }))
        .then(function (rows) { return (rows || []).map(A.job); });
    },
    getJob: function (id) {
      if (!API()) return ok(JOBS_BY_ID[Number(id)] || null);
      return SR.get('/api/jobs/' + Number(id)).then(A.job, function () { return null; });
    },
    /* which job does this cost-bearing item bill to? item override > show default */
    resolveJob: function (item, show) {
      var jid = (item && item.job_id) || (show && show.default_job_id) || null;
      if (!jid) return ok(null);
      if (JOBS_BY_ID[jid]) return ok(JOBS_BY_ID[jid]);
      if (!API()) return ok(null);
      return api.getJob(jid);
    },

    /* ---- steps --------------------------------------------------------- */
    listSteps: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(s.steps.slice()) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/steps' + SR.qs({ show_id: Number(showId) }))
        .then(function (rows) { return (rows || []).map(A.step); });
    },
    getStep: function (id) {
      if (!API()) return ok(STEPS_BY_ID[Number(id)] || null);
      return SR.get('/api/steps/' + Number(id)).then(A.step, function () { return null; });
    },
    /* ALL step mutations go by step id — never (event, lane, arrayIndex) */
    updateStep: function (id, patch) {
      if (!API()) {
        var st = STEPS_BY_ID[Number(id)];
        if (!st) return fail('step ' + id + ' not found');
        Object.keys(patch || {}).forEach(function (k) { st[k] = patch[k]; });
        return ok(st);
      }
      return SR.put('/api/steps/' + Number(id), patch || {}).then(A.step);
    },
    setStepStatus: function (id, status) {
      if (!API()) {
        var st = STEPS_BY_ID[Number(id)];
        if (!st) return fail('step ' + id + ' not found');
        st.status = normStatus(status);
        return ok(st);
      }
      return SR.put('/api/steps/' + Number(id) + '/status', { status: normStatus(status) }).then(A.step);
    },
    assignStep: function (id, username) {
      if (!API()) {
        var st = STEPS_BY_ID[Number(id)];
        if (!st) return fail('step ' + id + ' not found');
        st.owner = username || null;
        return ok(st);
      }
      return SR.put('/api/steps/' + Number(id) + '/assign', { owner: username || '' }).then(A.step);
    },
    myOpenSteps: function (username) {
      if (!API()) {
        var who = username || ME, out = [];
        ALL_SHOWS.forEach(function (s) {
          s.steps.forEach(function (st) {
            if (st.owner === who && normStatus(st.status) !== 'done' && normStatus(st.status) !== 'na') {
              out.push({ show: hydrateShow(s), step: st });
            }
          });
        });
        return ok(out);
      }
      /* the server returns flat steps with a show stub; the views want the
         {show, step} pair the mock produced, with a real show record. */
      return Promise.all([
        SR.get('/api/my-steps' + SR.qs({ username: username || null })),
        ALL_SHOWS.length ? ok(null) : fetchShows(null)
      ]).then(function (r) {
        return (r[0] || []).filter(function (x) { return x.show; }).map(function (x) {
          var stub = x.show;
          var step = A.step(x);
          delete step.show;
          return { show: SHOWS_BY_ID[stub.id] || stub, step: step };
        });
      });
    },

    /* ---- files --------------------------------------------------------- */
    listFiles: function (showId) {
      if (!API()) {
        if (showId == null) {
          var all = [];
          ALL_SHOWS.forEach(function (s) { s.files.forEach(function (f) { all.push(f); }); });
          return ok(all);
        }
        var sh = SHOWS_BY_ID[Number(showId)];
        return sh ? ok(sh.files.slice()) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/files' + SR.qs({ show_id: showId == null ? null : Number(showId), limit: 1000 }))
        .then(function (rows) { return (rows || []).map(A.file); });
    },
    getFile: function (id) {
      if (!API()) return ok(FILES_BY_ID[Number(id)] || null);
      return SR.get('/api/files/' + Number(id)).then(A.file, function () { return null; });
    },
    addFile: function (showId, body) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var f = mkFile({
          name: body.name, ext: body.ext, kind: body.kind, spec_type: body.spec_type,
          artifact: body.artifact, ver: body.ver, size: body.size, dim: body.dim,
          by: body.by || ME, off: 0, meta: body.meta, chain: body.chain_key
        });
        f.show_id = s.id; f.project_id = s.project_id;
        if (body.attached_to) f.attached_to = body.attached_to;
        FILES_BY_ID[f.id] = f;
        if (body.unshift) s.files.unshift(f); else s.files.push(f);
        return ok(f);
      }
      var b = {}; Object.keys(body || {}).forEach(function (k) { b[k] = body[k]; });
      b.show_id = Number(showId);
      delete b.unshift; delete b.by;
      return SR.post('/api/files', b, { notifyOk: true }).then(function (r) {
        var f = A.file(r && r.file ? r.file : r);
        var s2 = SHOWS_BY_ID[Number(showId)];
        if (s2 && s2.files) { if (body && body.unshift) s2.files.unshift(f); else s2.files.push(f); }
        return f;
      });
    },
    replaceChainFile: function (showId, chainKey, body) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        s.files = s.files.filter(function (f) { return f.chain_key !== chainKey; });
        body.chain_key = chainKey;
        return api.addFile(showId, body);
      }
      var b = {}; Object.keys(body || {}).forEach(function (k) { b[k] = body[k]; });
      b.chain_key = chainKey; b.replace_chain = true;
      return api.addFile(showId, b);
    },

    /* ---- bookings ------------------------------------------------------ */
    listBookings: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(s.bookings.slice()) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/bookings' + SR.qs({ show_id: Number(showId) }))
        .then(function (rows) { return (rows || []).map(A.booking); });
    },
    getBooking: function (id) {
      if (!API()) return ok(BOOKINGS_BY_ID[Number(id)] || null);
      return SR.get('/api/bookings/' + Number(id)).then(A.booking, function () { return null; });
    },

    /* ---- proofs -------------------------------------------------------- */
    listProofs: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(s.proofs.slice()) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/proofs' + SR.qs({ show_id: Number(showId) }));
    },

    /* ---- activity ------------------------------------------------------ */
    listActivity: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(s.activity.slice()) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/activity' + SR.qs({ show_id: Number(showId), limit: 80 }));
    },

    /* ---- spec derivation chain (INTEGRATION.md part a) ------------------ */
    getChain: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(s.chain) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/shows/' + Number(showId) + '/chain').then(function (c) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (s) s.chain = c;
        return c;
      });
    },
    updateChainNode: function (showId, key, patch) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s || !s.chain[key]) return fail('chain node ' + key + ' not found');
        Object.keys(patch || {}).forEach(function (k) { s.chain[key][k] = patch[k]; });
        return ok(s.chain[key]);
      }
      /* the route answers with the WHOLE recomputed chain (its derived `stale`
         flags are the point), so cache that and hand back the one node */
      return SR.put('/api/shows/' + Number(showId) + '/chain/' + encodeURIComponent(key), patch || {}, { notifyOk: true })
        .then(function (r) {
          var chain = (r && r.chain) ? r.chain : r;
          var s = SHOWS_BY_ID[Number(showId)];
          if (chain && chain[key] && s) s.chain = chain;
          return chain && chain[key] ? chain[key] : r;
        });
    },

    /* ---- Flex gear state ----------------------------------------------- */
    getGear: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        if (!s.gear.kit) s.gear.kit = buildKit(s.cabinets || 72);
        return ok(s.gear);
      }
      return SR.get('/api/shows/' + Number(showId) + '/gear').then(function (g) {
        g = normGear(showId, g);
        var s = SHOWS_BY_ID[Number(showId)];
        if (s) s.gear = g;
        return g;
      });
    },
    updateGear: function (showId, patch) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        Object.keys(patch || {}).forEach(function (k) { s.gear[k] = patch[k]; });
        return ok(s.gear);
      }
      return SR.put('/api/shows/' + Number(showId) + '/gear', patch || {}).then(function (g) {
        g = normGear(showId, g);
        var s = SHOWS_BY_ID[Number(showId)];
        if (s) s.gear = g;
        return g;
      });
    },

    /* ---- templates ----------------------------------------------------- */
    /* The one real RESHAPE in the swap. The mock's record is
         {event_type, def:{label,tag,icon,anchor,lanes:[{key,label,color}]},
          steps:{<lane>:[{name,role,off,flag}]}, meta:{desc}}
       and the server serves template ROWS (flat `steps` array, `title` /
       `owner_role` / `due_offset_days` / `depends_on_title` / `auto_source`)
       plus a separate lane+type catalogue at GET /api/event-types. shapeTpl()
       below is the whole adapter; the template EDITOR is unchanged. */
    listTemplates: function () {
      if (!API()) {
        return ok(Object.keys(EVENT_TYPES).map(function (type) {
          return { event_type: type, def: typeDef(type),
                   steps: TEMPLATE_STEPS[type] || {}, meta: TEMPLATE_META[type] || { desc: 'Custom event type.' } };
        }));
      }
      return Promise.all([SR.get('/api/templates'), eventTypes()]).then(function (r) {
        var byType = {};
        (r[0] || []).forEach(function (t) { if (!byType[t.event_type]) byType[t.event_type] = t; });
        var keys = Object.keys(byType);
        (r[1].types || []).forEach(function (t) { if (keys.indexOf(t.key) < 0) keys.push(t.key); });
        return keys.map(function (type) { return shapeTpl(type, byType[type], r[1]); });
      });
    },
    getTemplate: function (type) {
      if (!API()) {
        return ok({ event_type: type, def: typeDef(type),
                    steps: TEMPLATE_STEPS[type] || {}, meta: TEMPLATE_META[type] || { desc: 'Custom event type.' } });
      }
      /* the route takes a type OR a numeric id (deviation 2) */
      return Promise.all([
        SR.get('/api/templates/' + encodeURIComponent(type)).then(null, function () { return null; }),
        eventTypes()
      ]).then(function (r) { return shapeTpl(type, r[0], r[1]); });
    },

    /* ---- push to scheduler --------------------------------------------- */
    pushToScheduler: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok({ dryRun: true, show: s.name }) : fail('show ' + showId + ' not found');
      }
      return SR.post('/api/shows/' + Number(showId) + '/push-to-scheduler', {});
    },

    /* ================= FINANCE ==========================================
       GET  /api/finance/feed        -> listFinanceFeed()
       GET  /api/finance/exceptions  -> listExceptions()
       GET  /api/jobs/:id/finance    -> getJobFinance(id)
       GET  /api/jobs/:id/budget     -> listBudgetLines(jobId)
       POST /api/expenses            -> addExpense(showId, body)
       POST /api/files (financial)   -> addFinancialDoc(showId, body)
       POST /api/proposals/:id/confirm|reject -> confirmDoc / rejectDoc
       ==================================================================== */
    listBudgetLines: function (jobId) {
      if (!API()) return ok((BUDGET_BY_JOB[Number(jobId)] || []).slice());
      return SR.get('/api/jobs/' + Number(jobId) + '/budget').then(function (rows) {
        return A.budget(Number(jobId), rows || []).slice();
      });
    },
    listExpenses: function (showId) {
      if (!API()) {
        if (showId == null) return ok(ALL_EXPENSES.slice());
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok((s.expenses || []).slice()) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/expenses' + SR.qs({ show_id: showId == null ? null : Number(showId) }))
        .then(function (rows) { return (rows || []).map(A.expense); });
    },
    getJobFinance: function (jobId) {
      if (!API()) {
        var jf = financeForJob(Number(jobId));
        return jf ? ok(jf) : fail('job ' + jobId + ' not found');
      }
      return SR.get('/api/jobs/' + Number(jobId) + '/finance').then(normJobFinance);
    },
    listFinanceFeed: function () {
      if (!API()) return ok(financeFeed());
      return SR.get('/api/finance/feed').then(normFeed);
    },
    listExceptions: function () {
      if (!API()) return ok(financeExceptions());
      return SR.get('/api/finance/exceptions').then(normExceptions).then(function (rows) { SR.exceptions(rows); return rows; });
    },
    getFinanceStats: function () {
      if (!API()) return ok(financeStats());
      return SR.get('/api/finance/stats');
    },
    /* one call for the Finance view — stats + chase list + feed + every job */
    getFinanceOverview: function () {
      if (!API()) {
        return ok({ stats: financeStats(), exceptions: financeExceptions(), feed: financeFeed(),
                    jobs: ALL_JOBS.map(function (j) { return financeForJob(j.id); }) });
      }
      return SR.get('/api/finance/overview').then(function (o) {
        (o.jobs || []).forEach(normJobFinance);
        SR.exceptions(normExceptions(o.exceptions));
        normFeed(o.feed);
        return o;
      });
    },

    /* POLISH_LIST #5. Write the real QuickBooks number onto a job that has been
       running on a TEMP placeholder. Accounting-owned: the server refuses
       anyone who is not an admin or does not carry the finance capability
       (routes/finance.js PUT /api/jobs/:id), and it writes the
       "job number confirmed X (was TEMP-…)" activity row itself.
       Nothing re-links — every reference in the schema is on the job id. */
    confirmJobNumber: function (jobId, number) {
      var num = String(number || '').trim();
      if (!num) return fail('a job number is required');
      if (!API()) {
        var j = JOBS_BY_ID[Number(jobId)];
        if (!j) return fail('job ' + jobId + ' not found');
        if (!canSeeFinance()) return fail('only accounting may set a QuickBooks job number');
        var was = j.qb_job_number;
        j.qb_job_number = num;
        j.qb_number_status = /^TEMP-\d{2}-\d{3,}$/.test(num) ? 'temp' : 'confirmed';
        if (was !== num && j.qb_number_status === 'confirmed') {
          var p = PROJECTS_BY_ID[j.project_id];
          if (p && p.activity) {
            p.activity.unshift(mkAct(ME, 'confirmed the job number',
              'job number confirmed ' + num + ' (was ' + was + ')', 0, _nowHM()));
          }
        }
        return ok(j);
      }
      return SR.put('/api/jobs/' + Number(jobId), { qb_job_number: num }).then(A.job);
    },

    /* record a cost against a show (job defaults to the show's, overridable).
       No doc attached yet -> it lands on accounting's "waiting on me" list. */
    addExpense: function (showId, body) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var e = mkExpense(s, body.category || 'misc', body.vendor || 'Vendor TBD',
          Number(body.amount) || 0, 0, { job: body.job_id ? Number(body.job_id) : null, by: body.by || ME, memo: body.memo || '' });
        e.show_id = s.id; e.project_id = s.project_id;
        EXPENSES_BY_ID[e.id] = e; ALL_EXPENSES.push(e);
        s.activity.unshift(mkAct(ME, 'recorded an expense', e.vendor + ' · ' + (BUDGET_CATS[e.budget_line_category] || e.budget_line_category), 0, _nowHM()));
        return ok(e);
      }
      var b = {}; Object.keys(body || {}).forEach(function (k) { b[k] = body[k]; });
      b.show_id = Number(showId);
      if (b.category && !b.budget_line_category) b.budget_line_category = b.category;
      delete b.by;
      return SR.post('/api/expenses', b, { notifyOk: true }).then(function (r) { return A.expense(r && r.expense ? r.expense : r); });
    },

    /* file a receipt/invoice/po/confirmation. With an amount it ALSO creates
       the expense row (the server does this in one transaction; see
       routes/files.js POST /api/files). Passing expense_id / booking_id /
       po_id instead attaches it as that item's missing paperwork. */
    addFinancialDoc: function (showId, body) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var linkExp = body.expenseId ? EXPENSES_BY_ID[Number(body.expenseId)] : null;
        var linkBk = body.bookingId ? BOOKINGS_BY_ID[Number(body.bookingId)] : null;
        var linkPo = body.poId ? POS_BY_ID[Number(body.poId)] : null;
        var vendor = body.vendor || (linkExp && linkExp.vendor) || (linkBk && linkBk.vendor) || (linkPo && linkPo.vendor) || 'Vendor TBD';
        var amount = body.amount != null ? Number(body.amount)
          : (linkExp ? linkExp.amount : (linkBk ? linkBk.amount : (linkPo ? poTotal(linkPo) : null)));
        var kindLbl = { receipt: 'receipt', invoice: 'invoice', po: 'purchase order', confirmation: 'confirmation' }[body.kind] || 'doc';
        var f = mkFile({ name: vendor + ' — ' + kindLbl, ext: 'pdf', kind: body.kind, size: 245760,
          by: ME, off: 0, meta: 'filed ' + TODAY_ISO + ' · modeled' + (linkPo ? ' · ' + linkPo.po_number : ''),
          amount: amount, vendor: vendor, doc_date: TODAY_ISO,
          job_id: body.job_id ? Number(body.job_id) : (linkExp ? linkExp.job_id : (linkBk ? linkBk.job_id : (linkPo ? linkPo.job_id : null))) });
        f.show_id = s.id; f.project_id = s.project_id;
        FILES_BY_ID[f.id] = f;
        s.files.unshift(f);
        if (linkPo) {
          /* PO paperwork — never a second expense: the PO owns its cost rows */
          if (body.kind === 'invoice') {
            linkPo.invoice_file_id = f.id;
            (PO_LINES_BY_PO[linkPo.id] || []).forEach(function (l) {
              if (!l.expense_id) return;
              var le = EXPENSES_BY_ID[l.expense_id];
              if (le && !le.file_id) le.file_id = f.id;      /* evidence the actuals */
            });
            if (linkPo.status === 'received') {
              linkPo.status = 'reconciled';
              linkPo.activity.unshift(mkAct(ME, 'reconciled ' + linkPo.po_number, 'vendor invoice on file — closed out', 0, _nowHM(), true));
            } else {
              linkPo.activity.unshift(mkAct(ME, 'attached the vendor invoice to ' + linkPo.po_number, 'reconciles on receipt', 0, _nowHM()));
            }
          } else {
            if (!linkPo.quote_file_id) linkPo.quote_file_id = f.id;
            linkPo.activity.unshift(mkAct(ME, 'attached a ' + kindLbl + ' to ' + linkPo.po_number, vendor, 0, _nowHM()));
          }
        } else if (linkExp) {
          linkExp.file_id = f.id;                         /* clears its exception */
        } else if (linkBk) {
          linkBk.file_id = f.id;                          /* clears its exception */
          if (amount) {
            var be = mkExpense(s, body.category || 'misc', vendor, amount, 0, { job: linkBk.job_id || null, file: f.id, by: ME });
            be.show_id = s.id; be.project_id = s.project_id;
            EXPENSES_BY_ID[be.id] = be; ALL_EXPENSES.push(be);
          }
        } else if (amount) {
          var ne = mkExpense(s, body.category || 'misc', vendor, amount, 0, { job: f.job_id, file: f.id, by: ME });
          ne.show_id = s.id; ne.project_id = s.project_id;
          EXPENSES_BY_ID[ne.id] = ne; ALL_EXPENSES.push(ne);
        }
        s.activity.unshift(mkAct(ME, 'filed a ' + kindLbl, vendor + (amount ? ' · $' + Number(amount).toLocaleString('en-US') : ''), 0, _nowHM(), true));
        return ok(f);
      }
      /* API: POST /api/files does the whole thing in one transaction */
      var kindLbl2 = { receipt: 'receipt', invoice: 'invoice', po: 'purchase order', confirmation: 'confirmation' }[body.kind] || 'doc';
      var b = {
        show_id: Number(showId),
        kind: body.kind,
        ext: body.ext || 'pdf',
        name: body.name || ((body.vendor || 'Vendor TBD') + ' — ' + kindLbl2),
        vendor: body.vendor || null,
        amount: body.amount != null ? Number(body.amount) : null,
        doc_date: body.doc_date || TODAY_ISO,
        size: body.size || 245760,
        category: body.category || null,
        job_id: body.job_id != null ? Number(body.job_id) : null,
        expense_id: body.expenseId != null ? Number(body.expenseId) : (body.expense_id != null ? Number(body.expense_id) : null),
        booking_id: body.bookingId != null ? Number(body.bookingId) : (body.booking_id != null ? Number(body.booking_id) : null),
        po_id: body.poId != null ? Number(body.poId) : (body.po_id != null ? Number(body.po_id) : null)
      };
      Object.keys(b).forEach(function (k) { if (b[k] === null || b[k] === undefined) delete b[k]; });
      b.show_id = Number(showId);
      return SR.post('/api/files', b, { notifyOk: true }).then(function (r) {
        var f = A.file(r && r.file ? r.file : r);
        if (r && r.expense) A.expense(r.expense);
        var s2 = SHOWS_BY_ID[Number(showId)];
        if (s2 && s2.files) s2.files.unshift(f);
        return f;
      });
    },

    /* human review of an agent proposal — "file, don't fire" made a UI.
       DEVIATION 1: the caller holds a FILE id; the server resolves a PROPOSAL
       through GET /api/files/:id/proposal. */
    confirmDoc: function (fileId) {
      if (!API()) {
        var f = FILES_BY_ID[Number(fileId)];
        if (!f) return fail('file ' + fileId + ' not found');
        var s = SHOWS_BY_ID[f.show_id];
        f.status = 'filed';
        if (f.meta === 'awaiting review') f.meta = 'confirmed ' + TODAY_ISO;
        (s.expenses || []).forEach(function (e) { if (e.file_id === f.id) e.status = 'filed'; });
        s.activity.unshift(mkAct(ME, 'confirmed a proposed ' + f.kind, (f.vendor || f.name), 0, _nowHM(), true));
        return ok(f);
      }
      return proposalIdFor(fileId)
        .then(function (pid) { return SR.post('/api/proposals/' + pid + '/confirm', {}, { notifyOk: true }); })
        .then(function (r) {
          if (r && r.expense) A.expense(r.expense);
          if (r && r.file) return A.file(r.file);
          return SR.get('/api/files/' + Number(fileId)).then(A.file, function () { return null; });
        });
    },
    rejectDoc: function (fileId) {
      if (!API()) {
        var f = FILES_BY_ID[Number(fileId)];
        if (!f) return fail('file ' + fileId + ' not found');
        var s = SHOWS_BY_ID[f.show_id];
        s.files = s.files.filter(function (x) { return x.id !== f.id; });
        delete FILES_BY_ID[f.id];
        var dropped = (s.expenses || []).filter(function (e) { return e.file_id === f.id; });
        s.expenses = (s.expenses || []).filter(function (e) { return e.file_id !== f.id; });
        dropped.forEach(function (e) {
          delete EXPENSES_BY_ID[e.id];
          var i = ALL_EXPENSES.indexOf(e);
          if (i >= 0) ALL_EXPENSES.splice(i, 1);
        });
        s.activity.unshift(mkAct(ME, 'rejected a proposed ' + f.kind, (f.vendor || f.name), 0, _nowHM()));
        return ok({ ok: true, show_id: s.id, name: f.vendor || f.name });
      }
      var cached = FILES_BY_ID[Number(fileId)] || {};
      var showId = cached.show_id || null, label = cached.vendor || cached.name || 'the document';
      return proposalIdFor(fileId)
        .then(function (pid) { return SR.post('/api/proposals/' + pid + '/reject', {}, { noNotify: true }); })
        .then(function () {
          /* the row survives as `rejected`; drop it from the local cache so the
             view stops offering it (the server filters it out of every list) */
          var f = FILES_BY_ID[Number(fileId)];
          if (f) {
            delete FILES_BY_ID[Number(fileId)];
            var s = SHOWS_BY_ID[f.show_id];
            if (s && s.files) s.files = s.files.filter(function (x) { return x.id !== f.id; });
          }
          return { ok: true, show_id: showId, name: label };
        });
    },

    /* ================= PURCHASING =======================================
       GET  /api/pos                 -> listPOs(filters)
       GET  /api/pos/:id             -> getPO(id)
       POST /api/pos                 -> createPO(body)
       PUT  /api/pos/:id/status      -> updatePOStatus(id, status)   [gated]
       POST /api/pos/:id/approve     -> approvePO(id)   [admins + Candice]
       POST /api/pos/:id/lines       -> addPOLine(id, body)
       GET  /api/procurement/risks   -> listProcurementRisks()
       GET  /api/jobs/:id/committed  -> listCommitted(jobId)
       ==================================================================== */
    listPOs: function (filters) {
      filters = filters || {};
      if (!API()) {
        var out = ALL_POS.filter(function (po) {
          if (filters.status && po.status !== filters.status) return false;
          if (filters.projectId && po.project_id !== Number(filters.projectId)) return false;
          if (filters.jobId && !(PO_LINES_BY_PO[po.id] || []).some(function (l) { return poLineJobId(l) === Number(filters.jobId); })) return false;
          if (filters.showId && !(PO_LINES_BY_PO[po.id] || []).some(function (l) { return l.show_id === Number(filters.showId); })) return false;
          return true;
        });
        return ok(out.slice());
      }
      return SR.get('/api/pos' + SR.qs({ status: filters.status, projectId: filters.projectId,
                                         jobId: filters.jobId, showId: filters.showId, limit: 500 }))
        .then(function (rows) { return (rows || []).map(A.po); });
    },
    getPO: function (id) {
      if (!API()) {
        var po = POS_BY_ID[Number(id)];
        return po ? ok(po) : fail('PO ' + id + ' not found');
      }
      return SR.get('/api/pos/' + Number(id)).then(A.po);
    },
    /* one call for the Purchasing view — stats + board + risks + queue */
    getPurchasingOverview: function () {
      if (!API()) {
        return ok({ stats: purchasingStats(), pos: ALL_POS.slice(), risks: listAllPoRisks(),
                    approvals: ALL_POS.filter(function (po) { return po.status === 'quoted' && poNeedsApproval(po); }) });
      }
      return syncPoThreshold().then(function () {
        return SR.get('/api/purchasing/overview');
      }).then(function (o) {
        (o.pos || []).forEach(A.po);
        (o.approvals || []).forEach(A.po);
        (o.risks || []).forEach(function (r) { if (r && r.po) A.po(r.po); });
        return o;
      });
    },
    listProcurementRisks: function () {
      if (!API()) return ok(listAllPoRisks());
      return SR.get('/api/procurement/risks').then(function (rows) {
        (rows || []).forEach(function (r) { if (r && r.po) A.po(r.po); });
        return rows;
      });
    },
    listCommitted: function (jobId) {
      if (!API()) return ok(committedForJob(Number(jobId)));
      return SR.get('/api/jobs/' + Number(jobId) + '/committed');
    },

    createPO: function (body) {
      if (!API()) {
        var p = PROJECTS_BY_ID[Number(body.project_id)];
        if (!p) return fail('project ' + body.project_id + ' not found');
        var po = mkPO({ num: 'PO-26-0' + (50 + _poSeq), vendor: body.vendor || 'TBD',
          project: p.id, job: body.job_id ? Number(body.job_id) : null,
          status: 'needed', by: ME, memo: body.memo || '' });
        po.activity.unshift(mkAct(ME, 'opened ' + po.po_number, 'needed — add lines, then quote it out', 0, _nowHM()));
        return ok(po);
      }
      return SR.post('/api/pos', body || {}, { notifyOk: true }).then(A.po);
    },
    addPOLine: function (poId, body) {
      if (!API()) {
        var po = POS_BY_ID[Number(poId)];
        if (!po) return fail('PO ' + poId + ' not found');
        if (!body.item || !(Number(body.qty) > 0)) return fail('a line needs an item and a quantity');
        var l = mkPOLine(po, { item: body.item, detail: body.detail || '',
          qty: Number(body.qty), unit: Number(body.unit_cost) || 0,
          category: body.category || 'gear',
          job: body.job_id ? Number(body.job_id) : null,
          show: body.show_id ? Number(body.show_id) : null,
          ownership: body.ownership === 'inventory' || body.ownership === 'cogs' ? body.ownership : null });
        po.activity.unshift(mkAct(ME, 'added a line to ' + po.po_number,
          l.item + ' · ' + l.qty + ' × $' + Number(l.unit_cost).toLocaleString('en-US'), 0, _nowHM()));
        return ok(l);
      }
      if (!body || !body.item || !(Number(body.qty) > 0)) return fail('a line needs an item and a quantity');
      return SR.post('/api/pos/' + Number(poId) + '/lines', body, { notifyOk: true }).then(function (r) {
        if (r && r.po) A.po(r.po);
        return r && r.line ? r.line : r;
      });
    },

    /* the approval gate lives on the SERVER — quoted cannot advance to ordered
       while the total is over the threshold and unapproved. Enforced, not
       advisory (same posture as the agent-API confidence bands). */
    updatePOStatus: function (id, status) {
      if (!API()) {
        var po = POS_BY_ID[Number(id)];
        if (!po) return fail('PO ' + id + ' not found');
        var from = PO_STATUSES.indexOf(po.status), to = PO_STATUSES.indexOf(status);
        if (to < 0) return fail('unknown PO status "' + status + '"');
        if (to !== from + 1) return fail(po.po_number + ' is ' + po.status + ' — advance one stage at a time');
        if (status === 'ordered' && poNeedsApproval(po)) {
          return fail(po.po_number + ' is over the $' + PO_APPROVAL_THRESHOLD.toLocaleString('en-US') +
            ' threshold — an admin or Candice must approve it before it can be ordered');
        }
        if (status === 'reconciled' && !po.invoice_file_id) {
          return fail('attach the vendor invoice to reconcile ' + po.po_number);
        }
        po.status = status;
        if (status === 'ordered') {
          if (!po.ordered_date) po.ordered_date = TODAY_ISO;
          if (!po.approval) po.approval = { required: false, threshold_exceeded: false, approved_by: null, approved_at: null };
        }
        if (status === 'received') {
          po.received_date = TODAY_ISO;
          var made = poGenerateExpenses(po, 0);
          if (po.invoice_file_id) po.status = 'reconciled';   /* invoice already on file */
          var ps = poPrimaryShow(po);
          if (ps) ps.activity.unshift(mkAct(ME, 'received ' + po.po_number, made.length
            ? made.length + ' cost line' + (made.length === 1 ? '' : 's') + ' now actuals'
            : '→ Flex inventory intake', 0, _nowHM(), true));
        }
        po.activity.unshift(mkAct(ME, 'marked ' + po.po_number + ' ' + (PO_STATUS_META[po.status] || {}).label,
          null, 0, _nowHM(), status === 'ordered' || status === 'received'));
        return ok(po);
      }
      return SR.put('/api/pos/' + Number(id) + '/status', { status: status }, { notifyOk: true })
        .then(function (r) { return A.po(r && r.po ? r.po : r); });
    },
    approvePO: function (id) {
      if (!API()) {
        var po = POS_BY_ID[Number(id)];
        if (!po) return fail('PO ' + id + ' not found');
        if (!poNeedsApproval(po)) return fail(po.po_number + ' has nothing awaiting approval');
        /* Tom's rule: the admins (Tom · Tony · Jim) + Candice via finance —
           not the generic manager+ predicate */
        if (!canApprovePOs(CURRENT_USER)) {
          return fail('PO approval sits with the admins — Tom, Tony, Jim — and Candice (finance)');
        }
        po.approval = { required: true, threshold_exceeded: true, approved_by: ME, approved_at: TODAY_ISO };
        po.activity.unshift(mkAct(ME, 'approved ' + po.po_number,
          'over the $' + PO_APPROVAL_THRESHOLD.toLocaleString('en-US') + ' threshold — cleared to order', 0, _nowHM(), true));
        return ok(po);
      }
      return SR.post('/api/pos/' + Number(id) + '/approve', {}, { notifyOk: true })
        .then(function (r) { return A.po(r && r.po ? r.po : r); });
    },

    /* ================= NOTES + @MENTIONS ================================
       GET  /api/notes?anchor_type=&anchor_id= -> listNotes(type, id)
       POST /api/notes               -> addNote(body)   [mentions parsed
                                        server-side; always filed, never
                                        proposed]
       PUT  /api/notes/:id           -> editNote(id, body) [author-only]
       GET  /api/me/inbox            -> myInbox()
       POST /api/me/inbox/read       -> markNotesRead(ids) / markAllNotesRead()
       ==================================================================== */
    listNotes: function (anchorType, anchorId) {
      if (!NOTE_ANCHORS[anchorType]) return fail('unknown note anchor "' + anchorType + '"');
      if (!API()) return ok(notesFor(anchorType, anchorId));
      return SR.get('/api/notes' + SR.qs({ anchor_type: anchorType, anchor_id: Number(anchorId) }))
        .then(function (threads) {
          (threads || []).forEach(function (t) {
            A.note(t.root);
            (t.replies || []).forEach(A.note);
          });
          return threads || [];
        });
    },
    /* post as CURRENT_USER. One level of replies — replying to a reply
       re-anchors onto its thread root, never deeper (server-enforced too). */
    addNote: function (body) {
      var t = body.anchor_type, id = Number(body.anchor_id);
      if (!NOTE_ANCHORS[t]) return fail('unknown note anchor "' + t + '"');
      var text = String(body.body || '').trim();
      if (!text) return fail('a note needs a body');
      if (!API()) {
        var parent = body.parent_id ? NOTES_BY_ID[Number(body.parent_id)] : null;
        if (body.parent_id && !parent) return fail('note ' + body.parent_id + ' not found');
        if (parent && parent.parent_id) parent = NOTES_BY_ID[parent.parent_id];
        var n = mkNote(t, id, body.author || ME, text, 0, _nowHM(), { parent: parent ? parent.id : null });
        markNoteRead(noteAuthorUser(n), n.id);       /* your own note is read */
        /* structured activity row — never duplicates the body */
        var a = noteAnchor(n);
        var detail = n.mentions.length ? '@ ' + n.mentions.map(firstName).join(', ') : null;
        if (t === 'po') {
          var po = POS_BY_ID[id];
          if (po) po.activity.unshift(mkAct(n.author, 'commented on ' + po.po_number, detail, 0, _nowHM()));
        } else if (a && a.show) {
          var lbl = t === 'show' ? (parent ? 'replied to a note on this show' : 'left a note on this show')
            : 'commented on ' + (t === 'step' ? '“' + a.label + '”' : a.label);
          a.show.activity.unshift(mkAct(n.author, lbl, detail, 0, _nowHM()));
        }
        /* job / project anchors have no activity surface yet — see report */
        return ok(n);
      }
      return SR.post('/api/notes', { anchor_type: t, anchor_id: id, body: text,
                                     parent_id: body.parent_id ? Number(body.parent_id) : null })
        .then(function (r) { return A.note(r && r.note ? r.note : r); });
    },
    editNote: function (id, body) {
      if (!API()) {
        var n = NOTES_BY_ID[Number(id)];
        if (!n) return fail('note ' + id + ' not found');
        if (n.kind === 'notify') return fail('a notification is a record — it cannot be edited');
        if (n.author !== ME) return fail('only the author can edit a note');
        var text = String(body || '').trim();
        if (!text) return fail('a note needs a body');
        n.body = text;
        n.mentions = parseMentions(text);            /* mentions re-parse on edit */
        n.edited_at = TODAY_ISO + 'T' + _nowHM();
        return ok(n);
      }
      var text2 = String(body || '').trim();
      if (!text2) return fail('a note needs a body');
      return SR.put('/api/notes/' + Number(id), { body: text2 }).then(A.note);
    },
    myInbox: function () {
      if (!API()) return ok({ items: noteInbox(ME), proposals: proposalsForUser(ME) });
      /* The bell renders a proposal as the DOCUMENT a human is being asked to
         confirm — the mock's `proposals` are file rows. The server's are
         proposal rows whose `created_rows.files` names the quarantined file,
         so fetch the proposed files alongside and hand the view the files. */
      return Promise.all([
        SR.get('/api/me/inbox'),
        SR.get('/api/files' + SR.qs({ status: 'proposed', limit: 200 })).then(null, function () { return []; })
      ]).then(function (r) {
        var inbox = r[0] || {};
        (inbox.items || []).forEach(function (x) {
          A.note(x.note);
          /* the mock's anchor carries the show object; the server sends its id */
          if (x.anchor && x.anchor.show_id && SHOWS_BY_ID[x.anchor.show_id]) x.anchor.show = SHOWS_BY_ID[x.anchor.show_id];
        });
        var proposed = (r[1] || []).map(A.file);
        var byId = {};
        proposed.forEach(function (f) { byId[f.id] = f; });
        var out = [];
        (inbox.proposals || []).forEach(function (p) {
          var ids = (p.created_rows && p.created_rows.files) || [];
          var f = null;
          for (var i = 0; i < ids.length && !f; i++) f = byId[ids[i]] || null;
          if (!f && p.payload) {
            /* nothing was materialised (the proposal is the whole record) —
               synthesise the minimum a bell row prints */
            f = A.file({ id: -p.id, kind: p.payload.kind || 'other', name: p.payload.name || (p.kind + ' proposal'),
                         vendor: p.payload.vendor || null, amount: p.payload.amount != null ? Number(p.payload.amount) : null,
                         show_id: p.show_id || null, project_id: p.project_id || null,
                         status: 'proposed', created_at: p.created_at, provenance: p.provenance || null,
                         meta: 'awaiting review', tags: [] });
          }
          if (f) { f.proposal_id = p.id; out.push(f); }
        });
        inbox.proposals = out;
        return inbox;
      });
    },
    /* draft recaps THIS person is the one to act on — the same predicate as
       the Approve button, so the bell and the button can never disagree */
    recapsAwaitingReview: function () {
      if (!API()) return ok(recapsAwaitingReview(ME));
      return SR.get('/api/me/recaps-awaiting-review')
        .then(function (rows) { return (rows || []).map(A.deliverable); },
              function () { return []; });
    },
    markNotesRead: function (ids) {
      if (!API()) {
        (ids || []).forEach(function (nid) { markNoteRead(ME, Number(nid)); });
        return ok({ ok: true });
      }
      return SR.post('/api/me/inbox/read', { ids: (ids || []).map(Number) }, { noNotify: true });
    },
    markAllNotesRead: function () {
      if (!API()) {
        noteInbox(ME).forEach(function (x) { markNoteRead(ME, x.note.id); });
        return ok({ ok: true });
      }
      return SR.post('/api/me/inbox/read', { all: true }, { noNotify: true });
    },
    notesUnreadCount: function () {
      if (!API()) {
        return ok({ unread: noteUnreadCount(ME), proposals: proposalsForUser(ME).length, badge: inboxBadgeCount(ME) });
      }
      return SR.get('/api/me/inbox/count', { quiet: true });
    },
    /* ---- notify-picker delivery (Tony's rule: the actor chooses) ----------
       DEMO: rides the local notes machinery — a system note (kind 'notify')
       that never renders in a thread.
       API : the picker's selection normally rides the mutation itself as
       `notify:[…]` (api.stageNotify). This method is the FALLBACK for actions
       whose mutation did not carry it: an anchored note carrying the @handles,
       which is exactly what the server's own notify does. `to` empty delivers
       NOTHING — routine work stays silent; there is no broadcast path. */
    notify: function (body) {
      body = body || {};
      var to = (body.to || []).filter(function (u, i, a) {
        return (API() ? true : !!ROSTER[u]) && u !== ME && a.indexOf(u) === i;
      });
      if (!to.length) return ok({ ok: true, delivered: 0, note: null });
      var t = body.anchor_type, id = Number(body.anchor_id);
      if (!NOTE_ANCHORS[t]) return fail('unknown note anchor "' + t + '"');
      var text = String(body.text || '').trim();
      if (!text) return fail('a notification needs text');
      if (!API()) {
        var n = mkNote(t, id, ME, text, 0, _nowHM(), { kind: 'notify', mentions: to });
        return ok({ ok: true, delivered: to.length, note: n });
      }
      var withHandles = text + ' ' + to.map(function (u) { return '@' + u; }).join(' ');
      return SR.post('/api/notes', { anchor_type: t, anchor_id: id, body: withHandles }, { noNotify: true })
        .then(function (r) {
          return { ok: true, delivered: to.length, note: A.note(r && r.note ? r.note : r) };
        });
    },

    /* ================= SCHEDULE (call sheet) ============================
       GET  /api/shows/:id/call-sheet  -> getSchedule(id)  [assembled sheet]
              (POLISH_LIST #1: this is the canonical path. The older
               /run-of-show path is a retained alias on the same handler; the
               name it uses is reserved for the future what-plays-when
               document and must not come back as UI copy.)
       GET  /api/shows/:id/schedule    -> the raw items, a DIFFERENT resource
       POST /api/shows/:id/schedule    -> addScheduleItem(showId, body) [pm+]
       PUT  /api/schedule/:id          -> updateScheduleItem(id, patch) [pm+]
       DELETE /api/schedule/:id        -> removeScheduleItem(id)        [pm+]
       ==================================================================== */
    getSchedule: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var items = scheduleForShow(s.id);
        var days = scheduleDays(s.id).map(function (d) {
          return { day: d, tag: schedDayTag(s, d),
                   items: items.filter(function (it) { return it.day === d; }) };
        });
        return ok({
          show: hydrateShow(s), days: days, schedule: items,
          crew: crewForShow(s.id),
          pocs: { onsite: ROSTER[s.on_site_poc] || null, venue: s.venue_poc || null, client: s.client_poc || null },
          /* weather is a placeholder until the backend proxies a forecast API */
          weather: { placeholder: true, summary: 'Forecast lands with the live backend' }
        });
      }
      return SR.get('/api/shows/' + Number(showId) + '/call-sheet').then(function (r) {
        (r.schedule || []).forEach(A.sched);
        (r.crew || []).forEach(A.crew);
        if (r.pocs && r.pocs.onsite) A.user(r.pocs.onsite);
        /* the sheet header renders from the cached (fully hydrated) show when
           we have one — the route's show record is the thin row. */
        var cached = SHOWS_BY_ID[Number(showId)];
        if (r.show) { A.show(r.show); if (cached) r.show = cached; }
        if (r.show) r.show.schedule_items = r.schedule || [];
        return r;
      });
    },
    addScheduleItem: function (showId, body) {
      var title = String(body.title || '').trim();
      if (!title) return fail('a schedule item needs a title');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.day || ''))) return fail('a schedule item needs an ISO day');
      if (!/^\d{2}:\d{2}$/.test(String(body.start_time || ''))) return fail('a schedule item needs an HH:MM start time');
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        if (!SCHED_EDIT_ROLES[CURRENT_USER.role]) return fail('editing the schedule requires pm, manager or admin');
        if (!canEditFolderOf(s)) return fail('editing the schedule requires pm, manager or admin on this project');
        var it = mkSched(s, body.day, body.start_time, title, {
          end: body.end_time || null, detail: body.detail || '',
          who: body.who || 'all', location: body.location || '',
          kind: SCHED_KINDS[body.kind] ? body.kind : 'work'
        });
        s.activity.unshift(mkAct(ME, 'added to the schedule', title + ' · ' + body.start_time, 0, _nowHM()));
        return ok(it);
      }
      return SR.post('/api/shows/' + Number(showId) + '/schedule', {
        day: body.day, start_time: body.start_time, end_time: body.end_time || null,
        title: title, detail: body.detail || '', who: body.who || 'all',
        location: body.location || '', kind: SCHED_KINDS[body.kind] ? body.kind : 'work'
      }, { notifyOk: true }).then(function (r) { return A.sched(r && r.item ? r.item : r); });
    },
    updateScheduleItem: function (id, patch) {
      patch = patch || {};
      if (patch.title !== undefined && !String(patch.title).trim()) return fail('a schedule item needs a title');
      if (patch.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.day))) return fail('day must be ISO');
      if (patch.start_time !== undefined && !/^\d{2}:\d{2}$/.test(String(patch.start_time))) return fail('start time must be HH:MM');
      if (patch.kind !== undefined && !SCHED_KINDS[patch.kind]) return fail('unknown schedule kind "' + patch.kind + '"');
      if (!API()) {
        var it = SCHEDULE_BY_ID[Number(id)];
        if (!it) return fail('schedule item ' + id + ' not found');
        if (!SCHED_EDIT_ROLES[CURRENT_USER.role]) return fail('editing the schedule requires pm, manager or admin');
        if (!canEditFolderOf(s)) return fail('editing the schedule requires pm, manager or admin on this project');
        ['day', 'start_time', 'end_time', 'title', 'detail', 'who', 'location', 'kind'].forEach(function (k) {
          if (patch[k] !== undefined) it[k] = patch[k];
        });
        var s = SHOWS_BY_ID[it.show_id];
        if (s) s.activity.unshift(mkAct(ME, 'updated the schedule', it.title + ' · ' + it.start_time, 0, _nowHM()));
        return ok(it);
      }
      return SR.put('/api/schedule/' + Number(id), patch, { notifyOk: true }).then(function (r) { return A.sched(r && r.item ? r.item : r); });
    },
    removeScheduleItem: function (id) {
      if (!API()) {
        var it = SCHEDULE_BY_ID[Number(id)];
        if (!it) return fail('schedule item ' + id + ' not found');
        if (!SCHED_EDIT_ROLES[CURRENT_USER.role]) return fail('editing the schedule requires pm, manager or admin');
        if (!canEditFolderOf(s)) return fail('editing the schedule requires pm, manager or admin on this project');
        var s = SHOWS_BY_ID[it.show_id];
        if (s) {
          s.schedule_items = s.schedule_items.filter(function (x) { return x.id !== it.id; });
          s.activity.unshift(mkAct(ME, 'removed from the schedule', it.title, 0, _nowHM()));
        }
        delete SCHEDULE_BY_ID[it.id];
        return ok({ ok: true, show_id: it.show_id });
      }
      var cachedIt = SCHEDULE_BY_ID[Number(id)] || {};
      var sid = cachedIt.show_id || null;
      return SR.del('/api/schedule/' + Number(id), null, { notifyOk: true }).then(function (r) {
        delete SCHEDULE_BY_ID[Number(id)];
        var s = SHOWS_BY_ID[sid];
        if (s && s.schedule_items) s.schedule_items = s.schedule_items.filter(function (x) { return x.id !== Number(id); });
        return { ok: true, show_id: (r && r.show_id) || sid };
      });
    },

    /* ================= EVENT PHOTOS =====================================
       GET  /api/shows/:id/photos    -> listPhotos(showId)
       GET  /api/photos?…            -> listAllPhotos(filters)
       PUT  /api/photos/:id          -> updatePhoto(id, {caption, tags})
       PUT  /api/photos/:id/pick     -> setRecapPick(id, bool)  [pm+]
       POST /api/proposals/:id/confirm|reject -> confirmPhoto / rejectPhoto
       ==================================================================== */
    listPhotos: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(photosForShow(s.id)) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/shows/' + Number(showId) + '/photos')
        .then(function (rows) { return (rows || []).map(A.file); });
    },
    listAllPhotos: function (filters) {
      filters = filters || {};
      if (!API()) {
        var out = [];
        ALL_SHOWS.forEach(function (s) {
          if (filters.showId && s.id !== Number(filters.showId)) return;
          photosForShow(s.id).forEach(function (f) {
            if (filters.tag && (f.tags || []).indexOf(filters.tag) < 0) return;
            if (filters.pick && !f.recap_pick) return;
            if (filters.status && f.status !== filters.status) return;
            out.push(f);
          });
        });
        out.sort(function (a, b) { return a.taken_at < b.taken_at ? 1 : a.taken_at > b.taken_at ? -1 : b.id - a.id; });
        return ok(out);
      }
      return SR.get('/api/photos' + SR.qs({ show_id: filters.showId, tag: filters.tag,
                                            pick: filters.pick ? 1 : null, status: filters.status, limit: 500 }))
        .then(function (rows) { return (rows || []).map(A.file); });
    },
    updatePhoto: function (id, patch) {
      patch = patch || {};
      var bad = Object.keys(patch).filter(function (k) { return k !== 'caption' && k !== 'tags'; });
      if (bad.length) return fail('"' + bad[0] + '" is not editable on a photo — caption and tags only');
      if (patch.caption !== undefined && !String(patch.caption).trim()) return fail('a photo needs a caption');
      if (patch.tags !== undefined && Object.prototype.toString.call(patch.tags) !== '[object Array]') {
        return fail('tags must be an array');
      }
      if (!API()) {
        var f = FILES_BY_ID[Number(id)];
        if (!f || f.kind !== 'photo') return fail('photo ' + id + ' not found');
        if (!canEditPhoto(f)) return fail('editing a photo requires pm, manager, admin — or its uploader');
        if (patch.caption !== undefined) f.caption = String(patch.caption).trim();
        if (patch.tags !== undefined) {
          f.tags = patch.tags.map(function (t) { return String(t).toLowerCase().trim(); }).filter(Boolean);
        }
        var s = SHOWS_BY_ID[f.show_id];
        if (s) s.activity.unshift(mkAct(ME, 'edited a photo caption', String(f.caption).slice(0, 64), 0, _nowHM()));
        return ok(f);
      }
      return SR.put('/api/photos/' + Number(id), patch, { notifyOk: true })
        .then(function (r) { return A.file(r && r.photo ? r.photo : r); });
    },
    /* the curation flag the post-event recap consumes ("picks") */
    setRecapPick: function (id, on) {
      if (!API()) {
        var f = FILES_BY_ID[Number(id)];
        if (!f || f.kind !== 'photo') return fail('photo ' + id + ' not found');
        if (!PH_EDIT_ROLES[CURRENT_USER.role]) return fail('curating recap picks requires pm, manager or admin');
        f.recap_pick = !!on;
        var s = SHOWS_BY_ID[f.show_id];
        if (s) s.activity.unshift(mkAct(ME, on ? 'starred a photo for the client recap' : 'removed a photo from the recap picks',
          String(f.caption || f.name).slice(0, 64), 0, _nowHM(), !!on));
        return ok(f);
      }
      return SR.put('/api/photos/' + Number(id) + '/pick', { on: !!on }, { notifyOk: true })
        .then(function (r) { return A.file(r && r.photo ? r.photo : r); });
    },
    /* proposed photos ride the SAME review machinery as proposed docs */
    confirmPhoto: function (fileId) {
      var f = FILES_BY_ID[Number(fileId)];
      if (!API()) {
        if (!f || f.kind !== 'photo') return fail('photo ' + fileId + ' not found');
        if (f.status !== 'proposed') return fail(f.name + ' is already filed');
      } else if (f && f.status && f.status !== 'proposed') {
        return fail(f.name + ' is already filed');
      }
      return api.confirmDoc(Number(fileId));
    },
    rejectPhoto: function (fileId) {
      var f = FILES_BY_ID[Number(fileId)];
      if (!API()) {
        if (!f || f.kind !== 'photo') return fail('photo ' + fileId + ' not found');
        if (f.status !== 'proposed') return fail(f.name + ' is already filed — rejecting is for proposals');
      } else if (f && f.status && f.status !== 'proposed') {
        return fail(f.name + ' is already filed — rejecting is for proposals');
      }
      return api.rejectDoc(Number(fileId));
    },

    /* ================= CLIENT RECAP =====================================
       GET  /api/shows/:id/deliverables -> getDeliverables(showId)
       GET  /api/shows/:id/recap        -> getRecap(showId)
       POST /api/shows/:id/recap        -> generateRecap(showId)   [pm+]
       PUT  /api/shows/:id/recap        -> updateRecap(showId, patch) [pm+ ·
                                           draft only · firewall-checked]
       POST /api/shows/:id/recap/approve|reopen|sent

       markSent SENDS NOTHING, in either mode. There is no outbound path in
       this app — not for an agent (AGENT_API §9) and not for a person. It
       records that a human sent it, and logs that.
       ==================================================================== */
    getDeliverables: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(deliverablesForShow(s.id)) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/shows/' + Number(showId) + '/deliverables')
        .then(function (rows) { return (rows || []).map(A.deliverable); });
    },
    getRecap: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        return s ? ok(recapForShow(s.id)) : fail('show ' + showId + ' not found');
      }
      return SR.get('/api/shows/' + Number(showId) + '/recap').then(unwrapRecap);
    },

    generateRecap: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        if (!RECAP_EDIT_ROLES[CURRENT_USER.role]) return fail('drafting a client recap requires pm, manager or admin');
        if (!canApproveRecapFor(s, ME)) return fail('drafting a client recap on this show requires manager, admin — or the show’s own owner');
        var rec = recapForShow(s.id);
        if (rec && rec.status !== 'draft') {
          return fail('this recap is already ' + rec.status + ' — reopen it before regenerating');
        }
        var body = buildRecapDraft(s);            /* the firewalled generator */
        var again = !!rec;
        if (rec) {
          /* idempotent: same show, same record -> same body, same row. A
             regenerate is a REPLACE — it discards human edits on purpose. */
          rec.body = body;
          rec.generated_by = 'agent:' + s.owner;
          rec.generated_at = TODAY_ISO + 'T' + _nowHM();
          rec.edited_by = null; rec.edited_at = null;
          rec.provenance = recapProvenance(s, s.owner);
        } else {
          rec = mkDeliverable(s, body, { off: 0, time: _nowHM() });
        }
        s.activity.unshift(mkAct('agent:' + s.owner, (again ? 'regenerated' : 'drafted') + ' the post-event client recap',
          body.highlights.length + ' highlights · ' + body.photo_ids.length + ' photos · awaiting review', 0, _nowHM(), true));
        return ok(rec);
      }
      return SR.post('/api/shows/' + Number(showId) + '/recap', {}).then(unwrapRecap);
    },

    /* edit the body while it is a draft. EVERY string goes through the
       content firewall (lib/firewall.js server-side, recapUnsafe in the demo)
       — a human who pastes an internal number is refused with the reason, not
       silently scrubbed. */
    updateRecap: function (showId, patch) {
      patch = patch || {};
      var allowed = { headline: 1, narrative: 1, highlights: 1, stats: 1, photo_ids: 1, closing: 1 };
      var bad = Object.keys(patch).filter(function (k) { return !allowed[k]; });
      if (bad.length) return fail('"' + bad[0] + '" is not a recap section');

      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var rec = recapForShow(s.id);
        if (!rec) return fail('no recap on this show yet — generate one first');
        if (!RECAP_EDIT_ROLES[CURRENT_USER.role]) return fail('editing a client recap requires pm, manager or admin');
        if (!canApproveRecapFor(s, ME)) return fail('editing a client recap on this show requires manager, admin — or the show’s own owner');
        if (rec.status !== 'draft') return fail('this recap is ' + rec.status + ' — reopen it to edit');

        function guard(v, where) {
          var u = recapUnsafe(v);
          if (u) return where + ' cannot carry ' + u.why + ' (“' + u.match + '”) — a recap is client-facing';
          return null;
        }
        var err = null;
        if (patch.headline !== undefined) {
          if (!String(patch.headline).trim()) return fail('a recap needs a headline');
          err = guard(patch.headline, 'The headline');
        }
        if (!err && patch.closing !== undefined) {
          if (!String(patch.closing).trim()) return fail('a recap needs a closing');
          err = guard(patch.closing, 'The closing');
        }
        if (!err && patch.narrative !== undefined) {
          if (Object.prototype.toString.call(patch.narrative) !== '[object Array]' || !patch.narrative.length) {
            return fail('the narrative must be at least one paragraph');
          }
          patch.narrative.forEach(function (p, i) { if (!err) err = guard(p, 'Paragraph ' + (i + 1)); });
        }
        if (!err && patch.highlights !== undefined) {
          if (Object.prototype.toString.call(patch.highlights) !== '[object Array]') return fail('highlights must be a list');
          patch.highlights.forEach(function (h, i) { if (!err) err = guard(h, 'Highlight ' + (i + 1)); });
        }
        if (!err && patch.stats !== undefined) {
          if (Object.prototype.toString.call(patch.stats) !== '[object Array]') return fail('stats must be a list');
          patch.stats.forEach(function (st, i) {
            if (err) return;
            if (!st || !String(st.label || '').trim()) { err = 'Stat ' + (i + 1) + ' needs a label'; return; }
            err = guard(st.label, 'Stat ' + (i + 1) + '’s label') || guard(st.value, 'Stat ' + (i + 1) + '’s value');
          });
        }
        if (!err && patch.photo_ids !== undefined) {
          if (Object.prototype.toString.call(patch.photo_ids) !== '[object Array]') return fail('photo_ids must be a list');
          var okIds = patch.photo_ids.every(function (id) {
            var f = FILES_BY_ID[Number(id)];
            return f && f.kind === 'photo' && f.show_id === s.id && f.status !== 'proposed';
          });
          if (!okIds) return fail('a recap can only carry filed photos from this show');
        }
        if (err) return fail(err);

        Object.keys(patch).forEach(function (k) {
          rec.body[k] = k === 'photo_ids' ? patch[k].map(Number)
            : (k === 'narrative' || k === 'highlights')
              ? patch[k].map(function (t) { return String(t).trim(); }).filter(Boolean)
              : k === 'stats'
                ? patch[k].map(function (st) { return { label: String(st.label).trim(), value: String(st.value == null ? '' : st.value).trim() }; })
                : String(patch[k]).trim();
        });
        rec.edited_by = ME; rec.edited_at = TODAY_ISO + 'T' + _nowHM();
        var sect = Object.keys(patch).map(function (k) {
          return { headline: 'headline', narrative: 'narrative', highlights: 'highlights',
                   stats: 'stats', photo_ids: 'photos', closing: 'closing' }[k];
        }).join(', ');
        s.activity.unshift(mkAct(ME, 'edited the client recap draft', sect, 0, _nowHM()));
        return ok(rec);
      }
      return SR.put('/api/shows/' + Number(showId) + '/recap', patch).then(unwrapRecap);
    },

    /* photo strip helpers — reorder / remove / add back. All three compose
       updateRecap, so they inherit the same draft + role guard. */
    reorderRecapPhoto: function (showId, fileId, delta) {
      return api.getRecap(showId).then(function (rec) {
        if (!rec) return fail('no recap on this show yet');
        var ids = ((rec.body && rec.body.photo_ids) || []).slice(), i = ids.indexOf(Number(fileId));
        if (i < 0) return fail('that photo is not in the recap');
        var j = i + (Number(delta) < 0 ? -1 : 1);
        if (j < 0 || j >= ids.length) return ok(rec);          /* already an end */
        var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
        return api.updateRecap(showId, { photo_ids: ids });
      });
    },
    removeRecapPhoto: function (showId, fileId) {
      return api.getRecap(showId).then(function (rec) {
        if (!rec) return fail('no recap on this show yet');
        var ids = ((rec.body && rec.body.photo_ids) || []).filter(function (id) { return id !== Number(fileId); });
        return api.updateRecap(showId, { photo_ids: ids });
      });
    },
    addRecapPhoto: function (showId, fileId) {
      return api.getRecap(showId).then(function (rec) {
        if (!rec) return fail('no recap on this show yet');
        var ids = ((rec.body && rec.body.photo_ids) || []).slice();
        if (ids.indexOf(Number(fileId)) < 0) ids.push(Number(fileId));
        return api.updateRecap(showId, { photo_ids: ids });
      });
    },

    approveRecap: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var rec = recapForShow(s.id);
        if (!rec) return fail('no recap on this show yet');
        if (rec.status !== 'draft') return fail('this recap is already ' + rec.status);
        if (!canApproveRecap(s)) return fail('approving a client recap requires manager, admin — or the show’s own pm+ owner');
        rec.status = 'approved'; rec.approved_by = ME; rec.approved_at = TODAY_ISO + 'T' + _nowHM();
        s.activity.unshift(mkAct(ME, 'approved the client recap',
          'locked for send — a human sends it, never the agent', 0, _nowHM(), true));
        return ok(rec);
      }
      return SR.post('/api/shows/' + Number(showId) + '/recap/approve', {}).then(unwrapRecap);
    },
    reopenRecap: function (showId) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var rec = recapForShow(s.id);
        if (!rec) return fail('no recap on this show yet');
        if (rec.status === 'sent') return fail('this recap has been sent — that is a record, not a draft');
        if (rec.status !== 'approved') return fail('this recap is already a draft');
        if (!canApproveRecap(s)) return fail('reopening an approved recap requires manager, admin — or the show’s own pm+ owner');
        rec.status = 'draft'; rec.approved_by = null; rec.approved_at = null;
        s.activity.unshift(mkAct(ME, 'reopened the client recap for edits', 'back to draft', 0, _nowHM()));
        return ok(rec);
      }
      return SR.post('/api/shows/' + Number(showId) + '/recap/reopen', {}).then(unwrapRecap);
    },

    /* Records that a human sent it; sends nothing, in either mode. */
    markSent: function (showId, sentTo) {
      if (!API()) {
        var s = SHOWS_BY_ID[Number(showId)];
        if (!s) return fail('show ' + showId + ' not found');
        var rec = recapForShow(s.id);
        if (!rec) return fail('no recap on this show yet');
        if (rec.status !== 'approved') {
          return fail(rec.status === 'sent' ? 'this recap is already marked sent'
            : 'only an approved recap can be marked sent — approve it first');
        }
        if (!RECAP_EDIT_ROLES[CURRENT_USER.role]) return fail('recording a send requires pm, manager or admin');
        if (!canApproveRecapFor(s, ME)) return fail('recording a send on this show requires manager, admin — or the show’s own owner');
        var to = String(sentTo || (s.client_poc && s.client_poc.name) || (s.project && s.project.client) || 'the client').trim();
        rec.status = 'sent'; rec.sent_to = to; rec.sent_at = TODAY_ISO + 'T' + _nowHM();
        s.activity.unshift(mkAct(ME, 'recap sent to ' + to,
          'marked sent by hand — the app has no outbound path', 0, _nowHM(), true));
        return ok(rec);
      }
      return SR.post('/api/shows/' + Number(showId) + '/recap/sent',
                     { sent_to: sentTo ? String(sentTo).trim() : undefined }).then(unwrapRecap);
    },

    /* ================= SPEC BIND (INTEGRATIONS_SPEC §9 · D1/D5) =========
       The ?bind-spec=1 popup posts the tool's render bundle here. Session
       auth only — the tools never hold a credential (§9.3.1). */
    specBind: function (showId, payload) {
      if (!API()) return fail('Binding a spec needs the live Showrunner server');
      return SR.post('/api/shows/' + Number(showId) + '/spec-bind', payload, { timeout: 120000, noNotify: true });
    }
  };

  function _nowHM() {
    var d = new Date(), h = String(d.getHours()), m = String(d.getMinutes());
    return (h.length < 2 ? '0' + h : h) + ':' + (m.length < 2 ? '0' + m : m);
  }
})();
