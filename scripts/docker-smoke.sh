#!/usr/bin/env bash
# AC7 receipt: build the image, run it with a named volume, wait for health, check it runs as a
# non-root user and serves the demo scenario, then run the @smoke e2e subset against it.
# Uses the docker CLI exactly as the caller configured it. Published ports must be reachable on
# 127.0.0.1 from where this script runs. Always removes what it created.
set -euo pipefail

cd "$(dirname "$0")/.."

suffix="$(date +%Y%m%d%H%M%S)-${RANDOM}${RANDOM}"
image="fathom-smoke:${suffix}"
name="fathom-smoke-${suffix}"
volume="fathom-smoke-${suffix}"
built=""
volume_made=""
started=""

cleanup() {
  status=$?
  if [ -n "$started" ]; then
    if [ "$status" -ne 0 ]; then
      echo "docker-smoke: container log follows"
      docker logs --tail 50 "$name" 2>&1 || true
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
  if [ -n "$volume_made" ]; then docker volume rm -f "$volume" >/dev/null 2>&1 || true; fi
  if [ -n "$built" ]; then docker image rm "$image" >/dev/null 2>&1 || true; fi
  echo "docker-smoke: cleaned up"
  exit "$status"
}
trap cleanup EXIT

echo "docker-smoke: building ${image}"
built=1
docker build -t "$image" .

echo "docker-smoke: creating volume ${volume}"
volume_made=1
docker volume create "$volume" >/dev/null

port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')"
base="http://127.0.0.1:${port}"

echo "docker-smoke: starting ${name} on port ${port}"
started=1
docker run -d --name "$name" -p "${port}:8080" -v "${volume}:/data" "$image" >/dev/null

echo "docker-smoke: waiting up to 90s for health"
healthy=""
deadline=$((SECONDS + 90))
while [ "$SECONDS" -lt "$deadline" ]; do
  running="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    echo "docker-smoke: container is not running" >&2
    exit 1
  fi
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  if [ "$health" = "none" ]; then
    echo "docker-smoke: image has no HEALTHCHECK" >&2
    exit 1
  fi
  if [ "$health" = "healthy" ] && curl -fsS "${base}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ -z "$healthy" ]; then
  echo "docker-smoke: not healthy after 90s (last status ${health:-unknown})" >&2
  exit 1
fi
echo "docker-smoke: healthy"

uid="$(docker exec "$name" id -u | tr -d '[:space:]')"
if [ -z "$uid" ] || [ "$uid" = "0" ]; then
  echo "docker-smoke: container runs as root (uid ${uid:-unknown})" >&2
  exit 1
fi
echo "docker-smoke: runs as uid ${uid}"

curl -fsS "${base}/api/scenario" | node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const s = JSON.parse(raw);
  if (!Array.isArray(s.recs) || s.recs.length === 0) {
    console.error("docker-smoke: /api/scenario has no recs");
    process.exit(1);
  }
  console.log(`docker-smoke: /api/scenario has ${s.recs.length} recs`);
});'

echo "docker-smoke: running the smoke subset against ${base}"
BASE_URL="$base" npm run e2e:smoke

echo "docker-smoke: ok"
