#!/usr/bin/env bash
# Start an already-built image, poll /healthz, then remove the container.
# Usage: scripts/docker-healthz.sh <image>
# Does not build or delete the image. Published ports must be reachable on 127.0.0.1.
set -euo pipefail

image="${1:?usage: scripts/docker-healthz.sh <image>}"
suffix="$(date +%Y%m%d%H%M%S)-${RANDOM}${RANDOM}"
name="fathom-healthz-${suffix}"
started=""

cleanup() {
  status=$?
  if [ -n "$started" ]; then
    if [ "$status" -ne 0 ]; then
      echo "docker-healthz: container log follows"
      timeout --foreground 15 docker logs --tail 50 "$name" 2>&1 || true
    fi
    timeout --foreground 20 docker rm -f "$name" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')"
base="http://127.0.0.1:${port}"

echo "docker-healthz: starting ${name} from ${image} on port ${port}"
started=1
timeout --foreground 30 docker run -d --name "$name" -p "127.0.0.1:${port}:8080" "$image" >/dev/null

echo "docker-healthz: waiting up to 90s for /healthz"
deadline=$((SECONDS + 90))
while [ "$SECONDS" -lt "$deadline" ]; do
  running="$(timeout --foreground 10 docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    echo "docker-healthz: container is not running" >&2
    exit 1
  fi
  remaining=$((deadline - SECONDS))
  if [ "$remaining" -lt 1 ]; then
    break
  fi
  max="$remaining"
  if [ "$max" -gt 5 ]; then
    max=5
  fi
  if curl --connect-timeout 2 --max-time "$max" -fsS "${base}/healthz" >/dev/null 2>&1; then
    echo "docker-healthz: healthy"
    exit 0
  fi
  remaining=$((deadline - SECONDS))
  if [ "$remaining" -gt 2 ]; then
    sleep 2
  elif [ "$remaining" -gt 0 ]; then
    sleep "$remaining"
  fi
done
echo "docker-healthz: /healthz not healthy after 90s" >&2
exit 1
