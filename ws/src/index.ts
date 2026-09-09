import { loadEnv } from "./config.js";
import { createChatServer } from "./app.js";

async function main() {
  const env = loadEnv();
  const server = createChatServer(env);

  const shutdown = async () => {
    console.log("\n[ws] shutting down…");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[ws] fatal:", err);
  process.exit(1);
});
