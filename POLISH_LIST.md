# Polish list — Tom's tour feedback (collect here, fix in ONE consolidated Opus pass)

**Items 1–5 are DONE** (consolidated pass, 2026-08-27). Outcomes are one-liners
under each item; the detail lives in `SCHEMA.md` and `INTEGRATIONS_SPEC.md`.

1. **Terminology: "Run of Show" is wrong for the day schedule.** (Tom, 2026-08-21) In our world, *run of show* = the document highlighting the production and **what plays when** (content/playback sequence). The day-by-day crew/times feature should be **"Schedule"** (tab label, headers, empty states); the printable stays **"Call Sheet"** (already correct). Rename user-facing strings; internal identifiers (ROS_*, .ros-*) may rename opportunistically. Reserve the "Run of Show" name for a future what-plays-when document (see TEAM_FEEDBACK).
   > **DONE.** Front-end copy renamed; backend user-facing strings (activity actions, notify summaries, the pm+ 403) renamed too. The assembled sheet is now served from **`GET /api/shows/:id/call-sheet`** — canonical, and it finally pairs with the `PUT /api/shows/:id/call-sheet` that edits its header — with **`/run-of-show` retained as an alias on the same handler**. It could not simply move to `/schedule`: that path is already the schedule *items* collection (GET list · POST create), a different resource. `public/api.js getSchedule()` calls the canonical name; smoke asserts both paths return identical bodies.

2. **Notify-picker on mutating actions** (Tony's requirement, see TEAM_FEEDBACK "Notification control"). Assign-task, create-folder/show, and similar dialogs get a lightweight "Notify: [people picker | nobody]" affordance; routine edits stay silent by default. @mention model already covers notes.
   > **DONE** (earlier in this pass). Every route the app stages a notify before now implements `notify:[…]` server-side — files, expenses, chain-node PUT and proposal-confirm included — so the ping is written in the same transaction as the change. `sendNotifies()`'s local-delivery branch is retained on purpose for demo mode and as a degradation path, and now says so.

3. **Roles + PO approval set** (Tom, 2026-08-21): **Tom, Tony, Jim = admins** in the roster. **PO approval over the threshold = the three admins + Candice** (she approves too, via her finance capability — not the generic manager+ predicate currently implemented). $5k threshold itself stands. Update roster seeds, `approvePO` gating, approval-queue visibility (all four see the queue), and Settings copy.
   > **DONE** (earlier in this pass). One predicate — `role === 'admin' || finance` — behind `canApprovePO()` on the server and `canApprovePOs()` in every render site.

4. **Margin visibility = admin OR finance** (Tom, 2026-08-27: "all admins can see margins"). Front-end: canSeeFinance becomes `role==='admin' || finance` — Tom/Tony/Jim/Candice see margins/profitability; budgets stay visible to all. Backend was steered mid-build with the same rule. Two-line change in views/components gating.
   > **DONE.** `canSeeFinance(user)` in `public/components.js` is now `role === 'admin' || finance`, taking an optional user so the View-as strip and the viewAs toast use the *same* predicate as the render sites — exactly the shape `canApprovePOs()` already had. **The backend was verified, not assumed:** every margin gate routes through `hasFinance()` (`lib/auth.js`), which has been `admin || finance` all along — `stripMargin`, `canSeeMargin`, the `qb_job_number` gates, budget rights, `routes/agent.js` and `routes/purchasing.js`. **No spot checks `finance` alone.** Copy that said "finance + management" now says "admins and accounting". Verified against the live server on three discriminators: Tony (admin, no flag) now gets margin from the server *and* renders it; Brendon (manager, no flag) is still stripped server-side and still sees the lock.

5. **Temp job numbers** (Tom, 2026-08-27). A job can be created before Candice makes the real QB number: auto-assign a temp label (e.g. `TEMP-26-014`) with `qb_number_status: temp|confirmed`; qb_job_number stays editable (with an activity row on change: "job number confirmed 26-1180, was TEMP-26-014"). UI: quiet "temp #" badge wherever the job chip renders; **a temp-numbered job with activity on it feeds accounting's "waiting on me"** ("needs a QB job number") so Candice chases it. Safe by design: all links use internal job_id, so the swap re-links nothing. Backend: jobs route allows temp creation + number edit + status flip; agent-proposed projects create temp-numbered jobs (fits AGENT_API's always-propose rule).
   > **DONE, front and back.** `jobs.qb_number_status` added additively (defaults `'confirmed'`, so every existing row is right without a migration). **A job is never numberless:** created without a real number — by a pm, by a new folder's auto-job, or by confirming an agent-proposed project — it gets `TEMP-{yy}-{seq}` from `mintTempJobNumber()` in `lib/db.js`, and clearing the number re-mints one rather than blanking the chip. A pm may open the job; only the **three admins + Candice** (`hasFinance`) may type a real number; an agent still may not set one at all. Writing a non-`TEMP-` number flips the status implicitly and logs its own accented `job.number.confirm` row naming both numbers. `GET /api/finance/exceptions` emits `kind: 'job_number'` — *"needs a QB job number — Candice"* — but **only for a temp job something is riding on** (an expense, PO line, budget line, or any activity beyond its own `job.create`); an untouched temp job stays quiet. A quiet dashed `temp` badge renders beside the number on every job chip, job row, job card and job header, and the job page grows a Confirm/Edit job number dialog for accounting. Demo data seeds **job 11 · LOVB Salt Lake as `TEMP-26-014`** — it already carries PO lines, so the badge *and* the chase row are both demoable out of the box. `GET /api/activity` gained a `job_id` filter so a job can show its own history.

---

## Also landed in this pass (not numbered items)

* **Bind popup re-verified end to end** against the booted server, per
  `INTEGRATIONS_SPEC.md` §9. Three drifts fixed **in `public/bind.js`**, one in
  `public/api.js`, and the spec updated where it was silent or self-contradictory:
  * `bind-complete` now carries **`stale`** (the array of invalidated node
    names). §9.3.5 draws the tool showing a stale line and says it comes from
    the 200 response — but the tool never sees that response, only the popup
    does. The spec contradicted itself; §9.3.3 step 8 now agrees with §9.3.5.
  * **`bind-cancelled`** added (`pagehide`, once, never after a completed bind).
    It existed in neither the spec nor the code, and without it a tool that
    entered its waiting state on `bind-popup-ready` waits there forever when the
    operator just closes the popup.
  * `bind.js` now **adopts `specExt`/`specNode` from `GET /api/config`** instead
    of trusting its own hardcoded `SPEC_MAP`. There were three independent
    copies of that map (server, `lib/enums.js`, `bind.js`); three copies is
    exactly how T2 — a `.pcfg` bind claiming it filed a `.nsf` — happens. The
    server is now the single source, and a fourth tool needs no front-end release.
  * The checker's `provisional` flag and each question's `detail` now render
    (`lib/speccheck.js` asks the UI to say so out loud and it was not), and
    questions carry a speech-bubble glyph rather than an alert triangle.
  * §9.5 **D4 now enumerates the real `GET /api/config` response** — it named no
    field at all before.
* **`TOOLS_ORIGINS` documented as REQUIRED** in `SCHEMA.md`'s deploy env table.
  It was undocumented, and spec-bind **fails closed** without it: the allowlist
  is `[]`, the popup trusts only its own origin, and every tool bind is refused.

(more items as the tour continues)
