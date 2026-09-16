/* ============================================================================
   e360 SHOWRUNNER — ROUTER CORE  ·  the URL half of navigation
   ----------------------------------------------------------------------------
   Tom, 2026-09-16, live: "how come the back button takes me to a whole new
   website... it needs fixed. its totally annoying." Every screen rendered at
   ONE URL, so the browser's Back button left the site. This file is the pure
   half of the fix: route strings <-> {view, arg, tab}, plus a tiny core that
   decides when the hash is written, whether the write replaces or pushes, and
   which hashchange events are only echoes of our own writes.

   WHY HASH ROUTES (#/shows/13/schedule), NOT pushState PATHS: this app is
   served statically at one path in API mode AND opens straight off file:// in
   demo mode, where pushState is unavailable/awkward. A hash route behaves
   identically in both worlds, needs zero server route config, and survives a
   refresh without a rewrite rule. It also unifies the two link shapes already
   in the wild before this file existed: mail bodies emit '/#show/41' and
   '/#folder/7' (lib/audience.js · lib/mentions.js · routes/*), and the spec
   tools emit '/#/shows/13' (INTEGRATIONS_SPEC §9) — both parse below, so
   every old link starts working instead of breaking.

   TAB GRANULARITY — one deliberate behavior: a show's tab RIDES THE HASH, so
   a refresh and a copied link keep the exact tab — but a tab flick REPLACES
   the history entry rather than pushing one. Back therefore leaves the
   SCREEN. Tab-granular history would make Back crawl backward through every
   tab you glanced at — the exact annoyance Tom named, rebuilt in miniature.
   The viewer's prev/next paging gets the same treatment for the same reason.

   PURE ON PURPOSE: nothing here touches window, document, location or
   history. app.js supplies those through makeRouterCore(io), and the persona
   walk executes this same file headless in a vm — the echo guard and the
   replace/push policy are asserted by RUNNING them, not by reading them.
   ========================================================================== */

/* the singleton views — '#/<view>', no id (renderView's argless branches) */
var ROUTE_VIEWS = {
  projects: 1, finance: 1, purchasing: 1, mytasks: 1, archive: 1, outbox: 1,
  today: 1, changes: 1, calendar: 1, team: 1, staffing: 1, contacts: 1,
  files: 1, templates: 1, proposals: 1, settings: 1
};

/* the show folder's tab keys (views-folder.js drawShowTab) — a route part */
var ROUTE_SHOW_TABS = {
  overview: 1, schedule: 1, pipeline: 1, specs: 1, gear: 1, content: 1,
  files: 1, photos: 1, reports: 1, recap: 1, financials: 1, proofs: 1,
  bookings: 1, activity: 1
};

/* view + arg (+ tab) -> the canonical hash, or null for a view that has no
   route — the URL is then simply left alone: never a lie, never a crash */
function routeFor(view, arg, tab) {
  var withId = { show: '#/shows/', folder: '#/folders/', job: '#/jobs/',
                 po: '#/pos/', viewer: '#/viewer/' };
  if (withId[view]) {
    var n = arg == null ? NaN : Number(arg);
    if (!isFinite(n) || n <= 0 || n !== Math.floor(n)) return null;
    var t = view === 'show' && tab && tab !== 'overview' && ROUTE_SHOW_TABS[tab]
      ? '/' + tab : '';
    return withId[view] + n + t;
  }
  return ROUTE_VIEWS[view] ? '#/' + view : null;
}

/* a hash -> {view, arg, tab} · {view:null} for the empty hash (land by role)
   · null for anything unknown or stale-shaped, which the caller answers with
   the dashboard and an honest toast — never a blank screen, never a crash.
   Accepts the canonical '#/…' shapes AND both legacy shapes (see header). */
function routeParse(raw) {
  var h;
  try {
    h = String(raw == null ? '' : raw);
    if (h.charAt(0) === '#') h = h.slice(1);
    h = h.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!h) return { view: null };
    var parts = h.split('/');
    for (var i = 0; i < parts.length; i++) if (!parts[i]) return null; /* '#/shows//3' */
    var head = String(parts[0]).toLowerCase();
    var aliases = { shows: 'show', folders: 'folder', jobs: 'job', pos: 'po',
                    viewer: 'viewer',
                    /* the legacy mail shape: '/#show/41' · '/#folder/7' */
                    show: 'show', folder: 'folder', job: 'job', po: 'po' };
    var view = aliases[head];
    if (view) {
      var id = parts.length > 1 && /^[0-9]+$/.test(parts[1]) ? Number(parts[1]) : null;
      if (id === null || id <= 0) return null;
      if (view === 'show') {
        if (parts.length > 3) return null;
        var tab = parts.length === 3 ? String(parts[2]).toLowerCase() : null;
        if (tab !== null && !ROUTE_SHOW_TABS[tab]) return null;
        return { view: 'show', arg: id, tab: tab };
      }
      return parts.length === 2 ? { view: view, arg: id } : null;
    }
    return parts.length === 1 && ROUTE_VIEWS[head] ? { view: head } : null;
  } catch (_) { return null; }        /* a hostile hash is an unknown hash */
}

/* two routes on the same SCREEN differ only in a show's tab or in the file on
   the viewer's stage — those write with REPLACE, so history holds screens,
   not flicks. Everything else is a real move and pushes one entry. */
function routeSameScreen(a, b) {
  var pa = routeParse(a), pb = routeParse(b);
  if (!pa || !pb || !pa.view || pa.view !== pb.view) return false;
  if (pa.view === 'viewer') return true;
  return (pa.arg == null ? null : pa.arg) === (pb.arg == null ? null : pb.arg);
}

/* the state machine. io = {
     read()               -> the current hash string
     write(hash, replace) -> put it on the URL (replace = no new entry)
     navigate(route, raw) -> drive the SAME render path a click would
   } — app.js hands in the real location/history/render; the walk hands in
   counters and drives the guard by hand. */
function makeRouterCore(io) {
  var state = {
    cur: null,     /* the hash this tab's screen last wrote — the echo guard */
    pending: '*'   /* non-null while a ROUTED navigation is landing: the next
                      sync() REPLACES, because the entry already exists —
                      Back/Forward or a pasted link made it. '*' = boot: the
                      arrival entry is reused, never doubled. */
  };
  return {
    state: state,

    /* a screen SUCCESSFULLY rendered — record it on the URL. Called from the
       end of renderView() (and the tab/viewer hooks), never from a click
       handler, so a render that threw can never leave a lying URL. */
    sync: function (view, arg, tab) {
      var h = routeFor(view, arg, tab);
      if (h === null) return null;
      var routed = state.pending !== null;
      state.pending = null;
      if (h === state.cur && h === String(io.read() || '')) return h;   /* redundant re-render: ZERO writes */
      io.write(h, routed || routeSameScreen(state.cur, h));
      state.cur = h;
      return h;
    },

    /* THE ECHO GUARD. Our own location.hash write fires hashchange too; when
       the browser's hash already matches the screen we just recorded, this
       event is that write coming back — re-navigating on it is the classic
       infinite loop. Only a hash we did NOT write (Back/Forward, a pasted
       link, a hand-edit) routes. */
    onHashChange: function (raw) {
      raw = String(raw == null ? '' : raw);
      if (raw === state.cur) return false;
      io.navigate(routeParse(raw), raw);
      return true;
    },

    /* bracket a ROUTED navigation (boot deep link · hashchange) */
    routeBegin: function (raw) { state.pending = String(raw == null ? '' : raw); },
    /* -> true when NOTHING synced while pending: the route never landed (a
       deleted show, a dead file id). The caller falls back to the dashboard
       and replaces the stale hash, so the URL never lies. */
    routeEnd: function () { var missed = state.pending !== null; state.pending = null; return missed; }
  };
}
