// ════════════════════════════════════════════════════════════════════════════
// scripts/fake-graph.js — a local stand-in for Microsoft Graph (app-only)
// ────────────────────────────────────────────────────────────────────────────
// The suites must prove the unattended transcript reader against SOMETHING, and
// the live tenant is off the table by hard rule (no authenticated production
// calls, ever). This is a minimal in-memory express app implementing exactly the
// endpoint surface lib/graph.js and lib/transcripts.js drive:
//
//   POST /{tenant}/oauth2/v2.0/token                     the client-credentials
//        form-encoded, grant_type=client_credentials,    token endpoint
//        scope=https://graph.microsoft.com/.default
//   GET  /users/{id}/onlineMeetings/getAllTranscripts(     the listing — an
//          meetingOrganizerUserId='{id}',                  ODATA FUNCTION CALL
//          startDateTime={iso})?$top=n
//   GET  /users/{id}/onlineMeetings/{mid}/transcripts/{tid}/content
//        ?$format=text/vtt                                the body
//
// Faithfulness rules, in order of importance:
//   · EVERY call requires a Bearer token this server minted, exactly like the
//     real one — which is what makes "the second sweep fetches no new token"
//     a meaningful assertion rather than a counter nobody checks.
//   · THE LISTING TAKES ONLY THE FUNCTION-PARAMETER SPELLING. v1.0's
//     getAllTranscripts is an OData function, and on 2026-09-21 the live tenant
//     answered our old bare-path guess with a 400 saying so in as many words.
//     That 400 is reproduced here VERBATIM for the old spelling, so the shape is
//     PINNED by the suite rather than described in a comment nobody re-reads:
//     revert lib/transcripts.js's listPath and section G goes red immediately.
//   · the function parameters are HONOURED, not ignored: the organizer is what
//     the lookup is keyed on (so a listing that forgets it cannot accidentally
//     work), and startDateTime really does drop transcripts created at or before
//     the watermark, so the overlap-window logic is exercised instead of assumed.
//   · error bodies are Graph's OWN SHAPES, both dialects:
//       - the v1.0 envelope { error: { code, message } } for the 403 a tenant
//         with transcription switched off returns;
//       - the 402 payment/licensing refusal Microsoft returns for metered
//         app-only Teams APIs a tenant has not onboarded to a billing model.
//     Both must land honestly in the audit log and NEITHER may crash a sweep.
//   · a `failWhen` predicate arms those per-request, so a test can fail one
//     user's listing and prove the sweep carries on to the next one.
//
// This file is test infrastructure: it must never be mounted by server.js and
// no production code path may ever import it.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');

// The two error bodies, verbatim in shape. Kept as named builders so an
// assertion can say WHICH refusal it expects rather than matching a status code
// two different faults share.
function transcriptsDisabledBody() {
  return {
    error: {
      code: 'Forbidden',
      message: 'Transcription is disabled for this organization, or the meeting policy ' +
               'does not permit access to the transcript.',
      innerError: { code: 'transcriptAccessDisabled', date: new Date().toISOString() }
    }
  };
}
// VERBATIM from the live tenant, 2026-09-21 14:23 UTC — this is the exact text
// six mailboxes returned against the bare `getAllTranscripts?$filter=…` spelling
// we shipped on 0788468. Kept word for word so the suite's red line and the
// production audit row read the same, and nobody has to wonder whether the fake
// is testing the fault we actually met.
function organizerParamMissingBody() {
  return {
    error: {
      code: 'BadRequest',
      message: "meetingOrganizerUserId='{userId}' expected as a function parameter",
      innerError: { code: 'BadRequest', date: new Date().toISOString() }
    }
  };
}
// DOC-DERIVED, not observed — said plainly so it is never mistaken for the one
// above. The v1.0 reference lists `$top` as the ONLY OData query option this
// method supports and puts the date window in the function parentheses, so a
// `$filter` riding along is a client bug this fake refuses rather than ignores.
function filterNotSupportedBody() {
  return {
    error: {
      code: 'BadRequest',
      message: 'The query option $filter is not supported on getAllTranscripts. Pass the ' +
               'startDateTime and endDateTime function parameters; $top is the only ' +
               'supported OData query option.',
      innerError: { code: 'BadRequest', date: new Date().toISOString() }
    }
  };
}
function meteredLicenseBody() {
  return {
    error: {
      code: 'PaymentRequired',
      message: 'The tenant has not been onboarded to a billing model for this metered API. ' +
               'Teams application-level transcript access requires an Azure subscription ' +
               'linked for consumption billing.',
      innerError: { code: 'MeteredApiNotOnboarded', date: new Date().toISOString() }
    }
  };
}

function startFakeGraph({ tenant = 'fake-tenant', clientId = 'fake-client',
                          clientSecret = 'fake-secret' } = {}) {
  const state = {
    tokenHits: 0,              // "the second call hits the token endpoint zero times"
    listHits: 0,
    contentHits: 0,
    sendHits: 0,               // lib/mail.js's graph driver
    sent: [],                  // { fromUser, to, subject, text, replyTo }
    requests: [],              // { method, path, user, auth }
    tokens: new Set(),
    tokenTtl: 3600,
    // transcripts, keyed by the user id/email the sweep asks about
    byUser: {},                // { 'tony@…': [ { id, meetingId, createdDateTime, subject, vtt } ] }
    // ARMED FAILURES. (req) => null | { status, body }  — null means "answer
    // normally". This is how a test fails exactly one user and proves the sweep
    // continues to the next.
    failWhen: null
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    state.requests.push({
      method: req.method, path: req.path,
      query: req.originalUrl.slice(req.path.length),
      auth: req.headers.authorization ? 'bearer' : null
    });
    next();
  });

  // ── the token endpoint ────────────────────────────────────────────────────
  app.post('/:tenant/oauth2/v2.0/token', (req, res) => {
    state.tokenHits += 1;
    const b = req.body || {};
    if (req.params.tenant !== tenant) {
      return res.status(400).json({ error: 'invalid_request',
        error_description: `AADSTS90002: Tenant '${req.params.tenant}' not found.` });
    }
    if (b.grant_type !== 'client_credentials') {
      return res.status(400).json({ error: 'unsupported_grant_type',
        error_description: 'AADSTS70000: only client_credentials is accepted here.' });
    }
    if (b.scope !== 'https://graph.microsoft.com/.default') {
      return res.status(400).json({ error: 'invalid_scope',
        error_description: 'AADSTS70011: app-only tokens take the .default scope.' });
    }
    if (b.client_id !== clientId || b.client_secret !== clientSecret) {
      return res.status(401).json({ error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.' });
    }
    const token = 'fake-graph-tok-' + Math.random().toString(36).slice(2);
    state.tokens.add(token);
    res.json({ token_type: 'Bearer', expires_in: state.tokenTtl, ext_expires_in: state.tokenTtl,
               access_token: token });
  });

  // Every Graph call below is token-gated, like the real one.
  const requireToken = (req, res, next) => {
    const h = String(req.headers.authorization || '');
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!t || !state.tokens.has(t)) {
      return res.status(401).json({ error: { code: 'InvalidAuthenticationToken',
        message: 'Access token is empty or invalid.' } });
    }
    next();
  };
  // The armed-failure hook, applied AFTER auth so a test cannot accidentally
  // prove "it handled a 403" against a request that never authenticated.
  const maybeFail = (req, res, next) => {
    if (typeof state.failWhen === 'function') {
      const f = state.failWhen(req);
      if (f) return res.status(f.status).json(f.body);
    }
    next();
  };

  // ── the listing ───────────────────────────────────────────────────────────
  // THE FUNCTION-CALL FORM, AND ONLY IT. A RegExp route, because the segment
  // ends in `getAllTranscripts(...)` and express's string patterns treat
  // parentheses as syntax of their own. Group 1 is the mailbox, group 2 is the
  // raw parameter list — both percent-decoded by express, exactly as Graph
  // decodes a path before the OData parser ever sees the literals inside it.
  const LIST_FN = /^\/users\/([^/]+)\/onlineMeetings\/getAllTranscripts\((.*)\)$/;
  app.get(LIST_FN, requireToken, maybeFail, (req, res) => {
    const args = String(req.params[1] || '');
    // The organizer is REQUIRED and is what the lookup is keyed on. A listing
    // that omits it cannot quietly return the right answer by falling back to
    // the path segment — it gets Microsoft's own 400, which is the whole point.
    const mOrg = /(?:^|,)\s*meetingOrganizerUserId\s*=\s*'((?:[^']|'')*)'\s*(?:,|$)/.exec(args);
    if (!mOrg) return res.status(400).json(organizerParamMissingBody());
    // $top is the only query option v1.0 documents here; a $filter is the old
    // spelling leaking back in and is refused rather than silently honoured.
    if (req.query.$filter !== undefined) return res.status(400).json(filterNotSupportedBody());
    state.listHits += 1;
    const uid = mOrg[1].replace(/''/g, "'");
    const all = state.byUser[uid] || [];
    // Honour startDateTime / endDateTime — the watermark really bites.
    const mStart = /(?:^|,)\s*startDateTime\s*=\s*([^,)]+)/.exec(args);
    const mEnd = /(?:^|,)\s*endDateTime\s*=\s*([^,)]+)/.exec(args);
    const since = mStart ? new Date(mStart[1].trim()) : null;
    const until = mEnd ? new Date(mEnd[1].trim()) : null;
    const top = Math.max(1, parseInt(req.query.$top, 10) || 50);
    const value = all
      .filter((t) => !until || new Date(t.createdDateTime) <= until)
      .filter((t) => !since || new Date(t.createdDateTime) > since)
      .slice(0, top)
      .map((t) => ({
        id: t.id,
        meetingId: t.meetingId,
        meetingOrganizerId: uid,
        createdDateTime: t.createdDateTime,
        subject: t.subject || '',
        transcriptContentUrl:
          `/users/${encodeURIComponent(uid)}/onlineMeetings/${encodeURIComponent(t.meetingId)}` +
          `/transcripts/${encodeURIComponent(t.id)}/content`
      }));
    res.json({ '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#transcripts', value });
  });

  // THE OLD SPELLING, REFUSED. Registered AFTER the function form so it only
  // ever catches the bare path — `getAllTranscripts` with no parentheses, which
  // is what shipped on 0788468 and what the tenant rejected six times on
  // 2026-09-21. It answers that same 400 rather than a 404, because a 404 would
  // read like "no such mailbox" and send the next person down the wrong road.
  // This route exists to be HIT BY A REGRESSION and by nothing else.
  app.get('/users/:uid/onlineMeetings/getAllTranscripts', requireToken, maybeFail, (req, res) =>
    res.status(400).json(organizerParamMissingBody()));

  // ── the body ──────────────────────────────────────────────────────────────
  app.get('/users/:uid/onlineMeetings/:mid/transcripts/:tid/content',
    requireToken, maybeFail, (req, res) => {
      state.contentHits += 1;
      const list = state.byUser[req.params.uid] || [];
      const t = list.find((x) => x.id === req.params.tid);
      if (!t) {
        return res.status(404).json({ error: { code: 'itemNotFound',
          message: 'The requested transcript could not be found.' } });
      }
      res.set('Content-Type', 'text/vtt');
      res.send(t.vtt);
    });

  // ── sendMail (lib/mail.js's graph driver) ─────────────────────────────────
  // The SAME token endpoint above mints what this route demands, because the
  // real Graph works that way too — a different app registration, the same
  // client-credentials shape. Success is 202 Accepted with an EMPTY body, which
  // is exactly the thing a driver written against a guess gets wrong.
  //
  // The payload is CHECKED, not just counted: a sendMail with no recipient or
  // no subject is a 400 here, so "we posted something" can never pass for "we
  // posted the right thing".
  app.post('/users/:uid/sendMail', requireToken, maybeFail, (req, res) => {
    state.sendHits += 1;
    const b = req.body || {};
    const m = b.message || {};
    const to = ((m.toRecipients || [])[0] || {}).emailAddress || {};
    if (!to.address) {
      return res.status(400).json({ error: { code: 'ErrorInvalidRecipients',
        message: 'At least one recipient is required.' } });
    }
    if (!m.subject) {
      return res.status(400).json({ error: { code: 'ErrorInvalidItem',
        message: 'A message requires a subject.' } });
    }
    state.sent.push({
      fromUser: req.params.uid,                 // the /users/{id}/ path segment
      to: to.address,
      subject: m.subject,
      contentType: (m.body || {}).contentType || '',
      text: (m.body || {}).content || '',
      replyTo: ((m.replyTo || [])[0] || {}).emailAddress
        ? m.replyTo[0].emailAddress.address : null,
      saveToSentItems: b.saveToSentItems
    });
    res.status(202).end();                      // 202 Accepted, empty body
  });

  // Anything else is Graph's own 404 shape, so a wrong path in our client reads
  // like a wrong path and not like an empty result.
  app.use((req, res) => res.status(404).json({ error: { code: 'ResourceNotFound',
    message: `No Graph resource ${req.method} ${req.path}` } }));

  // ── seed helpers — how a test plants "a meeting that happened" ─────────────
  const seed = {
    transcript(uid, fields = {}) {
      const n = (state.byUser[uid] || []).length + 1;
      const t = {
        id: fields.id || `tr-${uid.replace(/[^a-z0-9]/gi, '')}-${n}`,
        meetingId: fields.meetingId || `mt-${uid.replace(/[^a-z0-9]/gi, '')}-${n}`,
        createdDateTime: fields.createdDateTime || new Date().toISOString(),
        subject: fields.subject || 'Weekly production sync',
        vtt: fields.vtt || seed.vtt(fields.lines || [['Tom Andresen', 'we are on track']])
      };
      (state.byUser[uid] = state.byUser[uid] || []).push(t);
      return t;
    },
    // A real WebVTT body: header, numbered cues, timings, <v Speaker> tags.
    vtt(lines) {
      const pad = (n) => String(n).padStart(2, '0');
      const cues = lines.map((pair, i) => {
        const a = `00:${pad(Math.floor(i * 12 / 60))}:${pad((i * 12) % 60)}.000`;
        const b = `00:${pad(Math.floor((i * 12 + 11) / 60))}:${pad((i * 12 + 11) % 60)}.000`;
        return `${i + 1}\n${a} --> ${b}\n<v ${pair[0]}>${pair[1]}</v>`;
      });
      return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
    },
    // the two refusals, ready to arm — plus the two 400s the listing enforces
    transcriptsDisabledBody, meteredLicenseBody,
    organizerParamMissingBody, filterNotSupportedBody
  };

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, state, seed,
        tenant, clientId, clientSecret,
        url: `http://127.0.0.1:${port}`,
        loginBase: `http://127.0.0.1:${port}`,
        apiBase: `http://127.0.0.1:${port}`,
        // Wire lib/graph.js at this fake — the suite's one-liner.
        env() {
          return {
            GRAPH_TENANT_ID: tenant,
            GRAPH_CLIENT_ID: clientId,
            GRAPH_CLIENT_SECRET: clientSecret,
            GRAPH_LOGIN_BASE: `http://127.0.0.1:${port}`,
            GRAPH_API_BASE: `http://127.0.0.1:${port}`
          };
        },
        // Wire lib/mail.js's graph driver at this same fake. A DIFFERENT app
        // registration in production (Mail.Send, one mailbox) — here it is the
        // same token endpoint, which is exactly how the real thing behaves:
        // two registrations, one Entra.
        mailEnv(from = 'showrunner@e360sport.test') {
          return {
            MAIL_DRIVER: 'graph',
            MAIL_TENANT_ID: tenant,
            MAIL_CLIENT_ID: clientId,
            MAIL_CLIENT_SECRET: clientSecret,
            MAIL_FROM: from,
            MAIL_GRAPH_LOGIN_BASE: `http://127.0.0.1:${port}`,
            MAIL_GRAPH_API_BASE: `http://127.0.0.1:${port}`
          };
        },
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { startFakeGraph, transcriptsDisabledBody, meteredLicenseBody,
                   organizerParamMissingBody, filterNotSupportedBody };
