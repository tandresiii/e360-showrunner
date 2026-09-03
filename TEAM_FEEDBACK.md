# Showrunner — Team Feedback & Requirements

Running log of requirements gathered from the team's responses to the "first look + your wishes" intro emails (management version + employee version, Aug 2026). Fold these into the build.

> **BUILT in the first post-deploy release (2026-08-27):** *Notification control*
> (its email-delivery and event-creation bullets included) · *Tech show reports* ·
> *Scope line + lifecycle + archiving*. Schema, routes and env vars are in
> `SCHEMA.md`; the one honest gap is that **nothing runs on a timer** — digests
> and the auto-archive sweep run on boot and on demand until a real scheduler
> exists, and the Graph `sendMail` driver is skeletoned pending the `showrunner@`
> mailbox + app registration. Everything else on this page is still open.

## THE FIRST REAL-USER BUG REPORT (Brendon Sawyer, manager · `bsawyer`, 2026-08-31)

The first teammate to actually work in production, on Show 1, filing his own
booking paperwork. Via Tom, verbatim: **"weird form, and it's wrong, and he
can't delete it."** Three sentences, three separate defects, all in one motion —
and worth keeping on this page rather than only in `HARDENING_TODO`, because the
*shape* of the report is the lesson.

| What he said | What was actually wrong |
|---|---|
| "weird form" | The financial attach-doc modal asked for a **vendor, an amount and a doc type — and never for the document.** Nobody notices a missing field on a form they have never seen do the right thing; they just feel it. |
| "and it's wrong" | It stamped every row **245,760 bytes** — a constant that looks like a PDF — and uploaded nothing. The viewer then told him, correctly, the bytes were not there, so the app contradicted itself on two screens. |
| "and he can't delete it" | `DELETE /api/files/:id` had existed since the wiring pass, transactional and cascade-correct, and **nothing in the product called it.** Built, tested, unreachable — `DESIGN_GAPS` P1 exactly. |

**All three fixed 2026-09-01** (`HARDENING_TODO` 21b): the form carries the file
and moves real bytes or creates nothing; a Delete affordance on every file card,
the viewer, and booking rows; two permission gates levelled so the person who
filed a thing can retract it. His three empty rows were removed from production
after the deploy; his bookings were left alone.

**The standing lesson, for every pass after this one:** the disease is not the
constant, it is *a screen that collects less than it claims to*. Grade a form by
asking what it would write if the person filled in every visible field and
nothing else — and if the answer contains a number nobody typed or measured, the
form is lying. `persona-walk.mjs` §12b now enforces that mechanically over every
file-creating call in `app.js`.

## Accounting / Finance — CONFIRMED requirement (from Accounting, 2026-08-21)
Accounting doesn't need the PM tool itself, but needs the **financial/accounting workflow to flow to them from every project** — orders, bookings, reservations, scheduling, invoices, receipts, confirmations — so they can stay ahead instead of finding out after the fact ("a lot of stuff isn't communicated to me until after the fact").

Build as a first-class **Accounting/Finance role + view**:
- **Cross-project finance feed** — every money-relevant event (order / booking / reservation / schedule / invoice / receipt / confirmation) surfaces to accounting, **tagged to its project**. Captured as a *byproduct* of people doing normal work in the app — no reliance on anyone remembering to loop accounting in.
- **"Waiting on me" exceptions list** — items booked/ordered where the invoice / confirmation / receipt hasn't reached accounting yet → flagged so they chase *ahead* of time.
- **Accounting's own agent** (per the MCP architecture) watches for invoices/receipts in their inbox, matches each to the right project, and flags what's still missing.
- This is the **job-costing / per-event P&L** sketched early on (the controller pain point) — now confirmed by the stakeholder. Bake in from the start, not bolted on.

### Financial documents + QuickBooks link (from Tom, 2026-08-21)
- **Financials / receipts element per job** — receipts, invoices, purchase orders, and confirmations attach to the job (a typed financial-docs category on top of Files). Feeds the Accounting view and the "waiting on me" exceptions.
- **QuickBooks job-number tag (the linking key).** Each Showrunner job carries the **QuickBooks job number Candice creates in QB** (`qb_job_number`), tying Showrunner ↔ QuickBooks so every doc/expense reconciles under the same job. Confirms accounting's stack = **QuickBooks** (answers the build plan's open "what does accounting run on?" question). Candice = accounting/QuickBooks owner.
  - **Near-term:** Candice creates the job # in QB → entered on the Showrunner job → all financial docs/expenses inherit it.
  - **Longer-term:** QuickBooks has an API — Showrunner could sync the job and push/pull POs/invoices/actuals (draft-first, human-approved). The job number is the anchor that makes real two-way job-costing possible. QB-first is the assumed origin of the number.

### Budgets + real-time profitability (from Accounting, 2026-08-21)
- **Budget lines per job/category** (esp. travel) — what's allotted / billed to the client. Everyone (per permission) can see their **allotted travel budget** and what's left.
- **Actuals flow from the finance feed + bookings** (receipts/invoices/POs/expenses tagged to the job) → **budget vs. actual, live** per category.
- **Real-time project profitability** = billed (revenue, via the QuickBooks link) − costs, updating as costs land. True profit, not just cost — the QB integration makes the revenue side real.
- Honest caveat: "real-time" = as-real-as-the-data-in; unrecorded costs aren't visible until recorded — exactly what the "waiting on me" exceptions surface.
- **Visibility is a permission choice:** budgets → broadly visible (accountability); full margin/profitability → likely role-gated to management/accounting.

### Adoption / "force people's hands" (from Accounting, 2026-08-21)
Strategy, not a single feature. Key lever: **the per-user agent does the data entry**, so consistent use doesn't depend on discipline. Plus: make it the single source of truth (schedule, pull sheets, packets, per diems, itineraries live there); gentle gates (the things people want — call times, itineraries, getting paid — come out of the app); visibility (nags/flags show who's current). Tool makes it easy; leadership sets the expectation.

## Deliverables & onsite (from a crew/onsite lead, 2026-08-21)
All three are **agent-generated deliverables from the event folder's data**:
- **Post-event client recap** — agent drafts a recap (what happened, highlights, maybe show stats) WITH event photos, to send the client. Post-strike closeout step; draft-first, human approves before it goes out.
- **Event photo organization** — agent sorts/names event photos into **per-event folders on the NAS**, tags them to the event, surfaces them in the folder's Files, and feeds the recap. **Storage = the NAS (already decided)** — Railway/Postgres holds only metadata + the NAS path; big media doesn't belong in the DB. Slots straight into the existing two-tier file model (`INTEGRATION.md`).
- **Run of show for onsite staff** — agent generates a per-show, **day-by-day** call sheet: setup/load-in times, each person's flights + hotels, POCs, schedule. This is the PM version of the staffing app's existing **"Tech Packet"** (already pulls per-tech flight/hotel/crew/contacts) — data's largely modeled; mostly generation + formatting.

## Notes / messaging between users (from Tom, 2026-08-21)
Users can send notes to one another inside the app. **Decided model: anchored comments + @mentions** (not DM chat — Teams covers that):
- Comment threads live **on things** — an event, a task, a file, a financial doc — never free-floating.
- **@mention** a teammate to ping them; each user gets a personal **inbox of mentions/replies**.
- Threads stay attached to their context, so per-user agents can read the conversation on the item they're filing into; the mentions inbox complements accounting's "waiting on me" exceptions pattern.

## Purchasing / procurement (from Tom, live use case, 2026-08-21)
Context: LOVB season planning meeting — ~7 installs needing new LED systems, power ancillaries, LED processors, etc. Purchasing must be a first-class element, not just a "PO" file kind:
- **Purchase orders as real records** — po_number, vendor, line items (item/qty/unit cost), job allocation, linked show(s), expected delivery.
- **Lifecycle:** needed → quoted → ordered → shipped → received → invoiced/reconciled. Each stage feeds accounting's finance feed; gaps feed **"waiting on me"** (ordered-but-no-invoice, and the ops version: **ordered-but-not-received with load-in approaching** → risk flag on the show's gear lane).
- **Season-scale ordering:** one order can serve many installs — PO lines allocate across shows/jobs (LOVB: league deal vs team-buy jobs).
- **Gear linkage:** received hardware should flow toward Flex inventory / kit building (LED systems bought for installs become pull-able gear).
- Open questions: (a) PO approval step — who signs off before an order goes out (management? threshold-based?); (b) owned-inventory vs job-cost split — when E360 buys LED systems, is it capex E360 keeps (Flex inventory) or cost-of-goods billed to the job — or both, per-line?
- Meta: this very meeting is the agent-API use case — once Teams transcripts go live, "derive the purchase list + tasks from this meeting for the LOVB shows" is exactly `create_tasks` / a future `create_purchase_request`.

## Run of Show — the REAL one (from Tom, 2026-08-21)
Terminology correction + future feature. "Run of show" = the production document showing **what plays when** — the content/playback sequence during the show (sponsor loops, game presentation, cues). The day-by-day crew/times feature is a **Schedule** (+ printable Call Sheet), NOT a run of show. Future: an actual Run of Show document per show — content cue sequence, tied to the specs/content chain (.e360 world) and possibly the render engine's playback. Natural `deliverables.kind` addition when built.

## Notification control — sender chooses who gets pinged (Tony, relayed by Tom 2026-08-21)
The staffing app largely missed this; Showrunner must not. Principle: **notifications are opt-in and chosen by the actor.**
- Creating a folder, assigning a task, or any significant action → the actor can **pick exactly whom to notify** (one, several, or nobody) at the moment of the action.
- Simple edits / routine touches → **silent by default**; must never spam the team.
- The notes model already embodies half of this (@mention = deliberate ping; plain comments ping no one). Extend the same choice to assign-task, folder/show creation, and other mutating flows: a lightweight "notify: [people picker | nobody]" affordance in those dialogs.
- Feeds the future notification surface (bell today; email/Teams digests later via the per-user agents — still sender-chosen).
- **Email delivery (Tom, 2026-08-27):** yes — assignments/mentions should be able to reach the user by email. Design: dedicated M365 mailbox (showrunner@) sending via **Graph Mail.Send** (app registration, admin-consented, ApplicationAccessPolicy-locked to that mailbox); per-user preference immediate/digest/off (assignments+mentions immediate by default, rest digested); skip send if read in-app first; rides the existing notify/read-state machinery. Also powers the tech-show-report nag. System mail ≠ agent outbound — file-don't-fire is untouched. Needs: mailbox + app registration from the M365 admin, creds as Railway env vars. Build: first post-deploy pass (with tech reports).
- **Event creation MUST carry the notify option** (Tom, 2026-08-27, from his own staffing-app blind spot: "I can email itineraries, but when I add an event I should have the option of letting people know about it"). The New Event / new show flow — still the app's last mock button — gets built post-deploy WITH the notify-picker row (crew/team selection, default nobody, one click to "everyone assigned"), delivering via bell + email once the mail layer lands.

## Contact rolodex (from Tom, 2026-08-27)
First-class cross-project contact directory in Showrunner — currently contacts are scattered (show POCs as JSONB, vendors as free-text strings on bookings/POs, local hires inline in crew assignments; the staffing app has venue/client contact tables; Flex holds contacts too).
- **contacts** entity: name, org, kind (client | venue | vendor | crew/local | freight | other), phone(s), email, notes, tags; linked from shows (POCs become references), bookings/POs (vendor becomes a reference w/ free-text fallback), crew assignments (local hires), call sheets (POC cards pull live).
- **Import/sync:** seed from the staffing app's venue-contacts + client-contacts (absorption path) and from Flex's contact records (API permitting — check FLEX_CAPABILITIES). Dedupe by name+org fuzzy match, human-confirmed.
- Rolodex UI: global nav or Settings-adjacent; searchable; per-contact "appears in" (shows/POs/bookings). Agents file new contacts as proposals (an email signature is a contact source — rides the existing proposal machinery).

## Rooming lists (integration testing finding, 2026-08-27)
Showrunner has no rooming-list concept: a hotel booking covers ONE staffAssigned, so a block covering six techs leaves five with no lodging on their tech packet (surfaced during live-push testing — the packet correctly rendered nothing). Feature: hotel bookings/blocks carry a rooming list (person ↔ room/confirmation), feeding the push's per-person hotel rows and the call sheet's crew cards.

## Tech show reports — REQUIRED after every show (from Tom, 2026-08-27)
Every tech on a show's crew must file a **post-show report**: log in, write the doc in-app (or upload one) straight to the event folder.
- **Required, not optional** — auto-created as a task for each crew member when the show ends/strikes; nags in My Tasks + bell until submitted; the show owner sees who still owes theirs ("waiting on" style). This is also an adoption lever (the accounting stakeholder's "gentle gates": things people must do come through the app).
- Techs CAN write/submit their own report; they can NEVER approve/sign off show reports — **sign-off = admins and/or project managers only** (Tom's rule, confirmed 8/27; matches the hardening fix).
- Report lands in the event folder (internal doc — NOT client-facing; the recap content firewall must never read report bodies).
- Freeform first (editor + upload); a structured template (issues / gear damage / venue notes / hours) can come later.

## Scope line + lifecycle + archiving (Tom, 2026-08-27 — CONFIRMED spec)
**1. Scope line — "what we're delivering," structured per show.** Typed fields per event type (LED: linear feet / cabinet count / cabinet type+pitch; Print: pieces / sqft; Both: both), rendered compact everywhere: `LED · 800′ · 144× P10`. **Auto-filled/verified from the bound spec** when one exists (stack-aware count via speccheck), hand-entered before that; divergence from a later-bound spec surfaces as a checker question. Client-safe → feeds recap stats. Display: show header, season rows, projects table, call-sheet header.
**2. Commercial lifecycle.** quoted → **confirmed** → in progress → delivered → closed → archived. **Confirm = explicit action, admin/PM only, means the client committed (signed/PO'd)** — datestamped + logged (confirmed_by/at). Confirming is the natural trigger moment for: temp job number → real QB number (Candice), and scheduler-push unlock.
**3. Archiving.** Auto-archive **60 days after closeout complete** (closeout = recap sent + all tech show reports filed + financials reconciled — machine-checkable); manual archive/unarchive for admins. Archived shows: hidden from default views ("we don't want 300 in our normal area in a year"), fully searchable/browsable via an Archive filter/view, season rollups unaffected.

## "One event, everywhere" — Flex event-folder creation + entity sync (Tom, 2026-08-27)
Core principle, Tom's words: "Why do I have to make an event folder in multiple places?" Creating an event in Showrunner should propagate everywhere it needs to exist — scheduler (DONE, live push), **Flex event folder (build)**, NAS folder skeleton (comes with storage wiring), calendar facets.
- **The Flex dependency chain:** Flex event folders reference clients/venues that must exist in Flex's contact directory first. Solution: the **contact rolodex is the Rosetta stone** — each Showrunner contact/venue record carries external refs (`flex_contact_id`, staffing ids). On "create in Flex": if the client/venue lacks a flex ref, create it there first (or match an existing one by name, human-confirmed on ambiguity), store the ref, then create the event folder. Port the existing Flex address book INTO the rolodex on first sync so most entities pre-match.
- Probes must confirm: Flex contact/venue creation endpoints + the event-folder create path (the existing staffing flexCreate flow is the proven base; the survey's probe plan covers the rest).
- Propagation is explicit and per-facet (a button/action per target with status chips: "In scheduler ✓ · In Flex ✓ · NAS ✓"), not silent — same file-don't-fire posture, human sees what exists where.

## THE NORTH STAR (Tom, 2026-08-28 — grade everything against this)
"We have a big problem with people who talk to the client not informing everyone of what needs to happen. Or changes, or whatever. **This needs to bind us all together. It needs to make our tasks transparent. It needs to keep things from falling through the cracks.**"
The test for every feature: *a change made anywhere becomes visible to everyone it affects, without the person who made it having to remember to tell anyone.*
- **Resolves the notify tension deliberately:** Tony's rule (sender picks who gets pinged; routine edits silent) governs *ad-hoc* pings. Tom's rule governs *material changes* (dates, scope, specs, schedule, confirm/stage, budget): the show's assigned team is AUTO-informed — subscription by assignment, not by the changer's memory. Digest-friendly so it binds without spamming.
- Needs (candidate mechanisms, coherence review to refine): a per-show **"What changed" feed/changelog** everyone on the crew sees; material-change classification on mutations; assignment = subscription; the client-facing person's inputs (calls, emails, meetings) becoming tasks via the agent pipeline (the transcript toggle is upstream of this); "waiting on me" generalized beyond finance (everyone has a cracks-list).

## Gear history — snapshot the pull sheet (Tom, 2026-08-28)
"Would like to look back and see what gear was used on previous events." The Flex LINK is stored (flex_state) but sheet contents are live-read only — no historical record survives Flex edits/archival. Build:
- **Snapshot on strike/closeout (auto) + on-demand button**: persist the normalized pull-sheet JSON (the flexReadPullSheet shape — groups/items/qty/serials/pack-status) as a permanent record on the show (spec_renders-style row or a files entry + render), stamped with fetchedAt. Renders/prints forever from the DB, independent of Flex.
- Multiple lists (pull sheet + manifest) each snapshotable; re-snapshot supersedes (keep history, never overwrite — supersede pattern).
- **Future unlock**: cross-event gear search over snapshots ("when did we last send the Lex 400 · which shows used BP2s"), gear-usage stats per season. The snapshot table is the foundation.
- Fits the north star: the gear record becomes part of the event folder's permanent truth, not tribal memory in Flex.

## Spec lifecycle controls (Tom, 2026-08-28)
"Should be able to delete spec sheets, or unbind them from a show, or mark them old — sometimes specs change after sending one." Supersede-on-rebind already exists (bind the new spec → old auto-marks superseded, kept for history). Build the manual half:
- **Mark outdated / withdraw** a bound spec WITHOUT a replacement (status 'superseded' or a new 'withdrawn', chain node reverts to needs-spec, downstream stale-flags) — for when the deal changed and no new spec exists yet.
- **Unbind** (detach from the chain node, file survives as a plain document) vs **Delete** (the route exists, admin/uploader-gated — needs a UI affordance with a real confirm; spec_renders cascade already handled).
- **Version history UI**: per chain node, a "versions" list showing superseded/withdrawn specs (they're queryable by status today, just unsurfaced) — open/print any old rev, see who bound what when. Discoverability note on the Specs tab: "binding a new spec retires this one automatically."

## (more team wishes to be added here as responses come in)

## Per-system ancillary checklist (Tom, 2026-09-02) — SHIPPED 2026-09-02: the per-job Needs List — seed the standard LED ancillaries onto a job, check items off or strike them n/a, and raise everything still open as ONE PO at needed, each item linked back to the order that covers it.

## Purchasing polish pass (Tom, 2026-09-02: "i want the purchasing thing to work awesome") — SHIPPED 2026-09-03: the PO lifecycle is now fully correctable from the UI — edit vendor/memo/number after creation (the raise-from-needs TBD vendor is one obvious click to fix), edit/remove lines while needed/quoted (frozen with a visible reason once ordered), delete a PO (manager+) with honest consequences (covered checklist items reopen, landed costs stay on the books unlinked); the raise-from-needs flow opens a picker — choose WHICH open items go to WHICH vendor, the rest stay open for the next raise; the $5k approval copy reads the live threshold everywhere instead of hardcoding it, and marking a PO quoted over the gate says out loud who must approve.

## Push choice new-vs-existing + update pushes (Tom, 2026-09-02) — SHIPPED 2026-09-03: pushing to staffing now forks — create a new event, or link an existing one (searchable picker) and push INTO it; linked shows show "Pushed <ago> by <who> · event #N" with a stale dot and a one-click "Push updates"; keep-vs-override chosen fresh at every linked push (keep is the default and never touches hand-entered staffing rows — proven and mutation-tested against a local fake scheduler); unlink clears only the local binding. Live env vars still land tonight — every path answers the honest 501 until then.

## Editability blocker wave (audit 2026-09-02) — SHIPPED 2026-09-03: everything the read-only audit flagged as built-but-unreachable now has its door — correct or VOID an expense from the row it lives on (the C4 "closed" claim that had drifted; corrections are audited with a before→after); delete a show or a whole folder behind a typed confirm that names the cascade honestly; Add show on the season dashboard (template seeds in the same transaction); Seed pipeline on an empty show's Pipeline tab (the toast that pointed at a control that didn't exist now points at one that does); Add job on the folder — the second deal the billing-override mechanic never had a target for; a milestone add/edit/delete modal plus the PUT route that was missing, with the production Calendar now folding every show's load-in/event/strike dates so it is never empty; an API keys card on Settings (show-once mint, revoke-never-delete — the front door for everyone's M365 agent); Delete beside a note author's Edit (replies cascade); and the last stray permission gate — a tech can only write gear/Flex state on a show they're actually crewed on. Every fix carries a persona-walk step so none of it can silently regress again.

## Editability rough+polish wave (audit 2026-09-02, tier 2) — SHIPPED 2026-09-03: the doors that stuck and the copy that lied — an agent proposal that named no show gets a one-field show picker (proactively, and on the overrides-400) and re-posts {overrides:{showId}} so the cost finally lands where the human points; a Proposals page past the bell's cap of 8 (pending confirm/reject rows first, then the resolved record with who decided and the rejection reason); Rename / re-kind beside Delete in the file viewer (a receipt filed as "Document" never reached Accounting's feed — now one click fixes it); "attach the document you already have" on show reports is real (existing file on the show or a fresh upload — the report keeps its body and gains its file); a health-pill override on the show header (go/warn/crit by hand, "by hand" marker, one click back to derived); the template editor's Save button actually saves (PUT on the live SOP, Bank-a-copy snapshots, a versions list with delete — manager floor, mutation-tested); the topbar search searches what's loaded (folders/shows/jobs/files, honest about having no server-side search yet); techs land on My Tasks at boot; and the polish quickies — an admin Archive button on the season header, finance-feed load-more with the false "full ledger lands with the backend" sentence deleted, the Settings NAS card reading the live /api/health probe instead of hardcoded green, and photo tag chips that edit in place. smoke 796→816, walk 273→322, every fix reach()-gated.
