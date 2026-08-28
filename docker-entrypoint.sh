#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════
# docker-entrypoint.sh — join the tailnet (if asked to), then run Showrunner
# ───────────────────────────────────────────────────────────────────────────────
# THE ONE RULE: with TAILSCALE_AUTHKEY unset this script is a no-op wrapper. It
# execs the app and the container behaves exactly as it did before there was a
# Dockerfile. Everything below is gated on that one variable being present.
#
# Userspace networking, not a TUN device: Railway containers do not get
# CAP_NET_ADMIN or /dev/net/tun, so `--tun=userspace-networking` is the only
# mode that works. Tailnet traffic is therefore not on any network interface —
# it is reachable only through the local proxy on 1055, which serves BOTH SOCKS5
# and HTTP CONNECT on the same port. lib/storage.js dials the NAS through it,
# and through it ONLY: no other outbound request in this app is proxied.
#
# DNS: the NAS is addressed by its MagicDNS name, and the container's resolver
# knows nothing about the tailnet. That is fine — lib/storage.js always sends
# the hostname to the proxy (SOCKS5 ATYP=domain) so tailscaled resolves it
# inside the tailnet. Do not "fix" this by resolving the name locally first.
#
# FAILURE POLICY: if the tailnet does not come up, the app still boots by
# default. Showrunner is a project-management app first — schedules, budgets,
# notes, POs and the whole agent surface work with no NAS at all, and byte
# operations report their own honest 502. Taking the entire app down because a
# file server is unreachable would be the wrong trade. Set TAILSCALE_REQUIRED=1
# to invert that and fail the deploy instead.
# ═══════════════════════════════════════════════════════════════════════════════
set -eu

TS_SOCKS_PORT="${TAILSCALE_SOCKS_PORT:-1055}"
TS_HOSTNAME="${TAILSCALE_HOSTNAME:-showrunner}"
TS_STATE="${TAILSCALE_STATE:-/var/lib/tailscale/tailscaled.state}"
TS_UP_TIMEOUT="${TAILSCALE_UP_TIMEOUT:-45}"

log() { echo "[entrypoint] $*"; }

fail_or_warn() {
  if [ "${TAILSCALE_REQUIRED:-0}" = "1" ]; then
    log "FATAL: $* (TAILSCALE_REQUIRED=1)"
    exit 1
  fi
  log "WARNING: $*"
  log "WARNING: the app will start anyway — NAS byte operations will answer 502"
  log "WARNING: and /api/health will show storageVia. Set TAILSCALE_REQUIRED=1 to"
  log "WARNING: make this a hard deploy failure instead."
}

# ── THE TWO KNOBS THAT CHANGE HOW PACKETS CROSS ────────────────────────────────
# Added 2026-08-28, when POST /api/admin/storage-probe proved that this container
# can open a TCP connection to the NAS, exchange small messages with it in 50ms,
# and never receive a reply that needs more than one packet. Same port, same
# second: a TLS handshake whose answer is a 7-byte alert arrives; one whose
# answer is a certificate chain does not.
#
# Neither knob is a fix for that — the fault is on the far side — but each one
# changes the path the NAS's packets take to get here, and either could route
# around it. They are FLAGS, not defaults, so the shape of a normal deploy is
# unchanged and turning one on is a decision somebody made on purpose.
#
#   TAILSCALE_FORCE_DERP=1  all traffic over Tailscale's relays instead of the
#                           direct UDP path. If the direct path is what mangles
#                           multi-packet replies, this steps around it — at the
#                           cost of relay latency on every byte.
#   TAILSCALE_MTU=<n>       the tunnel MTU, which sets the MSS we advertise and
#                           therefore how the NAS's TCP stack cuts up what it
#                           sends us. Tailscale's default is 1280.
#
# Both are tailscale's own debug knobs, spelled the way tailscale spells them.
if [ "${TAILSCALE_FORCE_DERP:-0}" = "1" ]; then
  export TS_DEBUG_ALWAYS_USE_DERP=1
  log "TAILSCALE_FORCE_DERP=1 — every packet goes via a DERP relay, no direct path"
fi
if [ -n "${TAILSCALE_MTU:-}" ]; then
  export TS_DEBUG_MTU="${TAILSCALE_MTU}"
  log "TAILSCALE_MTU=${TAILSCALE_MTU} — tunnel MTU overridden (tailscale's default is 1280)"
fi

if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  log "TAILSCALE_AUTHKEY is set — bringing up tailscaled (userspace networking)"
  mkdir -p /var/run/tailscale /var/lib/tailscale

  /usr/local/bin/tailscaled \
    --state="$TS_STATE" \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking \
    --socks5-server="localhost:${TS_SOCKS_PORT}" \
    --outbound-http-proxy-listen="localhost:${TS_SOCKS_PORT}" &
  TS_PID=$!

  # Wait for the daemon's socket rather than sleeping a guessed number of
  # seconds — a fixed sleep is either too short on a cold start or wasted on
  # every warm one.
  i=0
  while [ ! -S /var/run/tailscale/tailscaled.sock ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then break; fi           # 100 x 0.1s = 10s
    if ! kill -0 "$TS_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done

  if [ ! -S /var/run/tailscale/tailscaled.sock ]; then
    fail_or_warn "tailscaled did not create its socket"
  else
    # --reset so a stale state file from a warm restart cannot pin an old
    # hostname or an old set of flags. Railway's disk is ephemeral anyway, but
    # this makes the behaviour the same on a machine where it is not.
    if /usr/local/bin/tailscale up \
        --authkey="${TAILSCALE_AUTHKEY}" \
        --hostname="${TS_HOSTNAME}" \
        --accept-dns=true \
        --reset \
        --timeout="${TS_UP_TIMEOUT}s"; then
      log "tailscale up OK as '${TS_HOSTNAME}'"
      /usr/local/bin/tailscale status || true
      log "tailnet IPv4: $(/usr/local/bin/tailscale ip -4 2>/dev/null || echo '(none)')"
      log "SOCKS5 + HTTP proxy listening on localhost:${TS_SOCKS_PORT}"
    else
      fail_or_warn "tailscale up failed — check that the auth key is valid, REUSABLE, and not expired"
    fi
  fi
else
  log "TAILSCALE_AUTHKEY is not set — no tailnet, normal networking"
  log "(STORAGE_DRIVER=webdav will still work if the NAS is reachable directly)"
fi

log "starting: $*"
exec "$@"
