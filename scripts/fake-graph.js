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
//   GET  /users/{id}/onlineMeetings/getAllTranscripts     the listing
//        ?$filter=createdDateTime gt {iso}&$top=n
//   GET  /users/{id}/onlineMeetings/{mid}/transcripts/{tid}/content
//        ?$format=text/vtt                                the body
//
// Faithfulness rules, in order of importance:
//   · EVERY call requires a Bearer token this server minted, exactly like the
//     real one — which is what makes "the second sweep fetches no new token"
//     a meaningful assertion rather than a counter nobody checks.
//   · the $filter is HONOURED, not ignored: the listing really does drop
//     transcripts created at or before the watermark, so the overlap-window
//     logic is exercised instead of assumed.
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
  app.get('/users/:uid/onlineMeetings/getAllTranscripts', requireToken, maybeFail, (req, res) => {
    state.listHits += 1;
    const uid = req.params.uid;
    const all = state.byUser[uid] || [];
    // Honour $filter=createdDateTime gt {iso} — the watermark really bites.
    const f = String(req.query.$filter || '');
    const m = /createdDateTime\s+gt\s+(\S+)/i.exec(f);
    const since = m ? new Date(m[1]) : null;
    const top = Math.max(1, parseInt(req.query.$top, 10) || 50);
    const value = all
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
    // the two refusals, ready to arm
    transcriptsDisabledBody, meteredLicenseBody
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
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { startFakeGraph, transcriptsDisabledBody, meteredLicenseBody };
