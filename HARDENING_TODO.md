# Pre-deploy hardening list

Flagged by the 2026-08-27 consolidation review; **worked in the hardening pass
the same day**, before the Railway deploy. Status of every item is below.
Source of truth for current behavior remains the six test suites.

**Suites after the pass: 1,279 assertions green** — smoke 322 · API 193 ·
demo 632 · live-push 65 · flex 67 (measured baseline before the pass: 1,240 — smoke +37, API +2).

**After the 2026-08-27 evening pass (items 20–21): 1,780 green** — smoke 504
(+39) · API 257 (+14) · demo 835 (unchanged) · live-push 72 · flex 112 (+45).
Every suite run fresh; no test touches the live Flex tenant.

---

## Security / correctness

1. ~~**`/api/agent/purchase-requests` is ungated**~~ — **NOT A DEFECT.** The
   route sits behind the router-level `requireAgentKey` **and**
   `requireScope('agent:propose')`. Mutation-probed with five discriminating
   identities: no credential → 401 · a session token → 401 · a garbage key →
   401 · a key holding only `agent:read` → 403 · a key holding `agent:propose`
   → 200. The gate was watched refusing *and* admitting. **No change made.**
2. **`stripMargin` defeated by `dbToJob.contract_value`** — **FIXED.** The
   contract value is now in the stripped set (`stripMoney()` /`MONEY_FIELDS` in
   `lib/mappers.js`) and the strip **recurses into `job`/`jobs[]`**, which is
   how it escaped through `GET /projects/:id` and `jobFinance`. Costs stay
   visible to everyone; the derivable term does not. SCHEMA.md updated.
3. **Rotate `FLEX_API_KEY`** — **TOM'S, STILL OPEN.** Verified for him:
   `.gitignore` exists and covers `.env`, `node_modules/`, `dist/`, `.storage/`,
   `*.log`; the key appears in **exactly one file in the whole office lab**
   (`showrunner-app/.env`) and nowhere in the tree that will be committed;
   `.env.example` holds only placeholders. Nothing else secret-shaped found.
   **Tom declined rotation (2026-08-27): use the existing key as-is.** Risk
   noted and accepted by Tom; do not re-raise. (The separate "API Automation
   User" idea is likewise optional and not requested — existing key powers
   everything.)
4. **Agent PO numbering is lexicographic with no 23505 catch** — **FIXED.** The
   agent's private numbering is gone; it calls the human pipeline's
   `nextPoNumber()` (numeric max) through a new `insertPO()` that retries a lost
   race behind a **SAVEPOINT** — a failed statement otherwise poisons the whole
   transaction and the retry would hit "current transaction is aborted". A
   caller-SUPPLIED duplicate stays a 409; only a server-minted one renumbers.

## Routing / data integrity

5. **Thumbnailer PATCH route unreachable** — **FIXED.** `routes/photos` moved
   above the blanket-`requireAuth` routers. The rule is now written down in
   `server.js` and SCHEMA.md: a router accepting a non-session credential mounts
   above every router that calls `router.use(requireAuth)`.
6. **`superseded` missing from `FILE_STATUSES`** — **FIXED.** Added, plus
   `FILE_STATUSES_WRITABLE` (a client cannot file something born retired —
   supersession is a server act) and `FILE_STATUSES_HIDDEN`. `GET /files` now
   excludes `rejected` **and** `superseded` by default, and returns either when
   asked for by name, which is what revision history needs.
7. **`DELETE /files/:id` orphans `spec_renders`** — **FIXED.** `spec_renders`
   goes with the file (its `file_id` is `NOT NULL`, so nulling is not an option).
8. **Derived-vs-stored RAG: two `hydrateShow`s** — **FIXED.** `routes/core.js`
   has the only one; `routes/schedule.js` calls it and passes its `project`/
   `type` extras through. The call sheet and the dashboard now agree, and an
   explicit `rag_override` still beats the derivation on both.
9. **Bell badge recompiled `canApproveRecap` as case-sensitive SQL** — **FIXED.**
   `GET /me/inbox/count` filters rows with the JS predicate, like the list route
   it opens. That SQL had three divergences: case sensitivity (`s.owner = $1` vs
   `sameUser()`), a hand-rolled `['admin','manager']` rank test, and it would
   not have inherited item 14's floor. Mutation-tested: restoring the SQL yields
   `{badge: 1, list: 0}` — the badge offering a recap the button then refuses.

## Consistency / UX

10. **Four divergent notify implementations** — **FIXED.** All four now call
    `notifyTargets()` in `lib/mentions.js`; only the anchor and the one-line
    wording (`format`) stay per-family. Unified: a non-array is loud everywhere ·
    a comma string is accepted everywhere · a self-notify is dropped everywhere
    (with `agent:` stripped first) · one 400 message that names the unknown user.
11. **`A.po`/`A.budget` discard the canonical `keep()` object** — **FIXED.**
    `A.po` kept **three** objects alive per line id (merged in `PO_LINES_BY_ID`,
    raw in `PO_LINES`, raw in `PO_LINES_BY_PO`). `A.budget` never called
    `keep()` at all; it now merges through a new `BUDGET_BY_ID` index, so the
    per-job array and the flat list hold the same objects — matching what the
    demo store has always done.
12. **Nav live during the ≤2.5s mode probe** — **FIXED.** One `BOOTING` flag,
    consulted by the single delegated `data-act` listener and the three direct
    handlers `boot()` wires; `:root.is-booting` does the visual half. The flag,
    not the CSS, is the gate — `pointer-events` cannot stop a keyboard
    activation. The theme toggle stays live (it touches only `localStorage`).
13. **`TOOLS_ORIGINS` unset fails closed silently** — **FIXED.**
    `features.specBind` added to `GET /api/config`; the popup says so on open
    instead of refusing every bundle mutely, and tells the tool it is cancelled
    rather than leaving it waiting. Still fails closed — now audibly.

## The decision, taken

14. **Sub-pm show owner edge** — **RESOLVED, conductor-recommended, Tom-
    reversible.** The `pm+` floor moved INTO `canApproveRecap()`, so draft and
    approve are one expression and agree for every role: a tech who owns a show
    may now neither draft nor approve its recap, and manager/admin cover it.
    The mirror in `public/data.js canApproveRecapFor()` matches.
    **To reverse:** delete the `roleRank(...) < ROLE_RANK.pm` line in
    `lib/auth.js` and the `RECAP_EDIT_ROLES` line in `canApproveRecapFor()`, and
    flip the expectations in the two suites.
    The `[known gap]` assertions are gone from **both** sides — the smoke suite
    and `harness-api.mjs` (which pinned the UI mirror too) — replaced by real
    assertions of the agreeing rule, plus manager-cover assertions so the floor
    cannot be tightened into a wall unnoticed.

## API rough edges (found filing Show #1, 2026-08-27 — next maintenance session)
15. `POST /api/events` hardcodes job `description=''` (routes/core.js:451) — accept it in the payload.
16. `venue_address`/POCs writable only via `PUT /shows/:id/call-sheet`, not the composite or show PUT — unify.
17. `normalizePoc()` (routes/schedule.js:227) silently drops `email` — add the field.
18. `applyScope()` force-stamps scope_verified_at/by — allow an unverified manual write (scope_source:'manual' is the only honest marker today).
19. `pitch`/`cabinet_type` are TEXT — fine, but document; consider numeric pitch.

## Flex create — the real one
20. **BUILT 2026-08-27.** `POST /api/shows/:id/flex/create-element` (routes/files.js
    §7) calls `flexCreateEventFolder` for real and stores the id **Flex returned**.
    Guards in order: `requireRole('pm')` → 501 naming the unset `FLEX_*` vars →
    404 → `canEditProject` 403 → 409 if already linked to a REAL id. `modeledUuid`
    is gone from the create path (renamed `demoModeledUuid`, demo-only); the
    client calls the route and takes the response id; the button is gated on
    `config.features.flex`. Deep link `#element/<id>` is DERIVED per request and
    served on all four gear routes, so "View in Flex" is a real anchor.
    **Tom's two calls, both answered:** (a) the times ride in `notes`
    (`Event: … · Doors … · Show … · Strike …`) — the Event Folder definition has
    19 fields and not one takes a clock time; (b) contacts are **match → create →
    omit**, with a "Create missing contacts in Flex" toggle defaulted ON, and the
    per-contact outcome reported honestly in the response, the toast and the notes.
    See INTEGRATIONS_SPEC §3.4.1. **The contact POST has never been executed** —
    the post-deploy run on Show 1 is its first live use, and a failure there omits
    the field rather than failing the folder.
    *Still open:* `DELETE /api/shows/:id/flex/element` exists to clear a
    fabricated link, but nothing sweeps the pre-existing ones; the pull-sheet R21
    grammar + BUG 4 correction are still only banked in `scratchpad/flex-probe/`
    and want a write-back into INTEGRATIONS_SPEC §3.3 and FLEX_CAPABILITIES.

## THE FABRICATION LINE (2026-08-27 — found in production, same day)
21. **FIXED.** Tom opened Show 1's Specs & Chain tab in PRODUCTION and the
    prototype's mock generator filed a **canned `.e360`** — 10mm pitch, two MX40s,
    a placeholder pixel map — as a real `files` row with a real `spec_renders`
    bundle, under his real job number. Same disease as the Flex button.
    **The rule, now enforced:** *in API mode nothing is ever created except from
    real user input or a real integration response.*
    Gated behind `demoOnly()` in `public/app.js`: `specGen` (Showrunner cannot
    author a spec — the three desktop tools do, and bind through the popup),
    `flexPull` (not wired; it used to invent a gear list id, two PDF rows and a
    pull-sheet revision), `flexLink` (now asks for a REAL element id or a pasted
    deep link instead of hashing one). Second locks sit inside `bindChainFile`
    and `bindGearFiles`, the functions that actually write. `normGear` serves an
    EMPTY kit in API mode — `buildKit()` invents a whole LED package from a
    cabinet count. The Specs tab drops the Generate button entirely in API mode
    and says "bind from the tool" instead.
    **Mutation-tested:** removing the `specGen` guard turns five harness-api
    assertions red, including the row count on a bare show.
    *Swept (storage pass, 2026-08-28).* The follow-up below is done: there is now
    a real byte-upload route and the front end points at it.
    · In **API mode** the Add-file dialog is a REAL file picker — the ADD_TYPES
      card grid (with its 6.7 MB proof and its `2160 x 864`) survives in demo
      mode only, where there are no bytes to invent a size for.
      `commitUpload()` sends **no** `size` and **no** `dim`; drag-and-drop hands
      `dropFile()` the actual `File` object rather than its name.
    · `PUT /api/files/:id/content` is the backstop, and the right place for one:
      once real bytes exist the bytes are the truth. It replaces `size` with the
      byte count that actually arrived, and **clears `dim`** unless the caller
      measured it (`?w=&h=`, filled in from a decoded image, never a guess). It
      also returns the stored `sha256`, so a round trip is verifiable without a
      second transfer.
    · **Tested:** `scripts/storage-test.js` §13 and `scripts/smoke.js` both
      create a row with a deliberately WRONG `size`/`dim` and assert the upload
      corrects one and clears the other; the front-end path is covered against a
      real server + real WebDAV backend in the upload harness.

## Noted, deliberate — do NOT "fix"  *(untouched by the pass)*
- Photo curation is rank-only (no ownership term) BY DESIGN — mutation-tested.
- Schedule gates on the FOLDER's owner; recap gates on the SHOW's owner —
  different on purpose, guarded by split-owner fixtures in both harnesses.
- `addPOLine` returning `undefined × $NaN` was a FALSE POSITIVE (misread of the
  DELETE route) — the POST path is correct.
