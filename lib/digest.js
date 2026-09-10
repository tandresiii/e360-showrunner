// ════════════════════════════════════════════════════════════════════════════
// lib/digest.js — THE MORNING DIGEST: what needs a PERSON, gathered daily
// ────────────────────────────────────────────────────────────────────────────
// Tom's founding requirement, verbatim from the day this app was born: "we
// have a big problem with people who talk to the client not informing everyone
// of what needs to happen... it needs to keep things from falling through the
// cracks." Every piece already existed — tasks with due dates, PO approvals,
// scheduler stale flags, tech-report obligations, content chase lists,
// byteless files — but nothing GATHERED what needs a person into one place at
// the start of their day. This module is that gathering.
//
// Design decisions, and why:
//
//   · REUSE, NEVER RE-DERIVE. Every question below is answered by the
//     predicate that already owns it: /my-steps' open-step filter
//     (routes/core.js), canApprovePO + poNeedsApproval (lib/auth.js +
//     routes/purchasing.js), hydrateShow's scheduler_stale SQL
//     (routes/core.js), reports.owedFor (lib/reports.js), the content
//     chase-list filter (public/data.js contentWaitingOn, mirrored in SQL),
//     and fileIsByteless's size-owned-by-the-server rule (components.js).
//     A digest that recomputes a rule is a digest that drifts from the screen
//     it summarizes.
//
//   · SILENCE IS THE SUCCESS STATE. An empty digest produces NO notification —
//     ever. A daily "nothing to do!" is spam that trains people to ignore the
//     one morning the digest matters. The mutation test on this rule is in the
//     smoke suite: break the guard and the suite goes red naming the spam.
//
//   · ONE DIGEST PER USER PER UTC DAY, database-arbitrated. The digest_runs
//     ledger (lib/db.js) carries UNIQUE (username, day); the sweep inserts
//     ON CONFLICT DO NOTHING in the SAME transaction as the notification it
//     covers. No inserted row = today's already went = nothing enqueued. That
//     holds across restarts, across the timer racing a manual trigger, and
//     across two admins pressing the button at once. An empty day writes no
//     ledger row on purpose: work landing at 14:00 can still digest that
//     afternoon when an admin triggers — one delivery per day still holds,
//     because the delivery writes the row.
//
//   · DELIVERY RIDES THE HOUSE MACHINERY. One notification_outbox row of kind
//     'daily_digest' per user per day, through notify.enqueue — so the mail
//     half behaves exactly like every other notification (log driver records
//     it; Graph mails it the day the mailbox exists; nothing new is built
//     here). The BELL half is the live Today panel (GET /api/me/digest),
//     computed fresh on every open — the outbox row is the day's record and
//     the mail vehicle, never a stale copy the panel would have to trust.
//
//   · OPT-OUT MEANS NOTHING, NOT 'SKIPPED'. The daily_digest preference
//     ('off' where notify prefs live, default ON) is honoured by the sweep
//     BEFORE anything is built or written: an opted-out user gets no outbox
//     row at all, where other kinds record a skipped row. The difference is
//     deliberate — a skipped mention is a suppressed copy of a bell item that
//     still exists; a daily digest IS the delivery, and recording a skipped
//     one every day would rebuild the spam the opt-out refused. The live
//     Today panel still answers for everyone — opting out silences the ping,
//     not the view.
//
//   · THE TIMER is a self-rearming setTimeout chain, lib/backup.js doctrine
//     verbatim: no cron, no new dependency, always re-arms, unref()'d so a
//     test boot never hangs on it. DIGEST_HOUR_UTC defaults to 12 — ≈7am
//     Central (6am when CST). DST HONESTY: a UTC anchor means the Chicago
//     wall-clock hour shifts across the change; that is fine — the point is
//     "once, at the start of the working day", not "07:00:00 sharp" — and the
//     per-day ledger means a shifted fire can never double-deliver. A dyno
//     asleep across the fire hour misses that day's push (the same accepted
//     trade backup.js documents); the Today panel and the manual trigger are
//     the recovery, not a pretend catch-up cron.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { pool, withTx } = require('./db');
const { canApprovePO } = require('./auth');
const { todayISO, addDays, dayAge, num, roleRank, ROLE_RANK } = require('./enums');
const { logActivity } = require('./activity');
const notify = require('./notify');
const reports = require('./reports');

// ── the vocabulary: item kinds, in the order the day reads them ─────────────
// Ordered by "how loudly does this fall through a crack": money and dates
// first, records last. The Today panel and the mail body both render in this
// order, so the two can never disagree about what tops the list.
const DIGEST_GROUPS = [
  { kind: 'task',        title: 'Tasks overdue or due soon' },
  { kind: 'po_approval', title: 'Purchase orders waiting on your approval' },
  { kind: 'push_stale',  title: 'Scheduler pushes running behind' },
  { kind: 'crewless',    title: 'Load-ins inside 7 days with no crew' },
  { kind: 'report',      title: 'Show reports you owe' },
  { kind: 'content',     title: 'Content pieces due on you' },
  { kind: 'chase',       title: 'Content owed to us, past due' },
  { kind: 'byteless',    title: 'Files you filed with no document behind them' },
  { kind: 'backup_stale', title: 'Backups' },
  { kind: 'health',      title: 'System health' }
];

// how far ahead "due soon" looks, for tasks and content: today + 2 days.
const DUE_SOON_DAYS = 2;
// crewless-load-in horizon: inside a week is when an empty crew list stops
// being planning and starts being a problem.
const CREWLESS_DAYS = 7;

// ── THE GATHERING ───────────────────────────────────────────────────────────
// One person's plate, computed live. Never throws for an ordinary reason —
// the sweep iterates the whole roster and one person's broken corner must not
// silence everyone else's morning — but each collector that fails is reported
// in `errors` rather than swallowed into a lie of emptiness.
async function buildDigestFor(username, q = pool) {
  const today = todayISO();
  const out = { username, date: today, items: [], groups: [], total: 0, summary: '', errors: [] };
  const u = await q.query(
    'SELECT username, role, finance, active FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  const user = u.rows[0] || null;
  if (!user || user.active === false) return out;
  const soon = addDays(today, DUE_SOON_DAYS);
  const items = out.items;
  const collect = async (label, fn) => {
    try { await fn(); } catch (e) { out.errors.push(`${label}: ${e.message}`); }
  };

  // 1 · tasks — the /my-steps filter (routes/core.js) narrowed to dated steps
  // due within the window. Same open set (NOT done/na), same archived-show
  // exclusion, same LEFT JOIN that leaves project-level steps unaffected.
  await collect('tasks', async () => {
    const r = await q.query(
      `SELECT s.id, s.title, s.due_date, s.show_id, s.project_id,
              sh.name AS show_name, sh.venue AS show_venue, sh.project_id AS show_project_id
       FROM steps s LEFT JOIN shows sh ON sh.id = s.show_id
       WHERE LOWER(s.owner)=LOWER($1) AND s.status NOT IN ('done','na')
         AND sh.archived_at IS NULL
         AND s.due_date <> '' AND s.due_date <= $2
       ORDER BY s.due_date ASC, s.id ASC`, [username, soon]);
    for (const row of r.rows) {
      items.push({
        kind: 'task', label: row.title,
        where: row.show_name || row.show_venue || null,
        due: row.due_date, age: dayAge(row.due_date),
        show_id: row.show_id || null,
        project_id: row.show_project_id || row.project_id || null
      });
    }
  });

  // 2 · PO approvals — for canApprovePO holders ONLY (lib/auth.js: the admins
  // + the finance capability), the quoted POs poNeedsApproval() says are stuck
  // on a human. The predicates are routes/purchasing.js's own, imported —
  // never a second SQL copy of the threshold rule. Lazily required: the route
  // module needs express at load, and the direction (lib ← route) is worth
  // keeping visible at the one place it happens.
  await collect('po approvals', async () => {
    if (!canApprovePO({ role: user.role, finance: user.finance })) return;
    const purchasing = require('../routes/purchasing');
    const t = await purchasing.poThreshold(q);
    const pos = await q.query(`SELECT * FROM purchase_orders WHERE status='quoted' ORDER BY id`);
    if (!pos.rows.length) return;
    const lines = await q.query(
      `SELECT po_id, qty, unit_cost FROM po_lines WHERE po_id = ANY($1::int[])`,
      [pos.rows.map((p) => p.id)]);
    const byPo = new Map();
    for (const l of lines.rows) {
      if (!byPo.has(l.po_id)) byPo.set(l.po_id, []);
      byPo.get(l.po_id).push({ qty: num(l.qty, 0), unit_cost: num(l.unit_cost, 0) });
    }
    for (const row of pos.rows) {
      const po = { lines: byPo.get(row.id) || [], approval: row.approval };
      if (!purchasing.poNeedsApproval(po, t)) continue;
      items.push({
        kind: 'po_approval',
        label: `${row.po_number} · ${row.vendor || 'no vendor'}`,
        amount: purchasing.poTotal(po),
        po_id: row.id, project_id: row.project_id || null,
        age: dayAge(String(row.created_at).slice(0, 10))
      });
    }
  });

  // 3 · stale pushes — shows THIS person owns that were pushed and have since
  // changed. The three comparisons are hydrateShow's scheduler_stale SQL
  // (routes/core.js) verbatim: the show row, its steps, its crew — the exact
  // set a push publishes, and nothing else.
  await collect('stale pushes', async () => {
    const r = await q.query(
      `SELECT s.id, s.name, s.venue, s.project_id, s.event_date
       FROM shows s
       WHERE LOWER(s.owner)=LOWER($1) AND s.archived_at IS NULL
         AND s.scheduler_pushed_at IS NOT NULL
         AND ( s.updated_at > s.scheduler_pushed_at
               OR EXISTS (SELECT 1 FROM steps t
                          WHERE t.show_id = s.id AND t.updated_at > s.scheduler_pushed_at)
               OR EXISTS (SELECT 1 FROM crew_assignments ca
                          WHERE ca.show_id = s.id
                            AND GREATEST(ca.created_at, ca.updated_at) > s.scheduler_pushed_at) )
       ORDER BY s.event_date ASC NULLS LAST, s.id`, [username]);
    for (const row of r.rows) {
      items.push({
        kind: 'push_stale', label: row.name || row.venue || `show ${row.id}`,
        due: row.event_date || null, age: null,
        show_id: row.id, project_id: row.project_id
      });
    }
  });

  // 4 · crewless load-ins — shows this person owns, load-in inside the week,
  // not one crew line. A show a week out with nobody on it is the purest
  // "falling through the cracks" shape this app knows.
  await collect('crewless load-ins', async () => {
    const r = await q.query(
      `SELECT id, name, venue, project_id, load_in_date FROM shows s
       WHERE LOWER(owner)=LOWER($1) AND archived_at IS NULL
         AND load_in_date >= $2 AND load_in_date <= $3
         AND NOT EXISTS (SELECT 1 FROM crew_assignments ca WHERE ca.show_id = s.id)
       ORDER BY load_in_date ASC, id`, [username, today, addDays(today, CREWLESS_DAYS)]);
    for (const row of r.rows) {
      items.push({
        kind: 'crewless', label: row.name || row.venue || `show ${row.id}`,
        due: row.load_in_date, age: dayAge(row.load_in_date),
        show_id: row.id, project_id: row.project_id
      });
    }
  });

  // 5 · reports owed — lib/reports.js owedFor, the exact query My Tasks nags
  // from. Post-strike, crew-with-login, unfiled.
  await collect('reports', async () => {
    for (const rep of await reports.owedFor(username, q)) {
      items.push({
        kind: 'report',
        label: rep.show_name || rep.show_venue || `show ${rep.show_id}`,
        due: rep.due_date || null, age: rep.due_date ? dayAge(rep.due_date) : null,
        show_id: rep.show_id, project_id: rep.show_project_id || rep.project_id || null
      });
    }
  });

  // 6 · content due on THIS person — their own e360 pieces, open (the
  // complement of contentWaitingOn's done set: not approved/delivered/na),
  // dated inside the window.
  await collect('content', async () => {
    const r = await q.query(
      `SELECT cp.id, cp.name, cp.due_date, cp.show_id, sh.project_id,
              sh.name AS show_name, sh.venue AS show_venue
       FROM content_pieces cp JOIN shows sh ON sh.id = cp.show_id
       WHERE cp.source='e360' AND LOWER(cp.owner)=LOWER($1)
         AND cp.status NOT IN ('approved','delivered','na')
         AND sh.archived_at IS NULL
         AND cp.due_date <> '' AND cp.due_date <= $2
       ORDER BY cp.due_date ASC, cp.id`, [username, soon]);
    for (const row of r.rows) {
      items.push({
        kind: 'content', label: row.name,
        where: row.show_name || row.show_venue || null,
        due: row.due_date, age: dayAge(row.due_date),
        show_id: row.show_id, project_id: row.project_id
      });
    }
  });

  // 7 · the chase list — client/third-party pieces PAST due, for the pm+ who
  // OWNS the folder. The open-set filter is contentWaitingOn's, in SQL. The
  // audience is deliberately the folder's owner and not "everyone
  // canEditProject would pass" (which is every manager and admin, on every
  // folder): the chase belongs to the person running the event, and copying
  // it to the whole management tier every morning is how a digest becomes
  // wallpaper. The pm rank floor mirrors canEditProject's pm branch.
  await collect('chase list', async () => {
    if (roleRank(user.role) < ROLE_RANK.pm) return;
    const r = await q.query(
      `SELECT cp.id, cp.name, cp.source, cp.due_date, cp.show_id, sh.project_id,
              sh.name AS show_name, sh.venue AS show_venue
       FROM content_pieces cp
       JOIN shows sh ON sh.id = cp.show_id
       JOIN projects p ON p.id = sh.project_id
       WHERE cp.source <> 'e360'
         AND cp.status NOT IN ('approved','delivered','na')
         AND sh.archived_at IS NULL AND p.archived_at IS NULL
         AND LOWER(p.owner)=LOWER($1)
         AND cp.due_date <> '' AND cp.due_date < $2
       ORDER BY cp.due_date ASC, cp.id`, [username, today]);
    for (const row of r.rows) {
      items.push({
        kind: 'chase', label: row.name,
        where: row.show_name || row.show_venue || null,
        source: row.source,
        due: row.due_date, age: dayAge(row.due_date),
        show_id: row.show_id, project_id: row.project_id
      });
    }
  });

  // 8 · byteless files — rows THIS person filed whose bytes never landed
  // (Brendon's Rhino doc, 2026-09-03). fileIsByteless's rule, server-side:
  // the size the server owns is not > 0, the row is not remote-by-design
  // (external_store — the Dropbox third state must never read as missing
  // bytes), and only 'filed' rows count: proposed is the review queue's
  // problem, rejected/superseded are history.
  await collect('byteless files', async () => {
    const r = await q.query(
      `SELECT f.id, f.name, f.kind, f.show_id, f.project_id, f.created_at
       FROM files f LEFT JOIN shows sh ON sh.id = f.show_id
       WHERE LOWER(f.uploaded_by)=LOWER($1)
         AND COALESCE(f.size, 0) <= 0
         AND f.external_store IS NULL
         AND f.status='filed'
         AND sh.archived_at IS NULL
       ORDER BY f.id`, [username]);
    for (const row of r.rows) {
      items.push({
        kind: 'byteless', label: row.name,
        age: dayAge(String(row.created_at).slice(0, 10)),
        file_id: row.id, show_id: row.show_id || null, project_id: row.project_id || null
      });
    }
  });

  // 9 · admin extras — the operator's corner of the morning. CHEAP READS
  // ONLY: env-var presence and the ledger the health block already reads.
  // Nothing here opens a socket to the NAS or anything else — the storage
  // doctrine's 2026-08-28 lesson (a health check must say what it knows and
  // name what measures, never go dial a 30s-timeout NAS on every poll).
  if (user.role === 'admin') {
    await collect('backup posture', async () => {
      const hb = await require('./backup').healthBlock();
      if (hb.stale) {
        items.push({
          kind: 'backup_stale',
          label: 'No verified backup landing in 26h — the nightly failed, stopped, or never started',
          age: null
        });
      }
    });
    await collect('system health', async () => {
      const { storageReady, storageInfo } = require('./storage');
      if (!storageReady()) {
        items.push({ kind: 'health', label: 'File storage is not configured — uploads are being refused (WIRING_DAY.md)' });
      } else if (storageInfo().ephemeralRisk) {
        items.push({ kind: 'health', label: 'Storage is on the container\'s own disk — bytes there die with the next deploy' });
      }
    });
  }

  out.total = items.length;
  out.groups = groupItems(items);
  out.summary = digestSummary(items);
  return out;
}

// items -> ordered groups, DIGEST_GROUPS order, empty groups omitted.
function groupItems(items) {
  return DIGEST_GROUPS
    .map((g) => ({ kind: g.kind, title: g.title, items: items.filter((i) => i.kind === g.kind) }))
    .filter((g) => g.items.length);
}

// ── the one-line summary ────────────────────────────────────────────────────
// "3 overdue tasks · a PO waits on you · Big Ten push is stale" — compact,
// fixed order (the group order), one phrase per group. Pure, so the suites
// can pin its shape without a database.
function digestSummary(items) {
  const by = {};
  for (const i of items) (by[i.kind] = by[i.kind] || []).push(i);
  const s = (n) => (n === 1 ? '' : 's');
  const parts = [];
  const tasks = by.task || [];
  const late = tasks.filter((i) => i.age != null && i.age > 0).length;
  const dueSoon = tasks.length - late;
  if (late) parts.push(`${late} overdue task${s(late)}`);
  if (dueSoon) parts.push(`${dueSoon} task${s(dueSoon)} due soon`);
  const po = by.po_approval || [];
  if (po.length) parts.push(po.length === 1 ? 'a PO waits on you' : `${po.length} POs wait on you`);
  const st = by.push_stale || [];
  if (st.length) parts.push(st.length === 1 ? `${st[0].label} push is stale` : `${st.length} pushes are stale`);
  const cw = by.crewless || [];
  if (cw.length) parts.push(cw.length === 1
    ? `${cw[0].label} loads in with no crew` : `${cw.length} load-ins have no crew`);
  const rep = by.report || [];
  if (rep.length) parts.push(rep.length === 1 ? 'a show report is owed' : `${rep.length} show reports owed`);
  const ct = by.content || [];
  if (ct.length) parts.push(`${ct.length} content piece${s(ct.length)} due`);
  const ch = by.chase || [];
  if (ch.length) parts.push(ch.length === 1 ? 'a client piece is past due' : `${ch.length} client pieces past due`);
  const bl = by.byteless || [];
  if (bl.length) parts.push(`${bl.length} file${s(bl.length)} with no bytes`);
  if ((by.backup_stale || []).length) parts.push('backups are stale');
  if ((by.health || []).length) parts.push('storage needs attention');
  return parts.join(' · ');
}

// The mail/outbox body: the grouped list in plain text, same order as the
// panel. The outbox caps bodies at 4000; a plate that overflows that is a
// plate whose first line already made the point.
function digestBody(digest) {
  const lines = [];
  for (const g of digest.groups) {
    lines.push(g.title.toUpperCase());
    for (const i of g.items) {
      let line = `  · ${i.label}`;
      if (i.where) line += ` — ${i.where}`;
      if (i.due) line += ` — due ${i.due}`;
      if (i.age != null && i.age > 0) line += ` (${i.age}d late)`;
      if (i.amount != null) line += ` — $${Number(i.amount).toLocaleString('en-US')}`;
      lines.push(line);
    }
  }
  lines.push('');
  lines.push('The bell’s Today panel has this list with every line clickable.');
  return lines.join('\n');
}

// ── THE SWEEP ───────────────────────────────────────────────────────────────
// Once over the active roster: build each plate, honour the opt-out, stay
// silent on empty, and deliver AT MOST once per user per UTC day — the ledger
// insert and the outbox row commit or roll back together. Returns per-user
// counts so the admin trigger can show its work.
async function runDigestSweep({ actor = 'system', flush = true } = {}) {
  const day = todayISO();
  const out = { day, considered: 0, notified: 0, empty: 0, opted_out: 0, already: 0, users: {} };
  const roster = await pool.query(
    `SELECT username FROM users WHERE active IS NOT FALSE ORDER BY LOWER(username)`);
  for (const row of roster.rows) {
    const uname = row.username;
    out.considered += 1;
    // opt-out first: nothing is built, nothing is written. See the header —
    // 'off' on daily_digest means NO row, not a skipped one.
    const mode = await notify.modeFor(uname, 'daily_digest');
    if (mode === 'off') {
      out.opted_out += 1;
      out.users[uname] = { items: 0, outcome: 'opted out' };
      continue;
    }
    const digest = await buildDigestFor(uname);
    // SILENCE ON EMPTY — the success state. No notification, no ledger row
    // (so work landing later today can still digest once, on the next
    // trigger). Break this guard and the smoke suite goes red naming the spam.
    if (!digest.total) {
      out.empty += 1;
      out.users[uname] = { items: 0, outcome: 'empty — silent' };
      continue;
    }
    const delivered = await withTx(async (c) => {
      // the per-day dedupe: the UNIQUE (username, day) index arbitrates.
      // Same transaction as the enqueue — a failed enqueue takes its ledger
      // claim down with it, so no day is ever burned without its delivery.
      const led = await c.query(
        `INSERT INTO digest_runs (username, day, items, summary)
         VALUES ($1,$2,$3,$4) ON CONFLICT (username, day) DO NOTHING RETURNING id`,
        [uname, day, digest.total, digest.summary.slice(0, 240)]);
      if (!led.rows.length) return false;                 // today's already went
      await notify.enqueue(c, {
        username: uname, kind: 'daily_digest', actor: 'system',
        subject: `Today — ${digest.summary}`,
        body: digestBody(digest),
        link: ''
      });
      return true;
    });
    if (delivered) {
      out.notified += 1;
      out.users[uname] = { items: digest.total, outcome: 'notified' };
    } else {
      out.already += 1;
      out.users[uname] = { items: digest.total, outcome: 'already sent today' };
    }
  }
  // keep the ledger bounded — a season of mornings; the outbox rows carry the
  // deeper record (same bounding move as backup_runs' 500-row cap).
  try {
    await pool.query(`DELETE FROM digest_runs WHERE day < $1`, [addDays(day, -120)]);
  } catch (e) { console.error('[digest] ledger trim:', e.message); }
  if (out.notified) {
    try {
      await logActivity(pool, {
        actor, action: 'digest.sweep',
        detail: `morning digest → ${out.notified} of ${out.considered} people ` +
                `(${out.empty} all-clear, ${out.opted_out} opted out, ${out.already} already had today's)`
      });
    } catch (e) { console.error('[digest] activity row:', e.message); }
  }
  // the house flush, exactly what lifecycle.sweep does after ITS enqueues:
  // immediate rows go to the driver now rather than waiting for the next
  // boot. The log driver records; Graph mails when configured. Optional so a
  // suite can inspect queued state.
  if (flush) {
    try { out.flush = await notify.flush({}); }
    catch (e) { console.error('[digest] flush:', e.message); }
  }
  return out;
}

// ── SCHEDULING — the lib/backup.js chain, same doctrine, own knobs ──────────
// 12:00 UTC ≈ 7am Central (6am when CST). DST HONESTY: this is a UTC hour, so
// the Chicago wall-clock delivery time shifts by one hour twice a year. That
// is fine — the point is "at the start of the working day", not "07:00:00
// sharp" — and the per-day ledger means the shift can never double-deliver.
const hourUtc = () => {
  const h = parseInt(process.env.DIGEST_HOUR_UTC || '12', 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 12;
};
const enabledByEnv = () => String(process.env.DIGEST_ENABLED || '') !== '0';

function nextDigestRunAt(now = new Date(), hour = hourUtc()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

let timer = null;
let armedFor = null;
function armDigestTimer() {
  const arm = () => {
    const at = nextDigestRunAt(new Date(), hourUtc());
    armedFor = at;
    timer = setTimeout(async () => {
      try {
        if (!enabledByEnv()) {
          console.log('[digest] DIGEST_ENABLED=0 — scheduled sweep skipped');
        } else if (!process.env.DATABASE_URL) {
          console.log('[digest] scheduled sweep skipped — DATABASE_URL not set');
        } else {
          const r = await runDigestSweep({ actor: 'system' });
          console.log(`[digest] morning sweep: ${r.notified} notified, ${r.empty} all-clear, ` +
                      `${r.opted_out} opted out, ${r.already} already had today's`);
        }
      } catch (e) {
        console.error('[digest] scheduled sweep:', e.message);
      }
      arm();                                              // re-arm REGARDLESS
    }, at.getTime() - Date.now());
    if (timer.unref) timer.unref();
    return at;
  };
  return arm();
}
function armedForAt() { return armedFor; }

module.exports = {
  buildDigestFor, runDigestSweep, armDigestTimer, armedForAt,
  // pure seams, exported for the suites
  digestSummary, digestBody, groupItems, nextDigestRunAt, hourUtc,
  DIGEST_GROUPS, DUE_SOON_DAYS, CREWLESS_DAYS
};
