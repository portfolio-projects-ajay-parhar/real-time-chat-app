# Phase 3 — Authentication

## Goals
1. NextAuth v4 Credentials + JWT (same pattern as Projects 7–8)
2. **The WS bridge**: the same JWE session token must be verifiable inside the separate `ws` process
3. Sign-in / sign-up pages + route guards

## Steps

### 3.1 NextAuth setup (web)
- `src/lib/auth.ts` — `authOptions`: Credentials provider (email + password, `bcryptjs.compare`), PrismaAdapter, `session: { strategy: "jwt" }`, callbacks copying `token.sub` → `session.user.id`.
- `src/app/api/auth/[...nextauth]/route.ts` — standard handler.
- Register route `POST /api/auth/register`: zod (`email`, `name` 2–40, `password` ≥ 8 w/ letter+digit), 409 on duplicate email, hash with `bcryptjs`, rate-limit with an in-memory fixed window (per-IP, 5/min).

### 3.2 The WS token bridge
The session cookie is an **encrypted JWE**, not a plain JWT. The `ws` process verifies it without Next's request context:

- Web — `GET /api/ws-token` (handshake fallback for cross-origin deploys):
```ts
import { getToken } from "next-auth/jwt";
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) throw new ApiError(401, "UNAUTHENTICATED");
  return NextResponse.json({ token }); // raw JWE string — verified again by ws
}
```
- `ws/src/auth.ts` — handshake middleware:
```ts
import { decode } from "next-auth/jwt";

export const authMiddleware: Middleware = async (socket, next) => {
  const cookieToken = readCookie(socket.request.headers.cookie ?? "", "next-auth.session-token");
  const bearer = socket.handshake.auth?.token as string | undefined;
  const token = cookieToken ?? bearer;
  if (!token) return next(new Error("UNAUTHENTICATED"));
  const session = await decode({ token, secret: process.env.NEXTAUTH_SECRET! });
  if (!session?.sub) return next(new Error("UNAUTHENTICATED"));
  socket.data.userId = session.sub;
  next();
};
```
> Primary path is the **cookie through the `/socket.io` rewrite** (same-origin → no CORS, no token in JS). The `auth.token` fallback exists for deployments where ws sits on its own origin.

### 3.3 Pages + guards
- [ ] `(auth)/signin/page.tsx`, `(auth)/signup/page.tsx` — RHF + zod; `signIn("credentials", { redirect: false })`; map `CredentialsSignin` → inline error
- [ ] `src/lib/guards.ts` — `requireUser()` for route handlers (throws `ApiError(401)`); `(app)/layout.tsx` server-side `getServerSession` → `redirect("/signin?callbackUrl=…")`
- [ ] `GET /api/me` + `PATCH /api/me` (`name`, `bio`; `image` set later via media upload)
- [ ] Session/Query/Toast providers in `src/app/providers.tsx`

## Verify (Definition of Done)
- [ ] Register → auto sign-in → `(app)` reachable; wrong password shows inline error
- [ ] Unauthenticated visit to `/conversations` → 307 to `/signin?callbackUrl=…`
- [ ] `curl /api/ws-token` with a session cookie → `{ token: "eyJ…" }`; without → 401
- [ ] Unit test: `decode()` round-trip of a token minted by `encode()` with the shared secret (proves ws can read web's sessions before any socket exists)
