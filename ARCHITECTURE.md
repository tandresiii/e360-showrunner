# e360 Showrunner — Target Architecture

**One line:** the PM app is the shared **system of record** ("the brain"); an **MCP server** that wraps its REST API is "the nervous system"; and every teammate runs a **personal Claude agent** ("a *you*") that senses their own email + meetings and files pertinent things into the right event. Locked as the target architecture 2026-08-20.

## Topology
```
Showrunner app  (REST API · real server-side roles · activity/audit log)     ← shared system of record / "brain"
        ▲
        │  wraps the API as MCP tools
Showrunner MCP server  (hosted/remote · per-user auth)                        ← "nervous system"
        ▲
        │  connected alongside each person's Microsoft 365 MCP
Each teammate's Claude  (their M365 mail+meetings  +  the shared Showrunner MCP)   ← per-user agent = sensor + hand
```

## How it works
- The app's REST API (`showrunner-app/server.js`) is wrapped in a thin **MCP server** exposing tools like `search_events`, `add_note_to_event`, `add_task`, `assign_task`, `attach_file`, `update_step`, `flag_risk`, `bind_spec` — each just calls the REST API.
- Each teammate's Claude connects **two** MCPs: **their own Microsoft 365 connector** (their mailbox + calendar/Teams) and the **shared Showrunner MCP**.
- Their agent reads *their* world, decides which event a thing belongs to (client / venue / date / crew / keyword match — same logic as expense attribution), and files it into the right event → lane → step.
- **Not one central agent — one personal agent per person, all feeding one shared record.**

## The three guardrails that make it safe at team scale
1. **Per-user auth + role enforcement.** Each agent authenticates AS its person and inherits that person's app role (a tech's agent ≤ a tech's powers). The app's real server-side roles (viewer/tech/pm/manager/admin) enforce it. No god-mode agents.
2. **File, don't fire.** Agents enrich the record freely (notes, evidence, flags, draft tasks) — low-risk. Anything outbound or costly (client email, booking, delete) stays human-gated. The standing "automate the clerk, never the judgment" rule, team-wide.
3. **Confidence-based matching + audit.** Unsure which event? → a **triage queue** for a human, never force-filed into the wrong event. Every agent write lands in the **activity log** (already built), so it's auditable.

## Why we're already positioned for it
The backend scaffold already exposes a **clean REST API + real server-side roles + an activity/audit log** — exactly the substrate a safe MCP layer needs. The API is MCP-ready by design.

## Sequencing
Rides on top of the **deployed** app (API live, hosted, roles enforced) — so it's the layer added *after* the app is real. But we design the API toward it now (already are). Transport = a hosted/remote MCP server the team connects to, with per-user credentials.

See also: `INTEGRATION.md` (push-to-scheduler + spec-binding), `SCHEMA.md` (roles, activity log), `README.md`.
