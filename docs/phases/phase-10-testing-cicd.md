# Phase 10 — Testing, Docker & CI/CD

## Goals
1. The headline suite: **two clients across two ws instances** prove the Redis adapter end-to-end
2. Production images + a compose profile that runs the real topology
3. GitHub Actions pipeline; README that tells the architecture story

## Steps

### 10.1 Unit suites (already cumulative)
- [ ] `shared/` — every zod schema: accept/repair/reject tables; event-name constants exhaustive
- [ ] `ws/` — rate limiter with fake timers (boundary 30/31, window expiry); presence service with `ioredis-mock` (first/last socket transitions, TTL refresh); cursor encode/decode
- [ ] `web/` — optimistic reducer (append, pending→acked swap by clientId, dedupe on echo, failed retry); inbox badge patch; markdown-lite transform incl. XSS payloads; title-badge reducer

### 10.2 Two-instance integration suite (`ws/test/integration/`)
Harness: real Postgres + Redis (compose), seed once per run, two servers on 4001/4002, `socket.io-client` per actor (alice, bob — cookies minted by test-signing JWEs with the shared secret).
- [ ] `cross-instance-delivery` — alice → ws:4001, bob → ws:4002; alice emits MESSAGE_SEND → bob receives MESSAGE_NEW; alice gets ack with DB id
- [ ] `unread-fanout` — bob (not in conversation view) → `UNREAD_UPDATE` arrives on his **second** device (third client, same user room)
- [ ] `read-receipts` — bob emits CONVERSATION_READ → both alice devices get RECEIPT_UPDATE; watermark in DB
- [ ] `presence-mutuals-only` — carol (no shared conversation) receives **no** PRESENCE_UPDATE when alice connects
- [ ] `dm-advisory-lock` — `Promise.all` both users POST the same DM pair → one conversation
- [ ] `rate-limit` — 31st message in 10 s → ack `RATE_LIMITED`; 31st after window passes → ok
- [ ] `kicked-member` — bob removed via REST → his next MESSAGE_SEND acks `FORBIDDEN` **without reconnect** (DB re-check proof)
- [ ] `reconnect-dedupe` — same clientId emitted twice (reconnect simulation) → one row
- [ ] `typing-throttle` — 10 start events in 1 s → ≤ 1 broadcast

### 10.3 Docker & topology
- `web/Dockerfile` — `node:20-alpine`, `output: "standalone"`, multi-stage (deps → build → runner), prisma generate in build
- `ws/Dockerfile` — `tsc -p` → `dist/`, `node dist/index.js`, healthcheck hits `/:health`
- `docker-compose.yml` profile `prod-verify`: web, **ws-1, ws-2** (same image, `WS_PORT` 4001/4002, shared Redis), postgres, redis, nginx (proxy `/socket.io/` with `proxy_set_header Upgrade $http_upgrade; proxy_http_version 1.1;` to upstream `ws-1 ws-2` round-robin)
- [ ] `docker compose --profile prod-verify up` → two windows chat across the nginx-balanced pair (manual capstone check)

### 10.4 GitHub Actions (`.github/workflows/ci.yml`)
```yaml
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:16, env: { POSTGRES_USER: chat, POSTGRES_PASSWORD: chat, POSTGRES_DB: chat }, ports: ["5432:5432"], options: --health-cmd "pg_isready -U chat" }
      redis:    { image: redis:7, ports: ["6379:6379"], options: --health-cmd "redis-cli ping" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4 (node 20, cache npm)
      - run: npm ci
      - run: npx prisma migrate deploy && npm run db:seed -w web
      - run: npm run typecheck && npm run lint && npm run test
      - run: docker build -t chat-web -f web/Dockerfile . && docker build -t chat-ws -f ws/Dockerfile .
```

### 10.5 README + diagrams
- [ ] README sections per curriculum standard: Problem → Features → Stack → **Architecture diagram** (`docs/architecture.svg`: Client → nginx → ws×N ↔ Redis Pub/Sub, web → Postgres) → **ER diagram** (`docs/ER-diagram.svg`) → **Socket event contract table** (from PLAN) → REST docs → Auth strategy (JWE bridge) → Security → Testing (what the two-instance suite proves) → **Trade-offs** (PLAN §Key Trade-offs, verbatim) → Scaling story (adapter → add instances; next: sticky notes, message search, delivery≠read receipts) → Screenshots + demo GIF → What I Learned
- [ ] `docs/architecture.svg` + `docs/ER-diagram.svg` (draw.io/excalidraw exports, matching Project 7–8 doc style)

## Verify (Definition of Done)
- [ ] `npm run test` — all green locally (unit + integration against compose services)
- [ ] GitHub Actions run green on the final push (typecheck ×3, lint, unit, integration, both docker builds)
- [ ] `docker compose --profile prod-verify up` capstone: cross-instance chat works through nginx
- [ ] `tasks-progress.md` fully mirrored; PROJECTS.md roadmap row 9 done
