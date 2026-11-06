#!/usr/bin/env bash
# Proves the range helper rejects an empty range, and that gitleaks -m catches a
# secret that exists only in a merge resolution.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
gitleaks="${GITLEAKS:-gitleaks}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
git init -q -b main
git config user.email test@example.invalid
git config user.name test
echo base > file.txt
git add file.txt
git commit -qm base
base="$(git rev-parse HEAD)"

# Empty range must fail.
if EVENT_NAME=pull_request BASE_SHA="$base" HEAD_SHA="$base" BEFORE= PUSH_SHA= \
  "$root/scripts/gitleaks-range.sh" >/dev/null 2>"$work/empty.err"; then
  echo "gitleaks-range-test: empty range was accepted" >&2
  exit 1
fi
grep -q "no commits" "$work/empty.err"

# Secret only in the merge resolution, not in either parent.
git checkout -q -b left
echo left > file.txt
git add file.txt
git commit -qm left
left="$(git rev-parse HEAD)"

git checkout -q -b right "$base"
echo right > file.txt
git add file.txt
git commit -qm right

git checkout -q left
git merge -q --no-commit right || true
# Built at runtime so the committed test script has no detectable literal.
token="$(python3 -c 'import os; print("am_" + "synthetic_" + os.urandom(6).hex())')"
printf '%s\n' "const KEY = '${token}';" > file.txt
git add file.txt
git commit -qm merge
head="$(git rev-parse HEAD)"

opts="$(EVENT_NAME=pull_request BASE_SHA="$base" HEAD_SHA="$head" BEFORE= PUSH_SHA= \
  "$root/scripts/gitleaks-range.sh")"
case "$opts" in
  "-m ${base}..${head}") ;;
  *) echo "gitleaks-range-test: unexpected opts ${opts}" >&2; exit 1 ;;
esac

if "$gitleaks" detect --source . --no-banner --redact --exit-code 1 --log-opts="${left}..${head}" >/dev/null 2>&1; then
  :
else
  echo "gitleaks-range-test: secret was visible without -m, so the fixture is wrong" >&2
  exit 1
fi

if "$gitleaks" detect --source . --no-banner --redact --exit-code 1 --log-opts="$opts" >/dev/null 2>&1; then
  echo "gitleaks-range-test: -m did not report the merge secret" >&2
  exit 1
fi

zeros=0000000000000000000000000000000000000000
if EVENT_NAME=push BEFORE="$zeros" PUSH_SHA="$head" BASE_SHA= HEAD_SHA= \
  "$root/scripts/gitleaks-range.sh" >/dev/null 2>"$work/zero.err"; then
  echo "gitleaks-range-test: all-zero before was accepted with no baseline" >&2
  exit 1
fi
grep -q "needs a baseline" "$work/zero.err"

echo "gitleaks-range-test: ok"
