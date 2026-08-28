# Wiring day — putting real bytes on the NAS

The runbook for the one session that turns Showrunner's file layer on. Everything
in this document is a step somebody performs; nothing in it is a decision still
to be made.

**What is already built and tested (no NAS required):** the WebDAV driver, the
Tailscale SOCKS routing, the upload and download routes, the browser upload and
download flows, and the deployment image. `node scripts/storage-test.js` proves
all of it against an in-process WebDAV server, an in-process SOCKS5 proxy and a
self-signed TLS certificate, round-tripping the real Big Ten PDF byte-for-byte.

**What only this session can prove:** that Tom's Synology's WebDAV agrees with
that implementation, that a Railway container can join the tailnet and resolve
the NAS by name, and that `svc-showrunner` can actually write to the share.
Those three are §6 below.

| | Steps | Who | Where |
|---|---|---|---|
| **Part A · the NAS** | N1 – N7 | Tom | in front of DSM (or its web UI) |
| **Part B · Tailscale admin** | T1 – T5 | Tom | login.tailscale.com |
| **Part C · Railway** | R1 – R6 | Tom (or whoever holds Railway) | railway.app dashboard |
| **Part D · smoke** | S1 – S8 | together | browser + NAS + a terminal |
| **Part E · rollback** | X1 – X3 | — | if any of D fails |

**29 steps total — 12 on Tom's side (N1–N7 at the NAS, T1–T5 in the Tailscale
admin console), 6 on Railway (R1–R6), 8 in the smoke sequence (S1–S8), and 3
rollback steps (X1–X3) you only reach if something in D fails.**

Budget an hour. Most of it is waiting for two Synology packages to install.

---

## Before you start

Have these in hand:

- DSM admin login for the Synology.
- The `svc-showrunner` password (Tom's password manager). If the account does
  not exist yet, N5 creates it.
- Railway access to the Showrunner service.
- A Tailscale account. If there is no tailnet yet, T1 makes one — it is free
  for this (the Personal plan covers 3 users / 100 devices, and this needs two
  devices).
- The staged test file, already in the repo:

  ```
  showrunner-app/nas-staging/P1-big-ten-vs-sec-volleyball-challenge/
      S1-wrigley-field/spec/00_e360_BigTen_SEC_v01_080726_100pm.pdf
  ```

  | | |
  |---|---|
  | size | **364,739 bytes** |
  | SHA-256 | `f1ab6ba0580a539d6aa05f76b726fe0ac505249c1769da4cd689765741c2c22f` |
  | MD5 | `df17f2c099aa39a5c6f31fcd2e6ae0dc` |

  Those numbers are what §6 byte-compares against. Nothing else in this
  document needs to be believed on trust.

---

## Part A · the Synology  *(Tom, at the NAS)*

### N1. Install the Tailscale package

DSM → **Package Center** → search **Tailscale** → **Install**.

It is published by Tailscale for DSM 7. If it does not appear, the model is
probably on DSM 6 — say so and stop here, because the rest of Part A assumes
DSM 7 and the fallback (a manual `tailscaled` install) is a different runbook.

### N2. Log the NAS into the tailnet

Open the Tailscale package → **Log in** → it opens a browser tab → authenticate
with the same account used in T1 → approve the machine.

When it comes back the package shows a `100.x.y.z` address. **Write it down**;
S3 checks for it.

Give the machine a name you will not regret typing: **`e360-nas`**. (Tailscale
takes the hostname by default. Rename it in the admin console at T3 if DSM
handed it something like `DiskStation`.)

### N3. Install the WebDAV Server package

DSM → **Package Center** → search **WebDAV Server** → **Install**.

### N4. Enable WebDAV over HTTPS on 5006 — and only HTTPS

Open **WebDAV Server** → **Settings**:

- ☐ Enable HTTP  — **leave this OFF.** Port 5005 is plaintext. Even inside a
  WireGuard tunnel there is no reason to offer it, and an open 5005 is a thing
  somebody can later expose by accident.
- ☑ **Enable HTTPS** — port **5006**.
- ☑ Enable DavDepthInfinity — optional; Showrunner never sends `Depth:
  infinity`, so this changes nothing for us.

**Apply.**

> **DSM firewall.** If Control Panel → Security → Firewall is enabled, add a
> rule allowing **5006** on the **Tailscale interface**. Tailnet traffic arrives
> on `tailscale0`, not on the LAN interface, so a rule that only opens 5006 to
> the local subnet will not let Railway in — and the symptom is a connection
> that hangs rather than one that is refused.

### N5. The `svc-showrunner` account

DSM → **Control Panel → User & Group → User**.

- If `svc-showrunner` exists, skip to permissions.
- Otherwise **Create** it. Give it a long random password and put that password
  in the password manager *now*, because R4 needs it and DSM will not show it
  again.

Settings for the account:

- **Applications:** allow **WebDAV Server**. Deny everything else — DSM File
  Station, Drive, Photos, and above all **deny DSM login**. This account holds
  a password that lives in a Railway environment variable; it should not be able
  to log into the box.
- **Groups:** `users` only. Not `administrators`.

### N6. The `showrunner` shared folder and its permissions

DSM → **Control Panel → Shared Folder**.

- If a shared folder named **`showrunner`** does not exist, create it. Lower
  case, exactly that spelling — it is the last path segment of
  `NAS_WEBDAV_URL` and DSM's WebDAV paths are case-sensitive.
- Edit it → **Permissions** → give `svc-showrunner` **Read/Write**.
- Recycle bin: on is fine and is a small safety net. Showrunner never deletes a
  file's bytes on a normal delete (only the metadata row goes; see
  `routes/files.js`), so the only thing that lands there is a rejected agent
  proposal being purged out of `_agent-inbox`.

### N7. Sanity-check WebDAV from a machine on the LAN

Before involving Tailscale at all, prove WebDAV works locally. From any machine
on the office network:

```bash
curl -k -u 'svc-showrunner:PASSWORD' \
     -X PROPFIND -H 'Depth: 0' \
     https://<nas-lan-ip>:5006/showrunner
```

Expect **`207 Multi-Status`** and a lump of XML.

- `401` → the account or its WebDAV application permission (N5).
- `404` → the share name is wrong (N6).
- connection refused → the package is not running or HTTPS is not enabled (N4).
- hangs → the DSM firewall (the note in N4).

`-k` is there because the certificate is self-signed at this point; §5 deals
with that properly.

**If N7 does not return 207, stop.** Nothing after this can work, and every
later failure will look like a Tailscale problem instead of a WebDAV one.

---

## Part B · the Tailscale admin console  *(Tom, login.tailscale.com)*

### T1. A tailnet, if there is not one already

Sign in at **login.tailscale.com** with the account that should own this — a
Google/Microsoft/GitHub identity is fine. The tailnet is created on first login
and gets a name like `tail1a2b3.ts.net`. **Write that name down**; it is half of
`NAS_WEBDAV_URL`.

If a tailnet already exists, use it. Do not make a second one — the NAS and the
Railway container must be on the *same* tailnet or none of this connects.

### T2. Turn on MagicDNS

**DNS** tab → **MagicDNS: Enable**.

This is what makes the NAS reachable as `e360-nas.tail1a2b3.ts.net` instead of
a `100.x` address that changes if the machine is ever re-added. Showrunner
addresses the NAS by name on purpose, and always resolves it *inside* the
tailnet (the SOCKS5 CONNECT carries the hostname, not an IP), so MagicDNS is
load-bearing rather than a convenience.

### T3. Name the NAS machine and **disable its key expiry**

**Machines** tab → find the Synology.

1. Rename it to **`e360-nas`** if DSM gave it something else.
2. Open its **⋯** menu → **Disable key expiry**.

Step 2 is the one that quietly breaks this six months from now if it is skipped.
Node keys expire after 180 days by default; when the NAS's key expires it drops
off the tailnet, every upload starts answering 502, and nothing in the app will
point at "a key expired in the admin console".

Note the machine's full MagicDNS name — you need it for R3.

### T4. Generate the auth key for Railway

**Settings → Keys → Generate auth key**.

| Setting | Value | Why |
|---|---|---|
| **Reusable** | **ON** | Railway's filesystem is ephemeral. Every redeploy is a *new* node joining, and a single-use key works exactly once. |
| **Ephemeral** | **ON** | An ephemeral node removes itself from the machine list when it goes offline. Without it, the Machines page accumulates a dead `showrunner` for every deploy. |
| **Expiration** | 90 days | The maximum. Put a calendar reminder on it — see the note below. |
| **Tags** | `tag:showrunner` (optional, see T5) | |

Copy the key (`tskey-auth-…`). It is shown **once**. It goes straight into
Railway at R2.

> **The 90-day cliff.** Auth keys cannot be made non-expiring. When this key
> expires, existing deploys keep running (they are already on the tailnet) but
> the **next redeploy fails to join** — and the failure is a warning line in the
> deploy log, not a crash, because `docker-entrypoint.sh` deliberately lets the
> app boot without the tailnet. Put "rotate the Showrunner Tailscale key" in the
> calendar for **day 80**, and note that rotating it is: generate a new key
> (T4), paste it into `TAILSCALE_AUTHKEY` (R2), redeploy.

### T5. ACLs — pick one

**The quick path.** A fresh tailnet's default ACL is "everyone can reach
everything". Leave it. Both machines are Tom's, and the NAS's own account
permissions (N5/N6) are the real access control. Skip to Part C.

**The tight path.** If the tailnet has other people or devices on it, restrict
the container to exactly the one port it needs. **Access controls** tab:

```jsonc
{
  "tagOwners": {
    "tag:showrunner": ["autogroup:admin"],
    "tag:nas":        ["autogroup:admin"]
  },
  "acls": [
    // the Railway container may reach the NAS's WebDAV port and nothing else
    { "action": "accept", "src": ["tag:showrunner"], "dst": ["tag:nas:5006"] },
    // everything already allowed for people stays allowed
    { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }
  ]
}
```

Then tag the NAS: **Machines → e360-nas → ⋯ → Edit ACL tags → `tag:nas`**, and
make sure the auth key from T4 carries `tag:showrunner`. A tagged key is
required for a tagged node — if the key is untagged the container joins as
Tom's personal device and the first ACL rule never matches it.

---

## Part C · Railway  *(6 steps)*

### R1. Check which builder the service is using

Railway service → **Settings → Build**.

This repo now contains a **`Dockerfile`**, and Railway prefers it over Nixpacks
automatically. That is intended: the image has to carry `tailscaled` alongside
Node, and a Dockerfile is the only place that is legible. See the header comment
in `Dockerfile` for the full trade-off.

- If **Builder** is on *Automatic* / *Dockerfile*: nothing to do.
- If it has been **pinned to Nixpacks**: switch it to **Dockerfile**, or the
  tailscale binaries will not be in the image and every upload will 502.

**What changes about the build:** Node is now pinned to **22 LTS** (it used to
be whatever Nixpacks chose) and Tailscale to **1.86.2**. Nothing else. `npm
start` on a laptop is unaffected — the Dockerfile is not in that path.

### R2. Add `TAILSCALE_AUTHKEY`

**Variables** → New Variable:

```
TAILSCALE_AUTHKEY = tskey-auth-…            (the key from T4)
```

This one variable is the switch. With it unset, `docker-entrypoint.sh` never
starts `tailscaled` and the container behaves exactly as it did before —
which is also the rollback in X2.

### R3. Point the app at the NAS

```
STORAGE_DRIVER  = webdav
NAS_WEBDAV_URL  = https://e360-nas.tail1a2b3.ts.net:5006/showrunner
```

Substitute the real MagicDNS name from T3. The path is the **share** name from
N6. No trailing slash.

`SHOWRUNNER_NAS_ROOT` does **not** need setting — it already defaults to
`\\E360-NAS\Showrunner`, which is the UNC string operators read out of the UI
and paste into Explorer. It is a label, not a route; nothing dials it.

### R4. Credentials

```
NAS_WEBDAV_USER = svc-showrunner
NAS_WEBDAV_PASS = <the password from N5>
```

### R5. The certificate — choose one of three

The Synology's default certificate is self-signed and issued for the box's LAN
or DDNS name, **not** for `e360-nas.tail1a2b3.ts.net`. Left alone, Node refuses
the connection and `/api/health` reports the reason. Three honest ways out, best
first:

**(a) A real certificate from Tailscale — nothing to set.**
Admin console → **DNS → HTTPS Certificates → Enable**. Then on the Synology,
in the Tailscale package (or over SSH):

```bash
tailscale cert e360-nas.tail1a2b3.ts.net
```

Install the resulting cert/key in **DSM → Control Panel → Security →
Certificate**, and set it as the certificate used by **WebDAV Server**. It is a
publicly-trusted Let's Encrypt chain for the tailnet name, so verification
simply passes and **no `NAS_WEBDAV_*` certificate variable is needed at all.**
This is the right answer and it takes ten minutes.

**(b) Pin the NAS's own certificate.**

```
NAS_WEBDAV_CA = -----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----
```

Paste the DSM certificate's PEM (escaped newlines are handled). Verification
stays **on**, pinned to that certificate. `/api/health` reports
`storageTls: "pinned-ca"`. The cost is that DSM cert renewals become a thing
somebody has to remember.

**(c) Skip verification for this one host.**

```
NAS_WEBDAV_ALLOW_SELF_SIGNED = 1
```

Acceptable *here* and nowhere else: the connection is already inside an
authenticated, encrypted WireGuard tunnel, so TLS is the second lock on the
same door. It is scoped to the NAS driver only — it is **not**
`NODE_TLS_REJECT_UNAUTHORIZED`, and every other TLS client in the process
(Flex, Microsoft Graph, the staffing app) keeps full verification.
`/api/health` reports `storageTls: "self-signed-allowed"` so nobody can later
mistake this deployment for a verified one.

Start with (c) to get the wire working, then move to (a) before anyone calls
this finished.

### R6. Deploy, and read the log

Redeploy. In **Deployments → the new deploy → Logs**, expect, in this order:

```
[entrypoint] TAILSCALE_AUTHKEY is set — bringing up tailscaled (userspace networking)
[entrypoint] tailscale up OK as 'showrunner'
[entrypoint] tailnet IPv4: 100.x.y.z
[entrypoint] SOCKS5 + HTTP proxy listening on localhost:1055
[entrypoint] starting: node server.js
Showrunner DB tables ready
E360 Showrunner … running on port 8080
  storage driver : webdav  ->  https://e360-nas.tail1a2b3.ts.net:5006/showrunner  via tailscale-socks:127.0.0.1:1055
```

If instead you see `[entrypoint] WARNING: tailscale up failed`, the app is still
up (deliberately — Showrunner's schedules, budgets, notes and POs do not need
the NAS) but bytes will not move. Go to §7.

Optional variables, none of which need setting today:

| Var | Default | When you would set it |
|---|---|---|
| `TAILSCALE_HOSTNAME` | `showrunner` | a second environment on the same tailnet (`showrunner-staging`) |
| `TAILSCALE_REQUIRED` | off | make a failed tailnet join a hard deploy failure instead of a warning |
| `TAILSCALE_SOCKS_DISABLE` | off | the NAS became reachable directly and you want the proxy out of the path |
| `NAS_WEBDAV_TIMEOUT_MS` | `30000` | a slow link and large files |
| `MAX_UPLOAD_BYTES` | `104857600` | uploads bigger than 100 MB |

---

## Part D · the smoke sequence  *(8 steps)*

Do these in order. Each one isolates a different link in the chain, so the first
failure tells you which part is broken.

### S1. The container is on the tailnet

Tailscale admin → **Machines** → a machine named **`showrunner`**, online, with
an ephemeral marker. If it is not there, the failure is R2 or T4 (§7, first row).

### S2. The app can see the NAS

```bash
curl -s https://<your-showrunner>.up.railway.app/api/health | jq
```

```jsonc
{
  "ok": true,
  "storage": "webdav",
  "storageReady": true,
  "storageTarget": "https://e360-nas.tail1a2b3.ts.net:5006/showrunner",
  "storageVia": "tailscale-socks:127.0.0.1:1055",
  "storageTls": "self-signed-allowed",     // or "verified" / "pinned-ca"
  "storageError": null,
  "nasRoot": "\\\\E360-NAS\\Showrunner"
}
```

`storageReady: true` means *configured*, not *reachable* — it says the four
variables are present and parse. Reachability is S4.

There is no credential anywhere in that payload, deliberately: `/api/health` is
readable by anything that can reach the app.

### S3. The browser knows uploads are on

```bash
curl -s https://<your-showrunner>.up.railway.app/api/config | jq .features
```

`"fileUpload": true`. This is what makes the Add-file dialog offer a real file
picker instead of the "no storage on this server" callout.

### S4. Upload the staged Big Ten PDF

In the app: **Big Ten vs SEC Volleyball Challenge → Wrigley Field → Files →
Add file**.

- **File:** `nas-staging/P1-big-ten-vs-sec-volleyball-challenge/S1-wrigley-field/spec/00_e360_BigTen_SEC_v01_080726_100pm.pdf`
- **Type:** Spec
- **Name:** leave blank — it takes the file's own name.
- **Upload.**

Expect the toast **"File uploaded · 356 KB"**, the viewer opening on the new
row, and the file's **Size** reading **356 KB** (364,739 bytes) — a *real*
number that came back from the NAS, not one the browser guessed.

This is also the moment the deep MKCOL path runs for the first time: the
`P1-…/S1-…/spec/` folders do not exist on the share yet, and the driver creates
all three on the way.

**Headless equivalent**, if you would rather do it from a terminal:

```bash
APP=https://<your-showrunner>.up.railway.app
TOK=$(curl -s -X POST $APP/api/auth/login -H 'Content-Type: application/json' \
      -d '{"username":"tandres","password":"…"}' | jq -r .token)

# 1. the metadata row (the server derives nas_path — you cannot supply one)
FILE=$(curl -s -X POST $APP/api/files -H "x-auth-token: $TOK" \
     -H 'Content-Type: application/json' \
     -d '{"show_id":1,"name":"00_e360_BigTen_SEC_v01_080726_100pm","ext":"pdf","kind":"spec","spec_type":"e360"}')
ID=$(echo "$FILE" | jq -r .id)
echo "$FILE" | jq .nas_path

# 2. the bytes
curl -s -X PUT "$APP/api/files/$ID/content" -H "x-auth-token: $TOK" \
     --data-binary @nas-staging/P1-big-ten-vs-sec-volleyball-challenge/S1-wrigley-field/spec/00_e360_BigTen_SEC_v01_080726_100pm.pdf | jq
```

Expect:

```json
{ "ok": true, "size": 364739,
  "nas_path": "\\\\E360-NAS\\Showrunner\\P1-…\\S1-…\\spec\\00_e360_BigTen_SEC_v01_080726_100pm.pdf",
  "sha256": "f1ab6ba0580a539d6aa05f76b726fe0ac505249c1769da4cd689765741c2c22f" }
```

**The `sha256` in that response is computed from the bytes the server actually
received.** If it matches the table in "Before you start", the upload arrived
intact — no second transfer needed to know it.

### S5. The bytes are on the NAS, in the right folder

On the Synology (File Station, or Explorer at `\\E360-NAS\showrunner`):

```
showrunner\
  P1-big-ten-vs-sec-volleyball-challenge\
    S1-wrigley-field\
      spec\
        00_e360_BigTen_SEC_v01_080726_100pm.pdf      364,739 bytes
```

The folder names are `P{projectId}-{slug}` and `S{showId}-{slug}` — the same
convention the UI prints, so an operator can always find a file by reading its
path out of the app.

### S6. Byte-compare, on the NAS side

From Windows, against the file on the share:

```powershell
Get-FileHash '\\E360-NAS\showrunner\P1-big-ten-vs-sec-volleyball-challenge\S1-wrigley-field\spec\00_e360_BigTen_SEC_v01_080726_100pm.pdf' -Algorithm SHA256
```

Must print `F1AB6BA0580A539D6AA05F76B726FE0AC505249C1769DA4CD689765741C2C22F`.

That is the whole point of the exercise: **the file on Tom's NAS is bit-for-bit
the file that was on his laptop**, having crossed a WireGuard tunnel, a SOCKS5
proxy and a WebDAV PUT to get there.

### S7. Download it back **through the app**

In the viewer, **Download**. The browser saves
`00_e360_BigTen_SEC_v01_080726_100pm.pdf`; open it and it is the deck.

This is the half that matters for everyone who is not in the office. The NAS is
not on the internet and never will be — the *server* reaches it over the tailnet
and streams the bytes out over the session the user already has. Nobody needs a
VPN client, a share password, or a UNC path.

Headless:

```bash
curl -s "$APP/api/files/$ID/content" -H "x-auth-token: $TOK" -o /tmp/roundtrip.pdf
shasum -a 256 /tmp/roundtrip.pdf
```

Third occurrence of `f1ab6ba0…` — laptop, NAS, and back out through the app.

### S8. Failure behaves itself

Prove the honest-failure path once, while somebody is watching, so nobody meets
it for the first time during a show:

1. Stop the WebDAV Server package on the NAS (or pull it off the tailnet).
2. Reload the file in the app and press **Download**.
   Expect a toast reading **"Could not download … Cannot reach the E360 NAS
   (e360-nas.tail1a2b3.ts.net:5006 via the Tailscale SOCKS proxy at
   127.0.0.1:1055) … No data was lost; the Showrunner record is intact."**
3. Try an upload. Same class of message; the metadata row is still created and
   the file stays retryable.
4. `GET /api/health` → `storageReady` is still `true` (it is still *configured*)
   but every byte call answers **502**. That distinction is deliberate: a 502
   means "the NAS is down", a 501 means "nobody configured a NAS".
5. Restart the package. The next download works with no redeploy — nothing is
   cached and nothing needs resetting.

---

## Part E · rollback  *(3 steps)*

Any of Part D failing, and no appetite to debug it live:

### X1. Turn storage off

Railway → **Variables** → set:

```
STORAGE_DRIVER = local
```

(or delete the variable — `local` is the default). Redeploy.

Every byte route goes back to the pre-wiring behaviour: metadata rows are still
created, the Add-file dialog says *"No storage on this server"* up front, and
nothing pretends to have stored anything. **No data is lost and no rows change.**
`files.nas_path` was already being written on every row long before there was a
NAS — the paths stay correct and turning storage back on picks up exactly where
this left off.

### X2. Turn the tailnet off

Delete `TAILSCALE_AUTHKEY`. `docker-entrypoint.sh` stops launching `tailscaled`
and the container networks normally. Do this second, not first — the app boots
fine either way, and leaving the tailnet up while you debug storage is useful.

### X3. Undo the build change, if it is the build that broke

Delete `Dockerfile` and `.dockerignore` from the repo root and redeploy.
Railway falls straight back to Nixpacks and the image is what it was before
this session. Nothing else in the repo depends on those two files.

---

## §7 · When it does not work

### Start here: `POST /api/admin/storage-probe`

**Do not read the table below before running the probe.** Every row in it is a
guess, and on 2026-08-28 four of them looked right and all four were wrong.

Railway gives no shell and no log an operator can read from a laptop, so the
route's **response body is the instrument**. It walks the chain a layer at a
time and reports each with its own outcome, milliseconds and error — including
the layers that pass, because the one that answers in 2 ms is how you recognise
the one that hangs for 8 s. Nine numbered steps: the proxy port, the SOCKS5
greeting, CONNECT, TLS (with the real certificate and whether it *would*
verify), then PROPFIND, MKCOL, PUT, GET, DELETE. It cleans up after itself and
never prints a credential.

```bash
# sign in, then:
curl -sS -X POST https://<host>/api/admin/storage-probe \
     -H "x-auth-token: $TOKEN" -H 'content-type: application/json' \
     -d '{"timeoutMs":8000}' | jq '.verdict, .steps'

# when the nine steps are not enough — a port sweep through the tunnel, a
# reply-size ladder, an MTU ladder via `tailscale ping --size`:
     -d '{"timeoutMs":4000,"deep":true}'
```

Read **`verdict`** first: it is ordered by how far down the stack the fault is,
because the lowest failing layer is the only one worth fixing. Then
`firstFailure`, then the step itself.

> **`/api/health` cannot answer this question and never could.**
> `storageReady` and `storageTls` are read out of environment variables; that
> endpoint has never opened a socket. It said `true` and `"verified"` all day
> against a NAS that could not be reached at all. `"verified"` was not a
> handshake result — it was the string printed when no self-signed allowance is
> configured. It now reads `system-trust`, carries `readyMeans` / `tlsMeans`
> saying what it is and is not, and reports **`storageLiveness`** — whether the
> NAS answered the last time the app genuinely talked to it, which is the only
> free measurement there is.

### The one that cost a day

**Symptom:** every byte operation times out at 30 s with *"The NAS did not
answer"*, whatever its size. Both machines show **Connected**. `tailscale ping`
pongs in 50 ms. The NAS, the share and the account are perfect over the LAN.

**What it is not:** not DNS (name and IP hang identically), not the firewall
(off), not the SOCKS client, not credentials, not permissions, not the
certificate. The probe cleared all of them in one run: steps 1–3 pass in under
100 ms and HTTP CONNECT through the same port agrees.

**What it is:** over the **direct UDP path** the NAS could not deliver a reply
that needed more than one packet. The control that proved it — two TLS
handshakes to the same port in the same second:

| ClientHello | its answer | result |
|---|---|---|
| offering no acceptable cipher | a 7-byte `handshake_failure` alert | **arrived**, 7 bytes, connection closed |
| valid | a 2–4 KB certificate chain | **never arrived**, 0 bytes in 3,000 ms |

Nothing changed but the size of the answer. Every WebDAV verb sat behind that
handshake, so the only symptom the app could produce was one 30-second silence.

`tailscale ping` stays green throughout — including at 1400 bytes — because a
disco ping is generated inside `tailscaled` and never touches the far side's TCP
stack. That is exactly why *"both machines show Connected"* was true and useless.

**Fix:** `TAILSCALE_FORCE_DERP=1`, set in the `Dockerfile`. Traffic goes over a
Tailscale relay instead of point to point. With it, all nine steps pass and the
largest reply that arrives whole goes from 528 bytes to 12,130.

**It is a workaround, not a cure.** The fault is the far side: the NAS runs the
DSM Tailscale package **1.58.2** on a 4.4 kernel, four years older than the
client in the container. **Tom's hand:** update that package, then delete the
`ENV TAILSCALE_FORCE_DERP=1` line and re-run the probe. If all nine still pass,
the direct path is healed and the relay hop can go. To test without a deploy,
set `TAILSCALE_FORCE_DERP=0` as a Railway variable — it overrides the Dockerfile.

### Also found, and still Tom's

Step 4 reads the real certificate, and the NAS is presenting one that
**expired on 30 June 2023** — `CN=synology`, issued by `Synology Inc. CA`,
`SAN: DNS:synology`, `verifyError: CERT_HAS_EXPIRED`. Bytes move today only
because `ALLOW_SELF_SIGNED=1` turns verification off for this one host, and the
transport is an authenticated WireGuard tunnel underneath, so the practical risk
is low. But *"self-signed"* was a guess and *"expired for three years"* is a
measurement, and the honest description of the current posture is **no
certificate verification at all**.

The cure is R5a: `tailscale cert` on the NAS issues a real, auto-renewing
certificate for its tailnet name. When that is in place, point `NAS_WEBDAV_URL`
at the MagicDNS name, drop the allowance, and re-run the probe — step 4 should
say `wouldVerify: true` and health should read `storageTls: "system-trust"`.

### The rest

| Symptom | Almost always | Fix |
|---|---|---|
| **Everything times out at 30 s regardless of size, but `tailscale ping` is fine** | the direct path cannot carry a multi-packet reply | `TAILSCALE_FORCE_DERP=1` — see above. Confirm with `{"deep":true}`: the `tlsRaw` / `tlsTiny` pair is the proof |
| Probe step 1 fails, 2–9 skipped | `tailscaled` is down, never started, or bound an address the app is not dialling | the deploy log; `TAILSCALE_AUTHKEY` |
| Probe step 3 fails and step 3b **passes** | our SOCKS5 client is the fault — HTTP CONNECT reached the NAS through the same port and the same dialer | a bug in `lib/storage.js socksConnect`; the probe's trace names the phase |
| Probe steps 3 **and** 3b both fail the same way | the fault is below our proxy code — the tailnet data plane to this peer | the tailnet, not the app |
| Probe step 4 says `driverWouldAccept: false` | the certificate question, measured rather than guessed | R5, or `NAS_WEBDAV_ALLOW_SELF_SIGNED=1` |
| A variable you set does nothing | you spelled it the short way | `config.ignoredEnvVars` in the probe names it. The self-signed spellings are accepted outright; `config.allowSelfSignedFrom` says which one took effect |
| Deploy log: `WARNING: tailscale up failed` | the auth key is single-use, expired, or tagged without a matching `tagOwners` entry | T4 (Reusable **ON**) / T5 |
| No `showrunner` machine in the admin console | `TAILSCALE_AUTHKEY` is not set on the service, or the deploy predates it | R2, then redeploy |
| Health: `storageReady: false` | one of `NAS_WEBDAV_URL` / `USER` / `PASS` is missing — `storageError` names it | R3, R4 |
| `502 … the hostname did not resolve` | MagicDNS off, or the name is wrong | T2, T3 |
| `502 … nothing is listening` | WebDAV Server package stopped, or HTTPS/5006 not enabled | N3, N4 |
| `502 … no route to the host` | DSM firewall is not allowing 5006 on the Tailscale interface | the note in N4. **If the firewall is off and it still hangs, it is the row at the top of this table, not this one** |
| `502 … self-signed certificate` / `does not name this hostname` | the certificate question | R5 |
| `502 … refused the svc-showrunner credentials (401)` | password wrong, or the account lacks the **WebDAV Server** application permission | N5, R4 |
| `502 … refused to create … (404)` | the share is not named `showrunner`, or the account has read-only on it | N6 |
| `507 … out of space` | the share is full | free space on the NAS |
| Uploads work, downloads 404 | somebody moved or renamed files on the NAS by hand | the DB holds `nas_path`; move them back or fix the row |
| It all worked and stopped ~6 months later | the NAS's node key expired | **T3, step 2** |
| It all worked and the next *deploy* could not join | the 90-day auth key expired | rotate: T4 → R2 → redeploy |

Two error codes, one distinction worth remembering:

- **501** — *there is no NAS configured.* A deployment decision. Naming the
  missing variable is the whole message.
- **502** — *there is a NAS and it did not answer.* An operational event.
  Nothing was lost, the record is intact, and the bytes can be re-sent.

---

## §8 · After it works

- **Move to a real certificate** (R5 option a) if you started on (c).
- **Calendar: day 80** — rotate the Tailscale auth key.
- **Confirm key expiry is disabled on the NAS node** (T3, step 2). It is the
  single most likely thing to break this in six months and the hardest to
  diagnose from inside the app.
- **Delete `RAILWAY_ENV.txt`** from anywhere it has been pasted. It is
  gitignored, but it is a file full of secrets.
- **Re-run the suite** against the deployed database if you want the byte routes
  covered end-to-end there too:

  ```bash
  DATABASE_URL=<a scratch database, never production> node scripts/storage-test.js
  ```

  It never touches the real NAS — it stands up its own WebDAV server — so it is
  safe to run any time.
