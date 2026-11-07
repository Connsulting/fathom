#!/usr/bin/env bash
# Smoke an already-built app image when published ports are not reachable on
# 127.0.0.1 from this process. Uses the docker CLI exactly as the caller
# configured it. Joins the app container's network namespace and points
# Playwright at http://127.0.0.1:8080. Removes every container, volume, image
# and temp dir this script created. Does not remove the app image.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: scripts/remote-smoke.sh <app-image>" >&2
  exit 2
fi
app_image="$1"

suffix="$(date +%Y%m%d%H%M%S)-${RANDOM}${RANDOM}"
app_name="fathom-remote-smoke-${suffix}"
volume="fathom-remote-smoke-${suffix}"
harness_image="fathom-remote-smoke-harness:${suffix}"
harness_name="fathom-remote-smoke-harness-${suffix}"
tmpdir=""
volume_made=""
app_started=""
harness_built=""
harness_started=""

cleanup() {
  status=$?
  left=""
  if [ -n "$app_started" ] && [ "$status" -ne 0 ]; then
    echo "remote-smoke: app log follows"
    docker logs --tail 50 "$app_name" 2>&1 || true
  fi
  if [ -n "$harness_started" ]; then
    if ! docker rm -f "$harness_name" >/dev/null 2>&1; then
      left="${left} container ${harness_name}"
    fi
  fi
  if [ -n "$app_started" ]; then
    if ! docker rm -f "$app_name" >/dev/null 2>&1; then
      left="${left} container ${app_name}"
    fi
  fi
  if [ -n "$volume_made" ]; then
    if ! docker volume rm -f "$volume" >/dev/null 2>&1; then
      left="${left} volume ${volume}"
    fi
  fi
  if [ -n "$harness_built" ]; then
    if ! docker image rm "$harness_image" >/dev/null 2>&1; then
      left="${left} image ${harness_image}"
    fi
  fi
  if [ -n "$tmpdir" ]; then
    if ! rm -rf "$tmpdir"; then
      left="${left} temp ${tmpdir}"
    fi
  fi
  if [ -n "$left" ]; then
    echo "remote-smoke: still present:${left}" >&2
    if [ "$status" -eq 0 ]; then
      status=1
    fi
  else
    echo "remote-smoke: cleaned up"
  fi
  if [ "$status" -eq 0 ]; then
    echo "remote-smoke: pass"
  else
    echo "remote-smoke: fail"
  fi
  exit "$status"
}
trap cleanup EXIT

if ! docker image inspect "$app_image" >/dev/null 2>&1; then
  echo "remote-smoke: image not found: ${app_image}" >&2
  exit 1
fi

echo "remote-smoke: creating volume ${volume}"
volume_made=1
docker volume create "$volume" >/dev/null

echo "remote-smoke: starting ${app_name}"
app_started=1
docker run -d --name "$app_name" -v "${volume}:/data" "$app_image" >/dev/null

echo "remote-smoke: waiting up to 90s for /healthz"
healthy=""
health_deadline=$((SECONDS + 90))
while [ "$SECONDS" -lt "$health_deadline" ]; do
  running="$(docker inspect -f '{{.State.Running}}' "$app_name" 2>/dev/null || echo false)"
  if [ "$running" != "true" ]; then
    echo "remote-smoke: container is not running" >&2
    exit 1
  fi
  if docker exec "$app_name" node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ -z "$healthy" ]; then
  echo "remote-smoke: /healthz did not succeed within 90s" >&2
  exit 1
fi
echo "remote-smoke: healthy"

uid="$(docker exec "$app_name" id -u | tr -d '[:space:]')"
if [ "$uid" != "1000" ]; then
  echo "remote-smoke: expected uid 1000, got ${uid:-unknown}" >&2
  exit 1
fi
echo "remote-smoke: runs as uid ${uid}"

tmpdir="$(mktemp -d)"
mkdir -p "${tmpdir}/checkout"
git archive HEAD | tar -x -C "${tmpdir}/checkout"
archive="${tmpdir}/checkout"

pw_version="$(node -e 'const lock=require(process.argv[1]); const pkg=lock.packages && lock.packages["node_modules/@playwright/test"]; if (!pkg || !pkg.version) { process.exit(1); } process.stdout.write(pkg.version);' "${archive}/package-lock.json")"
case "$pw_version" in
  *[!0-9.]*)
    echo "remote-smoke: refusing playwright version ${pw_version}" >&2
    exit 1
    ;;
esac
echo "remote-smoke: playwright ${pw_version}"

echo "remote-smoke: building harness ${harness_image}"
harness_built=1
docker build \
  -f "${archive}/e2e/smoke.Dockerfile" \
  --build-arg "PLAYWRIGHT_VERSION=${pw_version}" \
  -t "$harness_image" \
  "$tmpdir"

echo "remote-smoke: running @smoke against http://127.0.0.1:8080"
harness_started=1
docker run --name "$harness_name" \
  --network "container:${app_name}" \
  -e BASE_URL=http://127.0.0.1:8080 \
  -e CI=1 \
  "$harness_image" --grep @smoke

echo "remote-smoke: smoke subset passed"
