#!/usr/bin/env bash
# Push tags of an image that was already built and smoked. Does not rebuild.
# Fails unless the registry digest resolves to the same image id.
# Usage: scripts/push-tested-image.sh <local-image> <remote-tag> [remote-tag...]
set -euo pipefail

local_image="${1:?usage: scripts/push-tested-image.sh <local-image> <remote-tag> [remote-tag...]}"
shift
if [ "$#" -lt 1 ]; then
  echo "push-tested-image: at least one remote tag is required" >&2
  exit 1
fi

tested="$(timeout --foreground 20 docker image inspect "$local_image" --format '{{.Id}}')"
for tag in "$@"; do
  timeout --foreground 20 docker tag "$local_image" "$tag"
  timeout --foreground 300 docker push "$tag"
done

digest="$(timeout --foreground 20 docker image inspect "$local_image" --format '{{index .RepoDigests 0}}')"
if [ -z "$digest" ] || [ "$digest" = "<no value>" ]; then
  echo "push-tested-image: ${local_image} has no repo digest after push" >&2
  exit 1
fi

timeout --foreground 300 docker pull "$digest" >/dev/null
pulled="$(timeout --foreground 20 docker image inspect "$digest" --format '{{.Id}}')"
if [ "$pulled" != "$tested" ]; then
  echo "push-tested-image: pulled ${pulled} does not match tested ${tested}" >&2
  exit 1
fi
echo "push-tested-image: ${digest} matches tested ${tested}"
