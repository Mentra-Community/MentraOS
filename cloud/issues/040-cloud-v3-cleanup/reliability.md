# Cloud v3 — Reliability

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [overview.md](./overview.md) · [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this doc?

This doc covers reliability improvements needed in the MentraOS cloud — making sure the system works correctly and consistently, especially under real-world conditions like rapid display updates, connection drops, and component failures.

## Why it matters

Users experience reliability issues that are hard to reproduce and harder to diagnose. The most visible example: when a live captions app updates the display rapidly, the glasses briefly flicker back to the previous text before showing the new text. This happens because the `DisplayManager` has a single shared mutable state that all apps write to — rapid updates can cause stale state to be re-pushed to glasses.

More broadly, the cloud needs to handle the messy reality of wireless connections, varying BLE quality, mini apps that crash or go slow, and components that temporarily go offline — without the user noticing.

## System context

See [overview.md](./overview.md) for full system architecture. This doc focuses on how the cloud ensures correct, consistent behavior across the full data path:

```
Glasses ←BLE→ Mobile Client ←WebSocket→ Cloud ←HTTP→ Mini Apps
```

Key reliability challenge: every link in this chain can be slow, flaky, or temporarily broken. The cloud sits in the middle and needs to handle this gracefully.

---

## Issues

### 1. DisplayManager redesign — per-AppSession display state + compositor pattern

**The bug**: When updating the display rapidly (e.g., live captions), the glasses briefly flicker back to the previous text before showing the new text. A word appears, regresses, then reappears.

**Root cause (likely)**: `DisplayManager6.1.ts` (1,082 lines) has a single shared `currentDisplay` state. All apps' display requests funnel through the same mutable state. Concepts like `backgroundLock`, `coreAppDisplay`, `savedDisplayBeforeBoot`, and throttling logic can cause stale state to be re-pushed to glasses between rapid updates.

**Proposed fix — compositor pattern:**

Each `AppSession` owns its own display state (what it wants to show on `ViewType.MAIN`). The `DisplayManager` becomes a compositor/arbiter — it doesn't store content, it just knows which app is active and reads that app's current state.

```
Before (shared mutable state):
  App A calls showText() → DisplayManager.currentDisplay = A's content
  App B calls showText() → DisplayManager.currentDisplay = B's content
  Throttle timer fires → re-sends whatever currentDisplay is (could be stale)

After (per-app state + compositor):
  App A calls showText() → AppSession A stores its own display state
  App B calls showText() → AppSession B stores its own display state
  DisplayManager: "App A is active → send App A's current state to MAIN view"
```

**Why the flicker goes away:**

- There's no "previous state" to regress to — each app's state is always the latest thing it set
- The DisplayManager never stores content itself, just points to the active app and reads its state
- No re-sending of stale data from throttle timers or priority re-evaluation
- If the dashboard manager updates while a captions app is active, nothing happens on the main view

**Priority arbitration** becomes a simple list:

1. System (boot screen, critical alerts)
2. Foreground app (whichever app the user is "in")
3. Dashboard (when no foreground app is active)

Switching between apps = point the compositor at a different app's state. No re-rendering needed.

---

### 2. Client-side view caching

The glasses client maintains two views:

- **Main view** — whatever the active app is showing (captions, navigation, etc.)
- **Dashboard view** — system info + app widgets

Both views are cached on the client at all times. Head-up/down gesture switches which cached view is rendered — zero network round-trip, instant.

**How it works with the compositor:**

The cloud pushes two independent update streams to the client:

- `DisplayRequest { view: MAIN }` — from whichever app is currently foreground
- `DisplayRequest { view: DASHBOARD }` — from the OS dashboard service

The client caches the latest content for each view. On gesture, the client renders whichever cached view is appropriate. The cloud doesn't need to know about gestures — it just keeps both caches fresh.

```
Cloud sends DisplayRequest { view: MAIN, layout: "The quick brown fox" }
  → Client stores in mainViewBuffer

Cloud sends DisplayRequest { view: DASHBOARD, layout: "3:45 🔋82% | Clear 75°F\n..." }
  → Client stores in dashboardViewBuffer

User looks up → client renders dashboardViewBuffer (instant, no cloud round-trip)
User looks down → client renders mainViewBuffer (instant, no cloud round-trip)
```

**Why this improves reliability:**

- Gesture response is instant regardless of cloud latency or connection quality
- If the cloud connection momentarily drops, the user still sees the last known content
- The cloud and client can recover independently — when the connection comes back, the cloud pushes fresh state for both views

---

### 3. Connection stability

The cloud currently has a WebSocket heartbeat mechanism for detecting dead connections, but it's partially disabled:

> _"Cloudflare absorbs protocol-level ping/pong at the edge, so pongs from the mobile client never reach Bun — they terminate at Cloudflare's edge. This causes the timeout to fire on every idle connection after 30s, killing healthy connections."_
> — Comment in `UserSession.ts`

**Current state:**

- `PONG_TIMEOUT_ENABLED = false` — pong timeout is disabled
- Server still sends pings and tracks `lastPongTime` for observability
- Dead connections are only detected when a send fails
- Clients take 3-7 minutes to detect a dead connection and reconnect

**What needs to happen:**

- Application-level heartbeat instead of protocol-level ping/pong (Cloudflare won't absorb custom message types)
- The `client_health` ping proposed in [observability.md](./observability.md) can double as a heartbeat — if no health ping arrives in X seconds, the connection is considered dead
- Faster dead-connection detection means faster reconnection, which means less downtime for the user
- Reconnection should be seamless — on reconnect, the cloud pushes the current display state for both views so the client is immediately up to date

---

### 4. Transcription recovery

When the Soniox transcription stream dies mid-session (rate limit, network issue, stream timeout), the system needs to recover automatically.

**Current state:**

- `TranscriptionManager.ts` (2,201 lines) has complex failover logic between Soniox and Azure
- Azure failover is dead code (see [maintainability.md](./maintainability.md) §2)
- After Azure is removed, the recovery path needs to be: Soniox fails → retry Soniox (with backoff) → if still failing, notify the user

**What recovery should look like:**

- Soniox stream dies → automatically attempt reconnection with exponential backoff
- During reconnection: audio chunks continue to be received and buffered (or discarded with a gap marker)
- User sees a brief indication that transcription is reconnecting (optional — depends on UX decision)
- Once reconnected, transcription resumes seamlessly
- Pipeline health status in [observability.md](./observability.md) reflects the recovery state (ok → broken → ok)

---

### 5. Graceful degradation

When a component in the pipeline is unavailable, the system should degrade gracefully rather than fail silently or crash.

| Scenario                      | Current behavior                         | Desired behavior                                                                                 |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Mini app webhook fails (5xx)  | App appears running but produces nothing | Cloud detects failure, retries with backoff, shows "App unavailable" on display after N failures |
| Mini app webhook times out    | Cloud waits, user sees nothing           | Timeout after configured limit, show last known content or "App not responding"                  |
| Soniox is down                | Transcription silently stops             | Auto-retry with backoff, user notified if recovery takes >X seconds                              |
| BLE disconnects               | Cloud keeps sending, data is lost        | Cloud detects via client health ping, pauses sending until BLE recovers (saves resources)        |
| Mobile app goes to background | WebSocket may close or go idle           | Graceful disconnect with state preservation, fast reconnect when app returns                     |

The general pattern: **detect → notify → retry → recover**. Never silently drop data or leave the user staring at stale content with no indication of what's wrong.

---

### 6. Dashboard reliability

The current Dashboard is a separate mini app that connects to the cloud like any third-party app. This means:

- If the Dashboard mini app server goes down, users have no dashboard
- If the webhook to the Dashboard app times out, system data (time, battery, weather) stops updating
- Dashboard has the same connection/reliability concerns as any external service

**Decision (from 039 D31):** Dashboard becomes an OS service inside the cloud. No external dependency, no webhook round-trip, no separate deploy. The cloud already has all the data (time, battery, location, notifications, calendar). The rewritten `DashboardManager` composes the dashboard layout directly and sends it to `ViewType.DASHBOARD`.

This eliminates an entire class of reliability issues — the dashboard can't go down independently of the cloud.

See [maintainability.md](./maintainability.md) §5 for the implementation scope.

---

## Prioritization

### Must-do for v3.0

| #   | Issue                                        | Why                                                      |
| --- | -------------------------------------------- | -------------------------------------------------------- |
| 1   | DisplayManager redesign (compositor pattern) | Fixes the display flicker bug, simplifies architecture   |
| 2   | Client-side view caching                     | Instant gesture switching, resilient to connection drops |
| 6   | Dashboard → OS service                       | Eliminates external dependency, already decided          |

### Should-do for v3.0

| #   | Issue                                      | Why                                                                           |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| 3   | Connection stability (app-level heartbeat) | Faster dead-connection detection, pairs with observability client health ping |
| 4   | Transcription recovery (Soniox-only path)  | Depends on Azure removal from maintainability                                 |

### Can defer past v3.0

| #   | Issue                               | Why                                          |
| --- | ----------------------------------- | -------------------------------------------- |
| 5   | Graceful degradation (full pattern) | Each scenario can be addressed incrementally |

---

## Related docs

- [observability.md](./observability.md) — pipeline health tracking detects the issues described here; client health ping doubles as heartbeat for §3
- [maintainability.md](./maintainability.md) — Azure removal (§2) is prerequisite for transcription recovery (§4); DashboardManager rewrite (§5) overlaps with §6 here
- [testing.md](./testing.md) — e2e test harness can simulate connection drops, slow apps, and rapid display updates to verify reliability improvements

---

## Open Questions

| #   | Question                                                                             | Notes                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Is the display flicker bug in the cloud, the mobile client, or the glasses firmware? | Likely cloud (shared mutable state in DisplayManager), but could also be client-side rendering. The compositor redesign fixes it regardless of root cause — each app's state is always clean. |
| Q2  | What should the user see during transcription reconnection?                          | Nothing (silent retry)? A brief indicator? Depends on UX preferences.                                                                                                                         |
| Q3  | App-level heartbeat interval?                                                        | Needs to balance fast detection vs. battery/bandwidth. 10s proposed (matches client health ping).                                                                                             |
| Q4  | Should the cloud buffer audio during Soniox reconnection?                            | Buffering means no gap in transcription, but adds memory pressure. Discarding is simpler.                                                                                                     |
| Q5  | Priority arbitration details                                                         | How exactly does the compositor decide which app is "foreground"? User selection? Most recent display update? System-level app switching?                                                     |
