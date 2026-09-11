# syntax=docker/dockerfile:1
# Build context = repo ROOT (the ws server imports the `shared` workspace and
# generates its Prisma client from web/prisma/schema.prisma).
#
# ---------- build: shared → prisma client → tsc ----------
FROM node:20-alpine AS build
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY ws/package.json ws/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY shared/ shared/
COPY ws/ ws/
COPY web/prisma web/prisma
RUN npm run build -w shared
RUN npx prisma generate --schema web/prisma/schema.prisma
RUN npm run build -w ws   # tsc → ws/dist

# ---------- runner ----------
FROM node:20-alpine AS runner
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NODE_ENV=production
# node_modules carries runtime deps AND the generated prisma client (+ engines)
COPY --from=build /app/package.json package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/ws/package.json ws/package.json
COPY --from=build /app/ws/dist ws/dist
EXPOSE 4001
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4001/health > /dev/null || exit 1
CMD ["node", "ws/dist/index.js"]