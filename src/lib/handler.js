import { getCommand, getMessageListeners } from "./commandLoader.js";
import { workerApi } from "./workerApi.js";

let cachedPrefixes = null;

export function resetPrefixCache() {
  cachedPrefixes = null;
}

async function getPrefixes() {
  if (cachedPrefixes) return cachedPrefixes;
  try {
    const result = await workerApi.getPrefixes();
    cachedPrefixes = result.prefixes?.length ? result.prefixes : ["."];
  } catch {
    cachedPrefixes = ["."];
  }
  return cachedPrefixes;
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
  const fromJid = msg.key.participant || msg.key.remoteJid;
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
  } catch {
    allowed = false;
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

