#!/usr/bin/env bash
# Push tags of an image that was already built and smoked. Does not rebuild.
# Fails unless every pushed tag reports the same registry digest and that
# digest is listed for the remote repository, not a bare local name.
# Usage: scripts/push-tested-image.sh <local-image> <remote-tag> [remote-tag...]
set -euo pipefail

local_image="${1:?usage: scripts/push-tested-image.sh <local-image> <remote-tag> [remote-tag...]}"
shift
if [ "$#" -lt 1 ]; then
  echo "push-tested-image: at least one remote tag is required" >&2
  exit 1
fi

repo_of() {
  local ref="$1"
  if [[ "$ref" == */*:* ]]; then
    printf '%s\n' "${ref%:*}"
  else
    printf '%s\n' "${ref%%:*}"
  fi
}

digest_from_push() {
  python3 -c 'import re,sys; found=re.findall(r"digest:\s*(sha256:[0-9a-f]{64})", sys.stdin.read()); print(found[-1] if found else "")'
}

tested="$(timeout --foreground 20 docker image inspect "$local_image" --format '{{.Id}}')"
repo=""
digest=""
for tag in "$@"; do
  this_repo="$(repo_of "$tag")"
  if [ -n "$repo" ] && [ "$this_repo" != "$repo" ]; then
    echo "push-tested-image: remote tags must share one repository" >&2
    exit 1
  fi
  repo="$this_repo"
  timeout --foreground 20 docker tag "$local_image" "$tag"
  # Docker prints the digest line on stdout or stderr depending on version.
  push_out="$(timeout --foreground 300 docker push "$tag" 2>&1)"
  this_digest="$(printf '%s\n' "$push_out" | digest_from_push)"
  if [ -z "$this_digest" ]; then
    echo "push-tested-image: ${tag} push did not report a digest" >&2
    exit 1
  fi
  if [ -n "$digest" ] && [ "$this_digest" != "$digest" ]; then
    echo "push-tested-image: pushed tags resolved to different digests" >&2
    exit 1
  fi
  digest="$this_digest"
done

matched=""
while IFS= read -r entry; do
  if [ "$entry" = "${repo}@${digest}" ]; then
    matched="$entry"
  fi
done < <(timeout --foreground 20 docker image inspect "$local_image" --format '{{range .RepoDigests}}{{println .}}{{end}}')

if [ -z "$matched" ]; then
  echo "push-tested-image: no repo digest for ${repo}@${digest}" >&2
  exit 1
fi

timeout --foreground 300 docker pull "$matched" >/dev/null
pulled="$(timeout --foreground 20 docker image inspect "$matched" --format '{{.Id}}')"
if [ "$pulled" != "$tested" ]; then
  echo "push-tested-image: pulled ${pulled} does not match tested ${tested}" >&2
  exit 1
fi
echo "push-tested-image: ${matched} matches tested ${tested}"
