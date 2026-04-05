# Recently Shipped

Last 2 weeks only. Older items get pruned.

---

[← Overview](./1-overview.md) | **Shipped** | [Tickets](./3-tickets.md) | [Backlog](./4-backlog.md)

---

- **Apr 2, BetterStack log volume investigation (080):** Found dashboard MiniApp (241 GB) and captions MiniApp (83 GB) flooding Vector. Not cloud, it's app stdout from automated testing.
- **Mar 31, Hot-path allocation reduction (075):** Reduce JSC heap fragmentation by reusing objects on hot paths instead of allocating new ones every cycle.
- **Mar 30, Session timer leak fix (OOM root cause):** Leaked timers were pinning disposed UserSession objects in memory, preventing GC. This was the actual root cause of the OOM crashes.
- **Mar 30, Dashboard layout fixes (047):** Model-aware layout resolves display profile from connected glasses. Stacked layout for narrow displays (Z100/Mach1). Weather anchored at 50% midpoint. Header column alignment fixed.
- **Mar 29, Soniox timeout crash fix (070):** Global `process.on("unhandledRejection")` handler prevents exit-code-1 crashes from any unhandled rejection.
- **Mar 29, WS disconnect observability (069):** Structured logging proving client vs. server disconnect cause. 5 new UserSession fields, 3 new log events.
- **Mar 29, ResourceTracker crash fix (068):** `track()` on disposed tracker no longer throws, preventing cascading process exits.
- **Mar 29, Prometheus metrics scraping:** Session count, event loop lag, UDP stats visible in Porter dashboard.
- **Mar 29, Separate liveness and readiness probes:** `/livez` is zero-computation with 3s timeout. `/health` stays as the readiness check.
- **Mar 29, Removed forced GC on disconnect:** Confirmed wasteful (2.2s/hr blocking, 0 bytes freed). Was contributing to liveness probe failures.
- **Mar 29, US West deploy workflow + Vector Helm chart:** Infrastructure for US West region log collection.
- **Mar 29, Runbooks:** Pod-crash, weekly-error-audit, and client-disconnect investigation SOPs.
- **Mar 29, SRT replacing RTMP:** Livestreaming transport upgrade with backward compat for old SDK message types.
- **Mar 28, Graceful shutdown (063):** SIGTERM/SIGINT handler sends WS close frames to all clients, `/health` returns 503 during drain, global drain middleware rejects all REST requests. Deploy disruption reduced from 30-60s to <2s.
- **Mar 28, MongoDB audit + app cache + diagnostics (062):** In-memory app cache eliminates hot-path DB round-trips. Event loop gap detector. MongoDB operation timing. Cumulative blocking metrics in system vitals.
- **Mar 28, Vector logging (067):** Replaced @logtail/pino with Vector log collection via stdout JSON. Eliminated heap growth from the old pino transport. Structured field normalization.
- **Mar 27, Crash diagnostics (061):** GC probe (60s forced GC with timing), health endpoint timing, Soniox audio send timing, connection counting in system vitals, Mongoose slow-query monitoring.
- **Mar 26, Observability overhaul + 5 memory leak fixes (057):** BetterStack integration, system vitals logging, heap tracking. Fixed: ManagedStreamingExtension interval leak, SonioxSdkStream listener leak, 4 missing manager dispose calls, identity-blind session map delete, email case normalization.

---

[← Overview](./1-overview.md) | [Tickets →](./3-tickets.md)
