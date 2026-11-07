#!/usr/bin/env bash
# Runs the Chrome-based fetcher on the machine that actually has the browser
# profile (the laptop, 10.6.0.7 tailscale). PocketBase (the store/UI) lives on the hub
# 10.0.0.1, which has no browser and no node, so its cron/refresh hooks call
# this script over ssh instead of spawning node locally.
#
# Env overrides: FETCH_HOST, FETCH_MJS, PB_URL, FETCH_KEY, FETCH_PROXY.
set -euo pipefail
HOST="${FETCH_HOST:-uzqw@10.6.0.7}"
FE="${FETCH_MJS:-/home/uzqw/wp/pi-usage-web/fetcher/fetch.mjs}"
PB_URL="${PB_URL:-http://10.0.0.1:8099}"
KEY="${FETCH_KEY:-$HOME/.ssh/id_pi_usage}"
SSH=(ssh -n -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -p 22)

# Outbound provider fetches go through this proxy (mihomo on 10.0.0.4); the
# hub/laptop LAN has no direct route. Set FETCH_PROXY="" to disable.
# Node's env-proxy does NOT honor CIDR entries in NO_PROXY (verified on 26.x:
# 10.0.0.0/8 still goes via mihomo), so list the PB host explicitly — otherwise
# the snapshot POST is proxied and mihomo answers 502, and nothing ever updates.
PROXY="${FETCH_PROXY-http://10.0.0.4:7890}"
PB_HOST="${PB_URL#*://}"; PB_HOST="${PB_HOST%%[:/]*}"
PROXY_ENV=""
[ -n "$PROXY" ] && PROXY_ENV="NODE_USE_ENV_PROXY=1 HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY NO_PROXY=localhost,127.0.0.1,$PB_HOST"

case "${1:-start}" in
  pgrep) "${SSH[@]}" "$HOST" "pgrep -f 'node .*fetch\.mjs'" >/dev/null ;;
  pkill) "${SSH[@]}" "$HOST" "pkill -f 'node .*fetch\.mjs'" >/dev/null 2>&1 || true ;;
  # </dev/null keeps the remote background child from holding the ssh channel
  # open, so this returns immediately instead of blocking for the whole round.
  start) "${SSH[@]}" "$HOST" "PB_URL=$PB_URL $PROXY_ENV nohup node $FE --once >>/tmp/codexbar-fetch.log 2>&1 </dev/null &" ;;
  *) echo "usage: $0 {pgrep|pkill|start}" >&2; exit 2 ;;
esac
