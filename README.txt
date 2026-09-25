bot-template - auth state save race condition fix

Files:
src/lib/remoteAuthState.js -> replace your existing file
src/lib/connection.js      -> replace your existing file

THE BUG (this is the cause of the "failed to find key to decode
mutation" / "Bad MAC" / "No matching sessions found" errors you saw
right after a fresh, successful pairing):

useRemoteAuthState() debounced every key/creds write by 500ms - each
new key generated resets a setTimeout, so a burst of activity (which
Baileys does heavily right after connecting: app-state sync, pre-key
generation, session establishment) only actually writes once, after
things settle.

That's fine as long as the process stays alive. But every reconnect
calls startBot() again, which calls useRemoteAuthState() again, which
creates a BRAND NEW keyStore object and a brand new save-timer closure.
If a reconnect happened while the OLD closure still had a save pending
(inside that 500ms window), the old closure - and its never-fired save
- was simply abandoned. Every key generated since the last successful
write was silently lost, even though Baileys had already used those
keys in memory to encrypt/decrypt real traffic. The next connection
then had no record of a key WhatsApp's servers had already seen used,
which is exactly what "failed to find key to decode mutation" and
"Bad MAC" mean.

Your logs showed "attempt: 2" on every line, meaning a reconnect had
already happened - consistent with this exact race.

THE FIX:

- remoteAuthState.js now returns a flush() function alongside state and
  saveCreds. Calling it either fires the pending debounced save
  immediately and awaits it, or awaits whatever save is already in
  flight. Nothing is dropped.
- connection.js now calls await flush() at the very top of the
  connection === "close" handler, before any of the existing
  401/403/reconnect branches run. This covers every path that leads to
  a fresh startBot() call, including the disconnect-signal "repair"
  path (sock.end() internally emits the same connection.update close
  event, confirmed by reading Baileys' own socket.js).

Verified with an isolated simulation: scheduled two key writes, forced
a "reconnect" at 100ms (well before the natural 500ms debounce would
fire), called flush(), confirmed both keys were persisted immediately
instead of being lost.

Sessions paired or that reconnected before this fix may already have
gaps in their stored keys from this bug. If a session keeps throwing
these decrypt errors after deploying this fix, re-pairing it is the
clean way to reset it; new activity going forward won't lose keys this
way regardless.
