/**
 * Demo beat — single-action driver for GIF frame capture.
 *   npx tsx ws/test/demo-beat.mjs read   <conversationId> [origin]
 *   npx tsx demo-beat.mjs typing <conversationId> [origin]
 *
 * "read"   → connect bob, wait, conversation:read (alice's ✓ flips to ✓✓)
 * "typing" → connect bob, typing:start held for 25 s, then stop + exit
 */
import { io } from "socket.io-client";

const mode = process.argv[2];
const conversationId = process.argv[3];
const ORIGIN = process.argv[4] ?? "http://localhost:3005";
if (!mode || !conversationId) {
  console.error("usage: tsx demo-beat.mjs <read|typing> <conversationId> [origin]");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[beat] ${m}`);

const csrfRes = await fetch(`${ORIGIN}/api/auth/csrf`);
const csrf = await csrfRes.json();
const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const signin = await fetch(`${ORIGIN}/api/auth/callback/credentials`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
  body: new URLSearchParams({
    csrfToken: csrf.csrfToken,
    email: "bob@example.com",
    password: "Password123!",
    json: "true",
  }).toString(),
  redirect: "manual",
});
const sessionCookie = (signin.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0])
  .find((c) => c.startsWith("next-auth.session-token="));
if (!sessionCookie) {
  console.error("❌ sign-in failed", signin.status);
  process.exit(1);
}

const socket = io(ORIGIN, {
  path: "/socket.io/ws",
  transports: ["websocket"],
  extraHeaders: { Cookie: sessionCookie },
});
socket.on("connect_error", (e) => {
  console.error("❌ connect_error:", e.message);
  process.exit(1);
});

socket.on("connect", async () => {
  log(`connected (${mode})`);
  await sleep(2500);

  if (mode === "typing") {
    socket.emit("typing:start", { conversationId });
    log("typing:start — holding 25 s");
    await sleep(25_000);
        socket.emit("typing:stop", { conversationId });
    log("typing stopped");
  } else if (mode === "read") {
    socket.timeout(5000).emit("conversation:read", { conversationId }, (err, ack) =>
      log(err || !ack?.ok ? "❌ read failed" : `read ok lastReadAt=${ack.lastReadAt}`)
    );
    await sleep(4000);
  }

  socket.disconnect();
  await new Promise((resolve) => {
    if (!socket.connected) return resolve();
    socket.once("disconnect", resolve);
    setTimeout(resolve, 1500);
  });
  log("done");
  process.exit(0);
});