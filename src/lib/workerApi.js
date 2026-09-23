const WORKER_URL = process.env.WORKER_URL;
const SESSION_ID = process.env.SESSION_ID;
const FIREKID_KEY = process.env.FIREKID_KEY;

if (!WORKER_URL || !SESSION_ID || !FIREKID_KEY) {
  throw new Error("WORKER_URL, SESSION_ID, and FIREKID_KEY env vars are required.");
}

function headers() {
  return {
    "Content-Type": "application/json",
    "X-Session-Id": SESSION_ID,
    "X-Firekid-Key": FIREKID_KEY,
  };
}

async function request(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `Worker call failed: ${path}`);
    err.status = res.status;
    err.code = body?.error;
    throw err;
  }
  return body?.data;
}

export const workerApi = {
  getAuthState: () => request("/bot/session/get").catch((e) => (e.status === 404 ? null : Promise.reject(e))),
  setAuthState: (creds, keys, epoch) =>
    request("/bot/session/set", { method: "POST", body: JSON.stringify({ creds, keys, epoch }) }),

  heartbeat: () => request("/sessions/heartbeat", { method: "POST" }),

  shouldSendWelcome: () => request("/sessions/should-send-welcome"),
  markWelcomeSent: () => request("/sessions/mark-welcome-sent", { method: "POST" }),

  getDisconnectSignal: () => request("/sessions/disconnect-signal"),
  resolveDisconnectSignal: (signalId) =>
    request(`/sessions/disconnect-signal/${signalId}/resolve`, { method: "POST" }),

  setFileMode: (fileMode) => request("/sessions/mode", { method: "POST", body: JSON.stringify({ fileMode }) }),

  isSudo: (jid) => request(`/sessions/is-sudo?jid=${encodeURIComponent(jid)}`),

  isOwner: (jid) => request(`/bot/is-owner?jid=${encodeURIComponent(jid)}`),

  getPrefixes: () => request("/sessions/prefixes/bot"),

  getCommandBundle: () => request("/bot/commands"),

  modeCheck: (jid) => request(`/bot/mode-check?jid=${encodeURIComponent(jid)}`),

  consumeAdminToken: (token, action) =>
    request("/admin/tokens/consume", { method: "POST", body: JSON.stringify({ token, action }) }),

  getGroupSettings: (groupJid) => request(`/groups/${encodeURIComponent(groupJid)}/settings`),
  patchGroupSettings: (groupJid, patch) =>
    request(`/groups/${encodeURIComponent(groupJid)}/settings`, { method: "PATCH", body: JSON.stringify(patch) }),

  incrementWarn: (groupJid, memberJid) =>
    request(`/groups/${encodeURIComponent(groupJid)}/warns/${encodeURIComponent(memberJid)}/increment`, {
      method: "POST",
    }),
  resetWarn: (groupJid, memberJid) =>
    request(`/groups/${encodeURIComponent(groupJid)}/warns/${encodeURIComponent(memberJid)}/reset`, {
      method: "POST",
    }),
  getWarns: (groupJid) => request(`/groups/${encodeURIComponent(groupJid)}/warns`),

  getEconomy: (jid) => request(`/bot/economy/${encodeURIComponent(jid)}`),
  patchEconomy: (jid, patch) =>
    request(`/bot/economy/${encodeURIComponent(jid)}`, { method: "PATCH", body: JSON.stringify(patch) }),

  isBlacklisted: (jid) => request(`/groups/blacklist`).then((r) => r.blacklist.some((b) => b.jid === jid)),
  addBlacklist: (jid, reason) =>
    request(`/groups/blacklist`, { method: "POST", body: JSON.stringify({ jid, reason }) }),
  removeBlacklist: (jid) => request(`/groups/blacklist/${encodeURIComponent(jid)}`, { method: "DELETE" }),

  addSudo: (jid, addedBy) =>
    request(`/sessions/sudo/bot-add`, { method: "POST", body: JSON.stringify({ jid, addedBy }) }),
};

export { SESSION_ID, FIREKID_KEY, WORKER_URL };
