// ════════════════════════════════════════════════════════════════════════════
// lib/transcripts.js — THE UNATTENDED MEETING-TRANSCRIPT READER
// ────────────────────────────────────────────────────────────────────────────
// The first piece of the standing M365 agent layer. On a timer (and through the
// manual door beside it), Showrunner sweeps recent Teams meeting transcripts for
// the team's users over app-only Graph, matches each one to a show with the
// SAME machinery the agent API uses, and either FILES it as a `transcript`
// document or — below the band — lands a PROPOSAL. File-don't-fire, unchanged:
// this surface gets no special dispensation just because nobody is watching it.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It does not re-derive matching, confidence or proposal handling. lib/agent.js
// owns all three and is called directly, IN PROCESS — never over HTTP to our own
// server, which would be a second authentication surface, a second rate limit
// and a second set of bugs to keep in sync. When the bands change, they change
// once. When the matcher improves, the sweep improves with it for free.
//
// ── WHAT A SWEEP COSTS, AND WHY IT IS SHAPED THIS WAY ───────────────────────
//   · PER USER, NOT PER TENANT. Graph's app-only transcript enumeration is
//     scoped to a meeting ORGANIZER, so the sweep walks the active Showrunner
//     users who have an email on file. Somebody with no address is not an error
//     — there is simply nothing to ask about them.
//   · ONE USER'S FAILURE IS NOT THE SWEEP'S FAILURE. A 403 on Tony's mailbox
//     must not cost Jim's transcripts. Each user is wrapped; the error is
//     already in the audit log verbatim by the time it is caught, the counter
//     ticks, and the loop continues.
//   · WATERMARK + OVERLAP. Each sweep starts from the last SUCCESSFUL sweep's
//     start time minus an overlap window, because a transcript is published some
//     minutes after its meeting ends and a hard watermark would step over the
//     ones that landed late. Re-reading is free; the ledger dedupes.
//   · DEDUPE IS THE LEDGER'S JOB. A transcript id that has already produced a
//     file or a proposal is skipped before its bytes are fetched — so a re-sweep
//     costs one listing call and files nothing new.
//
// ── TRANSCRIPTS ARE INTERNAL ────────────────────────────────────────────────
// A meeting body is the room talking, unedited. It is filed for US. The
// client-content firewall may never read one: lib/firewall.js's
// RECAP_FORBIDDEN_FILE_KINDS gives `transcript` the same exclusion the tech
// report has had since F2, enforced at runtime by guardRecapQuery, and the
// smoke suite goes red if that exclusion is removed.
//
// ── THE AUDIT LOG IS NOT OPTIONAL (Tony Tran, 2026-09-18) ───────────────────
// Every Graph request in this file goes through lib/graph.js's one request
// helper, which writes the graph_audit row in the same flow. Nothing here
// records its own — that is the point: there is no call site that COULD forget.
// What this file adds is the back-reference: once a transcript has become a file
// or a proposal, attachGraphResult() writes that id onto the row for the call
// that fetched it, so the ledger reads end to end — "we asked, this came back,
// this is where it went."
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');

const { pool, withTx, loadProject, loadShow } = require('./db');
const {
  graphConfigured, graphMissing, notConfigured, graphGet,
  attachGraphResult, pruneGraphAudit, scrubSecrets
} = require('./graph');
const { matchCandidates, bandFor, normalizeProvenance, createProposal, assigneeFor } = require('./agent');
const { storage, storageReady, buildNasPath, buildQuarantinePath } = require('./storage');
const fileCache = require('./filecache');
const { logActivity } = require('./activity');

// ── knobs (env, read at call time so the suites can steer them) ─────────────
const sweepMinutes = () => {
  const n = parseInt(process.env.GRAPH_SWEEP_MINUTES || '60', 10);
  return Number.isFinite(n) && n >= 1 ? n : 60;
};
// How far back a sweep reaches past the previous one's start. A Teams
// transcript is published minutes after the meeting ends, so a hard watermark
// drops exactly the ones that arrived late.
const overlapMinutes = () => {
  const n = parseInt(process.env.GRAPH_SWEEP_OVERLAP_MINUTES || '30', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
};
// The FIRST sweep on a fresh database has no watermark to start from. It looks
// back this far and no further — a cold start must not try to ingest the whole
// history of the tenant in one pass.
const coldStartHours = () => {
  const n = parseInt(process.env.GRAPH_SWEEP_COLD_START_HOURS || '24', 10);
  return Number.isFinite(n) && n >= 1 ? n : 24;
};
const maxPerUser = () => {
  const n = parseInt(process.env.GRAPH_SWEEP_MAX_PER_USER || '25', 10);
  return Number.isFinite(n) && n >= 1 ? n : 25;
};
const enabledByEnv = () => String(process.env.GRAPH_SWEEP_ENABLED || '') !== '0';

// The identity every filed transcript carries in its provenance. It is NOT a
// teammate's agent: no person asked for this and no person's key authorized it.
// It is the app's standing reader, and the record says so in as many words, so
// nobody reading the activity feed a year from now mistakes an unattended pull
// for something a colleague did.
const SWEEP_AGENT_USER = 'transcript-sweep';
const SWEEP_ACTOR = 'agent:' + SWEEP_AGENT_USER;

// ── the overlap latch ───────────────────────────────────────────────────────
// SET SYNCHRONOUSLY before the first await, exactly like lib/backup.js: a
// manual "Sweep now" racing the timer resolves deterministically — one runs,
// the other is refused 409. In-process is the right scope; there is one server.
let running = false;
function isRunning() { return running; }

// ════════════════════════════════════════════════════════════════════════════
// GRAPH SHAPES — written down so wiring this up is a credential change
// ────────────────────────────────────────────────────────────────────────────
// HONEST ABOUT WHAT IS PROVEN. These two paths are the documented app-only
// shapes and they are what the fake Graph server in scripts/fake-graph.js
// implements, which is what every assertion in the suites runs against. THE
// FIRST LIVE CALL IS WHAT PROVES THE REAL ENDPOINT — the exact spelling of the
// getAllTranscripts function parameters, whether the tenant's transcript toggle
// is on, and whether Microsoft meters this particular read, are three things no
// local fake can answer. All three land VERBATIM in graph_audit the moment
// credentials exist, which is precisely why the error text is never swallowed.
//
// AND THE FIRST ONE CAME BACK. 2026-09-21 14:23 UTC, six mailboxes, six 400s:
// `meetingOrganizerUserId='{userId}' expected as a function parameter`. The
// listing below is now the OData function form the tenant asked for, and the
// fake pins it. The other two — the transcript toggle and the metering — are
// still unanswered, and still the live sweep's to answer.
// ════════════════════════════════════════════════════════════════════════════

// Enumerate the transcripts of meetings this user ORGANIZED since `sinceISO`.
//
// THE SHAPE IS A FUNCTION CALL, NOT A QUERY STRING — and we know because the
// tenant told us. The first real sweep (2026-09-21 14:23 UTC) came back six
// times over with
//   400 BadRequest — meetingOrganizerUserId='{userId}' expected as a function parameter
// against the documented-guess spelling this line used to carry. v1.0's
// getAllTranscripts is an OData FUNCTION: the organizer and the date window are
// PARAMETERS INSIDE THE PARENTHESES, and `$top` is the only OData query option
// the method documents. `$filter=createdDateTime gt …` was our invention and it
// has no standing here — `startDateTime=` is the documented parameter carrying
// exactly the watermark semantics we want ("filter for artifacts created after
// the given start date"), so the overlap window is unchanged in meaning and only
// changed in spelling.
//   learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts?view=graph-rest-1.0
// scripts/fake-graph.js now accepts ONLY this form and answers the bare spelling
// with that same 400, so a revert goes red here instead of an hour from now in
// somebody's audit log.
//
// The organizer is an OData string literal: single quotes doubled (the OData
// escape), then percent-encoded exactly like the /users/ segment above it.
function odataString(v) {
  return encodeURIComponent(String(v == null ? '' : v).replace(/'/g, "''"));
}
function listPath(userId, sinceISO) {
  return `/users/${encodeURIComponent(userId)}/onlineMeetings/getAllTranscripts` +
         `(meetingOrganizerUserId='${odataString(userId)}',startDateTime=${sinceISO})` +
         `?$top=${maxPerUser()}`;
}
// The body. Graph hands back `transcriptContentUrl` on each item; we honour it
// when it is there and derive the documented path when it is not, because a
// listing that changes shape must not become "no transcripts found".
function contentPath(userId, t) {
  const url = t && t.transcriptContentUrl ? String(t.transcriptContentUrl) : '';
  const base = url
    ? (url.startsWith('http') ? url : (url.startsWith('/') ? url : '/' + url))
    : `/users/${encodeURIComponent(userId)}/onlineMeetings/` +
      `${encodeURIComponent(String(t.meetingId || ''))}/transcripts/` +
      `${encodeURIComponent(String(t.id || ''))}/content`;
  // vtt is the readable one: cues with speaker names, which is what makes a
  // transcript matchable and worth filing. docx is the alternative format and
  // is not asked for — bytes we cannot read are bytes we cannot match.
  return base + (base.includes('?') ? '&' : '?') + '$format=text/vtt';
}

// ── the watermark ───────────────────────────────────────────────────────────
async function lastSuccessfulSweep(q = pool) {
  const r = await q.query(
    `SELECT * FROM graph_sweeps WHERE status='ok' ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}
async function sinceFor(q = pool) {
  const last = await lastSuccessfulSweep(q);
  const from = last
    ? new Date(new Date(last.started_at).getTime() - overlapMinutes() * 60000)
    : new Date(Date.now() - coldStartHours() * 3600 * 1000);
  return from;
}

// ── dedupe, via the ledger ──────────────────────────────────────────────────
// "Has this transcript already produced something?" A row with a file_id or a
// proposal_id is a transcript that landed. A row with neither — a listing call,
// or a content fetch that errored — is NOT a claim that the work was done, so a
// failed fetch is retried on the next sweep rather than silently abandoned.
async function alreadyHandled(transcriptId, q = pool) {
  if (!transcriptId) return false;
  const r = await q.query(
    `SELECT 1 FROM graph_audit
     WHERE transcript_id = $1 AND (file_id IS NOT NULL OR proposal_id IS NOT NULL) LIMIT 1`,
    [String(transcriptId)]);
  return r.rows.length > 0;
}

// ── turning a transcript into something the matcher can read ────────────────
// WebVTT is cues, timestamps and speaker tags. The matcher wants prose: the
// venue name somebody said out loud, the client, the job number read off a
// sheet. So the cue scaffolding is stripped and the spoken text is what gets
// matched — while the FILED BYTES stay the original vtt, unmodified, because the
// document of record is what Microsoft handed us and not our reading of it.
function vttToText(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const out = [];
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^NOTE\b/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;                       // cue number
    if (/-->/.test(line)) continue;                         // cue timing
    // "<v Tony Tran>we need the cabinets by Thursday</v>" → the sentence
    out.push(line.replace(/<\/?v[^>]*>/gi, '').replace(/<[^>]+>/g, '').trim());
  }
  return out.filter(Boolean).join(' ');
}
// Speaker names are a matching signal in their own right (a show's owner being
// in the room), and they are the one piece of the body worth naming in the
// activity line. Capped — a standup has a dozen, a town hall has ninety.
function vttSpeakers(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const seen = new Set();
  const re = /<v\s+([^>]+)>/gi;
  let m;
  while ((m = re.exec(s)) && seen.size < 40) seen.add(m[1].trim());
  return [...seen];
}

// A stable, human-legible document name. The subject when Graph gives one, the
// date when it does not — never the bare transcript GUID, which tells a person
// nothing about what they are looking at in a folder listing.
//
// THE SUFFIX IS NOT DECORATION. nas_path is derived from this name, and an
// unattended reader sweeping a dozen mailboxes every hour WILL eventually meet
// two different meetings that share a day and a subject — "2026-10-01 Daily
// standup" twice is the normal case, not the exotic one. Without a
// discriminator the second one's bytes would silently overwrite the first's,
// which is the quietest possible way to lose a document. Eight characters off
// the transcript id (the one thing guaranteed unique) buys a name that is still
// readable and a path that cannot collide. The dedupe ledger means the SAME
// transcript is never written twice, so a collision could only ever be between
// two genuinely different meetings — exactly the case worth protecting.
function transcriptDocName(t, meetingSubject) {
  const when = String(t.createdDateTime || t.meetingOrganizerDateTime || '').slice(0, 10) ||
               new Date().toISOString().slice(0, 10);
  const subj = String(meetingSubject || t.subject || '').trim().replace(/[\\/:*?"<>|]+/g, '-');
  const tag = String(t.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-8) || 'notag';
  return (subj ? `${when} ${subj}` : `${when} Teams meeting`).slice(0, 140) +
         ` (transcript ${tag})`;
}

// ════════════════════════════════════════════════════════════════════════════
// FILING ONE TRANSCRIPT — the band decides, exactly as it does on /api/agent
// ════════════════════════════════════════════════════════════════════════════
// Bytes FIRST, row second (the human photo-upload doctrine, smoke §4c): we
// already hold the body in memory, so a storage failure leaves NOTHING behind —
// no ghost `files` row claiming a document nobody can open. The audit row for
// the content fetch is already written either way, and it gains a note saying
// the bytes could not be stored.
async function fileOneTranscript({ user, t, bytes, text, speakers, meetingSubject, auditId, sweepId }) {
  const sourceRef = 'graph:transcript/' + String(t.id);
  const match = await matchCandidates({
    sourceKind: 'meeting',
    subject: meetingSubject || t.subject || '',
    bodyExcerpt: text.slice(0, 4000),
    participants: [user.email, ...(t.participants || [])].filter(Boolean),
    dates: [String(t.createdDateTime || '').slice(0, 10)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    vendors: [],
    hints: {},
    sourceRef
  });
  const top = match.candidates[0] || null;
  const confidence = top ? top.confidence : 0;
  const band = bandFor(confidence);
  // The band, and the ambiguity override, read exactly as lib/agent.js's
  // assertBand does — but this path never REQUESTS 'filed', it asks the band
  // what it is allowed to do. A sweep that argued with the guardrail and caught
  // a 422 would be the same policy written twice.
  const fileIt = band === 'high' && !match.ambiguous && !!top;

  const provenance = normalizeProvenance({
    sourceKind: 'meeting',
    sourceRef,
    sourceLabel: (meetingSubject || t.subject || 'Teams meeting') +
                 (speakers.length ? ' — ' + speakers.slice(0, 4).join(', ') : ''),
    confidence,
    matchedBy: top ? top.matchedBy : []
  }, SWEEP_AGENT_USER);

  const show = fileIt ? await loadShow(top.showId) : null;
  const project = show ? await loadProject(show.project_id)
                       : (top ? await loadProject(top.projectId) : null);

  const stub = { kind: 'transcript', name: transcriptDocName(t, meetingSubject), ext: '.vtt' };
  // A filed transcript lands in the show's folder. Anything short of the band
  // lands in the agent quarantine, never in a real show folder — a rejected
  // proposal must leave nothing behind for somebody to find later (§3/punch 46).
  const nasPath = fileIt ? buildNasPath(project, show, stub)
                         : buildQuarantinePath(SWEEP_AGENT_USER, stub);

  if (!storageReady()) {
    await attachGraphResult(auditId, { note: 'bytes NOT stored — storage is not configured' });
    return { outcome: 'error', reason: 'storage is not configured — a transcript has nowhere to land' };
  }
  try {
    await storage.put(nasPath, bytes);
    fileCache.invalidatePath(nasPath);
  } catch (e) {
    await attachGraphResult(auditId, { note: 'bytes NOT stored: ' + scrubSecrets(e.message) });
    return { outcome: 'error', reason: 'storage refused the transcript bytes: ' + e.message };
  }

  const out = await withTx(async (c) => {
    // THE UNATTACHED CASE, deliberately. When the matcher returns no candidate
    // at all — a benefits meeting, a vendor call about nothing we are building —
    // AGENT_API §2's low band is explicit: submit UNATTACHED, status 'proposed',
    // no target. So this row can carry a NULL project AND a NULL show, which no
    // other writer in the app produces. It is not an orphan: the proposal owns
    // it (created_rows.files), the reviewer opens it by id, and it resolves when
    // the proposal does — confirmed onto a folder, marked rejected, or expired
    // at 30 days. Its bytes are in the quarantine precisely because there is no
    // folder they could honestly go in.
    const ins = await c.query(
      `INSERT INTO files (project_id, show_id, name, ext, kind, nas_path, size, uploaded_by,
         job_id, status, provenance, source_ref, meta)
       VALUES ($1,$2,$3,$4,'transcript',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [show ? null : (project ? project.id : null), show ? show.id : null,
       stub.name, '.vtt', nasPath, bytes.length, SWEEP_ACTOR,
       show ? show.default_job_id : null, fileIt ? 'filed' : 'proposed',
       JSON.stringify(provenance), sourceRef,
       fileIt ? '' : 'awaiting review']);
    const file = ins.rows[0];

    let proposalId = null;
    if (!fileIt) {
      // Below the band — a PROPOSAL, with its target when the matcher had an
      // opinion and unattached when it did not, which is what the medium and
      // low bands mean on every other agent surface.
      proposalId = (await createProposal(c, {
        kind: 'document',
        proposedBy: SWEEP_ACTOR,
        assignedTo: await assigneeFor({
          projectId: top ? top.projectId : null,
          showId: top ? top.showId : null,
          // No project owner to defer to? The person whose meeting it was
          // decides. They were in the room; nobody is better placed.
          agentUser: user.username
        }, c),
        projectId: top ? top.projectId : null,
        showId: top ? top.showId : null,
        jobId: top ? top.jobId : null,
        payload: {
          kind: 'transcript', name: stub.name, ext: '.vtt',
          transcriptId: String(t.id), meetingSubject: meetingSubject || t.subject || '',
          speakers: speakers.slice(0, 12), organizer: user.username,
          band, ambiguous: !!match.ambiguous,
          candidates: match.candidates.slice(0, 3),
          _resolved: { kind: 'transcript', name: stub.name, ext: '.vtt', nasPath }
        },
        provenance, confidence,
        createdRows: { files: [file.id] }
      })).id;
    }

    await logActivity(c, {
      projectId: project ? project.id : null, showId: show ? show.id : null,
      actor: SWEEP_ACTOR,
      action: fileIt ? 'file.add' : 'agent.document.propose',
      detail: `transcript: ${stub.name}`,
      accent: true, provenance
    });
    return { file, proposalId };
  });

  // THE BACK-REFERENCE. The audit row for the fetch now says where the bytes
  // went — the ledger reads end to end.
  await attachGraphResult(auditId, {
    fileId: out.file.id, proposalId: out.proposalId,
    note: fileIt ? `filed to show ${show.id}` : `proposed (${band}${match.ambiguous ? ', ambiguous' : ''})`
  });

  return {
    outcome: fileIt ? 'filed' : 'proposed',
    fileId: out.file.id, proposalId: out.proposalId,
    showId: show ? show.id : null, confidence, band, nasPath, bytes: bytes.length
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ONE USER'S PASS
// ════════════════════════════════════════════════════════════════════════════
// Throws on a listing failure — which the caller catches per user, so one
// mailbox's 403 does not end the sweep. Inside the transcript loop, a single
// transcript's failure is counted and stepped over: the other twelve in the
// same listing are still worth having.
async function sweepOneUser({ user, sinceISO, sweepId, tally }) {
  const graphUser = user.email || user.username;
  const listed = await graphGet(listPath(graphUser, sinceISO), {
    action: 'list', targetUser: graphUser, sweepId
  });
  if (!listed.ok) {
    // Already in the ledger, verbatim, with its status. Raised so the caller
    // counts the user as errored and moves on.
    const e = new Error(`Graph listing for ${graphUser} → ${listed.status}: ${listed.error || 'failed'}`);
    e.status = listed.status;
    throw e;
  }
  const items = (listed.body && Array.isArray(listed.body.value)) ? listed.body.value : [];
  tally.listed += items.length;

  for (const t of items.slice(0, maxPerUser())) {
    if (!t || !t.id) continue;
    if (await alreadyHandled(t.id)) { tally.skipped += 1; continue; }

    const got = await graphGet(contentPath(graphUser, t), {
      action: 'content', targetUser: graphUser, sweepId, transcriptId: String(t.id),
      wantBytes: true, headers: { Accept: 'text/vtt' }
    });
    if (!got.ok) {
      // A metered/licensed refusal and a "transcripts are off in this tenant"
      // refusal both arrive here, both are already recorded verbatim, and
      // NEITHER ends the sweep. The next transcript gets its own chance.
      tally.errors += 1;
      tally.lastError = `transcript ${String(t.id).slice(0, 24)} → ${got.status}: ${got.error || 'failed'}`;
      continue;
    }
    const buf = Buffer.isBuffer(got.body) ? got.body : Buffer.from(String(got.body || ''), 'utf8');
    if (!buf.length) {
      tally.errors += 1;
      tally.lastError = `transcript ${String(t.id).slice(0, 24)} came back empty`;
      continue;
    }

    let res;
    try {
      res = await fileOneTranscript({
        user, t, bytes: buf, text: vttToText(buf), speakers: vttSpeakers(buf),
        meetingSubject: t.subject || t.meetingSubject || '',
        auditId: got.auditId, sweepId
      });
    } catch (e) {
      tally.errors += 1;
      tally.lastError = `filing transcript ${String(t.id).slice(0, 24)}: ${e.message}`;
      continue;
    }
    if (res.outcome === 'filed') { tally.filed += 1; tally.bytes += buf.length; }
    else if (res.outcome === 'proposed') { tally.proposed += 1; tally.bytes += buf.length; }
    else { tally.errors += 1; tally.lastError = res.reason; }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE SWEEP
// ════════════════════════════════════════════════════════════════════════════
// Every exit writes a graph_sweeps row and returns it; only the overlap refusal
// throws (409 — the run that IS in flight will write the row for this moment,
// and two rows for one moment would make the ledger lie).
async function runTranscriptSweep({ trigger = 'manual' } = {}) {
  if (running) {
    const e = new Error('A transcript sweep is already running — one at a time, by design. ' +
                        'Watch GET /api/admin/graph-audit for the rows it lands.');
    e.status = 409;
    throw e;
  }
  running = true;
  const sweepId = 'sw-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const startedAt = new Date();
  const tally = { listed: 0, filed: 0, proposed: 0, skipped: 0, errors: 0, bytes: 0, lastError: null };
  let usersSeen = 0, userErrors = 0;
  let since = null;

  try {
    if (!graphConfigured()) {
      // DARK AND HONEST. No row claims a sweep happened, because none did — and
      // no Graph socket was opened, so there is correctly nothing in the audit
      // log either. 'skipped' is a real status the health block renders.
      return await recordSweep({
        sweepId, startedAt, status: 'skipped', trigger, usersSeen: 0, userErrors: 0, tally,
        since: null,
        error: 'not configured — set ' + graphMissing().join(', ') + ' (SCHEMA.md § Environment)'
      });
    }

    since = await sinceFor();
    const sinceISO = since.toISOString();
    const users = (await pool.query(
      `SELECT username, name, email FROM users
       WHERE active IS NOT FALSE AND COALESCE(email,'') <> ''
       ORDER BY username`)).rows;

    for (const user of users) {
      usersSeen += 1;
      try {
        await sweepOneUser({ user, sinceISO, sweepId, tally });
      } catch (e) {
        // ONE USER ERRORING DOES NOT END THE SWEEP. The reason is already in the
        // audit log with its HTTP status; this is the counter and the summary.
        userErrors += 1;
        tally.lastError = scrubSecrets(e.message);
        console.error(`[transcripts] ${user.username}: ${scrubSecrets(e.message)}`);
      }
    }

    // A sweep in which EVERY user failed is not an 'ok' sweep — it must not
    // become the watermark the next one starts from, or a tenant-wide outage
    // would silently skip the window it could not read.
    // Bound the ledger ONCE PER SWEEP, never per call — the bound is a
    // full-table scan, and the row-writing path must stay one cheap INSERT.
    await pruneGraphAudit();

    const status = (usersSeen > 0 && userErrors === usersSeen) ? 'error' : 'ok';
    return await recordSweep({
      sweepId, startedAt, status, trigger, usersSeen, userErrors, tally, since,
      error: status === 'error' ? (tally.lastError || 'every user errored') : null
    });
  } catch (e) {
    return await recordSweep({
      sweepId, startedAt, status: 'error', trigger, usersSeen, userErrors, tally, since,
      error: scrubSecrets(e.message)
    });
  } finally {
    running = false;
  }
}

// ── the sweep ledger ────────────────────────────────────────────────────────
function sweepToApi(r) {
  if (!r) return null;
  return {
    id: r.id, sweep_id: r.sweep_id,
    started_at: r.started_at, finished_at: r.finished_at,
    status: r.status, trigger: r.trigger,
    users_seen: r.users_seen, user_errors: r.user_errors,
    transcripts: r.transcripts, filed: r.filed, proposed: r.proposed, skipped: r.skipped,
    bytes: r.bytes == null ? 0 : Number(r.bytes),
    since_at: r.since_at, error: r.error
  };
}
async function recordSweep({ sweepId, startedAt, status, trigger, usersSeen, userErrors, tally, since, error }) {
  try {
    const r = await pool.query(
      `INSERT INTO graph_sweeps (sweep_id, started_at, finished_at, status, trigger,
         users_seen, user_errors, transcripts, filed, proposed, skipped, bytes, since_at, error)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [sweepId, startedAt, status, trigger, usersSeen, userErrors,
       tally.listed, tally.filed, tally.proposed, tally.skipped, tally.bytes,
       since, error ? scrubSecrets(error).slice(0, 400) : null]);
    await pool.query(
      `DELETE FROM graph_sweeps WHERE id NOT IN (SELECT id FROM graph_sweeps ORDER BY id DESC LIMIT 500)`);
    return sweepToApi(r.rows[0]);
  } catch (e) {
    // The ledger failing must not mask what the RUN did — synthesize the row,
    // exactly as lib/backup.js does.
    console.error('[transcripts] could not record the sweep:', e.message);
    return { id: null, sweep_id: sweepId, started_at: startedAt, finished_at: new Date().toISOString(),
             status, trigger, users_seen: usersSeen, user_errors: userErrors,
             transcripts: tally.listed, filed: tally.filed, proposed: tally.proposed,
             skipped: tally.skipped, bytes: tally.bytes, since_at: since,
             error: error ? scrubSecrets(error) : null, ledger_error: e.message };
  }
}
async function listSweeps(limit = 25) {
  const r = await pool.query(
    `SELECT * FROM graph_sweeps ORDER BY id DESC LIMIT $1`,
    [Math.min(200, Math.max(1, parseInt(limit, 10) || 25))]);
  return r.rows.map(sweepToApi);
}

// ── scheduling ──────────────────────────────────────────────────────────────
// A self-rearming setTimeout chain, the same shape as lib/backup.js's nightly
// and lib/digest.js's morning row: no cron, no new dependency, every boot
// re-arms, and the health block's `stale` flag catches a chain that stopped.
// unref() so a test boot never hangs on us.
//
// THE MANUAL-DOOR LAW: this timer has a wired human twin —
// POST /api/admin/transcript-sweep, the "Sweep now" button on the Settings card.
// A capability that only a timer can reach is a capability nobody can test,
// demonstrate or rescue at 4pm on a show day.
let timer = null;
let armedFor = null;
function nextSweepAt(now = new Date(), minutes = sweepMinutes()) {
  return new Date(now.getTime() + minutes * 60000);
}
function armTranscriptSweepTimer() {
  const arm = () => {
    const at = nextSweepAt(new Date(), sweepMinutes());
    armedFor = at;
    timer = setTimeout(async () => {
      try {
        // GATED AT FIRE TIME, never at arm time: the timer always arms, so
        // turning the credentials on in Railway starts sweeping at the next
        // tick without a redeploy, and turning them off stops it the same way.
        if (!enabledByEnv()) {
          console.log('[transcripts] GRAPH_SWEEP_ENABLED=0 — scheduled sweep skipped');
        } else if (!graphConfigured()) {
          // Deliberately quiet on the dark path: this is the NORMAL state today
          // and an hourly log line saying "still unconfigured" is noise that
          // trains people to ignore the log. /api/health says it plainly instead.
        } else {
          const row = await runTranscriptSweep({ trigger: 'schedule' });
          console.log(row.status === 'ok'
            ? `[transcripts] sweep ${row.sweep_id}: ${row.transcripts} seen, ${row.filed} filed, ` +
              `${row.proposed} proposed, ${row.skipped} already had, ${row.user_errors} user error(s)`
            : `[transcripts] sweep ${row.sweep_id} ${row.status}: ${row.error}`);
        }
      } catch (e) {
        // overlap (a manual sweep in flight) or a surprise — log it; the ledger
        // and the health block carry the record either way
        console.error('[transcripts] scheduled sweep:', scrubSecrets(e.message));
      }
      arm();                                                // re-arm REGARDLESS
    }, at.getTime() - Date.now());
    if (timer.unref) timer.unref();
    return at;
  };
  return arm();
}

// ── the health block (/api/health "graph") ──────────────────────────────────
// ADDITIVE, and in the doctrine every other block here follows: presence
// booleans, timestamps and counts — never a URL, never a credential. `stale` is
// the silently-stopped detector: configured, enabled, and no successful sweep
// inside TWO intervals.
async function healthBlock() {
  const { configBlock } = require('./graph');
  const cfg = configBlock();
  const enabled = cfg.configured && enabledByEnv();
  const out = {
    ...cfg,
    enabled,
    running,
    sweepMinutes: sweepMinutes(),
    overlapMinutes: overlapMinutes(),
    nextSweepAt: enabled && armedFor ? armedFor.toISOString()
               : enabled ? nextSweepAt().toISOString() : null,
    lastSweep: null,
    lastSuccessAt: null,
    auditRows: null,
    stale: false,
    staleMeans: `true when unattended access is configured and enabled and no sweep has SUCCEEDED ` +
                `in the last ${2 * sweepMinutes()} minutes (2× GRAPH_SWEEP_MINUTES) — the timer ` +
                `stopped, or every sweep since has failed. Unconfigured is never stale: nothing ` +
                `is expected to happen.`,
    auditMeans: 'Every unattended Graph request writes a graph_audit row in the same flow as the ' +
                'request — Tony Tran\'s condition for the 2026-09-18 grant, kept structurally. ' +
                'GET /api/admin/graph-audit (admin) is the read side.'
  };
  try {
    const last = (await pool.query(`SELECT * FROM graph_sweeps ORDER BY id DESC LIMIT 1`)).rows[0] || null;
    const lastOk = await lastSuccessfulSweep();
    out.lastSweep = last ? {
      at: last.finished_at, status: last.status, trigger: last.trigger,
      transcripts: last.transcripts, filed: last.filed, proposed: last.proposed,
      skipped: last.skipped, userErrors: last.user_errors,
      error: last.error || null
    } : null;
    out.lastSuccessAt = lastOk ? lastOk.finished_at : null;
    out.auditRows = parseInt((await pool.query(
      `SELECT COUNT(*)::int AS n FROM graph_audit`)).rows[0].n, 10);
    if (enabled) {
      // Never succeeded but HAS been trying → that is rot, say so. Never tried
      // at all on a freshly-configured deploy is merely young.
      out.stale = lastOk
        ? (Date.now() - new Date(lastOk.finished_at).getTime()) > 2 * sweepMinutes() * 60000
        : !!last;
    }
  } catch (e) {
    // health must answer even when the ledgers cannot — say why instead of 500ing
    out.error = scrubSecrets(e.message);
  }
  return out;
}

module.exports = {
  SWEEP_AGENT_USER, SWEEP_ACTOR,
  runTranscriptSweep, listSweeps, healthBlock, armTranscriptSweepTimer, isRunning,
  notConfigured,
  // pure/seam exports for the suites
  vttToText, vttSpeakers, transcriptDocName, listPath, contentPath,
  sinceFor, alreadyHandled, nextSweepAt, sweepMinutes
};
