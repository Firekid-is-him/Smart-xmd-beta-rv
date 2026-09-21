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

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await workerApi.setAuthState(serialize(creds), serialize(keyStore));
      } catch (err) {
        console.error("[auth] failed to persist creds:", err.message);
      }
    }, 500);
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
  };
}
