/**
 * Manual two-party test driver — "Bob" through the PROD-VERIFY nginx topology.
 * NextAuth credentials sign-in → session cookie → WS handshake via
 * http://localhost:8080/socket.io/ws (nginx round-robins ws-1/ws-2 — the
 * docker logs of each instance prove which one served this connection).
 *
 * Run: npx tsx ws/test/bob-nginx.mjs <conversationId> [message]
 */
import { io } from "socket.io-client";

const ORIGIN = process.env.BOB_ORIGIN ?? "http://localhost:8080";
const conversationId = process.argv[2];
const outgoing = process.argv[3] ?? "prod-verify: bob via nginx 🚀";
if (!conversationId) {
  console.error("usage: tsx bob-nginx.mjs <conversationId> [message]");
  process.exit(1);
}

// ---- NextAuth credentials sign-in (cookie jar kept by hand) ----
const csrfRes = await fetch(`${ORIGIN}/api/auth/csrf`);
const csrf = await csrfRes.json();
const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0])
  .join("; ");
const form = new URLSearchParams({
  csrfToken: csrf.csrfToken,
  email: "bob@example.com",
  password: "Password123!",
  json: "true",
});
const signin = await fetch(`${ORIGIN}/api/auth/callback/credentials`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: csrfCookie,
  },
  body: form.toString(),
  redirect: "manual",
});
const setCookies = signin.headers.getSetCookie?.() ?? [];
const sessionCookie = setCookies
  .map((c) => c.split(";")[0])
  .find((c) => c.startsWith("next-auth.session-token="));
if (!sessionCookie) {
  console.error("❌ no session cookie — sign-in failed", signin.status);
  process.exit(1);
}
console.log("✅ bob signed in via", ORIGIN, "(cookie len", sessionCookie.length + ")");

// ---- WS handshake through nginx (cookie path) ----
const socket = io(ORIGIN, {
  path: "/socket.io/ws",
  transports: ["websocket"],
  extraHeaders: { Cookie: sessionCookie },
});

socket.on("connect", async () => {
  console.log("✅ bob socket connected:", socket.id);

  socket.on("message:new", (p) => {
    console.log("📩 bob received message:new:", JSON.stringify(p.message.body));
  });
  socket.on("typing:update", (p) => {
    if (p.userIds.length > 0) console.log("✍️  bob sees typing:", p.userIds.length, "typer(s)");
  });

  // send one message with ack
  socket.timeout(5000).emit(
    "message:send",
    { conversationId, clientId: crypto.randomUUID(), type: "TEXT", body: outgoing },
    (err, ack) => {
      if (err) return console.error("❌ ack timeout");
      console.log(ack.ok ? "✅ send ack ok, id=" + ack.message.id : "❌ ack error:", ack);
    }
  );

  // listen for alice's reply, then exit
  await new Promise((r) => setTimeout(r, 12_000));
  console.log("👋 bob leaving");
  socket.close();
  process.exit(0);
});

socket.on("connect_error", (err) => {
  console.error("❌ connect_error:", err.message);
  process.exit(1);
});