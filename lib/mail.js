// ════════════════════════════════════════════════════════════════════════════
// lib/mail.js — F3. THE DELIVERY DRIVERS behind the notification outbox
// ────────────────────────────────────────────────────────────────────────────
// Two drivers, chosen by MAIL_DRIVER. Neither one can be reached except through
// lib/notify.js flush(), so "how a notification is delivered" has exactly one
// call site and the outbox row is always updated by the same code path.
//
//   log    (DEFAULT) — writes the message to the activity log and marks the
//                      outbox row sent. This is NOT a stub: on a Railway box
//                      with no mailbox configured it is the honest, auditable
//                      behaviour — the notification is recorded, addressed, and
//                      visible, it simply travelled zero metres. Every suite
//                      runs against it.
//
//   graph            — Microsoft Graph `sendMail` from the dedicated
//                      showrunner@ mailbox (TEAM_FEEDBACK, Tom 2026-08-27:
//                      app registration, admin-consented, ApplicationAccess-
//                      Policy-locked to that one mailbox). WIRED 2026-09-21,
//                      and the reason it had to be: the MAIL_* vars went into
//                      production, the driver flipped to 'graph', and every
//                      queued row came back carrying "configured but not yet
//                      wired" — an @mention and three days of digests per
//                      person, sitting in the outbox behind a skeleton. The
//                      helpers had been written for a year; the two calls had
//                      not. Unconfigured it still answers a 501-shaped "mail
//                      not configured" and THE ITEM STAYS QUEUED, so turning
//                      the env vars on later delivers the backlog rather than
//                      discovering it was thrown away.
//
// SYSTEM MAIL IS NOT AGENT OUTBOUND. "file-don't-fire" (AGENT_API §9) is about
// an agent sending mail AS A PERSON. This is the app telling a person that
// something of theirs changed, from its own mailbox, on that person's stated
// preference. The two never touch: nothing here reads a user's mailbox, signs
// as a user, or replies to a thread.
//
// ── ENV VARS (documented in SCHEMA.md § Environment) ────────────────────────
//   MAIL_DRIVER          'log' (default) | 'graph'
//   MAIL_FROM            the sending mailbox, e.g. showrunner@e360sport.com
//   MAIL_TENANT_ID       Entra tenant (GUID)
//   MAIL_CLIENT_ID       app registration (GUID)
//   MAIL_CLIENT_SECRET   client secret
//   MAIL_REPLY_TO        optional Reply-To
//   APP_BASE_URL         used to build the deep link in the message body
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { MAIL_DRIVERS } = require('./enums');
// The client-credentials DECISIONS, not the transport. lib/graph.js owns them
// because it got there first; this module drives them with a DIFFERENT app
// registration (MAIL_*) and deliberately does not write to that module's
// graph_audit ledger — see the block above tokenFormBody() over there for why.
const { tokenFormBody, tokenTtlMs, tokenFailureMessage,
        graphErrorText, scrubSecretsWith } = require('./graph');

function driverName() {
  const v = String(process.env.MAIL_DRIVER || 'log').toLowerCase();
  return MAIL_DRIVERS.includes(v) ? v : 'log';
}

// The four vars the graph driver cannot work without. MAIL_REPLY_TO is optional.
const GRAPH_VARS = ['MAIL_TENANT_ID', 'MAIL_CLIENT_ID', 'MAIL_CLIENT_SECRET', 'MAIL_FROM'];
function graphMissing() {
  return GRAPH_VARS.filter((k) => !String(process.env[k] || '').trim());
}
// Is the configured driver actually able to deliver right now?
function mailConfigured() {
  return driverName() === 'graph' ? graphMissing().length === 0 : true;
}
function appBaseUrl() {
  return String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
}
// A relative in-app link ('/#show/41') becomes absolute when APP_BASE_URL is
// set, and stays relative — still useful, still honest — when it is not.
function absoluteLink(link) {
  const l = String(link || '');
  if (!l) return '';
  if (/^https?:\/\//i.test(l)) return l;
  const base = appBaseUrl();
  return base ? base + (l.startsWith('/') ? l : '/' + l) : l;
}

// ── the message shape both drivers take ─────────────────────────────────────
//   { to, toName, subject, text, link }
// `text` is PLAIN TEXT. Nothing here builds HTML: a notification is one or two
// sentences and a link, and an HTML body would be a template to maintain and an
// injection surface to guard for no gain.
function renderText(msg) {
  const link = absoluteLink(msg.link);
  return [String(msg.text || '').trim(), link ? '\n' + link : '',
          '\n— e360 Showrunner. Change what reaches you in Settings → Notifications.']
    .filter(Boolean).join('\n');
}

// ── driver: log ─────────────────────────────────────────────────────────────
// Returns the same contract as graph. `logged` is what the caller writes into
// the activity trail, so the delivery is auditable without a mail server.
async function sendViaLog(msg) {
  return {
    ok: true,
    driver: 'log',
    detail: `mail(log) → ${msg.to}: ${msg.subject}`,
    body: renderText(msg)
  };
}

// ── driver: graph (skeleton) ────────────────────────────────────────────────
// The two URLs and the exact request body, written down so wiring this up is a
// credential change and not a design exercise.
// TESTS ONLY: MAIL_GRAPH_LOGIN_BASE / MAIL_GRAPH_API_BASE override the two
// hosts so the suites can point this driver at scripts/fake-graph.js, exactly
// as GRAPH_LOGIN_BASE / GRAPH_API_BASE do for lib/graph.js. Production never
// sets them, and both are read at CALL time so a suite can wire and unwire the
// fake mid-run without a reboot.
const loginBase = () =>
  String(process.env.MAIL_GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');
const apiBase = () =>
  String(process.env.MAIL_GRAPH_API_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');

function graphTokenUrl() {
  return `${loginBase()}/${encodeURIComponent(process.env.MAIL_TENANT_ID || '')}` +
         '/oauth2/v2.0/token';
}
function graphSendMailUrl(from) {
  return `${apiBase()}/users/${encodeURIComponent(from)}/sendMail`;
}
function graphSendMailBody(msg) {
  const body = {
    message: {
      subject: String(msg.subject || '').slice(0, 240),
      body: { contentType: 'Text', content: renderText(msg) },
      toRecipients: [{ emailAddress: { address: String(msg.to || '') } }]
    },
    saveToSentItems: false
  };
  const reply = String(process.env.MAIL_REPLY_TO || '').trim();
  if (reply) body.message.replyTo = [{ emailAddress: { address: reply } }];
  return body;
}

// ── the transport ───────────────────────────────────────────────────────────
// Deliberately NOT lib/graph.js graphFetch(): that helper writes a graph_audit
// row on every exit, and that ledger is Tony Tran's condition on the UNATTENDED
// TRANSCRIPT READER. System mail is a different registration, a different
// consent and a different promise, and quietly filing it under his audit would
// misrepresent both. What the two share is the DECISIONS (token form, cache
// margin, failure wording), imported at the top of this file.
//
// NEVER THROWS. Every exit is { ok, status, body } so the classifier below is
// the only place an outcome is decided.
const MAIL_TIMEOUT_MS = () => {
  const v = parseInt(process.env.MAIL_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v >= 1000 && v <= 120000 ? v : 20000;
};
async function mailFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS());
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (_) { body = text; } }
    return { ok: res.ok, status: res.status, body, text };
  } catch (err) {
    // A host that never answered is status 0 — transient by definition, and the
    // classifier treats it as retryable so the row keeps its place in the queue.
    const why = err && err.name === 'AbortError'
      ? `unreachable — timed out after ${MAIL_TIMEOUT_MS()}ms`
      : `unreachable — ${(err && err.message) || err}`;
    return { ok: false, status: 0, body: null, text: '', error: why };
  } finally {
    clearTimeout(timer);
  }
}

// ── the token, cached ───────────────────────────────────────────────────────
// Its own cache, not lib/graph.js's: two registrations, two secrets, two
// tokens. The MARGIN is shared (tokenTtlMs) so they cannot drift apart.
let _tok = null;
let _exp = 0;
let _tokenFetches = 0;                        // suite-visible; see mailTokenStats
async function mailToken(force = false) {
  if (!force && _tok && Date.now() < _exp) return _tok;
  _tokenFetches += 1;
  const r = await mailFetch(graphTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenFormBody({ clientId: process.env.MAIL_CLIENT_ID,
                          clientSecret: process.env.MAIL_CLIENT_SECRET })
  });
  if (!r.ok || !r.body || !r.body.access_token) {
    const e = new Error(r.error
      ? `Graph token request failed: ${r.error}`
      // the three the TOKEN call uses — MAIL_FROM is required by the driver but
      // is never sent to Entra, so naming it in a token-failure hint would send
      // an operator to check the wrong variable
      : tokenFailureMessage({ status: r.status, body: r.body,
                              vars: ['MAIL_TENANT_ID', 'MAIL_CLIENT_ID', 'MAIL_CLIENT_SECRET'],
                              secret: process.env.MAIL_CLIENT_SECRET }));
    e.status = r.status || 0;
    throw e;
  }
  _tok = r.body.access_token;
  _exp = Date.now() + tokenTtlMs(r.body.expires_in);
  return _tok;
}
function mailResetToken() { _tok = null; _exp = 0; }
function mailTokenStats() { return { fetches: _tokenFetches, cached: !!_tok && Date.now() < _exp }; }
function mailResetTokenStats() { _tokenFetches = 0; }

// ── the classifier ──────────────────────────────────────────────────────────
// THE WHOLE POINT OF THE OUTBOX'S TWO FAILURE STATES lives in this function.
//   retryable → the row stays QUEUED with last_error. "We could not send this
//               YET": a dead host, a throttle, a consent that has not finished
//               propagating, a token that expired mid-flight. The backlog
//               delivers when the condition clears.
//   not       → the row goes to FAILED. "We will never send this": Graph
//               rejected the PAYLOAD — a malformed address, a body it refuses.
//               Retrying that forever is a loop, not a recovery.
// 403 sits on the retryable side on purpose: on this tenant it is what an
// ApplicationAccessPolicy that has not caught up answers, and that resolves by
// itself. It is NOT a reason to throw a person's notification away.
function graphSendRetryable(status) {
  if (status === 0) return true;                       // never reached the host
  if (status === 401 || status === 403 || status === 408 || status === 429) return true;
  if (status >= 500) return true;                      // Graph's own bad day
  return false;                                        // 400-class payload refusal
}

async function sendViaGraph(msg) {
  const missing = graphMissing();
  if (missing.length) {
    // 501-shaped and NOT a failure of the message: the caller leaves the row
    // QUEUED so the backlog delivers the day the mailbox exists.
    return {
      ok: false, retryable: true, status: 501, driver: 'graph',
      error: 'mail not configured — set ' + missing.join(', ') +
             ' (Graph sendMail from the dedicated showrunner@ mailbox; see SCHEMA.md § Environment)'
    };
  }
  const from = String(process.env.MAIL_FROM || '').trim();

  let token;
  try {
    token = await mailToken();
  } catch (e) {
    // A token we could not get is ALWAYS retryable: wrong credentials are an
    // operator problem that gets fixed, and throwing the notification away
    // would destroy the evidence that anything was ever owed.
    return { ok: false, retryable: true, status: e.status || 502, driver: 'graph',
             error: String(e.message || e).slice(0, 400) };
  }

  const post = (tk) => mailFetch(graphSendMailUrl(from), {
    method: 'POST',
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(graphSendMailBody(msg))
  });

  let r = await post(token);
  // A cached token that went stale between the check and the call: refresh ONCE
  // and retry. Exactly once — a 401 that survives a fresh token is a real
  // authorization problem, and looping on it would hammer Entra.
  if (r.status === 401) {
    try {
      token = await mailToken(true);
      r = await post(token);
    } catch (e) {
      return { ok: false, retryable: true, status: e.status || 502, driver: 'graph',
               error: String(e.message || e).slice(0, 400) };
    }
  }

  // Graph answers 202 Accepted with an EMPTY body on success — there is no id
  // to record and no receipt to keep, which is why the outbox row's own
  // sent_at + driver is the record of the delivery.
  if (r.status === 202 || (r.status >= 200 && r.status < 300)) {
    return { ok: true, driver: 'graph', status: r.status,
             detail: `mail(graph) → ${msg.to}: ${msg.subject}` };
  }
  const why = graphErrorText(r.body, r.error || r.text, r.status, process.env.MAIL_CLIENT_SECRET);
  return {
    ok: false, retryable: graphSendRetryable(r.status), status: r.status, driver: 'graph',
    error: scrubSecretsWith(why, process.env.MAIL_CLIENT_SECRET).slice(0, 400)
  };
}

async function send(msg) {
  const d = driverName();
  try {
    if (d === 'graph') return await sendViaGraph(msg);
    return await sendViaLog(msg);
  } catch (e) {
    // The contract is a RESULT, never an exception. lib/notify.js flushOne
    // catches too, and this belt stays because a driver that throws past its
    // own contract is the shape that loses a notification silently.
    return { ok: false, retryable: true, driver: d,
             error: scrubSecretsWith(String((e && e.message) || e), process.env.MAIL_CLIENT_SECRET) };
  }
}

module.exports = {
  send, driverName, mailConfigured, graphMissing, absoluteLink, renderText,
  graphTokenUrl, graphSendMailUrl, graphSendMailBody, GRAPH_VARS,
  // the wire, exported for the suites (token-cache and classification assertions)
  mailToken, mailResetToken, mailTokenStats, mailResetTokenStats, graphSendRetryable
};
