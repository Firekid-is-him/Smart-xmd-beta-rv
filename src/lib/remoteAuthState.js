import { initAuthCreds, BufferJSON } from "baileys";
import { workerApi } from "./workerApi.js";

function serialize(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}
function deserialize(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

export async function useRemoteAuthState() {
  const stored = await workerApi.getAuthState();

  const creds = stored?.creds ? deserialize(stored.creds) : initAuthCreds();
  const keyStore = stored?.keys ? deserialize(stored.keys) : {};

  // Debounced but never dropped: a pending save now always actually
  // fires, even if the process reconnects/calls startBot() again before
  // the debounce window elapses. Previously, each new startBot() run
  // created a fresh closure over a new keyStore object with no
  // reference to whatever save timer a PRIOR run's closure had pending -
  // if a reconnect happened inside that 500ms window (exactly what
  // "attempt: 2" in the logs indicates was happening), the old timer's
  // keyStore was abandoned with its scheduled write never sent, silently
  // losing every key generated since the last successful save. That
  // showed up later as "failed to find key to decode mutation" / "Bad
  // MAC" once WhatsApp's servers used a key this bot never actually
  // persisted.
  //
  // pendingSave now tracks the in-flight write itself (not just a
  // timer), and flush() lets callers await it directly before doing
  // anything that might tear down this closure.
  let saveTimer = null;
  let pendingSave = Promise.resolve();

  const doSave = () => {
    pendingSave = workerApi
      .setAuthState(serialize(creds), serialize(keyStore))
      .catch((err) => {
        console.error("[auth] failed to persist creds:", err.message);
      });
    return pendingSave;
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      doSave();
    }, 500);
  };

  const flush = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await doSave();
    } else {
      await pendingSave;
    }
  };

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
    // Callers that are about to tear this session down (planned
    // disconnect, reconnect-with-new-socket, process exit) should await
    // this first so a key generated in the last 500ms isn't lost.
    flush,
  };
}
