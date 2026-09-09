import http from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import type { Env } from "./config.js";
import { authMiddleware, type ChatSocket, type SocketData } from "./auth.js";
import { joinUserRooms } from "./rooms.js";
import { onSocketConnected, onSocketDisconnected, startHeartbeat } from "./presence.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServerWithSocketData = Server<any, any, any, SocketData>;

export interface ChatServer {
  io: ServerWithSocketData;
  httpServer: http.Server;
  pub: Redis;
  sub: Redis;
  /** Stop the heartbeat, disconnect clients, close HTTP + Redis connections. */
  close(): Promise<void>;
}

/**
 * Build the full WS server: http + Socket.IO + Redis adapter + auth + rooms +
 * presence. Extracted as a factory so the integration suite can boot two
 * instances against the same Redis (the cross-instance adapter proof) without
 * spawning processes.
 */
export function createChatServer(env: Env): ChatServer {
  let io: ServerWithSocketData;

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          uptime: process.uptime(),
          sockets: io.engine.clientsCount,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  io = new Server(httpServer, {
    path: "/socket.io/ws",
    cors: { origin: env.ORIGIN, credentials: true },
  });


  // Redis adapter — every io.to(room) now fans out to ALL instances via Pub/Sub
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));

  // Handshake auth — unauthenticated sockets never reach any handler
  io.use(authMiddleware(env.NEXTAUTH_SECRET));

  const heartbeat = startHeartbeat(io, pub);

  io.on("connection", (socket: ChatSocket) => {
    console.log(`[ws] socket connected: ${socket.id} (user: ${socket.data.userId})`);

    void (async () => {
      try {
        await joinUserRooms(socket);
        await onSocketConnected(io, socket, pub);
      } catch (err) {
        console.error(`[ws] post-connect setup failed for ${socket.id}:`, err);
        socket.disconnect(true);
      }
    })();

    socket.on("disconnect", (reason) => {
      console.log(`[ws] socket disconnected: ${socket.id} (${reason})`);
      void onSocketDisconnected(io, socket, pub).catch((err) =>
        console.error(`[ws] disconnect handling failed for ${socket.id}:`, err)
      );
    });
  });

  httpServer.listen(env.WS_PORT, () => {
    console.log(`[ws] listening on :${env.WS_PORT} (origin: ${env.ORIGIN})`);
  });

  return {
    io,
    httpServer,
    pub,
    sub,
    async close() {
      clearInterval(heartbeat);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      pub.disconnect();
      sub.disconnect();
    },
  };
}
