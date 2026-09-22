bot-template self-ping, reapplied to your latest upload

Files:
src/index.js       -> replace your existing file
src/lib/health.js  -> new file, add it
render.yaml        -> replace your existing file (repo root)

What changed:
Your latest upload didn't have the self-ping from before (it's a copy
from an earlier point, before I added it), and render.yaml was back to
type: worker, which has no public URL for the ping to hit. Reapplied
both on top of this version:

- health.js: plain Node http server, GET / and GET /health return
  {"ok":true,...}. No new dependency.
- index.js: starts the health server and the 12-minute self-ping
  alongside startBot().
- render.yaml: type changed from worker to web, so Render actually
  gives this service a public URL and a PORT.

Untouched, not part of this fix: I noticed WORKER_URL is now hardcoded
in workerApi.js instead of read from env, and dropped from render.yaml's
envVars. That looks like your own deliberate change from whatever you
added for limit enforcement, so I left it exactly as you have it.

Uses process.env.RENDER_EXTERNAL_URL (set automatically by Render on
every web service). Falls back to SELF_PING_URL if unset. First ping
fires 30 seconds after boot, then every 12 minutes.
