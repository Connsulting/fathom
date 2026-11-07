# Harness for smoke against an app container on a Docker endpoint whose published
# ports are not reachable from the caller. The build context is a directory that
# contains checkout/ (a git archive of the tracked tree). PLAYWRIGHT_VERSION is
# the @playwright/test version from package-lock.json, passed by the script.
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

WORKDIR /app
COPY checkout/ ./
RUN npm ci
ENV CI=1
ENTRYPOINT ["npx", "playwright", "test"]
