import http from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { loadEnv } from "./config.js";

async function main() {
  const env = loadEnv();

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io = new Server(httpServer, {
    path: "/socket.io/ws",
    cors: { origin: env.ORIGIN, credentials: true },
  });

  // Redis adapter — fans every emit out to all ws instances
  const pubClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  io.on("connection", (socket) => {
    console.log(`[ws] socket connected: ${socket.id}`);
    socket.on("disconnect", (reason) => {
      console.log(`[ws] socket disconnected: ${socket.id} (${reason})`);
    });
  });

  httpServer.listen(env.WS_PORT, () => {
    console.log(`[ws] listening on :${env.WS_PORT} (origin: ${env.ORIGIN})`);
  });

  const shutdown = async () => {
    console.log("\n[ws] shutting down…");
    io.close();
    httpServer.close();
    pubClient.disconnect();
    subClient.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[ws] fatal:", err);
  process.exit(1);
});
