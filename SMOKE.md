# Running the smoke test

`scripts/smoke.js` boots the real server in-process on an ephemeral port and
drives it over HTTP, exactly as a browser or an agent would. It is the wiring
pass's proof of work: **322 assertions**, covering initDB idempotency, the
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
| 11 | cascade integrity | a folder carrying a child of **every** wired table is deleted; **zero orphans** across all 23 child tables |

## Reading a failure

Each line prints `✓` or `✗ name -> {response}`. A failing line names the
punch-list item or `AGENT_API.md` section it maps to, so the fix location is
usually obvious from the assertion text alone.

The run is self-cleaning: everything it creates is tagged `smoke<base36>` and
removed at the end, and the final assertion verifies that nothing tagged
survived.
