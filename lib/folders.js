// ════════════════════════════════════════════════════════════════════════════
// lib/folders.js — eager NAS folder skeletons  (Tom, 9/11)
// ────────────────────────────────────────────────────────────────────────────
// "the folder should get created the minute a show is created. i chose the big
// ten because i knew it was the only one with a folder."
//
// Until tonight the ONLY thing that created an entity's NAS folder was the
// first byte upload into it (storage.put's mkdirs fallback) — so a project
// with no uploads had no folder, and the Files experience on P2/P3/P4 read as
// broken. This module makes folder creation part of MINTING the entity, under
// one architecture rule learned the hard way today (a DSM uid-wedge left MKCOL
// answering 500 for hours): FOLDER CREATION NEVER SITS IN A USER'S HOT PATH.
//
//   · eagerCreate() is fired AFTER the DB commit and is never awaited by the
//     route — a NAS that hangs for its full timeout cannot slow POST /projects
//     by one millisecond, and a NAS that errors cannot fail it.
//   · The outcome is RECORDED, never thrown: storage_folder_at on success,
//     storage_folder_error + an activity line ('storage.folder_failed') on
//     failure — which is what the UI's warn chip and the sweep read.
//   · The lazy mkdirs-on-upload path is untouched and remains the retry; a
//     successful upload also stamps the entity (routes/files.js), so the warn
//     chip clears itself the moment bytes actually land.
//   · sweepStorageFolders() is the backfill: every non-archived project/show
//     still unstamped gets one attempt, reported per path — run on boot
//     (gated, non-blocking) and on POST /api/admin/storage-folders/sweep.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool, loadProject, loadShow } = require('./db');
const { storage, storageReady, buildFolderPath } = require('./storage');
const { logActivity } = require('./activity');

// mkdirs() creates the PARENTS of the path it is given — its last segment is
// the file — so the folder itself rides in as a synthetic trailing segment.
// This is deliberately the SAME driver call every upload takes, not a second
// creation scheme.
function mkFolder(nasDirPath) {
  return storage.mkdirs(nasDirPath + '\\_');
}

// Tom, 9/11, after the rugby bind fought the NAS one directory at a time:
// "it would make sense for the folder and subfolder structure to be done all
// at once in showrunner." So a SHOW's skeleton includes every {kind}
// subfolder up front — the full tree an upload or bind could ever want,
// created in the background lane that demonstrably works, so bind-time and
// upload-time create NOTHING on a healthy tree. The lazy mkdirs on upload
// stays as the self-heal for folders lost after birth.
const { FILE_KINDS } = require('./enums');
async function mkShowSkeleton(nasDirPath) {
  await mkFolder(nasDirPath);
  for (const kind of FILE_KINDS) {
    await mkFolder(nasDirPath + '\\' + kind);
  }
}

// One attempt, one recorded outcome. NEVER throws — the entity is already
// committed and the caller may be a fire-and-forget hop or the sweep. Returns
// { kind, id, path, ok, error, transport } for the sweep's per-path report.
async function ensureFolderFor({ project, show = null, actor = 'system', q = pool }) {
  const kind = show ? 'show' : 'project';
  const id = show ? show.id : project.id;
  const path = buildFolderPath(project, show);
  const table = show ? 'shows' : 'projects';
  try {
    if (show) await mkShowSkeleton(path);
    else await mkFolder(path);
    await q.query(
      `UPDATE ${table} SET storage_folder_at=NOW(), storage_folder_error=NULL WHERE id=$1`, [id]);
    return { kind, id, path, ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    // 502/504 are the transport family (NAS or tailnet down) — the sweep uses
    // this to stop hammering a dead host instead of timing out per row.
    const transport = !!(e && e.storage && (e.status === 502 || e.status === 504));
    try {
      await q.query(
        `UPDATE ${table} SET storage_folder_error=$2 WHERE id=$1`, [id, msg]);
      await logActivity(q, {
        projectId: project.id, showId: show ? show.id : null, actor,
        action: 'storage.folder_failed',
        detail: `${path} — ${msg}`
      });
    } catch (e2) {
      // recording the failure failed — log it; the sweep will meet this row again
      console.error('[folders] could not record folder failure:', e2.message);
    }
    return { kind, id, path, ok: false, error: msg, transport };
  }
}

// The routes' entry point: fire-and-forget, AFTER the transaction that minted
// the entity has committed. setImmediate so the response is already on the
// wire before the first NAS packet moves. Accepts rows or bare ids (the
// proposals confirm path holds only ids).
function eagerCreate({ project = null, show = null, projectId = null, showId = null,
                       actor = 'system' } = {}) {
  setImmediate(async () => {
    try {
      const p = project || (projectId ? await loadProject(projectId) : null);
      if (!p) return;
      const s = show || (showId ? await loadShow(showId) : null);
      await ensureFolderFor({ project: p, show: s, actor });
    } catch (e) {
      // ensureFolderFor never throws; this catches only a load failure
      console.error('[folders] eager create skipped:', e.message);
    }
  });
}

// ── THE BACKFILL ────────────────────────────────────────────────────────────
// Walks every non-archived project and show still unstamped and gives each
// one attempt through the driver. Per-path outcomes, honestly — a failure is
// a reported row, never a thrown sweep. After three CONSECUTIVE transport
// failures the rest are skipped and say so: fifty rows against a dead NAS
// must cost three timeouts, not fifty.
const TRANSPORT_BAIL = 3;

async function sweepStorageFolders({ actor = 'system' } = {}) {
  if (!storageReady()) {
    return {
      configured: false, driver: storage.name,
      attempted: 0, ok: 0, failed: 0, results: [],
      note: 'storage is not configured on this server — nothing to create. ' +
            'Set STORAGE_ROOT (local) or the NAS_WEBDAV_* variables and run the sweep again.'
    };
  }
  const projects = (await pool.query(
    `SELECT * FROM projects WHERE archived_at IS NULL AND storage_folder_at IS NULL
     ORDER BY id`)).rows;
  const shows = (await pool.query(
    `SELECT s.*, p.id AS p_id, p.slug AS p_slug, p.name AS p_name
       FROM shows s JOIN projects p ON p.id = s.project_id
      WHERE s.archived_at IS NULL AND s.storage_folder_at IS NULL
      ORDER BY s.id`)).rows;

  const work = projects.map((p) => ({ project: p, show: null }))
    .concat(shows.map((s) => ({
      project: { id: s.p_id, slug: s.p_slug, name: s.p_name }, show: s
    })));

  const results = [];
  let consecutiveTransport = 0;
  let bailed = false;
  for (const w of work) {
    if (bailed) {
      results.push({
        kind: w.show ? 'show' : 'project', id: w.show ? w.show.id : w.project.id,
        path: buildFolderPath(w.project, w.show), ok: false, skipped: true,
        error: `skipped — the NAS did not answer ${TRANSPORT_BAIL} attempts in a row; ` +
               `run the sweep again when it is back`
      });
      continue;
    }
    const r = await ensureFolderFor({ project: w.project, show: w.show, actor });
    results.push(r);
    if (!r.ok && r.transport) {
      consecutiveTransport += 1;
      if (consecutiveTransport >= TRANSPORT_BAIL) bailed = true;
    } else {
      consecutiveTransport = 0;
    }
  }
  const okN = results.filter((r) => r.ok).length;
  const failedN = results.filter((r) => !r.ok && !r.skipped).length;
  const skippedN = results.filter((r) => r.skipped).length;
  return {
    configured: true, driver: storage.name,
    attempted: results.length - skippedN, ok: okN, failed: failedN, skipped: skippedN,
    results
  };
}

module.exports = { eagerCreate, ensureFolderFor, sweepStorageFolders };
