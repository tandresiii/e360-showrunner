# e360 Showrunner — Integration Spec

How a Showrunner **Project Folder → Show → 6 lanes** connects to the two systems it does not own:

1. E360's own generators (Spec Sheet Generator, NovaSpec, PowerSpec) + Flex, whose artifacts get **bound** to a Show and made viewable/printable by anyone who opens it — **Part (a)**.
2. The **E360 Sport Staffing Dashboard** (`e360-staffing3`, Postgres + Express), which is the downstream system of record for the live schedule — **Part (b)**.

> All route/column facts in Part (b) were read directly from `C:\code\e360-staffing3\server.js` (READ-ONLY; version `2026.05.19-d`). Line references are to that file.

---

## Part (a) — Bind a spec to an event folder

### The objects

- A **Project Folder** is the engagement. It contains one or more **Shows** (dated productions). A Show carries the 6 lanes; the **Deliverables** lane (plus a general **Files** area) is where spec artifacts live.
- A spec artifact is one of three derived types, each produced by an E360 browser tool:
  | Type | Tool | `auto_source` | Extension | What it is |
  |---|---|---|---|---|
  | Content spec | Spec Sheet Generator | `spec_gen` | `.e360` | pixel map / content layout / display map |
  | Data cabling | NovaSpec | `novaspec` | `.nsf` | cabinet cabling + data runs |
  | Power | PowerSpec | `powerspec` | `.pcfg` | power distribution / feeder / amperage |

  A fourth downstream artifact, the **Flex pull sheet** (`auto_source: flex`), derives the gear count from the power/cabinet layout.

### Where the bytes live vs where the metadata lives

Two-tier storage, matching how `e360-staffing3` already handles specs:

- **Cached render (DB).** When a spec is bound, the tool posts a **self-contained render bundle** — `json` (the raw editable spec), `svg` (diagram), `html` (full printable page), `png` (raster for email) — into per-type columns. In staffing these are `e360_spec_json/svg/html/png`, `nsf_spec_*`, `pcfg_spec_*` on `events` (server.js:633–652) and the identical set on `residencies` (server.js:671–673). Showrunner mirrors this: the render bundle is small, so it lives **in the DB** and travels with the Show. This is what makes the spec viewable/printable by anyone, with **no dependency on the source tool or the NAS at view time**.
- **Source file + heavy assets (E360 NAS).** The original editable `.e360`/`.nsf`/`.pcfg` project files, plus content packages, proofs, PDFs, and other large binaries, live on the **E360 NAS**. The DB stores only a **path/URI + metadata** (filename, size, type, who bound it, when, and — see stale-flagging — a revision). The app is hosted so the NAS is reachable, but routine viewing/printing never touches it because the cached HTML/PNG is already in the DB.

Rule of thumb: **the DB holds what you need to look at and print; the NAS holds what you need to re-edit or re-render.**

### Binding flow

1. The user opens the Show, goes to the Deliverables step (e.g. *"Content spec sheet (.e360) generated"*, `auto_source: spec_gen`) and launches the generator, or generates independently and clicks **Bind to this Show**.
2. The tool `POST`s the render bundle to the Show's spec endpoint — modeled on staffing's `POST /api/events/:id/spec-sheet` (server.js:1206). Body: `{ type: "e360" | "nsf" | "pcfg", json, svg, html, png }`. The server validates `type` is a known spec type, `json` is an object, and `svg` starts with `<svg` (server.js:1209–1225), then writes the four columns for that type via a `specCols(type)` lookup (server.js:1226–1229). `html`/`png` are optional (legacy-safe).
3. The bound step's evidence now **exists**, so the Deliverables step **auto-completes** (a step with an `auto_source` completes when its `evidence_ref` is present).
4. **Residency specs** bind to the residency (parent) instead of a single Show, using the identical column set on `residencies`. Member Shows (e.g. a **LOVB match**) **inherit** them — that is exactly why the LOVB template's *"Pull season content spec (inherited from residency)"* step has `auto_source: none`: nothing is generated per-match, it references the banked residency spec.

### Viewing & printing (anyone who opens the event)

- `GET /api/events/:id/spec-sheet` returns `{ e360, nsf, pcfg }`, each packed as `{ json, svg, html, png }` or `null` (server.js:1189–1203).
- The Show's Deliverables tab renders each bound spec's **full-page `html`** inside an `<iframe srcdoc>` modal. That HTML already carries print CSS: editor chrome is hidden under `.no-print { @media print { display:none } }` and multi-page specs break on `.ps ~ .ps { page-break-before: always }` (server.js:1278–1286). So **Browser → Print / Save-as-PDF** produces a clean printout for anyone — no login to the source tool, no NAS fetch.
- Packet emails embed the **PNG**, not the SVG, because Gmail and some clients strip inline `<svg>` (server.js:642–647, 1292–1296). The viewer modal prefers HTML/SVG; email prefers PNG. Both come from the one cached bundle.

### Derivation chain + stale-flagging

The chain is a **derivation**, not three independent files:

```
content spec (.e360)  ──derives──▶  data cabling (.nsf)  ──derives──▶  power (.pcfg)  ──derives──▶  Flex pull sheet
     spec_gen                            novaspec                          powerspec                      flex
```

Changing an upstream artifact makes every downstream artifact **potentially wrong**. So:

- **Re-binding `.e360`** (content layout changed) marks `.nsf`, `.pcfg`, **and** the Flex pull sheet **stale**.
- **Re-binding `.nsf`** marks `.pcfg` and the pull sheet stale.
- **Re-binding `.pcfg`** marks the pull sheet stale.

In the template this relationship is encoded as `depends_on` (each spec step names its upstream), so the pipeline already knows the edge to walk when flagging.

**Mechanism (recommended — the current staffing schema has the columns but no stale flag yet):** give each spec a monotonic `rev` (or content hash) + `updated_at`, and store on each child the `derived_from_rev` it was built against. A child is **stale** when `child.derived_from_rev != parent.rev` (equivalently `child.updated_at < parent.updated_at`). On `POST .../spec-sheet` for a parent type, bump the parent `rev` and set a `stale` badge on every descendant until it is re-bound against the new rev. Surface it as a red **"stale — regenerate"** chip on the downstream Deliverables/Gear steps and roll it up to the Show's RAG status.

This reuses a pattern already in the codebase: residency Flex folders store `flex_span_start/flex_span_end` (server.js:683–684) precisely so the folder can be flagged stale when member events reschedule outside the recorded span. Spec staleness is the same idea applied to the `.e360 → .nsf → .pcfg → pull sheet` edges.

---

## Part (b) — Push to scheduler: field mapping

**Direction:** Showrunner → `e360-staffing3`. When a Show is promoted, its header + lane data is written into the staffing DB through the routes below. All write routes require `requireAuth` (an `x-auth-token` header). There are **no SQL foreign keys** anywhere — child rows carry a bare `event_id INTEGER NOT NULL` and referential integrity + cascade are the app's job (the manual cascade lives in `DELETE /api/events/:id`, server.js:928–936). Therefore **create the event first, capture the `SERIAL id` from `RETURNING *`, then fan out** every child write with that id.

> Architecture note: in the shipped design (`EVENT_PM_BUILD_PLAN.md`) Showrunner and the staffing dashboard are the **same app + same Postgres**, and "push to scheduler" is a transactional `POST /api/events/:id/promote` that flips a `stage` column and **backfills** these same child rows — so nothing literally "transfers," it is already the one `events` row. The tables below are the authoritative field map whether promote runs in-process or Showrunner is a separate client calling these HTTP routes.

### B.1 — Show header → `POST /api/events` (server.js:887–902)

Inserts **23 columns**, returns the row incl. the new `SERIAL id` via `RETURNING *`. Request body is camelCase; the server maps each to a snake_case column with a default fallback.

| Showrunner (Project/Show) source | Request body field | `events` column | Notes |
|---|---|---|---|
| Show name | `event` | `event` | required |
| Show event/match date | `eventDate` | `event_date` | anchor for all T-minus offsets |
| Load-in date (Venue/Gear lane) | `setup` | `setup` | |
| Strike date | `breakdown` | `breakdown` | |
| Load-in time | `setupTime` | `setup_time` | default `''` |
| Event start time | `eventTime` | `event_time` | default `''` |
| Venue / location | `location` | `location` | |
| Media server | `mediaServer` | `media_server` | default `'N/A'` |
| Crew lane assignees | `staff` | `staff` (JSONB) | array of **canonical** roster names — see B.5 |
| Kickoff summary / notes | `notes` | `notes` | |
| — | `archived` | `archived` | default `false` |
| Project client | `clientId` | `client_id` | integer id into `clients`; no FK enforced |
| Ship-out date (Logistics) | `shipOutDate` | `ship_out_date` | |
| Ship-return date (Logistics) | `shipReturnDate` | `ship_return_date` | |
| "no ship out" flag | `noShipOut` | `no_ship_out` | |
| "no ship return" flag | `noShipReturn` | `no_ship_return` | |
| Template `event_type` (LED/Print/Both) | `eventType` | `event_type` | default `'LED'` |
| Tech notes | `techNotes` | `tech_notes` | |
| Primary client contact (legacy single) | `clientContactName` | `client_contact_name` | multi-contact → B.4 |
| " | `clientContactTitle` | `client_contact_title` | |
| " | `clientContactCompany` | `client_contact_company` | |
| " | `clientContactPhone` | `client_contact_phone` | |
| " | `clientContactEmail` | `client_contact_email` | |

Spec columns (`e360_spec_*`, `nsf_*`, `pcfg_*`), `flex_element_*`, `flex_gear_list_*`, `route_id`, `residency_id`, `engagement_type` are **not** set here — they are bound afterward via the spec/Flex endpoints (B.6).

### B.2 — Logistics (& booked Gear) lane → `POST /api/bookings` (server.js:2839–2853)

One booking row per Logistics/labor/travel-vendor line. Requires `eventId` **and** `category` (server.js:2842). `category` is free-text; values the app already uses/special-cases include `truck`, `forklift`, `stagehands`, `labor`, `rental`, `shipping`, and `hotel` (hotels are treated as personal and excluded from the vendor section of packets — server.js:1911/1917). Map each template step whose `evidence_type` is `booking`:

| Showrunner source | Body field | `bookings` column |
|---|---|---|
| new event's id | `eventId` | `event_id` (required) |
| booking kind (truck/forklift/stagehands/labor/rental/hotel/shipping…) | `category` | `category` (required) |
| step title / free label | `customLabel` | `custom_label` |
| vendor | `vendorName` | `vendor_name` |
| vendor contact | `contactName` / `contactPhone` / `contactEmail` | `contact_name` / `contact_phone` / `contact_email` |
| qty (trucks, forklifts, hands) | `quantity` | `quantity` |
| service window | `startDate` / `endDate` | `start_date` / `end_date` |
| task status | `status` | `status` (default `'needed'`) |
| confirmation paperwork # | `confirmationNumber` | `confirmation_number` |
| notes | `notes` | `notes` |
| assigned tech(s) | `staffAssigned` (JSONB array) | `staff_assigned` |
| ordering | `sortOrder` | `sort_order` |

This is also the surface for the build plan's "who booked what / is it confirmed / show me the confirmation" accountability: `status` + `confirmationNumber` + `staffAssigned` per line.

### B.3 — Venue lane → `POST /api/venue-contacts` (server.js:2768–2779)

Requires `eventId`. One row per venue contact.

| Showrunner source | Body field | `venue_contacts` column |
|---|---|---|
| new event's id | `eventId` | `event_id` (required) |
| contact name | `name` | `name` |
| venue role (ops, grounds, power…) | `role` | `role` |
| phone / email | `phone` / `email` | `phone` / `email` |
| ordering | `sortOrder` | `sort_order` |

### B.4 — Client lane → `POST /api/client-contacts` (server.js:2708–2718)

Requires `eventId`. One row per client contact (multi-contact; the single legacy contact still also rides on the event header in B.1).

| Showrunner source | Body field | `client_contacts` column |
|---|---|---|
| new event's id | `eventId` | `event_id` (required) |
| contact name | `name` | `name` |
| job title | `title` | `title` |
| company | `company` | `company` |
| phone / email | `phone` / `email` | `phone` / `email` |
| ordering | `sortOrder` | `sort_order` |

### B.5 — Crew lane → `events.staff` (JSONB) — canonical-name validated

Crew is **not** a child table; it is the `staff` JSONB array on the `events` row (set in B.1, editable via `PUT /api/events/:id`, server.js:903). It is an array of **canonical roster names**. Downstream, the server keys the roster by `name.toLowerCase().trim()` to resolve emails and color chips (e.g. `rosterMap` at server.js:1897–1899); a name that is not a canonical `roster.name` silently gets **no email and no chip**.

**Showrunner obligation:** before pushing, resolve each Crew-lane owner (a roster person, not a role slug) to its canonical `roster.name` — the build plan calls this `canonicalName()` (EVENT_PM_BUILD_PLAN.md §3/§8) — and push the canonical string. Techs who are also booked labor additionally appear in `bookings.staff_assigned` (B.2). The template `owner_role` slugs (`lead_tech`, `pm`, …) are **planning roles**, not roster identities — map them to actual people at promote time.

### B.6 — Travel → `POST /api/travel` (server.js:2637–2646)

Upsert keyed on `travel_key` (`ON CONFLICT (travel_key) DO UPDATE`). Each Crew-travel step (`auto_source: travel`) becomes one upsert per person per leg.

| Showrunner source | Body field | `travel_info` column |
|---|---|---|
| composite key (below) | `key` | `travel_key` (unique) |
| flight number | `flightNum` | `flight_num` |
| arrival time / date | `arrivalTime` / `arrivalDate` | `arrival_time` / `arrival_date` |
| driving? | `isDriving` | `is_driving` |
| departure city/date/time | `departureCity` / `departureDate` / `departureTime` | `departure_city` / `departure_date` / `departure_time` |
| return leg? | `goingHome` | `going_home` |
| PNR / record locator | `recordLocator` | `record_locator` |

**`travel_key` format:** `"Person Name|prevEventId|nextEventId"` (the packet builder queries `%|%|<id>` for arrivals and `%|<id>|%` for departures — server.js:1920–1923). For an arrival into this Show use this event's id as `nextEventId`; for the return leg use it as `prevEventId` with `goingHome: true`.

### B.7 — Gear lane → Flex + spec endpoints (not a plain POST)

The Gear/Deliverables lanes don't map to a single insert; they call the Flex and spec routes, which stamp columns back onto the event:

| Showrunner step (`auto_source`) | Endpoint | Stamps on `events` |
|---|---|---|
| Create Flex event folder (`flex`) | `POST /api/events/:id/flex/create-element` (server.js:991) | `flex_element_id`, `flex_element_number` |
| Link an existing Flex folder | `POST /api/events/:id/flex/link-element` (server.js:1026) | same (verifies it is an Event Folder first) |
| Build / attach pull sheet (`flex`) | `GET /api/events/:id/flex/available-gear-lists` (server.js:1083) then `POST /api/events/:id/flex/attach-gear-list` (server.js:1103) | `flex_gear_list_id`, `flex_gear_list_type` (`pull-sheet`\|`manifest`) |
| Spec sheets (`spec_gen`/`novaspec`/`powerspec`) | `POST /api/events/:id/spec-sheet` (server.js:1206) | `{e360,nsf,pcfg}_spec_{json,svg,html,png}` — see Part (a) |

### Order of operations & guardrails

1. `POST /api/events` → capture `id` from `RETURNING *`.
2. Fan out with that id: `/api/bookings` (B.2), `/api/venue-contacts` (B.3), `/api/client-contacts` (B.4), `/api/travel` (B.6); `PUT /api/events/:id` to set `staff` (B.5); Flex + spec endpoints (B.7).
3. **No FKs** → Showrunner owns integrity. Deleting an event must mirror the app's manual cascade over `bookings`, `venue_contacts`, `client_contacts` (server.js:928–936); Export/Import must round-trip any new child rows (server.js export/import handlers).
4. **Auth:** every write needs `x-auth-token`. In-memory sessions are wiped on each Railway redeploy, so an automated Showrunner push needs a **durable service credential / API key**, not a UI session (EVENT_PM_BUILD_PLAN.md §5/§8).
5. **Idempotency:** a re-push (re-promote) should update existing child rows, not duplicate them — guard on existing rows per event.
