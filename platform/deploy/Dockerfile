FROM oven/bun:1.4.0 AS bun
FROM node:24-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts
RUN bun run cloud:build

FROM bun AS server
WORKDIR /app
COPY --from=build --chown=bun:bun /workspace/platform/server/dist ./dist
COPY --from=build --chown=bun:bun /workspace/platform/server/migrations ./migrations
ENV CLOUD_PORT=3200
EXPOSE 3200
USER bun
CMD ["bun", "dist/start.js"]

FROM node:24-bookworm-slim AS portal
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/platform/portal/.next/standalone ./
COPY --from=build --chown=node:node /workspace/platform/portal/.next/static ./platform/portal/.next/static
ENV HOSTNAME=0.0.0.0 PORT=3100 NODE_ENV=production
USER node
EXPOSE 3100
CMD ["node", "platform/portal/server.js"]

FROM caddy:2.10-alpine AS admin
COPY --from=build /workspace/platform/admin/dist /srv
COPY platform/deploy/admin.Caddyfile /etc/caddy/Caddyfile
EXPOSE 3101
