import makeWASocket, {
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from "baileys";
import pino from "pino";
import { useRemoteAuthState } from "./remoteAuthState.js";
import { workerApi } from "./workerApi.js";
import { loadCommands } from "./commandLoader.js";
import { handleMessage } from "./handler.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DISCONNECT_POLL_INTERVAL_MS = 10 * 1000;
const MIN_BACKOFF_MS = 5 * 1000;
const MAX_BACKOFF_MS = 2 * 60 * 1000;

let currentSock = null;
let heartbeatTimer = null;
let disconnectPollTimer = null;
let messageStore = new Map();

const startedAt = Date.now();
const seenMessageIds = new Set();
const MAX_SEEN_IDS = 500;

function shouldProcessMessage(msg) {
  const ts = Number(msg.messageTimestamp) * 1000;
  if (ts && ts < startedAt - 10_000) return false;

  const id = msg.key?.id;
  if (!id) return true;
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.add(id);
  if (seenMessageIds.size > MAX_SEEN_IDS) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return true;
}

export async function startBot() {
  const { state, saveCreds } = await useRemoteAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.macOS("Safari"),
    printQRInTerminal: false,
    getMessage: async (key) => {
      const stored = messageStore.get(key.id);
      return stored?.message ?? undefined;
    },
  });

  currentSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key?.id) messageStore.set(msg.key.id, { message: msg.message, ts: Date.now() });
      if (!shouldProcessMessage(msg)) continue;
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err }, "handleMessage threw");
      }
    }
  });

  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, entry] of messageStore) {
      if (entry.ts < cutoff) messageStore.delete(id);
    }
  }, 5 * 60 * 1000);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      logger.info("Connected.");
      startHeartbeat();
      startDisconnectSignalPolling(sock);
      await loadCommands();
      await sendWelcomeIfDue(sock);
    }

    if (connection === "close") {
      stopHeartbeat();
      stopDisconnectSignalPolling();

      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode === 401) {
        logger.error("Logged out (401). Not reconnecting — session is dead, needs re-pairing.");
        return;
      }

      if (statusCode === 403) {
        logger.warn("403 Forbidden — waiting 5 minutes before retry.");
        setTimeout(() => startBot(), 5 * 60 * 1000);
        return;
      }

      reconnectAttempt++;
      const delay = Math.min(MIN_BACKOFF_MS * 2 ** (reconnectAttempt - 1), MAX_BACKOFF_MS);
      logger.warn({ statusCode, delay, attempt: reconnectAttempt }, "Connection closed, reconnecting.");
      setTimeout(() => startBot(), delay);
    }
  });

  return sock;
}

let reconnectAttempt = 0;

function startHeartbeat() {
  reconnectAttempt = 0;
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    workerApi.heartbeat().catch((err) => logger.warn({ err: err.message }, "heartbeat failed"));
  }, HEARTBEAT_INTERVAL_MS);
  workerApi.heartbeat().catch(() => {});
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startDisconnectSignalPolling(sock) {
  stopDisconnectSignalPolling();
  disconnectPollTimer = setInterval(async () => {
    try {
      const { signal } = await workerApi.getDisconnectSignal();
      if (!signal) return;

      logger.info({ reason: signal.reason }, "disconnect signal received");
      stopDisconnectSignalPolling();
      stopHeartbeat();

      try {
        sock.end(undefined);
      } catch {}

      await workerApi.resolveDisconnectSignal(signal.id).catch((err) =>
        logger.error({ err: err.message }, "failed to resolve disconnect signal")
      );

      if (signal.reason === "repair") {
        reconnectAttempt = 0;
        setTimeout(() => startBot(), MIN_BACKOFF_MS);
        return;
      }

      process.exit(0);
    } catch (err) {
      logger.debug({ err: err.message }, "disconnect signal poll failed");
    }
  }, DISCONNECT_POLL_INTERVAL_MS);
}

function stopDisconnectSignalPolling() {
  if (disconnectPollTimer) clearInterval(disconnectPollTimer);
  disconnectPollTimer = null;
}

async function sendWelcomeIfDue(sock) {
  let shouldSend;
  try {
    const result = await workerApi.shouldSendWelcome();
    shouldSend = result.shouldSend;
  } catch (err) {
    logger.warn({ err: err.message }, "shouldSendWelcome check failed");
    return;
  }

  if (!shouldSend) return;

  const ownerJid = sock.user?.id;
  if (!ownerJid) return;

  try {
    await sock.sendMessage(ownerJid, {
      text: "Bot connected successfully. Type .menu for all commands.",
    });
    await workerApi.markWelcomeSent();
  } catch (err) {
    logger.warn({ err: err.message }, "welcome DM failed");
  }
}

export function getCurrentSocket() {
  return currentSock;
}
