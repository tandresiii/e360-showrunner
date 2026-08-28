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
//                      Policy-locked to that one mailbox). THE WIRE CALL IS
//                      DELIBERATELY NOT MADE YET: the mailbox and the app
//                      registration do not exist, so there is nothing to
//                      authenticate against and a half-written client would be
//                      untestable fiction. What IS built is everything up to
//                      the wire — config detection, the token-endpoint and
//                      sendMail URLs, the exact JSON body, and the failure
//                      contract. Unconfigured it answers a 501-shaped
//                      "mail not configured" and THE ITEM STAYS QUEUED, so
//                      turning the env vars on later delivers the backlog
//                      rather than discovering it was thrown away.
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
function graphTokenUrl() {
  return `https://login.microsoftonline.com/${encodeURIComponent(process.env.MAIL_TENANT_ID || '')}` +
         '/oauth2/v2.0/token';
}
function graphSendMailUrl(from) {
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
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
  // ── TODO (honest, not a stub-that-lies) ─────────────────────────────────
  // The wire call is not written because there is nothing to write it against:
  // the mailbox + app registration are an M365-admin task that has not happened
  // (HANDOFF "Open / next"). When it does, this is the whole of it:
  //   1. POST graphTokenUrl() with
  //        client_id / client_secret / scope=https://graph.microsoft.com/.default
  //        / grant_type=client_credentials       → cache the token ~55 min
  //   2. POST graphSendMailUrl(MAIL_FROM) with Bearer <token> and
  //        graphSendMailBody(msg)                → 202 Accepted on success
  //   3. map 401 → refresh once and retry; 429 → retryable with Retry-After;
  //      4xx other → { ok:false, retryable:false } so it lands as 'failed'.
  // Until then a CONFIGURED graph driver refuses loudly rather than silently
  // pretending: a queued notification is recoverable, a fake receipt is not.
  return {
    ok: false, retryable: true, status: 501, driver: 'graph',
    error: 'Graph sendMail is configured but not yet wired — the mailbox and app ' +
           'registration are pending (SCHEMA.md § Environment). The item stays queued.'
  };
}

async function send(msg) {
  const d = driverName();
  if (d === 'graph') return sendViaGraph(msg);
  return sendViaLog(msg);
}

module.exports = {
  send, driverName, mailConfigured, graphMissing, absoluteLink, renderText,
  graphTokenUrl, graphSendMailUrl, graphSendMailBody, GRAPH_VARS
};
