# Recently Shipped

Last 2 weeks only. Older items get pruned.

---

[← Overview](./overview.md) | **Shipped** | [Work](./work.md) | [OKRs](./okrs.md)

---

- **Apr 8, SDK v3 Alpha.2:** Published `@mentra/sdk@3.0.0-alpha.2` to npm. All 14 session managers built, v2 compat shims in place, build passes.
- **Apr 8, Cloud v3 merged:** Branch `cloud/issues-048` / PR #2326 merged to dev. Cloud-side v3 changes are live. Backward compatible with v2 SDK apps.
- **Apr 5, Dashboard and Captions log cleanup:** Reduced excessive stdout from dashboard and captions mini apps that were flooding log collection.
- **Apr 4, BetterStack duplicate collector fix (081):** Applied VRL container filter to US Central collector (99.7% log volume reduction, ~40K to ~130 logs/min). Enabled collectors on all four regional clusters with same filter. Was incurring significant daily cost.
- **Apr 2, Streamer cloud/SDK bug fixes:** Fixed managed streaming regressions for v2 SDK apps on the debug cloud.
- **Mar 31, Hot-path allocation reduction (075):** Reuse objects on hot paths instead of allocating new ones every cycle. Reduces JSC heap fragmentation.
- **Mar 30, Session timer leak fix (OOM root cause):** Leaked timers were pinning disposed UserSession objects in memory, preventing GC. This was the actual root cause of the OOM crashes.
- **Mar 30, Dashboard layout fixes (047):** Model-aware layout resolves display profile from connected glasses. Stacked layout for narrow displays. Weather anchored at 50% midpoint.
- **Mar 29, Soniox timeout crash fix (070):** Global `process.on("unhandledRejection")` handler prevents exit-code-1 crashes from any unhandled rejection.
- **Mar 29, WS disconnect observability (069):** Structured logging proving client vs. server disconnect cause. 5 new UserSession fields, 3 new log events.
- **Mar 29, ResourceTracker crash fix (068):** `track()` on disposed tracker no longer throws, preventing cascading process exits.
- **Mar 28, Graceful shutdown (063):** SIGTERM/SIGINT handler sends WS close frames to all clients, `/health` returns 503 during drain. Deploy disruption reduced from 30-60s to <2s.
- **Mar 28, Vector logging (067):** Replaced @logtail/pino with Vector log collection via stdout JSON. Eliminated heap growth from the old pino transport.

---

[← Overview](./overview.md) | [Work →](./work.md)
