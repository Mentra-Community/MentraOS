# Issue 063 — Graceful Shutdown (SUPERSEDED by 100)

This issue shipped a SIGTERM handler that attempted a graceful shutdown: close WebSockets, stop timers, close Mongo, wait 2 s for frame flush, exit. See `spec.md` for the original design.

In prod it produced `exit 137` (Kubernetes SIGKILL after the 30 s grace period elapsed) and the handler's Pino log lines never appeared in BetterStack across 7 days of pod restarts — suggesting Pino's async buffering never flushed before the process exited.

Superseded by [cloud/issues/100-fail-fast-sigterm/](../100-fail-fast-sigterm/) which:

- Uses synchronous `process.stderr.write` for start / complete announcements so shutdown events always reach container logs.
- Closes WebSockets with code 1001 (same as before).
- Fires Mongo close as fire-and-forget, does not await.
- Flushes Pino with a 500 ms timeout.
- Arms a 5 s watchdog that `process.exit(1)`s if anything hangs.
- Drops `terminationGracePeriodSeconds` from 30 to 10 in `porter.yaml`.

The original `spec.md` is preserved for historical context.
