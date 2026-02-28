# Cleanup: UserSession — Manager-first shape (final naming)

Goal: Make UserSession an orchestrator only. Everything it owns is a Manager. Within AppManager live AppSession(s). No standalone SubscriptionManager.

## Components and responsibilities

- UserSession (orchestrator)
  - Owns: userId, wiring of managers, lifecycle (init/dispose), snapshot assembly.
  - Not: raw ws event handlers, device fields, per-app state.

- ClientManager (glasses/client websocket)
  - Owns: the single active client WebSocket, ping/pong/heartbeat, ws event handlers, send/receive helpers, backpressure.
  - Not: domain routing or policy.

- DeviceManager (capabilities)
  - Owns: device model/firmware, capabilities, sensor/battery metadata; capability checks; profile snapshot.
  - Not: sockets, timers, side-effects.

- AppManager (apps hub)
  - Owns: Map<string, AppSession>, cross-app routing (messages/audio), subscription index for fast fanout, basic permission checks.
  - Not: client/glasses ws, device profile.

- AppSession (per-app)
  - Owns: one app’s connection/state, its own subscriptions, request/response correlation.
  - Not: cross-app policy or device info.

- SubscriptionManager
  - Deprecated: each AppSession manages its own subscriptions; AppManager maintains an aggregate index for fanout.

## Minimal contracts (sketch)

- UserSession
  - attachClient(ws): void
  - snapshot(): SessionSnapshot
  - dispose(): void

- ClientManager
  - attach(ws): void
  - onMessage(cb): void
  - send(type, payload): Promise<void>
  - close(): void

- DeviceManager
  - update(partial): void
  - hasCapability(name): boolean
  - snapshot(): DeviceSnapshot

- AppManager
  - ensure(appId): AppSession
  - get(appId): AppSession | undefined
  - relay(type, payload, opts?): void // uses subscriptions to target apps
  - listSubscriptions(): Map<string, string[]> // appId -> topics
  - dispose(): void

- AppSession
  - attach(ws): void
  - setSubscriptions(topics: string[]): void
  - isSubscribed(topic: string): boolean
  - send(type, payload): Promise<void>
  - dispose(): void

## Do / Don’t

- UserSession
  - Do: compose ClientManager, DeviceManager, AppManager; provide a clean snapshot for clients.
  - Don’t: handle ws events or store device/app state directly.

- ClientManager
  - Do: heartbeat and message parsing; emit messages upward.
  - Don’t: route to apps or enforce policy.

- DeviceManager
  - Do: hold pure device/profile data and capability checks.
  - Don’t: touch sockets or timers.

- AppManager / AppSession
  - Do: per-app subscriptions and routing; AppManager keeps an aggregate index so other managers don’t need to know about running apps.
  - Don’t: own the client/glasses ws or device state.

## Message flow (high level)

Client → ClientManager → UserSession → AppManager → AppSession(s)

For outbound to apps (e.g., audio): managers call AppManager.relay(...); AppManager targets AppSession(s) by subscription.

## Migration (tiny steps)

1. Extract ClientManager from UserSession and move ws handlers there (no behavior change).
2. Introduce DeviceManager; move capabilities/device fields; make snapshot consume DeviceManager.
3. Introduce AppManager + AppSession; move app maps, request correlation, and subscriptions; remove SubscriptionManager.
4. Update call sites to use AppManager.relay(...) for messages/audio; keep snapshot pure.

Done when: UserSession only wires Managers and exposes snapshot; no raw ws/device/app logic inside.
