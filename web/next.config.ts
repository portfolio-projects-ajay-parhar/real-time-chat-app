import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  // Docker (Phase 10): self-contained server bundle at `web/.next/standalone`.
  // The tracing root must be the MONOREPO root or the traced bundle would miss
  // the workspace package @chat/shared (symlinked outside web/).
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  async rewrites() {
    const ws = process.env.WS_INTERNAL_URL ?? "http://localhost:4001";
    return [
      // Proxy the WS handshake through Next (same-origin) so the socket
      // handshake carries the NextAuth session cookie automatically.
      // Socket.IO is mounted at path /socket.io/ws on the ws server
      // (Next rewrites can't match the bare engine.io default path).
      { source: "/socket.io/ws/", destination: `${ws}/socket.io/ws/` },
      { source: "/socket.io/ws", destination: `${ws}/socket.io/ws/` },
      { source: "/socket.io/:path*", destination: `${ws}/socket.io/:path*` },
    ];
  },
};


export default nextConfig;
