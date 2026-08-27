# Flex Rental Solutions API — Capability Survey

**Scope:** what the Flex API can do *beyond* the 15-function client `INTEGRATIONS_SPEC.md` §3 already documents.
**Method:** public documentation only. **No live API calls were made** — no key, and none attempted.
**Written:** 2026-08-27. Companion to `INTEGRATIONS_SPEC.md` §3 (that doc is the verified baseline; this one is the frontier).

Every claim below is tagged:

| Tag | Meaning |
|---|---|
| **[DOC]** | Stated in Flex's own docs, or a real request/response published by a Flex customer |
| **[INF]** | Reasoned from documented behaviour or from Flex's object model — not observed |
| **[UNK]** | Known to exist as a UI feature; the endpoint behind it is not public |

---

## 1. Documentation landscape

**Verdict: sparse, and Flex says so out loud.** There is no developer portal, no published OpenAPI file, no endpoint reference. The complete public corpus is five items:

| # | Source | What's in it | Quality |
|---|---|---|---|
| 1 | [API Getting Started Guide](https://helpcenter.flexrentalsolutions.com/hc/en-us/articles/4419036656151-API-Getting-Started-Guide) (help center art. `4419036656151`) | Key generation, auth header, base URL, permissions model, rate limits | The only official API doc. Thorough on auth/limits. **Names exactly one endpoint** (`/business-location/identity`, as an example). |
| 2 | [Flex5 REST API — Running a Report](https://flexrs.atlassian.net/wiki/spaces/SD/pages/131039282/Flex5+REST+API+-+Running+a+Report) (Confluence, space `SD`) | The `/api/report` interface, in full | Good. The only endpoint Flex documents properly. |
| 3 | Per-tenant **Swagger UI** — `https://e360sport.flexrentalsolutions.com/f5/swagger-ui.html` (older path) or `/f5/swagger-ui/index.html` (current) | The complete endpoint inventory | **The only full map, and it is behind e360's own login/key.** Not public, not crawlable. |
| 4 | [Community forum, API topic](https://helpcenter.flexrentalsolutions.com/hc/en-us/community/topics/14281412640919-API) — 10 threads | Scattered real endpoint intel | Thin but load-bearing. Several endpoints below exist *only* because a customer posted them. |
| 5 | [github.com/normschaeffer/Flex-API-Docs](https://github.com/normschaeffer/Flex-API-Docs) | Community README with **real captured response bodies** for ~6 endpoints | **The single best Flex API document in existence outside Swagger.** Rough, incomplete, but the JSON is real. |

Also useful, not API docs: [flex-rental-solutions/flex-release-notes](https://github.com/flex-rental-solutions/flex-release-notes) — the changelog as greppable JSON (`flex-enterprise.json`), which is how you spot when an API surface appears or moves.

### What Flex itself says

Three quotes that set expectations, all from source 1:

> "The Flex5 API is currently in a **'Beta'** status."

> "Please note that **Flex Rental Solutions does not currently provide support for the API**."

> "You will **not** be able to fully understand the usage of Flex5 API's using only the Swagger UI documentation. It does not document all the request parameter codes & JSON body structures. Since the Flex5 UI uses the Flex5 API, you can use your browser's network tool to observe how APIs are being used."

That last line is the operative one: **Flex's official documentation strategy is "open DevTools and watch."** Every community thread converges on the same advice. Any endpoint in this survey marked **[UNK]** is unknown because nobody has yet posted their DevTools capture — not because it doesn't exist.

### Undocumented-but-known-from-community

- The `findXGridNodes` **PUT-for-search** pattern — Flex's grid screens search via `PUT` with a JSON criteria body, not `GET`. Confirmed by a customer complaining about it: `.../f5/swagger-ui/index.html#/OOC%20Records/findOOCRecordGridNodes` is a `PUT`. Expect this shape for every list/grid in the app. **[DOC]**
- A Swagger controller literally named **"warehouse scan process"** — named by a customer answering "can I emulate a barcode reader via the API?" **[DOC that the tag exists; [UNK] shape]**
- `codeList` is a **field selector**, not a formality (see §5, BUG 5). **[DOC]**
- **No webhooks exist.** See §2.6. **[DOC]**

---

## 2. Capability map

Paths below omit the `/f5` prefix that `flexFetch` prepends, matching `INTEGRATIONS_SPEC.md` §3.2 convention. Full form is `https://e360sport.flexrentalsolutions.com/f5/api/...`.

### 2.0 Auth, limits, versioning

| Fact | Detail | Tag |
|---|---|---|
| Auth header | `X-Auth-Token: <key>` — **exactly what e360 already sends** | **[DOC]** |
| Base URL | `https://<tenant>.flexrentalsolutions.com/f5/api` | **[DOC]** |
| Key lifetime | "Access will not expire unless you revoke the API Key or lock the Flex User." No refresh, no OAuth. | **[DOC]** |
| **Key permissions** | "Each API key is directly tied to the user who generates it. The key inherits that user's permissions… If the user's permissions change later, the API key updates accordingly right away. API keys don't have their own independent permission sets." | **[DOC]** |
| Recommended practice | "Create a dedicated user in Flex with only the permissions needed (e.g. name it something like 'API Automation User')… Log in as that user and generate an API key." | **[DOC]** |
| Rate limits | Enterprise/GTS: **100,000/month, 10,000/day, 2,000/hour**. Daily = monthly÷10, hourly = monthly÷50. Monthly raisable to 250,000 for a fee. Flex Lite: no API access at all. | **[DOC]** |
| **Limits are shared** | "These limits are **aggregated across all API Keys**. For example, if a customer has four keys, the limit is split between all four keys." | **[DOC]** |
| Concurrency | **30 simultaneous requests per customer**. | **[DOC]** |
| Over limit | HTTP **429**. | **[DOC]** |
| Versioning | None published. No `/v1/`, no version header, no deprecation policy. "Beta" is the whole story. Endpoints move without notice (a customer documented `findOOCRecordGridNodes` changing from GET to PUT). | **[DOC]** |
| Flex4 vs Flex5 | e360 is entirely on **Flex5** (the `/f5` prefix *is* Flex5). Flex4's legacy interface returned "a valid XML document describing Quotes, Invoices, or Purchase Orders" — different system, ignore it. | **[INF]** |

> **Two operational consequences for Showrunner, both immediate.**
>
> **(a) The audit-trail problem in `INTEGRATIONS_SPEC.md` §3.1 has a documented fix.** That doc flags "One tenant-wide key shared by all users — Flex's audit log attributes every API-created element to Tom." Flex's own guidance is to create a dedicated Flex user (e.g. `showrunner-api`) and generate the key as that user. Everything Showrunner creates then reads as `showrunner-api` in Flex's audit log, not as Tom — and you can scope its permissions to exactly what Showrunner needs. This mirrors the `showrunner` staffing-app service account §1.4.1 already calls for. **Do this before wiring anything.**
>
> **(b) Budget the rate limit before designing any poll.** 2,000/hour is shared across *every* e360 key — including the staffing app's, which already runs `flexFindGearListsUnder` as one `/identity` call **per tree node, serially** (`staffing/server.js:131-151`). A naïve 60-second pack-status poll across 20 active shows costs 1,200 calls/hour — **60% of the entire company's hourly budget on one feature.** See §4 for the sizing rule.

---

### 2.1 Availability / conflict checking — Tom's headline ask

**Short answer: the quantity half is documented and easy. The date-range half is a UI feature whose endpoint is not public.**

| Endpoint | Does | Tag | Showrunner use |
|---|---|---|---|
| `GET /api/inventory-model/{modelId}/key-info` | Point-in-time counts for one model: `total`, `onHand`, `out`, `allocated`, `ooc`, `presumedMissing`, `inContainers`, `freeScannedOut`, `totalSold`, `totalDecommissioned`, `totalDeleted` | **[DOC]** — real response published | "We own 14, 8 on hand, 12 allocated, 0 out of commission." Gear tab + purchasing's "do we already own this?" |
| *Date-ranged availability for a model* | The actual "is this free 9/12–9/18" answer | **[UNK]** | The whole ask |
| *Line-item conflict fetch* | What the FETCH button calls | **[UNK]** | Per-line shortage flags |
| *Inventory Group Availability* | Group-level rollup — named in release notes, so it exists | **[UNK]** | Category-level headroom |
| *Line item → "Schedule"* | Per-line-item options menu has **Schedule**, "which will open the detailed schedule for the item" — a per-model booking timeline | **[UNK]** | The best candidate for a real date-range answer |

**`key-info` has no date parameter.** It is a snapshot of now. `allocated` counts current allocations across all elements regardless of when — useful, but it will not tell you whether 24 panels are free next March.

#### How Flex actually computes availability — [DOC], and it matters for probing

From [Availability Explained](https://helpcenter.flexrentalsolutions.com/hc/en-us/articles/360009622794-Availability-Explained), availability is a function of **three** things:

1. **Date range** — and "the date range must be current (i.e., **not in the past**). Once the End Date has passed, availability is moot, so Flex will not show availability." *A probe against a past show returns nothing and that is correct behaviour, not a bug.*
2. **Status** — an element's Status must be configured to **"Create Conflicts"** to affect availability at all. A second setting, **"Locks Availability,"** decides which element in a parent/child chain owns the calculation. A Quote whose child Pull Sheet both creates conflicts *and* locks availability drops out of the calculation for linked lines, so the same gear isn't counted twice.
3. **Scan Records** — "if any line items have a Scan Record associated with them, whether it be an inbound or outbound scan, **it will take precedence over everything else**."

> **Consequence for any availability feature Showrunner builds:** the number Flex returns depends on e360's own Status Option configuration, not just on gear counts. Two shows with identical gear can report different availability because one's pull sheet is in a conflict-creating status and the other isn't. Whatever endpoint we find, its answer must be presented as "Flex says," not as ground truth, and the first probe run should be sanity-checked against what the Flex UI shows for the same item and dates.

From [How Does "FETCH" Availability Work?](https://helpcenter.flexrentalsolutions.com/hc/en-us/articles/4402390491543-How-Does-FETCH-Availability-Work): elements over **300 line items** don't auto-load availability; the user clicks FETCH, which "initialize[s] availability fetch of currently **visible** line items," and scrolling queues more. Individual lines can be refreshed one at a time from the Options menu.

> **[INF], and it's a strong inference:** availability is computed **per line item, on demand, in small batches** — not as one bulk document call. So the endpoint we're hunting is very likely shaped `POST`/`PUT` with a list of line-item or model ids plus a date range, returning per-item availability. That is exactly the shape a Showrunner "check these 40 items for these dates" feature wants. It also means the call is cheap per item but N-scaled — relevant to the rate limit.

**The UI surfaces to capture in DevTools** (each is one or more API calls): the **Conflicts and Availability Window** (has an *Availability* tab and an *Availability Details* tab, both named in release notes), the **Resolve Shortages** page (accepts From/To dates and lists everything conflicting in that window — the closest UI analogue to Tom's ask), the **FETCH** button, and a line item's **Schedule** option.

---

### 2.2 Inventory queries

| Endpoint | Does | Tag | Showrunner use |
|---|---|---|---|
| `GET /api/inventory-model/{modelId}` | Full model record — sample published in full | **[DOC]** | Enrich Gear tab rows; see field notes below |
| `GET /api/inventory-model/{modelId}/key-info` | Counts (§2.1) | **[DOC]** | Owned/available at a glance |
| `GET /api/inventory-model-storage-location` | `{ id, modelId, locationId, section, aisle, shelf, bin }` | **[DOC]** | "Where is it in the warehouse" on pick lists |
| `GET /api/business-location/identity` | Locations / warehouses + company address | **[DOC]** — Flex's own code sample | Multi-warehouse awareness; `locationId` constant |
| **Global search** | "search by text, barcode, various categories (e.g. `inventory-model`, `contact`, `serial`, `all`)" — **named, path not published** | **[DOC]** by name, **[UNK]** path | **The missing join key** — see below |
| `GET /api/image/file/{imageId}` | Model images (appears as `imageUrl` in every sample) | **[DOC]** | Gear thumbnails |
| Inventory group list | Named in the community README with "(how might this be used ??)" | **[UNK]** | Category tree |

**Fields worth having from `inventory-model/{modelId}`** (all present in the published sample): `trackedBySerialUnit`, `container`, `serializedContents`, `freePickContainer` (the serial-vs-quantity distinction that BUG 6 is really about); `replacementCost`, `purchaseCost`, `averageCost` (insurance value + job costing); `weight`, `height`, `width`, `modelLength`, `weightUnit`, `linearUnit` (truck loading, freight estimates); `sku`, `partNumber`, `manufacturer`, `barcode`, `number` (the purchasing join); `prepTime`, `deprepTime` (labour estimating); `group.fullDisplayString` e.g. `"Lighting > Moving Head"` (category); `discontinued`, `presumedMissing`.

> **Global search is the highest-leverage [UNK] in this section.** Showrunner's PO lines, spec sheets, and gear lists all name items as *strings*. Flex indexes everything by `modelId` UUID. Without a name/barcode/SKU → `modelId` resolver, none of the inventory endpoints above can be pointed at a Showrunner record. Finding this endpoint unblocks §2.1, §2.2, and the purchasing story simultaneously. It is probe **P4** and should not be skipped.

---

### 2.3 Receiving & purchasing

**The object model is well documented. The API for it is not.**

**Flex has two kinds of PO** — [DOC], from the help center:

- **Purchase PO** — buying gear you will own. Lives at *Main Menu > Projects > Purchase POs*; Flex calls it "a **financial element** in Flex that allows you to add items that you will be purchasing from a vendor." This is e360's LED-systems case.
- **Rental PO** — subrental / backorder, i.e. gear you're renting in. Line items carry an "incoming" resource type (`Rental Backorder`, `Retail Backorder`, `Subrental`).

**Receiving** — [DOC], *Main Menu > Warehouse > Receiving*:

- The screen defaults to POs with an "Order By" date **within the next 7 days** that have at least one incoming-resource-type line.
- Received units inherit: **Barcode** (auto-assigned from the resource type's numbering scheme if left blank), **Model Number** (from the inventory model), **Location** (from the selected scanning location), **Resource Type** (from the PO line), **Purchase Order** (the PO), **Purchase Date** (defaults to the receiving date), **Purchase Cost** (from the PO line cost), **Depreciation Period** + **Salvage Value** (from the model).
- Serialized items accept a **serial number, stencil, or RFID tag** per unit. Non-serialized accept a quantity only, and "barcode can not be changed since it will automatically use the existing model barcode."
- **An inventory model must already exist** before anything can be received against it. Flex explicitly recommends creating a model even for gear you won't own, rather than using a miscellaneous line.
- **No over-receiving:** "you can only receive the requested amount. If additional items need to be received, you will need to update the Purchase PO and refresh the receiving screen."
- Workflow is line-by-line → **ADD** each → at 100% click **FINALIZE**.

#### Can Showrunner create a PO in Flex? — [INF], strong

From [Inventory Settings](https://helpcenter.flexrentalsolutions.com/hc/en-us/articles/5918189534999-Inventory-Settings): *"**Purchase Order Definitions** — determines what **Element Definitions** will be used for calculating the On Order quantity of an inventory model."*

That sentence is the tell. **POs are elements with `definitionId`s**, the same family as the Event Folder / Pull Sheet / Manifest e360 already creates. So `POST /api/element` — which e360's client already implements and has proven in production — is very likely all that's needed, with the Purchase PO definition's UUID in place of `FLEX_EVENT_FOLDER_DEF_ID`. `flexCreateEventFolder` is ~90% of the code.

It also means: once a Flex Purchase PO exists, Flex's own **On Order** quantity math starts counting e360's incoming LED systems, which is precisely what makes "do we already own / have we already ordered this?" answerable in the purchasing flow.

**Not established:** the definition UUID (must be read from the tenant — probe **P8**), the required payload fields, and whether PO *line items* can be added via API at all. Element creation and line-item population are different endpoints; §2.4's `eqlist-line-item/*` family is read-shaped in everything published.

#### Can Showrunner *receive* via API? — [UNK]

No public endpoint. Two adjacent signals:

- The changelog records `"Implemented 'Update Backorder Paperwork' API"` and `"Implemented 'Update Subrental Paperwork' API"` and `"Implemented 'Equipment List Generator' API"` — so Flex does expose element-level **actions** as APIs. An equivalent receiving action plausibly exists. **[INF]**
- The `"warehouse scan process"` Swagger controller (§2.4) is where receiving scans would most likely live. **[INF]**

> **Honest recommendation for the PO → "→ Flex inventory" story in `TEAM_FEEDBACK.md`.** Split it, and ship the half with no unknowns first:
>
> - **v1 (no unknowns):** Showrunner owns the full PO lifecycle (needed → quoted → ordered → shipped → received → invoiced). On "ordered," create the matching Flex **Purchase PO element** so Flex's On Order math is correct and the warehouse sees it coming. On "received," Showrunner records the receipt and **deep-links to the Flex PO**; a human receives in Flex, where serials and barcodes get assigned properly anyway. This needs one probe (the definition id) and reuses existing code.
> - **v2 (needs discovery):** API-driven receiving. Worth a DevTools capture, but do not put it on a critical path — and note that receiving assigns barcodes and serials to physical assets. That is a write with real consequences and belongs behind a human, which argues for v1 being the *right* design rather than merely the achievable one.
>
> Also: **Flex already sends purchase orders to QuickBooks.** Flex's official QBO integration covers "quotes, invoices, payments, credit memos, sub rentals, and **purchase orders**" with job costing. Before Showrunner builds its own QB↔PO sync on the `qb_job_number` key (`TEAM_FEEDBACK.md`), check what e360's existing Flex↔QBO connection already moves — there is a real chance of building a second, conflicting path into Candice's books.

---

### 2.4 Scan / prep / status workflow — **the biggest under-exploited win**

This section contains the strongest finding in the survey: **e360 already probed the endpoint that answers "is the truck packed?" and discarded it as empty.**

| Endpoint | Does | Tag | Showrunner use |
|---|---|---|---|
| `GET /api/equipment-list/{id}` | Full pull-sheet/manifest header record — **including the entire prep/ship/return completion block** | **[DOC]** — full sample published | Live pack-status chips on the Gear tab |
| `GET /api/eqlist-line-item/nodes-by-ids` (`?equipmentListId=…`) | Top-level nodes with **`lineQtyInfo`** and **`groupQtyInfo`** | **[DOC]** — full sample | Per-line "18 of 24 prepped" progress |
| `GET /api/eqlist-line-item/node-list/{parentLineItemId}?equipmentListId=…&page=0&size=20` | Children of one group, paged, each with qty info | **[DOC]** — working URL + real 10-row response | Drill-down under a group |
| `GET /api/element/{id}/header-data/?codeList=<field>&codeList=<field>` | Targeted header fields | **[DOC]** — community-published | Cheap date/field reads |
| `GET /api/element/current-workflow-state?elementIds=…` | Workflow state names | already in e360's client | — |
| *"warehouse scan process"* controller | Programmatic scanning | **[DOC]** tag exists, **[UNK]** shape | Write-side scanning — see caution |
| `PUT /api/.../findOOCRecordGridNodes` | Out-of-commission records | **[DOC]** path+method, **[UNK]** body | "This tile is OOC — don't plan on it" |

#### `GET /api/equipment-list/{id}` — the pack-status goldmine

`INTEGRATIONS_SPEC.md` §3.2 lists this endpoint under **"probed and rejected — do not use"**, with the note *"returns metadata only, no line items; superseded by #4 [row-data]."*

The observation was right. **The conclusion was wrong.** The published response body shows that "metadata" includes:

```
prepCompleted, deprepCompleted, returnCompleted,
shipCompleted, receiveCompleted, subrentalReturnCompleted      ← booleans
prepCompletedUserId,      …CompletedUserId       (×6)           ← who
prepCompletedTimestamp,   …CompletedTimestamp    (×6)           ← when
prepManifestId, deprepManifestId, shipManifestId,
returnManifestId, receiveManifestId, subrentalReturnManifestId  ← linked docs
currentWorkflowStateId, statusId, locked, open
weight, totalPrepTime, totalDeprepTime, insurableValue
budgetedRevenue, budgetedCost, actualRevenue, actualCost, resolved*
plannedStartDate, plannedEndDate, calcStartDate, calcEndDate,
loadInDate, loadOutDate, showStartDate, showEndDate, preparedDate,
rehearsalDate, doorsDate, depositDueDate, dueDate
clientId, venueId, vendorId, billToId, personResponsibleId, customerPO
```

**One call, per gear list, gives the Gear tab a real live status line: "Prepped ✓ 8/26 14:32 by Brendon · Shipped ✓ 8/27 06:10 · Returned —".** That is exactly the "is the truck actually packed" signal requested, it is fully documented with a real response body, and it requires no discovery whatsoever. It is the single highest-confidence, highest-value item in this survey.

#### `nodes-by-ids` / `node-list` — per-line pack progress, and a likely correction to BUG 4

Every line node carries **two** quantity blocks (`lineQtyInfo` for the line itself, `groupQtyInfo` for a group's rollup), each:

```json
{ "preppedQty": 0, "dePreppedQty": 0, "shippedQty": 0, "returnedQty": 0, "requiredQty": 24,
  "prepped": false, "deprepped": false, "returned": false, "shipped": false,
  "overPrepped": false, "overDeprepped": false, "overShipped": false, "overReturned": false }
```

This is per-line pack progress with over-pack detection — progress bars, "3 short," "2 extra came back."

**It also very likely dissolves BUG 6.** `INTEGRATIONS_SPEC.md` §3.3 BUG 6 documents that `row-data` returns `quantity: null` on serial-tracked items, forcing the `flexCleanItemName` + assume-1 + sum-by-name workaround. But `requiredQty` here is a clean integer on both serialized and non-serialized lines. The null-quantity problem appears to be **an artifact of using `row-data` rather than the line-item node endpoints** — not an inherent Flex defect. Worth confirming (probe **P3**), because it would replace a fragile string-munging heuristic with a number Flex actually computed.

**And it contradicts BUG 4 head-on.** `INTEGRATIONS_SPEC.md` §3.3 BUG 4 states `node-list/{parentLineItemId}` returns `{"content":[],"totalElements":0,"empty":true}` for all four parent strategies tried, and concludes it "returns nothing, ever." The community docs publish a **working URL and a real 10-item response**:

```
https://<tenant>.flexrentalsolutions.com/f5/api/eqlist-line-item/node-list/83a71180-8492-11ee-9ae0-e2999141f70a?equipmentListId=838a13a0-8492-11ee-9ae0-e2999141f70a&page=0&size=20
```

Two differences from e360's probes stand out. First, `page` and `size` are present and the community doc lists both as **required** alongside `equipmentListId`; a Spring `Pageable` with no page/size can legitimately yield an empty page. Second — more likely the real cause — the four parent ids e360 tried were *the element's own id, `0`, `null`, and empty*. The community doc is explicit that `parentLineItemId` must be a **group line-item id obtained from `nodes-by-ids`**. None of e360's four attempts was ever a group line-item id, so an empty result was the correct answer to every question asked.

**The correct call chain is three steps, and e360 only ever tried step 3:**

```
GET /api/equipment-list/{id}                    → header + pack status
GET /api/eqlist-line-item/nodes-by-ids?equipmentListId={id}   → group ids + rollup qtys
GET /api/eqlist-line-item/node-list/{groupLineItemId}?equipmentListId={id}&page=0&size=200
                                                → that group's children + per-line qtys
```

This is probe **P3**, and it is the one most likely to change how the Gear tab gets built.

#### Write-side scanning — [UNK], and probably leave it alone

A customer asked "can I mark items picked via the API instead of scanning, when preparing to load a truck?" and was pointed at the **"warehouse scan process"** Swagger tag. Nobody published the shape.

Technically interesting; **strategically dubious.** A scan record is Flex's highest-authority availability signal — "a Scan Record… will take precedence over everything else" (§2.1). Showrunner writing synthetic scans would corrupt the one input the warehouse trusts, to save a barcode gun. Recommend Showrunner stay **read-only** on scan state and let Flex remain the system of record for physical custody. Worth *knowing* the endpoint exists; not worth building on.

---

### 2.5 Financial / quote objects

| Endpoint | Does | Tag | Showrunner use |
|---|---|---|---|
| `GET /api/equipment-list/{id}` | Also carries the money block (§2.4) | **[DOC]** | Gear-side budget vs. actual into job costing |
| `GET /api/report/process/{reportId}?parameterSubmission=true&…` | **Runs any Flex report and returns it** | **[DOC]** — fully documented | Attach Flex PDFs/CSVs as financial docs |
| `GET /api/element-calendar/list-view-data` (+ `lastEditDate` as a `calendarTokenFieldId`) | List/search elements by date field — community's answer to "find quotes changed since X" | **[DOC]** endpoint, **[UNK]** exact params | The polling primitive for the finance feed |

**Money fields already on every equipment-list record:** `budgetedRevenue`, `budgetedCost`, `actualRevenue`, `actualCost`, `resolvedBudgetedRevenue/Cost`, `resolvedActualRevenue/Cost`, `insurableValue`, `deposit`, `depositPercentage`, `depositDueDate`, `clientInsurance`, `currencyId`, `defaultPricingModelId`, `customerPO`, plus `clientId` / `billToId` / `vendorId`. This is the gear-side cost line for the per-event P&L Accounting asked for — available today, no discovery needed.

#### The Reports API — documented, and quietly one of the best wins here

The only endpoint Flex documents properly:

```
GET /f5/api/report/process/{reportId}?parameterSubmission=true&<paramId>=<value>&REPORT_FORMAT=pdf
Header: X-Auth-Token: <key>
```

- **`parameterSubmission=true` must be the *first* parameter** if the report takes any parameters at all. **[DOC]**
- `REPORT_FORMAT` accepts `pdf` and `csv`; default is PDF. **[DOC]**
- **The response is a base64-encoded string**, not a binary body — decode before writing the file. **[DOC]**
- **Instance-level reports only.** Global and Definition level reports are not exposed. **[DOC]**
- Request-body parameters are not supported (Swagger 2.9.2 limitation). **[DOC]**
- There is a **circuit breaker** on report generation — the changelog records "Implemented Reports API circuit breaker" with a help article titled *"Report generation throttled from excessive failures."* Repeated failures will get report generation cut off, so fail loudly rather than retrying in a loop. **[DOC]**

Showrunner use: pull the official Flex pull sheet, manifest, PO, or valuation report as a real PDF and file it under the show's Files / financial-docs, feeding Accounting's cross-project feed with documents that *look like the ones Flex prints* rather than Showrunner re-renders. Cheap to build, immediately legible to the team.

---

### 2.6 Webhooks / events — **there are none**

**Flex is poll-only.** Confirmed three ways, all **[DOC]**:

1. A customer asks flatly: *"Any idea how zapier is set up to receive the trigger since there is no webhook?"*
2. On how the official Zapier integration works: *"Zapier looks at Flex every minute (or whatever you set it to) to see if there are any changes."* With a warning: *"Flex has a limit on the number of looks you can do in a month, so keep that in mind if you're running lots of things frequently."*
3. Even Zapier's trigger is narrow: *"The api can't trigger for the initial creation of a new quote, it only triggers for a change in workflow for an existing quote."*

Nothing in the Getting Started Guide, the Confluence space, or the changelog mentions webhooks, callbacks, subscriptions, or event streams.

**Consequences for Showrunner:**

- Every live signal — pack status, receiving, quote changes — is a **poll**, and every poll spends the shared 2,000/hour budget (§2.0).
- The closest thing to a change feed is `element-calendar/list-view-data` filtered on `lastEditDate` (§2.5): *one* call that returns everything edited since a watermark, instead of N calls polling N shows. If it works as described, it is worth far more than its obscurity suggests — it converts an O(shows) poll into O(1). Probe **P6**.
- Flex's own Zapier integration is a legitimate fallback for low-volume triggers, but it polls too and consumes the same quota.

---

## 3. Top opportunities, ranked

Ranked by (value to Showrunner) × (confidence it will work), highest first.

| # | Opportunity | Endpoint(s) | Feasibility | Plugs into |
|---|---|---|---|---|
| **1** | **Live pack status on the Gear tab** — prep / ship / return complete, with who and when | `GET /api/equipment-list/{id}` | **Documented, zero unknowns.** Real response body published. One call per gear list. | `PUNCH_LIST` #7 `flex_state`; the Gear lane's "is the truck packed" signal |
| **2** | **Per-line pack progress** — "18 of 24 panels prepped," over/short detection | `nodes-by-ids` → `node-list` | **Documented, needs one probe** to confirm the BUG 4 correction (P3) | Gear tab progress bars; replaces the BUG 6 quantity heuristic with real `requiredQty` |
| **3** | **Owned / on-hand / allocated per item** | `GET /api/inventory-model/{id}/key-info` | **Documented.** Blocked only on name→`modelId` resolution (P4) | Gear tab; purchasing's "do we already own this?" |
| **4** | **Flex reports as filed documents** — official PDFs/CSVs attached to the show | `GET /api/report/process/{reportId}` | **Documented in full.** Needs the tenant's report ids (P7). Watch the circuit breaker. | Files / financial-docs; Accounting's cross-project feed |
| **5** | **Date-range availability** — Tom's actual ask | **[UNK]** — behind Conflicts & Availability / Resolve Shortages / FETCH | **Needs DevTools capture** (P5). Highest value, lowest certainty. Answer is config-dependent (§2.1). | Gear tab conflict warnings; season planning |
| **6** | **PO → Flex Purchase PO element** | `POST /api/element` + Purchase PO `definitionId` | **[INF] strong.** Needs the definition id (P8). Reuses `flexCreateEventFolder` almost verbatim. | Purchasing "ordered" stage; makes Flex's On Order math correct |
| **7** | **One-call change feed** for the finance/activity feed | `GET /api/element-calendar/list-view-data` + `lastEditDate` | **Community-reported, params unknown** (P6). Turns an O(shows) poll into O(1) — worth the dig. | Accounting's cross-project feed; "waiting on me" exceptions |
| **8** | **Warehouse location on pick lists** | `GET /api/inventory-model-storage-location` | **Documented.** Small, cheap, genuinely useful. | Gear tab / pull-sheet display |

**Explicitly *not* recommended:** write-side scanning via "warehouse scan process" (§2.4) — technically reachable, but it would have Showrunner forging the one signal the warehouse trusts.

---

## 4. Probe plan — READ-ONLY, once `FLEX_API_KEY` is in `.env`

**Preconditions.** All calls carry `X-Auth-Token: $FLEX_API_KEY` and `Accept: application/json`, against `https://e360sport.flexrentalsolutions.com/f5/api/...`. Every probe below is a **GET** except where noted; none creates, mutates, or deletes anything. Save each raw response under `tools/probe-output/` alongside the existing May-13 captures.

**Rate-limit discipline.** The whole plan is well under 100 calls — negligible against 2,000/hour. But it shares the budget with the staffing app, so don't run it in a loop, and stop on the first `429`.

**Fixtures to collect first** (from the Flex UI, no API needed): one **pull sheet** id and one **manifest** id under a *recent, not-yet-past* Event Folder — availability probes need a current date range (§2.1) and the existing captures are all manifests from a finished show.

---

**P1 — Confirm the pack-status block. *Do this one first; it's the payoff.***
```
GET /api/equipment-list/{pullSheetId}
GET /api/equipment-list/{manifestId}
```
**Answers:** does the response carry `prepCompleted` / `shipCompleted` / `returnCompleted` + `*CompletedTimestamp` + `*CompletedUserId`, populated with real values? Are the timestamps naive-local or UTC? Does `currentWorkflowStateId` agree with what `/api/element/current-workflow-state` already returns?
**If yes →** opportunity #1 ships immediately, and `INTEGRATIONS_SPEC.md` §3.2's "probed and rejected" entry for this endpoint needs reversing.

---

**P2 — Group-node inventory with quantity info.**
```
GET /api/eqlist-line-item/nodes-by-ids?equipmentListId={pullSheetId}
GET /api/eqlist-line-item/nodes-by-ids?equipmentListId={manifestId}
```
**Answers:** what does `nodes-by-ids` return with only `equipmentListId` and no id list — everything, or an error demanding ids? Are `lineQtyInfo` / `groupQtyInfo` present and populated? Do the top-level nodes match the groups `flexFetchGearList` derives from `row-data`?
**Note:** the parameter name suggests it *may* want explicit ids (e.g. repeated `ids=` or `nodeIds=`). If it 400s, capture the exact message — it will name the required parameter, exactly as the BUG 5 `codeList` 400 did.

---

**P3 — Re-test BUG 4 with a real group id and paging. *The highest-information probe in the plan.***
```
GET /api/eqlist-line-item/node-list/{groupLineItemId}?equipmentListId={pullSheetId}&page=0&size=200
```
where `{groupLineItemId}` is an id from P2 with `"group": true`.
**Answers:** does `node-list` return children when given (a) a genuine group line-item id and (b) `page`+`size`? Isolate the two variables — repeat once **without** `page`/`size` to determine which of the two was the actual cause.
**If it returns content →** BUG 4 in `INTEGRATIONS_SPEC.md` §3.3 is **wrong as written** and must be rewritten: not "returns nothing, ever," but "requires a group line-item id from `nodes-by-ids`, plus paging." That in turn reopens whether `row-data` (and its whole BUG 5 + BUG 6 workaround stack) is the right primitive at all.

---

**P4 — Find global search. *Unblocks everything in §2.1–2.2.***
Path is unpublished. Recover it the way Flex recommends: open Flex5, DevTools → Network, type a known item name (e.g. `P10 Perimeter`) into the global search box, and capture the request. Then replay read-only:
```
GET /api/{captured-path}?...&query=P10+Perimeter&category=inventory-model
```
**Answers:** the exact path, parameter names, category vocabulary (`inventory-model`, `contact`, `serial`, `all`), and the response shape — specifically **whether it returns `modelId`**. Also test a **barcode** and a **SKU** query, since PO lines will more reliably carry those than a display name.
**Why it matters:** without name/barcode/SKU → `modelId`, none of the inventory or availability endpoints can be pointed at a Showrunner record.

---

**P5 — Find date-range availability. *The headline ask.***
DevTools capture, in this order (each is a different candidate):
1. Open a **current** pull sheet with the conflict column on → click **FETCH**. Capture the availability request: note the **HTTP method** (expect POST or PUT with a JSON body of line-item ids + dates, per the §2.1 inference), the date parameters, and whether it's batched by visible line.
2. Open the **Conflicts and Availability Window** on a single line → capture both the *Availability* and *Availability Details* tabs.
3. Open **Resolve Shortages**, set From/To → capture. This is the closest UI analogue to "check these items for this date range."
4. On a line item's Options menu, click **Schedule** → capture. Best candidate for a per-model booking timeline.

Then replay each **read-only** with e360's own dates.
**Answers:** whether a date-range availability call exists, its shape, whether it takes `modelId` or `lineItemId`, and whether it can be called for arbitrary items/dates or only in the context of an existing element.
**Sanity check, mandatory:** compare the API's number against what the Flex UI shows for the same item and dates. Availability depends on e360's Status Option configuration (§2.1) — verify the API sees the same world the UI does before building on it.

---

**P6 — The change feed.**
```
GET /api/element-calendar/list-view-data
```
Call it bare first to capture the 400 and learn the required parameters, then add `calendarTokenFieldId=lastEditDate` per the community report, then a date window.
**Answers:** can one call list elements edited since a watermark? What element types does it span (quotes only, or pull sheets and POs too)? Is it paged?
**If yes →** the finance feed polls once per cycle instead of once per show.

---

**P7 — Report ids and the base64 round-trip.**
```
GET /api/report/process/{reportId}?parameterSubmission=true&REPORT_FORMAT=pdf
```
Get candidate `reportId`s from the Flex UI's report menu (Flex's own example uses a readable slug, `deposit_invoice`). Start with a **parameterless** report to isolate the base64 decode, then one taking an element id.
**Answers:** which reports are instance-level and reachable; the exact parameter ids; that base64 → PDF decodes cleanly.
**Caution:** the circuit breaker throttles report generation after repeated failures — probe deliberately, not in a loop.

---

**P8 — Purchase PO definition id.**
```
GET /api/element/{knownPurchasePOElementId}/identity
```
Create nothing. Open an **existing** Purchase PO in the Flex UI, take its element id from the URL, and read its `identity` to harvest `definitionId` — the same trick that yielded `FLEX_EVENT_FOLDER_DEF_ID` and friends.
**Answers:** the Purchase PO `definitionId` (and, from a Rental PO, that one too). Also capture the full element record to see which fields a PO actually populates (`vendorId`, `dueDate`, `customerPO`, `statusId`) before attempting any create.
**Stop there.** Creating a PO is a **write** and belongs in a separate, deliberate step after Tom signs off.

---

**P9 — Close out the unverified pull-sheet group branch.** *(carried forward from `INTEGRATIONS_SPEC.md` §3.5)*
```
GET /api/line-item/{pullSheetId}/row-data/?codeList=name&codeList=quantity&codeList=note&node=root
```
§3.5 flags that `flexFetchGearList`'s **pull-sheet branch** (`group.group === true`) has **no probe evidence** — every saved capture is a manifest (`definitionId 9945d54c…`), and the pull-sheet path was written from the spec, not from an observed response.
**Answers:** do real pull-sheet rows actually have `group === true` at top level with `children` beneath? Is `quantity` populated on pull-sheet children (where BUG 6 says manifests give `null`)? Does the manifest-shaped `leaf`/container grammar leak into pull sheets?
**Then diff it against P2/P3** on the same pull sheet: if `nodes-by-ids` + `node-list` give the same tree with clean `requiredQty` integers, **the pull-sheet branch should be reimplemented on those endpoints** and the `flexCleanItemName` + assume-1 heuristic retired for pull sheets entirely.

---

**P10 — Header-data field selection (cheap, confirms the BUG 5 model).**
```
GET /api/element/{eventFolderId}/header-data/?codeList=loadInDate&codeList=plannedEndDate
```
**Answers:** does `codeList` on `header-data` genuinely select fields (returning only the two named), unlike `row-data` where e360 observed the values being ignored? If so, BUG 5's "values are ignored" is **row-data-specific**, and `header-data` becomes a cheap targeted read for date checks — much lighter than fetching `/identity` or the whole element.

---

## 5. Cross-check against the six known bugs

`INTEGRATIONS_SPEC.md` §3.3 documents six bugs. Public docs bear on five of them; **one looks wrong** and **one is partly explained**.

| Bug | Public-doc verdict |
|---|---|
| **BUG 1** — the `/f5` URL prefix | **Superseded — the framing, not the workaround.** §3.3 says "Swagger documents `/api/element`; the real URL is `/f5/api/element`." The current Getting Started Guide documents the base as `https://yourflexsite.flexrentalsolutions.com/f5/api` in both its Python and JavaScript samples, and the Swagger UI itself lives at `/f5/swagger-ui.html`. So `/f5` is **documented**; what misled e360 was Swagger's `basePath` omitting the servlet context, a stale-spec artifact rather than a bug. **Keep `flexFetch`'s unconditional prefix exactly as it is** — the 403-as-HTML failure mode is real. Just retire the "undocumented" framing so nobody re-litigates it. |
| **BUG 2** — date parser rejects `±HH:MM` offsets | **No public doc. Unexplained, and the workaround stands.** Nothing in the corpus mentions date formats. Consistent with a server-side `Instant.parse`, which accepts only `Z`. Keep `flexDateToUtcInstant`. |
| **BUG 3** — UTC midnight renders as the previous day | **Corroborated, and now explainable.** The published `equipment-list/{id}` and `/identity` samples return **every** datetime as naive local with no zone (`"plannedStartDate": "2023-11-29T18:00:00"`, `"loadInDate": "2023-11-29T20:00:00"`) — matching §3.4's note that `plannedStartDate` "comes back **without** the `Z` it was sent with." Flex converts to tenant-local on write and returns naive local on read, so a UTC midnight legitimately *is* the previous evening locally. Not a rendering bug; a timezone-model mismatch. **The noon-Central workaround is the correct fix**, and the Luxon DST handling is not optional. |
| **BUG 4** — `node-list` "returns nothing, ever" | **⚠️ CONTRADICTED — most likely wrong as written.** The community docs publish a working `node-list` URL and a real 10-item paged response (§2.4). Two probable causes for e360's four empty results: `page`/`size` were omitted (both listed as required; a Spring `Pageable` with neither can yield an empty page), and — more likely — **none of the four parent ids tried was a group line-item id.** e360 tried the element's own id, `0`, `null`, and empty; the docs are explicit that `parentLineItemId` comes from `nodes-by-ids`. An empty result was the correct answer to every question actually asked. **Re-probe (P3) before trusting §3.3 on this**, because "the OpenAPI spec points straight at the dead end" may have the causation backwards — the spec pointed at a live endpoint that was called wrong. |
| **BUG 5** — `codeList` required, values ignored, empty value fails silently | **Partly explained.** `codeList` is a genuine **field selector**: a customer uses `header-data/?codeList=loadInDate&codeList=plannedEndDate` specifically to get those two fields. So values are *not* globally ignored. On `row-data` they plausibly select **grid columns**, with the server falling back to the grid's configured default set when the names don't match a column — which is exactly why `["DEFAULT"]` and `["NAME","QUANTITY"]` returned byte-identical payloads. The genuinely dangerous half — **`codeList=` empty → 200 with `[]`**, indistinguishable from "no gear" — remains undocumented and untriaged by Flex. **Keep treating an empty array as suspicious.** P10 confirms the model cheaply. |
| **BUG 6** — `quantity` null on serial-tracked items | **Corroborated in mechanism, and a better primitive exists.** The model schema confirms the cause: `trackedBySerialUnit: true` means each physical unit is its own inventory record with its own `resourceId`, so a per-unit row has no meaningful `quantity`. §3.3's diagnosis is right. **But** `nodes-by-ids` / `node-list` return `lineQtyInfo.requiredQty` as a clean integer on serialized and non-serialized lines alike. The null-quantity problem looks like **an artifact of `row-data` specifically**, not an inherent Flex defect — meaning the `flexCleanItemName` + assume-1 + sum-by-name heuristic may be replaceable with a number Flex computed itself. Confirm via P3/P9 before rewriting. |

**Net:** four of six bugs stand (1's workaround, 2, 3, 6's mechanism). One is probably a misdiagnosis worth re-testing (**4**). One is half-explained with its dangerous edge intact (**5**). And the endpoint §3.2 lists as "probed and rejected" — `GET /api/equipment-list/{id}` — is in fact the single most valuable endpoint in this survey.

---

## 6. What this survey could not answer

Stated plainly, so nobody mistakes silence for absence:

- **The complete endpoint list.** It exists only in e360's own Swagger UI, behind the key. Once the key lands, `GET /f5/swagger-ui/index.html` (and its underlying spec document) is worth an afternoon — it will supersede large parts of this document.
- **Date-ranged availability** (§2.1) — the headline ask. Conceptually documented, endpoint not public. **P5.**
- **Global search path** (§2.2) — blocks pointing any inventory endpoint at a Showrunner record. **P4.**
- **API-driven receiving** (§2.3) — no public endpoint; adjacent "…Paperwork API" actions suggest one may exist.
- **Whether PO line items can be created via API** (§2.3) — element creation is proven; line-item population is not.
- **Request/response shapes for every `findXGridNodes` PUT** — the pattern is confirmed, no body schema is public.
- **Any rate-limit headers** — Flex documents the limits and the 429 but not whether responses carry remaining-quota headers. Worth checking on the first probe response; it changes how conservative the polling design needs to be.

**Roughly two-thirds of this survey is documented and directly buildable** (opportunities 1, 2, 3, 4, 8 — pack status, line progress, inventory counts, reports, storage locations). **The remaining third — availability by date range, global search, receiving, the change feed — needs live probing**, and P3/P4/P5 are the three that decide how much of the Gear tab is achievable.

## Correction from Tom (2026-08-27) — e360 does not use Flex financials
e360's Flex usage is OPS ONLY: inventory, event folders, pull sheets, manifests, contacts. No quotes/pricing/PO-to-QuickBooks flows are in use. Therefore: (a) the platform's PO→QB sync noted above is irrelevant — Showrunner's qb_job_number path has no double-entry conflict and QuickBooks stays the sole financial system of record; (b) deprioritize the financial/quote objects in the capability map; (c) opportunity ranking stands otherwise (pack status, per-line progress, on-hand counts, availability).
