# Showrunner — product coherence review

> ## STATUS — THE ROUGH + POLISH WAVE, 2026-09-03 (evening)
>
> The audit's second tier: doors that exist but stick, and copy that lies.
> All walk-gated (§26–32), smoke §18–19.
>
> **Closed this wave:**
> * **E4 · proposal retargeting** — the seam forwarded `overrides` since the
>   seam pass and nothing ever collected one. A Confirm on a show-less
>   proposal now opens a one-field show picker (proactively — before the
>   server has to refuse — and reactively on the overrides-400) and re-posts
>   `{overrides:{showId}}`; a "Folder only" escape keeps the old behavior an
>   explicit choice. Fixed alongside it: `confirmTasksBatch` claimed to
>   re-derive due dates on retarget and never could (propose-time dates
>   pre-filled the field it checked) — a retargeted batch now back-schedules
>   against the target show's own event date. Mutation-tested: drop the
>   overrides from the picker's re-post and walk §26 goes red.
> * **E8 · a proposals review page** — `listProposals` was in the seam,
>   called by nothing, while the bell capped at 8 and showed only YOURS. A
>   nav entry + a bell footer link open the backlog: pending first (the same
>   confirm/reject rows the bell renders, so the two can never disagree),
>   then the resolved record with who decided, when, and the rejection
>   reason. Paged client-side over the fetched answer.
> * **27 · file rename / re-kind** — `PUT /files/:id` took name + kind since
>   the wiring pass; a pencil now sits beside Delete in the viewer meta panel
>   for exactly the people the route accepts (uploader OR folder editor —
>   canDeleteFile's predicate, which is the same server sentence).
> * **D4 · a tech report can BE the attached document** — `tech_reports.file_id`
>   existed, three UI strings promised it, nothing wrote it. The report editor
>   offers "Attach the document you already have": an existing file on the
>   show, or a fresh upload (kind `report`), through the same POST the written
>   form uses. Files-from-other-shows still refused.
> * **9 · the RAG override** — `rag_override` rode the PUT whitelist from the
>   start with no control anywhere. A pencil on the show header's health pill
>   (manager+/pm-owner, the route's gate) sets go/warn/crit/idle or clears
>   back to derived; the client rollup now honors the override exactly as
>   `lib/mappers.js` does, and an overridden pill says **by hand** so a
>   hand-set green is never mistaken for a derived one.
> * **A5 · the template editor saves** — every button on the Templates grid
>   was a toast. The grid now stages row edits/adds/removes in the DOM and
>   **Save** commits the whole grid as one `PUT /api/templates/:id` on the
>   live SOP (the type's oldest row — the one createEvent and Seed-pipeline
>   actually copy from, so the editor's "every show seeded inherits the
>   change" hint is finally true). **Bank a copy** POSTs a snapshot; a
>   versions list shows live-vs-banked and deletes one (`DELETE`, new route).
>   Both new routes are manager-floor, asserted on both halves in smoke §18
>   and mutation-tested (floor lowered to pm → four smoke reds). Fidelity
>   note: the reshape now carries `evidence_type`/`auto_source`/`depends_on`
>   through the editor so a Save cannot strip the flex automation off a type.
> * **A12 · global search** — the decorative topbar input is a real
>   client-side filter over loaded folders/shows/jobs/files (name, venue,
>   city, client, QB number), grouped dropdown, Enter opens the first hit.
>   The empty state says the honest half out loud: there is no server-side
>   search route in this wave, so what was never loaded cannot be found.
> * **D1 · landing by role** — techs land on My Tasks at boot and login;
>   everyone else keeps the portfolio.
> * **Polish:** manual **Archive** button on the season header (admin floor,
>   beside Delete — the honest alternative to it) · finance feed **load-more**
>   and the false "full ledger lands with the backend" sentence deleted (the
>   backend landed; the cap was the client's own) · the Settings **NAS card
>   reads /api/health** — config vs measured last-contact, never a hardcoded
>   green "reachable" (the 2026-08-28 lesson, now in the UI) · **photo tag
>   chips edit in place** (add/remove, pm+ or the shooter — the PUT's whole
>   whitelist is caption + tags and only caption had a control).
>
> **Deliberately cut from this wave, and why:** template owner-role editing
> (the role column is display-only — template roles are planning slugs from
> templates.json, not the five login roles; offering the login-role picker
> would write the wrong vocabulary) · add-a-lane (a lane set belongs to the
> event TYPE's config, not to one template — the button now says so instead
> of toasting a fake success) · the "Preview schedule" toast-button was
> removed rather than faked · season-wide "Apply to all shows" / "Push
> season" stay honestly-not-built · no server-side search route.

> ## STATUS — THE BLOCKER WAVE, 2026-09-03
>
> A read-only editability audit (2026-09-02) re-walked the seam pass's
> "Closed" list against the rendered product and caught one claim that had
> drifted: **C4 was not closed.** The backend and the seam were finished; no
> view rendered an edit or void control, so a wrong amount was still permanent
> — and the walk never reach()ed it, which is exactly how the claim survived.
> C4 is **actually closed now**: a pencil on every expense row in the show
> Financials tab and the job cost table, Void behind the DELETE route's
> manager floor, and walk steps that fail if either affordance disappears.
>
> **Also shipped in this wave, all walk-gated (§20–25):** show + folder
> DELETE behind typed confirms that name the cascade honestly (the routes'
> zero-orphan cascades were already proven in smoke §6) · **Add show** on the
> season dashboard (the template seeds inside the create transaction, so A1 is
> closed without a second call) · **Seed pipeline** in an empty Pipeline tab —
> the season toast that pointed at a control that did not exist now points at
> this one, which does · **Add job** on the folder's jobs panel (C5 closed —
> the second deal the fully-built override mechanic never had a target for) ·
> the milestone add/edit/delete modal plus the missing `PUT /api/milestones/:id`
> (A13/H7), and `viewCalendar` now folds each show's load-in / event / strike
> dates so a production Calendar is never empty · an **API keys card** on
> Settings over the existing routes (list · show-once mint on the temp-password
> pattern · revoke-not-delete; A11's credential story) · **note delete** beside
> the author's Edit, replies cascading · and the last H1 stray:
> `PUT /shows/:id/gear` now pairs its tech floor with an ownership gate
> (canEditProject OR a tech with a crew line on THIS show) — mutation-tested:
> removing the gate turns the foreign-tech smoke assertion red.
>
> **Process note, banked:** the walk only protects what it reach()es — that is
> how a "closed" claim drifted. Every fix in this wave landed with its own
> reach() step in `scripts/persona-walk.mjs`.

> ## STATUS — THE SEAM PASS, 2026-08-28
>
> This document was the workbook for a pass that closed the top ten. What
> follows is the review **as written**; the items below are now done, and the
> gate for all of them is `npm run walk` (`scripts/persona-walk.mjs`, 157
> assertions, an empty database, driven through the real seam).
>
> **Closed:** B1 (crew) · B2 (call-sheet header) · B3 · B4 · B5 (tasks:
> create · edit · re-date · re-lane · delete) · D3 (a tech can report trouble)
> · A2 · A3 (show and folder edit) · C1 (budget lines) · C2 · C3 (contract
> value, deal type — and both are now gated to WRITE as they are to read) · C4
> (correct or void an expense) · B6 (bookings) · B7 (proofs — the hardcoded
> demo flow is gone) · B8 · B9 (PO ETA + tracking, so the delivery alarm can
> fire) · A7 · A8 (the live push has a trigger, and `features.schedulerPush` is
> consumed) · E2 · E3 · E4 · E5 · E6 (the agent review loop, end to end) · F1 ·
> F2 · F3 · F4 · F5 · F8 · F12 (the propagation layer: material-change
> classification, structured diffs, an audience per show, a cross-project
> changelog, dotted action keys) · H1 · H2 · H3 (the gates that carried rank
> and no ownership) · the POLISH_LIST download-button handoff.
>
> **Also fixed, found while walking:** the local storage driver reported
> `ready` with no `STORAGE_ROOT` set, so a container accepted uploads onto a
> disk the next redeploy destroys. It now refuses honestly and `/api/health`
> carries `storageEphemeralRisk`. See `SCHEMA.md`.
>
> **Deliberately deferred** (and why): A1/A5/A6 (add-a-second-show, template
> admin, apply-a-template — an SOP-editing pass of its own), A9/A10
> (on/offboarding), A11 (agent key provisioning — needs a screen and a
> credential story), A12 (global search), A13 (milestone CRUD + calendar),
> B10/D5 (the file/photo *upload* UI beyond what the NAS pass built), B12
> (a Tom decision), B13/B14, C5/C6/C7, D1/D4/D6/D7, E7/E8/E9/E10, F6/F7/F9/F10/
> F11 (generalised "waiting on me", the cross-project crew/schedule/notes
> routes), H4–H11. Everything marked POLISH.


**Method.** Five personas walked end to end through a real month, against the
code rather than the docs: `public/` (what a person can actually click),
`routes/` + `lib/` (what the server will actually accept), `SCHEMA.md`,
`TEAM_FEEDBACK.md`, `INTEGRATIONS_SPEC.md`, `HARDENING_TODO.md`, `POLISH_LIST.md`.

**Not re-registered here.** Everything already tracked is referenced, not
repeated: `HARDENING_TODO` 15–19 (the API rough edges — composite drops job
description, POCs writable only via the call-sheet PUT, `normalizePoc` drops
email, `applyScope` force-stamps verification, `pitch` is TEXT), 20–21 (Flex
create, the fabrication line), the "no cron" gap, `TEAM_FEEDBACK`'s contact
rolodex · rooming lists · the real Run of Show · the QuickBooks API ·
`graph` mail. One agent is concurrently patching users/email; anything it is
mid-fixing is marked **[in flight]**.

**The lens.** Tom, mid-review: *"people who talk to the client don't inform
everyone of what needs to happen — changes fall through the cracks. This needs
to bind us all together, make tasks transparent, keep things from falling
through the cracks."* Section **F** is that question asked at every mutation,
and it headlines the top ten.

Severity: **BLOCKS-DAILY-USE** — a persona cannot complete a normal step of
their month · **FRICTION** — they can, badly or by memory · **POLISH**.
Effort: S ≈ hours · M ≈ a day or two · L ≈ a pass of its own.

---

## A · Tom — owner/admin. Birth of a deal → archive, plus on/offboarding

The New Event flow (F1) is genuinely good: one type choice, one form, one
transaction, folder + show + TEMP-numbered job + seeded lanes + a notify row.
Then the record freezes.

**A1. A folder can never hold a second show.** · BLOCKS-DAILY-USE
`POST /api/shows` exists; `public/api.js` has no `createShow` and no view has an
"Add show" control. The LOVB case in `TEAM_FEEDBACK` — one season, ~7 installs —
cannot be built in the product. → "Add show to this folder" on the season
dashboard, calling `POST /shows` then `instantiate-template`. · **M**

**A2. A show can never be edited after creation.** · BLOCKS-DAILY-USE
`PUT /api/shows/:id` accepts name, venue, city, all three dates, stage, RAG
override, on-site POC, owner, default job, cabinets — and recomputes the whole
back-schedule on a date change. No `api.updateShow`, no `data-act`. A venue
change or a date move is impossible through the product. → An Edit-show dialog
reusing the New Event form. · **M**

**A3. A folder can never be edited.** · BLOCKS-DAILY-USE
Same shape: `PUT /api/projects/:id` (name, client, description, owner, stage,
summary) is unreachable. A client renaming their program is unrecordable. · **S**

**A4. Nothing can be deleted or voided from the UI.** · FRICTION
`DELETE /projects/:id` and `DELETE /shows/:id` exist, are transaction-wrapped,
and are proven zero-orphan by the smoke suite. Neither is reachable. A mis-typed
event is permanent; archive is the workaround and archive is closeout-shaped and
admin-only. → Delete on the folder/show header behind a typed confirmation. · **S**

**A5. Templates admin is entirely a mock.** · FRICTION (BLOCKS the day an SOP changes)
Every control in `tplEditor()` — step name, owner role, T-minus offset, remove
step, add step, add lane, **Save template** — is a `toastAttrs()` fake toast
(`views-global.js` 321–345). `POST /api/templates` has no client method. The SOP
that seeds every event is editable only by editing `templates.json` and
redeploying. · **L**

**A6. A template cannot be applied to an existing show.** · BLOCKS-DAILY-USE
`POST /api/shows/:id/instantiate-template` exists and is only ever called
server-side inside `POST /api/events`. The season dashboard's "Apply to all
shows" is a toast. Any show not born through New Event has no pipeline and no
way to get one. · **S**

**A7. The live scheduler push has no trigger.** · BLOCKS-DAILY-USE
`pushSched()` calls `api.pushToScheduler(showId)` with no `{live:true}`, and the
toast says "(dry run)". The single most-proven integration in the app — 72
assertions against a real staffing instance, pre-flight validation, resumable
fan-out, idempotent re-push — cannot be fired from the product. → A Push dialog
that shows the dry-run payload and problems, then a Send-for-real button. · **S**

**A8. `features.schedulerPush` is served and ignored.** · FRICTION
`GET /api/config` reports it and the README says the UI greys the button; the UI
does not read it. On a box with no `SCHEDULER_BASE_URL` the button is bright
primary and does a rehearsal nobody asked for. · **S**

**A9. Onboarding ends at "they can sign in."** · BLOCKS-DAILY-USE
Add-person mints a one-time password well. But: no email field surfaced
**[in flight]**; no staffing-roster identity, so the push resolves crew by
*name string* and 422s on a mismatch; no Flex user link; and — because of B1 —
no way to put the new hire on a show. The new person exists and has no work. · **M**

**A10. Offboarding mid-show strands the record.** · BLOCKS-DAILY-USE
`active=false` is a clean story for *identity* and no story at all for *work*:
their open steps stay assigned to a person who cannot log in, with no
reassignment prompt; they stay on `crew_assignments`; and an owed `tech_report`
becomes unfileable (only the owner's own session may write it) and therefore
**blocks that show's closeout forever**. → On deactivate, list what they own and
offer bulk reassign; let a pm+ waive an owed report with a reason. · **M**

**A11. Agent keys cannot be provisioned from the product.** · BLOCKS-DAILY-USE (for the agent roadmap)
`GET/POST/DELETE /api/keys` are built, session-only, scope-aware — and have no
client method and no screen. `ARCHITECTURE.md`'s per-teammate agent cannot be
issued a credential without a `curl`. · **S**

**A12. The global search box is decorative.** · FRICTION (BLOCKS at scale)
`index.html` line 38 renders a search input; nothing in `boot()` or the delegated
listener ever wires it. Archiving's whole promise is "out of the working set,
still fully searchable" — the search does not exist. · **M**

**A13. Calendar renders only `milestones`, and nothing creates milestones.** · BLOCKS-DAILY-USE
`viewCalendar()` iterates `s.milestones` only. `POST /api/shows/:id/milestones`
exists with no client method and no UI. In production the Calendar is empty
while its own subtitle promises "load-ins, shows, installs and strikes". → Fold
the four show dates into the calendar directly, then add milestone CRUD. · **S + S**

**A14. Settings states unverified facts as status.** · POLISH
NAS "Status: **reachable**" is a hardcoded string; the Scheduler card says
"Auth: service token" when `SCHEMA.md` records that `SCHEDULER_API_TOKEN` is
retired in favour of programmatic login. Read the real posture from
`GET /api/config` + `/api/admin/mail-status`, as the Notifications card already
correctly does. · **S**

**A15. An admin cannot archive a folder by hand.** · POLISH
`archiveProject` is in the `ACTIONS` table and is rendered by no view — only
`unarchiveProject` (Archive view) and `archiveShow` (closeout panel) appear. F6
promises manual archive for admins. · **S**

---

## B · Brenden — PM. Running Show #1 day to day

**B1 is the one to read first: crew cannot get into a show at all.**

**B1. There is no way to put a person on a show.** · BLOCKS-DAILY-USE
`crew_assignments` has exactly **one** write site in the entire repository —
`routes/schedule.js:576`, behind `POST /api/shows/:id/crew`. There is no
`api.addCrew`, no `data-act`, and `lib/seed.js` seeds no crew. In production a
crew row cannot come into existence.

The cascade is the point:
* the call sheet's crew cards, call times, flights and hotels are always empty;
* `markStruck` creates **zero** tech reports — the UI even has a sympathetic
  string for it ("nobody on the crew has a login, so no report is owed"), so F2,
  a well-built feature with its own table, gates and firewall assertion, is inert;
* closeout condition 2 ("every tech report filed") passes trivially, so shows
  auto-archive with no reports;
* the push sends only crew-lane *step owners* as staff;
* Omar (§D) has nothing at all.

→ A Crew panel on the Schedule tab: roster picker for logins, name+phone for
local hires, role on site, call time; wired to the existing POST/PUT/DELETE. · **M**

**B2. The call-sheet header is rendered everywhere and editable nowhere.** · BLOCKS-DAILY-USE
`load_in_time` · `doors_time` · `event_time` · `strike_time` · `venue_address` ·
`parking_notes` · `radio_channel` · `dress_code` · `venue_poc` · `client_poc` all
render in `tabSchedule()`, the printed call sheet and the push payload.
`PUT /api/shows/:id/call-sheet` exists; no client method, no control. Brenden
prints a call sheet with four blank times. (`HARDENING_TODO` 16 tracks the
*unification* of these fields across routes; this is the missing UI.) · **S–M**

**B3. A task cannot be created.** · BLOCKS-DAILY-USE
`POST /api/steps` exists. No client method, no button. Every step in the system
comes from a template. A PM cannot add "chase the venue about the rigging plot". · **S**

**B4. A task cannot be edited — including being marked blocked.** · BLOCKS-DAILY-USE
`api.updateStep` exists and no view calls it. The only status control anywhere is
`toggleStep()`, which flips done↔todo. So: no due-date change, no re-lane, no
title fix, no `risk` flag, and **no way to set a step `blocked`** — which is the
input the RAG derivation treats as `crit`, the thing the Overview's "Biggest
risk" reads, and the field signal the whole health model is built on. · **M**

**B5. A task cannot be deleted.** `DELETE /api/steps/:id` (pm+) is unreachable. · FRICTION · **S**

**B6. Bookings are read-only.** · BLOCKS-DAILY-USE
`tabBookings()` renders a table and two of its four buttons are `toastAttrs`
fakes ("Paperwork", "Assign"). `POST/PUT/DELETE /api/bookings` exist with no
client method. Trucking, forklift, feeder cable, install and strike labour,
hotels — the entire logistics lane's substance, and the rows the push maps onto
staffing `/api/bookings` — cannot be created. The rooming-list gap in
`TEAM_FEEDBACK` sits on top of a booking that cannot be made in the first place. · **M**

**B7. The proofs tab is a screenshot.** · BLOCKS-DAILY-USE + correctness
`tabProofs()` renders a **hardcoded** six-stage approval flow with invented
attributions — Design/`jhawk`, Internal QC/`lfarkos`, "Sent to client · R2",
"Approved · e-sign" — for *every* show, regardless of what is in `proofs` /
`proof_rounds`. Approve and Request-changes call `proofAction()`
(`app.js` 979–985), which **only fires a toast and calls no API**. This is the
same disease as `HARDENING_TODO` 21, uncaught by that sweep, and it is the print
persona's core workflow. `POST /api/proofs` and `/proofs/:id/rounds` exist. · **M**

**B8. PO `expected_date` and `tracking` are written by nothing.** · BLOCKS-DAILY-USE
They are the sole inputs to the delivery-risk engine — `poRisks`,
`GET /api/procurement/risks`, the Gear-tab strip, the season-row flag, the
Purchasing cockpit's crit/warn counters. `PUT /api/pos/:id` has no client method,
so on real data the alarm can never fire and every PO reads "no ETA". · **S**

**B9. A PO cannot be edited, voided, or have a line corrected.** · FRICTION
No `updatePO`, `deletePO`, `updatePOLine`, `deletePOLine` in the seam (all four
routes exist). A fat-fingered unit cost is permanent and rides the job budget as
committed spend forever. · **S**

**B10. Real files cannot be put in the event folder.** · BLOCKS-DAILY-USE
`openAddFile()` offers five canned types and `commitAddFile()` stamps a
fabricated `size`/`dim`/`meta:'modeled'`; the dropzone reads
`dataTransfer.files[0].name` and **discards the bytes**; "Download" is a toast;
`PUT /api/files/:id/content` — a real byte route with a 100 MB cap — is
unreachable. The Event Folder, whose whole premise is "if the PM is kidnapped by
aliens anyone can pick it up", holds no documents. (`HARDENING_TODO` 21 flags the
fabricated numbers as deliberately not-yet-swept; this registers the missing
capability behind them.) · **M**

**B11. Files cannot be renamed, re-kinded or deleted.** `PUT`/`DELETE /api/files/:id`
exist and the delete has a hand-written cascade. No client method. · FRICTION · **S**

**B12. Only the FOLDER owner can run a show.** · FRICTION — needs a Tom decision
`canEditProject()` grants a `pm` edit rights only when they own the **project**.
A PM who owns a show inside another PM's season folder cannot add crew, edit the
schedule, edit the show or push it. `HARDENING_TODO` 14 settles the
schedule-vs-recap split deliberately; the consequence for a multi-PM season is
that one person is the bottleneck for all of it. → Either grant show-owner rights
on schedule/crew, or make co-ownership explicit. · **S**

**B13. A PM cannot ask "is my spec chain consistent?"** · POLISH
`GET /api/shows/:id/spec-check` exists and is returned inline on a bind; the
front end has no method for it, so the checker's questions are visible only in
the moment a tool binds. There is also no in-app affordance to open the
`?bind-spec=1` popup — correct (the tools own that), but nothing on the Specs tab
tells you which tool to open beyond a sentence. · **S**

**B14. There is no cross-show PM surface.** · FRICTION
My Tasks is *steps assigned to me*. A PM running three shows has no "everything
late across my shows", no "my shows", and no health roll-up narrower than the
whole company portfolio. · **M**

---

## C · Candice — finance. The money month

Purchasing and the exceptions engine are the best-realised money features. The
inputs beneath them are not there.

**C1. Budget lines have no input path.** · BLOCKS-DAILY-USE
`POST /api/jobs/:id/budget` and `PUT/DELETE /api/budget-lines/:id` exist, write
audit activity rows, and feed `budget_total` (derived). The client has
`listBudgetLines` and nothing else. Budget-vs-actual — the *confirmed* accounting
requirement from `TEAM_FEEDBACK` — has no entry surface, so every burn bar in the
app reads against an allotted of zero. The Financials empty state even says
"Candice sets per-category allotments on the job" — she cannot. · **M**

**C2. `jobs.contract_value` is written by nothing.** · BLOCKS-DAILY-USE
Margin = billed − actual, and `billed` is `contract_value`. Nothing in the UI
writes it (the job page offers only the QB number). So the single most-defended
number in the codebase — `stripMoney`, `MONEY_FIELDS`, the recursion into
`job`/`jobs[]`, `hasFinance()` on six surfaces, the whole
admin-or-finance visibility rule — gates a field with no data-entry path. · **S**

**C3. `deal_type` is set once and never editable.** · BLOCKS-DAILY-USE
rental vs sale decides whether received PO lines become E360 capex or job COGS.
It is stamped at auto-create and there is no job edit form. · **S**

**C4. An expense cannot be corrected or voided.** · BLOCKS-DAILY-USE
`PUT`/`DELETE /api/expenses/:id` exist; the client has `addExpense` only. A wrong
amount or a wrong job is permanent, rides the burn, and sits on the chase list
forever. For a finance persona, "no correction path" is disqualifying. · **S**

**C5. A folder cannot get a second job.** · BLOCKS-DAILY-USE
"One show can bill across two deals" is explained in three places in the UI and
is the LOVB league-vs-team-buy case. `POST /api/jobs` exists; there is no
`api.createJob`. The second deal cannot be created, so the override mechanic —
which is fully built on both sides — has nothing to override to. · **S**

**C6. There is no invoiced/AR half.** · FRICTION
Candice's month is *what did we bill, what came in, what is still out*.
Showrunner models cost beautifully and revenue as one static contract number.
`expenses.status` has a `posted` value in the enum that nothing ever writes. The
QuickBooks API is honestly scoped as future in `TEAM_FEEDBACK`; the near-term gap
is that the reconciliation step she performs monthly has no home here at all. · **M**

**C7. The finance feed caps at 14 rows with a demo string.** · POLISH
`viewFinance()` slices to 14 and prints "+N earlier — the full ledger lands with
the backend." The backend has landed and `GET /api/finance/feed` pages. · **S**

**C8. What she does in both systems today, end to end** — worth stating plainly
because it is the gap: she opens Showrunner to read the chase list and to type a
QB job number, and does *everything else* in QuickBooks. Nothing flows back.
Given C1–C6, Showrunner is currently a to-do list for Candice, not a system she
can work in. That is a coherent v1 position — but it is not what
`TEAM_FEEDBACK`'s accounting section describes, and it should be a stated
decision rather than an emergent one.

---

## D · Omar — a tech, on a phone

**D1. Every persona lands on the company portfolio.** · FRICTION (BLOCKS at 6am)
`boot()` renders `projects` for everyone. A tech's actual question — *where am I,
what time, what's my hotel* — is three taps into a folder they must first
identify by name from a table of every event in the company. → Route by role to
My Tasks / a My Day view; make Schedule the default tab on a show that is
running today. · **S** (routing) / **M** (a real My Day)

**D2. Every phone-first surface is empty for a tech in production** — downstream
of B1. The Schedule tab, the "Your day" card, the crew grid, the tech packet and
the report obligation all key off `crew_assignments`. · see B1

**D3. A tech cannot report trouble.** · BLOCKS-DAILY-USE
`PUT /api/steps/:id/status` explicitly admits a tech who owns the step, and
accepts `status` and `risk`. The only control the UI exposes is the done/todo
toggle. The person standing in front of the problem cannot mark it `blocked` or
flag risk — the two signals the whole RAG model consumes. → A status menu on the
task card (todo · in progress · **blocked** · done · n/a) plus a risk toggle. · **S**

**D4. A show report can only be typed, never attached.** · FRICTION
Three UI strings promise "write it in the app **or attach the document you
already have**"; `tech_reports.file_id` exists and nothing writes it, and there is
no upload path anyway (B10). A tech with the report already in Word is stuck. · **S**

**D5. A tech cannot upload a photo.** · BLOCKS-DAILY-USE
`POST /api/shows/:id/photos` and `PUT /api/photos/:id/content` exist. No client
method, no control. The gallery's empty state — "Photos land here when your agent
syncs them" — is honest and also means the photo feature, the recap picks it
feeds, and the client recap's images have **zero human path** in production. · **M**

**D6. No poor-signal story.** · FRICTION
Every view awaits a fetch. The offline banner says "showing the last data
loaded", but a re-render re-fetches, so an arena with no signal shows a blank
call sheet. The print path works and is the honest answer — but nothing tells the
tech to print before they leave. → Either cache the call sheet payload, or make
"Print / save your call sheet" a prompt on the show the day before. · **L** (or **S**, as a prompt)

**D7. Every tech sees every project and every cost in the company.** · FRICTION — needs a Tom decision
`GET /api/projects` is unscoped by role or assignment, and costs are visible to
all *by design* ("budgets → broadly visible", per `TEAM_FEEDBACK`). But budgets
broadly visible is not the same as every field tech reading every vendor invoice
on every deal. Worth an explicit call rather than an inherited one.

**What works and should not be touched:** the printed call sheet, the tel: links
on the POC cards, the "my day" filter, the day chips with a live *Now* marker,
and the whole tech-report obligation flow. F2 is the best-designed feature in the
product. It just has no fuel.

---

## E · The agents — API personas

The server-side agent surface is the most carefully built thing in the codebase:
confidence bands, per-user idempotency committed before the response, provenance,
route-topology denials, no DELETE anywhere. **The review loop that turns an agent
proposal into a human decision is broken in production.**

**E1. No key can be issued** — see A11. Every scenario below is theoretical
until it is.

**E2. The proposal review loop crashes the UI after the server has committed.** · BLOCKS-DAILY-USE
Three defects compound:
* `GET /api/me/inbox` projects a proposal without `created_rows`
  (`routes/notes.js:336-340`), but `api.js:1855` reads `p.created_rows.files` to
  find the real file. The join therefore **never** fires — including for document
  proposals that *do* have a real quarantined file — so every proposal falls
  through to the synthesize branch (`api.js:1858-1866`) and gets `id: -p.id`.
* The bell's "View" calls `openViewer(-88)` → `GET /api/files/-88` → 404.
* "Confirm" calls `confirmDocAct` (`app.js:1010-1015`), which does
  `JOBS_BY_ID[fileJobId(f)]` on a `null` — `api.confirmDoc` returns null for a
  negative id — and `fileJobId(null)` throws on `f.show_id`. **The server-side
  confirm has already committed**; the browser then throws "Something went
  wrong", so the human believes it failed and confirms again.

A tasks-batch proposal renders as *"Tom's agent proposed a doc — tasks_batch
proposal · $—"*, and its 25 derived tasks are never displayed at all. → Project
`created_rows` on the inbox route, or give proposals their own row renderer and
their own detail view. · **M**

**E3. An agent-filed cost never becomes an actual.** · BLOCKS-DAILY-USE
On the high-confidence *filed* path, `POST /api/agent/documents` inserts the
expense at `status='proposed'` (`agent.js:324`) **with no proposal row**. That
row is therefore: in no review queue anywhere; excluded from
`GET /finance/exceptions` (`finance.js:455`); counted as `proposedTotal`, not
`actual`, in the job P&L (`finance.js:392`); and excluded from the agent's own
money context. The only promotion path is `PUT /api/expenses/:id`, which has no
`api.*` method (C4). Every receipt the agent files with confidence lands in a
state nothing can move it out of. · **S**

**E4. The re-targeting mechanism exists and the client never uses it.** · BLOCKS-DAILY-USE
`overrides` is how a human says "this belongs to *that* show"
(`proposals.js:113`, consumed at `:176-190`, `:233`, `:266-268`, `:330-336`).
`api.js:1568` posts `{}`. So a low-confidence, *unattached* proposal — exactly
the case the confidence bands exist to produce — confirms with no show and
creates no expense, and a tasks-batch confirm throws
`400 "set showId in overrides"` that the human has **no way to satisfy from the
UI**. There is no proposal detail screen; the bell row is the entire review
surface. · **M**

**E5. Only *financial* proposals have a confirm button.** · FRICTION
The file viewer renders review actions only when `isFin`
(`views-global.js:595, 604`). A proposed **transcript, spec, contract, recording
or report** has no confirm/reject anywhere except the one bell row, which is
itself broken (E2) and capped. · **S**

**E6. Confirm silently drops what the agent supplied.** · FRICTION
`memo` (`agent.js:326` vs the hard-coded `''` at `proposals.js:215`) and
`match_reason` (written on the filed path, omitted from confirm's INSERT at
`:210-216`) both vanish the moment a human confirms — so the *why* behind a
match survives auto-filing and is lost on human review, which is backwards.
`confirmProject` likewise drops `cabinets`, every scope field, `on_site_poc` and
the four clock times that the human show form sets. · **S**

**E7. Filing what arrives *with* the receipt is impossible.** · FRICTION
The agent can file any `FILE_KINDS` document, a note, a task batch, a project
proposal and a purchase request. It has **no path to a booking, a travel leg, a
crew assignment, a schedule item, a contact, a budget line, a milestone or a
proof** — and cannot add a show to an *existing* project (only inside a new
project proposal, `proposals.js:296`). The same inbox that carries the hotel
receipt carries "your hotel is confirmed", and that is the shape it cannot
express. (Recaps and tech reports are forbidden deliberately and correctly —
`agent.js:21-22`.) · **M**

**E8. There is no proposals page.** · FRICTION
`GET /api/proposals` exists and has no client method. Review happens only in a
popover that caps human items at 8. A backlog after a busy week has no surface. · **S**

**E9. The agent's output lands in forms that don't exist.** · see B/C
An agent-proposed project creates a TEMP-numbered job whose `contract_value`,
`deal_type` and budget lines have no edit form (C1–C3); a confirmed task batch
produces steps with `evidence_type='none'`, no `depends_on`, no assignment
notification, and no way to re-date or re-lane them (B4) — and confirm does
**not** re-check the owner against the roster, so a person deactivated between
propose and confirm still gets the work (A10).

**E10. Meeting → tasks is the designed answer to Tom's north star and is
switched off at both ends.** `POST /api/agent/tasks:batch` is built, atomic,
capped at 25. It needs Teams transcription upstream and a key downstream (A11).
Flagged, not registered — the app side is ready. · see F9

---

## F · Change propagation — "keeping things from falling through the cracks"

This is the section Tom's sentence asks for. The finding, stated once: **the app
records changes thoroughly and tells nobody about them.** 68 activity verbs, 128
`logActivity` call sites, and exactly **four** places in the entire codebase that
enqueue a notification — an @mention, a notify-picker pick, a step assignment,
and a tech-report nag. Nothing that *changes a plan* ever notifies anyone.

**F1. Moving the event date silently rewrites every deadline in the show.** · BLOCKS-DAILY-USE
`PUT /api/shows/:id` recomputes `due_date` for every step with a
`due_offset_days`, logs one row whose detail is **just the show name**, and
notifies only whoever the caller typed into `notify:[]`. Every owner whose
deadline moved learns about it by noticing. → Classify the date change as
material: field-level activity detail, and an auto-addressed notification to the
show's assignees. · **M**

**F2. Marking a step blocked notifies nobody.** · BLOCKS-DAILY-USE
`PUT /steps/:id/status` writes an *accented* activity row for `blocked` — the app
flagging it as significant to itself — and does not call `notifyTargets` at all
and cannot carry a `notify` param. "This is stuck" is the single most
crack-shaped event in the business and it reaches no human. (Compounded by D3:
the tech cannot even set it.) · **S**

**F3. The activity log does not record diffs on the changes that matter.** · BLOCKS-DAILY-USE
Only 14 of ~100 `detail:` strings carry a before→after (`step.assign`,
`step.status`, `chain.bind`, `job.number.confirm`, `budget.line.update`, the user
admin rows, the PO threshold). **`show.update`, `project.update`, `scope.set`,
`gear.update` carry none** — a venue change, an owner change and a date move all
log identically as `show.update · Wrigley Field`. So a "what changed" changelog
**cannot be built from today's log** for the highest-value change types. This is a
capture gap, not only a surfacing one, and it should be fixed first because
everything else in this section reads from it. → Pass the prior row into
`logActivity` and emit `field: old → new` for a named material set. · **M**

**F4. The activity log has one surface, and it is the wrong one.** · BLOCKS-DAILY-USE
`GET /api/activity` filters by `show_id | project_id | po_id | job_id | actor`.
There is **no cross-project mode, no `since`, no relevance filter, and no read
state**. The only place it renders is a per-show Activity tab nobody opens. Every
other event type in this section already has its raw material in that table —
step status, PO status, file adds, budget changes, chain binds, confirms,
strikes, archives. This one is pure surfacing. → `GET /api/me/changes?since=`
scoped to the shows I am on, a "What changed" panel on the show header, and a
rail badge. · **M**

**F5. Assignment is not subscription — nothing has an audience.** · BLOCKS-DAILY-USE
This is the structural root. Being assigned a step, being on the crew, owning the
show or owning the folder creates **no standing interest in anything**. Every
notification in the app is either push-by-name (mention, picker) or a personal
obligation (assignment, nag). Nobody is ever told about a change to a thing they
are *on*. → Derive a per-show audience — owner + folder owner + step owners +
crew — and let material changes address it. `notification_prefs` already exists
per (user, kind) to control the volume, and the digest row already exists to
batch it. · **M**

**F6. The notify picker is doing a job it was not designed for.** · FRICTION
Tony's rule was *"let the actor choose, and don't spam"* — a **suppression**
mechanism. It has become the only propagation mechanism, so the default is
silence. 28 routes accept `notify`; the ones that do **not** are the tell:

* **every recap writer** (generate · edit · approve · reopen · mark-sent) —
  the client-facing deliverable notifies nobody;
* **every tech-report writer** (file · revise · review · reopen);
* **every budget route**, and `PUT`/`DELETE /expenses/:id` — so *creating* a cost
  can notify and *changing or deleting* one cannot;
* `POST /shows/:id/struck`, all four archive routes, `scope/from-spec`,
  `push-to-scheduler`, `instantiate-template`;
* **every step route** — create, update, status, delete. `PUT /steps/:id/assign`
  hard-wires an assignment mail (`core.js:995`) but accepts no caller list;
* every booking and proof writer, `PUT /files/:id`, `POST /spec-bind`,
  `flex/create-element`;
* **`POST /proposals/:id/reject`** — confirm notifies, reject does not, so the
  agent's user never learns their proposal was refused.

`routes/schedule.js` is the one module where **every** mutating route takes it,
including the DELETEs. That is the pattern to copy. · **S per flow**

**F7. "Waiting on me" exists once, for finance only.** · BLOCKS-DAILY-USE
`GET /api/finance/exceptions` emits four kinds (booking · expense · po ·
job_number) and is the app's proven cracks-list pattern. There is no equivalent
for anyone else. A PM's list writes itself from data already present: shows with
no crew · shows past load-in with no bound spec · POs with no ETA · shows quoted
past their event date and never confirmed · shows struck with reports outstanding
· stale chain nodes. Same for the owner (unconfirmed deals, temp job numbers with
activity, closeouts stalled). → Generalise to `GET /api/me/waiting`, one row shape
per persona, one panel component. · **M**

**F8. Schedule edits are silent *by design*, on the wrong axis.** · FRICTION (BLOCKS the night before a show)
`app.js` splits notify on **create vs edit** — "editing a time or caption is
routine and silent". Moving load-in from 08:00 to 05:00 the evening before is an
edit. The split has to be **material vs routine**, not create vs edit: a time or
a day or a `who` change is material; a typo in the detail line is not. · **S**

**F9. Nothing captures the client conversation that starts the change.** · FRICTION → the actual north star
Tom's sentence is about the *upstream*: the call where the client asks for
something. Today the only capture surface is a free-text note on the show, which
pings nobody unless somebody remembers to `@`. The designed answer — the personal
M365 agent turning a meeting or an email thread into tasks via
`POST /api/agent/tasks:batch` — is built on this side and blocked on Teams
transcription plus key provisioning (A11). Worth stating as the plan rather than
leaving it implicit: **the app's answer to "people don't tell each other" is that
the agent tells the app, and the app tells the people.** Both halves are
currently switched off. · **L** (upstream)

**F10. Scope divergence surfaces only inside the scope dialog.** · FRICTION
`GET /shows/:id/scope` returns divergence questions and the checker's
`provisional` flag — visible only to somebody who opens the scope editor. If a
later spec bind contradicts the sold scope, the sales side learns nothing. →
Surface the question as a chip on the show header, and notify the show owner on
bind-induced divergence. · **S**

**F11. There is no cross-project view of the things that fall through.** · BLOCKS-DAILY-USE (Tom's oversight)
`crew_assignments`, `schedule_items`, `milestones` and `notes` have **no
cross-project route at all** — every one is per-show, and `GET /notes` 400s
without an anchor. There is no "who is booked next week", no "every outstanding
tech report across all shows" (`GET /me/reports` is *mine* only), no
"every unconfirmed deal". Expenses, files, photos, proofs, bookings, POs and
steps *do* have global routes — so the pattern exists and was applied unevenly.
Tom cannot ask the system a single question about the whole company that isn't
about money. · **M**

**F12. `routes/schedule.js` logs free-text actions.** · POLISH now, FRICTION later
Every other family uses dotted machine keys (`step.assign`, `po.status`);
schedule/crew/call-sheet log `'added to the schedule'`, `'updated crew'`,
`'updated the call sheet'`. Any changelog, filter or digest built on the activity
table cannot key on these. Fix while the table is small. · **S**

**Where the mechanisms in the brief land, against what exists:**

| Candidate | Verdict |
|---|---|
| (a) per-show "What changed" changelog | **Do it — and it is half-built.** The table, 68 verbs and 128 call sites exist. Blocked on F3 (no diffs on the big verbs) and F4 (no read shape). |
| (b) material-change classification | **Do it first.** It is the cheap primitive both (a) and (c) need, and it fixes F8's wrong axis at the same time. |
| (c) assignment-as-subscription + digest | **Do it.** The delivery machinery is finished — outbox, per-(user,kind) prefs, skip-if-read, digest row, driver. What is missing is only *who to address*. Highest leverage per line of code in this document. |
| (d) generalised "waiting on me" | **Do it.** Proven once in finance; the PM/owner versions need no new data. |
| (e) agent → tasks from client conversations | **The real answer, and both ends are off.** Needs Teams transcription upstream and A11 downstream. Do not let it block (a)–(d). |

---

## G · Cross-cutting: the lifecycle audit, in one table

Every entity, against the checklist. "route only" = the server accepts it, the
product cannot reach it.

| Entity | Create | Edit | Correct/void | Cross-system id | Notifies on change |
|---|---|---|---|---|---|
| project | UI | route only | route only | — | picker only |
| show | UI (composite) | route only | route only | `scheduler_event_id`, `flex_state.element_id` | picker only |
| step | route only | route only (status/assign in UI) | route only | — | assignment only |
| job | auto only | number only | none | `qb_job_number` | none |
| budget line | route only | route only | route only | — | none |
| expense | UI | route only | route only | — | picker |
| booking | route only | route only | route only | — | none |
| purchase order | UI | route only | route only | — | picker |
| PO line | UI | route only | route only | — | none |
| file | UI (fabricated) | route only | route only | `nas_path` | picker |
| file **bytes** | route only | — | — | NAS | — |
| photo | route only (agent path only) | UI (caption/pick) | proposal reject | `nas_path`, `thumb_path` | none |
| note | UI | UI (author) | route only | — | @mention |
| schedule item | UI | UI | UI | — | add only |
| **crew assignment** | **route only** | route only | route only | **none — push matches by name** | none |
| milestone | route only | none | route only | — | none |
| proof / round | route only | none (UI is a mock) | none | — | none |
| deliverable (recap) | UI | UI | reopen | — | bell (awaiting review) |
| tech report | auto (needs crew) | UI (own) | reopen | — | nag ✓ |
| user | UI | UI | deactivate ✓ | **none** [in flight] | none |
| api key | route only | — | route only | — | — |
| contact / POC | JSONB on show, no entity | via call-sheet PUT (route only) | — | — | none |

---

## H · Permission coherence and demo/API parity — found while walking

Not workflow gaps; coherence defects that will bite a persona. Grouped because
they share a cause: gates were written per route rather than per entity.

**H1. Six routes carry a rank check and no ownership check.** · FRICTION
`PUT /bookings/:id` · `PUT /proofs/:id` · `DELETE /proofs/:id` ·
`POST /proofs/:id/rounds` · `DELETE /milestones/:id` · `PUT /shows/:id/gear` all
gate on `requireRole('pm')` **without `canEditProject`**. Any PM in the company
can edit these on anybody's project. Every neighbouring route in the same file
pairs the two. · **S**

**H2. An expense with no `show_id` has no ownership check at all.** · FRICTION
`PUT /api/expenses/:id` only runs `canEditProject` `if (cur.show_id)`
(`finance.js:298-302`). A folder-level or PO-generated cost is editable by any
pm. · **S**

**H3. `DELETE /milestones/:id` and `DELETE /bookings/:id` do not check that the
row exists** and return `{ok:true}` for any id — so a stale UI reports success
for a delete that deleted nothing. · **POLISH · S**

**H4. `DELETE /files/:id` excludes the uploader that `PUT /files/:id`
includes.** A tech may edit the file they uploaded and not remove it. Probably
deliberate; it is not written down anywhere. · **POLISH**

**H5. A PO cannot be voided by the person who raised it.** · FRICTION
`PO_STATUSES` has no cancelled state, `PUT /pos/:id/status` refuses anything but
one step forward (`purchasing.js:730`), and the only correction is
`DELETE /pos/:id` at `requireRole('manager')`. A PM who mis-ordered must find a
manager to destroy the record — there is no reverse and no audit-preserving
void. · **S** (add a `cancelled` terminal status)

**H6. Several rows are unmovable once wrong.** · FRICTION
`expenses.show_id`/`project_id`, `steps.show_id`, `jobs.project_id` and
`files.project_id`/`show_id` are absent from every update whitelist. An expense
filed against the wrong show, a step on the wrong show, or a job in the wrong
folder can only be deleted and re-created — losing its history. · **M**

**H7. `milestones`, `proof_rounds` and `api_keys` have no UPDATE route at all,
and `templates` has neither UPDATE nor DELETE.** Every column is frozen at
create. A mis-scoped key must be revoked and re-minted (fine, and it should say
so); a wrong proof round can only be removed by deleting the whole proof; a bad
template is permanent short of a redeploy — which is the real reason A5 is worse
than a missing UI. · **S–M**

**H8. Demo mode teaches a permission that does not exist.** · FRICTION
`api.js:2015` and `:2030` call `canEditFolderOf(s)` where `var s` is declared on
the *next* line, so `s` is `undefined`; `data.js:2939` returns `true` for an
undefined show. The schedule folder-ownership gate therefore **always passes in
demo** while the server enforces `pmPlus` + `canEditProject`. Anyone learning the
product in demo learns the wrong rule. · **S**

**H9. `confirmPhoto`/`rejectPhoto` skip their own guard when the file is not
cached** (`api.js:2128, 2138` — `else if (f && …)`). · **POLISH · S**

**H10. `addFinancialDoc` and `updatePOStatus` do materially more in demo than in
API mode** — the demo branch flips a PO `received → reconciled`, back-fills
`expense.file_id` on every line, generates actuals and writes activity rows; the
API branch posts once and trusts the server. Where the server does not do the
same work, the demo is a *specification nobody wrote down*. Worth an explicit
check, not a rewrite. · **M**

**H11. `HARDENING_TODO` 21 is partially stale** — `flexPull` and `flexLink` are
no longer `demoOnly()`; both were rebuilt on 2026-08-28 with real API paths and
real refusals. `specGen` is now the only live `demoOnly()` call site. Worth
correcting so the next reader does not re-fix it. · **POLISH · S**

---

## The top 10, by severity × how often you hit it

1. **B1 · Crew cannot be added to a show.** One write site, no client method, no
   button. Silently disables the call sheet, travel, tech reports, closeout
   integrity and the whole field persona. Everything about Omar's day is
   downstream of this one missing form.
2. **F5 · Nothing has an audience.** No entity has subscribers; every ping is
   push-by-name. This is the structural cause of Tom's sentence, and the delivery
   machinery to fix it is already finished — only the addressing is missing.
3. **A2/A3 · A show and a folder can never be edited after creation.** Dates,
   venue, client, owner, POC — all frozen at birth on the app's most-used object.
4. **F3+F4 · The activity log is write-only and diff-less.** 68 verbs, 128 call
   sites, one buried tab, no cross-project read, no before→after on
   `show.update`. The changelog Tom wants is half-built and cannot be finished
   without the diffs.
5. **C1+C2 · Budget lines and contract value have no input path.** Budget-vs-
   actual and margin — the confirmed accounting requirement, and the most heavily
   permission-gated numbers in the codebase — compute from fields nothing writes.
6. **B3+B4 · Tasks cannot be created, re-dated, or marked blocked.** The pipeline
   is template-only and read-only, and the RAG model's primary input is
   unreachable from both directions (PM and tech).
7. **E2+E3+E4 · The agent review loop is broken end to end.** The bell shows a
   synthesized pseudo-file, "View" 404s, "Confirm" throws *after* the server has
   committed, an auto-filed cost lands `proposed` with no queue and no promotion
   path, and the re-targeting mechanism the confidence bands exist to feed is
   never sent by the client. The whole `ARCHITECTURE.md` premise runs through
   this loop.
8. **B10 · No real file upload or download.** The Event Folder — the product's
   founding metaphor — cannot hold a document.
9. **A7 + B6 + B8 · Three proven subsystems starved of their only inputs.** The
   live scheduler push has no button; bookings cannot be created; PO ETAs cannot
   be entered, so the delivery-risk alarm can never fire.
10. **F2+F7+F11 · "Blocked" tells no one, only accounting gets a cracks-list, and
    Tom cannot ask a company-wide question that isn't about money.** The cheapest
    wins in this document: one notify call, and a generalisation of a pattern
    already proven once in `GET /finance/exceptions`.

---

## The patterns behind the gaps

**P1 · The seam is narrower than the server.** ~192 routes; ~115 methods in
`public/api.js`; and the *write* half of eight entities — crew, bookings, budget
lines, milestones, proofs, step-create, file-bytes, api-keys — is built,
role-gated, cascade-wired, smoke-tested, and **unreachable from the product**.
The backend was built to a spec; the client seam was built per feature pass;
nobody ever diffed the two lists. This single pattern accounts for more than half
of this document.

**P2 · Create-forms exist; correct-a-mistake forms do not.** Show, project,
expense, PO, PO line, file, job, note. The system assumes first entry is right.

**P3 · Read surfaces shipped before write surfaces.** Bookings, crew, budget
lines, proofs, milestones each render a rich, thoughtful table of a thing there
is no way to make.

**P4 · Demo fixtures make read-only screens look finished.** `HARDENING_TODO` 21
closed the half where demo code *wrote* fiction into a real database. The other
half is still open: a populated demo store makes a display-only tab look like a
feature, and the same tab is an empty state in API mode. Proofs is still doing
the original thing outright — hardcoded names in the flow, toast-only approve.

**P5 · Notification is push-by-name, never by interest.** Tony's picker was
designed to *suppress*; it has become the only propagation path, so the default
across the product is silence.

**P6 · The audit log is a write-only ledger.** Rich vocabulary, no diffs where it
matters, one surface, no read state, no cross-project view — and one route family
logging free-text English instead of machine keys.

**P7 · Features are validated at the row level, never at the workflow level.**
F2's tests all pass and F2 cannot fire, because nothing can create a crew row.
Closeout counts reports that cannot exist. Delivery risk reads a date nothing
writes. Margin gates a number nothing enters. Every one of these has green tests.

**P8 · Entities lack foreign identities.** Users carry no staffing or Flex id —
which is exactly why the push matches crew by *name string* and 422s on a
mismatch. Contacts are not an entity (JSONB on shows, free text on POs). Jobs
carry a QB number with no sync. `TEAM_FEEDBACK`'s rolodex is the right fix and is
load-bearing for more than it looks.

**P9 · Config flags are served and not consumed.** `features.flex` is honoured;
`features.schedulerPush` is not. `GET /api/stages` exists so the SPA need not
hardcode the vocabulary, and the SPA has no method for it.

**P10 · Honest empty states are standing in for missing capability.** Several
screens explain beautifully why they are empty. The prose reads as design
restraint; the cause is that no human path exists. This is the most dangerous
pattern here, because it makes an incomplete feature feel deliberate.

**P11 · Gates were written per route, not per entity.** Six routes carry a rank
check and no ownership check while their immediate neighbours carry both; an
expense without a show has no check at all; delete includes the uploader in one
place and excludes them in another. Nothing here is wrong on purpose — each was
correct in isolation. `hasFinance` / `canApprovePO` / `canApproveRecap` prove the
house rule (one decision, one expression); it was applied to the *hard* questions
and not to the routine ones. *(§H)*

**P12 · The client seam quietly drops what the server designed for.** `overrides`
is the whole re-targeting mechanism and the client posts `{}`. `created_rows` is
the join the bell needs and the route does not project it. `memo` and
`match_reason` survive auto-filing and are lost on human confirm. `features.
schedulerPush` is served and ignored. Each is one line; together they are why the
most carefully engineered subsystem in the product does not work end to end.

---

## The pre-build checklist — so a brief stops shipping these

Put this at the top of every feature brief. Nine of the ten patterns above are
caught by items 1–4.

1. **List the entity's five verbs before writing a route.** create · read ·
   **correct** · **retire/void** · **who else finds out**. Any "n/a" must be
   written down with its reason. *(P2, P5)*
2. **Every route in this feature is reachable by a named persona on a named
   screen, in the same change.** A route with no `api.*` method and no `data-act`
   is not shipped — it is a liability with a passing test. *(P1, P7)*
3. **Every field the feature renders must name the form that writes it.** If a
   screen displays `expected_date`, the brief says which dialog enters it. Run
   this as a literal two-column list. *(P3, P7)*
4. **Name the audience of every mutation.** "Who is affected, and how do they
   find out without the actor remembering to tell them?" Silence is a legitimate
   answer *once it is written down*. *(P5)*
5. **Classify each mutation material vs routine at design time** — never
   create-vs-edit, which is the wrong axis and already wrong in the schedule. *(P5)*
6. **Material mutations log a diff and a dotted key.** `logActivity` gets
   `field: old → new`; the action is `family.verb`, never a sentence. *(P6)*
7. **State the foreign identities on day one** — staffing id, Flex id, QB number,
   NAS path — even as nullable columns nothing populates yet. Retrofitting an
   identity onto a populated table is the expensive version. *(P8)*
8. **Demo the feature in API mode against an empty database before calling it
   done.** If the screen is empty and there is no button that fills it, the
   feature is not finished — however good the empty state's prose is. *(P4, P10)*
9. **If a field persona touches it, name the phone answer** — and if the answer
   is "print it beforehand", something in the app has to say so at the right
   moment. *(D6)*
10. **Name the agent path.** Can an agent propose this? If not, say why. The
    inbox agent's blind spots (bookings, travel, crew) were never a decision —
    they are what happens when nobody asks. *(E2)*
11. **Name the upstream.** What happens *outside* the app that should have created
    this row, and what is the capture surface for it? This is Tom's question, and
    it is the one a feature brief almost never asks. *(F9)*
12. **Write the gate once, per entity, not per route.** State the entity's
    predicate — rank *and* ownership — in the brief, then assert every route in
    the family uses it. The house already does this for the three hard
    predicates and not for the routine ones. *(P11, §H)*
13. **Trace one round trip field-by-field before calling an integration done.**
    Not "does it 200" — does every field the sender put in arrive, and does the
    receiver read the field the sender actually sent? Four of this document's
    sharpest defects are one-line mismatches between two halves that were each
    built correctly. *(P12, E2–E6)*

---

## Verdict — how far from "a team can live in this daily"

**Not far in engineering, further than it looks in product.**

The backend is genuinely good: 37 tables, 192 routes, additive-only migrations,
hand-written cascades proven zero-orphan, one expression per decision on the
hard predicates, a content firewall enforced as a topology fact, an agent surface
with real confidence bands and real denials. Almost nothing in this document is a
*rewrite*. Most of it is a form, a client method, or one line that connects two
halves that were each built correctly.

But the honest test — *can each of the five people do their month in this?* —
comes out:

* **Tom** can open a deal and archive it. He cannot edit it, add a second show,
  edit the SOP, push it for real, search, or ask the system one company-wide
  question that isn't about money.
* **Brenden** can work a template pipeline and run purchasing. He cannot add a
  person to his show, set a call time, create a task, mark one blocked, book a
  truck, upload a file, or enter the delivery date the risk alarm reads.
* **Candice** can read the chase list and type a QuickBooks number. Every other
  number she needs — allotments, contract value, deal type, a corrected
  expense — has no entry path, so the P&L computes against nulls.
* **Omar** has nothing, because nothing can put him on a show.
* **The agents** have the best-engineered surface in the product and a review
  loop that throws after it commits.

Two counts say it most plainly. **`crew_assignments` has exactly one write site
in the repository and no way to reach it** — and F2, F6, the call sheet, travel
and the entire field persona hang off it. And **the write half of eight entities
is built, gated, cascade-wired, smoke-tested and unreachable** — the backend was
built to a spec, the client was built per feature pass, and nobody diffed the two
lists.

The distance to daily use is roughly: **the seam gap** (crew · call-sheet header ·
step create/edit · bookings · budget lines · contract value · file bytes · PO
edit — mostly forms over routes that already exist), then **the propagation
layer** (material-change classification, an audience per show, a "what changed"
read — the delivery machinery is already finished), then **the agent loop's
four one-line fixes**. That is weeks of focused work, not a rebuild.

The risk is not the size of the list. It is that every item on it passed its own
tests. Nothing here will be caught by more testing of the same kind — it is
caught by walking a person through a month against an empty database, which is
what item 8 of the checklist exists to force.
