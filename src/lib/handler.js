import { getCommand, getMessageListeners } from "./commandLoader.js";
import { workerApi } from "./workerApi.js";
import { resolveFromJid } from "./jid.js";

// TTL-based, not connection-lifetime cached: a dashboard prefix change used
// to only reach a running bot on its next reconnect (resetPrefixCache() was
// only ever called from connection.js's "open" handler), which could mean
// hours of staleness on a long-lived connection. This refetches at most
// once per PREFIX_CACHE_TTL_MS regardless of message volume — piggybacking
// on the normal per-message flow rather than adding a new setInterval/poll,
// so a busy chat can't turn this into a request storm against the worker.
const PREFIX_CACHE_TTL_MS = 60 * 1000;

let cachedPrefixes = null;
let cachedAt = 0;
// Coalesces concurrent refetches (e.g. several messages arriving in the
// same tick right as the TTL expires) into a single in-flight request
// instead of each message firing its own — another spam-avoidance guard.
let inFlightFetch = null;

// Throttles the "couldn't verify permissions" reply during a worker
// outage — without this, every command message that comes in while the
// worker is down would trigger its own outbound WhatsApp message, which
// is exactly the kind of rapid-fire sending pattern that risks a ban on
// the account. One notice per window is enough to inform the sender.
const MODE_CHECK_ERROR_NOTICE_INTERVAL_MS = 60 * 1000;
let lastModeCheckErrorNoticeAt = 0;

export function resetPrefixCache() {
  cachedPrefixes = null;
  cachedAt = 0;
}

async function getPrefixes() {
  const isFresh = cachedPrefixes && Date.now() - cachedAt < PREFIX_CACHE_TTL_MS;
  if (isFresh) return cachedPrefixes;

  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    try {
      const result = await workerApi.getPrefixes();
      cachedPrefixes = result.prefixes?.length ? result.prefixes : ["."];
      cachedAt = Date.now();
    } catch {
      // Keep serving the last known-good prefixes on a transient failure
      // rather than collapsing to "." and breaking anyone using a custom
      // prefix during a blip; only fall back to "." if we've never
      // successfully fetched at all.
      if (!cachedPrefixes) cachedPrefixes = ["."];
      cachedAt = Date.now();
    } finally {
      inFlightFetch = null;
    }
    return cachedPrefixes;
  })();

  return inFlightFetch;
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

export async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  // PN-normalized, not the raw participant/remoteJid — see jid.js. Without
  // this, the same person could show up as @s.whatsapp.net in one chat and
  // @lid in another (or even message-to-message), and owner/sudo checks
  // that compare against a stored PN JID would inconsistently deny someone
  // who genuinely is the owner.
  const fromJid = resolveFromJid(msg.key);
  const text = extractText(msg).trim();

  for (const listener of getMessageListeners()) {
    try {
      await listener(sock, msg);
    } catch (err) {
      console.error("message listener threw:", err.message);
    }
  }

  const prefixes = await getPrefixes();
  const matchedPrefix = prefixes.find((p) => text.startsWith(p));
  if (!matchedPrefix) return;

  const withoutPrefix = text.slice(matchedPrefix.length).trim();
  const [rawCommand, ...args] = withoutPrefix.split(/\s+/);
  if (!rawCommand) return;

  const commandName = rawCommand.toLowerCase();

  if (commandName === "changefilemode") {
    await handleChangeFileMode(sock, msg, args, matchedPrefix);
    return;
  }

  let allowed;
  try {
    const result = await workerApi.modeCheck(fromJid);
    allowed = result.allowed;
  } catch (err) {
    // A failed permission check used to look identical to "you're not
    // allowed" — the bot would just go silent either way, which made a
    // real outage indistinguishable from correctly-enforced private mode.
    // Log the real error so it's visible in the deploy logs, and let the
    // sender know it's a transient problem rather than saying nothing.
    console.error({ err: err.message, fromJid }, "modeCheck failed, denying by default");
    const now = Date.now();
    if (now - lastModeCheckErrorNoticeAt > MODE_CHECK_ERROR_NOTICE_INTERVAL_MS) {
      lastModeCheckErrorNoticeAt = now;
      await sock
        .sendMessage(jid, { text: "couldn't verify permissions right now, try again in a moment" }, { quoted: msg })
        .catch(() => {});
    }
    return;
  }
  if (!allowed) return;

  const cmd = getCommand(commandName);
  if (!cmd) return;

  try {
    await cmd.handler(sock, msg, { args, jid, fromJid, prefix: matchedPrefix, command: commandName });
  } catch (err) {
    console.error(`command "${commandName}" threw:`, err.message);
  }
}

async function handleChangeFileMode(sock, msg, args, prefix) {
  const jid = msg.key.remoteJid;
  const [target, token] = args;

  if (!target || !token || (target !== "prod" && target !== "beta")) {
    await sock.sendMessage(jid, { text: `usage: ${prefix}changefilemode <prod|beta> <token>` });
    return;
  }

  try {
    await workerApi.consumeAdminToken(token, "changefilemode");
  } catch (err) {
    await sock.sendMessage(jid, { text: "invalid or expired token" });
    return;
  }

  await workerApi.setFileMode(target);
  await sock.sendMessage(jid, { text: `file mode set to ${target}, reloading commands` });

  const { loadCommands } = await import("./commandLoader.js");
  await loadCommands();
}
