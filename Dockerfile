# syntax=docker/dockerfile:1

FROM node:24-alpine

# PUID/PGID default to Unraid's nobody:users and can be overridden at runtime.
ENV NODE_ENV=production \
    PORT=5057 \
    DATABASE_FILE=/data/discovarr.db \
    PUID=99 \
    PGID=100

WORKDIR /app

# su-exec lets the entrypoint drop privileges after fixing /data ownership.
RUN apk add --no-cache su-exec \
    && mkdir -p /data \
    && chown 99:100 /data

# No dependencies to install: SQLite ships with Node as node:sqlite.
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 5057

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5057) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
