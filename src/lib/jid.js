// Normalizes a WhatsApp JID to its phone-number (PN) form whenever a PN
// alternative is available, so identity comparisons (owner check, sudo
// check) don't silently fail just because a given message happened to be
// addressed via @lid instead of @s.whatsapp.net.
//
// Baileys 7.0.0-rc attaches the PN counterpart directly on the message key
// when it knows one — participantAlt / senderPn for participants,
// remoteJidAlt for the chat itself — so this reads that instead of doing
// any async lookup (lid-mapping.update is unreliable and doesn't fire for
// every message; see Baileys #2263, #2414, #2551). No network calls here on
// purpose: this runs on every single incoming message, and anything that
// added a request per message would be a real risk of hammering the worker
// (and by extension WhatsApp, since that traffic rides the same account) on
// a busy chat.
//
// Falls back to the given jid unchanged when no PN alt is known — matches
// prior behavior for the (common, expected) case where the jid was never
// an @lid in the first place.
export function normalizeJid(jid, altJid) {
  if (!jid) return jid;
  if (jid.endsWith("@lid") && altJid) return altJid;
  return jid;
}

// Resolves the best-known identity JID for whoever sent a message, given
// the raw message key. Mirrors the same participant-then-remoteJid
// fallback handler.js already used, just alt-aware:
// - group message: key.participant (+ key.participantAlt)
// - DM: key.remoteJid (+ key.remoteJidAlt)
export function resolveFromJid(key) {
  if (key.participant) return normalizeJid(key.participant, key.participantAlt);
  return normalizeJid(key.remoteJid, key.remoteJidAlt);
}
