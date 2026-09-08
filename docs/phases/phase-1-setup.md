# Phase 1 — Monorepo Setup & Infrastructure

## Goals
1. npm-workspaces monorepo: `web` (Next.js 16), `ws` (Socket.IO server), `shared` (event contract)
2. docker-compose Postgres + Redis with healthchecks
3. Env plumbing: web talks to ws through a same-origin `/socket.io` rewrite (no CORS in dev or prod)
4. Root scripts: one command starts both processes

## Steps

### 1.1 Root workspace
```bash
mkdir real-time-chat-app && cd real-time-chat-app && npm init -y
```
`package.json` (root):
```json
{
  "name": "real-time-chat-app",
  "private": true,
  "workspaces": ["shared", "ws", "web"],
  "scripts": {
    "dev": "concurrently -n ws,web -c yellow,cyan \"npm run dev -w ws\" \"npm run dev -w web\"",
    "dev:ws": "npm run dev -w ws",
    "db:up": "docker compose up -d postgres redis",
    "db:migrate": "npm run db:migrate -w web",
    "db:seed": "npm run db:seed -w web",
    "typecheck": "tsc --noEmit -p shared && tsc --noEmit -p ws && tsc --noEmit -p web",
    "lint": "npm run lint -w web",
    "test": "npm run test -w shared && npm run test -w ws && npm run test -w web"
  },
  "devDependencies": { "concurrently": "^9" }
}
```

### 1.2 `shared/` — the contract package
```bash
mkdir -p shared/src && cd shared && npm init -y
```
- `package.json`: name `@chat/shared`, `"main": "src/index.ts"`, `"types": "src/index.ts"` (consumed as source by both workspaces via TS `paths` or workspace resolution — no build step needed for dev).
- Deps: `zod`.
- `src/events.ts` — string-const maps `CLIENT_EVENTS` (`MESSAGE_SEND`, `TYPING_START`, `TYPING_STOP`, `CONVERSATION_READ`) and `SERVER_EVENTS` (`MESSAGE_NEW`, `TYPING_UPDATE`, `RECEIPT_UPDATE`, `PRESENCE_UPDATE`, `UNREAD_UPDATE`, `CONVERSATION_NEW`, `MEMBER_JOINED`, `MEMBER_LEFT`, `ERROR`).
- `src/schemas.ts` — zod schemas per PLAN §Socket Event Contract: `MessageSendSchema`, `TypingSchema`, `ConversationReadSchema`, `MessageDtoSchema`, ack envelope `AckSchema<T>` helper, `ErrorCode` union (`UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | VALIDATION | RATE_LIMITED | PAYLOAD_TOO_LARGE`).
- `src/types.ts` — `z.infer` exports (`MessageSend`, `MessageDto`, …) + `ChatEventMap` interface used by `socket.emit` typing on both sides.

### 1.3 `ws/` — Socket.IO server skeleton
```bash
mkdir -p ws/src && cd ws
npm init -y
npm install socket.io @socket.io/redis-adapter ioredis @prisma/client next-auth @chat/shared@*
npm install -D typescript tsx @types/node vitest
```
- `package.json` scripts: `"dev": "tsx watch src/index.ts"`, `"build": "tsc -p tsconfig.json"`, `"start": "node dist/index.js"`, `"test": "vitest run"`.
- `src/index.ts` (skeleton — adapter + auth wired in Phase 5):
```ts
import { createServer } from "node:http";
import { Server } from "socket.io";

const port = Number(process.env.WS_PORT ?? 4001);
const httpServer = createServer((_req, res) => {
  res.writeHead(200).end(JSON.stringify({ ok: true, uptime: process.uptime() }));
});
const io = new Server(httpServer, { cors: { origin: process.env.ORIGIN ?? "http://localhost:3000" } });

io.on("connection", (socket) => {
  console.log("connected", socket.id); // replaced by auth middleware in Phase 5
});

httpServer.listen(port, () => console.log(`ws on :${port}`));
```

### 1.4 `web/` — Next.js
```bash
npx create-next-app@latest web --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
cd web
npm install prisma @prisma/client @tanstack/react-query axios next-auth @auth/prisma-adapter \
  bcryptjs zod react-hook-form @hookform/resolvers lucide-react date-fns @chat/shared@*
npm install -D @types/bcryptjs tsx vitest @testing-library/react @testing-library/jest-dom
```
`web/next.config.ts` — the same-origin socket proxy:
```ts
async rewrites() {
  return [{ source: "/socket.io/:path*", destination: `${process.env.WS_INTERNAL_URL}/socket.io/:path*` }];
}
```

### 1.5 docker-compose + env
`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_USER: chat, POSTGRES_PASSWORD: chat, POSTGRES_DB: chat }
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U chat"], interval: 5s, retries: 10 }
  redis:
    image: redis:7
    ports: ["6379:6379"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, retries: 10 }
volumes: { pgdata: }
```
`.env.example` (mirrored to `.env`, ws + web read the same values):
```env
DATABASE_URL="postgresql://chat:chat@localhost:5432/chat"
NEXTAUTH_SECRET="openssl rand -base64 32"
NEXTAUTH_URL="http://localhost:3000"
WS_PORT=4001
WS_INTERNAL_URL="http://localhost:4001"
ORIGIN="http://localhost:3000"
REDIS_URL="redis://localhost:6379"
STORAGE_PROVIDER="local"
```

## Verify (Definition of Done)
- [ ] `docker compose up -d postgres redis` → both `healthy`
- [ ] `npm run dev` → web :3000 AND ws :4001 both boot; `curl localhost:4001` → `{"ok":true,…}`
- [ ] `npm run typecheck` green across all three workspaces
- [ ] `.env.example` matches every var actually read by the code so far
