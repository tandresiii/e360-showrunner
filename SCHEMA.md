# E360 Showrunner — Schema, API surface & scheduler mapping

**Regenerated 2026-08-27 from the running database** at the end of the wiring
pass; **extended by the first post-deploy release** (F1 event creation ·
F2 tech show reports · F3 the notification outbox + mail layer · F4 the scope
line · F5 the confirm lifecycle · F6 closeout + archiving), whose additions are
marked **F1-F6** throughout. This file is the reference again: every table, column, index, enum and
route below was read back out of a live Postgres after `initDB()` + `seedAll()`,
not transcribed from intent.

All migrations are **additive** — `CREATE TABLE IF NOT EXISTS` +
`ALTER TABLE ADD COLUMN IF NOT EXISTS`, in one `initDB()` (`lib/db.js`). Never
`DROP`. **No SQL foreign keys and no `ON DELETE CASCADE`**: parent/child links
are plain integer columns and cascade deletes are handled manually, in code,
inside a transaction (staffing-app convention). Adding a table means wiring it
into the cascades or it leaks rows on every folder delete.

Hierarchy: **Project (Event Folder) → Show (≈ one staffing event) → Steps**,
with **Jobs** (the commercial dimension) alongside the shows in the folder.

> **Encoding:** the database must be **UTF-8**. Activity details and notes carry
> `→`, `—` and typographic quotes.

---

## Module map

| File | Lines | What it owns |
|---|---:|---|
| `server.js` | 315 | app setup, CORS allowlist, body caps, mount order, SPA + deep-link fallback, boot, housekeeping |
| `lib/enums.js` | 372 | every whitelist + pure helpers |
| `lib/db.js` | 1030 | pool, `withTx`, `initDB`, the three manual cascades, config get/set |
| `lib/auth.js` | 320 | bcrypt, durable sessions, api keys, role/scope/capability gates, rate limits |
| `lib/mappers.js` | 547 | row → API record (snake_case human surface, camelCase agent surface) |
| `lib/seed.js` | 261 | lanes, event types, recap stat keys, config, admin, opt-in roster, **templates.json loader** |
| `lib/activity.js` | 37 | the one `logActivity` writer |
| `lib/agent.js` | 342 | matcher, confidence bands, provenance, idempotency ledger, proposals |
| `lib/storage.js` | 155 | NAS abstraction — local driver now, SMB/WebDAV stubbed |
| `lib/firewall.js` | 344 | `recapFacts` / `recapUnsafe` / `buildRecapDraft` — the client-content firewall |
| `lib/http.js` | 67 | `asyncH`, throwable HTTP errors, paging helpers |
| `lib/mentions.js` | 171 | @mention parsing, the notify principle |
| `lib/notify.js` | 284 | **F3** — the notification outbox: preferences, enqueue, the digest row, skip-if-read, flush |
| `lib/mail.js` | 165 | **F3** — the two delivery drivers (`log` default · `graph` skeleton) |
| `lib/reports.js` | 170 | **F2** — tech show reports: the obligation, the nag, the two gates |
| `lib/lifecycle.js` | 284 | **F5/F6** — the confirm gate, the machine-checked closeout, archiving, the sweep |
| `routes/auth.js` | 248 | login, roster, **api keys (human-only)** |
| `routes/core.js` | 1361 | projects, shows, steps, templates, milestones, activity, push-to-scheduler |
| `routes/files.js` | 737 | files + financial docs, spec chain, Flex state, bookings, proofs |
| `routes/finance.js` | 616 | jobs, budget lines, expenses, the money views |
| `routes/purchasing.js` | 920 | purchase orders, lines, the approval gate |
| `routes/notes.js` | 387 | anchored notes, mentions, the personal inbox |
| `routes/schedule.js` | 824 | run of show, crew, call-sheet header |
| `routes/photos.js` | 601 | photo curation, picks, the thumbnailer contract |
| `routes/deliverables.js` | 624 | the client recap lifecycle |
| `routes/proposals.js` | 406 | **confirm / reject — session only** |
| `routes/agent.js` | 660 | the whole `/api/agent/*` surface |
| `routes/reports.js` | 322 | **F2** — the tech-show-report human surface (deliberately absent from `/api/agent/*`) |
| `routes/notifications.js` | 179 | **F3/F6** — outbox + preferences + mail status + the admin sweep |
| `scripts/smoke.js` | 2357 | 465-assertion end-to-end smoke (see `SMOKE.md`) |

---

## Enumerations (whitelisted server-side, `lib/enums.js`)

| Enum | Values |
|---|---|
| project/show `type`, template `event_type` | `led` · `print` · `both` |
| `stage` (project + show) | **F5 — a UNION, never a replacement.** The legacy five (`lead` · `planning` · `ready` · `scheduled` · `closed`) stay legal values and **no stored row is ever rewritten**; the commercial lifecycle joins them: `quoted` -> `confirmed` -> `in_progress` -> `delivered` -> `closed` -> `archived`. `in_production` is still a *print lane*, never a stage. See **F5 · the commercial lifecycle** below for the display/ordering map |
| show `rag` | `go` · `warn` · `crit` · `idle` |
| step `lane` | **not an enum** — see *Lanes are config* below |
| step `status` | `todo` · `in_progress` · `done` · `blocked` · `na` |
| step `evidence_type` | `flex_element` · `doc_link` · `booking` · `file` · `none` |
| step `auto_source` | `spec_gen` · `novaspec` · `powerspec` · `flex` · `travel` · `none` |
| file `kind` | `spec` · `proof` · `contract` · `confirmation` · `recording` · `other` **· `receipt` · `invoice` · `po` · `transcript` · `photo` · `report`** (F2 — a filed tech show report lands in the folder's Files) |
| financial file kinds | `receipt` · `invoice` · `po` · `confirmation` |
| file `artifact` | `pullsheet` · `manifest` · `image` · `document` |
| file `status` | `filed` · `proposed` · `rejected` · `superseded` — writable by a client: `filed` · `proposed` · `rejected` only. `superseded` is a **server act** (binding a new spec rev retires the file the previous rev pointed at), so it is not on the create whitelist. `rejected` and `superseded` are **history, not inventory**: `GET /files` excludes both by default and returns them only when asked for by name (`?status=superseded`) |
| file `spec_type` | `e360` · `nsf` · `pcfg` · `null` |
| expense `status` | `proposed` · `filed` · `confirmed` · `posted` |
| job `deal_type` | `rental` · `sale` |
| **budget category** (shared by `budget_lines.category`, `expenses.budget_line_category`, `po_lines.category`) | `travel` · `freight` · `labor` · `gear` · `print` · `production` · `misc` |
| PO `status` | `needed` → `quoted` → `ordered` → `shipped` → `received` → `reconciled` |
| PO committed statuses | `ordered` · `shipped` |
| `po_lines.ownership` | `inventory` · `cogs` |
| note `anchor_type` | `project` · `show` · `step` · `file` · `job` · `expense` · `po` |
| schedule `kind` | `travel` · `work` · `show` · `meal` · `strike` |
| deliverable `kind` / `status` | `recap` · `call_sheet` · `photo_set` / `draft` · `approved` · `sent` |
| recap stat keys | `cabinets` · `panels` · `crew` · `days` · `attendance` · `date` **· F4, widened deliberately: `scope` · `linear_feet` · `cabinet_count` · `cabinet_type` · `pitch` · `print_pieces` · `print_sqft`** — physical facts about what the client bought, none of which is derivable into a cost, a rate or a margin |
| **F4** scope `kind` / `source` | `led` · `print` · `both` / `manual` · `spec` |
| **F2** tech report `status` | `owed` -> `filed` -> `reviewed`. **Filing completes the obligation**; `reviewed` is optional pm bookkeeping and closeout counts *filed*, never *reviewed* |
| **F3** notification `kind` | `assignment` · `mention` · `notify` · `report_nag` · `digest` |
| **F3** notification `mode` | `immediate` · `digest` · `off` — the per-(user, kind) preference. **`off` silences the EMAIL, never the bell** |
| **F3** notification `status` | `queued` · `sent` · `skipped` · `failed`. `skipped` is a deliberate outcome with a reason (`read in-app` · `preference off` · `no email address on file`), not a failure |
| **F3** mail driver | `log` (default) · `graph` |
| provenance `source_kind` | `email` · `meeting` · `chat` · `manual` · **`camera_roll`** · **`closeout`** |
| `matched_by` tokens | `explicit_id` · `client_name` · `venue` · `date_window` · `participant` · `vendor_history` · `thread_ref` · `job_number` · `keyword` · `show_record` |
| agent scopes | `agent:read` · `agent:file` · `agent:propose` |
| proposal `kind` / `status` | `document` · `tasks_batch` · `project` · `expense` · `purchase_request` / `pending` · `confirmed` · `rejected` · `expired` |
| template `owner_role` | `sales` · `account_manager` · `pm` · `technical_director` · `content_manager` · `lead_tech` · `gear_lead` · `logistics_coordinator` · `graphic_designer` · `print_producer` |
| user `role` | `viewer` · `tech` · `pm` · `manager` · `admin` |

### Lanes are config, not an enum

`lanes` (14 rows) is the catalogue; `event_types` carries a `lanes TEXT[]` per
type. A step's lane is validated against **its project type's** set, read from
the DB at request time:

| type | lanes |
|---|---|
| `led` (6) | client · venue · logistics · crew · gear · deliverables |
| `print` (8) | design · proof · approval · production · tracking · ship · install · return |
| `both` (10) | client · venue · design · proof · approval · logistics · crew · gear · deliverables · install |

Adding "Motion Graphics" with three new lanes is two rows, not a deploy.
`GET /api/event-types` serves both tables so the front-end never hardcodes them.

---

## Tables (37)

### Core hierarchy

**`projects`** — the Event Folder
`id · name · slug · client · type · stage · owner · description · summary · source · provenance JSONB · source_ref · created_at · updated_at`
**F6:** `· archived_at · archived_by` *(idx: `archived_at`)*
`summary`/`source` drive the AI-summary panel and its provenance line.
A folder archives when **every show inside it** is archived (or by hand, for an
empty one). Archived folders drop out of `GET /api/projects`; the folder itself
still resolves by id, so a deep link and a search hit both still open.

**`shows`** — one show ≈ one staffing event *(idx: `project_id`, `default_job_id`)*
`id · project_id · name · slug · venue · city · load_in_date · event_date · strike_date · stage · rag · rag_override · on_site_poc · owner · default_job_id · cabinets · scheduler_event_id · summary · source · load_in_time · doors_time · event_time · strike_time · venue_address · parking_notes · radio_channel · dress_code · venue_poc JSONB · client_poc JSONB · provenance JSONB · source_ref · created_at · updated_at`
**F4 (the scope line):** `· scope_kind · scope_linear_feet NUMERIC(10,2) · scope_cabinet_count INT · scope_cabinet_type · scope_pitch · scope_print_pieces INT · scope_print_sqft NUMERIC(12,2) · scope_source · scope_verified_at · scope_verified_by`
**F5 (the confirm fact):** `· confirmed_at · confirmed_by`
**F2 (strike):** `· struck_at · struck_by`
**F6 (closeout + archive):** `· closeout_complete_at · archived_at · archived_by` *(idx: `archived_at`, `closeout_complete_at`)*
Every one of these defaults to `NULL`, so an existing show simply has no scope
line, no confirm datestamp and no archive state until someone creates one — **no
row is rewritten and nothing renders differently until it is.**

> **RAG resolution:** `rag_override` (a manager's explicit call) **wins**;
> otherwise the value is **derived** from the show's steps (blocked or overdue →
> `crit`; risk-flagged or due within 3 days → `warn`; nothing open → `go`);
> `rag` is the legacy stored fallback for a show with no steps yet.

**`jobs`** — one deal = one client = one `qb_job_number` = one budget *(idx: `project_id`)*
`id · project_id · name · qb_job_number · qb_number_status · client · deal_type · description · contract_value NUMERIC(12,2) · status · created_at · updated_at`
**`budget_total` is derived** (`SUM(budget_lines.allotted)`) in the query — there
is deliberately no such column. `qb_job_number` is writable only by the finance
capability (or an admin), and never by an agent.

**Temp job numbers (POLISH_LIST #5).** A deal exists days before accounting cuts
the QuickBooks number, and costs start landing against it immediately — so a job
is **never numberless**. Created without a real number it gets the placeholder
`TEMP-{yy}-{seq}` and `qb_number_status='temp'`; `'confirmed'` means the number
came from QuickBooks, and is the default for every row that predates the column.
The seq is the highest already minted that year plus one (`mintTempJobNumber()`
in `lib/db.js`, shared by `routes/finance.js`, `routes/core.js` and
`routes/proposals.js`), so a deleted job never has its label reused.

* **Nothing links by the number.** Every reference in this schema — expenses,
  po_lines, budget_lines, shows.default_job_id, activity — is on `jobs.id`, so
  confirming the real number re-links nothing. That is the whole safety argument.
* **Who writes it:** `PUT /api/jobs/:id` gates `qb_job_number` on `hasFinance()`
  — the three admins plus Candice. A **pm** may create a job (the placeholder is
  minted server-side) but may not type a real number; an **agent** may propose a
  job and never set a number at all (AGENT_API §9).
* **Flipping to confirmed** is implicit: write a non-`TEMP-` number and the
  status follows. It logs its own accented activity row,
  `job.number.confirm` — *"job number confirmed 26-1241 (was TEMP-26-014)"* —
  rather than a generic `job.update`. Clearing the number re-mints a placeholder
  instead of leaving the row blank.
* **The chase:** `GET /api/finance/exceptions` emits `kind: 'job_number'`
  (`missing: 'a QB job number — Candice'`, `chase: 'candice'`, `amount: null`,
  `show: null`) for a temp job that has **something riding on it** — an expense,
  a PO line, a budget line, or any activity other than its own `job.create` row.
  A temp job nobody has touched is just an early folder and stays quiet.

**`steps`** — the pipeline unit *(idx: `show_id`, `project_id`, `owner`)*
`id · show_id · project_id · lane · title · status · owner · owner_role · due_date · due_offset_days · evidence_type · evidence_ref · depends_on · auto_source · sort_order · notes · risk BOOL · provenance JSONB · source_ref · created_at · updated_at`
Keeping **both** `due_date` and `due_offset_days` means a show date change
recomputes the back-schedule (`PUT /api/shows/:id` does exactly that).

**`milestones`** *(idx: `show_id`, `project_id`)* — `id · show_id · project_id · label · date · sort_order`

### Templates + lane config

**`event_type_templates`** — `id · name · event_type · description · created_at · source_key`
`source_key` (unique when non-null) is how the templates.json loader updates a
template in place instead of duplicating it. Human-authored templates have
`source_key NULL` and are never touched by the loader.

**`template_steps`** *(idx: `template_id`)* — `id · template_id · lane · title · due_offset_days · owner_role · evidence_type · auto_source · depends_on_title · sort_order`

**`lanes`** — `key · label · color · sort_order`
**`event_types`** — `key · label · tag · icon · anchor · lanes TEXT[] · sort_order`

### Documents & evidence

**`files`** — metadata only; bytes live behind `lib/storage.js`
*(idx: `project_id`, `show_id`, `kind`, `status`, `job_id`, `source_ref`)*
`id · project_id · show_id · name · ext · kind · spec_type · artifact · ver · dim · meta · chain_key · nas_path · size BIGINT · uploaded_by · amount NUMERIC(12,2) · vendor · doc_date · job_id · attached_to · status · provenance JSONB · source_ref · taken_at · width · height · caption · tags TEXT[] · shot_by · recap_pick BOOL · thumb_path · created_at`

A **photo** is a `files` row with `kind='photo'`. A **financial doc** is a
`files` row with `amount`/`vendor`/`doc_date`/`job_id` set. One table, one
lifecycle, one set of guardrails.

**NAS path convention** (`lib/storage.js buildNasPath`):
```
{SHOWRUNNER_NAS_ROOT}\P{projectId}-{slug}\{ S{showId}-{slug} | _project }\{kind}\{filename}
```
Photos therefore land under the **mechanical `{kind}` folder — `\photo\`** with
no special casing. Proposed documents quarantine under
`{ROOT}\_agent-inbox\{username}\{kind}\{filename}` and **move to the canonical
path on confirm**; a rejected proposal leaves nothing behind.
The NAS thumbnailer writes `{name}_t320.jpg` beside the original and PATCHes
`files.thumb_path`.

**`spec_chain`** *(unique `(show_id, node)`)* — `id · show_id · node · gen · rev · derived_from_rev · by · when_at · file_id · updated_at`
Nodes: `content → cabling → power → pull`. A child is **stale** when
`derived_from_rev ≠ parent.rev`; staleness is *derived on read*, never stored.

**`spec_renders`** *(idx: `(show_id, node)`, `file_id`)* — `id · file_id · show_id · node · spec_type · rev · svg · html · png · json JSONB · tool_version · source_url · created_by · created_at`
The **render bundle** the three browser tools produce, one row per bind, so
history comes free and `files` stays narrow. Showrunner stores the spec *file*
(`files` + NAS bytes) and the chain *state* (`spec_chain`); without this table a
bound spec could not be viewed or printed without opening the source tool.
`html` renders in an `<iframe srcdoc>` — the tools inline their own stylesheets,
so browser Print → PDF works unaided. Prefer `png` for anything email-bound
(Gmail strips inline `<svg>`). `json` is kept here as well as on the NAS so the
consistency checker never has to touch storage.

| Tool | `spec_type` | node | ext |
|---|---|---|---|
| Spec Sheet Generator | `e360` | `content` | `.e360` |
| NovaSpec | `nsf` | `cabling` | `.nsf` |
| PowerSpec | `pcfg` | `power` | `.pcfg` |
| *(Flex pull sheet — not a tool)* | — | `pull` | — |

Both maps live in `lib/enums.js` (`SPEC_NODE_FOR_TYPE`, `EXT_FOR_SPEC_TYPE`).
They are maps rather than ternaries on purpose: the staffing app derives the
extension with `type === 'e360' ? '.e360' : '.nsf'` in two places, which is why
a PowerSpec bind there tells the user it attached a `.nsf`.

**`flex_state`** *(unique `show_id`)* — `id · show_id · linked · pulled · element_id · gear_list_id · gear_list_type · doc_number · updated_at`

**`proofs`** / **`proof_rounds`** *(idx: `show_id` / `proof_id`)* — the print proof chain.

### Money

**`expenses`** *(idx: `show_id`, `(job_id, status)`, `po_id`)*
`id · show_id · project_id · job_id · budget_line_category · category · vendor · amount NUMERIC(12,2) · txn_date · status · file_id · by · memo · po_id · match_confidence · match_reason · evidence_ref · provenance JSONB · source_ref · created_at`
`by` is *who to chase*. `po_id` traces a PO-generated actual to its order **and
excludes it from the exceptions scan** — the PO carries that exception, never
both.

**`budget_lines`** *(idx: `job_id`)* — `id · job_id · category · allotted · notes · created_at · created_by · updated_at · updated_by`
Every change also writes an `activity` row (`budget.line.add/update/delete`),
which is what the finance feed reads for budget events.

**`bookings`** *(idx: `show_id`, `(status, file_id)`)* — `id · show_id · job_id · category · vendor · status · amount · booked_date · file_id · confirmation_number · notes · created_at`

**`purchase_orders`** *(idx: `status`, `project_id`, unique `po_number`)*
`id · po_number · vendor · project_id · job_id · status · created_by · ordered_date · expected_date · received_date · approval JSONB · provenance JSONB · source_ref · memo · tracking · quote_file_id · invoice_file_id · created_at · updated_at`

**`po_lines`** *(idx: `po_id`, `job_id`)* — `id · po_id · item · detail · qty · unit_cost · category · job_id · show_id · ownership · expense_id · created_at`

> **The budget mechanic.** `ordered`/`shipped` = **committed**; `received` =
> **actual**. `cogs` lines ride the job budget between allotted and actual and
> generate `expenses` rows on receive; `inventory` lines are **E360 capex** and
> are never a job cost. `ownership` derives from the resolved job's `deal_type`
> (a *sale* is COGS, a *rental* keeps the gear).

> **The approval gate (punch 28, Tom 2026-08-21).** A PO whose total exceeds
> `config.po_approval_threshold` (default **5000**) cannot advance
> `quoted → ordered` without `approval.approved_by`. **Approvers = the admins
> (Tom/Tony/Jim) + Candice's finance capability** — `canApprovePO()` is
> `role==='admin' || finance===true`. Not manager+.

### Conversation

**`notes`** *(idx: `(anchor_type, anchor_id)`, `parent_id`, `project_id`, `show_id`)*
`id · anchor_type · anchor_id · project_id · show_id · author · body · parent_id · mentions TEXT[] · created_at · edited_at · provenance JSONB · source_ref`
`author` accepts `agent:<username>`. **One level of replies**: replying to a
reply re-anchors to the thread root. Mentions are parsed **server-side** on
every write and re-parsed on every edit. Edit is **author-only**, and an
agent-authored note is **immutable to humans**.

**`note_reads`** *(unique `(note_id, username)`)* — read state.
**`note_mentions`** *(unique `(note_id, username)`, idx `username`)* — the mention **fact**, deliberately separate from read state.

> Activity rows for notes carry the **mention list**, never the body.

### Run of show

**`schedule_items`** *(idx: `show_id`)* — `id · show_id · day · start_time · end_time · title · detail · who JSONB · location · kind · created_at · updated_at`
`who` is `"all"`, a `["username"]` array, or a role slug.

**`crew_assignments`** *(idx: `show_id`)* — `id · show_id · username · name · phone · role_on_site · call_time · travel JSONB · created_at`
`travel` mirrors the staffing app's `travel_info` shape (INTEGRATION.md B.6)
1:1 so the future read-back swaps in without reshaping.

### Deliverables

**`deliverables`** *(idx: `(show_id, kind)`)* — `id · project_id · show_id · kind · status · body JSONB · generated_by · generated_at · edited_by · edited_at · approved_by · approved_at · sent_at · sent_to · provenance JSONB`
`kind` is the extension point (`recap` now; `call_sheet`/`photo_set` later).
`body` = `{headline, narrative[], highlights[], stats[{key,label,value}], photo_ids[], closing}`.

**`recap_stat_keys`** — `key · label · sort_order`. Stats carry a client-safe
key **by FK, not by regex**.

**`tech_reports`** (F2) *(unique `(show_id, username)`; idx: `(username, status)`, `show_id`)*
`id · show_id · project_id · username · crew_assignment_id · role_on_site · status · body TEXT · file_id · due_date · requested_at · filed_at · reviewed_by · reviewed_at · last_nagged_at · nag_count · created_at · updated_at`

> **Why a dedicated table rather than a `deliverables` kind.** Three reasons, and
> the first is the important one:
>
> 1. **The firewall.** A recap is the one artifact that leaves the building, and
>    TEAM_FEEDBACK is explicit that its generator must never read a report body.
>    Inside `deliverables` that would be a promise a future `SELECT` could break;
>    in its own table it is a **topology fact** — the same argument this codebase
>    already makes for `/api/agent/*` — and `lib/firewall.js guardRecapQuery()`
>    now enforces it at runtime by throwing on any SQL that names the table.
> 2. **Shape.** A report is per-PERSON and REQUIRED. `deliverables` has no
>    username column and carries a draft/approved/sent lifecycle that is wrong
>    here: **sign-off is NOT required** (Tom, 2026-08-27).
> 3. **Nagging.** "Who still owes theirs" is a join against `crew_assignments`
>    keyed on `(show, person)` — a UNIQUE INDEX here, unenforceable in a shared
>    kind-discriminated table.
>
> Only crew with a **login** owe one: a local hire recorded by name has nobody to
> ask, which is exactly the gap between the crew count and the report count.
> An uploaded doc is a `files` row of kind `report`; an in-app write becomes one
> too, so both forms land in the event folder's Files.

**`notification_outbox`** (F3) *(idx: `(username, status)`, `(status, mode)`, `note_id`, `show_id`)*
`id · username · kind · mode · status · subject · body · link · note_id · project_id · show_id · actor · driver · attempts · last_error · skipped_reason · queued_at · sent_at`

> The **bell is unchanged and stays primary**; this is the SECOND channel, and
> nothing here can suppress a bell notification. `note_id` is what makes
> **skip-if-read-in-app** possible: the flush joins `note_reads` and marks the
> row `skipped` rather than mailing somebody about a thing they already read.
> A **retryable** driver refusal (the unconfigured `graph` driver) leaves the row
> `queued` — the difference between "not yet" and "never".
>
> **The digest** is literally one open `kind='digest'` row per person, whose
> subject counts what is waiting behind it. **HONEST TODO: nothing in this app
> runs on a timer.** Immediate rows flush on the boot/admin sweep; digest rows
> flush only when a caller asks explicitly (`POST /api/admin/notifications/flush`
> with `{digest:true}`). A real daily digest needs Railway cron or the per-user
> agents of `ARCHITECTURE.md`, and this app will not fake one with `setInterval`
> and hope the dyno stays up.

**`notification_prefs`** (F3) *(unique `(username, kind)`)* — `id · username · kind · mode · updated_at`

> **Deviations only.** A user who never opens Settings has no row here and gets
> the house default: assignments and @mentions immediately, everything else
> digested (Tom's rule). Writing the house default **removes** the row, so a
> later change to the defaults reaches everyone who never expressed an opinion.

> **Nothing sends anything.** `POST /api/recaps/:id/sent` records that a *human*
> sent it. There is no outbound path in this app, for people or agents.

### Identity, agents, audit

**`users`** — `id · username (unique) · password_hash · pw_algo · role · name · initials · color · title · discipline · phone · email · finance BOOL · active BOOL · created_at`
Passwords are **bcrypt**; a legacy `sha256+salt` hash still verifies and is
re-hashed in place on the next successful login. `finance` is a **capability,
not a rank**: it grants margin visibility and PO approval without changing role.

**`sessions`** *(idx: `user_id`, `expires_at`)* — `token PK · user_id · username · created_at · expires_at · last_seen_at · ip`
Durable: sessions survive a redeploy. Role and capabilities are read **live from
`users`** on every request, never copied onto the session.

**`api_keys`** *(idx: `user_id`, unique `key_hash`)* — `id · user_id · username · label · key_prefix · key_hash · scopes TEXT[] · created_at · created_by · revoked_at · last_used_at · last_used_ip`
Keys are **revoked, never deleted**, and the key itself is returned exactly once.

**`proposals`** *(idx: `assigned_to`, `status`, `show_id`, `project_id`)*
`id · kind · status · proposed_by · assigned_to · project_id · show_id · job_id · payload JSONB · provenance JSONB · confidence · resolved_by · resolved_at · resolve_reason · created_rows JSONB · created_at`
One generic table with a payload, not a table per type. Pending proposals older
than 30 days are expired by the housekeeping pass.

**`agent_idempotency`** *(unique `(username, key)`)* — `id · key · username · endpoint · body_hash · response JSONB · created_at`
Scoped **per user**; retained 90 days. The ledger row is **committed before the
response is sent**, so a tight retry cannot beat it and double-file. Two
genuinely *concurrent* requests on one key are not serialised — see the note in
`lib/agent.js`.

**`activity`** *(idx: `project_id`, `show_id`, `po_id`)* — `id · project_id · show_id · po_id · job_id · actor · action · detail · accent BOOL · provenance JSONB · created_at`
`actor` accepts `agent:<username>` (the UI renders "Tom's agent"). `provenance`
lets the feed render *"filed by Tom's agent from email 'Re: LOVB invoices' —
93% (client, date, vendor history)"* with a link back to the source.

**`config`** — `key PK · value · updated_at · updated_by`. Currently
`po_approval_threshold` (default `5000`).

---

## F5 · the commercial lifecycle (additive, and provably so)

Tom-confirmed 2026-08-27:
`quoted -> confirmed -> in_progress -> delivered -> closed -> archived`.

**Nothing migrates.** `STAGES` is the legacy five PLUS the six lifecycle values,
so every stage string already in the database is still a legal value and no row
is ever rewritten. `STAGE_ALIAS` maps a legacy value onto its lifecycle POSITION
so a chip, a timeline and the push gate can *order* an old row without touching
it — a display/ordering concern and nothing more:

| stored | reads as | position |
|---|---|---|
| `lead` | "Sales" | `quoted` |
| `planning` | "Planning" | `confirmed` |
| `ready` | "Ready" | `confirmed` |
| `scheduled` | "Scheduled" | `in_progress` |
| `closed` | "Closed" | `closed` |

An unknown string degrades to `quoted` — the least-committed position — rather
than throwing out of a renderer.

**The CONFIRM FACT is `shows.confirmed_at`, never the stage string.** A legacy
row therefore reads as *confirmed by position, with no datestamp*, which is the
truth about it; only the explicit Confirm action writes a datestamp.
`isConfirmed(row)` = an explicit `confirmed_at` **OR** a stage at/after
`confirmed` — and that second clause is exactly what keeps every pre-existing
`planning`/`ready`/`scheduled`/`closed` show pushable with no migration.

**The push gate** sits on the LIVE path only. A dry run sends nothing and its
whole job is to tell you what is wrong before you commit, so it still runs and
reports "not confirmed" among its `problems`; the live push is the one that
answers 409.

---

## F6 · closeout + archiving

`closeoutStatus(showId)` answers three questions with SQL, never with a flag
somebody remembered to tick:

1. **recap sent** — a `deliverables` row of kind `recap` at status `sent`
2. **every tech report filed** — no `tech_reports` row still `owed` (a show with
   no crew owes nothing and passes trivially)
3. **no open money exception ON THIS SHOW** — the SHOW-SCOPED subset of
   `financeExceptions()`. That scan also reports show-less rows (a PO with no
   show, a job still on a TEMP number), and a folder-wide accounting problem must
   not hold one city's show hostage.

`closeout_complete_at` is stamped the first time all three hold, and **CLEARED
again if the state regresses** — a late expense un-completes a closeout, and the
60-day clock should not keep running against paperwork that came undone.

`ARCHIVE_AFTER_DAYS` (60) after that stamp, the sweep archives the show; a folder
archives when every show inside it is. **Archived is out of the working set, not
out of the app**: list routes exclude it by default, `GET /api/{shows,projects}/:id`
always resolves (deep links and search still open it), and a folder's own show
list keeps every show it ever had — which is what leaves season rollups unaffected.

**No cron.** `sweep()` runs once on boot and on `POST /api/admin/sweep`. It is
idempotent, so both paths are safe to repeat. A real daily job needs Railway cron
or the per-user agents of `ARCHITECTURE.md`; this app does not fake one.

---

## Delete cascades (manual, transaction-wrapped, `lib/db.js`)

| Entry point | Reaches |
|---|---|
| `deletePoCascade(poId)` | po-anchored `notes` (+ their reads/mentions), `po_lines`, `activity`, nulls `expenses.po_id`, the PO |
| `deleteShowCascade(showId)` | notes anchored on the show and on its steps/files/expenses (+ reads/mentions), `proofs`, `proof_rounds`, `steps`, `files`, `expenses`, `bookings`, `schedule_items`, `crew_assignments`, `deliverables`, `milestones`, `spec_chain`, `spec_renders`, `flex_state`, `proposals`, **`tech_reports`**, **`notification_outbox`**, `activity`, nulls `po_lines.show_id`, the show |
| `deleteProjectCascade(projectId)` | every show (via the show cascade), every PO (via the PO cascade), job- and project-anchored notes, `budget_lines`, `jobs`, project-level `steps`/`files`/`expenses`/`milestones`/`deliverables`/`proposals`/**`tech_reports`**/**`notification_outbox`**, `activity`, the project |
| `DELETE /api/files/:id` (single file, `routes/files.js`) | file-anchored `notes` (+ reads/mentions), **`spec_renders` by `file_id`**, nulls `expenses.file_id` / `bookings.file_id` / `purchase_orders.quote_file_id` / `.invoice_file_id`, the file. The NAS bytes are left on disk deliberately. `spec_renders` was added in the 2026-08-27 hardening pass: `spec_renders.file_id` is `NOT NULL`, so a render cannot be orphaned the way a nullable FK can — it goes with the file or it is a dangling row |

The smoke test builds a folder carrying a child of **every** one of these tables,
deletes it, and asserts **zero orphans** in all 26.

---

## API surface (192 routes)

Human routes return **snake_case** records matching `public/data.js`; agent
routes speak **camelCase** per `AGENT_API.md`. Request bodies accept **both**
spellings everywhere. Success is always `200` — there is no `201`/`204`.

```
Meta        GET /api/version · GET /api/health
Auth        POST /api/auth/login · POST /api/auth/logout · GET /api/auth/me
Users       GET /api/users (any) · GET /api/users/:idOrUsername · POST /api/users (admin)
            PUT /api/users/:id · PUT /api/users/:id/role · PUT /api/users/:id/finance
            PUT /api/users/:id/password · DELETE /api/users/:id
Keys        GET/POST /api/keys · DELETE /api/keys/:id            (session only)
Projects    GET /api/projects · GET /api/projects/:id · GET /api/projects/:id/folder
            POST /api/projects · PUT/DELETE /api/projects/:id
Shows       GET /api/shows · GET /api/shows/:id · POST /api/shows · PUT/DELETE /api/shows/:id
            GET/POST /api/shows/:id/milestones · DELETE /api/milestones/:id
Steps       GET /api/steps · GET /api/steps/:id · GET /api/my-steps · POST /api/steps
            PUT /api/steps/:id · /assign · /status · DELETE /api/steps/:id
Templates   GET /api/templates · GET /api/templates/:idOrType · GET /api/event-types
            POST /api/templates · POST /api/shows/:id/instantiate-template
Files       GET /api/files · GET /api/files/:id · POST /api/files
            PUT /api/files/:id · PUT /api/files/:id/content · DELETE /api/files/:id
Chain/Gear  GET/PUT /api/shows/:id/chain[/:node] · GET/PUT /api/shows/:id/gear
Bookings    GET /api/bookings[/:id] · POST /api/bookings · PUT/DELETE /api/bookings/:id
Proofs      GET /api/proofs · POST /api/proofs · POST /api/proofs/:id/rounds
            PUT/DELETE /api/proofs/:id
Jobs        GET /api/jobs[/:id] · POST /api/jobs · PUT/DELETE /api/jobs/:id
Budget      GET/POST /api/jobs/:id/budget · PUT/DELETE /api/budget-lines/:id
Expenses    GET /api/expenses · POST /api/expenses · PUT/DELETE /api/expenses/:id
Finance     GET /api/jobs/:id/finance · /committed · GET /api/finance/{feed,exceptions,stats,overview}
Purchasing  GET /api/pos[/:id] · GET /api/purchasing/overview · GET /api/procurement/risks
            GET /api/shows/:id/procurement-risks · POST /api/pos · POST /api/pos/:id/lines
            PUT/DELETE /api/pos/:id/lines/:lineId · PUT /api/pos/:id/status
            POST /api/pos/:id/approve · PUT/DELETE /api/pos/:id
            GET/PUT /api/config/po-approval-threshold
Notes       GET /api/notes · GET /api/notes/:id · GET /api/notes/count/:type/:id
            POST /api/notes · PUT/DELETE /api/notes/:id
Inbox       GET /api/me/inbox · GET /api/me/inbox/count · POST /api/me/inbox/read
Schedule    GET /api/shows/:id/call-sheet   (the assembled sheet — CANONICAL)
            GET /api/shows/:id/run-of-show  (retained alias, same handler)
            GET/POST /api/shows/:id/schedule   (the schedule ITEMS — a different
                                                resource: list · create)
            PUT/DELETE /api/schedule/:id · GET/POST /api/shows/:id/crew
            PUT/DELETE /api/crew/:id · PUT /api/shows/:id/call-sheet · GET /api/shows/:id/travel
Photos      GET /api/shows/:id/photos · GET /api/photos[/:id] · GET /api/shows/:id/photo-facets
            GET /api/shows/:id/recap-picks · POST /api/shows/:id/photos
            PUT /api/photos/:id · /pick · /content · PATCH /api/photos/:id/thumb
Deliverabl. GET /api/shows/:id/deliverables · GET /api/shows/:id/recap
            POST /api/shows/:id/recap · PUT /api/recaps/:id (or /shows/:id/recap)
            POST /api/recaps/:id/{approve,reopen,sent} (+ /shows/:id/recap/… aliases)
            GET /api/me/recaps-awaiting-review · GET /api/recap-stat-keys
Proposals   GET /api/proposals[/:id] · GET /api/files/:id/proposal
            POST /api/proposals/:id/confirm · /reject                (session only)
Activity    GET /api/activity
Push        POST /api/shows/:id/push-to-scheduler        (dry run; live = 501,
            and REFUSED with 409 pre-confirm — the dry run still runs and says why)

── the first post-deploy release ────────────────────────────────────────────
Events      POST /api/events                             (F1 · pm+ · folder + job
            + show + lanes + ONE notify, in one transaction)
Stages      GET  /api/stages                             (F5 · the vocabulary +
            the legacy alias map, so the SPA hardcodes neither)
Scope       GET  /api/shows/:id/scope                    (F4 · + the bound spec
            and any divergence QUESTIONS)
            PUT  /api/shows/:id/scope                    (pm+ on the folder)
            POST /api/shows/:id/scope/from-spec          (auto-fill, stack-aware)
Lifecycle   POST /api/shows/:id/confirm                  (F5 · admin/manager, or
            the pm who owns the show or its folder. 409 if already confirmed)
            POST /api/shows/:id/struck                   (F2 · pm+ · creates the
            reports the crew owes and nags them)
Closeout    GET  /api/shows/:id/closeout                 (F6 · machine-checked;
            reading it SYNCS the marker, so the number and the clock agree)
Archive     POST /api/shows/:id/{archive,unarchive}      (F6 · ADMIN only)
            POST /api/projects/:id/{archive,unarchive}   (F6 · ADMIN only)
            GET  /api/projects?archived=1                (the Archive view)
            GET  /api/{projects,shows}?include_archived=1
Reports     GET  /api/shows/:id/tech-reports             (F2 · pm+ sees all +
            the waiting-on names; a tech sees only their own row)
            GET  /api/tech-reports/:id                   (own, or pm+)
            GET  /api/me/reports                         (the My Tasks nag)
            POST /api/shows/:id/tech-report              (file MINE)
            PUT  /api/tech-reports/:id                   (revise MINE — a pm
            may read, nag and review, but never WRITE somebody else's)
            POST /api/tech-reports/:id/{review,reopen}   (pm+ · OPTIONAL)
            POST /api/shows/:id/tech-reports/nag         (pm+ on the folder)
Notify      GET  /api/notification-kinds
            GET/PUT /api/me/notification-prefs           (F3 · your own only)
            GET  /api/me/notifications                   (your own queue)
            GET  /api/admin/notification-outbox          (admin)
            GET  /api/admin/mail-status                  (admin)
            POST /api/admin/notifications/flush          (admin; {digest:true})
            POST /api/admin/sweep                        (admin · F2+F6, and the
            honest answer to "no cron": boot + on demand, idempotent)

Agent       GET  /api/agent/whoami
            POST /api/agent/match
            GET  /api/agent/shows/:id/context · GET /api/agent/shows
            POST /api/agent/documents · PUT /api/agent/documents/:id/content
            POST /api/agent/tasks:batch · POST /api/agent/projects
            POST /api/agent/notes · POST /api/agent/purchase-requests
            GET  /api/agent/proposals[/:id]              (key OR session)
            ALL  /api/agent/*  ->  404 terminal guard
```

### `public/api.js` → REST, for the swap pass

Every mock method maps to exactly one call. Responses already come back in the
shape `api.js` returns, so each body becomes `return fetch(...).then(r => r.json())`.

| `api.*` | Endpoint |
|---|---|
| `currentUser()` | `GET /api/auth/me` → `.user` |
| `listUsers()` / `getUser(u)` | `GET /api/users` / `GET /api/users/:u` |
| `listProjects()` / `getProject(id)` | `GET /api/projects` / `GET /api/projects/:id` |
| `resolveFolder(pid)` | `GET /api/projects/:id/folder` |
| `listShows(pid)` / `getShow(id)` | `GET /api/shows?project_id=` / `GET /api/shows/:id` |
| `listJobs(pid)` / `getJob(id)` | `GET /api/jobs?project_id=` / `GET /api/jobs/:id` |
| `resolveJob(item, show)` | *stays client-side* — `item.job_id ?? show.default_job_id` |
| `listSteps(sid)` / `getStep(id)` | `GET /api/steps?show_id=` / `GET /api/steps/:id` |
| `updateStep` / `setStepStatus` / `assignStep` | `PUT /api/steps/:id` · `/status` · `/assign` |
| `myOpenSteps(u)` | `GET /api/my-steps[?username=]` |
| `listFiles` / `getFile` / `addFile` | `GET /api/files?show_id=` · `GET /api/files/:id` · `POST /api/files` |
| `replaceChainFile(sid, key, body)` | `POST /api/files` with `{chain_key, replace_chain:true}` |
| `listBookings` / `getBooking` | `GET /api/bookings?show_id=` / `:id` |
| `listProofs(sid)` | `GET /api/proofs?show_id=` |
| `listActivity(sid)` | `GET /api/activity?show_id=` |
| `getChain` / `updateChainNode` | `GET /api/shows/:id/chain` · `PUT /api/shows/:id/chain/:node` |
| `getGear` / `updateGear` | `GET`/`PUT /api/shows/:id/gear` |
| `listTemplates` / `getTemplate(type)` | `GET /api/templates` / `GET /api/templates/:type` |
| `pushToScheduler(sid)` | `POST /api/shows/:id/push-to-scheduler` |
| `listBudgetLines(jid)` | `GET /api/jobs/:id/budget` |
| `listExpenses(sid)` / `addExpense` | `GET /api/expenses?show_id=` / `POST /api/expenses` |
| `getJobFinance` / `listFinanceFeed` / `listExceptions` / `getFinanceStats` / `getFinanceOverview` | `GET /api/jobs/:id/finance` · `/api/finance/feed` · `/exceptions` · `/stats` · `/overview` |
| `addFinancialDoc(sid, body)` | `POST /api/files` (pass `amount`/`vendor`, or `expense_id`/`booking_id`/`po_id`) |
| `confirmDoc` / `rejectDoc` | `POST /api/proposals/:proposalId/confirm` · `/reject` **(id is the PROPOSAL, not the file)** |
| `listPOs` / `getPO` / `getPurchasingOverview` | `GET /api/pos` · `/api/pos/:id` · `/api/purchasing/overview` |
| `listProcurementRisks` / `listCommitted` | `GET /api/procurement/risks` · `GET /api/jobs/:id/committed` |
| `createPO` / `addPOLine` / `updatePOStatus` / `approvePO` | `POST /api/pos` · `POST /api/pos/:id/lines` · `PUT /api/pos/:id/status` · `POST /api/pos/:id/approve` |
| `listNotes(t, id)` / `addNote` / `editNote` | `GET /api/notes?anchor_type=&anchor_id=` · `POST /api/notes` · `PUT /api/notes/:id` |
| `myInbox` / `markNotesRead` / `markAllNotesRead` / `notesUnreadCount` | `GET /api/me/inbox` · `POST /api/me/inbox/read {ids}` · `{all:true}` · `GET /api/me/inbox/count` |
| `getSchedule` / `addScheduleItem` / `updateScheduleItem` / `removeScheduleItem` | `GET /api/shows/:id/call-sheet` (alias `/run-of-show`) · `POST /api/shows/:id/schedule` · `PUT`/`DELETE /api/schedule/:id` |
| `listPhotos` / `listAllPhotos` / `updatePhoto` / `setRecapPick` | `GET /api/shows/:id/photos` · `GET /api/photos` · `PUT /api/photos/:id` · `/pick` |
| `confirmPhoto` / `rejectPhoto` | same proposal routes as `confirmDoc`/`rejectDoc` |
| `getDeliverables` / `getRecap` / `generateRecap` / `updateRecap` | `GET /api/shows/:id/deliverables` · `/recap` · `POST /api/shows/:id/recap` · `PUT /api/shows/:id/recap` |
| `approveRecap` / `reopenRecap` / `markSent` | `POST /api/shows/:id/recap/{approve,reopen,sent}` |
| `reorderRecapPhoto` / `removeRecapPhoto` / `addRecapPhoto` | *stay client-side* — they compose `updateRecap({photo_ids})` |
| **F1** `createEvent(payload)` | `POST /api/events` — one call, one transaction, one notify |
| **F4** `getScope` / `setScope` / `scopeFromSpec` | `GET`/`PUT /api/shows/:id/scope` · `POST /api/shows/:id/scope/from-spec` |
| **F5** `confirmShow(sid)` | `POST /api/shows/:id/confirm` |
| **F2** `markStruck(sid)` | `POST /api/shows/:id/struck` |
| **F2** `listTechReports` / `getTechReport` / `myReports` | `GET /api/shows/:id/tech-reports` · `GET /api/tech-reports/:id` · `GET /api/me/reports` |
| **F2** `fileTechReport` / `reviewTechReport` / `reopenTechReport` / `nagTechReports` | `POST /api/shows/:id/tech-report` · `POST /api/tech-reports/:id/{review,reopen}` · `POST /api/shows/:id/tech-reports/nag` |
| **F3** `notificationPrefs` / `setNotificationPrefs` | `GET`/`PUT /api/me/notification-prefs` |
| **F3** `myNotifications` / `mailStatus` / `flushNotifications` | `GET /api/me/notifications` · `GET /api/admin/mail-status` · `POST /api/admin/notifications/flush` |
| **F6** `getCloseout(sid)` | `GET /api/shows/:id/closeout` |
| **F6** `archiveShow` / `unarchiveShow` / `archiveProject` / `unarchiveProject` | `POST /api/{shows,projects}/:id/{archive,unarchive}` |
| **F6** `listArchivedProjects()` | `GET /api/projects?archived=1` |
| **F6** `sweep()` | `POST /api/admin/sweep` |

**Two signature deviations worth knowing:**
1. `confirmDoc(fileId)` / `rejectDoc(fileId)` take a **file id** in the mock; the
   server resolves a **proposal id**. `GET /api/files/:id/proposal` exists
   precisely for that hop, so the swap is two lines rather than a refactor.
2. `getTemplate(type)` keys by event type; the REST route accepts a type **or**
   a numeric id.
3. **F2/F3 read-through cache.** `tech_reports` and `notification_outbox` rows
   are absorbed into `TECH_REPORTS` / `NOTIF_OUTBOX` by `SR.absorb.report` and
   `SR.absorb.notification`, because the Reports tab, its badge and the
   "waiting on" line all read those flat stores **synchronously** — exactly the
   way every other renderer reads `SHOWS_BY_ID`. A server row has to land where
   a demo row does, or the tab renders an empty state against a populated
   server. Both stores are cleared by `resetStore()` on login, or the demo
   fixture would leak into a real session.

### Route topology is the guardrail

Mount order in `server.js` is load-bearing: `routes/auth` (the only
unauthenticated endpoints) → `routes/agent` at `/api/agent` → **`routes/photos`**
→ everything else → a terminal `/api` 404. `requireAuth` **rejects
`x-agent-key` outright**, and the agent router ends in its own 404, so nothing
under `/api/agent/*` can fall through onto the human surface — and no new human
endpoint is ever accidentally agent-reachable.

**Why `routes/photos` is third.** Several routers call `router.use(requireAuth)`,
which runs for **every** `/api/*` request that reaches them — including requests
destined for a router mounted later. `PATCH /api/photos/:id/thumb` is the one
route with a non-session credential (the NAS thumbnailer's
`x-thumbnailer-token`), and with photos mounted ninth, six blanket-auth routers
answered that daemon **401** before `routes/photos` ever saw it: the route was
unreachable in production. The rule this establishes: **a router that accepts a
non-session credential must be mounted above every router that calls
`router.use(requireAuth)`.** `routes/purchasing` and `routes/deliverables`
authenticate per-route for the same family of reasons and say so in their
headers.

### Roles & capabilities

| | |
|---|---|
| `viewer` | read-only |
| `tech` | read-only **plus** status/notes on steps they own |
| `pm` | create/edit projects & shows they own; assign; edit steps/files/expenses on their projects |
| `manager` | all of the above across **all** projects |
| `admin` | everything, plus user management and server config |
| **`finance` capability** | **not a rank.** Grants margin/profitability visibility and PO approval. Tom/Tony/Jim are admins; Candice carries the flag. |

**Margin visibility (Tom, 2026-08-27):** `admin ‖ finance` — the same predicate
shape as PO approval. A manager without the flag does not see margin. Budgets,
burn and committed stay visible to everyone. Gated fields are **stripped from
the payload**, not zeroed.

The stripped set is `margin` · `marginPct` · `billed` · **`contract_value`**
(`MONEY_FIELDS` / `stripMoney()` in `lib/mappers.js`). `contract_value` joined
that list in the 2026-08-27 hardening pass: because costs are visible to
everyone by design, the contract value was the only missing term — anyone
holding it could derive the margin by subtraction, which made stripping
`margin` decorative. The strip **recurses into `job` / `jobs[]`**, since a job
rides inside `GET /projects/:id`, `GET /shows/:id`, `GET /jobs/:id/finance` and
the finance overview; a top-level-only strip was how it escaped.

**Closeout ownership (Tom, 2026-08-27; floor added in the hardening pass):**
drafting, editing, approving, reopening and recording a send on a client recap
all ask ONE predicate — `canApproveRecap()` in `lib/auth.js`: **`manager+` OR
the SHOW's own owner, where that owner is `pm` or above.** The `pm+` floor
originally sat only on the draft path, which let a tech who owned a show approve
a recap he was forbidden to write. The hardening call was to add the floor to
approve rather than drop it from draft (tighter; a tech-owned show is unusual
and manager/admin cover it) — **Tom-reversible in two lines**, `lib/auth.js`
`canApproveRecap()` and its mirror `canApproveRecapFor()` in `public/data.js`.
The bell badge (`GET /me/inbox/count`) evaluates the same JS predicate per row
rather than recompiling it as SQL, so the badge and the Approve button cannot
disagree. **Deliberately NOT the same owner as the schedule gate**, which keys
to the FOLDER (`canEditProject`) — two questions, two answers, pinned from both
directions by split-owner fixtures in the smoke and API suites.

**Notification principle (Tony):** mutating routes accept an optional
`notify: ["username", …]`; it lands as an anchored note + mention rows and shows
up in the target's bell. Routine edits stay silent; it is never forced; an
unknown username is a **400**, never a silent drop. One implementation —
`notifyTargets()` in `lib/mentions.js`.

That "one implementation" became true in the 2026-08-27 hardening pass; before
it there were **four** (here, plus `notifyFrom` in purchasing, `deliverNotify`
in schedule, `applyNotify` in photos), and they disagreed on every axis. The
unified answers: absent → silent · a comma-separated string → accepted · any
other non-array → **400** · an unknown name → **400 naming it** · the actor's
own name → **dropped** (`agent:` prefix stripped first, so an agent notifying
its own user is dropped too). What stayed per-family is only where the note
anchors and how its one line reads (the `format` parameter).

Implemented on: projects · shows · schedule · crew · call-sheet · photos ·
purchasing · **files · expenses · spec-chain bind · proposal confirm**.

**Naming (POLISH_LIST #1):** "run of show" is **reserved** for the future
what-plays-when document. This feature is the **Schedule**; its printable is the
**Call Sheet**. No string a person reads may say "run of show" — not an activity
action, not a notify summary, not an error message.

The assembled sheet is served from **`GET /api/shows/:id/call-sheet`**, which is
the canonical path and pairs with the `PUT /api/shows/:id/call-sheet` that edits
its header fields. **`GET /api/shows/:id/run-of-show` is retained as an alias on
the same handler** so nothing already pointing at it breaks; `public/api.js`
`getSchedule()` calls the canonical name. The rename could not reuse
`/api/shows/:id/schedule` — that path is the schedule **items** collection
(GET list · POST create) and is a different resource.

---

## Push-to-scheduler field mapping

`POST /api/shows/:id/push-to-scheduler` maps a Showrunner **show** onto the
staffing app (`e360-staffing3`). Source of truth: `buildSchedulerPayloads()` in
**`lib/scheduler.js`** — one builder feeds both the dry run and the live push, so
they cannot drift.

**Auth is programmatic login, not a token.** The staffing app has no API-key
path and no service-credential mechanism: sessions are an in-memory `Map` with a
12 h TTL, wiped on every redeploy, so a static token is dead within hours.
Showrunner logs in as `SCHEDULER_USER`/`SCHEDULER_PASS`, caches the token for
11 h, and **retries once on 401** — which is what a redeploy looks like from
here. `SCHEDULER_API_TOKEN` is **retired**; do not reintroduce it.

### 1. Show → staffing `POST /api/events`

| Staffing field | Source |
|---|---|
| `event` | `show.name` (falls back to `project.name`) |
| `eventDate` | `show.event_date` — **omitted when empty**, because `''` is stored as an empty string, not NULL, and sorts before real dates |
| `setup` / `breakdown` | `show.load_in_date` / `show.strike_date` |
| `setupTime` / `eventTime` | `show.load_in_time` / `show.event_time` (the call-sheet header) |
| `location` | `show.venue` |
| `staff[]` | crew-lane step owners (status ≠ `na`) + `crew_assignments`, **resolved to canonical staffing roster names** |
| `notes` | `project.description` |
| `clientId` | resolved live from staffing `/api/clients` by `project.client`; a `400 already exists` means re-GET and match, not fail |
| `eventType` | `project.type` → `LED` / `Print` / `Both` |
| `shipOutDate` / `shipReturnDate` / `noShipOut` / `noShipReturn` | `''` / `false` — Showrunner has no ship dates |
| `mediaServer`, `techNotes`, `archived` | **never sent.** On create staffing applies its own defaults; on update the push read-modify-writes, so an operator's typing survives |
| the five legacy `clientContact*` fields | **never sent.** Company-only is inert clutter that staffing's boot-time backfill can resurrect as a duplicate contact. The multi-row `client_contacts` table is the live one |

### 2. `logistics` lane → `POST /api/bookings`

`category` is a **closed 7-key enum** — `trucking` · `forklift` · `feeder_cable` ·
`install_labor` · `strike_labor` · `hotel` · `other`. The DB column is free text,
but **every render path in staffing filters `b.category === cat.key`**, so a
value outside these seven is stored and then invisible in the UI and excluded
from the booked/needed totals. `hotel` must be **lowercase**: the tech-packet
builder tests `b.category === 'hotel'` twice — once to keep hotels out of the
shared vendor list, once to collect them as per-person lodging.

Derivation order is load-bearing: `hotel` first (so "hotel block for the install
crew" is not labor), then `strike_labor` **before** `install_labor` (both match
`/labor/`). `status` is `booked` when the step is done, else `needed` — the only
two states staffing has. `quantity` is the **string** `"1"` (the column is
`TEXT`). `vendorName` is left empty and the step's `evidence_ref` rides in
`notes`, because `evidence_ref` is a free-text evidence pointer (a URL, a doc
link), not a vendor, and it renders as the vendor in tech packets.

### 3–4. Contacts

- `venue` lane → `POST /api/venue-contacts`; `show.on_site_poc` is contact #1,
  `show.venue_poc` is contact #2.
- `client` lane → `POST /api/client-contacts`, with `show.client_poc` first.

### 5. Travel → `POST /api/travel`

An **upsert on `travel_key`**, one call per person per leg, built from
`crew_assignments.travel`. `travel_info` has **no `event_id`** — the event
linkage is encoded entirely in the key string, and there are **three legal
forms**:

| Form | Meaning |
|---|---|
| `Name\|prevEventId\|nextEventId` | one leg serving **both** events |
| `Name\|eventId\|inbound` | arrival when there is no previous event |
| `Name\|eventId\|outbound` | departure when there is no next event |

**The two sentinels are mandatory.** Note the asymmetry: both put the event id in
position 1. Writing an empty third segment stores a row that the staffing UI will
never look up, because its own lookup constructs the `outbound` form for that
case. `person` must be the **canonical roster name** — the packet builder
lowercases and trims it, then matches the roster map.

### Pre-flight validation — the push REFUSES rather than writing junk

`POST /api/events` performs no validation whatsoever; a missing `event` comes
back as a raw Postgres message inside a 500. So the push checks first and
answers **422** with the reasons:

- no show name (the column is `NOT NULL`);
- **no load-in date** — staffing derives the Flex folder start from
  `(shipOutDate || setup)` and throws when both are falsy, surfacing as an
  opaque 502 from `/flex/create-element`;
- **any crew name that does not match the staffing roster.** A miss silently
  yields no email, no colour chip and no tech packet, so a ghost is worse than a
  refusal.

### Idempotency — children are DELETE-then-INSERT

Staffing has no upsert and no delete-first on the child tables, so an
unconditional POST appends a second full set on every `{force:true}`. It also has
**no `source` column**, so Showrunner cannot tell its own rows from ones an
operator typed. The fix needs no staffing change: Showrunner records the ids it
created in **`shows.pushed_child_ids`** and deletes **only those** before
re-inserting. Rows a human added survive a re-push untouched. Travel needs no
delete — it is an upsert by construction.

**No transaction crosses the wire.** Each HTTP call is its own commit, so the
fan-out is **resumable, not atomic**: `scheduler_event_id` is persisted the
moment the event exists, so a retry updates instead of duplicating.

### Modes

- **Dry run (default):** returns every payload and sends nothing, `200`. It also
  returns `ready` and `problems` — and when the scheduler is reachable it
  resolves crew names against the live roster, so an operator sees the naming
  problems here rather than mid-push.
- **Live (`{"live": true}`):** performs the fan-out above. Session auth, `pm`+,
  and `canEditProject`. An **agent key can never reach it** — route topology
  gives 403 (`AGENT_API.md` §9 forbids publishing crew and bookings to an agent
  outright).
- **Unconfigured:** with `SCHEDULER_BASE_URL` unset the live path is a **501 that
  names the missing variable**. That is the default posture, so nobody turns it
  on by accident.
- **Idempotent:** an already-linked show returns `409` unless `{"force": true}`.

### Read-back (§4) — no staffing-side change was required

Both endpoints already exist and are unauthenticated:
`GET /api/travel` (the whole table, as an **object keyed by `travel_key`**) and
`GET /api/bookings?eventId=N`. Hotels are **not** in `travel_info` — a hotel is
a `bookings` row with `category='hotel'` and the occupants in `staff_assigned`.

`GET /api/shows/:id/travel` and `GET /api/shows/:id/run-of-show` merge that onto
each crew line as **`booked: {arrival, departure, hotel}`**, alongside the local
`travel` mirror. Both are **graceful by contract**: an unreachable or
unconfigured scheduler yields `scheduler.unavailable` and the sheet still
renders from local data. A travel lookup failure must never fail a call sheet.

---

## Spec bind (`POST /api/shows/:id/spec-bind`)

Session auth, `pm`+. The **atomic** bind the three browser tools post into, in
one `withTx`: envelope validation → **type sniff** → logo MIME gate → supersede
the old file → insert `files` → `storage.put` the bytes → upsert `spec_chain`
(rev+1, `derived_from_rev` = the parent's rev) → insert `spec_renders` →
`logActivity`. Composing the three existing calls from a browser would leave a
half-bound show on any mid-sequence failure and push megabytes over three round
trips.

- **Type sniff** — `e360` needs a truthy `version`, `nsf` needs
  `_app === 'NovaSpec'`, `pcfg` needs `_app === 'e360_power_cabling'`. These are
  the producers' own load-time guards. A mismatch is a **400 naming both types**,
  which prevents a whole class of silent chain corruption; the staffing app
  checks none of this.
- **Supersede, never delete** — the previous file on that node becomes
  `status='superseded'` and stays.
- **Staleness is free** — `chainFor` derives `stale` as
  `up && node.gen && up.gen && node.derivedRev !== up.rev`, so binding a `.e360`
  marks `.nsf`, `.pcfg` and the pull sheet stale with no extra code here.
- **Logo gate** — `clientLogoDataUrl` must match
  `data:image/(png|jpe?g|gif|webp);base64,…`. A stored `.e360` is
  attacker-influenced input the moment anyone can upload one, and the tool's own
  gate exists to stop `data:image/svg+xml,<svg onload=…>`. A bad logo does not
  fail the bind — it is stripped, and `logoStripped: true` says so.
- **Body limit** — this one route gets `SPEC_BIND_BODY_LIMIT` (25 MB), because
  the payload is `json + svg + pageHtml + png`; every other route keeps the 1 MB
  default.

`GET /api/shows/:id/spec-render/:node` serves the bundle back.
`GET /api/config` (public, no session) serves `toolsOrigins` so `public/` never
hardcodes an origin, plus the spec/ext/node maps and the feature flags:

| `features.*` | true when | the UI uses it to |
|---|---|---|
| `schedulerPush` | `SCHEDULER_BASE_URL` is set | grey out Push rather than offer a 501 |
| `flex` | `FLEX_BASE_URL` **and** `FLEX_API_KEY` are set | same, for gear |
| `specBind` | `TOOLS_ORIGINS` is non-empty | say "not configured on this server" in the bind popup instead of refusing every bundle without explanation |

Each flag reports whether a deployment is CONFIGURED for something, never
whether the caller may do it — permission stays server-side. `public/bind.js`
treats a missing `specBind` (an older server) as "cannot tell" and falls back to
inspecting `toolsOrigins`, so the flag is additive.

The agent surface can **file** a spec artifact (`spec_type` / `chain_key` /
`artifact` on `POST /api/agent/documents`) but can never **bind** one: an agent
key is 403 outside `/api/agent/*` by route topology. An agent may put the file on
the shelf; a human decides it is the spec of record and bumps the rev.

### The consistency checker — `lib/speccheck.js`

`GET /api/shows/:id/spec-check`, also returned inline on every bind. It is
**stack-aware**, and every finding is a **question, never an error**, because
stacking is recorded differently at each node of the chain and dropped entirely
at the last:

| Node | where `doubleStacked` lives | count arithmetic |
|---|---|---|
| `.e360` | **`zones[]` only**, keyed by cabinet range | sum of `doubleStacked ? n*2 : n`, `n = last − first + 1` |
| `.nsf` | **`complexSections[]`** (+ `stackFlow`) | `cxPathTotal()`, same doubling rule |
| `.pcfg` | **nowhere** | flat sum of `count` — a single-row **footprint**, not a cabinet count |

The rules, derived from the real VNL Chicago pair:

1. `.e360 fields.totalCabinets` is **hand-typed free text**, never computed.
   Report a difference as "declared 144, geometry 120 — confirm."
2. A `.e360` with `zones: []` carries **no stacking data at all**. `.nsf`
   stacking with no upstream counterpart is **normal**, never drift.
3. Compare **stack-aware** totals, and only when both sides have stacking
   information; branch on `layoutMode` first.
4. A `.pcfg` count under-counts a stacked wall by construction.
5. All of it is **provisional** pending one stacked-zone walkthrough with Tom.

On VNL (144 declared / 120 geometry / 124 stack-aware) this produces exactly two
questions and flags **no** mismatch on the 120-vs-124 gap. On Unified Events it
surfaces the one real operator edit (field width 225 vs 222).

---

## Environment

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **required**; TLS auto-enabled for non-loopback hosts |
| `PORT` | `3100` | |
| `CORS_ORIGINS` | *(unset)* | comma-separated allowlist. Unset = same-origin only |
| `JSON_BODY_LIMIT` | `1mb` | JSON is metadata, never bytes |
| `SPEC_BIND_BODY_LIMIT` | `25mb` | scoped to `POST /api/shows/:id/spec-bind` only |
| `MAX_UPLOAD_BYTES` | `104857600` | the raw byte-upload cap (100 MB) |
| `STORAGE_DRIVER` | `local` | `local` · `smb` · `webdav` (the latter two are stubs) |
| `STORAGE_ROOT` | `./.storage` | where the local driver writes bytes |
| `SHOWRUNNER_NAS_ROOT` | `\\E360-NAS\Showrunner` | the logical root every `nas_path` is expressed against |
| `ADMIN_PASSWORD` | `e360admin` | the first-boot admin password |
| `SEED_ROSTER` | *(off)* | `1` seeds the prototype's 9-person demo roster |
| `SEED_ROSTER_PASSWORD` | `e360demo` | |
| `BCRYPT_ROUNDS` | `10` | |
| `SESSION_HOURS` | `12` | |
| `AGENT_KEY_PEPPER` | `e360salt` | **change it in production** |
| `THUMBNAILER_TOKEN` | *(unset)* | lets the NAS thumbnailer PATCH `files.thumb_path` without a session |
| `API_RATE_LIMIT` / `LOGIN_RATE_LIMIT` | `1200`/5min · `20`/15min | per IP |
| `SCHEDULER_BASE_URL` | *(unset)* | the staffing app's host. **Unset = the live push is a 501** |
| `SCHEDULER_USER` / `SCHEDULER_PASS` | *(unset)* | the dedicated `showrunner` service account (role `edit`). `SCHEDULER_API_TOKEN` is **retired** |
| `SCHEDULER_TIMEOUT_MS` | `20000` | |
| `TOOLS_ORIGINS` | *(unset)* | **REQUIRED to use spec-bind.** Comma-separated allowlist of origins that may `postMessage` a spec bundle into the `?bind-spec=1` popup; served at `GET /api/config` as `toolsOrigins`. **Unset fails CLOSED** — the allowlist is `[]` and the popup accepts nothing but its own origin. Since the hardening pass it also fails **audibly**: `GET /api/config` reports `features.specBind: false` and the popup says "Spec binding is not configured on this server" the moment it opens, instead of waiting 30s and looking like the tool broke. A deployment that expects e360-tools to bind specs MUST set it. |
| `FLEX_BASE_URL` / `FLEX_API_KEY` | *(unset)* | **Unset = every `lib/flex.js` function throws a 501 naming the missing var** — never a silent empty result |
| `FLEX_TIMEOUT_MS` · `FLEX_TREE_MAX_DEPTH` · `FLEX_TREE_MAX_NODES` · `FLEX_IDENTITY_BATCH` · `FLEX_USER_CACHE_MS` | `20000` · `4` · `200` · `5` · `1800000` | guards on the Event Folder tree walk (one `/identity` call per node against a BETA API) and a TTL on the current-user cache |

### Mail — F3, the notification outbox's delivery layer (`lib/mail.js`)

Every real delivery (assignment · @mention · a notify-picker pick · a tech-report
nag) is queued into `notification_outbox` and flushed by a **driver**. Nothing in
the app reaches a mail server except through `lib/mail.js send()`, so "how a
notification is delivered" has exactly one call site.

| Var | Default | Notes |
|---|---|---|
| `MAIL_DRIVER` | `log` | `log` · `graph`. **`log` is the default and is not a stub**: it records the delivery in the activity trail (`notification.sent`) and marks the row sent. On a box with no mailbox that is the honest behaviour — the notification is recorded, addressed and auditable; it simply travelled zero metres. |
| `MAIL_FROM` | *(unset)* | the sending mailbox — the dedicated `showrunner@` account (TEAM_FEEDBACK, Tom 2026-08-27). Required by `graph`. |
| `MAIL_TENANT_ID` | *(unset)* | Entra tenant GUID. Required by `graph`. |
| `MAIL_CLIENT_ID` | *(unset)* | app-registration GUID. Required by `graph`. |
| `MAIL_CLIENT_SECRET` | *(unset)* | client secret. Required by `graph`. |
| `MAIL_REPLY_TO` | *(unset)* | optional `Reply-To`. |
| `APP_BASE_URL` | *(unset)* | used to make the deep link in a message body absolute. Unset leaves the link relative — still useful, still honest. |
| `TECH_REPORT_DUE_DAYS` | `3` | how long a tech has to file a show report after strike. |
| `ARCHIVE_AFTER_DAYS` | `60` | F6 — days after `closeout_complete_at` before the sweep auto-archives. Tom's number. |
| `SWEEP_ON_BOOT` | *(on)* | `0` disables the boot sweep. |
| `SWEEP_LOOKBACK_DAYS` | `45` | How far back the sweep reaches to **strike a show it has never seen**. The first boot after this release meets a database full of shows that already happened; unbounded, it would strike all of them and nag every crew member about a job from last year. Older than this is history — a pm can still strike it by hand. A show **already struck** is unaffected, and closeout/archiving have no lookback at all: they are pure re-checks of the record. |

**`graph` is a SKELETON and says so.** The mailbox and app registration are an
M365-admin task that has not happened (HANDOFF "Open / next"), so the wire call
is deliberately not written — there is nothing to authenticate against and a
half-written client would be untestable fiction. What IS built is everything up
to the wire: config detection, the token + `sendMail` URLs, the exact JSON body
(`graphTokenUrl()` / `graphSendMailUrl()` / `graphSendMailBody()`), and the
failure contract. Selected but unconfigured, it answers a **501-shaped
"mail not configured"** naming the missing vars, and **the item stays queued** —
so turning the env vars on later delivers the backlog rather than discovering it
was thrown away. `GET /api/admin/mail-status` reports exactly this.

**System mail is not agent outbound.** "File-don't-fire" (`AGENT_API.md` §9) is
about an agent sending mail *as a person*. This is the app telling a person that
something of theirs changed, from its own mailbox, on that person's stated
preference. Nothing here reads a mailbox, signs as a user, or replies to a thread.

Agent-key limits are fixed at **120 writes/hour and 600 reads/hour per key**
(`AGENT_API.md` §9).
