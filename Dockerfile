# Fathom: one container serving the UI and the JSON API, data on a volume at /data.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY web ./web
COPY demo ./demo
COPY packs ./packs
COPY scripts ./scripts

RUN mkdir -p /data && chown node:node /data

ENV FATHOM_DATA=/data \
    FATHOM_PORT=8080 \
    FATHOM_HOST=0.0.0.0

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.FATHOM_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/server.mjs"]
