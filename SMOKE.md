# Running the smoke test

`scripts/smoke.js` boots the real server in-process on an ephemeral port and
drives it over HTTP, exactly as a browser or an agent would. It is the wiring
pass's proof of work: **504 assertions**, covering initDB idempotency, the
templates.json seed loader, auth, one representative call per route family, the
whole agent-API happy path, the confidence bands, idempotent replay, the §9
guardrails, the recap content firewall, cascade integrity, and — since
2026-08-27 — a section per fixed item in `HARDENING_TODO.md` (§14: the margin
projection, PO numbering, the thumbnailer route's reachability, superseded-file
listing, `spec_renders` cleanup, one `hydrateShow`, one notify mechanism, and
the recap floor that draft and approve now share).

Each §14 assertion is written to FAIL on the behaviour it replaced, and every
one of them was **mutation-tested** — the fix reverted, the suite watched going
red, the fix restored. A gate test nobody has watched fail is a rumour.

```bash
cd showrunner-app
npm install
DATABASE_URL="postgres://user:pass@host:5432/showrunner_scratch" npm run smoke
```

Exit code `0` = everything passed. `1` = assertions failed (each is named).
`2` = no `DATABASE_URL`. `3` = the run aborted on an exception.

---

## Requirements

| | |
|---|---|
| **PostgreSQL** | 12+. A **scratch database — never production.** The script creates and then cascade-deletes everything it touches, but it also runs `initDB()` against whatever you point it at. |
| **Encoding** | **The database must be UTF-8.** Activity details and note bodies carry `→`, `—` and typographic quotes; a `WIN1252` database rejects them with `22P05 report_untranslatable_char`. Railway's Postgres is UTF-8 by default. To create one by hand: `CREATE DATABASE showrunner WITH ENCODING 'UTF8' TEMPLATE template0;` |
| **Node** | 18+ (it uses the built-in `fetch`). |
| **Storage** | Defaults to a temp directory. Override with `STORAGE_ROOT=…`. It never needs the NAS. |

## Environment

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **required** |
| `SMOKE_PORT` | `31879` | change it if the port is busy |
| `STORAGE_ROOT` | `$TMPDIR/showrunner-smoke-storage` | where byte uploads land |
| `SEED_ROSTER` | forced to `1` | the demo roster is created so mention/assignment paths have people |

Add `?sslmode=disable` to a local connection string; the pool only enables TLS
for non-loopback hosts.

## What it proves

| # | Area | Sample assertions |
|---|---|---|
| 1 | `initDB` idempotency | boots twice; the table count is identical |
| 2 | seed loader (punch B/A/C) | 4 templates from `templates.json`, `owner_role` preserved, 9 `evidence_type` `file → flex_element` reconciliations, no duplicate templates on re-run, lane sets `led=6 / print=8 / both=10` |
| 3 | auth (punch E/F) | bcrypt hash in the row, durable session row, a legacy sha256 password logging in **and being re-hashed to bcrypt**, 401 on an unauthenticated read |
| 4 | CRUD per family | projects · shows (+ template instantiation and back-scheduled due dates) · steps (incl. the tech-owns-their-own-step rule) · files (+ byte upload) · jobs/budgets/expenses · POs (the whole `needed → ordered` pipeline and the $5k gate) · notes/inbox · the call sheet (canonical `/call-sheet`, retained `/run-of-show` alias) · photos · deliverables |
| 4b | temp job numbers (POLISH_LIST #5) | a pm opens a job with no number and the server mints `TEMP-{yy}-{seq}`; the next one takes the next sequence; a pm still cannot type a real number; an untouched temp job is quiet but one with a budget line feeds `kind: job_number` on the chase list; accounting confirms it, the status flips, `job.number.confirm` names both numbers, the chase clears, and the budget line is still attached |
| 5 | agent API | key mint → `whoami` → `match` → `documents` → `tasks:batch` → `notes` → `projects` → `purchase-requests`, plus `shows/:id/context` |
| 6 | proposals | medium band quarantines under `_agent-inbox`, creates **no** expense; confirm materializes it and **moves the bytes**; reject marks the row and **purges the bytes**; re-confirm is 409; an agent key cannot confirm |
| 7 | confidence bands | `filed` at 40 → **422**; `ambiguous:true` at 95 → **422**; `filed` at 93 → lands, with its expense and activity row |
| 8 | idempotency | identical replay returns the **original** body with `x-idempotent-replay: true` and creates no duplicate; a different body on the same key → **409** |
| 9 | §9 guardrails | no `DELETE` under `/api/agent/*`; scheduler push, user admin and key management all **403** with an agent key; deliverables absent; an unknown agent path 404s **there**, never falling through; scope and revocation enforced |
| 10 | content firewall | a dollar figure and internal accounting language are **refused with the reason**; client-safe prose is accepted |
| 11 | cascade integrity | a folder carrying a child of **every** wired table is deleted; **zero orphans** across all 25 child tables |
| 15 | **F1 · real event creation** | one `POST /api/events` creates the folder, its show and a TEMP-numbered job **in one transaction** — exactly one of each; the type's template seeds its lanes with back-scheduled due dates; a scope entered at creation lands; the notify picker produces **one** ping, **one** anchored note and **one** activity line for the whole act; with no selection **nobody** is notified; a tech is refused; a nameless or badly-dated event is a 400 |
| 15 | **F2 · tech show reports** | striking a show creates one report per **logged-in** crew member and none for the local hire; striking twice creates nothing; the nag is an anchored note **plus** an outbox row of kind `report_nag`. **Gate, mutation-tested:** a tech sees only his own row and gets the headcount **without** the names, is 403 on a colleague's report, and cannot mark anything reviewed — *"techs file their own reports but never sign one off"*; a pm sees every row and the waiting-on list, and a pm **cannot write** somebody else's report at all. Filing lands a `report` file in the folder; revising does not create a second one; a reviewed report is locked until a pm reopens it, and reopening returns it to **filed**, not to owed |
| 15 | **F2 · THE FIREWALL** | a report body carrying a canary reaches **neither** `recapFacts` nor a real regenerate nor the client sheet — and the body is still sitting in the table, simply unread. The enforcement, not the observation: `guardRecapQuery()` **throws** if the generator ever reads `tech_reports` (or `expenses`/`jobs`/`notes`/`deliverables`/…), while the reads it is allowed pass straight through |
| 15 | **F3 · the outbox** | defaults are Tom's rule and are stored **nowhere** — the prefs table holds deviations only, and writing the house default removes the row; an assignment and an @mention each queue an immediate row, and the mention carries its **note id**. **Skip-if-read-in-app:** a note read in the app first is `skipped`, an unread one is `sent` and the `log` driver records where it went. `off` still reaches the **bell** and records the silence as `skipped: preference off`. A plain flush leaves **digest** rows alone (there is no scheduler); `{digest:true}` flushes them. With `MAIL_DRIVER=graph` unconfigured, `send()` is a 501 naming the four missing vars and **the item stays queued** |
| 15 | **F4 · the scope line** | pm+ sets it and the **server** renders the one canonical line; a tech is refused; an unknown kind and a negative count are 400s; switching an LED scope to `both` **keeps** the print numbers. Filling from a bound spec takes the **stack-aware** count and marks the source, while leaving linear feet (which no spec records) alone; a divergence is a **question**, not an error, and overwrites nothing. **Firewall:** the seven scope fields are on `RECAP_SOURCES.show` deliberately (`scope_verified_by` is **not**), every stat the generator emits has a key in `recap_stat_keys`, and a key off that list is refused by name |
| 15 | **F5 · the confirm lifecycle** | `/api/stages` publishes the vocabulary and the legacy alias map. A `planning` row is **stored, returned and labelled** `planning`, carries `stage_canonical: confirmed` alongside, and reads as confirmed **by position with no datestamp invented**. **Gate, mutation-tested:** a tech and a pm-who-owns-nothing are refused and write nothing; the owning pm clears it, records who and when, advances the stage, logs it, and prompts for the real QuickBooks number. Confirming twice is a 409. The **live push** is a 409 pre-confirm naming the endpoint that fixes it, while the **dry run still runs** and reports the reason — and a pre-existing `planning` row is not blocked, which is the additive proof |
| 16 | **Flex · the real create-element** | With `FLEX_*` unset the route is a **501 naming both variables**, and a tech is refused *before* the configuration question is even asked. Then the vars are pointed at an **unroutable stub host** and `global.fetch` is swapped for a pass-through stub, so the server is still driven over real HTTP while every Flex call is answered locally — **no test ever writes to the live tenant.** Against the stub: a non-owner pm is 403 and an unknown show 404 with nothing sent; the create stores **the id Flex returned**, the em-dash in the show name arrives as a hyphen, every date is `…Z` (never `T00:00:00Z`, never an offset), plannedStart/End are load-in −3d / strike +7d at Central noon, and the doors/show/strike times ride in `notes` because the Event Folder form has no field for a clock time. A client already in the directory is **matched**, a venue that is not is **created**, the directory is read **once** for both, and one activity line names the element and both outcomes. A second create is a **409** that sends nothing. A **fabricated** prototype id is flagged, offered no deep link, and **replaced** rather than 409'd — and when the contact create fails, `venueId` is **absent** from the payload while the venue name still reaches Flex on its own notes line. With the toggle **off**, no contact is created and the reason says the option was off, not that Flex refused |
| 15 | **F6 · closeout + archiving** | closeout is machine-checked on three conditions and names which one is out; late money **un-completes** it and stops the 60-day clock. **Gate, mutation-tested:** neither a pm nor a manager may archive — admin only, and both refusals write nothing. Archived is excluded from the default lists, returned by `?archived=1`, included by `?include_archived=1`, **still resolves by id**, is **still carried by its folder** (season rollups unaffected), and stops nagging in My Tasks. Archiving a folder takes its shows; unarchiving returns a show to `closed` rather than inventing a stage. The **sweep** auto-archives a show 61 days past closeout, takes its folder with it, changes nothing on a second run, and says out loud that it is not a scheduled job |

## The additive-upgrade proof

`scratchpad/upgrade_proof.js` (run under the same `pgharness.js`) proves the
"strictly additive" rule against a **real pre-release database** rather than
against a claim. It checks the PREVIOUS `lib/db.js` out of git, runs *its*
`initDB()` — literally the schema now live on Railway — writes a folder, a job,
a show at stage `planning`, a step and a note the old way, then runs the NEW
`initDB()` over the same database and asserts, in **29 assertions**:

* every pre-existing column on all five rows is **byte-identical**
* the show kept its legacy stage string, rag, owner, dates and cabinet count
* the job kept its real QuickBooks number, and `qb_number_status` defaulted to
  `confirmed` — a number already in the table came from QuickBooks
* no row was added or removed
* all 17 new `shows` columns exist and **every one is NULLABLE** — no `NOT NULL`
  on an existing table — and read `NULL` on the pre-existing row
* the three new tables exist and are **empty**: a migration creates obligations
  for nobody
* the legacy row reads correctly through the new mappers — stored stage
  returned verbatim, canonical position *alongside* it, confirmed **by position
  with no datestamp invented**, and an empty scope line rather than a
  fabricated one

## Reading a failure

Each line prints `✓` or `✗ name -> {response}`. A failing line names the
punch-list item or `AGENT_API.md` section it maps to, so the fix location is
usually obvious from the assertion text alone.

The run is self-cleaning: everything it creates is tagged `smoke<base36>` and
removed at the end, and the final assertion verifies that nothing tagged
survived.
