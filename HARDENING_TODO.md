# Pre-deploy hardening list

Flagged by the 2026-08-27 consolidation review; **worked in the hardening pass
the same day**, before the Railway deploy. Status of every item is below.
Source of truth for current behavior remains the six test suites.

**Suites after the pass: 1,279 assertions green** — smoke 322 · API 193 ·
demo 632 · live-push 65 · flex 67 (measured baseline before the pass: 1,240 — smoke +37, API +2).

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

## Noted, deliberate — do NOT "fix"  *(untouched by the pass)*
- Photo curation is rank-only (no ownership term) BY DESIGN — mutation-tested.
- Schedule gates on the FOLDER's owner; recap gates on the SHOW's owner —
  different on purpose, guarded by split-owner fixtures in both harnesses.
- `addPOLine` returning `undefined × $NaN` was a FALSE POSITIVE (misread of the
  DELETE route) — the POST path is correct.
