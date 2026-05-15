# Issue 107 Design: Cheap Reconnects Under WebSocket Storms

## Plain-English Summary

The cloud pod crashed because too many sockets reconnected at once and each reconnect repeated work that did not need to happen during reconnect.

The fix is to make reconnect boring:

> Reconnect should restore the wire, not rediscover the world.

When a miniapp reconnects, cloud already knows the user's session, installed apps, running apps, and subscriptions in memory. Reconnect should attach the new WebSocket, send the app its acknowledgment, and reuse that known state. Database refreshes and broad app-state broadcasts should happen when state actually changes, such as install, uninstall, start, stop, or settings change.

## Failure Mode

On May 11, 2026, us-central prod saw a broad WebSocket drop:

- 62 glasses/client sockets closed with code 1006 in one second.
- 47-49 miniapp sockets closed with code 1006 in the same window.
- 29 users reconnected about 6 seconds later.
- 72 slow app-connect logs fired across 29 users and 11 packages.
- The slow path was `connection_init -> broadcastAppState -> refreshInstalledApps`.
- The pod stopped answering `/health` and `/livez`.
- Kubernetes killed the container with exit 137 after liveness probe failures.

This is a WebSocket reconnect storm with thundering-herd amplification. The original socket drop may be network or infrastructure related, but cloud made the recovery worse by doing too much repeated work at the same time.

## Current Hot Path

Today, app reconnect/init can do this:

```text
miniapp websocket connects
  -> AppManager.handleAppInit()
  -> attachAppSocket()
  -> send ACK and state snapshot
  -> broadcastAppState()
  -> refreshInstalledApps()
  -> appService.getAllApps(userId)
  -> User.findOne(...)
  -> App.find(...)
```

That DB-backed refresh is useful when the installed app list may have changed. It is wasteful during ordinary reconnect because the session already has `userSession.installedApps`, populated when the session was created.

## Design Principles

1. Reconnect must be cheap all the time, not only during storm mode.
2. Refresh from the database only when state may actually be stale.
3. Collapse duplicate app-state broadcasts for the same user.
4. Preserve protocol behavior for apps and clients.
5. Keep observability so the next storm proves whether the fix worked.

## Proposed Fix

### 1. Make Installed-App Refresh Explicit

Change `broadcastAppState()` so it does not automatically call `refreshInstalledApps()`.

Default behavior:

```text
broadcastAppState()
  -> use cached userSession.installedApps
  -> snapshot session
  -> send APP_STATE_CHANGE
```

Explicit refresh behavior:

```text
broadcastAppState({ refreshInstalledApps: true })
  -> refreshInstalledApps()
  -> snapshot session
  -> send APP_STATE_CHANGE
```

The fallback should still refresh if `userSession.installedApps` is empty, because an empty cache may mean the session failed to bootstrap correctly.

### 2. Coalesce Duplicate Broadcasts

Add a per-user-session scheduler:

```text
scheduleBroadcastAppState()
  -> if one is already scheduled, do nothing
  -> otherwise wait briefly, then call broadcastAppState()
```

Recommended delay: 150 ms.

If any caller requests a refresh while a broadcast is pending, the scheduled broadcast does one refresh, not many.

### 3. Treat Reconnect Differently From State Change

For app `connection_init` and reconnect paths:

```text
attach socket
send ACK
send current device/session snapshot
schedule a cheap app-state broadcast from cached state
```

Do not refresh installed apps from Mongo just because a socket reattached.

### 4. Reuse Per-App Settings After First Attach

The app ACK includes app-specific settings. On first attach, cloud can read those settings from the user document and cache them in the active `AppManager`.

On later reconnects for an app that was already running, cloud should reuse that cache instead of reading the user document again. If the user changes settings while the session is active, the settings route should update both Mongo and the active in-memory cache before sending the settings update.

This keeps reconnect cheap while preserving correctness:

```text
first attach -> load settings from user document
settings changed -> update document and active-session cache
reconnect -> reuse active-session cache
cache missing -> fall back to user document
```

### 5. Avoid Redundant Running-App Writes

`addRunningApp(packageName)` should remain on the first real app attach/start path, but reconnect should skip it when in-memory app state already says the app is running, dormant, or in grace period.

The database should record actual state changes. It should not be required for restoring a socket that cloud already expected to exist.

### 6. Refresh on Real State Changes

Callers that can change installed or running state should request an explicit refresh when needed.

Examples:

- install app: refresh before broadcasting
- uninstall app: refresh before or after stop flow
- start app: broadcast cached state, because start changes running state, not installed app list
- stop app: broadcast cached state, because stop changes running state, not installed app list

## Reconnect Storm Guard

The storm guard is a backup fuse, not the primary fix.

It should detect bursts like:

```text
50 socket closes with code 1006 in 10 seconds
or
25 reconnects in 10 seconds
```

During the guard window, reconnect work must stay in cheap mode:

- no installed-app refresh
- coalesced app-state broadcasts only
- no best-effort cleanup or repair loops inline

This PR can ship the cheap reconnect fix first. If the implementation already makes reconnect cheap in normal mode, the guard can be added as a smaller follow-up or included only as logging.

## Test Strategy

### Unit/Behavior Tests

Add tests around `AppManager` behavior:

1. `broadcastAppState()` does not call `refreshInstalledApps()` by default.
2. `broadcastAppState({ refreshInstalledApps: true })` refreshes once.
3. duplicate scheduled broadcasts collapse into one broadcast.
4. app init schedules a cheap broadcast instead of awaiting a DB-backed refresh.

### Local Harness

Add or update a local harness that simulates:

- many users
- many apps per user
- app WebSocket init/reconnect bursts
- artificial delay inside installed-app refresh

The before/after signal should be:

```text
before: reconnect burst runs one installed-app refresh per app connection
after: reconnect burst runs zero refreshes on reconnect, or one coalesced refresh only when explicitly requested
```

The harness does not need to perfectly recreate Porter or AKS. It only needs to prove the cloud reconnect path no longer amplifies a socket storm into repeated DB-backed work.

The local sync-pressure comparison added for this issue showed:

```text
origin/staging: 56 reconnects caused a 2737 ms event-loop heartbeat gap
cheap reconnect, realistic warm reconnect: 56 reconnects caused about a 230 ms max round heartbeat gap
```

That is enough to show we reproduced the process-level health-check failure shape locally and removed the specific reconnect amplification we saw in prod logs.

## Success Criteria

Under a local reconnect burst comparable to the May 11 incident:

- app reconnect ACKs are still sent
- installed-app refresh count is near zero for reconnect-only traffic
- already-running reconnects do not reread user settings
- already-running reconnects do not rewrite running-app state
- duplicate app-state broadcasts collapse per user
- event loop remains responsive enough for health checks
- slow `connection_init` logs no longer show `refreshInstalledApps` as the dominant phase

## Rollout

1. Branch from `staging`.
2. Ship to cloud-debug first.
3. Simulate reconnect storms against debug if practical.
4. Watch `slow-app-connect`, `event-loop-delay`, health checks, and reconnect logs.
5. Promote through staging before main.

## Open Questions

1. Should uninstall call a second explicit broadcast after `stopApp()` so the installed app list refresh is guaranteed?
2. Should `validateApiKey` get a per-package cache if debug/staging shows it becomes the next storm bottleneck?
3. Should the storm guard be implemented now, or should this PR focus on making normal reconnect cheap and leave guard logging for the next PR?
