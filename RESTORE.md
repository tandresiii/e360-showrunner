# RESTORE.md — the bad day, scripted while it is still hypothetical

Showrunner's only PostgreSQL lives on Railway. Every night at **08:00 UTC**
(≈ 3am Central; it drifts an hour across DST and that is fine) the app runs
`pg_dump -Fc` on itself and ships the file to the NAS at

    \\E360-NAS\Showrunner\_backups\showrunner-YYYY-MM-DDTHHmm.dump

through the same storage driver (WebDAV over Tailscale) that carries every
other byte. Each landing is **read back and size-verified** before the run is
recorded `ok`; the in-app ledger is `GET /api/admin/backups` (admin) and the
Settings → Backups card, and `/api/health` carries a `backup` block whose
`stale: true` means *no verified dump in 26 hours — look today, not on the
bad day*.

This file is the script for the day Railway's Postgres is gone.

---

## 1 · Get the dump off the NAS

The **NAS listing is the source of truth** — on the true bad day the app (and
its ledger) are down with the database. From any machine on the office LAN or
tailnet:

- Explorer: `\\E360-NAS\Showrunner\_backups\` → take the **newest**
  `showrunner-*.dump` (names sort chronologically).
- Or Synology File Station / a tailnet mount — same folder.

Sanity check: the file should be roughly the size of recent nightlies, not
0 bytes. (If the app is still up, `GET /api/admin/backups` shows the ledger
size next to the live NAS listing — they should agree.)

## 2 · Provision the new database — the two-URL dance

1. In Railway, add a **fresh PostgreSQL service** to the project.
2. You now hold **two URLs**: the old `DATABASE_URL` still configured on the
   Showrunner service (pointing at the dead database — leave it alone for
   now) and the **new** service's connection URL (Railway shows both an
   internal `postgres.railway.internal` URL and a public proxy URL — from
   your laptop, use the **public** one).
3. **Do not point the app at the new database yet.** Showrunner's `initDB()`
   is additive and runs on boot: pointed at an empty database it would create
   empty tables, seed an admin, and look perfectly alive — an empty app that
   *looks* restored is the trap this ordering exists to avoid.

## 3 · Restore — restore FIRST, then point the app

From any machine with PostgreSQL client tools **version ≥ the server major**
(the repo's `node scripts/fetch-pg-tools.mjs` fetches them on Windows;
`apt install postgresql-client-18` elsewhere):

```sh
pg_restore --no-owner --dbname "<NEW_PUBLIC_URL>" showrunner-2026-09-10T0800.dump
```

- `--no-owner` because the new service's role differs from the old one.
- A handful of `ALTER OWNER` warnings is normal; hard errors are not.

Quick pre-flight count before touching the app:

```sh
psql "<NEW_PUBLIC_URL>" -c "SELECT
  (SELECT COUNT(*) FROM projects)  AS projects,
  (SELECT COUNT(*) FROM shows)     AS shows,
  (SELECT COUNT(*) FROM files)     AS files,
  (SELECT COUNT(*) FROM users)     AS users,
  (SELECT COUNT(*) FROM activity)  AS activity;"
```

Numbers should look like the workspace you remember (the restored
`backup_runs` table even carries the ledger of the dumps that led here).

## 4 · Point the app, then verify

1. On the Showrunner service, set `DATABASE_URL` to the **new** URL (Railway
   internal URL is fine for the app itself) and redeploy.
2. Verify, in order:
   - `GET /api/health` → `ok: true`, and the `backup` block reappears
     (it will read `stale: true` until the next nightly lands — correct).
   - Sign in; open a folder you know; check a show, its files list, and the
     finance view against the counts from step 3.
   - `POST /api/admin/backup` (or Settings → Backups → *Back up now*) — the
     first dump OF the restored database into the same `_backups/` pile is
     the closing of the loop.

Sessions are not preserved across a restore-to-new-instance in practice —
everyone signs in again; that is the whole damage when this script works.

## Quarterly restore drill — without touching production

A backup nobody has restored is a hope, not a backup. Once a quarter:

1. Take the newest dump off the NAS (step 1 — read-only, no production
   contact).
2. Restore it into a **scratch** Postgres: a throwaway Railway service you
   delete afterwards, a local Docker `postgres:18`, or the repo's embedded
   one. **Never** set the production app's `DATABASE_URL` during a drill.
3. Run the step-3 count query; eyeball a couple of rows (`SELECT name FROM
   projects ORDER BY id DESC LIMIT 5`).
4. Delete the scratch database. Note the drill (date + counts) in
   TEAM_FEEDBACK.md or a note row.

The smoke suite also proves the mechanism end-to-end on every run — it dumps
its throwaway database through `lib/backup.js`, restores the landed file into
a second database with real `pg_restore`, and asserts row counts match — so
the *code* path is continuously rehearsed; the quarterly drill rehearses the
*human* path.

## What this backup does NOT cover — honestly

- **NAS file bytes.** The show files, photos and specs already LIVE on the
  NAS; the dump carries their metadata rows (`files.nas_path`), not the bytes
  — those are the NAS's own RAID + Hyper Backup story. A dead NAS is a
  different bad day than a dead Railway, and this file scripts only the
  second.
- **Railway environment variables.** `DATABASE_URL`, the Tailscale key, the
  WebDAV credentials, mail/Flex/scheduler settings — re-entered by hand from
  SCHEMA.md's environment table. They are secrets; they do not belong in a
  dump.
- **The container image.** Rebuilt from this repo by Railway on deploy;
  nothing to restore.
- **Anything after the last nightly.** The window is up to 24h + the work
  since 08:00 UTC. `POST /api/admin/backup` before risky maintenance shrinks
  it to zero on demand.
