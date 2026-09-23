import { initAuthCreds, BufferJSON } from "baileys";
import { workerApi } from "./workerApi.js";

function serialize(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}
function deserialize(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

// Registered once for the process, not once per useRemoteAuthState() call.
// startBot() re-invokes useRemoteAuthState() on every reconnect, and
// process.on listeners are never auto-replaced, so registering inside the
// function would leak one SIGTERM/SIGINT/beforeExit listener per reconnect
// and risk multiple stale sessions racing to flush on shutdown.
let activeFlush = null;
let shutdownHandlersRegistered = false;

function registerShutdownHandlersOnce() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const runFlush = async () => {
    if (activeFlush) await activeFlush().catch(() => {});
  };

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      await runFlush();
      process.exit(0);
    });
  }
  process.on("beforeExit", () => {
    runFlush();
  });
}

export async function useRemoteAuthState() {
  const stored = await workerApi.getAuthState();

  const creds = stored?.creds ? deserialize(stored.creds) : initAuthCreds();
  const keyStore = stored?.keys ? deserialize(stored.keys) : {};

  // Debounce coalesces bursts of writes, but a burst must never be able to
  // outlive the process: `dirty` tracks whether memory has unwritten
  // changes, and `flush()` is both what the timer calls and what shutdown
  // handlers call to force an immediate, awaited write. `inFlight` prevents
  // two overlapping writes to the same row from racing.
  let saveTimer = null;
  let dirty = false;
  let inFlight = null;

  const persist = async () => {
    dirty = false;
    const payload = { creds: serialize(creds), keys: serialize(keyStore) };
    try {
      await workerApi.setAuthState(payload.creds, payload.keys);
    } catch (err) {
      console.error("[auth] failed to persist creds:", err.message);
      dirty = true; // retry on the next scheduled save or flush
    }
  };

  const flush = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (inFlight) await inFlight.catch(() => {});
    if (!dirty) return;
    inFlight = persist();
    await inFlight;
    inFlight = null;
  };

  const scheduleSave = () => {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      inFlight = persist().finally(() => {
        inFlight = null;
      });
    }, 500);
  };

  activeFlush = flush;
  registerShutdownHandlersOnce();

  const keys = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const value = keyStore[type]?.[id];
        if (value) result[id] = value;
      }
      return result;
    },
    set: async (data) => {
      for (const type in data) {
        keyStore[type] = keyStore[type] || {};
        for (const id in data[type]) {
          const value = data[type][id];
          if (value) keyStore[type][id] = value;
          else delete keyStore[type][id];
        }
      }
      scheduleSave();
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      scheduleSave();
    },
    flush,
  };
}
