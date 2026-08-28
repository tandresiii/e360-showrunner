# E360 Showrunner

The **project-management** app for E360 Sport live-event LED/Print production.
Everything from the sales call → planning → specs → gear/trucks/vendors/travel →
show → strike → the client recap, organized in one **Event Folder** so that if
the person running an event is "kidnapped by aliens," anyone can pick it up and
keep going.

Showrunner is a **separate service** from the staffing/scheduler app
(`e360-staffing3`). It owns the *planning* lifecycle; when a show is ready it
**pushes to the scheduler** over HTTP — staffing stays the system of record for
live crew scheduling.

It also serves an **agent-facing API** (`AGENT_API.md`) so each teammate's M365
agent can file documents, propose expenses and draft work — under a hard rule:
**agents file, they never fire.** Nothing in this system has an outbound path.

`APP_VERSION` is at the top of `server.js` and is served at `GET /api/version`.

> **First post-deploy release (2026-08-27).** Six Tom-confirmed features landed
> on top of the deployed build, every migration strictly additive:
> **F1** real event creation (the last mock button in the app) carrying the
> notify picker · **F2** required tech show reports with their own table, their
> own two gates and a runtime firewall assertion · **F3** a notification outbox
> with per-user preferences and a delivery driver (`log` now, Graph `sendMail`
> skeletoned) · **F4** a structured scope line, spec-verified and client-safe ·
> **F5** the commercial lifecycle with an explicit Confirm · **F6** a
> machine-checked closeout and archiving. See `SCHEMA.md` for the schema, the
> routes and the env vars.

> **Identity, additively (2026-08-28).** Two nullable columns on `users`, on top
> of the live build. **`email`** — optional, validated, unique among the *active*
> (enforced in route logic, never a constraint on a live table); the outbox marks
> an addressless person's rows `skipped · no email address on file` instead of
> erroring, so the Graph driver lands behind it unchanged; and `POST
> /api/auth/login` now takes **a username or an email** on one field, with the
> `@` picking the lookup and the no-enumeration property asserted and
> mutation-tested. **`staffing_name`** — the identity half of the cross-system
> linkage: the staffing app keys people on a *display name* and has never heard
> of a Showrunner username, so a person the two systems spell differently used to
> be pushed as a ghost with no packet. Usernames stay slugs and stay the
> identity. `SCHEMA.md` → *Identity, agents, audit*.

---

## What it actually is

Two halves that can run independently:

1. **A no-build SPA** (`public/`) — plain `<script>` tags, no modules, no
   bundler, so it works over `file://`. It runs in **two modes**, decided once
   at boot by a single probe of `/api/health`:
   - **demo** — the fixture in `data.js` *is* the world. Fully interactive,
     nothing is saved, nothing is real. This is what opens if no server answers.
   - **api** — every read and write goes to the backend; `data.js` contributes
     only its vocabulary (roles, statuses, lane definitions) and its pure
     helpers.
2. **A Node/Express + PostgreSQL backend** (`server.js`, `lib/`, `routes/`) —
   `pg` `Pool` on `DATABASE_URL`, **no ORM, no build step**, additive-only
   `initDB()` (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`,
   **never `DROP`**), `x-auth-token` sessions in a **durable `sessions` table**
   that survives redeploys, and manual transaction-wrapped delete cascades.

**34 tables · 160 routes.** Column-by-column detail, the full route list, the
push-to-scheduler field mapping and the spec-bind contract are in
**[SCHEMA.md](./SCHEMA.md)**.

### Data model in one line

**Project (Event Folder) → 1+ Shows → Steps in lanes.** A folder holding exactly
one show auto-collapses into that show everywhere in the UI. Lanes are **not
fixed** — each event *type* declares its own set (`led` = 6, `print` = 8,
`both` = 10) and types are extensible from config; every dashboard, folder,
pipeline and template grid is lane-agnostic. Alongside that sits the commercial
axis: **one job = one deal = one QuickBooks number = one budget**, and any
cost-bearing item can override its show's default job, so one show can bill
across two deals.

---

## Module map

### `public/` — the SPA (load order is dependency order; see `index.html`)

| File | What it owns |
|---|---|
| `data.js` | The demo fixture **and** the shared vocabulary: `ROLES`, `STATUS`, `EVENT_TYPES`/`LANES`, `BUDGET_CATS`, `PO_STATUS_META`, `RECAP_STATUS`. Plus the flat index maps (`SHOWS_BY_ID`, `JOBS_BY_ID`, …) and the pure read helpers (`financeExceptions`, `poRisks`, `noteInbox`, `buildRecapDraft`, …). Runs at parse time in **both** modes. |
| `api.js` | The seam. `SR` = transport, session, mode probe, store sync; `api.*` = ~90 methods that each branch demo vs API. The `A.*` absorbers are the read-through cache that keeps the index maps in step with server payloads. |
| `components.js` | Shared render helpers — `esc()`, formatters, pills/tags/chips, the roster picker, and the white **document sheets** (spec, pull sheet, manifest, proof, money, call sheet, client recap) used by both the viewer and the print path. |
| `views-dashboard.js` | Projects portfolio + the Season/Program dashboard. |
| `views-folder.js` | The per-show tabbed folder: Overview · Schedule · Pipeline · Specs · Gear · Files · Photos · Recap · Financials · Proofs/Bookings · Activity. |
| `views-finance.js` | Finance cockpit, job drill-in, the per-show Financials tab, season P&L strip. |
| `views-purchasing.js` | Purchasing cockpit, PO drill-in, the per-show procurement surfaces. |
| `views-notes.js` | The one anchored-thread component, @mentions, and the bell inbox. |
| `views-global.js` | My Tasks · Calendar · Team & Roles · Files library · Templates · Settings · the multimedia viewer. |
| `bind.js` | The `?bind-spec=1` popup — a first-party page that carries the operator's session so a spec tool never holds a credential. |
| `app.js` | Router, the **one** delegated `data-act` click listener, every mutation, the login screen, and boot. |
| `app.css` / `tokens.css` | Dark-first tokens with a light override on `:root[data-theme="light"]`. |

**Safety rule, enforced throughout:** every interpolated value goes through
`esc()`, and inline handlers carry **numeric ids only** — anything stringy is a
`data-` attribute read by the delegated listener.

### `lib/` — backend core

`auth.js` (roles, `hasFinance`, `canApprovePO`, `canApproveRecap`) ·
`db.js` (schema + cascades) · `enums.js` (server-side whitelists) ·
`mappers.js` (row → API shape) · `agent.js` + `firewall.js` (agent surface and
the client-facing content firewall) · `scheduler.js` (push) · `flex.js` (Flex
client) · `speccheck.js` (the stack-aware spec checker) · `storage.js` (NAS
drivers) · `mentions.js` · `seed.js` · `activity.js` · `http.js`.

### `routes/` — one file per family

`auth · core · files · finance · purchasing · schedule · notes · photos ·
deliverables · proposals · agent`.

### `scripts/`

`smoke.js` (the full end-to-end suite) · `storage-test.js` (the NAS byte layer,
against an in-process WebDAV server + SOCKS5 proxy — no NAS needed) ·
`flex-test.js` (offline, recorded shapes) · `flex-probe.js` (needs a real key).

---

## Run it

### 1. Demo mode — zero setup

```bash
open public/index.html            # or just double-click it
```

No server, no database. Works over `file://`. A **"Demo data"** badge sits in
the topbar the whole time, and Settings says so too.

`dist/showrunner-single.html` is the same app inlined into **one 775 KB file**
you can email or drop on a USB stick. Rebuild it after any `public/` change:

```bash
node build-single.mjs
```

### 2. Full local — app + database

```bash
npm install
export DATABASE_URL="postgres://user:pass@localhost:5432/showrunner?sslmode=disable"
export SEED_ROSTER=1              # optional: placeholder teammates for @mentions
npm start                         # PORT, default 3100
```

First boot runs `initDB()` and seeds the templates from `templates.json` plus a
default admin — **`admin` / `e360admin`** (override with `ADMIN_PASSWORD`;
change it immediately). Health: `GET /api/health`.

**No Postgres handy?** The suites are driven through a throwaway embedded
cluster — see the harness note under *Suites* below. The database **must be
UTF-8**; activity details and note bodies carry `→`, `—` and typographic quotes.

### 3. Suites

```bash
DATABASE_URL="…" npm run smoke    # scripts/smoke.js — the end-to-end suite
npm run storage:test              # the NAS byte layer — no NAS, no DB needed
npm run flex:test                 # offline, no key needed
npm run flex:probe                # needs FLEX_BASE_URL + FLEX_API_KEY
```

`storage:test` stands up its own WebDAV server, its own SOCKS5 proxy and its own
self-signed certificate in-process, then drives the real `webdav` driver at them
— deep MKCOL, PUT, streamed GET, MOVE, DELETE, 404/401/timeout/507, TLS
verification on and off, and the real 364,739-byte Big Ten PDF round-tripped and
compared by SHA-256 through both the buffered and the streamed path. It never
touches a real NAS, so it is safe to run anywhere. Add `DATABASE_URL` and it
also boots the real server with `STORAGE_DRIVER=webdav` and pushes that PDF
through `PUT`/`GET /api/files/:id/content`.

`smoke.js` boots the real server in-process on an ephemeral port and drives it
over HTTP exactly as a browser would: `initDB` idempotency, the seed loader,
auth (including a legacy sha256 password being re-hashed to bcrypt), one
representative call per route family, the whole agent-API happy path with its
confidence bands and idempotent replay, the §9 guardrails, the recap content
firewall, spec-bind, the **people-and-permissions lifecycle** (add · one-time
temp password · forced change · edit · reset · deactivate/reactivate, plus the
last-active-admin lockout guard), and **zero-orphan cascade integrity across
every wired table**. Details and failure-reading guidance in
**[SMOKE.md](./SMOKE.md)**.

The SPA suites are harnesses that load `public/` into a DOM shim and drive the
real render + action code (demo mode, API mode against a live server, and a
full live push into a local staffing app). They live in the working scratchpad
rather than the repo.

### 4. Deploying (Railway)

The repo carries a **`Dockerfile`**, and Railway prefers it over Nixpacks
automatically. It exists for one reason: the NAS lives on Tom's Tailscale
tailnet, so the image has to carry `tailscaled` next to Node and start it before
the app. It pins what Nixpacks left implicit — Node 22 LTS, Tailscale 1.86.2 —
and `docker-entrypoint.sh` is **inert without `TAILSCALE_AUTHKEY`**: no daemon
starts, no proxy is used, and the container behaves exactly as it did before.
`npm start` on a laptop is not in that path at all. Rollback is deleting the two
files. Full reasoning in the header of `Dockerfile`; the wiring session itself is
**[WIRING_DAY.md](./WIRING_DAY.md)**.

### Environment variables

Every variable, with defaults and notes, is in **[SCHEMA.md § Environment](./SCHEMA.md)**
and mirrored with inline commentary in **`.env.example`**. The ones that change
behaviour rather than tuning it:

| Var | Effect when unset |
|---|---|
| `DATABASE_URL` | the server will not boot (the SPA still runs in demo mode) |
| `SCHEDULER_BASE_URL` | push-to-scheduler dry-run works; **live** push returns a 501 naming the missing var |
| `FLEX_BASE_URL` / `FLEX_API_KEY` | `features.flex` is false; the SPA greys the Flex actions instead of offering a 501 |
| `TOOLS_ORIGINS` | the spec-bind allowlist is **empty and fails closed** — every tool message is refused |
| `STORAGE_DRIVER` | defaults to `local`. `webdav` is real but needs `NAS_WEBDAV_URL`/`USER`/`PASS` — any one missing is a 501 that **names it**. `smb` is an honest 501 pointing at `webdav`. See [WIRING_DAY.md](./WIRING_DAY.md) |
| `TAILSCALE_AUTHKEY` | no `tailscaled` starts, no proxy is used — the tailnet feature is entirely inert and the container networks normally |

---

## Integration status — where each one honestly stands

| Integration | Status |
|---|---|
| **Push to scheduler** | **Proven locally.** Dry run is the default and returns the exact payloads it would send. The live path is real — not commented out — and is gated on `SCHEDULER_BASE_URL`; unset, it is a 501 that names the variable. Verified end-to-end against a real local staffing app (72 assertions), including idempotent re-push and a clean 502 when the scheduler is unreachable. **Since F5 it also refuses a show the client has not confirmed** — 409 on the live path, while the dry run still runs and explains the refusal. Not yet pointed at production staffing. |
| **Email notifications (F3)** | **Queued, not sent.** Every real delivery lands in `notification_outbox` under the recipient's own preference, and the default `log` driver records it in the activity trail — auditable, addressed, and it travelled zero metres. The `graph` driver is a **skeleton**: config detection, the token + `sendMail` URLs and the exact JSON body are written, the wire call is not, because the `showrunner@` mailbox and app registration are still an M365-admin task. Unconfigured it answers a 501 and **the items stay queued**, so turning the env vars on delivers the backlog. |
| **The sweep (F2/F6)** | **No scheduler.** Strike detection, report nags, the closeout re-check and auto-archiving run once **on boot** and on `POST /api/admin/sweep`. Idempotent, so both are safe to repeat. A real daily job needs Railway cron or the per-user agents; the app does not fake one with `setInterval`. |
| **Flex** | **Client ready, probes pending a key.** `lib/flex.js` is written and covered by 67 offline tests against recorded shapes. Nothing in `routes/` calls it yet — the per-show gear state is read/written directly, and the UI labels itself *modeled*. The API is BETA, so none of the recorded shapes are confirmed until `scripts/flex-probe.js` runs with a real key. |
| **Spec bind** (`?bind-spec=1`) | **Verified both sides.** The popup carries the operator's session so the three spec tools never hold a credential; every inbound message is origin-checked against server-served `TOOLS_ORIGINS` (fail-closed). `bind-complete` carries the `stale` node list and `bind-cancelled` fires when the operator closes the popup — both are implemented in `bind.js` **and** handled in all three tools in `C:\code\e360-tools`. |
| **NAS** | **Built and tested end-to-end; one wiring session from live.** The `webdav` driver is real — deep MKCOL, PUT, streamed GET, MOVE, DELETE, PROPFIND against the Synology's WebDAV package — and routes NAS traffic (and *only* NAS traffic) through the Tailscale userspace SOCKS proxy so a Railway container can reach a box that is on the tailnet and nowhere else. `PUT`/`GET /api/files/:id/content` carry the bytes; the browser has a real file picker and a real download. `scripts/storage-test.js` proves all of it against an in-process WebDAV server, an in-process SOCKS5 proxy and a self-signed certificate, round-tripping the real 364,739-byte Big Ten PDF and byte-comparing by SHA-256 — **139 assertions, no NAS required**. What is unproven is only what needs Tom's hardware: that his Synology's WebDAV agrees, that Railway can join the tailnet, and that `svc-showrunner` can write the share. Runbook: **[WIRING_DAY.md](./WIRING_DAY.md)**. `smb` remains an honest 501 pointing at `webdav`. |
| **M365 / agent API** | Live and enforced server-side — scopes, confidence bands, rate limits, idempotency, and no `DELETE` anywhere under `/api/agent/*`. Agents propose; humans confirm. |

---

## Conventions / guardrails

- Additive migrations only in `initDB()` — **never `DROP`.** Legacy columns stay.
- **Wire every new table into the delete cascade** (`lib/db.js`) or you leak
  orphans; the smoke suite fails loudly if you forget.
- Roles are gated **server-side**. The UI hiding a button is a courtesy, not a
  control.
- Multi-row writes go through `withTx()`.
- One decision, one expression: a rule that appears in two places will drift.
  `hasFinance`, `canApprovePO` and `canApproveRecap` each exist exactly once and
  every call site delegates to them.
- The client recap is built by a generator that can only read client-safe
  fields, and every human edit is re-checked on the way in. No cost, PO or
  internal note is reachable from it.
