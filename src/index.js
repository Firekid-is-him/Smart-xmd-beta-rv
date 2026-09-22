import { startBot } from "./lib/connection.js";
import { startHealthServer, startSelfPing } from "./lib/health.js";

startHealthServer();
startSelfPing();

startBot().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
