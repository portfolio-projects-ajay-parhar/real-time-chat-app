/**
 * Demo driver — "Bob" acts out a scripted conversation for the README GIF
 * capture. Timeline (with generous pauses so the orchestrator can screenshot
 * each beat in Alice's browser):
 *
 *   connect → (2s) typing:start hold (4s) → text msg 1 → (5s)
 *   → typing (2s) → text msg 2 → (5s)
 *   → IMAGE upload + send → (12s: alice opens lightbox + replies)
 *   → conversation:read (alice's ticks flip ✓✓) → (4s)
 *   → final text → stay 8s → exit
 *
 * Run: npx tsx ws/test/demo-driver.mjs <conversationId> [origin]
 */
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORIGIN = process.argv[3] ?? "http://localhost:3005";
const conversationId = process.argv[2];
if (!conversationId) {
  console.error("usage: tsx demo-driver.mjs <conversationId> [origin]");
  process.exit(1);
}
const IMAGE_PATH = fileURLToPath(
  process.env.DEMO_IMAGE ?? new URL("../../docs/screenshots/demo-image.png", import.meta.url)
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[driver ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---- NextAuth credentials sign-in ----
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
  console.error("❌ bob sign-in failed", signin.status);
  process.exit(1);
}
log("bob signed in");

// ---- WS connect (cookie handshake) ----
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
  log("socket connected — alice should see bob come ONLINE");
  await sleep(8000);

  // 1. typing
  socket.emit("typing:start", { conversationId });
  log("typing:start — alice should see the dots");
  await sleep(20_000);
  socket.emit("typing:stop", { conversationId });
  await sleep(1500);

  // 2. first message
  socket.timeout(5000).emit(
    "message:send",
    { conversationId, clientId: crypto.randomUUID(), type: "TEXT", body: "hey! did you catch the cross-instance demo? 🚀" },
    (err, ack) => log(err || !ack?.ok ? `❌ send1 failed: ${err ?? ack?.code}` : "msg1 delivered")
  );
  await sleep(20_000);

  // 3. second message (same sender run)
  socket.emit("typing:start", { conversationId });
  await sleep(4000);
  socket.emit("typing:stop", { conversationId });
  socket.timeout(5000).emit(
    "message:send",
    { conversationId, clientId: crypto.randomUUID(), type: "TEXT", body: "the redis adapter carried every hop 🔥" },
    (err, ack) => log(err || !ack?.ok ? `❌ send2 failed: ${err ?? ack?.code}` : "msg2 sent")
  );
  await sleep(20_000);

  // 3. image message (real upload through POST /api/media)
  const buf = readFileSync(IMAGE_PATH);
  const fd = new FormData();
  fd.append("file", new File([buf], "sunset-adapter.png", { type: "image/png" }));
  const up = await fetch(`${ORIGIN}/api/media`, {
    method: "POST",
    headers: { Cookie: sessionCookie },
    body: fd,
  });
  const { key } = await up.json();
  if (!key) {
    log(`❌ upload failed: ${up.status}`);
  } else {
    log("image uploaded");
    socket.timeout(5000).emit(
      "message:send",
      {
        conversationId,
        clientId: crypto.randomUUID(),
        type: "IMAGE",
        body: "peeks at the topology 📸",
        attachment: { key, name: "topology.png", size: buf.length, mime: "image/png", width: 1200, height: 750 },
      },
      (err, ack) => log(err || !ack?.ok ? `❌ image send failed: ${err ?? ack?.code}` : "image message sent")
    );
  }
  await sleep(45_000); // alice opens the lightbox and replies

  // 4. bob reads alice's messages → her ticks flip to ✓✓
  socket.timeout(5000).emit("conversation:read", { conversationId }, (err, ack) =>
    log(err || !ack?.ok ? "❌ read failed" : `read ack ok lastReadAt=${ack.lastReadAt}`)
  );
  await sleep(12_000);

  // 5. final beat
  socket.emit("typing:start", { conversationId });
  await sleep(4000);
  socket.emit("typing:stop", { conversationId });
  socket.timeout(5000).emit(
    "message:send",
    { conversationId, clientId: crypto.randomUUID(), type: "TEXT", body: "and the ✓✓ receipts — nice touch ✨" },
    (err, ack) => log(err || !ack?.ok ? `❌ send3 failed: ${err ?? ack?.code}` : "msg3 sent")
  );

  await sleep(15_000);
  log("— bob done —");
  // Disconnect CLEANLY (await the server-side ack) so the sockets set is
  // pruned — process.exit() right after close() can race the disconnect.
  socket.disconnect();
  await new Promise((resolve) => {
    if (!socket.connected) return resolve();
    socket.once("disconnect", resolve);
    setTimeout(resolve, 1500);
  });
  process.exit(0);
});

socket.on("connect_error", (e) => {
  console.error("❌ connect_error:", e.message);
  process.exit(1);
});