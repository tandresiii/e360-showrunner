# Showrunner — Team Feedback & Requirements

Running log of requirements gathered from the team's responses to the "first look + your wishes" intro emails (management version + employee version, Aug 2026). Fold these into the build.

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

## (more team wishes to be added here as responses come in)
