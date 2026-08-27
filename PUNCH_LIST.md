# Backend wiring punch-list — the complete workbook
Compiled 2026-08-27 from the six build passes' schema-delta reports + the original audit. Work these into server.js + SCHEMA.md (+ seed loader). The front-end prototype (public/) is the behavioral spec — its data.js shapes and api.js signatures are what the REST layer must serve.

## From the audit (pre-existing divergences)
- A. `evidence_type`: templates.json types Flex steps as `file`, seedLedTemplate() as `flex_element` — pick one (flex_element), fix both.
- B. `owner_role` column missing on template_steps — templates.json carries 10 planning-role slugs that a seed loader currently drops. Add column + build the templates.json → DB seed loader (templates.json is referenced by NOTHING today).
- C. Lanes: server enforces 6 fixed lanes; front-end EVENT_TYPES uses per-type lane sets (print=8, both=10). Lanes must become per-event-type config (event_type_templates-driven), not a fixed enum.
- D. `stage`: front-end uses server enum values now, but confirm full vocabulary (incl. whether 'in_production' is wanted).
- E. Sessions are in-memory (die on redeploy) — durable sessions + the api_keys story below.
- F. sha256+salt → bcrypt/argon2. CORS tightened. Basic rate limiting + input caps.
- G. `/public` is empty → serve the SPA from it + deep-link fallback for all routes.
- H. push-to-scheduler live path is commented out (501) — leave dry-run; live path is a later, separate decision.

## Foundations pass (1–15)
1. files.kind can't express Flex artifacts (pullsheet/manifest/image) — add `artifact` column (front-end already models it) or new kind values.
2. files.ver — no column; chain UI displays v{rev}. Add.
3. files.dim (display string, e.g. "2 zones · 1408 x 96") — add nullable TEXT.
4. steps.risk boolean — drives RAG + warn pill. Add column (or status-enum value; front-end models boolean).
5. jobs table + shows.default_job_id + job_id on cost-bearing rows (expenses.job_id; Showrunner-side bookings too — see 15).
6. Spec-chain state per node {gen, rev, derived_from_rev, by, when} — needs columns/table (INTEGRATION.md §48–67).
7. Flex gear state (linked, pulled, element_id, gear_list_id, doc_number) — columns on shows or a flex_state table.
8. Extra milestones ("Content due", "Proof approved", "Freight", "Target") — milestones child table {show_id, label, date}.
9. shows.rag: front-end computes from steps; decide derived-only (drop column) or stored manager override that wins. Recommend: derived, nullable override column.
10. projects.summary + projects.source (AI-summary panel + provenance line).
11. activity.accent flag column.
12. shows.cabinets INT (drives Flex kit sizing).
13. users: reconcile invented usernames (tvigon, bsawyer, lfarkos, jhawk, dvargas, aramos, jeaton) against the real staffing roster at go-live; add display columns initials/color/title/discipline.
14. proofs + proof_rounds tables (entirely missing from SCHEMA.md).
15. Showrunner bookings table (front-end models it; currently only exists downstream in staffing).

## Accounting pass (16–24)
16. jobs.deal_type TEXT CHECK (rental|sale) — drives COGS treatment + P&L grouping.
17. budget_lines table (job_id, category, allotted NUMERIC(12,2), notes) + shared category enum travel|freight|labor|gear|print|production|misc enforced on expenses.budget_line_category too.
18. expenses.by TEXT ("who to chase") + expenses.memo TEXT.
19. bookings.amount NUMERIC(12,2), bookings.booked_date, bookings.file_id NULL + index (status, file_id) — exceptions/feed depend on these.
20. jobs.budget_total derived (sum of lines) — computed in queries/view, don't double-enter.
21. Budget-line change audit: updated_at/updated_by + activity rows.
22. activity.actor must accept 'agent:<username>' (UI renders "Tom's agent").
23. files kind whitelist += receipt|invoice|po|transcript|photo; files.status TEXT DEFAULT 'filed'; files.provenance JSONB; provenance JSONB + source_ref TEXT also on steps/expenses/projects/shows/activity (AGENT_API hooks).
24. Reject-proposal semantics: server resolves the proposals row, never materializes rows to delete (prototype hard-deletes; server must not need a delete path).

## Purchasing pass (25–30)
25. purchase_orders table {po_number, vendor, project_id, job_id, status needed→quoted→ordered→shipped→received→reconciled, created_by, ordered/expected/received_date, approval JSONB, provenance JSONB, source_ref TEXT, memo, tracking, quote_file_id, invoice_file_id} + indexes (status, project_id) + delete-cascade wiring.
26. po_lines {po_id, item, detail, qty, unit_cost, category (7-cat enum), job_id NULL=inherit, show_id NULL=season-wide, ownership inventory|cogs, expense_id NULL} + indexes (po_id, job_id) + cascades.
27. expenses.po_id NULL — PO-generated actuals trace to their order; excluded from exceptions scan.
28. Config po_approval_threshold (default 5000); gate enforced server-side on quoted→ordered. **APPROVERS (Tom's decision 8/21, supersedes manager+): the admins (Tom/Tony/Jim) + Candice (finance capability).**
29. files: no change for PO docs — quote/invoice reuse financial-doc columns; POs reference file ids.
30. Agent API: POST /api/agent/purchase-requests → lands status 'needed', mandatory provenance (AGENT_API §6–8 conventions).

## Notes pass (31–37)
31. notes table: anchor_type/anchor_id (AGENT_API's target_kind/target_id maps to this), author (accepts 'agent:<u>'), body, created_at, edited_at NULL, mentions TEXT[] denormalized, parent_id NULL, provenance JSONB.
32. note_reads (note_id, username, read_at, UNIQUE(note_id, username)) — separate from note_mentions (the mention fact).
33. parent_id rule server-side: replies-to-replies re-anchor to thread root (one level max).
34. Anchor whitelist: project·show·step·file·job·expense·po. notes join the PO delete path + project/show cascades.
35. GET /api/me/inbox + POST /api/me/inbox/read; badge = unread + proposals WHERE assigned_to=me AND status='pending'.
36. Notes write activity rows (action 'note.add', detail = mention list, NEVER the body); job/project-anchored notes also write a project-scoped activity row.
37. Edit route: author-only, sets edited_at, re-parses mentions server-side; agent-authored notes immutable to humans.

## Call-sheet pass (38–42)
38. shows += load_in_time/doors_time/event_time/strike_time (HH:MM TEXT), venue_address, parking_notes, radio_channel, dress_code (all nullable) + venue_poc/client_poc JSONB.
39. schedule_items table {show_id, day DATE, start_time, end_time NULL, title, detail, who JSONB ('all'|usernames[]|role), location, kind travel|work|show|meal|strike}.
40. crew_assignments {show_id, username NULL (local hires carry name+phone), role_on_site, call_time, travel JSONB in the staffing B.6 shape}.
41. users.phone TEXT.
42. Staffing read-back API (staffing-app side): expose GET /api/travel?eventId= (the packet builder's travel_key queries, staffing server.js ~1920) + GET /api/bookings?eventId=&category=hotel; Showrunner maps rows → crew_assignments.travel by canonical name. Day-by-day schedule stays Showrunner-owned; staffing only receives header times via B.1.

## Photos pass (43–48)
43. files += taken_at TIMESTAMPTZ, width INT, height INT, caption TEXT, tags TEXT[], shot_by TEXT NULL, recap_pick BOOL DEFAULT false, thumb_path TEXT.
44. provenance.source_kind enum += camera_roll; source_ref format photos:{user}/IMG_nnnn.
45. NAS path: photos file under mechanical {kind} folder \photo\ (Tom pending on plural \photos\ — trivial either way).
46. NAS agent/thumbnailer contract: agent files via POST /api/agent/documents kind:'photo' (+taken_at/width/height/caption/tags), bytes via PUT :id/content; <85 confidence quarantines under _agent-inbox; NAS watcher writes {name}_t320.jpg beside originals and PATCHes files.thumb_path; confirm moves original+thumb to canonical path via the proposal machinery.
47. Human routes: PUT /api/photos/:id (caption/tags; pm+ OR uploader) + PUT /api/photos/:id/pick (pm+). Session-only — agent surface stays append-only.
48. Recap consumes recap_pick ordered by taken_at (front-end recapStripPhotos() is the reference).

## Recap pass (49–54)
49. deliverables table {project_id, show_id, kind TEXT, status draft|approved|sent, body JSONB, generated_by, generated_at, edited_by/at, approved_by/at, sent_at, sent_to, provenance JSONB} + index (show_id, kind) + cascades.
50. provenance.source_kind += closeout (confidence 100, matched_by ['show_record']).
51. deliverables.kind is the extension point (recap now; call_sheet/photo_set later).
52. **Content firewall server-side**: recapFacts (closed source whitelist) + recapUnsafe (string gate) move into server.js; client copies are UX only. Generation is a pm+ session route running as the owner's agent.
53. deliverables deliberately ABSENT from /api/agent/* — no agent-key path may create/edit/approve/send; approval is session-only.
54. recap_stat_keys table (cabinets·panels·crew·days·attendance·date) — client-safe stats by FK, not regex.

## Agent API core (from AGENT_API.md — implement the spec)
- api_keys, proposals (generic + payload JSONB), agent_idempotency (UNIQUE user+key, replays return original response) tables.
- All /api/agent/* endpoints per AGENT_API.md: whoami, match, shows/:id/context, shows lookup, documents (+content), tasks:batch (atomic, cap 25), projects (always proposal), notes, proposals list. Human-only: keys CRUD, proposals confirm/reject.
- Server-enforced confidence bands (≥85 file / 60–84 proposal / <60 unattached; ambiguous top-2-within-10 forces proposal). status:'filed' below band = 422.
- v1 agent surface append-only: no DELETE or PUT-of-existing routed under /api/agent/* (documents content PUT is the create-flow exception per spec).
- Hard denials: no outbound sends, no scheduler push, no deletes, no role/user admin via agent keys.

## Roles (Tom's decisions)
- Tom, Tony, Jim = admin. Candice = accounting: finance capability flag (sees margins, approves POs) — capability, not a rank. users.finance BOOL.
- Notification principle (Tony): actor picks who to notify on significant actions; routine edits silent. Server: notify targets optional param on mutating routes → lands as note_mentions/inbox entries, never forced.

## Cascade rule (repeat because every pass flagged it)
No SQL FKs by convention — EVERY new table must be wired into the manual delete cascades in DELETE /api/projects/:id and DELETE /api/shows/:id (and POs' own delete path for po_lines/notes): jobs, budget_lines, purchase_orders, po_lines, notes, note_reads, schedule_items, crew_assignments, deliverables, proposals, milestones, proofs, bookings, flex_state.
