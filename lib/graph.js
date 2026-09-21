// ════════════════════════════════════════════════════════════════════════════
// lib/graph.js — the UNATTENDED Microsoft Graph client, and its audit ledger
// ────────────────────────────────────────────────────────────────────────────
// Tony Tran granted tenant API access for Teams transcripts on 2026-09-18 and
// approved APPLICATION-PERMISSION (app-only) pulls — Showrunner reaching into
// the tenant on a timer with nobody watching — on exactly one condition, in his
// words: "keep an audit log if we could."
//
// THAT CONDITION IS THE ARCHITECTURE OF THIS FILE. Every Graph request this app
// makes goes through graphFetch() below, and graphFetch() writes its
// `graph_audit` row in the same flow — before it returns, on success, on an
// HTTP error, and on a socket that never answered. There is no second door: the
// token call, the listing call and the content call are all the same helper with
// different arguments, so a Graph touch WITHOUT its audit row is not something a
// future edit can forget to add — it is something a future edit would have to
// delete the ledger write to achieve, and the smoke suite goes red when it does.
//
// Contrast lib/mail.js, which speaks Graph as a PERSON'S mailbox on a person's
// behalf. This module is the standing agent layer: no user is signed in, nobody
// clicked, and the only thing standing between "convenient" and "surveillance"
// is a ledger somebody can read. So the ledger is not a feature of this module.
// It is the price of admission.
//
// AUTH — client credentials (app-only), the documented shape:
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//        grant_type=client_credentials
//        scope=https://graph.microsoft.com/.default
//   → { access_token, expires_in }   cached until 5 minutes inside its own TTL.
//
// ── ENV VARS (documented in SCHEMA.md § Environment) ────────────────────────
//   GRAPH_TENANT_ID       Entra tenant (GUID)
//   GRAPH_CLIENT_ID       app registration (GUID)
//   GRAPH_CLIENT_SECRET   client secret — NEVER logged, NEVER echoed, NEVER
//                         stored in a ledger row, and scrubbed out of any
//                         upstream error text before it is recorded
//   GRAPH_SWEEP_MINUTES   sweep cadence, default 60   (lib/transcripts.js)
//
// ALL OF THEM ARE UNSET TODAY. The feature ships DARK, in the exact posture of
// the mail / scheduler / dropbox drivers: unconfigured is an honest 501 that
// NAMES the missing variables, and the Settings card says so in plain English
// rather than offering a button that can only fail.
//
// TESTS: GRAPH_LOGIN_BASE / GRAPH_API_BASE override the two hosts and exist
// ONLY so the suites can point this module at scripts/fake-graph.js. Production
// never sets them. Every env var here is read at CALL time so a suite can wire
// and unwire the fake mid-run.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool } = require('./db');

const GRAPH_TIMEOUT_MS = () => parseInt(process.env.GRAPH_TIMEOUT_MS || '20000', 10);
// transcript bodies are real bytes off a CDN-ish endpoint; longer leash
const GRAPH_CONTENT_TIMEOUT_MS = () => parseInt(process.env.GRAPH_CONTENT_TIMEOUT_MS || '60000', 10);

const loginBase = () =>
  String(process.env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const apiBase = () =>
  String(process.env.GRAPH_API_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');

// ── configuration ───────────────────────────────────────────────────────────
// The three the client-credentials flow cannot work without. GRAPH_SWEEP_MINUTES
// is optional and has a default, so it is deliberately not on this list.
const GRAPH_VARS = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'];
function graphMissing() {
  return GRAPH_VARS.filter((k) => !String(process.env[k] || '').trim());
}
function graphConfigured() {
  return graphMissing().length === 0;
}
function notConfigured() {
  const e = new Error(
    'Unattended Graph access is not configured on this server: set ' + graphMissing().join(', ') +
    ' (the app-only registration Tony Tran consented on 2026-09-18). Until then every unattended ' +
    'affordance answers this instead of pretending — and nothing is swept, so nothing is logged.');
  e.status = 501;
  e.code = 'GRAPH_NOT_CONFIGURED';
  e.missing = graphMissing();
  return e;
}

// ── secret hygiene ──────────────────────────────────────────────────────────
// Nothing in this module puts the secret into a message in the first place, but
// upstream error bodies are not ours to vet — Entra has been known to echo a
// submitted parameter back inside an error_description. Anything that looks
// like the configured secret, a bearer token, or a client_secret= form field is
// blanked before it can reach a ledger row, a log line or an HTTP response.
function scrubSecretsWith(s, secret) {
  let out = String(s == null ? '' : s);
  const sec = String(secret || '').trim();
  if (sec && sec.length >= 6) out = out.split(sec).join('<redacted>');
  return out
    .replace(/client_secret=[^&\s"']+/gi, 'client_secret=<redacted>')
    .replace(/(access_token"\s*:\s*")[^"]+/gi, '$1<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>')
    .slice(0, 400);
}
function scrubSecrets(s) {
  return scrubSecretsWith(s, process.env.GRAPH_CLIENT_SECRET);
}

// ── SHARED CLIENT-CREDENTIALS DECISIONS (lib/mail.js drives these too) ──────
// lib/mail.js speaks to a DIFFERENT app registration — MAIL_TENANT_ID /
// MAIL_CLIENT_ID / MAIL_CLIENT_SECRET, consented for Mail.Send and locked to
// one mailbox by ApplicationAccessPolicy — and it deliberately does NOT write
// to this module's graph_audit ledger: that ledger is Tony Tran's condition on
// the UNATTENDED TRANSCRIPT READER, and quietly widening it to cover system
// mail would blur what he actually agreed to. So the two flows share their
// DECISIONS, not their transport, and the decisions live here exactly once:
//
//   tokenFormBody()      the form the token endpoint takes
//   tokenTtlMs()         cache until five minutes inside Entra's own TTL,
//                        floored at 60s so a pathological expires_in cannot
//                        produce a token that is already stale
//   tokenFailureMessage() what a non-token answer MEANS, naming the variables
//                        of whichever registration asked
//
// Fork any of these and two registrations start behaving differently for
// reasons nobody wrote down. That is the whole argument for this block.
function tokenFormBody({ clientId, clientSecret }) {
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(clientId || '').trim(),
    client_secret: String(clientSecret || '').trim(),
    scope: 'https://graph.microsoft.com/.default'
  }).toString();
}
function tokenTtlMs(expiresIn) {
  const ttlS = Number(expiresIn) || 3600;
  return Math.max(60, ttlS - 300) * 1000;
}
function tokenFailureMessage({ status, body, vars, secret }) {
  const detail = body && typeof body === 'object'
    ? (body.error_description || body.error || '')
    : String(body || '').slice(0, 200);
  return `Graph token request failed: ${status}` +
    (detail ? ' — ' + scrubSecretsWith(detail, secret).slice(0, 200) : '') +
    (status === 400 || status === 401
      ? ` (check ${(vars || []).join(' / ')}, and that the application permission ` +
        'is admin-consented)'
      : '');
}

// ── THE LEDGER (Tran's condition) ───────────────────────────────────────────
// One row per Graph REQUEST. `endpoint` is the PATH ONLY: query strings carry
// $filter values, continuation tokens and — on the content endpoint — nothing
// secret today but nothing we want to promise about tomorrow either, so the
// query is dropped at the door rather than trusted.
//
// The write is best-effort-but-loud: a ledger that cannot be written must not
// silently convert an audited call into an unaudited one, so a failure is
// console.error'd with the action it could not record. It does NOT throw —
// killing a sweep because the audit table is momentarily unavailable would
// trade a missing row for a missing sweep, and the health block already carries
// the sweep's own verdict.
function pathOnly(url) {
  try {
    const u = new URL(String(url));
    return u.pathname;
  } catch (_) {
    return String(url || '').split('?')[0].slice(0, 400);
  }
}
async function recordGraphCall({
  action, targetUser, endpoint, httpStatus, outcome, bytes,
  transcriptId, sweepId, fileId, proposalId
}, q = pool) {
  try {
    const r = await q.query(
      `INSERT INTO graph_audit (action, target_user, endpoint, http_status, outcome, bytes,
         transcript_id, sweep_id, file_id, proposal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [String(action || 'unknown').slice(0, 32), String(targetUser || '').slice(0, 320),
       String(endpoint || '').slice(0, 400),
       httpStatus == null ? null : parseInt(httpStatus, 10),
       scrubSecrets(outcome || 'ok').slice(0, 400), bytes == null ? 0 : Number(bytes),
       transcriptId ? String(transcriptId).slice(0, 320) : null,
       sweepId ? String(sweepId).slice(0, 64) : null,
       fileId == null ? null : parseInt(fileId, 10),
       proposalId == null ? null : parseInt(proposalId, 10)]);
    return r.rows[0].id;
  } catch (e) {
    console.error(`[graph-audit] COULD NOT RECORD a '${action}' call — ` +
                  `an unattended Graph touch has gone unlogged: ${e.message}`);
    return null;
  }
}

// The resulting file/proposal is not known until the sweep has matched and
// filed, which is strictly after the request returned. The ROW already exists by
// then — this only enriches it. A call that files nothing simply keeps its nulls.
async function attachGraphResult(auditId, { fileId = null, proposalId = null, note = null } = {}, q = pool) {
  if (!auditId) return false;
  try {
    await q.query(
      `UPDATE graph_audit SET file_id = COALESCE($2, file_id),
                              proposal_id = COALESCE($3, proposal_id),
                              outcome = CASE WHEN $4::text IS NULL THEN outcome
                                             ELSE LEFT(outcome || ' · ' || $4::text, 400) END
       WHERE id = $1`,
      [auditId, fileId == null ? null : parseInt(fileId, 10),
       proposalId == null ? null : parseInt(proposalId, 10),
       note ? scrubSecrets(note).slice(0, 200) : null]);
    return true;
  } catch (e) {
    console.error('[graph-audit] could not attach the result to row ' + auditId + ':', e.message);
    return false;
  }
}

// Keep the ledger bounded the way backup_runs is — a long tail of unattended
// reads, not a forensic archive. 20k rows is roughly a year of hourly sweeps
// across a dozen mailboxes.
//
// Called ONCE PER SWEEP, deliberately, not on every insert: the bound is a
// full-table `NOT IN (… ORDER BY id DESC LIMIT n)`, and paying for that on every
// Graph call would mean a dozen scans an hour to trim rows that accrue a dozen
// an hour. The row-writing path stays one INSERT, which is the path that must
// never be the reason somebody argues for skipping it.
const AUDIT_KEEP = () => {
  const n = parseInt(process.env.GRAPH_AUDIT_KEEP || '20000', 10);
  return Number.isFinite(n) && n >= 100 ? n : 20000;
};
async function pruneGraphAudit(q = pool) {
  try {
    const r = await q.query(
      `DELETE FROM graph_audit WHERE id NOT IN
         (SELECT id FROM graph_audit ORDER BY id DESC LIMIT $1)`, [AUDIT_KEEP()]);
    return r.rowCount;
  } catch (e) {
    console.error('[graph-audit] prune failed (the ledger is intact, merely long):', e.message);
    return 0;
  }
}

// Admin read side — paged, newest first. GET /api/admin/graph-audit.
async function listGraphAudit({ limit = 50, offset = 0, sweepId = null } = {}, q = pool) {
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  // One optional filter, spelled once per query rather than shared — the page
  // read and the count read use different parameter positions, and threading one
  // string through both is how an off-by-one $n bug gets written.
  const rows = (await q.query(
    `SELECT id, at, action, target_user, endpoint, http_status, outcome, bytes,
            transcript_id, sweep_id, file_id, proposal_id
     FROM graph_audit ${sweepId ? 'WHERE sweep_id = $3' : ''}
     ORDER BY id DESC LIMIT $1 OFFSET $2`,
    sweepId ? [lim, off, String(sweepId)] : [lim, off])).rows;
  const total = parseInt((await q.query(
    `SELECT COUNT(*)::int AS n FROM graph_audit ${sweepId ? 'WHERE sweep_id = $1' : ''}`,
    sweepId ? [String(sweepId)] : [])).rows[0].n, 10);
  return {
    rows: rows.map((r) => ({ ...r, bytes: r.bytes == null ? 0 : Number(r.bytes) })),
    total, limit: lim, offset: off
  };
}

// Per-sweep counts, for the Settings card's summary strip.
async function graphAuditBySweep(limit = 10, q = pool) {
  const r = await q.query(
    `SELECT sweep_id, MIN(at) AS started_at, MAX(at) AS ended_at, COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE outcome NOT LIKE 'ok%')::int AS errors,
            COUNT(DISTINCT transcript_id)::int AS transcripts,
            -- A PROPOSED transcript has BOTH ids on its row (the quarantined
            -- file row AND the proposal that governs it), so counting file_id
            -- alone would report every proposal as a filing — the one number on
            -- this card nobody would want overstated.
            COUNT(*) FILTER (WHERE file_id IS NOT NULL AND proposal_id IS NULL)::int AS filed,
            COUNT(*) FILTER (WHERE proposal_id IS NOT NULL)::int AS proposed,
            COALESCE(SUM(bytes),0)::bigint AS bytes
     FROM graph_audit WHERE sweep_id IS NOT NULL
     GROUP BY sweep_id ORDER BY MAX(at) DESC LIMIT $1`,
    [Math.min(100, Math.max(1, parseInt(limit, 10) || 10))]);
  return r.rows.map((x) => ({ ...x, bytes: Number(x.bytes) }));
}

// ── the token cache ─────────────────────────────────────────────────────────
// Cached until five minutes inside Entra's own reported TTL — the same
// cache-and-margin shape as lib/dropbox.js, because it is the same problem. The
// TOKEN CALL IS AUDITED TOO: "the app authenticated as itself at 03:00" is
// exactly the kind of line Tran asked for, and a cached token means the ledger
// shows one token row per hour rather than one per request, which is itself the
// honest picture of what the app did.
let _tok = null;
let _exp = 0;
let _tokenFetches = 0;                       // suite-visible; see graphTokenStats
async function graphToken(force, ctx = {}) {
  if (!force && _tok && Date.now() < _exp) return _tok;
  if (!graphConfigured()) throw notConfigured();
  const url = `${loginBase()}/${encodeURIComponent(String(process.env.GRAPH_TENANT_ID).trim())}` +
              '/oauth2/v2.0/token';
  _tokenFetches += 1;
  const r = await graphFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenFormBody({ clientId: process.env.GRAPH_CLIENT_ID,
                          clientSecret: process.env.GRAPH_CLIENT_SECRET })
  }, { action: 'token', targetUser: '(application)', sweepId: ctx.sweepId || null,
       timeoutMs: GRAPH_TIMEOUT_MS() });
  if (!r.ok || !r.body || !r.body.access_token) {
    const e = new Error(tokenFailureMessage({
      status: r.status, body: r.body, vars: GRAPH_VARS,
      secret: process.env.GRAPH_CLIENT_SECRET }));
    e.status = 502;
    e.auditId = r.auditId;
    throw e;
  }
  _tok = r.body.access_token;
  _exp = Date.now() + tokenTtlMs(r.body.expires_in);       // 5-min margin inside their TTL
  return _tok;
}
function graphResetToken() { _tok = null; _exp = 0; }
// The suites assert "the second call hits the token endpoint zero times". This
// is the counter they read; nothing in production consults it.
function graphTokenStats() { return { fetches: _tokenFetches, cached: !!_tok && Date.now() < _exp }; }
function graphResetTokenStats() { _tokenFetches = 0; }

// ════════════════════════════════════════════════════════════════════════════
// THE REQUEST HELPER — the ONE place a Graph request is made, and therefore the
// one place the audit row is written.
// ────────────────────────────────────────────────────────────────────────────
// Do not add a second fetch() to this module, and do not let a caller build one
// of its own: the guarantee Tran was given is structural, not procedural. Every
// exit from this function — 2xx, 4xx, 5xx, timeout, DNS failure — passes through
// one of the two recordGraphCall() calls below.
//
// Returns { ok, status, body, bytes, auditId }. It NEVER throws for an HTTP
// status: classifying a 403 is the caller's job, and a thrown error here would
// be a path that skipped the ledger write on the way out.
// ════════════════════════════════════════════════════════════════════════════
async function graphFetch(url, options = {}, ctx = {}) {
  const budget = ctx.timeoutMs || GRAPH_TIMEOUT_MS();
  const endpoint = pathOnly(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    // UNREACHABLE IS AN AUDITED EVENT. "We tried to read Tony's meetings at
    // 03:00 and the tenant did not answer" is a fact the log owes its reader
    // just as much as a successful read is.
    const why = err && err.name === 'AbortError'
      ? `unreachable — timed out after ${budget}ms`
      : `unreachable — ${err && err.message ? err.message : err}`;
    const auditId = await recordGraphCall({
      action: ctx.action, targetUser: ctx.targetUser, endpoint,
      httpStatus: null, outcome: 'error: ' + why, bytes: 0,
      transcriptId: ctx.transcriptId, sweepId: ctx.sweepId });
    return { ok: false, status: 0, body: null, bytes: 0, auditId, error: why, ms: Date.now() - t0 };
  }
  clearTimeout(timer);

  let body = null;
  let bytes = 0;
  let text = '';
  if (ctx.wantBytes && res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    body = buf;
    bytes = buf.length;
  } else {
    text = await res.text();
    bytes = Buffer.byteLength(text || '', 'utf8');
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  }

  // THE ERROR TEXT IS RECORDED VERBATIM (scrubbed of secrets, capped at 400
  // chars). The mandate on this feature is explicit and it is the right call:
  // the FIRST LIVE call is what proves the endpoint shape, the licensing and
  // the tenant toggle, and a swallowed upstream message would throw away the
  // one artifact that tells us which of those three we hit.
  const outcome = res.ok ? 'ok' : 'error: ' + graphErrorText(body, text, res.status);
  const auditId = await recordGraphCall({
    action: ctx.action, targetUser: ctx.targetUser, endpoint,
    httpStatus: res.status, outcome, bytes,
    transcriptId: ctx.transcriptId, sweepId: ctx.sweepId });

  return { ok: res.ok, status: res.status, body, bytes, auditId,
           error: res.ok ? null : outcome.slice(7), ms: Date.now() - t0 };
}

// Graph speaks several dialects of failure: the v1.0 { error: { code, message } }
// envelope, the OAuth { error, error_description } envelope, and — on some
// metered and some proxy paths — plain text. All three land here so a ledger row
// says what actually came back instead of "502".
// `secret` names WHICH registration's secret to blank out of the upstream text;
// it defaults to this module's so every existing caller is unchanged, and
// lib/mail.js passes its own rather than growing a second copy of the two error
// dialects Graph answers in.
function graphErrorText(body, text, status, secret = process.env.GRAPH_CLIENT_SECRET) {
  const scrub = (s) => scrubSecretsWith(s, secret);
  if (body && typeof body === 'object' && body.error) {
    const e = body.error;
    if (typeof e === 'object') {
      return scrub(`${e.code || status} — ${e.message || ''}`.trim());
    }
    return scrub(`${e} — ${body.error_description || ''}`.trim());
  }
  if (typeof body === 'string' && body.trim()) return scrub(body);
  if (text && text.trim()) return scrub(text);
  return `HTTP ${status}`;
}

// ── the thin verbs ──────────────────────────────────────────────────────────
// Both take the same ctx the audit row needs, and both refuse to run at all when
// the app is unconfigured — a 501 before the socket, which is how the dark
// posture stays dark instead of becoming a DNS lookup to login.microsoftonline.
async function graphGet(path, ctx = {}) {
  if (!graphConfigured()) throw notConfigured();
  const token = await graphToken(false, ctx);
  const url = path.startsWith('http') ? path : apiBase() + path;
  return graphFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(ctx.headers || {}) }
  }, { ...ctx, timeoutMs: ctx.timeoutMs || (ctx.wantBytes ? GRAPH_CONTENT_TIMEOUT_MS() : GRAPH_TIMEOUT_MS()) });
}
async function graphPost(path, payload, ctx = {}) {
  if (!graphConfigured()) throw notConfigured();
  const token = await graphToken(false, ctx);
  const url = path.startsWith('http') ? path : apiBase() + path;
  return graphFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
               Accept: 'application/json', ...(ctx.headers || {}) },
    body: JSON.stringify(payload == null ? {} : payload)
  }, { ...ctx, timeoutMs: ctx.timeoutMs || GRAPH_TIMEOUT_MS() });
}

// ── the health block's config half (/api/health "graph") ────────────────────
// PRESENCE booleans read from env, never a value — the doctrine the scheduler
// and dropbox blocks already set, and the phrasing is deliberately the same:
// this is CONFIGURATION, and it has never opened a socket.
function configBlock() {
  return {
    configured: graphConfigured(),
    tenantIdSet: !!String(process.env.GRAPH_TENANT_ID || '').trim(),
    clientIdSet: !!String(process.env.GRAPH_CLIENT_ID || '').trim(),
    clientSecretSet: !!String(process.env.GRAPH_CLIENT_SECRET || '').trim(),
    missing: graphMissing(),
    configuredMeans: 'env vars are present in this process. This is NOT a login test — the first ' +
      'live sweep is what measures the app registration, the admin consent, the transcript ' +
      'toggle and whatever Microsoft meters on app-only transcript reads. Every one of those ' +
      'answers lands verbatim in the audit log.'
  };
}

module.exports = {
  // config
  GRAPH_VARS, graphConfigured, graphMissing, notConfigured, configBlock,
  scrubSecrets, scrubSecretsWith,
  // the client-credentials DECISIONS, shared with lib/mail.js's own registration
  tokenFormBody, tokenTtlMs, tokenFailureMessage,
  // transport (the token pair is exported for the suites' cache assertions)
  graphFetch, graphGet, graphPost, graphToken, graphResetToken,
  graphTokenStats, graphResetTokenStats, graphErrorText, pathOnly,
  // the ledger
  recordGraphCall, attachGraphResult, listGraphAudit, graphAuditBySweep, pruneGraphAudit
};
