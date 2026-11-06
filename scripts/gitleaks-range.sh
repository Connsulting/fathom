#!/usr/bin/env bash
# Print one gitleaks --log-opts string for this GitHub event.
# The string starts with -m so merge commits are diffed.
# Exits non-zero when an endpoint is missing or the range has no commits.
# Env: EVENT_NAME, BASE_SHA, HEAD_SHA, BEFORE, PUSH_SHA.
set -euo pipefail

zeros=0000000000000000000000000000000000000000

have() {
  git cat-file -e "$1^{commit}" >/dev/null 2>&1
}

# rev-list proves the range. gitleaks itself exits 0 on an invalid range.
emit() {
  local range="$1"
  local count
  if ! count="$(git rev-list --count "$range")"; then
    echo "gitleaks: cannot resolve range ${range}" >&2
    exit 1
  fi
  if [ "$count" -eq 0 ]; then
    echo "gitleaks: range ${range} contains no commits" >&2
    exit 1
  fi
  echo "gitleaks: ${count} commits in ${range}" >&2
  printf '%s\n' "-m ${range}"
}

if [ "${EVENT_NAME}" = "pull_request" ]; then
  have "${BASE_SHA}" || { echo "gitleaks: missing base ${BASE_SHA}" >&2; exit 1; }
  have "${HEAD_SHA}" || { echo "gitleaks: missing head ${HEAD_SHA}" >&2; exit 1; }
  emit "${BASE_SHA}..${HEAD_SHA}"
  exit 0
fi

have "${PUSH_SHA}" || { echo "gitleaks: missing pushed sha ${PUSH_SHA}" >&2; exit 1; }

if [ -z "${BEFORE}" ] || [ "${BEFORE}" = "$zeros" ]; then
  # No previous tip. Scan only what this push adds on top of origin/main.
  # An initial main push has no such range, so fail instead of scanning history.
  if have "origin/main"; then
    base="$(git merge-base origin/main "${PUSH_SHA}" 2>/dev/null || true)"
    if [ -n "${base}" ] && [ "${base}" != "${PUSH_SHA}" ]; then
      echo "gitleaks: before is unset; using merge-base ${base}" >&2
      emit "${base}..${PUSH_SHA}"
      exit 0
    fi
  fi
  echo "gitleaks: an initial main push needs a baseline" >&2
  exit 1
fi

if ! have "${BEFORE}"; then
  git fetch --no-tags origin "${BEFORE}" >/dev/null 2>&1 || true
fi

if have "${BEFORE}"; then
  emit "${BEFORE}..${PUSH_SHA}"
  exit 0
fi

# The old tip is gone (a force push GitHub no longer serves). Use a range we can
# prove. If origin/main is already this push, the merge-base range is empty and
# we fail instead of scanning nothing.
if have "origin/main"; then
  base="$(git merge-base origin/main "${PUSH_SHA}" 2>/dev/null || true)"
  if [ -n "${base}" ] && [ "${base}" != "${PUSH_SHA}" ]; then
    echo "gitleaks: before ${BEFORE} is unreachable; using merge-base ${base}" >&2
    emit "${base}..${PUSH_SHA}"
    exit 0
  fi
fi

echo "gitleaks: before ${BEFORE} is unreachable and no non-empty push range can be proved" >&2
exit 1
