# Issue 107 Spec: Prevent Reconnect Storm Crashes

## Goal

Prevent the cloud pod from becoming unresponsive when many glasses/client and miniapp WebSockets reconnect at the same time.

The primary strategy is simple:

> Reconnect should reattach transport, not recompute session truth.

The reconnect path should use already-known session state wherever possible. Expensive refreshes should happen on actual state changes, not on every reconnect.

## Non-Goals

- Do not solve the root cause of the initial code-1006 socket drop in this PR.
- Do not redesign the entire AppManager.
- Do not change miniapp protocol semantics unless required for correctness.
- Do not remove existing observability.
- Do not make Kubernetes liveness much looser as the primary fix.

## Current Problem

During the May 11, 2026 prod incident, a broad socket drop was followed by reconnect work:

- 62 glasses/client socket closes with code 1006 in one second
- 47-49 app socket closes with code 1006
- 29 users reconnected roughly 6 seconds later
- 72 slow app-connect logs fired across 29 users and 11 packages
- slow phase was dominated by `connection_init -> broadcastAppState -> refreshInstalledApps`
- pod stopped answering `/health` and `/livez`
- Kubernetes restarted the container with exit 137 after liveness failures

The expensive path today:

```text
app reconnect
  -> attachAppSocket()
  -> connection ack
  -> broadcastAppState()
  -> refreshInstalledApps()
  -> appService.getAllApps(userId)
  -> User.findOne(...)
  -> App.find(...)
```

That is too much work to repeat during reconnect storms.

## Design Principles

1. Reconnect must be idempotent.
2. Reconnect must avoid DB reads unless state is actually missing.
3. Reconnect must avoid DB writes unless state changed.
4. Duplicate app-state broadcasts should collapse into one.
5. Health checks must remain responsive during reconnect storms.
6. Storm protection should be a safety net, not the first line of defense.

## Proposed Changes

### S1: Stop Refreshing Installed Apps on Every App-State Broadcast

Change `AppManager.broadcastAppState()` so it does not automatically call `refreshInstalledApps()`.

Instead, `broadcastAppState()` should use `userSession.installedApps`, which is already populated on session creation.

Allowed refresh points:

- session creation
- app install
- app uninstall
- app settings changes that affect app list/state
- explicit client refresh route if one exists
- fallback if `userSession.installedApps` is empty or clearly uninitialized

Implementation shape:

```ts
async broadcastAppState(options?: { refreshInstalledApps?: boolean }): Promise<AppStateChange | null> {
  if (options?.refreshInstalledApps || this.userSession.installedApps.size === 0) {
    await this.refreshInstalledApps();
  }

  ...
}
```

Default behavior should be no refresh.

Call sites that actually mutate installed apps should pass `refreshInstalledApps: true` or call `refreshInstalledApps()` before broadcasting.

### S2: Coalesce App-State Broadcasts Per User Session

Add a per-`AppManager` broadcast scheduler so repeated calls collapse into one broadcast over a short window.

Recommended window: 100-250ms.

Behavior:

- first call schedules a broadcast
- duplicate calls while scheduled do not start new work
- if a refresh is requested by any caller, the scheduled broadcast includes one refresh
- callers do not need to await unless they need a return value

Implementation shape:

```ts
private appStateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
private pendingAppStateRefresh = false;

scheduleBroadcastAppState(options?: { refreshInstalledApps?: boolean }): void {
  this.pendingAppStateRefresh ||= Boolean(options?.refreshInstalledApps);
  if (this.appStateBroadcastTimer) return;

  this.appStateBroadcastTimer = setTimeout(async () => {
    this.appStateBroadcastTimer = null;
    const refreshInstalledApps = this.pendingAppStateRefresh;
    this.pendingAppStateRefresh = false;
    await this.broadcastAppState({ refreshInstalledApps });
  }, 150);
}
```

Use `unref()` where available so timers do not block shutdown.

### S3: Make App Reconnect Avoid App-State Refresh

For `connection_init` and other reconnect attach paths:

- attach the socket
- send ACK
- send device/session snapshot as needed
- do not refresh installed apps
- schedule a coalesced app-state broadcast using cached state

If app state did not actually change, consider skipping the broadcast entirely.

Rule of thumb:

```text
new app started -> broadcast app state
existing app socket reattached -> do not recompute app state
```

### S4: Make `addRunningApp(packageName)` Idempotent or Backgrounded

`attachAppSocket()` currently calls:

```ts
await user.addRunningApp(packageName);
```

During reconnect, this is likely unnecessary if the app is already known running.

Change behavior so reconnect does not block on this write:

Option A:

- check in-memory session/app state first
- only call `addRunningApp` if the app was not already running

Option B:

- fire-and-log in the background after ACK
- keep the socket attach path fast

Preferred: A where easy, B where correctness requires eventual persistence.

Implementation note for this PR:

- compute whether the app was already expected to be running before calling `handleConnect(ws)`
- skip `addRunningApp(packageName)` when the app was already running, dormant, or in grace period
- keep the write on the first real attach/start path

### S4.5: Reuse App-Specific Settings on Reconnect

`attachAppSocket()` also reads the user document to get app-specific settings before sending `CONNECTION_ACK`.

During reconnect, the active session can reuse settings it already loaded for that app. Keep an in-memory per-`AppManager` settings cache:

```text
first attach for package -> read user settings and cache them
settings update route -> update user settings and refresh the active session cache
already-running reconnect -> reuse cached settings
```

Fallback behavior:

- if settings are missing from the cache, read from the user document
- if app settings are updated while a session is active, update the cache before sending the settings update message

This keeps reconnect cheap without changing the settings protocol.

### S5: Keep `refreshInstalledApps()` But Make Its Use Intentional

Do not delete `refreshInstalledApps()`. It is still useful when the app list may be stale.

Add call-site comments or function names to make intent clear:

- `refreshInstalledAppsFromDb()`
- `broadcastAppState({ refreshInstalledApps: true })`
- `scheduleBroadcastAppState({ refreshInstalledApps: true })`

The goal is to make accidental DB refresh on reconnect hard to reintroduce.

### S6: Add Reconnect Storm Safety Net

After S1-S5, add a lightweight safety guard.

Track per-pod reconnect pressure over a short rolling window:

- app WebSocket reconnects
- glasses/client reconnects
- app WebSocket closes with 1006
- glasses/client closes with 1006

If thresholds are exceeded, log `reconnect-storm-detected` and force reconnect work into cheap mode:

- no installed-app refresh
- coalesced app-state broadcasts only
- no blocking DB writes in reconnect path

Suggested initial thresholds:

```text
50 socket closes with code 1006 in 10 seconds
or
25 reconnects in 10 seconds
```

This should be a belt-and-suspenders guard. The normal reconnect path should already be cheap without it.

### S7: Keep Health Checks Minimal

Do not make liveness do app/session work.

Verify:

- `/livez` is a minimal process-alive check
- `/health` can include slightly richer checks, but should not block behind reconnect processing

If needed, tune liveness only after S1-S6:

- readiness can fail during short pressure
- liveness should only fail when the process is truly wedged

## Files Likely Touched

Expected implementation files:

- `cloud/packages/cloud/src/services/session/AppManager.ts`
- `cloud/packages/cloud/src/services/core/app.service.ts` only if helper naming or caching changes are needed
- app install/uninstall/settings route files that call `broadcastAppState()`
- tests under `cloud/tests/` or existing cloud package test location
- local harness under `cloud/tools/ws-storm-local/` if committed/available

## Test Plan

### Unit Tests

Add tests for `AppManager` behavior:

1. `broadcastAppState()` does not call `refreshInstalledApps()` by default.
2. `broadcastAppState({ refreshInstalledApps: true })` calls refresh once.
3. repeated scheduled broadcasts coalesce into one.
4. if any coalesced call requests refresh, the final broadcast refreshes once.
5. reconnect attach does not block on installed-app refresh.
6. reconnect attach does not call `addRunningApp` if app is already running.
7. reconnect attach reuses cached app-specific settings after the first successful attach.
8. active-session settings cache updates when the app settings route saves new settings.

### Integration / Harness Tests

Use or add a reconnect-storm harness:

1. start cloud locally or in debug
2. create 50-100 app/glasses WebSocket connections
3. close them with code 1006 or abrupt socket termination
4. reconnect them within 5-10 seconds
5. poll `/livez` and `/health` during the storm

Acceptance:

- `/livez` remains responsive
- no container restart
- no multi-minute vitals gap
- slow `connection_init` count drops sharply
- no repeated `refreshInstalledApps` per app reconnect
- no repeated user settings read per already-running app reconnect
- app state is eventually correct

### Production Verification

After deployment to debug/staging:

Run BetterStack queries during natural reconnects and synthetic debug tests.

Expected improvements:

- `slow-app-connect` decreases in count and duration
- `broadcast_app_state` is no longer dominated by `refreshInstalledApps` during reconnect
- no health timeout during reconnect bursts
- DB slow-query volume does not spike during reconnect

## Rollout Plan

1. Branch from `staging`.
2. Implement S1-S5 first.
3. Add S6 storm guard only after reconnect path is cheap.
4. Deploy to cloud-debug.
5. Run reconnect-storm harness.
6. Soak on cloud-debug.
7. PR to `staging`.
8. Soak staging.
9. Promote staging to main.
10. Back-merge staging to dev.

## Acceptance Criteria

This issue is done when:

- reconnect no longer refreshes installed apps unless explicitly requested
- duplicate app-state broadcasts are coalesced
- app reconnect does not block on unnecessary DB writes
- reconnect storm harness cannot make `/livez` time out
- BetterStack shows reconnect storms as degraded/recovering, not pod-killing
- the next natural 1006 storm does not restart the pod

## Risks

### Stale installed apps

Risk: if installed apps are not refreshed on reconnect, app state may be stale after install/uninstall.

Mitigation: refresh on actual install/uninstall/settings mutation paths, not reconnect.

### Missing app-state broadcast

Risk: if reconnect skips or coalesces broadcasts too aggressively, the client may not learn current state.

Mitigation: use cached state and send one coalesced broadcast after reconnect settles.

### Background DB write failure

Risk: if `addRunningApp` is backgrounded, persistence failures could be missed.

Mitigation: log failures and keep in-memory session state as source of truth during active session.

### Timer lifecycle leaks

Risk: coalescing timers could survive disposed sessions.

Mitigation: clear timers in `AppManager.dispose()` / `UserSession.dispose()`.

## Follow-Up Questions

1. Should `broadcastAppState()` be renamed so it is clear whether it reads DB?
2. Should app-state broadcast include a reason field for observability?
3. Should `refreshInstalledApps` have its own slow diagnostic with user hash and call-site reason?
4. Should app reconnect ACK be sent before any persistence work?
5. Should app WebSocket reconnects have jitter/backoff guidance in the SDK?
