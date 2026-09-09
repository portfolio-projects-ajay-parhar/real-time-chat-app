/**
 * Manual two-party test driver — "Bob" over raw HTTP + socket.io-client:
 * NextAuth credentials sign-in → session cookie → WS handshake through the
 * same-origin Next rewrite (the production path) → typing:start → message:send
 * → listens for Alice's replies (message:new) and her typing.
 * Run: npx tsx ws/test/bob-live.mjs <conversationId>
 */
import { io } from "socket.io-client";

const ORIGIN = "http://localhost:3005";
const conversationId = process.argv[2];
if (!conversationId) {
  console.error("usage: tsx bob-live.mjs <conversationId>");
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
console.log("✅ bob signed in (cookie len", sessionCookie.length + ")");

// ---- WS handshake through the Next rewrite (cookie path) ----
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
    console.log("⌨️  bob received typing:update:", JSON.stringify(p.userIds));
  });
  socket.on("unread:update", (p) => {
    console.log("🔔 bob received unread:update:", JSON.stringify(p));
  });

  // start typing, then send after a beat so alice's UI shows the dots
  socket.emit("typing:start", { conversationId });
  await new Promise((r) => setTimeout(r, 1200));
  socket.emit("typing:stop", { conversationId });

  await new Promise((r) => setTimeout(r, 400));
  socket.timeout(5000).emit(
    "message:send",
    {
      conversationId,
      clientId: crypto.randomUUID(),
      type: "TEXT",
      body: "live test: bob → alice over the rewrite proxy 🚀",
    },
    (err, ack) => {
      if (err || !ack?.ok) console.log("❌ send ack:", err ?? ack);
      else console.log("✅ bob send ack ok — persisted id:", ack.message.id);
    }
  );
});

socket.on("connect_error", (e) => console.error("❌ connect_error:", e.message));
socket.on("disconnect", (r) => console.log("socket disconnected:", r));

// stay alive for alice's UI sends
setTimeout(() => {
  console.log("— bob done —");
  socket.close();
  process.exit(0);
}, 25_000);