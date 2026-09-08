import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
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
