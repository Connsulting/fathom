# Releasing

Images on `main` are untagged builds. A versioned release is a git tag pushed after the version
in `package.json` matches that tag.

## Steps

1. Open a pull request that sets `version` in `package.json` and the root package in
   `package-lock.json` to the new semver (for example `0.1.0`).
2. Merge that pull request to `main`.
3. On `main`, create and push the matching tag: `git tag v0.1.0 && git push origin v0.1.0`.
   The tag is `v` plus the version in `package.json`. The tag workflow fails if they differ.

## What gets published

Every pull request builds the container and does not push it. The image is started and `/healthz`
must answer before the job succeeds.

Every push to `main` pushes `ghcr.io/connsulting/fathom` with tags `sha-<short sha>` and `main`.
Those builds do not get a version tag or `latest`.

A tag `vX.Y.Z` (for example `v0.1.0`) runs the same unit tests and Playwright suite as CI, then
pushes the image with tags `X.Y.Z`, `X.Y` and `latest`, then opens a GitHub Release with
generated notes. A failing test, health check or version check publishes nothing.

Secret scanning in CI covers the pull request range (`base..head`) and, on `main`, the pushed
range. A one-time full-history scan found only a synthetic email fixture, since removed. CI does
not scan full history and does not allowlist findings.
