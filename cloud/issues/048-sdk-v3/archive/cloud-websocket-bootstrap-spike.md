# Spike: Cloud WebSocket Bootstrap & UserSession Ownership

**Issue:** 048  
**Related:** [SDK v3 spike](./spike.md), [Mini App Reconnection & Session Architecture](./reconnection-architecture-spike.md), [Private Runtime Architecture](./private-runtime-architecture.md)  
**Status:** Spike  
**Date:** 2026-03-19

---

## Why This Spike Exists

Before changing cloud-side reconnect and resurrection behavior for SDK v3, we need a precise view of how the cloud currently creates `UserSession`s, how glasses and mini app WebSockets are authenticated, and what happens when an app reconnects before the user's mobile/glasses connection is restored.

The core question is:

- should the cloud create a `UserSession` when only a mini app reconnects, even if the mobile/glasses WebSocket has not reconnected yet?

This spike documents the current implementation and the architectural implications of that decision.

---

## Current WebSocket Entry Points

The active Bun-native WebSocket implementation lives in:

- [`cloud/packages/cloud/src/services/websocket/bun-websocket.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/bun-websocket.ts)

It exposes two WebSocket upgrade paths:

- `/glasses-ws`
- `/app-ws`

There are older `ws`-package services in:

- [`cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts)
- [`cloud/packages/cloud/src/services/websocket/websocket-app.service.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/websocket-app.service.ts)

Those follow the same broad lifecycle model, but the Bun path is the active one we should treat as authoritative for current behavior.

---

## Current Ownership Model

### `UserSession` is created by the glasses/mobile connection

Today, `UserSession` is created or reattached only from the `/glasses-ws` path.

Flow:

1. `/glasses-ws` upgrade validates the core JWT.
2. The token subject is effectively the current `userId` key.
3. `handleGlassesOpen()` calls `UserSession.createOrReconnect(ws, userId)`.
4. If an existing session is present in the in-memory static map, it is reused and its WebSocket is replaced.
5. Otherwise a fresh `UserSession` is created and registered in `UserSession.sessions`.

Relevant code:

- [`bun-websocket.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/bun-websocket.ts)
- [`UserSession.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/session/UserSession.ts)

Important consequence:

- the cloud currently treats `UserSession` as the user's active connection to this cloud, anchored by the glasses/mobile WebSocket
- mini app connections do not independently establish user presence

### `UserSession` persists briefly after glasses disconnect

When the glasses WebSocket closes:

1. `userSession.disconnectedAt` is set
2. a 1-minute cleanup timer starts
3. if the user reconnects before timeout, the existing `UserSession` is reused
4. if not, `userSession.dispose()` runs and removes it from the static map

This means the cloud already has a temporary "user session exists without active glasses socket" state, but it is implicit, not modeled as an explicit lifecycle state.

Relevant code:

- [`bun-websocket.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/bun-websocket.ts)
- [`UserSession.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/session/UserSession.ts)

---

## Current Mini App Connection Behavior

### `/app-ws` never creates `UserSession`

Mini app WebSocket connections are accepted at the transport level, but they do not create a `UserSession`.

Current behavior:

1. app connects to `/app-ws`
2. cloud authenticates via JWT headers or legacy `CONNECTION_INIT`
3. cloud extracts `userId` and `sessionId`
4. cloud calls `UserSession.getById(userId)`
5. if no `UserSession` exists, cloud sends `CONNECTION_ERROR` with `SESSION_NOT_FOUND`
6. the app socket is closed or ignored depending on path

This is true for both:

- JWT-based init on socket open
- legacy `CONNECTION_INIT` after socket open

Relevant code:

- [`bun-websocket.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/bun-websocket.ts)
- [`websocket-app.service.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/websocket/websocket-app.service.ts)

Important consequence:

- today, the app side cannot "bootstrap" a missing user session
- the cloud requires user presence to exist first, then allows mini apps to attach

### Mini app connection also requires app lifecycle state

Even if `UserSession` exists, `AppManager.handleAppInit()` rejects the connection unless the app is already in one of these states:

- `CONNECTING`
- `RUNNING`
- `GRACE_PERIOD`
- `DORMANT`

If the app is not already expected to exist, cloud returns `APP_NOT_STARTED`.

That means the cloud is already authoritative about whether a mini app is supposed to be running for that user session.

Relevant code:

- [`AppManager.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/cloud/src/services/session/AppManager.ts)

---

## Current Cloud Restart / Recovery Implications

After a cloud crash/restart, all in-memory `UserSession`s are gone.

That means:

1. mini apps may reconnect quickly
2. `/app-ws` will not find `UserSession`
3. cloud returns `SESSION_NOT_FOUND`
4. mini app cannot attach yet, even if it still has valid in-memory session state

Separately, the mobile/glasses side will eventually reconnect and recreate `UserSession`.

Then:

1. cloud sends `CONNECTION_ACK` to glasses
2. cloud starts previously running apps from the DB via `startPreviouslyRunningApps()`
3. those apps receive webhook starts and connect again

So current boot order is effectively:

- glasses/mobile reconnect first
- then cloud recreates `UserSession`
- then cloud starts mini apps
- then mini apps connect

If the mini app arrives early, the cloud has no temporary holding state for it today.

---

## What `UserSession` Means Today

`UserSession` is not just a generic per-user bag of state.

It owns:

- the active glasses/mobile WebSocket
- app manager and app lifecycle state
- audio pipeline
- microphone state and resync
- display/dashboard/device managers
- user settings manager
- translation/transcription/location/photo/streaming managers

So creating a `UserSession` with no real mobile/glasses attachment is not a trivial act. It would mean creating a large runtime that currently assumes the user's cloud presence has actually been established.

This matters because a mini app reconnecting early after cloud restart does **not** imply:

- the user is connected to this cloud yet
- device state is available
- capabilities are known
- the phone will reconnect at all

---

## Does the Cloud Already Have a "Provisional UserSession" Pattern?

Partially, but only after a real glasses connection has already existed.

Current implicit provisional period:

- glasses disconnects
- `UserSession` remains in memory for 1 minute
- no active glasses socket exists during this time
- if glasses reconnect, the same `UserSession` is reused
- if not, it is disposed

This is useful, but it is not the same as creating a brand new `UserSession` from an early mini app reconnect after cloud restart.

That would be a new pattern.

---

## Architectural Options

### Option A: Let `/app-ws` create a provisional `UserSession`

Idea:

- if app reconnects and no `UserSession` exists, create one in a booting/provisional state
- wait for mobile/glasses to reconnect within a timeout
- if they do, convert it into a normal active user session
- if not, dispose it

Pros:

- app reconnect can "seed" recovery after cloud restart
- gives cloud a place to park app-side state

Cons:

- `UserSession` currently implies far more than "user might come back soon"
- creates large session runtime without proof the user is actually present on this cloud
- risks booting device/audio/display state prematurely
- encourages the wrong ownership model: mini app connection becomes user-presence authority

### Option B: Keep `UserSession` glasses-owned, add provisional app-side holding state

Idea:

- do **not** create `UserSession` from `/app-ws`
- if a v3 mini app reconnects early, accept the socket into a deferred/unattached state
- hold it temporarily while the cloud waits for glasses/mobile to restore `UserSession`
- once `UserSession` exists and the app is known to be running, attach the socket
- otherwise reject it terminally or let it expire

Pros:

- preserves current ownership semantics cleanly
- avoids overloading `UserSession`
- aligns with the new v3 `RECONNECT_DEFERRED` / parked-session design
- separates "transport exists" from "user session exists"

Cons:

- requires new cloud-side unattached app socket registry/state
- requires new explicit booting/deferred protocol for v3 apps

### Option C: Create a new explicit `BOOTING` `UserSession` state

Idea:

- create a lightweight or partial `UserSession` record before glasses reconnect
- distinguish it from a fully active user session
- promote it once glasses/mobile reconnect

Pros:

- makes boot/recovery state explicit

Cons:

- only good if we are willing to split `UserSession` into lighter-weight lifecycle layers
- current `UserSession` implementation is too heavyweight for this to be a simple change

---

## Recommendation From This Spike

For v3, the cleaner direction is **Option B**:

- keep `UserSession` owned by the glasses/mobile connection
- do not let `/app-ws` create full `UserSession`s
- add a cloud-side deferred/unattached mini app connection state for v3 reconnects during boot

Reasoning:

1. It matches current architecture more naturally.
2. It avoids turning `UserSession` into a speculative object created by mini apps.
3. It aligns with the already-decided parked/deferred v3 reconnect model.
4. It gives us the right primitive for cloud restart recovery: "app transport exists, but user session authority is not ready yet."

So the likely v3 cloud model should be:

1. early v3 mini app reconnect arrives
2. cloud authenticates it
3. no `UserSession` exists yet, or user/app restore is still booting
4. cloud holds socket in deferred unattached state
5. mobile/glasses reconnect recreates `UserSession`
6. cloud restores running apps from DB
7. cloud either:
   - attaches the waiting socket to the expected app session, or
   - rejects it if that app should not be running

This preserves the rule that the cloud, not the mini app, decides whether the app should run here.

---

## Open Questions For The Spec

These are the cloud-side decisions still worth locking before implementation:

1. Where does the deferred unattached app socket registry live?
   - WebSocket layer
   - `UserSession`-adjacent manager
   - dedicated global recovery manager

2. What exact conditions produce `RECONNECT_DEFERRED`?
   - no `UserSession`
   - `UserSession` exists but cloud still booting
   - app not yet restored into expected running state

3. How long can cloud hold an unattached app socket open?
   - likely 30 seconds to match parked SDK timeout

4. What data is required to match a deferred socket to a later restored app session?
   - `sdkVersion`
   - `packageName`
   - `userId`
   - optional prior `sessionId`

5. Should v2 apps continue to get immediate `SESSION_NOT_FOUND`?
   - likely yes, for strict backward compatibility

---

## Bottom Line

The current cloud does **not** create `UserSession` from mini app reconnects.

That is probably correct to preserve conceptually.

The right v3 addition is likely **not** "make a fake `UserSession` if the app arrives first."
The right addition is:

- keep `UserSession` as the real user-presence/session runtime
- add a deferred/unattached app connection phase for v3 reconnects during cloud boot and recovery

That gives us the recovery behavior we want without collapsing the boundary between:

- user connected to this cloud
- mini app transport connected to this cloud
