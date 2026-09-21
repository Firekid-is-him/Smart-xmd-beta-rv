import { startBot } from "./lib/connection.js";

startBot().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
