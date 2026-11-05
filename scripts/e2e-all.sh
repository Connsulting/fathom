#!/usr/bin/env bash
# AC8 receipt: the full e2e suite against the Playwright-managed demo servers, then the @smoke
# subset against a separately started server through BASE_URL.
set -euo pipefail

cd "$(dirname "$0")/.."

# The full run must use the local webServers, never a caller's target.
unset BASE_URL JAN_BASE_URL

echo "e2e-all: running the full suite"
npm run e2e

data_dir="$(mktemp -d)"
log_file="$(mktemp)"
server_pid=""

cleanup() {
  status=$?
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -s "$log_file" ]; then
    echo "e2e-all: server log follows"
    tail -n 50 "$log_file" || true
  fi
  rm -rf "$data_dir"
  rm -f "$log_file"
  exit "$status"
}
trap cleanup EXIT

port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')"
base="http://127.0.0.1:${port}"

echo "e2e-all: starting a demo server on port ${port} with a fresh data dir"
FATHOM_DATA="$data_dir" FATHOM_PORT="$port" FATHOM_DEMO=1 node src/server.mjs >"$log_file" 2>&1 &
server_pid=$!

ready=""
for _ in $(seq 1 60); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "e2e-all: server exited before it was healthy" >&2
    exit 1
  fi
  if curl -fsS "${base}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "e2e-all: server not healthy after 30s" >&2
  exit 1
fi

echo "e2e-all: running the smoke subset against ${base}"
BASE_URL="$base" npm run e2e:smoke

echo "e2e-all: ok"
