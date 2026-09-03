// ════════════════════════════════════════════════════════════════════════════
// scripts/fake-scheduler.js — a local stand-in for the staffing app
// ────────────────────────────────────────────────────────────────────────────
// The suites must prove the push against SOMETHING, and production is off the
// table by hard rule. This is a minimal in-memory express app implementing
// exactly the endpoint surface lib/scheduler.js drives — shapes copied from
// the real handlers in staffing/server.js (line refs beside each) — plus seed
// helpers so a test can plant "foreign" rows: children a human typed into the
// staffing app that no push may ever count dead.
//
// Faithfulness rules, in order of importance:
//   · auth is a login-issued token in an in-memory Map (:769) — the thing that
//     forced the programmatic-login design in the first place.
//   · every GET is UNAUTHENTICATED, every write requires x-auth-token, exactly
//     like the real routes.
//   · POST /api/travel is an UPSERT on travel_key (:2637) and there is NO
//     DELETE /api/travel — which is why override mode cannot remove legs.
//   · PUT /api/events/:id is a FULL REPLACE (:903) — the R8 behaviour the
//     read-modify-write in lib/scheduler.js exists to survive.
//
// This file is test infrastructure: it must never be mounted by server.js and
// no production code path may ever import it.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');

function startFakeScheduler({ user = 'showrunner', pass = 'fake-pass' } = {}) {
  const state = {
    logins: 0,
    events: [],
    clients: [],
    roster: [],
    bookings: [],
    venueContacts: [],
    clientContacts: [],
    travel: {},                 // keyed by travel_key, like the real table
    nextId: 1
  };
  const sessions = new Set();
  const id = () => state.nextId++;

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const requireAuth = (req, res, next) => {
    const t = req.headers['x-auth-token'];
    if (!t || !sessions.has(t)) return res.status(401).json({ error: 'Not authenticated' });
    next();
  };

  // ── auth (:769) ───────────────────────────────────────────────────────────
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    state.logins += 1;
    if (String(username || '').toLowerCase().trim() !== user || password !== pass) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = 'fake-tok-' + Math.random().toString(36).slice(2);
    sessions.add(token);
    res.json({ token, username: user, role: 'admin' });
  });

  // ── events (:881/:887/:903) ───────────────────────────────────────────────
  app.get('/api/events', (req, res) => res.json(state.events.slice()));
  app.post('/api/events', requireAuth, (req, res) => {
    const ev = { id: id(), archived: false, staff: [], ...req.body };
    state.events.push(ev);
    res.json(ev);
  });
  app.put('/api/events/:id', requireAuth, (req, res) => {
    const i = state.events.findIndex((e) => e.id === Number(req.params.id));
    if (i < 0) return res.status(404).json({ error: 'Not found' });
    // full replace, id preserved — the R8 shape
    state.events[i] = { ...req.body, id: state.events[i].id };
    res.json(state.events[i]);
  });

  // ── clients (:840/:846) ───────────────────────────────────────────────────
  app.get('/api/clients', (req, res) => res.json(state.clients.slice()));
  app.post('/api/clients', requireAuth, (req, res) => {
    const name = String((req.body || {}).name || '');
    if (state.clients.some((c) => c.name === name)) {
      return res.status(400).json({ error: 'Client name already exists' });
    }
    const c = { id: id(), name };
    state.clients.push(c);
    res.json(c);
  });

  // ── roster (:2484/:2490) ──────────────────────────────────────────────────
  app.get('/api/roster', (req, res) => res.json(state.roster.slice()));
  // The staffing app's own "add staff member" door: an UPSERT on the UNIQUE
  // name (ON CONFLICT (name) DO UPDATE), token-gated like every write. A null
  // name is the raw-500 shape the real handler produces, faithfully.
  app.post('/api/roster', requireAuth, (req, res) => {
    const m = req.body || {};
    if (m.name == null || m.name === '') {
      return res.status(500).json({ error: 'null value in column "name" of relation "roster" violates not-null constraint' });
    }
    const cur = state.roster.find((r) => r.name === m.name);
    const row = {
      id: cur ? cur.id : id(),
      name: m.name,
      color: m.color || '#4472C4',
      qualBlaze: !!m.qualBlaze, qualMRocket: !!m.qualMRocket,
      initials: m.initials || '', sortOrder: m.sortOrder || 0, email: m.email || ''
    };
    if (cur) Object.assign(cur, row); else state.roster.push(row);
    res.json(row);
  });

  // ── the three child collections (:2824 / :2754 / :2694) ───────────────────
  // One factory: list (optionally ?eventId=), create, delete — identical
  // mechanics on the real side, identical here.
  const children = [
    ['bookings', '/api/bookings'],
    ['venueContacts', '/api/venue-contacts'],
    ['clientContacts', '/api/client-contacts']
  ];
  for (const [key, base] of children) {
    app.get(base, (req, res) => {
      const evId = req.query.eventId ? parseInt(req.query.eventId, 10) : null;
      res.json(state[key].filter((r) => evId == null || r.eventId === evId));
    });
    app.post(base, requireAuth, (req, res) => {
      const row = { id: id(), ...req.body };
      if (!row.eventId) return res.status(400).json({ error: 'eventId required' });
      state[key].push(row);
      res.json(row);
    });
    app.delete(base + '/:id', requireAuth, (req, res) => {
      const i = state[key].findIndex((r) => r.id === Number(req.params.id));
      if (i < 0) return res.status(404).json({ error: 'Not found' });
      state[key].splice(i, 1);
      res.json({ ok: true });
    });
  }

  // ── travel (:2629/:2637) — object keyed by travel_key; POST is an upsert ──
  app.get('/api/travel', (req, res) => res.json({ ...state.travel }));
  app.post('/api/travel', requireAuth, (req, res) => {
    const { key, ...rest } = req.body || {};
    if (!key) return res.status(500).json({ error: 'null value in column "travel_key"' });
    state.travel[key] = rest;
    res.json({ ok: true });
  });

  // ── seed helpers — how a test plants what "was already there" ─────────────
  const seed = {
    event(fields) {
      const ev = { id: id(), archived: false, staff: [], event: 'seeded', eventDate: '',
                   setup: '', breakdown: '', location: '', ...fields };
      state.events.push(ev);
      return ev;
    },
    roster(name, fields = {}) {
      const r = { id: id(), name, email: '', ...fields };
      state.roster.push(r);
      return r;
    },
    // A FOREIGN child: a row a human typed into the staffing app. The suites
    // seed these, then assert the push's delete pass never counts one dead.
    booking(eventId, fields = {}) {
      const b = { id: id(), eventId, category: 'other', customLabel: 'hand-entered',
                  status: 'booked', staffAssigned: [], ...fields };
      state.bookings.push(b);
      return b;
    },
    venueContact(eventId, fields = {}) {
      const v = { id: id(), eventId, name: 'hand-entered venue poc', role: '', ...fields };
      state.venueContacts.push(v);
      return v;
    },
    clientContact(eventId, fields = {}) {
      const c = { id: id(), eventId, name: 'hand-entered client poc', title: '', ...fields };
      state.clientContacts.push(c);
      return c;
    },
    travel(key, fields = {}) {
      state.travel[key] = { flightNum: 'ZZ111', ...fields };
      return state.travel[key];
    }
  };

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        state,
        seed,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { startFakeScheduler };
