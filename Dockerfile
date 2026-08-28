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

# Documentation only — Railway injects PORT and the app reads it.
EXPOSE 3100

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
