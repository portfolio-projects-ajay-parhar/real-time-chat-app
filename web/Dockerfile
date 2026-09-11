# syntax=docker/dockerfile:1
# Build context = monorepo ROOT (see docker-compose.yml) so the `shared`
# workspace and web/prisma can participate. Multi-stage: deps → build → runner.
#
#   target=runner   → the Next standalone server (compose `web` service)
#   target=migrator → full node_modules + prisma CLI for `migrate deploy`
#                     (compose one-shot `migrate` service)

# ---------- deps: install the whole workspace once ----------
FROM node:20-alpine AS deps
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY ws/package.json ws/package.json
COPY web/package.json web/package.json
RUN npm ci

# ---------- migrator: prisma CLI + migrations (never shipped in `web`) ----------
FROM deps AS migrator
COPY web/prisma web/prisma

# ---------- build: shared → prisma client → next standalone ----------
FROM deps AS build
COPY shared/ shared/
COPY web/ web/
RUN npm run build -w shared
RUN npx prisma generate --schema web/prisma/schema.prisma
ENV NEXT_TELEMETRY_DISABLED=1
# `output: "standalone"` + `outputFileTracingRoot` (next.config.ts) make the
# traced bundle self-contained, workspace packages (@chat/shared) included.
RUN npm run build -w web

# ---------- runner: minimal standalone ----------
FROM node:20-alpine AS runner
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# server.js + the traced subset of node_modules (incl. @prisma/client engines
# and the @chat/shared workspace package, thanks to outputFileTracingRoot)
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public
EXPOSE 3000
CMD ["node", "web/server.js"]