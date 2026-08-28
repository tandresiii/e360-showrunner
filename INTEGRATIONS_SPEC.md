# Showrunner — Integrations Spec (implementation-ready)

**Target repo for this doc:** `d:\e360_office_lab\showrunner-app\`
**Reconnaissance source (READ-ONLY, nothing written):** `C:\code\e360-staffing3\`, version `2026.05.19-d` (`server.js:3`, `server.js:7`)
**Written:** 2026-08-27. Every claim below carries a `file:line` citation. Where this doc contradicts `INTEGRATION.md`, **this doc wins** — the drift items are called out inline and summarized in §7.

Line references:
- `staffing/server.js:N` → `C:\code\e360-staffing3\server.js`
- `staffing/index.html:N` → `C:\code\e360-staffing3\public\index.html`
- `sr/server.js:N` → `d:\e360_office_lab\showrunner-app\server.js`

---

## 1. The staffing app: stack, run, auth

### 1.1 Stack and entry point

| Thing | Value | Ref |
|---|---|---|
| Entry point | `server.js` (monolith, 3675 lines, 186 KB) | `package.json` `main` |
| Runtime | Node ≥ 18 (uses global `fetch`) | `package.json` `engines` |
| Framework | Express 4 | `staffing/server.js:9,16` |
| DB | PostgreSQL via `pg` `Pool` | `staffing/server.js:10,21-24` |
| Deps | `cors`, `express`, `luxon`, `nodemailer`, `pg` | `package.json` |
| Frontend | `public/index.html`, single file, 478 KB, vanilla JS, no build | `staffing/index.html` |
| Start | `npm start` → `node server.js` | `package.json`, `Procfile` |
| Host | Railway, auto-deploy from GitHub `main` | `CLAUDE.md:18`, `railway.toml` |
| Version string | `APP_VERSION = '2026.05.19-d'`, served at `GET /api/version` | `staffing/server.js:7,786-788` |

**There is no `routes/` directory and no module split.** Everything — Flex client, email templates, schema migrations, all 88 routes — lives in the one `server.js`. Do not expect to import anything from it.

### 1.2 Running it locally

```bash
cd C:\code\e360-staffing3
npm install
# Postgres must be reachable. initDB() is idempotent (CREATE TABLE IF NOT EXISTS
# + ALTER TABLE ADD COLUMN IF NOT EXISTS) so pointing at an empty DB just works.
DATABASE_URL='postgres://user:pass@localhost:5432/e360staffing' PORT=3000 node server.js
```

- **Port:** `process.env.PORT || 3000` (`staffing/server.js:3668`). Showrunner defaults to `3100` (`sr/server.js:1348`) — no collision, but both read the bare `PORT` var, so if you launch them from one shell set `PORT` explicitly per process.
- **SSL quirk:** `ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false` (`staffing/server.js:23`). If `DATABASE_URL` is set at all, it forces SSL-with-no-verify. A plain local Postgres without SSL will **fail to connect** unless you also set `PGSSLMODE=disable` or run Postgres with SSL. This is a real local-dev trap.
- **On boot:** `initDB()` runs all migrations, then seeds a default admin **only if `users` is empty**: username `admin`, password `e360admin` (`staffing/server.js:759-764`). Then `runServerAutoArchive()` fires and re-fires every 24 h (`staffing/server.js:3669-3672`).
- **Optional seed data:** `POST /api/seed` (unauthenticated, `staffing/server.js:2657`) loads `seed_events.json` + `seed_roster.json`, but no-ops if `events` already has rows.

### 1.3 Environment variables (complete list)

| Var | Used at | Required for |
|---|---|---|
| `DATABASE_URL` | `staffing/server.js:22` | everything |
| `PORT` | `staffing/server.js:3668` | optional (default 3000) |
| `FLEX_BASE_URL` | `staffing/server.js:43` | all Flex routes; value `https://e360sport.flexrentalsolutions.com` |
| `FLEX_API_KEY` | `staffing/server.js:49` | all Flex routes |
| `GMAIL_USER` | `staffing/server.js:367,372,960,1955` | packets / notify |
| `GMAIL_APP_PASSWORD` | `staffing/server.js:367,372` | packets / notify |

> **Drift:** `CLAUDE.md:30` and `CLAUDE.md:147` document the mail password var as `GMAIL_PASS`. The code reads **`GMAIL_APP_PASSWORD`**. `CLAUDE.md` is wrong. Irrelevant to Showrunner (we never trigger mail) but it tells you how much to trust that file.

### 1.4 Auth model — and how Showrunner authenticates

The whole model is 25 lines (`staffing/server.js:506-531`):

```js
function hashPassword(p) { return crypto.createHash('sha256').update(p + 'e360salt').digest('hex'); }   // :506
const sessions = new Map();                                                                              // :512
function createSession(userId, username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, username, role, expires: Date.now() + 12*60*60*1000 });                  // :515
  return token;
}
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];                                                             // :526
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });                             // :528
  req.session = session; next();
}
```

Facts that matter:

1. **`requireAuth` does not check role.** Any valid session — even role `view` or `crew` — passes every write route. Role is checked inline in exactly two places: `GET/POST/PUT/DELETE /api/users` (`staffing/server.js:799`) and `POST /api/import` (`staffing/server.js:3435`). So a Showrunner service account needs *no special role* to write events/bookings/contacts/travel.
2. **Sessions are in-memory and die on every Railway redeploy** (`CLAUDE.md:100-104`). There is **no API-key path and no service-credential mechanism** anywhere in the codebase.
3. **Tokens expire after 12 hours** (`staffing/server.js:515`).
4. **CORS is wide open** — `app.use(cors())` with no options (`staffing/server.js:17`). Showrunner can call it from anywhere, browser or server.
5. **Body limit is 20 MB** (`staffing/server.js:18`) — plenty for spec bundles.

> **Drift / correction to `INTEGRATION.md` §"Order of operations" item 4:** it says an automated push "needs a **durable service credential / API key**, not a UI session." That credential **does not exist and is not on the roadmap.** Do not block the build on it, and do not ship a static `SCHEDULER_API_TOKEN` env var — a hardcoded token is guaranteed to be dead within 12 h or one deploy, whichever comes first.

#### 1.4.1 REQUIRED: Showrunner's scheduler auth strategy

Showrunner must **log in programmatically and re-login on 401**. This works against the app as it exists today, with zero changes to the staffing repo.

```
POST {SCHEDULER_BASE_URL}/api/auth/login
Content-Type: application/json
{ "username": "showrunner", "password": "<secret>" }

200 → { "token": "<64 hex chars>", "username": "showrunner", "role": "edit" }
401 → { "error": "Invalid username or password" }
```
(`staffing/server.js:769-780`. Note `username.toLowerCase().trim()` is applied server-side — `staffing/server.js:773`.)

Replace `SCHEDULER_API_TOKEN` in `sr/server.js:1225` with a token cache:

```js
// lib/scheduler.js
let _tok = null, _exp = 0;
async function schedulerToken(force) {
  if (!force && _tok && Date.now() < _exp) return _tok;
  const r = await fetch(schedulerBaseUrl() + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.SCHEDULER_USER, password: process.env.SCHEDULER_PASS })
  });
  if (!r.ok) throw new Error('Scheduler login failed: ' + r.status);
  const b = await r.json();
  _tok = b.token;
  _exp = Date.now() + 11 * 60 * 60 * 1000;   // 11h, one hour inside the server's 12h TTL
  return _tok;
}

async function schedulerFetch(apiPath, options = {}, _retried) {
  const token = await schedulerToken(false);
  const res = await fetch(schedulerBaseUrl() + apiPath, { ...options, headers: {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    'x-auth-token': token, ...(options.headers || {})
  }});
  if (res.status === 401 && !_retried) {          // redeploy wiped the session
    await schedulerToken(true);
    return schedulerFetch(apiPath, options, true);
  }
  /* ...existing body parse + error throw from sr/server.js:1229-1238... */
}
```

**Showrunner env vars to add:** `SCHEDULER_BASE_URL`, `SCHEDULER_USER`, `SCHEDULER_PASS`. **Retire** `SCHEDULER_API_TOKEN`.

**Ops prerequisite for Tom:** create a dedicated `showrunner` user in the staffing app (Users tab, admin-only) with role `edit`. Do **not** reuse a human login — a second login for the same account is fine (sessions are per-token, not per-user), but you want the Flex audit trail and any future change log to name the robot.

---

## 2. Inbound surface for the push

### 2.1 Ground rules

- **No SQL foreign keys exist anywhere.** Child tables carry a bare `event_id INTEGER NOT NULL` (`staffing/server.js:690,703,738`). Integrity and cascade are the app's job; the only cascade is the manual one in `DELETE /api/events/:id` (`staffing/server.js:928-936`, deletes `bookings` → `venue_contacts` → `client_contacts` → `events`; note it does **not** delete `travel_info` or detach `route_id`, despite `CLAUDE.md:111` claiming it detaches routes).
- **Create the event first, capture `id`, then fan out.** `POST /api/events` returns the full row through `dbToEvent` (`staffing/server.js:899`, mapper at `:2431-2457`), so `created.id` is your `event_id`.
- **Every write route is `requireAuth`.** Every `GET` listed in §4 is **not**.

### 2.2 Route table (exact)

| # | Method + path | Line | Required fields | Returns |
|---|---|---|---|---|
| B.1 | `POST /api/events` | `:887` | none validated (see 2.3) | full event via `dbToEvent` |
| B.1u | `PUT /api/events/:id` | `:903` | none | full event, or 404 |
| B.2 | `POST /api/bookings` | `:2839` | `eventId`, `category` → else 400 `eventId and category required` (`:2842`) | booking via `dbToBooking` |
| B.3 | `POST /api/venue-contacts` | `:2768` | `eventId` → else 400 `eventId required` (`:2771`) | contact |
| B.4 | `POST /api/client-contacts` | `:2708` | `eventId` → else 400 (`:2711`) | contact |
| B.6 | `POST /api/travel` | `:2637` | `key` (upsert PK) | `{ ok: true }` |
| B.0 | `GET /api/clients` / `POST /api/clients` | `:840` / `:846` | `name` unique | client; 400 `Client name already exists` on 23505 (`:855`) |
| B.7a | `POST /api/events/:id/flex/create-element` | `:991` | — | event; 409 if already linked (`:998`) |
| B.7b | `POST /api/events/:id/flex/link-element` | `:1026` | `input` (UUID or Flex URL) | event; 409 if linked |
| B.7c | `GET /api/events/:id/flex/available-gear-lists` | `:1083` | — | `{ items: [...] }` |
| B.7d | `POST /api/events/:id/flex/attach-gear-list` | `:1103` | `gearListId`, `type ∈ {pull-sheet, manifest}` | event |
| B.7e | `POST /api/events/:id/spec-sheet` | `:1206` | `type ∈ {e360,nsf,pcfg}`, `json` object, `svg` string starting `<svg` | `{ ok, type }` |

### 2.3 B.1 — `POST /api/events` exact contract

Insert of **23 columns** (`staffing/server.js:890-898`). camelCase in → snake_case column, with these literal defaults:

| Body field | Column | Server default applied |
|---|---|---|
| `event` | `event` | **none** — column is `TEXT NOT NULL` (`:537`) |
| `eventDate` | `event_date` | none (null allowed) |
| `setup` | `setup` | none |
| `breakdown` | `breakdown` | none |
| `setupTime` | `setup_time` | `''` |
| `eventTime` | `event_time` | `''` |
| `location` | `location` | `''` |
| `mediaServer` | `media_server` | `'N/A'` |
| `staff` | `staff` (JSONB) | `[]`, `JSON.stringify`'d server-side |
| `notes` | `notes` | `''` |
| `archived` | `archived` | `false` |
| `clientId` | `client_id` | `null` |
| `shipOutDate` | `ship_out_date` | `''` |
| `shipReturnDate` | `ship_return_date` | `''` |
| `noShipOut` | `no_ship_out` | `false` |
| `noShipReturn` | `no_ship_return` | `false` |
| `eventType` | `event_type` | `'LED'` |
| `techNotes` | `tech_notes` | `''` |
| `clientContactName/Title/Company/Phone/Email` | `client_contact_*` | `''` each |

**Validation: there is none.** No required-field check, no type check, no enum check on `eventType`. Omitting `event` produces a raw Postgres `null value in column "event"` message inside a **500** (`:901`), not a 400.

**Not settable here** (must be stamped afterward, or left alone): `route_id`, `residency_id`, `engagement_type`, `flex_element_id`, `flex_element_number`, `flex_gear_list_id`, `flex_gear_list_type`, all twelve `{e360,nsf,pcfg}_spec_{json,svg,html,png}` columns.

**`PUT /api/events/:id` is a FULL REPLACE of the same 23 columns** (`:907-921`). Any field you omit is written as its default, not preserved. Consequences for a re-push:
- omit `techNotes` → the operator's tech notes are **erased**;
- omit `archived` → an archived event is **un-archived**;
- omit `staff` → the crew list is **emptied**.
The 15 columns *outside* that list (`route_id`, `residency_id`, `engagement_type`, `flex_*`, `*_spec_*`) are **not** in the UPDATE and therefore survive untouched. So a re-push can never clobber a Flex link or a bound spec sheet — but it *will* clobber everything else unless you read-modify-write.

### 2.4 What Showrunner currently WOULD send vs what staffing accepts

Source: `buildSchedulerPayloads()` at `sr/server.js:1150-1208`, plus the commented live path at `sr/server.js:1283-1326`. There is **no** refactored `routes/` successor — I checked; `showrunner-app/` contains only `lib/enums.js`, `public/`, `dist/`, and the monolithic `server.js` (mtime 2026-08-20).

#### FIELD MISMATCH LIST — every one, ordered by severity

**M1 — CRITICAL: booking `category` values match nothing.**
`deriveBookingCategory()` (`sr/server.js:1133-1142`) emits `'Trucking' | 'Forklift' | 'Hotel' | 'Travel' | 'Power/Cable' | 'Rental' | 'Other'`.
The staffing app's category vocabulary is a **fixed 7-key enum in the frontend** (`staffing/index.html:4392-4400`):

```js
const BOOKING_CATEGORIES = [
  { key: 'trucking',      label: 'Trucking'     },
  { key: 'forklift',      label: 'Forklift'     },
  { key: 'feeder_cable',  label: 'Feeder Cable' },
  { key: 'install_labor', label: 'Install Labor'},
  { key: 'strike_labor',  label: 'Strike Labor' },
  { key: 'hotel',         label: 'Hotels'       },
  { key: 'other',         label: 'Other'        }
];
```
The DB accepts any string (`category TEXT NOT NULL`, `staffing/server.js:739`), but **every render path iterates `BOOKING_CATEGORIES` and filters `b.category === cat.key`** — the event edit modal's vendor sections (`staffing/index.html:5179-5188`), the Booking overview grid columns (`:4489, :4517`), and `bookingStats`. A booking whose category is not one of the seven **is stored and then invisible in the staffing UI, and excluded from the booked/needed totals.** Every booking Showrunner pushes today lands in that black hole.

**M2 — CRITICAL: `'Hotel'` breaks the Tech Packet.**
The packet builder tests `b.category === 'hotel'` **lowercase, twice**: once to exclude hotels from the shared vendor section, once to collect them as per-person lodging (`staffing/server.js:1911, 1917`). A pushed `'Hotel'` fails both: the hotel leaks into every tech's vendor list *and* no tech gets a hotel block. This is the read-back path in §4 failing at the source.

**M3 — CRITICAL: booking `status` vocabulary is wrong.**
`mapBookingStatus()` (`sr/server.js:1144-1146`) emits `'confirmed'`. The app's two states are `'booked'` and `'needed'` (`staffing/index.html:5215` `line.status === 'booked'`, `:5267` the toggle writes `'booked'`/`'needed'`; DB default `'needed'`, `staffing/server.js:748`). `'confirmed'` renders as amber ⚡ NEEDED forever and never counts toward "booked".

**M4 — CRITICAL: travel is never pushed.**
`buildSchedulerPayloads` returns `{ eventPayload, bookings, venueContacts, clientContacts, crewNames }` (`sr/server.js:1207`) — **no travel payload**, and the commented live path has no `/api/travel` call. `INTEGRATION.md` B.6 documents the mapping but nothing implements it. Showrunner's own call sheet then reads back travel that Showrunner never wrote. See §2.6 for the payload to add.

**M5 — CRITICAL: `travel_key` sentinel forms are undocumented and mandatory.**
See §4.2. `INTEGRATION.md` B.6 documents only `"Person|prevEventId|nextEventId"`. The real scheme has **two sentinel forms** the app writes and reads when a neighbour event does not exist: `"Person|<eventId>|inbound"` and `"Person|<eventId>|outbound"` (`staffing/index.html:3850, 3858, 3994, 4004`). Writing an empty segment instead (`"Tom|12|"`) stores a row the staffing UI will never look up.

**M6 — HIGH: crew names are not canonicalized.**
`crewNames` is `steps.filter(lane==='crew' && owner && status!=='na').map(s => s.owner.trim())` (`sr/server.js:1151-1153`) — raw Showrunner owner strings, which per `sr/server.js:242` may be "roster name / username / **role token**". Downstream, staffing keys the roster by `name.toLowerCase().trim()` (`staffing/server.js:958, 1899`); a miss silently yields **no email, no colour chip, no tech packet** (`staffing/server.js:1963` pushes the person onto `missingEmail` and `continue`s). Pushing `lead_tech` as a crew member produces a ghost. Showrunner must resolve to a canonical `roster.name` before pushing — fetch `GET /api/roster` (unauthenticated, `staffing/server.js:2484`) and match case-insensitively; refuse the push on any unmatched name rather than writing a ghost.

**M7 — HIGH: `shipOutDate` / `shipReturnDate` hardcoded to `''`, which breaks Flex folder creation.**
`sr/server.js:1170-1171`. `flexCreateEventFolder` computes `startSource = ev.shipOutDate || ev.setup` and throws `'Cannot create Flex folder: event has no Setup or Ship Out date'` when both are falsy (`staffing/server.js:278-282`). Showrunner's `setup` comes from `show.load_in_date` which defaults to `''` (`sr/server.js:219`). A show pushed without a load-in date creates an event that can never get a Flex folder — and the failure surfaces as a **502** from `/flex/create-element` (`staffing/server.js:1017`), not a clear validation error. Showrunner should refuse to push a show with no `load_in_date`.

**M8 — HIGH: re-push duplicates every child row.**
The live path (`sr/server.js:1304-1315`) unconditionally POSTs each booking / venue contact / client contact. With `{force:true}` on an already-pushed show it PUTs the event but **appends** a second full set of children. There is no upsert and no delete-first. See §2.7 for the required algorithm.

**M9 — MEDIUM: `PUT` on re-push blanks operator-entered fields.** Per §2.3. `eventPayload` hardcodes `setupTime: ''`, `eventTime: ''`, `techNotes: ''`, `mediaServer: 'N/A'`, `archived: false` (`sr/server.js:1161-1175`). Re-pushing wipes whatever the staffing operator typed into those five. Read-modify-write, or drop them from the PUT body by fetching the current row first.

**M10 — MEDIUM: `vendorName` is sourced from `evidence_ref`.**
`vendorName: s.evidence_type === 'booking' ? (s.evidence_ref || '') : ''` (`sr/server.js:1187`). `evidence_ref` is a free-text evidence pointer (`sr/server.js:246`), not a vendor name. This will put confirmation URLs and doc links into `bookings.vendor_name`, which is rendered as the vendor in packets. Leave `vendorName` empty and put the ref in `notes` until Showrunner has a real vendor field.

**M11 — MEDIUM: `clientContactCompany` is set on the event header but the name is not.**
`sr/server.js:1178` sets `clientContactCompany: project.client` with `clientContactName: ''`. The client-contacts backfill and most UI paths key off name/phone/email being non-empty (`staffing/server.js:728-732`), so a company-only legacy contact is inert clutter. Either send nothing to the five legacy `clientContact*` fields (recommended — the multi-row `client_contacts` table is the live one, `CLAUDE.md:247`) or send a complete contact.

**M12 — LOW: `clientId` resolution can 400.**
The commented resolver (`sr/server.js:1286-1292`) GETs `/api/clients`, matches case-insensitively, else POSTs. That's correct, but `POST /api/clients` returns **400** `Client name already exists` on a unique violation (`staffing/server.js:855`) — so treat 400 as "someone else created it, re-GET and match" rather than fatal.

**M13 — LOW: `eventDate: ''` stores an empty string, not NULL.** Harmless today (`event_date TEXT`, no constraint), but `''` sorts before real dates in `ORDER BY setup ASC` (`staffing/server.js:883`) and reads as "no date" in some UI paths. Prefer omitting the key.

**M14 — LOW: unused `deriveBookingCategory` branches.** `'Travel'` and `'Power/Cable'` have no staffing home at all; travel is not a booking (it is `travel_info`) and power/cable is `feeder_cable`.

#### Corrected mapping helpers (drop-in replacements)

```js
// REPLACES sr/server.js:1133-1142
// Staffing's category enum is closed — staffing/index.html:4392-4400.
// Anything outside these 7 keys is invisible in the staffing UI.
const SCHED_BOOKING_CATEGORIES = ['trucking','forklift','feeder_cable','install_labor','strike_labor','hotel','other'];
function deriveBookingCategory(title) {
  const s = String(title || '').toLowerCase();
  if (/hotel|lodging|room|motel/.test(s))                  return 'hotel';
  if (/truck|freight|shipping|ship|carrier|ltl/.test(s))   return 'trucking';
  if (/forklift|telehandler|scissor|boom|lift/.test(s))    return 'forklift';
  if (/feeder|cable|power|distro|generator|genny/.test(s)) return 'feeder_cable';
  if (/strike|load[- ]?out|tear[- ]?down|breakdown/.test(s)) return 'strike_labor';
  if (/install|load[- ]?in|stagehand|labor|hands|crew/.test(s)) return 'install_labor';
  return 'other';   // the real title always rides along in customLabel
}

// REPLACES sr/server.js:1144-1146
// Staffing's status enum is 'booked' | 'needed' — staffing/index.html:5215,5267.
function mapBookingStatus(status) { return status === 'done' ? 'booked' : 'needed'; }
```

Order matters: `strike_labor` must be tested before `install_labor` (both match `/labor/`), and `hotel` first so "hotel block for install crew" doesn't become labor.

### 2.5 B.2/B.3/B.4 exact payloads

**`POST /api/bookings`** (`staffing/server.js:2839-2853`) — 15 columns:
```json
{ "eventId": 42, "category": "trucking", "customLabel": "53ft dry van to venue",
  "vendorName": "", "contactName": "", "contactPhone": "", "contactEmail": "",
  "quantity": "1", "startDate": "2026-09-01", "endDate": "2026-09-05",
  "status": "needed", "confirmationNumber": "", "notes": "", "staffAssigned": [], "sortOrder": 0 }
```
`quantity` is **`TEXT`**, not a number (`staffing/server.js:745`) — send `"1"`, not `1`. `staffAssigned` is JSONB, `JSON.stringify`'d server-side (`:2849`); it must contain canonical roster names or the per-tech hotel lookup in §4.3 misses. All fields except `eventId`/`category` default to `''`/`[]`/`0`.

**`POST /api/venue-contacts`** (`:2768-2779`): `{ eventId, name, role, phone, email, sortOrder }`, all but `eventId` default `''`/`0`.

**`POST /api/client-contacts`** (`:2708-2718`): `{ eventId, name, title, company, phone, email, sortOrder }`, same defaults.

### 2.6 B.6 — the travel push Showrunner must add

`POST /api/travel` (`staffing/server.js:2637-2646`) is an upsert on the unique `travel_key`:
```sql
INSERT INTO travel_info (travel_key, flight_num, arrival_time, arrival_date, is_driving,
  departure_city, departure_date, departure_time, going_home, record_locator)
VALUES ($1..$10) ON CONFLICT (travel_key) DO UPDATE SET ...
```
Body → column: `key`→`travel_key`, `flightNum`→`flight_num`, `arrivalTime`→`arrival_time`, `arrivalDate`→`arrival_date`, `isDriving`→`is_driving`, `departureCity`→`departure_city`, `departureDate`→`departure_date`, `departureTime`→`departure_time`, `goingHome`→`going_home`, `recordLocator`→`record_locator`. Returns `{ ok: true }` — **no row echoed**, so nothing to capture. Idempotent by construction: re-pushing the same key updates in place. Missing `key` inserts a row with `travel_key = null`, which violates `NOT NULL` → **500**; guard client-side.

Add to `buildSchedulerPayloads`, returning `travel: [...]`:

```js
// travel_key MUST use the sentinel forms when there is no neighbouring event —
// see §4.2 and staffing/index.html:3850,3858.
function travelKey(person, idA, idB) { return `${person}|${idA}|${idB}`; }
function arrivalKey(person, prevEventId, eventId) {
  return prevEventId ? travelKey(person, prevEventId, eventId) : `${person}|${eventId}|inbound`;
}
function departureKey(person, eventId, nextEventId) {
  return nextEventId ? travelKey(person, eventId, nextEventId) : `${person}|${eventId}|outbound`;
}
```

One upsert per person per leg. `goingHome: true` on the outbound leg when the tech is not continuing to another show. **`person` must be the canonical roster name** (M6) — the packet builder lowercases `parts[0]` and matches against the roster map (`staffing/server.js:1931, 1961-1962`).

### 2.7 Order of operations and idempotency (required algorithm)

```
0. token = await schedulerToken()                          # §1.4.1
1. Validate: show.name non-empty; show.load_in_date non-empty (M7);
   every crew owner resolves against GET /api/roster (M6). Abort on any failure.
2. clientId  ← GET /api/clients, case-insensitive name match; else POST; on 400 re-GET (M12).
3. eventId:
     if show.scheduler_event_id:
         cur = (await GET /api/events).find(e => e.id === show.scheduler_event_id)
         if !cur → treat as unlinked (the event was deleted in staffing)
         PUT /api/events/:id with { ...cur, ...ourFields }        # read-modify-write (M9)
     else:
         created = POST /api/events {payload};  eventId = created.id
4. Children — DELETE-then-INSERT, scoped to this event, so re-push never duplicates (M8):
     existing = GET /api/bookings?eventId=N           (unauthenticated, :2824)
     for each b in existing where b came from Showrunner → DELETE /api/bookings/:id  (:2874)
     then POST the new set.
     Same for /api/venue-contacts (GET :2754, DELETE :2794)
      and /api/client-contacts   (GET :2694, DELETE :2734).
5. Travel: POST /api/travel per leg — upsert, no delete needed (§2.6).
6. Flex (optional, only if the Gear lane asks for it): POST /api/events/:id/flex/create-element.
   409 means already linked — treat as success, not error (:998).
7. Local: UPDATE shows SET scheduler_event_id, stage='scheduled' inside withTx + logActivity
   (already written at sr/server.js:1318-1323).
```

**Ownership marker problem (step 4):** the staffing app has no `source` column on `bookings`/`venue_contacts`/`client_contacts`, so Showrunner cannot distinguish rows it created from rows Brendon typed by hand. Two options, pick one and document it in the UI:
- **(a) Recommended, no schema change:** keep a Showrunner-side `pushed_child_ids` JSONB on `shows` recording the ids returned by each child POST. Delete only those on re-push. Rows a human added survive.
- **(b) Requires a staffing change:** add `source TEXT DEFAULT ''` to the three child tables and filter on `source='showrunner'`. Cleaner, but it is a write to the staffing repo — out of scope here.

**No transactions cross the wire.** Each HTTP call is its own commit; a mid-fan-out failure leaves a half-populated event. Make the push resumable rather than atomic: persist `scheduler_event_id` immediately after step 3 so a retry updates instead of duplicating.

### 2.8 Residencies (LOVB-shaped work)

If a Showrunner project maps to a residency rather than a standalone show, the parallel surface is: `POST /api/residencies` (`:3018`), `POST /api/residencies/:id/events` to attach (`:3057`), `POST /api/residencies/:id/spec-sheet` (`:3126`), `POST /api/residencies/:id/flex/create-folder` (`:3177`, derives its date span from member events and stamps `flex_span_start/end` for staleness — `:3199-3202`), and `POST /api/residencies/:id/apply-shipping` (`:3360`) which sets `no_ship_out`/`no_ship_return` on member events so only the first ships out and only the last ships back. Events join a residency via `residency_id` + `engagement_type` (`:679-680`), neither of which `POST /api/events` accepts — attach after creating.

---

## 3. Flex integration

### 3.1 Where it lives and how it authenticates

The entire client is **`staffing/server.js:26-363`** — inline in the monolith, no separate module. Constants at `:34-38`:

```js
const FLEX_EVENT_FOLDER_DEF_ID = '358f312c-b051-11df-b8d5-00e08175e43e';
const FLEX_PULL_SHEET_DEF_ID   = 'a220432c-af33-11df-b8d5-00e08175e43e';
const FLEX_MANIFEST_DEF_ID     = '9945d54c-af32-11df-b8d5-00e08175e43e';
const FLEX_GEAR_LIST_CODELIST  = ['name', 'quantity', 'note'];
const FLEX_TIMEZONE            = 'America/Chicago';
```

Auth (`staffing/server.js:54-79`):
- Header **`X-Auth-Token: <key>`** — *not* `Authorization: Bearer`.
- Base URL `process.env.FLEX_BASE_URL` = `https://e360sport.flexrentalsolutions.com`, trailing slash stripped (`:45`).
- Key `process.env.FLEX_API_KEY`. **One tenant-wide key shared by all users** — Flex's audit log attributes every API-created element to Tom (`flex_integration_plan.md:96`).
- Error shape: throws `Error('Flex API ' + status + ': ' + msg)` with `err.status` and `err.body` attached (`:69-77`), where `msg` prefers `body.exceptionMessage`, then `body.message`, then the first 200 chars of the text.

> **UNRESOLVED — flag for Tom:** the actual `FLEX_API_KEY` value is not in this repo (`.gitignore` excludes `.env`, and no `.env` file exists). It lives only in Railway's env-var store for the `e360-staffing3` service. **Showrunner needs it copied into its own Railway/host env before any Flex code can run.** Same for `FLEX_BASE_URL`, though that value is public and documented above.

### 3.2 Every Flex endpoint in use

| # | Method | Path (after the `/f5` prefix `flexFetch` adds) | Wrapper | Line |
|---|---|---|---|---|
| 1 | GET | `/api/user-profile/current-user` | `flexGetCurrentUser()` | `:81-90` |
| 2 | GET | `/api/element/{id}/identity` | `flexGetElement()` | `:111-113` |
| 3 | GET | `/api/element/{id}/tree` | `flexGetElementTree()` | `:115-117` |
| 4 | GET | `/api/line-item/{id}/row-data/?codeList=name&codeList=quantity&codeList=note&node=root` | `flexGetRowData()` | `:119-122` |
| 5 | GET | `/api/element/current-workflow-state?elementIds=A&elementIds=B…` | `flexEnrichWithStatus()` | `:159-183` |
| 6 | POST | `/api/element` | `flexCreateEventFolder()` / `flexCreateResidencyFolder()` | `:304`, `:354` |

**Added by Showrunner's READ path, 2026-08-28** (all GET, all verified live against
pull sheet `2e63b247-62e3-47b1-8460-88a9bb32bfba` / folder `257e6ba3-0ced-4ab0-9af4-976bb21c99c6`):

| # | Method | Path | Wrapper | Notes |
|---|---|---|---|---|
| 7 | GET | `/api/equipment-list/{id}` | `flexGetEquipmentList()` | 127 keys incl. the whole prep/ship/return block **and `definitionId`** |
| 8 | GET | `/api/user-profile/{userId}` | `flexGetUserName()` | resolves `prepCompletedUserId` → `{id,name,userName,emailAddress}` |

Endpoints **probed and rejected** — do not use them:
- `GET /api/eqlist-line-item/node-list/{parentId}?equipmentListId=…` — see BUG 4.
- `GET /api/equipment-list-definition-settings/{defId}` — 405 `Request method 'GET' not supported` (`tools/probe-output/05-definition-settings.json`).
- ~~`GET /api/equipment-list/{id}` — returns metadata only, no line items; superseded by #4.~~
  **CORRECTED 2026-08-28.** The observation was right and the conclusion was wrong
  (`FLEX_CAPABILITIES.md` §2.4). That "metadata" is the entire
  `prep/deprep/ship/return/receive/subrentalReturn` completion block — a boolean, a
  user id, a timestamp and a generated manifest id per stage — plus `definitionId`,
  `locked`, `open`, `weight` and the full date set. It does not replace #4; it is the
  other half of a read. Showrunner's `flexReadPullSheet()` calls both. Live proof:
  `prepCompleted:true`, `prepCompletedTimestamp:'2026-05-19T20:35:50'`,
  `prepCompletedUserId:'21ad5aca-…'` (= Tom Andres) on TT_26_1.
- `GET /api/user/{id}` — 404 `FLEX_5000`. A Flex **user** is not reachable there.
- `GET /api/contact/{id}` for a user id — 400 `Unable to find contact with id: …`.
  A Flex user and a Flex contact are different objects with different id spaces;
  `/api/user-profile/{id}` is the one that answers.

**R21 is RETIRED for the pull-sheet grammar.** §3.5's claim (top-level rows with
`group===true` whose children are items) was written from the spec with no probe
evidence. It is now confirmed against a real pull sheet — 9 such rows on TT_26_1 —
with one correction the spec did not have: a child row may itself carry
`container:true`, its own `resourceId`, `quantity` and `barcode`, **and** children.
That row is real gear AND a container. Treating it as a heading (which the first
draft of `flexNormalizePullSheet` did) silently deletes units from the sheet.

### 3.3 Known bugs and workarounds — all SIX

Three are documented in `flex_integration_plan.md:53-80`. Three more are only visible in the May-13 probe output and the shipped code; they are equally load-bearing.

**BUG 1 — the `/f5` URL prefix.** Swagger documents `/api/element`; the real URL is `/f5/api/element`. Without `/f5` you hit Apache's plain web tier and get **403 Forbidden as HTML**, not a JSON error — so a naive `res.json()` throws a parse error and hides the cause. Workaround: `flexFetch` unconditionally builds `flexBaseUrl() + '/f5' + cleanPath` (`staffing/server.js:56`). *Never* let a caller pass a path that already contains `/f5`.
(`flex_integration_plan.md:56-60`)

**BUG 2 — the date parser rejects `±HH:MM` offsets.** `2026-05-29T12:00:00-05:00` → HTTP 400 `Text '…' could not be parsed, unparsed text found at index 19`. Only ISO-8601 with a `Z` suffix is accepted. Workaround: `flexDateToUtcInstant()` builds the instant in `America/Chicago` via Luxon then `.toUTC().toISO({suppressMilliseconds:true})` (`staffing/server.js:96-102`).
(`flex_integration_plan.md:61-69`)

**BUG 3 — UTC midnight renders as the previous day.** Sending `2026-05-29T00:00:00Z` for a date-only field displays in Flex's UI as `5/28/2026 7:00 PM` (CDT). Workaround: send **noon Central**, expressed as UTC — `T17:00:00Z` in CDT, `T18:00:00Z` in CST. `flexDateToUtcInstant(dateStr, timeStr)` defaults `timeStr` to `'12:00'` when absent or not matching `/^\d{1,2}:\d{2}/` (`staffing/server.js:98`), and Luxon handles the DST boundary correctly — do **not** hand-roll the ±5/±6 offset.
(`flex_integration_plan.md:70-79`)

**BUG 4 — the documented line-item endpoint returns nothing, ever.** `GET /api/eqlist-line-item/node-list/{parentLineItemId}?equipmentListId=…` was probed with four different parent strategies (the element's own id, `0`, `null` literal, empty) and returned `{"content":[],"totalElements":0,"empty":true}` for **all** of them (`tools/probe-output/03-line-items-zero.json`, `03-line-items-self-as-parent.json`, `03-line-items-null-literal.json` — byte-identical, 478 bytes each). Workaround: use the flat `GET /api/line-item/{id}/row-data/` instead, which returns the full nested tree in one call. This is the single most expensive wrong turn available; the OpenAPI spec points straight at the dead end.

**BUG 5 — `codeList` is required, its values are ignored, and an empty value fails silently.** Omit `codeList` entirely → **400** `Required request parameter 'codeList' for method parameter type List is not present` (`tools/probe-output/06-header-data.json`). Pass `codeList=` (empty string) → **200 with `[]`** (`tools/probe-output/04-row-data-empty.json`) — you get an empty gear list and no error, which reads as "this pull sheet has no gear." Pass any non-empty list → the full 51-row payload; `["DEFAULT"]` and `["NAME","QUANTITY"]` returned byte-identical results (md5 `47250c6f…`), a 6-code verbose list differed only marginally. Workaround: always send the shipped `FLEX_GEAR_LIST_CODELIST = ['name','quantity','note']` plus `&node=root`, and **treat an empty array as suspicious rather than authoritative**.

**BUG 6 — `quantity` is null on serial-tracked items, and the name carries the serial.** Real row-data rows look like:
```json
{ "id":"900a4e69-…", "rootLineId":"900a4e69-…", "ordinal":0, "leaf":true, "group":false,
  "resourceId":"cbc5ffc0-…", "name":"2024 P10 Perimeter (6858)",
  "barcode":"A6B600000000000000006858", "serial":"6858", "isUnit":true,
  "quantity": null, "note":null, "isNote":false, "isVirtual":null, "stencil":"", "expanded":true }
```
(`tools/probe-output/04-row-data-common.json`, 51 rows.) Serial-tracked gear returns **N rows of quantity `null`**, untracked gear returns **one row with `quantity > 1`**. Two workarounds, both shipped:
- `flexCleanItemName(name)` strips a trailing parenthetical: `String(name).replace(/\s*\([^)]*\)\s*$/, '').trim()` (`staffing/server.js:186-188`). The cleaned name is the only stable "same item type" key, because each physical unit has its own `resourceId`.
- Quantity fallback: `const addQty = typeof c.quantity === 'number' && c.quantity > 0 ? c.quantity : 1` (`staffing/server.js:216, 239`), then sum by cleaned name. **Never trust `quantity` directly.**

### 3.4 Response shapes (verified against probe output)

**`/identity`** (`tools/probe-output/01-identity.json`):
```json
{ "id":"7bde0d38-…", "name":"Dallas Renegades  (Hosting in Fort Hood TX)",
  "documentNumber":"07CTI", "definitionId":"9945d54c-af32-11df-b8d5-00e08175e43e",
  "plannedStartDate":"2026-05-13T17:00:00", "plannedEndDate":"2026-05-25T17:00:00",
  "deleted":false, "domainId":"equipment-list",
  "displayName":"Dallas Renegades  (Hosting in Fort Hood TX) (07CTI)" }
```
Note: `plannedStartDate` comes back **without** the `Z` it was sent with. Note also `elementNumber` does not appear — `link-element` falls back `documentNumber || elementNumber || ''` (`staffing/server.js:1067`).

**`/tree`** (`tools/probe-output/tree-root.json`): nodes carry `nodeId` (not `id`), `name`, `documentNumber`, `parentId`, `iconUrl`, `leaf`, `domainId`, `children` (`null` on leaves). The root's `nodeId` is the folder's own id.

**`POST /api/element`** response, the parts that matter (`flex_integration_plan.md:146-155`):
```json
{ "elementId":"6fe1b084-…", "elementNumber":null, "elementName":"…",
  "definitionName":"Event Folder", "plannedStartDate":"2026-05-29T17:00:00" }
```
**`elementNumber` is always `null` for Event Folders** (`definitionNumberingEnabled: false`). Do not build UI that expects a friendly number; the shipped code coerces to `''` (`staffing/server.js:310`).

**Element creation payload** (`staffing/server.js:291-302`):
```json
{ "definitionId":"358f312c-b051-11df-b8d5-00e08175e43e",
  "name":"em-dashes stripped to hyphens", "notes":"", "printNotes":true,
  "plannedStartDate":"2026-08-29T17:00:00Z", "plannedEndDate":"2026-09-10T17:00:00Z",
  "loadInDate":"2026-09-01T17:00:00Z", "loadOutDate":"2026-09-05T17:00:00Z",
  "assignedToUserId":"<user UUID>", "personResponsibleId":"<contact UUID>" }
```
`loadInDate`/`loadOutDate` are omitted entirely when null (`:301-302`). Date derivation: `plannedStartDate = (shipOutDate || setup) − 3 days`; `plannedEndDate = (shipReturnDate || breakdown) + 7 days`, falling back to `plannedStart`; `loadInDate = setup` (with `setupTime` if it matches `HH:MM`); `loadOutDate = breakdown` (`staffing/server.js:277-289`).

**Never send** (`flex_integration_plan.md:190-197`): `secondaryClientId`, `billToId`, `secondaryVenueId`, `facilityId`, `locationId` (Flex defaults to the user's homebase), `currencyId`, `statusId` (let Flex default), any `customField*Value`, `salesPersonId`, `accountExecutiveId` (not visible on the Event Folder form).

> **Amended 2026-08-27 (Tom).** `clientId` and `venueId` LEFT the never-send list. The original reason was "an FK into Flex's contact DB, needing a lookup flow that doesn't exist" — Showrunner now has that flow (§3.4.1). They are still never *guessed*: the caller resolves an id or the key is absent from the payload entirely.

#### 3.4.1 The contact directory — and the create nobody has watched

Three facts, read off the live tenant on 2026-08-27 (artifacts: `flex-probe/contact-page0.json`, `contact-one.json`):

- **C1 — the shape.** `GET /f5/api/contact` answers a Spring page envelope `{content:[…], totalElements:24, totalPages:2, size:20, number:0, last}`. Each row is the *identity* projection only: `{id, name, preferredDisplayString, barcode, deleted, shortName, domainId:'contact', className:'CONTACT', shortNameOrName}`. There is no type discriminator on the listing — a person and a stadium look identical.
- **C2 — every filter is ignored.** `?searchText=`, `?name=` and `?query=` all return the same unfiltered page; only `size=` is honoured (`size=200` returns all 24 in one call, on any `page`). **Match locally, over the whole directory.** `lib/flex.js flexListContacts()` pages defensively and dedupes by id, because a `page` parameter that is silently ignored will otherwise return the first page forever.
- **C3 — the full record.** `GET /f5/api/contact/{id}` returns ~60 fields. An organisation contact ("Kansas City Municipal") carries `{name, organization:true, company:'<same name>', addresses:[…]}`. That is where the create payload comes from.

**The create is UNPROBED.** `OPTIONS /f5/api/contact` answers `Allow: POST,GET,HEAD,OPTIONS`, so the verb exists; the body `{name, organization:true, company:name}` is inferred from C3 and has never been executed. `flexCreateContact()` therefore treats *any* failure — non-2xx, or a 2xx carrying no id — as a reason to **omit the field and say so**, never as a reason to fail the folder create. The first live execution is the conductor's post-deploy run on Show 1.

**The v1 resolution rule** (`flexResolveContact`): exact local match → use that id · no match and "create missing contacts" is ON → POST the contact, use the returned id · no match with it OFF, or the create failed → **omit the field and report the reason**. Matching is case-insensitive and whitespace-collapsed but still EXACT — the real directory holds `Hard Rock  Stadium` and `Allegiant ` with the spacing a human typed, while `Citrus Sports Group` and `Citrus Sports group  Co` are two different contacts and must stay so. `deleted:true` rows never match.

**What the operator is told.** `POST /api/shows/:id/flex/create-element` returns `contacts:{client:{outcome,id,name,reason}, venue:{…}}` with `outcome` one of `matched | created | omitted`, and the omitted name is additionally written into the folder's `notes` (`Venue: Wrigley Field (not linked in Flex)`). A folder that lands without its venue says so twice rather than looking complete.

**Name sanitization:** `flexSanitizeName` maps `[–—―−]` → `-` (`staffing/server.js:92-94`). Flex silently strips em-dashes; do this before every POST.

**Deep link:** `https://e360sport.flexrentalsolutions.com/f5/ui/#element/<elementId>` — note the `#` SPA marker. If it ever 404s, append `/view/simple-element/header` (`flex_integration_plan.md:161-166, 303-309`).

### 3.5 Gear-list normalization (the part worth copying verbatim)

`flexFetchGearList(gearListId, gearListType)` (`staffing/server.js:192-262`) returns:
```ts
{ type: 'pull-sheet' | 'manifest',
  name: string, documentNumber: string,
  groups: Array<{ name: string,
                  type: 'category' | 'container' | 'loose',
                  containerSerial?: string,
                  items: Array<{ name: string, qty: number, resourceId: string }> }> }
```
Two different row grammars behind one envelope:
- **pull-sheet:** top-level rows with `group === true`; their `children` are the items; each becomes a `type:'category'` group.
- **manifest:** `leaf === true` rows are loose items (aggregated into a single `type:'loose'` group **unshifted to the front**); `leaf === false` rows are containers whose `children` are contents, emitted as `type:'container'` with `containerSerial = row.serial || row.barcode` (`staffing/server.js:223-258`).

Verified against the real manifest probe: 51 rows, 5 non-leaf containers (`Fabulux Quarter Pack (FQ007)` with 8 children, `VT Mini Rack (VB-mini-6)` with 2, …), 46 leaves, and **zero rows with `group === true`**.

> **Caveat to carry forward:** the pull-sheet branch (`group.group`) has **no probe evidence** — every saved probe response is a manifest (`definitionId 9945d54c…`). The pull-sheet path is written from the spec, not from an observed response. Validate it against a real pull sheet before trusting it.

### 3.6 `lib/flex.js` — the module Showrunner should have

Port, do not re-derive. Recommended shape:

```js
// lib/flex.js  — port of staffing/server.js:26-363
// env: FLEX_BASE_URL, FLEX_API_KEY   (copy both from the e360-staffing3 Railway service)
const { DateTime } = require('luxon');   // ← ADD luxon to showrunner's package.json

const FLEX_EVENT_FOLDER_DEF_ID = '358f312c-b051-11df-b8d5-00e08175e43e';
const FLEX_PULL_SHEET_DEF_ID   = 'a220432c-af33-11df-b8d5-00e08175e43e';
const FLEX_MANIFEST_DEF_ID     = '9945d54c-af32-11df-b8d5-00e08175e43e';
const FLEX_GEAR_LIST_CODELIST  = ['name','quantity','note'];
const FLEX_TIMEZONE            = 'America/Chicago';

flexBaseUrl()                       : string          // throws if env missing
flexApiKey()                        : string          // throws if env missing
flexFetch(path, options)            : Promise<any>    // BUG 1: prepends /f5. X-Auth-Token header.
                                                      // throws Error w/ .status + .body
flexGetCurrentUser()                : { userId, contactId, name }        // module-level cached
flexSanitizeName(s)                 : string          // em/en-dash → '-'
flexDateToUtcInstant(dateStr, time?) : string|null    // BUG 2+3: Central noon → ...Z
flexShiftDate(dateStr, days)        : string|null     // YYYY-MM-DD ± n days, TZ-safe
flexGetElement(id)                  : identity        // /api/element/{id}/identity
flexGetElementTree(id)              : treeNode        // /api/element/{id}/tree
flexGetRowData(id)                  : row[]           // BUG 4+5: /api/line-item/{id}/row-data/
flexFindGearListsUnder(folderId)    : [{id,name,documentNumber,type}]
flexEnrichWithStatus(items)         : items + .status // never throws; logs and returns unenriched
flexCleanItemName(name)             : string          // BUG 6: strip trailing "(serial)"
flexFetchGearList(id, type)         : envelope        // §3.5
flexCreateEventFolder({ event, notes, setup, setupTime, breakdown, shipOutDate, shipReturnDate })
                                    : { elementId, elementNumber, raw }
```

Showrunner-specific additions worth making:
- **Cache invalidation for `flexCurrentUserCache`** — the staffing version caches forever with no reset (`staffing/server.js:40, 82`). If the key is rotated, only a restart clears it. Give it a TTL.
- **Concurrency guard on `flexFindGearListsUnder`** — it issues one `/identity` call **per tree node, serially** (`staffing/server.js:131-151`). A deep Event Folder is an N+1 storm against a BETA API. Cap the walk depth and batch or throttle.
- **Do not swallow errors in `flexEnrichWithStatus`** as silently as the original does (`staffing/server.js:179-181` `console.warn` and returns unenriched) — surface a `statusUnavailable: true` flag so the UI can say so.

**Showrunner `package.json` change required:** add `"luxon": "^3.4.4"`. It is currently absent (deps are `bcryptjs`, `cors`, `express`, `pg`). The DST handling in BUG 3 is not optional — `flex_integration_plan.md:181-183` explicitly warns that the probe's hand-rolled offset is "good enough for testing but not for production."

**The API is officially BETA per Flex** (`flex_integration_plan.md:366`). Re-run `tools/flex_create_element_probe.py whoami` and `tools/flex_pull_sheet_probe.py inspect <id>` before believing any of the above after a Flex upgrade.

---

## 4. Travel / hotel read-back (for the Showrunner call sheet)

### 4.1 Storage

```sql
CREATE TABLE travel_info (            -- staffing/server.js:560-571 + :591-596
  id SERIAL PRIMARY KEY,
  travel_key      TEXT UNIQUE NOT NULL,
  flight_num      TEXT DEFAULT '',
  arrival_time    TEXT DEFAULT '',
  arrival_date    TEXT DEFAULT '',
  is_driving      BOOLEAN DEFAULT false,
  departure_city  TEXT DEFAULT '',
  departure_date  TEXT DEFAULT '',
  departure_time  TEXT DEFAULT '',
  going_home      BOOLEAN DEFAULT false,
  record_locator  TEXT DEFAULT ''
);
```
No `event_id` column. **The event linkage is encoded entirely in the `travel_key` string**, and there is no index on it beyond the unique constraint.

Hotels are **not** in `travel_info`. A hotel is a `bookings` row with `category = 'hotel'` and the occupants in `staff_assigned` (JSONB array of names) — `staffing/server.js:736-755`, `:1917`.

### 4.2 The `travel_key` scheme (complete — this is where `INTEGRATION.md` is incomplete)

Builder: `travelKey(person, idA, idB) => \`${person}|${idA}|${idB}\`` (`staffing/index.html:1475`).

**Three forms exist:**

| Form | Meaning | Written at |
|---|---|---|
| `Name\|prevEventId\|nextEventId` | one leg serving **both** events — prev's departure *and* next's arrival | `staffing/index.html:2584, 2652, 3354, 3371, 3465, 3475` |
| `Name\|eventId\|inbound` | arrival when there is **no previous event** | `staffing/index.html:3850, 3994` |
| `Name\|eventId\|outbound` | departure when there is **no next event** | `staffing/index.html:3858, 4004` |

Note the asymmetry: both sentinel forms put the event id in **position 1** (the "prev" slot), and the sentinel word in position 2.

> **DRIFT — `INTEGRATION.md` B.6 (line 175) documents only the first form.** It says "for the return leg use it as `prevEventId` with `goingHome: true`" and leaves `nextEventId` unspecified. If Showrunner writes `"Tom Andres|12|"` (empty third segment), the row stores fine and the packet builder even parses it as a departure — **but the staffing UI will never find it**, because the UI's own lookup constructs `"Tom Andres|12|outbound"` for that case. The row becomes orphaned data that only the email path can see. **The sentinels are mandatory.**

Also note the shared-leg semantics: `Tom|12|13` is simultaneously event 12's departure and event 13's arrival. Showrunner must not write a second row for the same physical leg.

### 4.3 The Tech Packet's actual queries

`POST /api/events/:id/send-packet` — `staffing/server.js:1877-1989`. (`GET /api/events/:id/packet-html`, `:1993`, and the admin packet, `:2271`/`:2365`, repeat the same query set.) In order:

```js
// event                                                                    :1885
'SELECT * FROM events WHERE id=$1'
// client name                                                             :1892
'SELECT name FROM clients WHERE id=$1'
// roster, keyed lowercased+trimmed  ← the canonical-name contract          :1897-1899
'SELECT * FROM roster'
// bookings                                                                :1905
'SELECT * FROM bookings WHERE event_id=$1 ORDER BY category, id'
// travel  ← THE query the task asked about (:1919-1924)
'SELECT * FROM travel_info WHERE travel_key LIKE $1 OR travel_key LIKE $2'
//   $1 = `%|%|${eventId}`     (arrivals: this event is the "next")
//   $2 = `%|${eventId}|%`     (departures + the inbound/outbound sentinels)
// venue contacts                                                          :1944
'SELECT * FROM venue_contacts WHERE event_id=$1 ORDER BY sort_order, id'
// client contacts                                                         :1948
'SELECT * FROM client_contacts WHERE event_id=$1 ORDER BY sort_order, id'
```

The disambiguation that follows (`staffing/server.js:1927-1941`) is the authoritative reading of the key — reproduce it exactly:

```js
for (const row of travelRes.rows) {
  const parts = (row.travel_key || '').split('|');
  if (parts.length < 3) continue;                  // malformed keys silently dropped
  const idStr = String(eventId);
  const personKey = parts[0].toLowerCase().trim();
  if (parts[2] === idStr)          travelByPerson[personKey] = row;   // arrival
  else if (parts[1] === idStr) {
    if (parts[2] === 'inbound')    travelByPerson[personKey] = row;   // arrival (no prev event)
    else                           returnByPerson[personKey] = row;   // departure (incl. 'outbound')
  }
}
```

Per-person hotel resolution (`staffing/server.js:1966-1969`):
```js
const hotelLines = allBookings.filter(b => b.category === 'hotel');          // :1917 — LOWERCASE
const myHotel = hotelLines.find(h => {
  const assigned = Array.isArray(h.staff_assigned) ? h.staff_assigned : JSON.parse(h.staff_assigned || '[]');
  return assigned.some(n => String(n).toLowerCase().trim() === lookupKey);   // lookupKey = person.toLowerCase().trim()
});
```
And hotels are excluded from the shared vendor list: `if (b.category === 'hotel') continue;` (`:1911`).

### 4.4 What already exists — no new endpoints are strictly required

**This is the biggest correction to the task premise.** Both read-back endpoints the brief asked me to spec **already exist and are unauthenticated**:

**`GET /api/travel`** — `staffing/server.js:2629-2636`. No `requireAuth`. `SELECT * FROM travel_info` (whole table, no filter, no pagination). Returns an **object keyed by `travel_key`**, not an array:
```json
{ "Tom Andres|11|12": { "flightNum":"AA1234", "arrivalTime":"14:20", "arrivalDate":"2026-09-01",
    "isDriving":false, "departureCity":"DFW", "departureDate":"", "departureTime":"",
    "goingHome":false, "recordLocator":"ABCDEF" },
  "Tom Andres|12|outbound": { ... } }
```

**`GET /api/bookings?eventId=N`** — `staffing/server.js:2824-2836`. No `requireAuth`. Optional `eventId` filter, `ORDER BY event_id, category, sort_order, id`. Returns an **array** of `dbToBooking` shapes (`:2802-2821`): `{ id, eventId, category, customLabel, vendorName, contactName, contactPhone, contactEmail, quantity, startDate, endDate, status, confirmationNumber, notes, staffAssigned, sortOrder }`. **No `category` filter parameter** — filter client-side.

Also already open and useful: `GET /api/events` (`:881`, all events, no filter), `GET /api/roster` (`:2484`), `GET /api/clients` (`:840`), `GET /api/venue-contacts?eventId=` (`:2754`), `GET /api/client-contacts?eventId=` (`:2694`).

**Recommendation: build the call sheet against these today. Do not wait on a staffing-repo change.**

```js
// lib/scheduler-readback.js — no staffing changes needed
async function fetchTravelForEvent(eventId) {
  const all = await schedulerGet('/api/travel');           // object keyed by travel_key
  const id = String(eventId);
  const arrivals = {}, departures = {};
  for (const [key, v] of Object.entries(all)) {
    const p = key.split('|');
    if (p.length < 3) continue;
    const person = p[0];
    if (p[2] === id)                 arrivals[person]   = { ...v, key };
    else if (p[1] === id) {
      if (p[2] === 'inbound')        arrivals[person]   = { ...v, key };
      else                           departures[person] = { ...v, key };
    }
  }
  return { arrivals, departures };                          // mirrors staffing/server.js:1927-1941
}

async function fetchHotelsForEvent(eventId) {
  const rows = await schedulerGet(`/api/bookings?eventId=${eventId}`);
  return rows.filter(b => b.category === 'hotel');          // lowercase — staffing/server.js:1917
}

function hotelForPerson(hotels, personName) {
  const k = String(personName).toLowerCase().trim();
  return hotels.find(h => (h.staffAssigned || []).some(n => String(n).toLowerCase().trim() === k)) || null;
}
```
`dbToBooking` already parses `staff_assigned` into a real array (`staffing/server.js:2818`), so no JSON.parse is needed on the Showrunner side.

### 4.5 The two additive endpoints — SPEC ONLY, do not implement

Worth adding **only** as an efficiency and access-control improvement, not as an unblock. If Tom green-lights a staffing-repo change, this is the minimal, purely additive shape.

**(a) `GET /api/travel?eventId=N`** — extend the existing route at `staffing/server.js:2629`, keeping the no-param behaviour byte-identical so the frontend (which loads the whole table into a `travelInfo` map) is unaffected.

```js
app.get('/api/travel', async (req, res) => {
  try {
    let r;
    if (req.query.eventId) {
      const id = String(parseInt(req.query.eventId, 10));            // integer-coerce: kills LIKE wildcards
      if (id === 'NaN') return res.status(400).json({ error: 'eventId must be an integer' });
      r = await pool.query(
        'SELECT * FROM travel_info WHERE travel_key LIKE $1 OR travel_key LIKE $2',
        [`%|%|${id}`, `%|${id}|%`]                                    // identical to staffing/server.js:1921-1923
      );
    } else {
      r = await pool.query('SELECT * FROM travel_info');              // unchanged
    }
    const obj = {};
    for (const row of r.rows) obj[row.travel_key] = { flightNum: row.flight_num, arrivalTime: row.arrival_time,
      arrivalDate: row.arrival_date||'', isDriving: row.is_driving, departureCity: row.departure_city||'',
      departureDate: row.departure_date||'', departureTime: row.departure_time||'',
      goingHome: row.going_home||false, recordLocator: row.record_locator||'' };
    res.json(obj);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```
Response shape is **unchanged** (key → object). Optionally add `CREATE INDEX IF NOT EXISTS travel_info_key_idx ON travel_info(travel_key text_pattern_ops);` — a leading-`%` LIKE cannot use it, so the win is marginal; skip unless the table grows past a few thousand rows.

**(b) `GET /api/bookings?eventId=N&category=hotel`** — extend `staffing/server.js:2824`:
```js
if (req.query.category) { query += (params.length ? ' AND' : ' WHERE') + ' category = $' + (params.length+1);
                          params.push(String(req.query.category)); }
```
Response shape unchanged (array of `dbToBooking`).

**Auth for both:** the honest recommendation is **leave them unauthenticated, matching every sibling GET**, and treat the fix as a whole-app decision rather than a two-route one. Adding `requireAuth` to `GET /api/travel` alone would **break the staffing frontend**, which calls it during the pre-login sync. If access control is wanted, the correct scope is: gate *all* read routes behind `requireAuth`, update `index.html`'s `authHeaders()` call sites, and accept that the lobby displays (`lobby.html`, `lobby2.html`, which poll the same open GETs) need a read-only token. That is a real project, not an additive tweak — flag it to Tom as such.

**Showrunner-side auth is unaffected either way**: `schedulerFetch` already attaches `x-auth-token` to every call, so if these routes are later gated, Showrunner keeps working with no change.

---

## 5. Spec-chain reality check (`.e360` → `.nsf` → `.pcfg`)

### 5.1 What these artifacts actually are

All three are **plain JSON documents written by three separate browser apps**. Verified by reading the five samples Tom banked at `C:\code\e360-staffing3\docs\spec-samples\`:

| Ext | Producer | Root marker | Top-level keys (observed) |
|---|---|---|---|
| `.e360` | Spec Sheet Generator | `{"version": 1, ...}` — note: **no `_app` key**, and `version` not `_version` | `version, fields, zones, complexSections, complexUnit, compassBearing, reverseNumbering, sideStates, layoutMode, clientLogoDataUrl` (+ `diagramView, modularConfig, isoCabStroke, isoLabelOverrides` in the newer sample) |
| `.nsf` | NovaSpec | `{"_version":1, "_app":"NovaSpec", ...}` | `_app, _version, fields, complexSections, complexUnit, compassBearing, reverseNumbering, fiberBoxes, ports, fieldType, fieldColor, showConnectors` |
| `.pcfg` | PowerSpec | `{"_app":"e360_power_cabling", "_version":1, "_saved":"<ISO>", ...}` | `_app, _version, _saved, clientName, sections, wattsPerCab, distros` |

Sample field values, to make the derivation concrete:
- `e360_vnl_chicago_sample.e360` → `fields.cabinetType:"p391"`, `fieldLength:"110"`, `fieldWidth:"59"`, `totalCabinets:"144"`
- `VNL_Chicago_2026-05-13.nsf` → `fields.cabType:"p391"`, `fieldLength:"110"`, `fieldWidth:"59"`, `sum(complexSections[].count) = 120`
- `Unified_Events.pcfg` → `sections:[{name:"Touchline", cabType:"p10", count:150}]`, `wattsPerCab:1000`, `distros:[{model:200, firstCab:79, lastCab:150, socapex:[…]}]`

`.e360` and `.nsf` share a **near-identical geometry sub-schema** (`complexSections[]` with `name/side/count/offset/fieldDist/direction/doubleStacked/stackFlow`, plus `compassBearing`, `complexUnit`, `reverseNumbering`). That is the physical evidence the derivation is real: NovaSpec reopens the `.e360` geometry. `.pcfg` collapses it further to `sections[].{name, side, cabType, count, gapBefore}`.

### 5.2 What exists, and what does not

**Searched and found nothing:** no parser, no generator, no validator, no transformer for any of the three extensions — not in `e360-staffing3` (only the five sample files and the DB columns), not in `d:\e360_office_lab\` (which contains only markdown, meeting transcripts, and `showrunner-app/`), not in `D:\e360_render_engine\` (its `window.e360.{update,play,stop}` at `RENDER_ENGINE.md:71,95` is a **JS template runtime API — an unrelated namespace collision**, not the spec format).

The three producing tools are **explicitly out of repo**: `CLAUDE.md:203-211` lists "Spec Sheet Generator", "NovaSpec", "PowerSpec", and "Test Pattern Generator" under *"Other apps in the E360 ecosystem (not in this repo)"*, and `CLAUDE.md:212` states flatly: *"The dashboard does NOT currently integrate with these."*

What the staffing app *does* have is **storage plus a browser-rendered cache**, and it is honest about it (`staffing/server.js:628-632`):
> *"Stored as raw JSON + pre-rendered SVG. SVG is produced **browser-side by hidden iframes loaded from the e360-tools source apps** and POSTed here for caching."*

So: 12 columns per event and per residency (`{e360,nsf,pcfg}_spec_{json,svg,html,png}` — `staffing/server.js:633-652`, `:671-673`); `POST /api/events/:id/spec-sheet` validates only that `type` is one of three, `json` is an object, and `svg` starts with `<svg` (`:1209-1225`); `GET` packs them back out (`:1189-1203`). **The server never opens the JSON.** It is an opaque blob store with a `<svg` prefix check.

### 5.3 So what does "making the chain real" mean server-side?

Split it cleanly. Do not let the roadmap pretend the second column is buildable this quarter.

| Capability | Where it lives | Buildable in Showrunner now? |
|---|---|---|
| Store the `.e360`/`.nsf`/`.pcfg` **bytes** (NAS path + metadata) | `files` table: `spec_type`, `nas_path`, `kind='spec'` (`sr/server.js:286-298`); path built by `buildNasPath()` (`sr/server.js:476-489`) | **Yes — already scaffolded** |
| Store the **render bundle** (json/svg/html/png) for view + print | mirror staffing's 12 columns, or a `spec_renders` table | **Yes** |
| **Revision tracking** — monotonic `rev` per (show, spec_type) | new columns / table | **Yes** |
| **Staleness flagging** — child stale when `child.derived_from_rev != parent.rev` | pure bookkeeping over the `depends_on` edges already in `steps` (`sr/server.js:247`) and the template chain (`sr/server.js:379-382`) | **Yes** |
| **Cross-artifact consistency check** — compare overlapping fields (§5.4) | reads the JSON blobs Showrunner already stores | **Yes — and it's the highest-value piece** |
| **Rendering** JSON → SVG/HTML/PNG | the three browser tools, via hidden iframe, POSTing the bundle back | **No — lives in the browser tools** |
| **Deriving** `.e360` → `.nsf` → `.pcfg` | a human opening the upstream file in the next tool | **No — human process, no code exists anywhere** |
| Flex pull sheet from `.pcfg` | a human building the pull sheet in Flex's UI; Showrunner only *links* it | **No — Flex's equipment list is read-only via API** (`flex_integration_plan.md:321-322`) |

**Plain statement for the build agent:** the derivation chain is a **human workflow across three browser apps**. Showrunner's job is to be the **ledger of that workflow**, not to perform it. Build: file storage + rev tracking + staleness propagation + a consistency checker + a "regenerate this downstream artifact" nudge with a deep link to the right tool. Do **not** scope any `.e360 → .nsf` transformer; there is nothing to port and no spec to write it from.

### 5.4 The consistency check worth building (and the evidence it's needed)

Because `.e360` and `.nsf` share a geometry schema, a server-side checker can compare them **without understanding either format**:

| Check | `.e360` path | `.nsf` path | `.pcfg` path |
|---|---|---|---|
| Cabinet type | `fields.cabinetType` | `fields.cabType` | `sections[].cabType` |
| Field length | `fields.fieldLength` | `fields.fieldLength` | — |
| Field width | `fields.fieldWidth` | `fields.fieldWidth` | — |
| Cabinet count | `fields.totalCabinets` | `sum(complexSections[].count)` | `sum(sections[].count)` |
| Section names/counts | `complexSections[].{name,count}` | `complexSections[].{name,count}` | `sections[].{name,count}` |
| Compass bearing | `compassBearing` | `compassBearing` | — |

All values are **strings** in `.e360`/`.nsf` `fields` and **numbers** in `.pcfg` — coerce before comparing.

**Tom's own banked samples already disagree**, which is the argument for building this:
- `VNL Chicago`: `.e360` says `totalCabinets: "144"`; the matching `.nsf` sections sum to **120**. A 24-cabinet gap.
- `Unified Events`: `.e360` says `fieldWidth: "225"`; the `.nsf` says **`"222"`**. The `.pcfg` agrees with the `.e360` on count (150) and cab type (p10).

Two real, shipped specs that would each have thrown a warning. This check pays for itself on day one and requires no cooperation from the browser tools.

**Rev mechanism (recommended, matching `INTEGRATION.md`'s Part (a) sketch):** give each stored spec a monotonic `rev` + `updated_at`; store `derived_from_rev` on each child; stale ⟺ `child.derived_from_rev != parent.rev`. On binding a parent type, bump `rev` and flag every descendant along the `.e360 → .nsf → .pcfg → pull sheet` edges. This mirrors a pattern the staffing app already ships: residency Flex folders bank `flex_span_start`/`flex_span_end` at link time precisely so the folder can be flagged stale when member events reschedule outside the recorded span (`staffing/server.js:683-684`, stamped at `:3199-3202`, surfaced as `flexDatesStale` at `:3203`). Same idea, different edge.

---

## 6. Risk register

### Auth and access

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | **No durable service credential exists.** Sessions are an in-memory `Map`, 12 h TTL, wiped on every Railway redeploy. A static `SCHEDULER_API_TOKEN` will be dead within hours. | `staffing/server.js:512-515`; `CLAUDE.md:100-104` | Login-per-boot + 401-retry (§1.4.1). Never hardcode a token. |
| R2 | **`requireAuth` ignores role.** Any session — including `view`/`crew` — can write every event, booking, contact, and travel row. | `staffing/server.js:525-531`; role checked only at `:799`, `:3435` | Give the robot the least-privileged role that exists (`edit`); understand it buys nothing security-wise. |
| R3 | **Every read route is public.** `/api/events`, `/api/travel`, `/api/bookings`, `/api/roster`, `/api/clients`, `/api/venue-contacts`, `/api/client-contacts` — no auth. Crew names, phone numbers, emails, flight numbers, PNRs, hotel confirmations, all readable by anyone who can reach the host. | `:881, :2629, :2824, :2484, :840, :2754, :2694` | Convenient for Showrunner today. Flag to Tom as a standing exposure — the PNRs in `record_locator` are the sharpest edge. |
| R4 | **`GET /api/export` dumps the entire DB to any authenticated session** — it is `requireAuth` but **not** admin-gated, unlike `POST /api/import`. | `:3398` vs `:3435` | Report only. |
| R5 | **`POST /api/roster/bulk` and `POST /api/seed` are unauthenticated writes.** `bulk` upserts roster rows by name with no auth at all. | `:2519`, `:2657` | Report only. Do not use them from Showrunner. |
| R6 | Password hashing is `sha256(password + 'e360salt')` — unsalted-per-user, no KDF. | `:506-508` | Report only; use a long random password for the robot account. |
| R7 | **`cors()` with no options** — any origin, any site. | `:17` | Convenient for Showrunner; a real exposure given R3. |

### Data model surprises

| # | Risk | Evidence |
|---|---|---|
| R8 | **`PUT /api/events/:id` is a full 23-column replace.** Omitted fields are written as defaults, not preserved. Re-push wipes `techNotes`, `setupTime`, `eventTime`, `mediaServer`, `staff`, and un-archives. The other 15 columns (`flex_*`, `*_spec_*`, `route_id`, `residency_id`, `engagement_type`) are outside the UPDATE and survive. | `:907-921` |
| R9 | **No foreign keys anywhere.** Orphaned children are silently possible; the only cascade is manual in `DELETE /api/events/:id`, and it does **not** clean `travel_info` (whose rows are unreachable by event id) or detach `route_id` — despite `CLAUDE.md:111` claiming it does. | `:690, :703, :738, :928-936` |
| R10 | **`bookings.quantity` is `TEXT`, not a number.** | `:745` |
| R11 | **`bookings.category` is an unenforced free-text column fronting a closed 7-key UI enum.** Anything outside the seven is stored and then invisible. This is M1/M2 and the single most likely way a push "succeeds" while producing nothing a human can see. | `:739` vs `staffing/index.html:4392-4400, 5179-5188` |
| R12 | **`travel_info` has no `event_id`.** The link is a `LIKE`-matched substring of a composite string key, with three legal formats including two sentinel words. | `:560-571`, `:1921-1923`, `staffing/index.html:3850, 3858` |
| R13 | **Auto-archive will hide pushed events.** Any event with `breakdown` more than 7 days past is flipped `archived = true` on startup and every 24 h. A Showrunner push of a historical show disappears from the main view immediately. | `:3642-3662, :3669-3672` |
| R14 | **Legacy `client_contact_*` columns on `events` are dead but load-bearing for a backfill** that runs on every boot. Writing them can resurrect a duplicate contact. | `:714-734`; `CLAUDE.md:247` |
| R15 | **Hotel `staff_assigned` goes stale** when a tech is removed from an event — the UI badges it but never cleans it. A Showrunner re-push that changes the crew leaves ghost hotel assignments. | `CLAUDE.md:248` |

### The staffing app's own bugs on our paths

| # | Bug | Evidence |
|---|---|---|
| R16 | `POST /api/events/:id/spec-sheet` and `.../clear` reject with the message **`type must be "e360" or "nsf"`** even though `pcfg` is accepted — the message was never updated when the third type landed. Cosmetic, but it will send a debugger down the wrong path. | `:1210, :1240` |
| R17 | `flexFindGearListsUnder` issues **one `/identity` call per tree node, serially**, against a BETA API. Deep folders are an N+1 storm and a latency cliff. | `:126-155` |
| R18 | `flexEnrichWithStatus` swallows every error and returns items with `status: ''` — indistinguishable from "genuinely no workflow state". | `:159-183` |
| R19 | `flexCurrentUserCache` never expires and has no reset path — a rotated `FLEX_API_KEY` requires a process restart. | `:40, :82` |
| R20 | The travel `LIKE` patterns interpolate `req.params.id` into the pattern string. It is passed as a bound parameter (no SQL injection), but `%` or `_` in the id becomes a **wildcard**, over-matching. | `:1921-1923` |
| R21 | The `.e360`/`.nsf` **pull-sheet** normalization branch (`group.group === true`) has **no probe evidence** — every saved probe response is a manifest. Untested code path. | `:208-222` vs `tools/probe-output/04-row-data-common.json` (0 rows with `group === true`) |
| R22 | **The Flex API is officially BETA.** Shapes can change without notice; three of the six known bugs are undocumented behaviours, not spec'd contracts. | `flex_integration_plan.md:366` |
| R23 | `POST /api/events` performs **no validation whatsoever**. A missing `event` yields a raw Postgres error inside a 500, not a 400. Showrunner must validate before pushing or it will get unactionable errors. | `:887-901` |

### Operational

| # | Risk | Evidence |
|---|---|---|
| R24 | **`ssl: { rejectUnauthorized: false }` is forced whenever `DATABASE_URL` is set** — a plain local Postgres fails to connect. Real local-dev trap. | `:21-24` |
| R25 | **Two probe-created test elements are still live in Flex** (`eae48d0e-…` and `6fe1b084-…`, names starting `TEST -`) and were never deleted. They will show up in any tenant-wide search. | `flex_integration_plan.md:46-51` |
| R26 | **No tests anywhere.** Manual QA only. Nothing will catch a regression in these paths. | `CLAUDE.md:31` |
| R27 | Both apps read the bare `PORT` env var (staffing → 3000, showrunner → 3100). Launching both from one shell with `PORT` set collides. | `:3668`; `sr/server.js:1348` |
| R28 | `CLAUDE.md` is stale in at least two places (`GMAIL_PASS` vs `GMAIL_APP_PASSWORD` at `:30`; "detach its routes" at `:111`). Treat it as narrative context, not as spec. | — |
| R29 | Adding `requireAuth` to `GET /api/travel` would **break the staffing frontend and both lobby displays**, which poll it unauthenticated. Any auth hardening must be app-wide, not route-local. | `:2629`; `lobby.html`, `lobby2.html` |

---

## 7. `INTEGRATION.md` drift summary

`INTEGRATION.md` is broadly accurate on the route inventory, the column mapping in B.1/B.3/B.4, and the two-tier spec storage model. Five things in it are wrong or incomplete, in descending order of blast radius:

1. **B.2 booking categories (line 111)** — claims `category` is *"free-text; values the app already uses/special-cases include `truck`, `forklift`, `stagehands`, `labor`, `rental`, `shipping`, and `hotel`."* Only `forklift` and `hotel` are real. The actual closed enum is `trucking, forklift, feeder_cable, install_labor, strike_labor, hotel, other` (`staffing/index.html:4392-4400`), and non-members are invisible in the UI. **§2.4 M1/M2.**
2. **B.2 booking status (line 122)** — implies `status` is open with default `'needed'`. The enum is `booked | needed`, and Showrunner emits `'confirmed'`, which is neither. **§2.4 M3.**
3. **B.6 `travel_key` format (line 175)** — documents only `Person|prevEventId|nextEventId`. The mandatory `Person|<eventId>|inbound` / `|outbound` sentinel forms are missing; without them, rows Showrunner writes are invisible to the staffing UI. **§4.2, §2.4 M5.**
4. **Guardrail 4 (line 193)** — asserts an automated push *"needs a durable service credential / API key."* No such mechanism exists or is planned. The workable answer is programmatic login + 401-retry against `POST /api/auth/login`. **§1.4.1.**
5. **Part (b) architecture note (line 75)** — describes Showrunner and staffing as *"the same app + same Postgres"* with promote as an in-process transaction. That is not the shipped shape: Showrunner is a separate service with its own Postgres and its own `users` table (`sr/server.js:37, 321-329`), and the push is HTTP. Every call is its own commit; **the fan-out is not atomic** and must be made resumable instead. **§2.7.**

Minor: the Part (a) claim that the read-back endpoints need to be built is also wrong — `GET /api/travel` and `GET /api/bookings?eventId=` already exist, unauthenticated (**§4.4**).

---

## 8. Open items for Tom

1. **`FLEX_API_KEY` value.** Not in the repo (gitignored, no `.env` present). It exists only in the `e360-staffing3` Railway env store. **Showrunner cannot make a single Flex call until this is copied across.** Decide also whether Showrunner shares Tom's key (Flex audit logs will attribute Showrunner-created elements to Tom, same as the dashboard today) or gets its own.
2. **The `showrunner` service account.** Needs creating in the staffing app's Users tab (admin-only) with role `edit`, then its username/password into Showrunner's env as `SCHEDULER_USER` / `SCHEDULER_PASS`.
3. **`SCHEDULER_BASE_URL`.** The staffing app's live Railway URL is not recorded in either repo.
4. **Child-row ownership on re-push (§2.7).** Pick (a) Showrunner-side id tracking — no staffing change — or (b) a `source` column on the three child tables, which is a write to `e360-staffing3`. Default to (a) unless Tom wants the staffing change.
5. **Whether the two read-back endpoints in §4.5 are wanted at all.** They are an optimization, not an unblock. The related question — whether *any* staffing read route should require auth (R3) — is a bigger decision with lobby-display fallout (R29).
6. **The pull-sheet code path is unverified (R21).** Someone should run `python tools/flex_pull_sheet_probe.py inspect <a-real-pull-sheet-uuid>` and bank the output before Showrunner depends on gear-list grouping. Every existing probe artifact is a manifest.
7. **Two stale `TEST -` elements are still live in Flex (R25).**

## §5 addendum — stacked zones (Tom, 2026-08-27)
Spec-sheet caution from Tom: **some designs have double-stacked zones that change the cabinet count** — so a cross-artifact check that naively sums per-zone counts and compares to the .e360 total will raise FALSE mismatches on valid specs (the VNL 144-vs-120 case in §5.4 may be exactly this, not an error). Any consistency checker must be stack-aware: understand zone stacking before comparing totals, and when artifacts differ, report it as "verify stacking" (a question), never "spec error" (an accusation). Get Tom to walk through one real stacked-zone spec before finalizing the checker's rules.

## §8 addendum — resolved values (Tom, 2026-08-27)
- **SCHEDULER_BASE_URL** = `https://web-production-f9d318.up.railway.app` (the Staffing & Planner production deployment; confirmed by Tom).
- **FLEX_API_KEY**: confirmed to live in the staffing service's Railway variables — Tom copies it into showrunner's .env / Railway variables himself; never committed, never pasted into chat.
- **Tools directory**: `https://e360-tools-production.up.railway.app/` links all E360 tools — including **E360 Spec Sheet** (`/e360/`), **NovaSpec** (`/novaspec/`), **Power Spec** (`/powerspec/`): these deployed web tools are almost certainly the ORIGIN of the .e360/.nsf/power-spec chain artifacts (relevant to §5 — the "derivation is a human workflow" finding: the humans use THESE tools). Source repo location TBD — spec-chain integration should consider deep-linking Showrunner → these tools, or having them export into Showrunner.
- Still pending from Tom: create the `showrunner` service user in the staffing app admin (SCHEDULER_USER/SCHEDULER_PASS).
- **RESOLVED 2026-08-27:** Tom created the `showrunner` admin account in the planner; credentials in his password manager → SCHEDULER_USER / SCHEDULER_PASS env vars at wiring time.

---

# §9 — Tools bind-to-Showrunner

**Recon source (READ-ONLY, nothing written):** `C:\code\e360-tools\`, deployed at `https://e360-tools-production.up.railway.app/`.
**Written:** 2026-08-27, after the §5/§8 addenda. This section *resolves* the §8-addendum open question "Source repo location TBD" and *grounds* the §5 stacking caution in the real formats. Nothing here contradicts §5 or §8 — §9.2 supplies the evidence those addenda asked for.

Line references in this section:
- `tools/e360:N` → `C:\code\e360-tools\e360\index.html` (547 KB)
- `tools/novaspec:N` → `C:\code\e360-tools\novaspec\index.html` (144 KB)
- `tools/powerspec:N` → `C:\code\e360-tools\powerspec\index.html` (81 KB, React via in-page Babel)
- `sr/<path>:N` → `d:\e360_office_lab\showrunner-app\<path>`

> **⚠ Context change since §1–§8.** Those sections were written against Showrunner's monolithic `server.js`. A concurrent build has since **refactored it into `routes/` + `lib/`** (`sr/server.js` is now an 11 KB bootstrap; the surface lives in `routes/{auth,agent,core,files,finance,purchasing,notes,schedule,photos,deliverables,proposals}.js` and `lib/{auth,db,agent,storage,mappers,enums,http,firewall,activity,mentions,seed}.js`). §9 is written against **that** code. §2's push-to-scheduler analysis still stands — verify its line numbers against the new `routes/schedule.js` before implementing.

---

## 9.1 The existing "Bind to Dashboard Event" mechanism

### 9.1.1 It exists in all three tools, and it is the same code three times

| Tool | Button | Bind block | `DASHBOARD_URL` | `specType` sent |
|---|---|---|---|---|
| Spec Sheet Generator | `tools/e360:860` — `📤 BIND TO DASHBOARD EVENT` (sidebar) | `tools/e360:5631-5715` | `tools/e360:5638` | `e360` (`:5676`) |
| NovaSpec | `tools/novaspec:316` — `📤 Bind to Dashboard Event` (sidebar) | `tools/novaspec:2280-2360` | `tools/novaspec:2287` | `nsf` (`:2323`) |
| PowerSpec | `tools/powerspec:1010` — `📤 BIND TO DASHBOARD` (React toolbar, calls `window.bindToDashboardEvent`) | `tools/powerspec:1130-1171` | `tools/powerspec:1031` | `pcfg` (`:1136`) |

All three hardcode the same target:
```js
const DASHBOARD_URL    = 'https://web-production-f9d318.up.railway.app';
const DASHBOARD_ORIGIN = new URL(DASHBOARD_URL).origin;
```
That is the same URL §8's addendum records as `SCHEDULER_BASE_URL`. **It is a compile-time constant in three separate static files** — see §9.4.

Git history confirms the build order: `d94e6c1` e360 headless render → `e52b57e` NovaSpec headless render → `ec33a76` render returns `{svg, pageHtml}` → `6e73a9e` `?embed=dashboard` → `185bc27` bind button on e360 + novaspec → `8392a50` PowerSpec integration (all three flows at once) → `2c83ee4` PowerSpec SVG xmlns fix.

### 9.1.2 The flow — and the auth insight that makes it work

**The tools never call the staffing API and never hold a credential.** They open the *dashboard itself* in a popup; the dashboard, which already has the operator's session, performs the write. This is the single most important architectural fact in §9.

```
TOOL (e360-tools origin)                     DASHBOARD (staffing origin)
──────────────────────────                   ────────────────────────────
click "Bind to Dashboard Event"
  window.open(DASHBOARD_URL
      + '?bind-spec=1&specType=e360',
      'bind-spec-popup', '900x720')   ────▶  loads, runs normal init (auth+data)
                                             sees ?bind-spec=1  (index.html:4383-4389)
                                             openBindSpecOverlay(specType)  (:6100)
                                               └ if !isLoggedIn() → login prompt,
                                                 poll every 250 ms up to 5 min (:6118-6148)
                                  ◀────       postMessage {type:'bind-popup-ready',
                                                           specType}   (:6159)
  onMessage → sendSpec():
    json     = collectProjectData()
    svg      = renderTopdownSvg()
    pageHtml = captureE360PageHtml()
    png      = await _bindSvgToPng(svg)
  popup.postMessage({type:'bind-spec-data',
      json, svg, png, pageHtml},
      DASHBOARD_ORIGIN)             ────▶    _bindSpecMessageHandler (:6167)
                                             → _renderBindEventPicker()  (:6182)
                                               filtered list + search box
                                             user clicks an event
                                             confirmBindToEvent(eventId)  (:6235)
                                               confirm() overwrite warning
                                               POST /api/events/:id/spec-sheet
                                                 headers: authHeaders()   ← session token
                                                 body: {type, json, svg,
                                                        html: pageHtml, png}  (:6247-6257)
                                  ◀────       postMessage {type:'bind-complete',
                                                  eventId, eventName}  (:6258)
  alert('✓ Bound to: ' + eventName)          setTimeout(window.close, 1200)
```

Error path: if the tool's `sendSpec()` throws, it posts `{type:'bind-source-error', error}` and the popup renders `_showBindError` (`staffing/index.html:6176, 6267`).

**The API call is exactly the `POST /api/events/:id/spec-sheet` documented in §2.2 (B.7e) / `staffing/server.js:1206`** — `{type, json, svg, html, png}`, validated as: `type ∈ {e360,nsf,pcfg}`, `json` an object, `svg` a string starting `<svg`, `html`/`png` optional strings.

### 9.1.3 The render bundle each tool produces

| Piece | e360 | novaspec | powerspec |
|---|---|---|---|
| `json` | `collectProjectData()` `tools/e360:3216` | `collectNsfData()` `tools/novaspec:2098` | `window.PowerSpec.collectData()` `tools/powerspec:963` |
| `svg` | `renderTopdownSvg()` `tools/e360:5572` — dispatches on `layoutMode`; **`modular` returns a placeholder SVG saying "Modular layouts are not rendered in the dashboard preview"** (`:5574-5576`) | print-style cabling diagram `tools/novaspec:2227+` | `tools/powerspec:1065-1079` — toggles `setPrintMode(true)`, captures, restores |
| `pageHtml` | `captureE360PageHtml()` `tools/e360:5586-5601` — clones `<link rel=stylesheet>` + inline `<style>` from `<head>`, wraps `#page1.outerHTML` in a full `<!doctype html>` with `#page1{box-shadow:none!important}` | same pattern over `#sheetWrap` | same pattern |
| `png` | `_bindSvgToPng(svg)` `tools/e360:5641-5671` — awaits `document.fonts.ready`, parses `width`/`height`/`viewBox` off the `<svg>` tag, rasterizes at **`SCALE = 2`** onto a white-filled canvas, returns `canvas.toDataURL('image/png')`. **Failure is non-fatal** — logs a warning and binds with `png: ''` so emails fall back to inline SVG (`:5709-5710`). |

This is precisely the two-tier model §5.2 describes: the tool renders in the browser and POSTs the cache; the server never opens the JSON.

### 9.1.4 Two sibling mechanisms in the same code (both reusable)

**(a) Headless render** — `tools/e360:5564-5628`, `tools/novaspec:2227-2277`, `tools/powerspec:1115-1128`. The dashboard loads the tool in a **hidden iframe** and posts `{type:'render-spec', id, json}`; the tool replies `{type:'render-spec-result', id, svg, pageHtml}` or `{..., error}` to `e.origin`. `tools/e360:5613` exposes it as `window.E360Render.renderTopdownFromJson(json)`; PowerSpec routes through `window.PowerSpec.loadFromJson` (`:1121`). This is how the dashboard re-renders a stored spec without the operator opening the tool.

**(b) Embed / edit mode** — `?embed=dashboard`. `tools/e360:5725-5791`, `tools/novaspec:2369-2431`, `tools/powerspec:1174-1233`. Hides all chrome via injected CSS (`body > *:not(#page1):not(#embed-toolbar):not(script){display:none!important}`), adds a fixed Save/Cancel toolbar, and speaks a tiny protocol with `window.parent`: tool posts `{type:'edit-ready'}`, parent posts `{type:'edit-load', json}`, tool posts `{type:'edit-save', json}` or `{type:'edit-cancel'}`. PowerSpec tags `documentElement` with `.powerspec-embed` instead of styling `body > *`, because React owns the tree (`tools/powerspec:1180`).

### 9.1.5 Defects in the existing bind (inherit none of these)

| # | Defect | Evidence |
|---|---|---|
| T1 | **The dashboard's message handler does not check `e.origin`.** `_bindSpecMessageHandler` (`staffing/index.html:6167-6180`) accepts `bind-spec-data` from *any* origin, and `_startBindSpecFlow` posts `bind-popup-ready` with target `'*'` (`:6159`). The tools *do* check (`e.origin !== DASHBOARD_ORIGIN`, `tools/e360:5685`). Exploiting it needs the user to have the popup open, so severity is low — but the Showrunner version must check both directions. |
| T2 | **`.pcfg` is mislabelled as `.nsf` in the UI.** `const ext = _bindSpecType === 'e360' ? '.e360' : '.nsf'` at **both** `staffing/index.html:6192` and `:6232`. PowerSpec was added later (`8392a50`) and these two strings were never updated, so a PowerSpec bind tells the user it is attaching a `.nsf`. Cosmetic, but it will confuse anyone debugging the chain. |
| T3 | **The picker only offers non-archived, future events.** `staffing/index.html:6185-6189` filters `!ev.archived` and `(breakdown \|\| eventDate \|\| setup) >= today`. Combined with §6/R13 auto-archive (anything with `breakdown` >7 days past), a spec cannot be bound to a recently-finished show. |
| T4 | **Bind silently overwrites.** `POST /api/events/:id/spec-sheet` is a blind `UPDATE` of the four columns for that type (`staffing/server.js:1227-1230`). The only guard is a client-side `confirm()` (`staffing/index.html:6234`). No revision, no history, no staleness — exactly the gap §5.3/§5.4 exist to close. |
| T5 | **The dashboard origin is a hardcoded constant in three separate static files** — see §9.4. |

---

## 9.2 The real save/load formats — and the stacking answer

Ground truth from the serializers, cross-checked against the five samples in `C:\code\e360-staffing3\docs\spec-samples\`.

### 9.2.1 `.e360` — Spec Sheet Generator

Written by `saveProject()` (`tools/e360:3255-3265`) as `JSON.stringify(collectProjectData(), null, 2)`, filename `e360_{clientName_slug}.e360`. Read by `applyProjectData(p)` (`tools/e360:3266`), which throws `'Invalid file'` unless `p.version` is truthy.

```jsonc
{
  "version": 1,                    // NOTE: `version`, NOT `_version`. No `_app` key at all.
  "fields": {                      // every value is a STRING (read off DOM .value) — tools/e360:3217-3229
    "clientName": "", "venueName": "", "contentDeadline": "", "releaseDate": "",
    "sport": "", "cabinetType": "p10|p391|…", "fieldLength": "", "fieldWidth": "",
    "totalCabinets": "",           // ⚠ HAND-TYPED FREE TEXT — never computed. See 9.2.4.
    "compassBearingInput": "", "submitUrl": "",
    "cm_name": "", "cm_phone": "", "cm_email": "",   // content manager
    "td_name": "", "td_phone": "", "td_email": "",   // technical director
    "codecName": "", "codecContainer": "", "codecFps": "", "codecDuration": "",
    "codecBitrate": "", "codecNotes": ""
  },
  "sideStates": { "south": bool, "north": bool, "east": bool, "west": bool },
  "layoutMode": "u" | "complex" | "modular",
  "complexUnit": "ft" | "m",
  "complexSections": [ { "name","side","count","offset","fieldDist","direction",
                         "cabOverride"? } ],        // ⚠ NO doubleStacked — see 9.2.4
  "reverseNumbering": bool,
  "compassBearing": 0,
  "diagramView": "topdown" | "iso",
  "isoCabStroke": bool,
  "isoLabelOverrides": {},
  "modularConfig": { "cabType","cabsWide","cabsTall","mounting","sdi":{} },
  "zones": [ { "name","color","first","last","doubleStacked" } ],   // ← stacking lives HERE
  "clientLogoDataUrl": "data:image/png;base64,…" | null
}
```

Two details worth copying:
- **`layoutMode` selects which geometry key is authoritative.** `'u'` → `sideStates` + `zones`; `'complex'` → `complexSections`; `'modular'` → `modularConfig`. Any consumer *must* branch on it. (`applyProjectData` defaults it to `'u'` — `tools/e360:3287`.)
- **`clientLogoDataUrl` is MIME-gated on load**: `/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/` (`tools/e360:3322`), explicitly to stop a malicious `.e360` smuggling `data:image/svg+xml,<svg onload=…>`. **Showrunner must apply the same gate anywhere it renders a stored `.e360`.**

### 9.2.2 `.nsf` — NovaSpec

Written by `saveSheet()` (`tools/novaspec:2115`) from `collectNsfData()` (`tools/novaspec:2098-2113`), filename `{jobName}_{YYYY-MM-DD}.nsf`. Read by `applyNsfData(data)` (`tools/novaspec:2127`), which throws `'This does not appear to be a NovaSpec file.'` unless `data._app === 'NovaSpec'`.

```jsonc
{
  "_version": 1,
  "_app": "NovaSpec",
  "fields": { "jobName","venue","showDate","techName","revision","procModel",
              "maxPixels","techNotes","cabType","fieldLength","fieldWidth" },   // all strings
  "complexSections": [ { "name","side","count","offset","fieldDist","direction",
                         "doubleStacked": bool,          // ← stacking lives HERE
                         "stackFlow": "snake"|"parallel",
                         "cabOverride": null } ],
  "complexUnit": "ft", "compassBearing": 0, "reverseNumbering": bool,
  "showConnectors": bool, "fieldType": …, "fieldColor": …,
  "ports": [...], "fiberBoxes": [...]
}
```
`applyNsfData` back-fills defaults on every section: `{doubleStacked:false, stackFlow:'snake', cabOverride:null, ...s}` (`tools/novaspec:2129-2131`) — so an older `.nsf` without those keys loads clean.

### 9.2.3 `.pcfg` — PowerSpec

Written by `saveConfig()` (`tools/powerspec:979-989`), filename `{clientName}.pcfg`. The in-memory `collectData()` (`tools/powerspec:963`) omits `_saved`; the file write adds it.

```jsonc
{
  "_app": "e360_power_cabling", "_version": 1,
  "_saved": "2026-05-13T21:20:57.471Z",     // file only, not in collectData()
  "clientName": "Unified Events",
  "sections":  [ { "name","side","cabType","count","gapBefore" } ],  // ⚠ no stacking
  "wattsPerCab": 1000,
  "distros":   [ { "model": 200, "firstCab": 79, "lastCab": 150,
                   "socapex": [ { "firstCab","lastCab","cpc" } ],
                   "socMode": "pack" } ]
}
```

### 9.2.4 ⭐ THE STACKING ANSWER (resolves the §5 addendum)

Tom's caution was right, and the reality is messier than "stacking doubles the count." **Stacking is represented differently at every node of the chain, and it is dropped entirely at the last one.**

| Node | Where `doubleStacked` lives | Count arithmetic |
|---|---|---|
| `.e360` | **`zones[]` only** — `{name,color,first,last,doubleStacked}`, keyed by cabinet range. `complexSections[]` has **no such field**: `addCxSection()` creates `{name,side,count,offset,fieldDist,direction,cabOverride}` and nothing else (`tools/e360:3912-3922`). | `totalCabs += z.doubleStacked ? count * 2 : count` where `count = last − first + 1` (`tools/e360:2827` U-mode, `:4699` complex-mode) |
| `.nsf` | **`complexSections[]`** — `doubleStacked` + `stackFlow` (`'snake'` = row 2 reverses, `'parallel'` = row 2 same direction; `tools/novaspec:574-577`) | `cxPathTotal() = Σ (doubleStacked ? n*2 : n)` (`tools/novaspec:454`) |
| `.pcfg` | **Nowhere.** `sections[]` is `{name,side,cabType,count,gapBefore}`. | `buildGeometry` counts `sec.count` flat (`tools/powerspec:341`) |

**The `.e360 → .nsf` bridge is real code.** NovaSpec has an *"⬇ Import from Client Spec (.e360)"* button (`tools/novaspec:319-320` → `importE360()` at `:1950`). When the `.e360` is complex-mode it copies `complexSections` verbatim, then **cross-references `zones` to recover stacking** (`tools/novaspec:1990-2002`):

```js
complexSections = data.complexSections.map(s => ({ doubleStacked:false, stackFlow:'snake', ...s }));
if (Array.isArray(data.zones)) {
  let runningCab = 1;
  complexSections.forEach(sec => {
    const n = parseInt(sec.count) || 0;
    const secStart = runningCab, secEnd = secStart + n - 1;
    const matchedZone = data.zones.find(z => z.doubleStacked && z.first >= secStart && z.last <= secEnd);
    if (matchedZone) sec.doubleStacked = true;
    runningCab = secEnd + 1;
  });
}
```
When the `.e360` is U-mode it *reconstructs* `complexSections` from `sideStates` + field dimensions instead (`tools/novaspec:2003+`).

**The `.e360 → .pcfg` and `.nsf → .pcfg` bridge drops stacking on the floor.** `parseConfig(txt)` (`tools/powerspec:62-87`) accepts either format — it reads `fields.clientName || fields.jobName` and `fields.cabinetType || fields.cabType`, so one function handles both — and maps `complexSections` to `sections` using **`count: parseInt(cs.count) || 0`** (`:82`). It never reads `doubleStacked`, never reads `zones`. If there are no `complexSections` it falls back to a single section sized by **`fields.totalCabinets`** — the hand-typed string (`:85-86`).

#### Worked example — VNL Chicago, three numbers for one wall

Verified against `docs/spec-samples/e360_vnl_chicago_sample.e360` + `VNL_Chicago_2026-05-13.nsf`:

| Source | Value | How it arises |
|---|---|---|
| `.e360` `fields.totalCabinets` | **144** | hand-typed into a text box |
| `.e360` `complexSections` Σ`count` | **120** | 34 + 24 + 4 + 24 + 34 |
| `.e360` `zones` | **`[]`** — empty | zone-derived total = 0; the file carries *no* stacking information |
| `.nsf` stack-aware `cxPathTotal()` | **124** | same five sections; "Section 3" (count 4, north) has `doubleStacked:true` → 4×2 = 8 |

§5.4 flagged "144 vs 120" as a probable spec error. It is not. The truth: the geometry describes **120 single-height positions**; the operator marked one 4-cabinet section double-stacked **inside NovaSpec** (that flag never existed upstream, because `zones` was empty); and someone typed **144** into the spec sheet. Three legitimate artifacts, three different numbers, zero errors.

Contrast **Unified Events**, where the chain is clean: `.e360` U-mode, `zones` = 3 contiguous zones covering 1–150, none stacked, `totalCabinets` "150"; `.nsf` sections 40+70+40 = **150**; `.pcfg` single section count **150**. The only divergence is `fieldWidth` **225** (`.e360`) vs **222** (`.nsf`) — a real operator edit, and exactly the kind of one-field drift a checker *should* surface.

#### Consequences — write these into the checker

1. **Never compare `.e360 fields.totalCabinets` to anything as if it were authoritative.** It is free text. Treat it as a *declared* value and report disagreement as "declared 144, geometry 120 — confirm."
2. **A `.e360` with `zones: []` carries no stacking data.** `.nsf` stacking that has no `.e360` zone counterpart is **normal**, not drift. Never flag it.
3. **Compare stack-aware totals, not raw sums.** `.e360` → Σ over `zones` with the ×2 rule (or, if `zones` is empty, note "stacking unknown upstream"). `.nsf` → `cxPathTotal()`. Branch on `layoutMode` first.
4. **`.pcfg` count is a single-row footprint, not a physical cabinet count**, whenever an upstream section was double-stacked. For VNL, PowerSpec would plan for 120 cabinets against 124 physical ones.
5. Per Tom's §5 addendum, every one of these is a **question** ("verify stacking"), never an accusation. Walk one real stacked-zone spec with Tom before the checker ships.

> ⚑ **Flag for Tom — possible real-world power-planning gap, not a Showrunner bug.** `totalPower = totalCabs × wattsPerCab` (`tools/powerspec:302`) is computed from the stacking-blind `sections[].count`. On a double-stacked wall that under-counts cabinets — VNL: 120 vs 124, i.e. 4 kW at 1000 W/cab. It may be that operators hand-correct `count` in PowerSpec after import, in which case nothing is wrong. **Ask before treating it as a defect.**

---

## 9.3 "Bind to PM show" — the design

### 9.3.1 Decision: reuse the popup pattern, do not use an API key

The tools are **static files on a Caddy file-server** (§9.4). Anything embedded in them — an `x-agent-key`, a service password — is world-readable on a public URL. Showrunner's agent keys are `sk_sr_live_<40 hex>`, hashed at rest, and act as their user with that user's full role (`sr/lib/auth.js:100-124`); shipping one to a browser would be handing out a durable write credential.

The existing bind already solved this: **the popup is a first-party Showrunner page and carries the operator's own session.** Three further facts make it the only currently-viable option:

1. **Agent keys are blocked from the human surface by topology.** `requireAuth` returns 403 for any request carrying `x-agent-key` outside `/api/agent/*` (`sr/lib/auth.js:134-136`), and `requireAgentKey` refuses to run outside that prefix (`sr/lib/auth.js:158-160`). `PUT /api/shows/:id/chain/:node` lives on the human surface (`sr/routes/files.js:292`) — **an agent key can never bind a chain node.**
2. **The agent document route cannot file a spec anyway.** `POST /api/agent/documents` (`sr/routes/agent.js:204`) inserts `kind, name, ext, nas_path, amount, vendor, doc_date, job_id, status, provenance, …` — it never writes `spec_type`, `artifact`, or `chain_key` (compare the human `POST /api/files`, `sr/routes/files.js:130-140`, which does).
3. **CORS would otherwise be a blocker.** Showrunner's CORS is an env allowlist, and unset means same-origin only (`sr/server.js:59-66`). With the popup pattern the tools make **zero cross-origin XHR** — everything is `postMessage` plus first-party fetches from inside the popup. **No `CORS_ORIGINS` change is needed.** That alone is worth the pattern.

`GET /api/agent/shows` (`sr/routes/agent.js:172`) remains the right endpoint for a *server-side* agent picking a show. It is the wrong one here.

### 9.3.2 Tool side — additive, ~40 lines per tool

Add a **second** button next to the existing one. Do not modify or remove the dashboard bind; both targets are legitimate and Tom will use both during the transition.

```js
// ── BIND TO SHOWRUNNER (PM app) ─────────────────────────────────────────────
// Same popup pattern as bindToDashboardEvent(), different target + payload.
const SHOWRUNNER_URL    = 'https://<showrunner-host>';          // see §9.4 on config
const SHOWRUNNER_ORIGIN = new URL(SHOWRUNNER_URL).origin;

function bindToShowrunnerShow() {
  // Open synchronously inside the click — popup blockers allow gesture-opened
  // popups only. (Same reasoning as tools/e360:5674-5676.)
  const popup = window.open(
    SHOWRUNNER_URL.replace(/\/$/, '') + '/?bind-spec=1&specType=e360',   // 'nsf' | 'pcfg'
    'bind-show-popup', 'width=900,height=720');
  if (!popup) { alert('Popup blocked. Please allow popups for this site and try again.'); return; }

  let sent = false;
  function onMessage(e) {
    if (e.origin !== SHOWRUNNER_ORIGIN) return;                 // fixes T1, our side
    const msg = e.data; if (!msg || !msg.type) return;
    if (msg.type === 'bind-popup-ready' && !sent) {
      sent = true;
      sendSpec().catch(err => {
        try { popup.postMessage({ type:'bind-source-error', error:String(err.message||err) }, SHOWRUNNER_ORIGIN); } catch(_) {}
        cleanup();
      });
    } else if (msg.type === 'bind-complete') {
      _srBound = { showId: msg.showId, showName: msg.showName, node: msg.node, rev: msg.rev };
      _renderShowrunnerBindState();                             // §9.3.5
      cleanup();
    }
  }
  function cleanup() { window.removeEventListener('message', onMessage); }
  window.addEventListener('message', onMessage);

  async function sendSpec() {
    const json     = collectProjectData();                      // collectNsfData() | window.PowerSpec.collectData()
    const svg      = renderTopdownSvg();
    const pageHtml = captureE360PageHtml();
    let png = '';
    try { png = await _bindSvgToPng(svg); } catch (e) { console.warn('PNG rasterize failed:', e); }
    popup.postMessage({
      type: 'bind-spec-data',
      specType: 'e360',                                         // 'nsf' | 'pcfg'
      json, svg, png, pageHtml,
      // NEW vs the dashboard bind — lets Showrunner name the file and fill the
      // chain node without re-parsing the spec.
      suggestedName: (json.fields && (json.fields.clientName || json.fields.jobName)) || 'spec',
      toolVersion:   (typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''),
      sourceUrl:     location.href
    }, SHOWRUNNER_ORIGIN);
  }
}
```

`_bindSvgToPng`, `collectProjectData`, `renderTopdownSvg`, `captureE360PageHtml` are reused unchanged. PowerSpec exposes its version as `window.bindToShowrunnerShow` on `window`, matching `tools/powerspec:1131`.

### 9.3.3 Showrunner side — a `?bind-spec=1` popup route

A new front-end mode in `sr/public/`, mirroring `staffing/index.html:4383-4389` + `:6087-6280`, plus **one** new backend endpoint (§9.5 D1).

```
1. Popup loads Showrunner SPA. If ?bind-spec=1 → enter bind mode instead of the normal shell.
2. Not logged in?  Show the login form; on success continue.  (Session = x-auth-token, sr/lib/auth.js)
3. postMessage {type:'bind-popup-ready', specType} to window.opener, target '*'
   — must be '*' because we do not know the tool's origin a priori.
4. Receive {type:'bind-spec-data', ...}.  MUST validate:
      if (!TOOLS_ORIGINS.includes(e.origin)) return;     // fixes T1, our side
   TOOLS_ORIGINS is served to the page from the backend (env-driven), never hardcoded.
5. Render a show picker: GET /api/shows (session auth, routes/core.js).
   Order by event_date DESC; include project name, client, venue, dates.
   Do NOT copy the dashboard's "future only" filter (T3) — a spec is often
   bound after load-in. Offer a "show past shows" toggle instead, default on.
6. User picks a show → confirm dialog naming the show, the extension, and
   whether an existing file on that chain node will be superseded.
7. POST /api/shows/:id/spec-bind   (the ONE new endpoint — §9.5 D1)
8. postMessage {type:'bind-complete', showId, showName, node, rev, stale} to opener; close after ~1.2 s.
9. If the popup is closed WITHOUT a bind (the user gave up, the tool never
   answered, the origin was refused), postMessage {type:'bind-cancelled', specType}
   on `pagehide`, targeting the pinned tool origin — or '*' if no bundle ever
   arrived, since the message carries no data. Never sent after bind-complete.
```

**`stale` on `bind-complete`** *(added 2026-08-27, wrap-up pass)*. §9.3.5 draws
the tool showing "⚠ cabling and power are now stale" and says the line comes
from the 200 response — but the tool never sees that response; only the popup
does. So the popup forwards it: `stale` is the **array of node names** that the
bind invalidated, derived from the response's `stale` map. An older tool that
ignores the field is unaffected.

**`bind-cancelled`** *(added 2026-08-27, wrap-up pass)*. Without it a tool that
put its UI into a waiting state on `bind-popup-ready` waits there forever when
the popup is closed, and the operator's only tell is that nothing happened. It
carries no data beyond the `specType` echo.

**The `specType` → chain-node mapping** (`CHAIN_NODES = ['content','cabling','power','pull']`, `CHAIN_UP = {content:null, cabling:'content', power:'cabling', pull:'power'}` — `sr/routes/files.js:41-42`):

| Tool | `specType` | `files.spec_type` | `files.ext` | chain node | `chain_key` |
|---|---|---|---|---|---|
| Spec Sheet Generator | `e360` | `e360` | `.e360` | `content` | `content` |
| NovaSpec | `nsf` | `nsf` | `.nsf` | `cabling` | `cabling` |
| PowerSpec | `pcfg` | `pcfg` | `.pcfg` | `power` | `power` |
| *(Flex pull sheet — not a tool)* | — | — | — | `pull` | `pull` |

All three `spec_type` values are already legal (`SPEC_TYPES = ['e360','nsf','pcfg']`, `sr/lib/enums.js:41`) and `kind: 'spec'` is already in `FILE_KINDS` (`sr/lib/enums.js:34`).

### 9.3.4 `POST /api/shows/:id/spec-bind` — the one new endpoint

It exists to make the bind **atomic**. Composing the three existing calls (`POST /api/files` → `PUT /api/files/:id/content` → `PUT /api/shows/:id/chain/:node`) from the browser would leave a half-bound show on any mid-sequence failure, and would need three round-trips carrying multi-megabyte payloads.

```
POST /api/shows/:id/spec-bind
  auth:    session (x-auth-token), requireRole('pm')   ← matches PUT /chain/:node, sr/routes/files.js:292
  body:    { specType: 'e360'|'nsf'|'pcfg',
             json:     <object>,        // the .e360/.nsf/.pcfg document
             svg:      "<svg …",        // optional
             pageHtml: "<!doctype html>…",  // optional
             png:      "data:image/png;base64,…",  // optional
             suggestedName: "VNL Chicago",  // optional
             toolVersion:   "…",            // optional, → files.meta
             sourceUrl:     "https://…"     // optional, → files.meta
           }
  200:     { fileId, node, rev, stale: {…}, chain: {content:{…},cabling:{…},power:{…},pull:{…}},
             nasPath, supersededFileIds: [] }
```

Server does, in **one `withTx`**:
1. `oneOf(specType, SPEC_TYPES)`; `typeof json === 'object' && json !== null`; if `svg` present it must start with `<svg` (copy `staffing/server.js:1215`); reject `png` that fails `/^data:image\/png;base64,/`.
2. **Sanity-check the document against its declared type**, which the staffing app never does:
   - `e360` → `json.version` truthy (`tools/e360:3267` throws `'Invalid file'` otherwise)
   - `nsf` → `json._app === 'NovaSpec'` (`tools/novaspec:2128`)
   - `pcfg` → `json._app === 'e360_power_cabling'` (`tools/powerspec:314`)
   Mismatch → **400**, naming both the declared and detected type. This alone prevents a whole class of silent chain corruption.
3. `UPDATE files SET status='superseded' WHERE show_id=$1 AND chain_key=$2 AND status='filed'` — reuse the `replace_chain` semantics already in `POST /api/files` (`sr/routes/files.js:122-125`). **Supersede, never delete.**
4. `INSERT INTO files (…, kind='spec', spec_type, chain_key, ext, nas_path, ver, meta, status='filed', uploaded_by, provenance, …)`, `nas_path` from `buildNasPath(project, show, {kind:'spec', name, ext})` — **always server-derived** (`sr/routes/agent.js:241-244` states the rule).
5. `storage.put(nas_path, Buffer.from(JSON.stringify(json, null, 2)))` — the `.e360`/`.nsf`/`.pcfg` bytes, byte-identical to what the tool's own Save button writes.
6. Persist the render bundle — **see §9.5 D2, the one genuinely missing capability.**
7. Upsert `spec_chain` for the node: `gen=true`, `rev = prev.rev + 1`, `derived_from_rev = chain[CHAIN_UP[node]].rev`, `by = req.actor`, `when_at = todayISO()`, `file_id = <new id>` — identical to `sr/routes/files.js:310-316`.
8. `logActivity({action:'chain.bind', detail:'<node> → v<rev>', accent:true})`.
9. Return the recomputed chain via `chainFor(showId, c)`, whose derived `stale` flag (`sr/routes/files.js:50-54`) tells the tool — and the Showrunner UI — exactly which downstream nodes just went stale.

Because `chainFor` derives `stale` as `up && node.gen && up.gen && node.derivedRev !== up.rev`, **binding `.e360` automatically marks `.nsf`, `.pcfg` and the pull sheet stale with no extra code.** The §5.3 "buildable now" ledger is already built; this endpoint just feeds it.

### 9.3.5 Bound-state display in the tool

The dashboard bind is fire-and-forget: an `alert('✓ Bound to: …')` and nothing persists (`tools/e360:5694`). Showrunner's should persist, matching the "Linked" state pattern from `flex_integration_plan.md:253-259`:

```
┌────────────────────────────────────────────────────────┐
│ 📤 Showrunner                              ✓ Bound      │
│  VNL Chicago · Now Arena · 2026-03-10                  │
│  content · v3 · bound by tom · 2026-08-27              │
│  ⚠ cabling and power are now stale                     │
│  [🔗 Open in Showrunner]   [📤 Re-bind]                │
└────────────────────────────────────────────────────────┘
```

Persist `{showId, showName, node, rev, boundAt}` in `localStorage` under a per-tool key. It is a convenience hint, not state of record — wrap reads/writes in `try/catch`, and treat a miss as "not bound" (the tool is a static page; the DB is the truth). Deep link: `SHOWRUNNER_URL + '/#/shows/' + showId`. The stale line comes straight from the `chain` object in the 200 response.

---

## 9.4 Deployment constraints on how the bind ships

```dockerfile
FROM caddy:alpine
COPY . /srv
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":3000"]
```
(`C:\code\e360-tools\Dockerfile`, 3 lines.)

**One Railway service, one Caddy static file-server, four tools under one origin.** `/` is the landing page (`index.html`, a dark card grid linking the four); `/e360/`, `/novaspec/`, `/powerspec/`, `/testpattern/` are each a **single self-contained `index.html`**. No build step, no bundler, no server-side code, no environment variables reaching the browser.

What that constrains:

| # | Constraint | Consequence for the bind |
|---|---|---|
| C1 | **No runtime config.** A static file cannot read an env var. `DASHBOARD_URL` is a hardcoded `const` in three files (`tools/e360:5638`, `tools/novaspec:2287`, `tools/powerspec:1031`). | `SHOWRUNNER_URL` must be hardcoded the same way — **or** better, add a tiny shared `/config.js` at the repo root (`window.E360_TARGETS = { dashboard:'…', showrunner:'…' }`) and `<script src="/config.js">` it from all three. Caddy serves it happily; it becomes the **one** place to change a host, retiring T5. |
| C2 | **All four tools share one origin.** A `postMessage` origin check on the Showrunner side allowlists a single value: `https://e360-tools-production.up.railway.app`. | `TOOLS_ORIGINS` is effectively one entry — plus a localhost entry for dev. |
| C3 | **Same-origin also means no isolation between tools.** `localStorage` written by `/e360/` is readable by `/powerspec/`. | Namespace the bound-state key: `showrunner:bind:e360`, not `bind`. |
| C4 | **Three copies of the same 40 lines.** The existing bind is already triplicated, and PowerSpec's copy drifted (it needs the React `window.PowerSpec` shim, and `2c83ee4` had to fix an xmlns bug only it had). | Ship the Showrunner bind as a shared `/bind.js` alongside `/config.js`, parameterised by `specType` and a `collect()` callback. Three `<script>` tags, one implementation. |
| C5 | **PowerSpec is React compiled in-browser via Babel**; its integration code deliberately lives *outside* React and pokes in through `window.PowerSpec` (`tools/powerspec:953-976`, comment at `:1024-1028`). | The shared `bind.js` must not assume DOM-first tools. Pass `collect()` in; let PowerSpec supply `() => window.PowerSpec.collectData()` and guard `window.PowerSpec.isLoaded()` first (as `:1132-1134` already does). |
| C6 | **Static hosting cannot hold a secret.** | Confirms §9.3.1: popup + session, never an API key. |
| C7 | **No cache-busting.** Caddy serves `index.html` with default caching; the staffing repo's deploy notes already warn to hard-refresh (`CLAUDE.md:183`). | After shipping the bind, tell operators to hard-refresh the tool page, or add a `?v=` to the new `<script>` tags. |

---

## 9.5 Delta for the backend / integration build

What §9.3 needs **beyond** what `AGENT_API.md` and `PUNCH_LIST.md` already define. Everything not listed here already exists in the refactored code.

### Must build

**D1 — `POST /api/shows/:id/spec-bind`** *(new route, `sr/routes/files.js`)*
Session auth + `requireRole('pm')`. The atomic bind of §9.3.4. Composes existing primitives (`buildNasPath`, `storage.put`, the `files` insert with `spec_type`/`chain_key`/`artifact`, the `spec_chain` upsert, `logActivity`, `chainFor`) — no new tables. Add the type-sniff validation in step 2; it is four lines and prevents silent chain corruption.

**D2 — Render-bundle storage** *(new columns or table)* — **the one real capability gap.**
Showrunner today stores the spec **file** (`files` row + NAS bytes) and the **chain state** (`spec_chain`), but has **nowhere to put `svg` / `pageHtml` / `png`**. Grep confirms: no `spec_svg`, `spec_html`, `spec_png`, `spec_json` or render-bundle column anywhere in `sr/lib/db.js` or `sr/routes/*.js`. The staffing app has twelve such columns on `events` **and** twelve on `residencies` (`staffing/server.js:633-652`, `:671-673`).

Without D2 a bound spec in Showrunner is **not viewable or printable without opening the source tool** — which is precisely the promise `INTEGRATION.md` Part (a) makes ("the DB holds what you need to look at and print"). Recommended shape — one row per bound artifact, so history comes free and `files` stays narrow:

```sql
CREATE TABLE IF NOT EXISTS spec_renders (
  id         SERIAL PRIMARY KEY,
  file_id    INTEGER NOT NULL,      -- the files row this renders
  show_id    INTEGER NOT NULL,
  node       TEXT NOT NULL,         -- content | cabling | power | pull
  spec_type  TEXT NOT NULL,         -- e360 | nsf | pcfg
  rev        INTEGER NOT NULL,      -- matches spec_chain.rev at bind time
  svg        TEXT,
  html       TEXT,
  png        TEXT,                  -- data: URL, 2× scale (tools/e360:5654)
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS spec_renders_show_idx ON spec_renders(show_id, node);
```
Serve via `GET /api/shows/:id/spec-render/:node` returning `{json, svg, html, png}` for the current rev. Render the `html` in an `<iframe srcdoc>` — the tools already emit print-ready pages with their own stylesheets inlined (`tools/e360:5586-5601`), so browser Print → PDF works with no further work. Prefer `png` for anything email-bound (Gmail strips inline `<svg>` — `staffing/server.js:642-645`).

**D3 — Raise `JSON_BODY_LIMIT`.** `sr/server.js:78` sets `express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' })`. The bind payload is `json + svg + pageHtml + png`, where `png` alone is a base64 data URL of a **2×-scaled** canvas (`tools/e360:5654`) and `pageHtml` inlines every stylesheet. Realistically **2–10 MB**; the staffing app allows **20 MB** for exactly this route (`staffing/server.js:18`). Set `JSON_BODY_LIMIT=20mb`, **or** scope a larger limit to the `spec-bind` route only (cleaner — it keeps the 1 MB default protecting every other endpoint). `MAX_UPLOAD_BYTES` (100 MB, `sr/lib/storage.js:36`) governs the raw-bytes path and needs no change.

**D4 — `TOOLS_ORIGINS` env var + a way for the page to read it.** The popup must validate `e.origin` on inbound `bind-spec-data` (fixing T1 on our side). Add `TOOLS_ORIGINS` (comma-separated, same parsing style as `CORS_ORIGINS` at `sr/server.js:59`) and surface it to the SPA — via the existing bootstrap/config JSON the front end already fetches, or a `GET /api/config` field. **Do not hardcode it in `public/`.**

*As built (`sr/server.js`, `GET /api/config` — public, no session required):*

```jsonc
{
  "app": "e360-showrunner",
  "version": "…",
  "toolsOrigins": ["https://tools.example"],          // TOOLS_ORIGINS, array; [] when unset
  "specTypes":  ["e360","nsf","pcfg"],
  "specExt":    { "e360": ".e360", "nsf": ".nsf", "pcfg": ".pcfg" },   // T2: a MAP, never a ternary
  "specNode":   { "e360": "content", "nsf": "cabling", "pcfg": "power" },
  "chainNodes": ["content","cabling","power","pull"],
  "specBindBodyLimit": "25mb",
  "features": { "schedulerPush": false, "flex": false }
}
```

`public/bind.js` consumes **all three** of `toolsOrigins`, `specExt` and
`specNode` — the last two overwrite its boot-time `SPEC_MAP` fallback, so the
server stays the single source of the type→extension→node mapping and a fourth
tool needs no front-end release. **Unset `TOOLS_ORIGINS` fails CLOSED:** the
array is `[]`, the popup trusts only its own origin, and every tool bind is
refused with a message naming the missing server setting.

**D5 — `?bind-spec=1` front-end mode in `sr/public/`.** The popup shell: login gate → `bind-popup-ready` → receive + origin-check → show picker → confirm → `POST /spec-bind` → `bind-complete` → close. Model on `staffing/index.html:6087-6280` but fix T1 (check origin), T2 (derive the extension from a `{e360:'.e360', nsf:'.nsf', pcfg:'.pcfg'}` map, not a ternary) and T3 (do not hide past shows).

### Should build

**D6 — Extend `POST /api/agent/documents` with `spec_type` / `chain_key` / `artifact`.** Not needed for §9.3, but today a server-side agent literally cannot file a spec artifact: the insert at `sr/routes/agent.js:250-267` omits all three columns that the human `POST /api/files` sets (`sr/routes/files.js:130-140`). Any future "agent files the spec it found in an email" flow is blocked on this. Chain *binding* should stay session-only — it is a deliberate, correct guardrail.

**D7 — Stack-aware chain consistency checker.** §9.2.4 supplies the exact rules and field paths. Gate it behind the walkthrough with Tom that the §5 addendum asks for. Report as questions, never errors.

**D8 — `.e360` logo MIME gate on any Showrunner render path.** Copy `/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/` from `tools/e360:3322`. A stored `.e360` is attacker-influenced input the moment anyone can upload one.

### Explicitly NOT needed

- **No `CORS_ORIGINS` change.** The popup pattern makes zero cross-origin XHR (§9.3.1).
- **No new agent scope.** `AGENT_SCOPES = ['agent:read','agent:file','agent:propose']` (`sr/lib/enums.js:73`) is untouched; the bind is session-authenticated.
- **No `api_keys` change**, and no tools-scoped key. Issuing one would put a durable write credential in a public static file (C6).
- **No new `FILE_KINDS`, `SPEC_TYPES`, `FILE_ARTIFACTS` or `CHAIN_NODES` values.** `kind:'spec'`, all three spec types, and all four chain nodes already exist.
- **No change to `PUT /api/shows/:id/chain/:node`.** D1 reuses its exact upsert; the manual route stays for operators binding without a tool.

### Ops prerequisites for Tom

1. **Showrunner's public host name** — needed for `SHOWRUNNER_URL` in the tools (C1). Not yet recorded anywhere.
2. **A decision on `/config.js`** (C1/C4): retire the triplicated hardcoded host now, or ship a fourth copy and clean up later.
3. **Write access to `C:\code\e360-tools`** — this pass was read-only. The tool-side change is ~40 lines × 3 files, or ~60 lines in two shared files plus three `<script>` tags.
4. **One stacked-zone spec walkthrough** before D7 ships (carried over from the §5 addendum; §9.2.4 now says exactly what to look at).
