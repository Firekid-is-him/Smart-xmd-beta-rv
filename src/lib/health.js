import http from "node:http";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

const PORT = process.env.PORT || 3000;
// Render's own external URL for this service, e.g.
// https://smart-xmd-rv-<hash>.onrender.com. Render sets RENDER_EXTERNAL_URL
// automatically for every web service, so this normally needs no manual
// config - only fall back to a user-supplied SELF_PING_URL if that's ever
// unset (local dev, or a Render env that doesn't expose it).
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || null;
const PING_INTERVAL_MS = 12 * 60 * 1000;

let lastStatus = { connected: false, sessionId: process.env.SESSION_ID || null };

export function setHealthStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
}

export function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...lastStatus }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "NOT_FOUND" }));
  });

  server.listen(PORT, () => {
    logger.info(`Health server listening on :${PORT}`);
  });

  return server;
}

export function startSelfPing() {
  if (!SELF_URL) {
    logger.warn("No RENDER_EXTERNAL_URL or SELF_PING_URL set, self-ping disabled. This service will sleep after 15 minutes of inactivity on Render's free tier.");
    return null;
  }

  const ping = () => {
    fetch(SELF_URL).catch((err) => {
      logger.warn({ err: err.message }, "self-ping failed");
    });
  };

  // Fire one shortly after boot too, not just on the first interval tick,
  // so a fresh deploy doesn't wait a full 12 minutes for its first ping.
  setTimeout(ping, 30_000);
  return setInterval(ping, PING_INTERVAL_MS);
}
