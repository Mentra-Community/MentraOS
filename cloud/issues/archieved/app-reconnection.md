# App reconnection and resurrection — scenarios and plan

Context: Current logic conflates reconnect (SDK-driven) and resurrection (server-driven). We want clearer semantics without large code changes right now.

## Scenarios

1. Cloud restarts
   - Cloud WS endpoints restart; apps must reconnect.
   - Desired: SDK reconnects quickly; server stays in GRACE_PERIOD, no resurrection.

2. App server restarts
   - App process restarts or deploys; requires a fresh connect.
   - Desired: If cloud is up, RESURRECTING may be needed if SDK doesn’t reconnect in time.

3. Transient WS drop
   - Network hiccup; both cloud and app state are still valid.
   - Desired: SDK reconnects; server treats as reconnect; no resurrection.

## Terms

- Connect: first attach of a packageName within a user session.
- Reconnect: SDK re-attaches after a WS loss for the same packageName.
- Resurrection: server-initiated restart (webhook) after grace window expires.

## Low-risk improvements (now)

- Introduce reconnectGraceMs (5–8s): on close, transition to GRACE_PERIOD and wait; do not resurrect during grace.
- If SDK reconnects within grace: treat as reconnect; keep per-app state (subs, correlation), cancel timers.
- After grace: transition to DISCONNECTED, optionally schedule resurrection with jittered backoff (to avoid thundering herds).
- Add optional init.reconnect hint in SDK payloads; if absent, infer reconnect from recent GRACE_PERIOD.

## Sketch (behavior only)

```ts
// On close
setState(pkg, GRACE_PERIOD);
timers.set(
  pkg,
  setTimeout(() => {
    if (state(pkg) === GRACE_PERIOD) {
      setState(pkg, DISCONNECTED);
      scheduleResurrectionWithJitter(pkg);
    }
  }, reconnectGraceMs),
);

// On init
const isReconnect = Boolean(init.reconnect) || wasRecentlyInGrace(pkg);
if (isReconnect) {
  attachExistingSession(pkg, ws, init); // retain subs and correlation
  cancelTimers(pkg);
  setState(pkg, RUNNING);
} else {
  createOrAttachNewSession(pkg, ws, init);
  setState(pkg, RUNNING);
}
```

## Future (optional, later)

- Explicit reconnect tokens (issued by AppManager, presented by SDK) to bind reconnects tightly and reject stale connections.
- More granular states (e.g., BACKOFF, EVICTED) and a per-app circuit breaker.
- Persist minimal per-app state to survive cloud restarts without losing subscriptions.
- Metrics: reconnect success rate, average reconnect latency, resurrection rate, false resurrection rate.
