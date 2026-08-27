# e360 Showrunner — Agent-Facing API

The layer per-user Claude agents call to **file things into the record**. Each
teammate's agent senses their own world (M365 mail, Teams meetings/transcripts,
chats) and writes into Showrunner *as that person*, under that person's role. The
concrete contract behind `ARCHITECTURE.md` — the MCP server is a thin wrapper over
these endpoints and adds no authority of its own.

Driving cases: *"send this receipt to show X"* · *"derive tasks from this meeting
for show Y"* · accounting's agent matching invoices to jobs · an event born in the
PM app from a sales thread.

**Conventions.** JSON in/out, camelCase request bodies, snake_case DB columns
(same as today's routes). Success is `200` with a body; there is no `201`/`204`
anywhere in this app. Dates `YYYY-MM-DD`. Money `NUMERIC(12,2)`. Confidence
`0–100` (matches `expenses.match_confidence NUMERIC(5,2)`).

---

## 1. Auth for agents — durable API keys

The in-memory `sessions` Map (`server.js:71`) dies on redeploy and expires in 12h.
That is fine for a browser and wrong for a daemon.

> **DECISION:** agents authenticate with a **durable, hashed API key** in a new
> `x-agent-key` header — never a password, never a session token. Rationale: an
> agent must survive redeploys and be revocable per-person without touching the
> user's login.

A key **acts as its user and inherits that user's role**. A tech's agent has a
tech's powers. Changing the user's role changes the key's powers immediately —
role is read live from `users`, never copied onto the key.

```
x-agent-key: sk_sr_live_9f3c...          (shown once at creation, never again)
x-idempotency-key: m365:AAMkAGI2...#doc  (see §8)
```

### `api_keys` table  *(agent-API-only)*

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `user_id` | INTEGER NOT NULL | the human this key acts as (indexed) |
| `username` | TEXT NOT NULL | denormalized for logging |
| `label` | TEXT | "Tom's M365 agent", "Accounting agent" |
| `key_prefix` | TEXT | first 12 chars — how the UI identifies a key |
| `key_hash` | TEXT NOT NULL | sha256 of the full key (same `hashPassword` shape) |
| `scopes` | TEXT[] | `agent:read` · `agent:file` · `agent:propose` |
| `created_at` / `created_by` | TIMESTAMPTZ / TEXT | |
| `revoked_at` | TIMESTAMPTZ NULL | non-null = dead; keys are revoked, never deleted |
| `last_used_at` / `last_used_ip` | TIMESTAMPTZ NULL / TEXT | best-effort on each call |

Key management is **human-only** (session auth, `requireAuth`), never reachable
with an agent key:

| Method | Path | Role | Notes |
|---|---|---|---|
| `GET` | `/api/keys` | self / admin | lists prefix+label+last_used; never the key |
| `POST` | `/api/keys` | self / admin | `{label, scopes[]}` → `{id, key}` — **only** response containing the key |
| `DELETE` | `/api/keys/:id` | self / admin | sets `revoked_at`; returns `{ok:true}` |

`GET /api/agent/whoami` → `{"username":"tom","role":"pm","scopes":["agent:read","agent:file","agent:propose"],"actor":"agent:tom"}`
— the agent's first call, so it knows what it may attempt.

**Attribution.** Every agent write records the actor as **`agent:<username>`**
(`agent:tom`, `agent:candice`) in `activity.actor` and in author-ish columns
(`files.uploaded_by`, `steps.owner` is *not* overwritten — see §4). The UI reads
the `agent:` prefix to render "Tom's agent".

### Errors (all endpoints)

| Code | When |
|---|---|
| `400` | validation — missing/invalid field, bad enum, bad date |
| `401` | missing / unknown / revoked key → `{"error":"Invalid or revoked agent key"}` |
| `403` | role too low, or key lacks the scope → `{"error":"Requires 'pm' role or higher"}` / `{"error":"Key lacks scope 'agent:file'"}` |
| `404` | target project/show/job/proposal not found |
| `409` | idempotency key replayed with a different body (§8) |
| `422` | confidence band forbids the requested action (e.g. `status:"filed"` at confidence 40) |
| `429` | rate limit — `{"error":"Rate limited","retryAfter":30}` |
| `500` | `{"error": e.message}` (existing convention) |

---

## 2. Matching — `POST /api/agent/match`

The confidence guardrail. The agent hands over source context; the app returns
**ranked candidates with reasons**. Matching lives server-side so it's consistent
across all agents and improvable in one place — the agent never guesses against a
list it scraped. **Scope:** `agent:read`; never writes, safe to call repeatedly.

```json
POST /api/agent/match
{
  "sourceKind": "email",
  "subject": "Re: LOVB invoices — Madison forklift",
  "participants": ["candice@e360sport.com", "ap@lovb.com"],
  "bodyExcerpt": "Invoice attached for the forklift rental at the Madison match...",
  "dates": ["2026-09-14"],
  "amounts": [1240.00],
  "vendors": ["Sunbelt Rentals"],
  "hints": { "projectId": null, "showId": null, "clientName": "LOVB" }
}
```

```json
200
{
  "candidates": [
    { "projectId": 12, "projectName": "LOVB 2026 Season",
      "showId": 41, "showName": "Madison — Alliant Energy Center",
      "jobId": 7, "qbJobNumber": "LOVB-26-004",
      "confidence": 93, "band": "high",
      "matchedBy": ["client_name", "date_window", "vendor_history"],
      "why": "Client 'LOVB' matches project 12; 2026-09-14 is show 41's load-in; Sunbelt billed to job 7 twice before." },
    { "projectId": 12, "showId": 44, "jobId": 7, "confidence": 31, "band": "low",
      "matchedBy": ["client_name"], "why": "Same client, no date or vendor overlap." }
  ],
  "top": { "confidence": 93, "band": "high" },
  "ambiguous": false
}
```

`matchedBy` tokens: `explicit_id` · `client_name` · `venue` · `date_window` ·
`participant` · `vendor_history` · `thread_ref` · `job_number` · `keyword`.

### Confidence bands — what each permits

| Band | Range | Agent may | Result |
|---|---|---|---|
| **high** | ≥ 85 | file directly | `status:"filed"` — lands in the record, logged, visible immediately |
| **medium** | 60–84 | file **as a proposal** against the matched target | `status:"proposed"` — appears in the owner's Agent inbox with a pre-filled target |
| **low** | < 60 | submit **unattached** | `status:"proposed"`, `targetShowId:null` — lands in the review queue for a human to attach |

> **DECISION:** bands are **server-enforced, not advisory.** A write asking for
> `status:"filed"` with `confidence < 85` is rejected `422`, not silently
> downgraded. Rationale: silent downgrades hide agent misbehavior; a hard error
> shows up in the agent's transcript and in ours.

> **DECISION:** `ambiguous:true` (top two candidates within 10 points) forces
> proposal regardless of confidence. Rationale: "confident about two different
> shows" is exactly the wrong-folder failure we're guarding against.

The agent must echo the `confidence` and `matchedBy` it acted on into the write's
`provenance` (§7). A claimed confidence the server can't corroborate is still
accepted — but it's recorded as the agent's claim, so the audit shows who lied.

---

## 3. Filing documents — `POST /api/agent/documents`

Receipts, invoices, POs, confirmations, photos, recordings, transcripts. Two-tier
as always: **metadata in Postgres, bytes on the NAS**.

**Scope:** `agent:file` (filed) / `agent:propose` (proposed). **Role:** `tech`+
(matches today's `POST /api/files`).

```json
POST /api/agent/documents
{
  "showId": 41, "jobId": 7,
  "kind": "invoice", "name": "sunbelt-forklift-madison", "ext": ".pdf", "size": 184320,
  "amount": 1240.00, "vendor": "Sunbelt Rentals", "docDate": "2026-09-14",
  "status": "filed",
  "provenance": { "sourceKind": "email", "sourceRef": "AAMkAGI2LTk5...",
                  "sourceLabel": "Re: LOVB invoices — Madison forklift",
                  "confidence": 93, "matchedBy": ["client_name","date_window","vendor_history"] }
}
```
```json
200
{ "status": "filed", "fileId": 318, "expenseId": 205, "activityId": 1904,
  "nasPath": "\\\\E360-NAS\\Showrunner\\P12-lovb-2026-season\\S41-alliant-energy-center\\invoice\\sunbelt-forklift-madison.pdf",
  "uploadUrl": "/api/agent/documents/318/content" }
```

- **`kind`** extends `FILE_KINDS` with the financial types accounting asked for:
  the existing six **+ `receipt · invoice · po · transcript · photo`**. *(accounting pass)*
- **`nasPath`** is always server-derived via `buildNasPath()` — the agent may not
  supply it. Proposed docs quarantine under
  `{ROOT}\_agent-inbox\{username}\{kind}\{filename}` and **move to the canonical
  path on confirm**.
  > **DECISION:** proposals never write bytes into a real show folder. Rationale:
  > a rejected proposal must leave no trace on the NAS for someone to find later.
- **Bytes** go in a second call, `PUT /api/agent/documents/:id/content`
  (`application/octet-stream`, raw body, ≤ 100 MB) → `{ok:true, size}`.
  Metadata-first means a failed upload leaves a resolvable record, not a ghost.
- **`amount` + `vendor` + `jobId`** additionally create an `expenses` row
  (`status:'proposed'`, `evidence_ref` = the file id) so the doc reaches
  accounting's finance feed as a cost, not just a PDF. No `amount` → no expense.
- `jobId` defaults to the show's `default_job_id`; supply it only to override
  (the per-item override in the jobs model).

**Errors:** `400` unknown `kind`, `amount` non-numeric, neither `showId` nor
`projectId`; `404` show/job not found; `422` `status:"filed"` below band; `409`
idempotency replay.

---

## 4. Deriving tasks — `POST /api/agent/tasks:batch`

"Derive tasks from this meeting for show Y." One meeting → many steps, **atomic**.

**Scope:** `agent:file` / `agent:propose`. **Role:** `pm`+ to file; any role may
propose.

```json
POST /api/agent/tasks:batch
{
  "showId": 41, "status": "proposed",
  "provenance": { "sourceKind": "meeting", "sourceRef": "19:meeting_MjZh...@thread.v2/1755...",
                  "sourceLabel": "LOVB Madison production call — 2026-08-19",
                  "confidence": 78, "matchedBy": ["participant","client_name"] },
  "steps": [
    { "lane": "venue",     "title": "Confirm dock height with Alliant ops", "owner": "tom",  "dueDate": "2026-08-28" },
    { "lane": "logistics", "title": "Rent forklift — Madison",              "dueOffsetDays": -6 },
    { "lane": "crew",      "title": "Book 2 stagehands",                    "owner": "mike", "dueOffsetDays": -6 }
  ]
}
```

- proposed → `200 {"status":"proposed","proposalId":88,"count":3,"stepIds":[]}`
- filed → `200 {"status":"filed","proposalId":null,"count":3,"stepIds":[901,902,903]}`

- **Atomic:** the whole batch runs in `withTx`. One bad `lane` → nothing written,
  `400` naming the index: `{"error":"steps[1].lane invalid","index":1}`.
- **Cap:** 25 steps per batch (`400` beyond). `lane` uses the existing whitelist;
  `dueDate` **or** `dueOffsetDays` (resolved against `show.event_date`, as today).
- **`owner`** must resolve to a known username/roster name, else `400` — the agent
  may assign, it may not invent people.
  > **DECISION:** below `pm`, an agent may only set `owner` to itself or leave it
  > blank. Rationale: assigning work to other people is a management act; a tech's
  > agent shouldn't hand a task to a colleague.
- Filed steps land `status:'todo'`, `evidence_type:'none'` — the provenance
  carries the meeting link, not the evidence slot.

---

## 5. Creating instances & notes

### `POST /api/agent/projects` — propose a folder + show + job

An event born in the PM app from a sales thread.

> **DECISION:** this is **always a proposal**, at any confidence, for any role.
> Rationale: creating a client-facing commercial object (a folder, a show, and a
> `qb_job_number` accounting will reconcile against) is judgment, not clerking.

```json
POST /api/agent/projects
{
  "project": { "name": "Vail Summit LED", "client": "Vail Resorts", "type": "led", "stage": "lead" },
  "show":    { "name": "Base Village screen", "venue": "Vail Base Village",
               "eventDate": "2026-12-12", "loadInDate": "2026-12-10" },
  "job":     { "name": "Vail Summit LED 2026", "qbJobNumber": null },
  "provenance": { "sourceKind": "email", "sourceRef": "AAMk...",
                  "sourceLabel": "RFP — Vail Summit LED", "confidence": 71, "matchedBy": ["thread_ref"] }
}
```
→ `200 {"status":"proposed","proposalId":91,"targetKind":"project"}`

`qbJobNumber` is **left null by the agent** — Candice creates it in QuickBooks and
it's entered on confirm. Confirm creates project + show + job in one `withTx`, and
instantiates the matching event-type template if passed `{"instantiateTemplate":true}`.

### `POST /api/agent/notes` — post a note / @mention as the user's agent

Anchored comments only (per `TEAM_FEEDBACK.md`) — never free-floating.

```json
POST /api/agent/notes
{
  "target": { "kind": "file", "id": 318 },
  "body": "Filed the Sunbelt forklift invoice ($1,240) to Madison. @candice — QB job LOVB-26-004.",
  "mentions": ["candice"],
  "provenance": { "sourceKind": "email", "sourceRef": "AAMk...", "confidence": 93, "matchedBy": ["vendor_history"] }
}
```
→ `200 {"noteId": 512, "notified": ["candice"]}`

- `target.kind`: `project · show · step · file · job · expense`.
- Notes are **always filed, never proposed** — commentary, reversible, the
  cheapest way for an agent to say "I did a thing, check me." The natural
  companion to every high-confidence auto-file.
- `mentions[]` must be existing usernames (`400` otherwise) and drop into that
  person's mentions inbox. Agents may mention; agents may not email (§9).
- **Scope:** `agent:file`. **Role:** `viewer`+ — anyone who can read can comment.

---

## 6. The review queue (Agent inbox)

Where "file, don't fire" becomes a UI. Pairs with the mentions inbox as the
second half of a person's **Agent inbox** surface.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/agent/proposals` | key **or** session | defaults to the caller's own; `?status=pending\|confirmed\|rejected`, `?kind=`, `?showId=`, `?limit=` |
| `GET` | `/api/agent/proposals/:id` | key or session | full payload + provenance |
| `POST` | `/api/proposals/:id/confirm` | **session only** | `{ "overrides": { "showId": 44, "jobId": 7 } }` → materializes the write |
| `POST` | `/api/proposals/:id/reject` | **session only** | `{ "reason": "wrong show" }` |

> **DECISION:** confirm/reject are **session-auth only** — an agent key is
> rejected `403` even for its own proposals. Rationale: "file, don't fire" is
> meaningless if the agent that proposed can also confirm.

Confirm applies the proposal in a `withTx`: materializes the row(s), moves any
quarantined bytes to the canonical NAS path, copies the provenance onto the
created row(s) with `confirmed_by`/`confirmed_at` appended, logs
`agent.proposal.confirm`. Already-resolved → `409`. `overrides` may change target
(`showId`/`jobId`/`projectId`) and scalar fields; never `kind`.
`GET /api/agent/proposals?user=all` requires `manager`+.

### `proposals` table  *(agent-API-only)*

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `kind` | TEXT NOT NULL | `document · tasks_batch · project · expense` |
| `status` | TEXT `'pending'` | pending · confirmed · rejected · expired |
| `proposed_by` | TEXT NOT NULL | `agent:tom` |
| `assigned_to` | TEXT | who should decide (project owner, or the agent's user) — indexed |
| `project_id` / `show_id` / `job_id` | INTEGER NULL | best-guess target; NULL = unattached (low band) |
| `payload` | JSONB NOT NULL | the exact request body, replayed on confirm |
| `provenance` | JSONB NOT NULL | §7 |
| `confidence` | NUMERIC(5,2) | denormalized for sorting |
| `resolved_by` / `resolved_at` / `resolve_reason` | TEXT / TIMESTAMPTZ / TEXT | |
| `created_rows` | JSONB | `{"files":[318],"expenses":[205]}` — what confirm created |
| `created_at` | TIMESTAMPTZ | |

> **DECISION:** one generic `proposals` table with a `payload` JSONB, not a
> proposal table per type. Rationale: proposal kinds will grow faster than we want
> migrations; the payload is the request body we already validate.

Wire it into the manual delete cascades (`SCHEMA.md`) or you leak rows. Pending
proposals older than 30 days → `expired` by a housekeeping pass.

---

## 7. Provenance on EVERY agent write

Non-negotiable. No agent write is accepted without it (`400` if absent).

```json
{
  "source_kind":  "email",              // email | meeting | chat | manual
  "source_ref":   "AAMkAGI2LTk5...",    // M365 message id / meeting id / chat id
  "source_label": "Re: LOVB invoices",  // human-readable, for the UI string
  "source_url":   "https://outlook.office.com/...",  // optional deep link
  "agent_user":   "tom",                // from the key, server-set — client value ignored
  "actor":        "agent:tom",          // server-set
  "confidence":   93,
  "matched_by":   ["client_name","date_window","vendor_history"],
  "matched_at":   "2026-08-21T14:02:11Z"
}
```

> **DECISION:** provenance is a **JSONB column named `provenance`** on every
> agent-writable table (`files`, `steps`, `expenses`, `notes`, `projects`,
> `shows`, `proposals`), *plus* two promoted scalar columns —
> `source_ref TEXT` and `status TEXT` — where they need indexing or gating.
> Rationale: one shape, one parser, no 6-column migration on every table; the two
> promoted columns are the ones we actually query (idempotency lookups,
> proposed-vs-filed filters).

**Where it shows.** `activity` gets a row per agent write with `actor='agent:tom'`
(`action:'file.add'`, `detail:'invoice: sunbelt-forklift-madison'`) plus an
optional `activity.provenance JSONB` so the feed can render the full string:
**"filed by Tom's agent from email *'Re: LOVB invoices'* — 93% (client, date,
vendor history)"**, with `source_url` linking back to the original message.
Anything `status='proposed'` renders with a **proposed** chip and inline
confirm/reject, in addition to appearing in the Agent inbox.

---

## 8. Idempotency

Agents re-read the same inbox. Re-filing must be a **no-op returning the original
result**, not a duplicate. Every mutating agent endpoint accepts
`x-idempotency-key` — required for `documents`, `tasks:batch`, `projects`;
optional for `notes`.

Recommended key: `{sourceKind}:{sourceRef}#{intent}` — e.g.
`email:AAMkAGI2LTk5...#doc`, `meeting:19:meeting_MjZh...#tasks`. Stable across
re-processing of the same message, distinct per intent on the same message.

| Situation | Response |
|---|---|
| First call | normal `200`, result recorded |
| Replay, identical body hash | the **original** `200` body verbatim + `x-idempotent-replay: true` |
| Replay, different body hash | `409 {"error":"Idempotency key reused with a different payload","originalId":318}` |
| No key on a required endpoint | `400 {"error":"x-idempotency-key required"}` |

### `agent_idempotency` table  *(agent-API-only)*

`id · key TEXT NOT NULL · username TEXT NOT NULL · endpoint TEXT · body_hash TEXT
· response JSONB · created_at TIMESTAMPTZ` — **UNIQUE (username, key)**.

> **DECISION:** a single idempotency ledger, not a `idempotency_key` column on
> each table. Rationale: one uniqueness constraint, replays return the exact
> original response including derived ids, and it covers multi-row writes
> (`tasks:batch`) that no single column could.

Scoped per user — dedupe within a person, not across the company (two agents
forwarding the same vendor email are filing to different contexts). Retain 90 days.

---

## 9. Hard guardrails — what an agent key can NEVER do

Enforced by **key scope + route topology**, server-side. Agent endpoints live
under `/api/agent/*`; the agent-key middleware rejects every other `/api/*` path,
so a new human endpoint is not accidentally agent-reachable.

| Forbidden | Enforcement |
|---|---|
| **Any outbound send** — client email, vendor email, SMS | no such endpoint exists on the agent surface; the agent's *own* M365 MCP send tools are the human's problem, not the app's |
| **Push to scheduler** (`POST /api/shows/:id/push-to-scheduler`) | not under `/api/agent/*` → `403`. Publishing crew/bookings to the staffing app is a human act |
| **Any DELETE** — projects, shows, steps, files, expenses, notes | no `DELETE` verb is routed under `/api/agent/*` at all |
| **User / role admin** (`/api/users`, `PUT /api/users/:id/role`, `/api/keys`) | session-auth only → `403` with an agent key |
| **Confirming its own proposals** | `/api/proposals/:id/confirm` is session-only (§6) |
| **Editing `qb_job_number` or budget lines** | accounting-owned fields; agents may *read* them and may *propose* a job, never set the number |
| **Changing another user's step status** | inherits the existing `canUpdateStepStatus` rule unchanged |
| **Escalating its own role or scopes** | role read live from `users` on every request; scopes read from `api_keys`; neither is settable by the key |

> **DECISION:** the v1 agent surface is **append-only** (plus proposals) — no
> `PUT` of existing steps/files/expenses either. Rationale: appending is
> recoverable and audit-legible; silent overwrites of someone's data are the
> failure that would end team trust in the agents. Revisit once the audit log has
> real usage behind it.

Rate limits: 120 writes/hour and 600 reads/hour per key (`429`), so a looping
agent cannot flood the record before a human notices.

---

## 10. MCP tool mapping

The MCP server exposes one tool per endpoint and adds no logic. Tool descriptions
should state the band rules so the model self-selects `filed` vs `proposed`.

| MCP tool | Endpoint | One-liner |
|---|---|---|
| `whoami` | `GET /api/agent/whoami` | Who this agent acts as, its role and scopes |
| `match_context` | `POST /api/agent/match` | Rank candidate project/show/job for an email, meeting or chat, with confidence + reasons |
| `get_show_context` | `GET /api/agent/shows/:id/context` | Compact show summary — lanes/steps, recent activity, jobs, open money items — so the agent can reason before filing |
| `search_shows` | `GET /api/agent/shows?q=&client=&from=&to=` | Light lookup by name/client/venue/date when the agent already knows the target |
| `file_document` | `POST /api/agent/documents` | Attach a receipt/invoice/PO/confirmation/photo/recording/transcript to a show (+ job, amount, vendor) |
| `upload_document_bytes` | `PUT /api/agent/documents/:id/content` | Send the actual bytes to the NAS path returned by `file_document` |
| `create_tasks` | `POST /api/agent/tasks:batch` | Derive steps on a show's lanes from a meeting or email — atomic batch |
| `propose_event` | `POST /api/agent/projects` | Propose a new folder + show + job from a sales thread (always human-confirmed) |
| `post_note` | `POST /api/agent/notes` | Post an anchored note / @mention as the user's agent |
| `list_my_proposals` | `GET /api/agent/proposals` | What this agent proposed that is still waiting on a human |
| `get_proposal` | `GET /api/agent/proposals/:id` | Full payload + provenance of one proposal |

No `confirm_proposal` tool exists. That is the point.

### `GET /api/agent/shows/:id/context`

```json
200
{
  "show":    { "id": 41, "name": "Madison — Alliant Energy Center", "venue": "Alliant Energy Center",
               "eventDate": "2026-09-14", "loadInDate": "2026-09-12", "stage": "planning", "rag": "warn" },
  "project": { "id": 12, "name": "LOVB 2026 Season", "client": "LOVB", "type": "led", "owner": "tom" },
  "jobs":    [ { "id": 7, "name": "LOVB league LED", "qbJobNumber": "LOVB-26-004", "isDefault": true } ],
  "lanes":   { "client": { "todo": 1, "done": 3 }, "logistics": { "todo": 2, "in_progress": 1, "blocked": 1 } },
  "openSteps": [ { "id": 902, "lane": "logistics", "title": "Rent forklift — Madison", "owner": "", "dueDate": "2026-09-08", "status": "blocked" } ],
  "recentActivity": [ { "actor": "agent:tom", "action": "file.add", "detail": "invoice: sunbelt-forklift-madison", "createdAt": "2026-08-21T14:02:11Z" } ],
  "money":   { "expensesTotal": 8420.00, "proposedCount": 2, "missingDocs": ["Book truck / freight"] },
  "pendingProposals": 1
}
```

Budget-capped (top 20 open steps, 20 activity rows) so an agent can pull it every
turn without burning context. `money` is role-filtered — margin/profitability
stays `manager`/accounting-gated per `TEAM_FEEDBACK.md`; a tech's agent sees
counts, not dollars.

---

## 11. Appendix — schema hooks for the upcoming passes

Land these in the passes named and the agent API needs **zero** migrations later.
All additive (`ADD COLUMN IF NOT EXISTS`), per house rules.

| Pass | Table | Column / change | Why the agent API needs it |
|---|---|---|---|
| accounting | `jobs` *(new)* | `id · project_id · name · qb_job_number · client · budget_total · status · created_at` | the commercial dimension every filed doc/expense attributes to |
| accounting | `shows` | `default_job_id INTEGER NULL` | agents inherit it when `jobId` is omitted |
| accounting | `files` | `job_id INTEGER NULL` | per-item job override on a doc |
| accounting | `files` | `amount NUMERIC(12,2)` · `vendor TEXT` · `doc_date TEXT` | financial docs are files with money on them; drives the finance feed |
| accounting | `files` | `kind` whitelist += `receipt · invoice · po · transcript · photo` | the doc types agents actually file |
| accounting | `expenses` | `job_id INTEGER NULL` · `file_id INTEGER NULL` | ties a cost to its evidence doc and its QB job |
| accounting | `expenses` | index on `(job_id, status)` | the "waiting on me" exceptions query |
| notes | `notes` *(new)* | `id · target_kind · target_id · project_id · show_id · body · author · parent_id · created_at` | anchored threads; `author` accepts `agent:<username>` |
| notes | `note_mentions` *(new)* | `id · note_id · username · read_at` | the per-user mentions inbox; agent @mentions land here |
| notes | `notes` | `provenance JSONB` · `source_ref TEXT` | an agent-posted note carries where it came from |
| either (do early) | `files` | `provenance JSONB` · `source_ref TEXT` · `status TEXT DEFAULT 'filed'` | proposed-vs-filed + audit on every doc |
| either (do early) | `steps` | `provenance JSONB` · `source_ref TEXT` | "this task came from the 8/19 production call" |
| either (do early) | `expenses` | `provenance JSONB` · `source_ref TEXT` | richer superset of the ad-hoc `match_confidence`/`match_reason` pair (keep both) |
| either (do early) | `projects` / `shows` | `provenance JSONB` | events born from a sales thread |
| either (do early) | `activity` | `provenance JSONB` | renders the "filed by Tom's agent from …" string in the feed |
| **agent-API-only** | `api_keys` | §1 | durable per-user agent credentials |
| **agent-API-only** | `proposals` | §6 | the review queue / Agent inbox |
| **agent-API-only** | `agent_idempotency` | §8 | replay-safe re-processing |

**Cascade note:** `proposals`, `notes`, `note_mentions` and `jobs` must be wired
into the manual delete cascades in `DELETE /api/projects/:id` and
`DELETE /api/shows/:id` (`SCHEMA.md`) — no SQL FKs in this app, so an unwired new
table leaks rows on every folder delete.

---

*Spec only. Nothing here is implemented in `server.js` yet.*
