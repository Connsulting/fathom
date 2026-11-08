# Fathom: one container serving the UI and the JSON API, data on a volume at /data.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY web ./web
COPY demo ./demo
COPY packs ./packs
COPY scripts ./scripts
COPY evals ./evals

RUN mkdir -p /data /app/evals/out && chown node:node /data /app/evals/out

# The git SHA of the build, reported as the MCP server version. Placed last so a new SHA reuses every layer above.
ARG FATHOM_BUILD_SHA=
ENV FATHOM_BUILD_SHA=$FATHOM_BUILD_SHA

ENV FATHOM_DATA=/data \
    FATHOM_PORT=8080 \
    FATHOM_HOST=0.0.0.0

USER 1000:1000
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.FATHOM_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/server.mjs"]
