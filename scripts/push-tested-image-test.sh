#!/usr/bin/env bash
# Proves push-tested-image.sh ignores a bare local RepoDigests entry that
# sorts first, requires every pushed tag to report the same digest, and
# pulls <remote-repo>@<digest>.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tested_id="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
good="sha256:597f6d47aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
other="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
remote="ghcr.io/example/fathom"

write_stub() {
  local map="$1"
  python3 - "$work/docker" "$map" <<'PY'
import sys
path, raw = sys.argv[1:]
pairs = []
for line in raw.splitlines():
    if not line.strip():
        continue
    tag, digest = line.split(" ", 1)
    pairs.append((tag, digest))
body = """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$DOCKER_LOG"
declare -A PUSH_DIGESTS=(
"""
for tag, digest in pairs:
    body += f"  [{tag!r}]={digest!r}\n"
body += r"""
)
if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then
  ref="${3:-}"
  format="${5:-}"
  case "$format" in
    '{{.Id}}')
      if [ "$ref" = "$LOCAL_IMAGE" ] || [ "$ref" = "$EXPECT_PULL" ]; then
        printf '%s\n' "$TESTED_ID"
      else
        printf '%s\n' "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      fi
      ;;
    '{{range .RepoDigests}}{{println .}}{{end}}')
      printf '%s\n' "$REPO_DIGESTS"
      ;;
    *)
      echo "stub docker: unexpected inspect format ${format}" >&2
      exit 1
      ;;
  esac
  exit 0
fi
if [ "${1:-}" = "push" ]; then
  tag="${2:-}"
  if [ -z "${PUSH_DIGESTS[$tag]:-}" ]; then
    echo "stub docker: no digest for ${tag}" >&2
    exit 1
  fi
  printf '%s: digest: %s size: 1\n' "$tag" "${PUSH_DIGESTS[$tag]}"
  exit 0
fi
if [ "${1:-}" = "tag" ] || [ "${1:-}" = "pull" ]; then
  exit 0
fi
echo "stub docker: unexpected $*" >&2
exit 1
"""
open(path, "w").write(body)
PY
  chmod +x "$work/docker"
}

run_script() {
  local name="$1"
  shift
  : >"$work/${name}.log"
  set +e
  env PATH="$work:$PATH" \
    DOCKER_LOG="$work/${name}.log" \
    LOCAL_IMAGE="fathom:ci" \
    TESTED_ID="$tested_id" \
    EXPECT_PULL="${remote}@${good}" \
    REPO_DIGESTS="$REPO_DIGESTS" \
    "$root/scripts/push-tested-image.sh" "$@" >"$work/${name}.out" 2>"$work/${name}.err"
  status=$?
  set -e
}

python3 - <<PY
good = "${good}"
other = "${other}"
assert len(good) == len("sha256:") + 64
assert len(other) == len("sha256:") + 64
PY

REPO_DIGESTS="$(printf '%s\n' "fathom@${other}" "${remote}@${good}")"
write_stub "${remote}:sha-abc ${good}
${remote}:main ${good}"
run_script ok fathom:ci "${remote}:sha-abc" "${remote}:main"
if [ "$status" -ne 0 ]; then
  echo "push-tested-image-test: shared digest was rejected" >&2
  cat "$work/ok.err" >&2
  exit 1
fi
grep -q "pull ${remote}@${good}" "$work/ok.log"
if grep -q "pull fathom@" "$work/ok.log"; then
  echo "push-tested-image-test: pulled the bare local name" >&2
  exit 1
fi
python3 - "$work/ok.log" "${remote}:sha-abc" "${remote}:main" <<'PY'
import sys
log, a, b = sys.argv[1:]
lines = open(log).read().splitlines()
ia = next(i for i, line in enumerate(lines) if line.startswith("push ") and a in line)
ib = next(i for i, line in enumerate(lines) if line.startswith("push ") and b in line)
ip = next(i for i, line in enumerate(lines) if line.startswith("pull "))
if not (ia < ip and ib < ip):
    raise SystemExit("pushes did not both finish before pull")
PY

write_stub "${remote}:sha-abc ${good}
${remote}:main ${other}"
run_script diverge fathom:ci "${remote}:sha-abc" "${remote}:main"
if [ "$status" -eq 0 ]; then
  echo "push-tested-image-test: divergent digests were accepted" >&2
  exit 1
fi
grep -q "different digests" "$work/diverge.err"
if grep -q "^pull " "$work/diverge.log"; then
  echo "push-tested-image-test: pulled after divergent digests" >&2
  exit 1
fi

REPO_DIGESTS="fathom@${other}"
write_stub "${remote}:main ${good}"
run_script bare fathom:ci "${remote}:main"
if [ "$status" -eq 0 ]; then
  echo "push-tested-image-test: bare-only RepoDigests was accepted" >&2
  exit 1
fi
grep -q "no repo digest" "$work/bare.err"
if grep -q "^pull " "$work/bare.log"; then
  echo "push-tested-image-test: pulled without a remote digest" >&2
  exit 1
fi

grep -q 'scripts/push-tested-image.sh' "$root/.github/workflows/release.yml"
grep -q 'scripts/push-tested-image.sh' "$root/.github/workflows/containers.yml"

echo "push-tested-image-test: ok"
