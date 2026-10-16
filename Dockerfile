FROM node:22.22.3-bookworm-slim AS node
FROM oven/bun:1.3.9 AS base
WORKDIR /app

FROM base AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run prisma:generate
RUN bun run build

FROM base AS runtime
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/.bun-version ./.bun-version
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/oss ./apps/oss
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts/workspace-env.js ./scripts/workspace-env.js

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
