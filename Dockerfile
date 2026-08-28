# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════════
# e360 Showrunner — the Railway image
# ───────────────────────────────────────────────────────────────────────────────
# WHY A DOCKERFILE AND NOT NIXPACKS (which is what this repo deployed with until
# the storage wiring):
#
#   Showrunner now has to reach a NAS that is on Tom's Tailscale tailnet and
#   nowhere else. That means a second daemon (`tailscaled`) inside the container,
#   started before the app, in userspace-networking mode. Nixpacks CAN be pushed
#   into that shape — a custom phase that curls the static tarball plus a start
#   script — but every part of it is implicit: the Node version is whatever
#   Nixpacks decides today, the tailscale version is whatever the phase happens
#   to fetch, and the start command lives in a TOML file that reads nothing like
#   the process tree it produces.
#
#   A Dockerfile makes all three explicit and pinned: this Node, this Tailscale,
#   this entrypoint. For an image whose job is to hold a credential and open a
#   tunnel into the office, "you can read exactly what is in it" is worth more
#   than the twenty lines it costs.
#
#   THE TRADE: Railway prefers a Dockerfile over Nixpacks the moment one exists
#   at the repo root, so adding this file CHANGES HOW EVERY DEPLOY IS BUILT, not
#   just the ones that use Tailscale. It also PINS what used to be implicit —
#   most importantly the Node major version. That is deliberate, and it is the
#   one thing to watch on the first deploy.
#
#   ROLLBACK: delete this file (and .dockerignore) and Railway falls straight
#   back to Nixpacks. Nothing else in the repo depends on it. `npm start` on a
#   laptop is untouched either way — this file is not in that path at all.
#
# INERT WITHOUT A KEY: with TAILSCALE_AUTHKEY unset, docker-entrypoint.sh does
# not start tailscaled at all and execs the app directly. The image then behaves
# exactly like the Nixpacks one.
# ═══════════════════════════════════════════════════════════════════════════════

# ── the tailscale binaries ─────────────────────────────────────────────────────
# Taken from Tailscale's own published image rather than curl|tar, so the version
# is pinned by a tag that Tailscale signs and Railway's builder caches.
# If this ever needs to be self-contained, the equivalent is:
#   ADD https://pkgs.tailscale.com/stable/tailscale_1.86.2_amd64.tgz /tmp/ts.tgz
#   RUN tar -xzf /tmp/ts.tgz --strip-components=1 -C /usr/local/bin \
#         tailscale_1.86.2_amd64/tailscaled tailscale_1.86.2_amd64/tailscale
FROM docker.io/tailscale/tailscale:v1.86.2 AS tailscale

# ── the app ────────────────────────────────────────────────────────────────────
# Pinned to Node 22 LTS. The app declares `engines: >=18` and uses nothing newer
# than built-in fetch; 22 is the current LTS and is what this pins in place of
# "whatever Nixpacks picked".
FROM node:22-bookworm-slim AS app

ENV NODE_ENV=production
WORKDIR /app

# ca-certificates: tailscaled needs a trust store to reach the coordination
# server. (Node ships its own bundle, so the app's own TLS does not depend on
# this — but a container with no CA store is a confusing failure mode.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale /usr/local/bin/tailscale  /usr/local/bin/tailscale

# tailscaled's socket and state directory. Railway's filesystem is EPHEMERAL, so
# the state here does not survive a redeploy — which is exactly why the auth key
# must be REUSABLE (WIRING_DAY.md §3). Every deploy joins the tailnet fresh.
RUN mkdir -p /var/run/tailscale /var/lib/tailscale

# Dependencies first, so a code-only change does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

COPY . .
RUN chmod +x /app/docker-entrypoint.sh

# ── WHY THIS CONTAINER RELAYS INSTEAD OF GOING DIRECT (2026-08-28) ─────────────
# THE ONE LINE THAT MAKES THE NAS REACHABLE. Without it, no byte has ever
# crossed this tunnel in either direction, and the failure is silent and total.
#
# What was measured, by POST /api/admin/storage-probe:
#   · the tunnel was never the problem. tailscaled comes up in 1ms, SOCKS5
#     CONNECT to the NAS returns success in 92ms, HTTP CONNECT through the same
#     port agrees, the peer is online, and `tailscale ping` pongs in ~50ms at
#     every size from 200 to 1400 bytes.
#   · over the DIRECT UDP path, the NAS could not deliver a reply that needed
#     more than one packet. The control that proved it: two TLS handshakes to
#     the same port in the same second, one offering no acceptable cipher (whose
#     answer is a 7-byte alert — ARRIVED) and one valid (whose answer is a 2-4 KB
#     certificate chain — NEVER ARRIVED). Nothing changed but the size of the
#     answer. Every WebDAV verb sat behind that, which is why the only symptom
#     the app could produce was "the NAS did not answer" at 30 seconds.
#   · with DERP forced, all nine probe steps pass: PROPFIND 207, MKCOL 201,
#     PUT 201, GET 200 byte-identical, DELETE 204, and the largest reply that
#     arrived whole went from 528 bytes to 12,130.
#
# `tailscale ping` stays green throughout because a disco ping is generated
# inside tailscaled and never touches the far side's TCP stack. That is exactly
# why "both machines show Connected" was true and useless.
#
# THE COST: every byte to the NAS goes through a Tailscale relay in Dallas
# instead of point to point. For this app that is a 364 KB spec every so often,
# and correct-and-slower beats fast-and-never.
#
# THIS IS A WORKAROUND, NOT A CURE. The fault is the far side — the NAS runs the
# DSM Tailscale package 1.58.2 on a 4.4 kernel, four years older than the client
# here. The cure is on Tom's hand: update that package, then delete this line
# and re-run the probe. If all nine steps still pass, the direct path is healed
# and the relay hop can go. Set TAILSCALE_FORCE_DERP=0 as a Railway variable to
# test that without a deploy — a variable of the same name overrides this.
ENV TAILSCALE_FORCE_DERP=1

# Documentation only — Railway injects PORT and the app reads it.
EXPOSE 3100

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
