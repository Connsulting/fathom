#!/usr/bin/env bash
# Publish the mock to a stable directory and serve it tailnet-only with `tailscale serve`.
# Usage: tools/deploy.sh [port] [target_dir]
# The private scenario (mock-v2/private/) is copied if present. Never use Funnel.
set -euo pipefail
port="${1:-8771}"
target="${2:-$HOME/.local/share/fathom-mock-v2/site}"
here="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$target"
rsync -a --delete --exclude tools --exclude CONTRACT.md "$here/" "$target/"
chmod -R a+rX "$target"

if ! tailscale serve status 2>/dev/null | grep -q ":${port} "; then
  tailscale serve --bg --https="$port" "$target"
fi
tailscale serve status | grep -A1 ":${port} " || true
