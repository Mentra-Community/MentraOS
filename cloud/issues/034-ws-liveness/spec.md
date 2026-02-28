# Spec: Application-Level WebSocket Ping/Pong

## Overview

**What this doc covers:** A specification for application-level ping/pong messages between the mobile client and cloud, so both sides can detect dead WebSocket connections within seconds and reconnect.

**Why this doc exists:** The mobile client currently has no way to detect a silently dead WebSocket. React Native's WebSocket API does not expose protocol-level ping/pong frames — the server already sends them every 10 seconds, but the client JavaScript never sees them. When the connection dies silently (e.g. nginx kills it, Cloudflare drops it, network black-holes packets), the client sits there thinking it's connected. Users tap "start app," nothing happens. This has been the #1 source of "app is broken" reports.

**What you need to know first:** Read [spike.md](./spike.md) if you want to understand _why_ WebSocket connections die. This spec doesn't try to prevent disconnections — it makes the client detect and recover from them in seconds instead of minutes.

**Who should read this:** Mobile client engineers implementing the client side, cloud engineers implementing the server side.

---

## The Problem in 30 Seconds

1. The server sends protocol-level WebSocket pings every 10s. The phone's OS auto-responds with a pong, but **React Native's `onmessage` never fires** for these. They're invisible to the app's JavaScript.
2. When the connection dies silently (no TCP RST, no close frame), the client gets no `onerror` or `onclose` event. It has to wait for the OS TCP keepalive to time out — which takes **30–120+ seconds** on Android, sometimes longer on Samsung devices.
3. During that entire window, the client thinks it's connected. REST calls to start/stop apps hit a cloud that may have already disposed the user's session. The user sees nothing happen.

**Verified experimentally:** Connecting to a local cloud, pausing the Docker VM, the client did not detect the dead connection for over 60 seconds. Zero events fired.

---

## Spec

### Message format

Two new JSON message types over the existing WebSocket:

```json
{ "type": "ping" }
{ "type": "pong" }
```

These are regular WebSocket text messages (not protocol-level frames). They flow through `onmessage` like any other message. Both client and server can see them.

### Client behavior

| Parameter        | Value                          | Rationale                                                                                                                                                |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ping interval    | **2 seconds**                  | Audio already streams at hundreds of KB/s per user. A 15-byte JSON message every 2s is negligible. Faster detection is worth more than saving bandwidth. |
| Liveness timeout | **4 seconds** (2 missed pings) | If the server hasn't sent _any_ message (pong, display event, app state, anything) within 4 seconds, assume the connection is dead.                      |
| Check interval   | **2 seconds**                  | How often the client evaluates whether the liveness timeout has been exceeded.                                                                           |

**The liveness clock resets on ANY incoming message, not just pongs.** If the server is sending display events, app state changes, or anything else, those all count. The ping is just a fallback to guarantee traffic when nothing else is happening.

#### Client flow

```
CONNECTED:
  Start a repeating timer (every 2s):
    → Send { "type": "ping" } to server

  Start a repeating liveness check (every 2s):
    → If (now - lastMessageTime) > 4 seconds:
        Log: "No message from server in Xs — assuming dead"
        Force-close the WebSocket (null out event handlers first)
        Set status to DISCONNECTED
        Start reconnect interval

  On EVERY onmessage (any type):
    → Update lastMessageTime = now

DISCONNECTED / ERROR:
  Stop ping timer
  Stop liveness check timer
  Reconnect interval handles reconnection
```

#### Reconnect behavior changes

The current `actuallyReconnect()` only attempts reconnection when status is `DISCONNECTED`. If `onerror` fires (setting status to `ERROR`) but `onclose` hasn't fired yet, every reconnect tick is a silent no-op. This is a bug independent of the ping/pong work but should be fixed alongside it:

- `actuallyReconnect()` should attempt reconnection when status is `DISCONNECTED` **or** `ERROR`

### Server behavior

| Parameter                        | Value                          |
| -------------------------------- | ------------------------------ |
| Response to `{ "type": "ping" }` | Send back `{ "type": "pong" }` |

The server should respond to application-level pings with a pong. That's it.

The server already has its own protocol-level heartbeat (10s ping interval with pong timeout tracking). That system remains unchanged — it detects dead connections from the server's perspective. The application-level ping/pong is for the _client's_ perspective.

#### Server handling

When the glasses WebSocket message handler receives a message with `type: "ping"`:

- Respond with `{ "type": "pong" }`
- No logging needed (2 pings/second/user × many users = log noise)
- No other processing — don't relay to apps, don't update session state

### What this does NOT change

- **Protocol-level pings from server → client** — still happen every 10s, still invisible to RN. They serve a different purpose (server-side dead connection detection + nginx/Cloudflare keepalive).
- **Reconnect interval timing** — still 5 seconds between reconnect attempts.
- **Session grace period** — cloud still keeps the `UserSession` alive for 60 seconds after WS disconnect. The faster client-side detection means the client is more likely to reconnect within this window.
- **UDP audio** — unaffected. Separate path entirely.

---

## Timing Analysis

Worst-case detection time:

```
t=0.0s  Client sends ping
t=0.1s  Connection dies silently (no close frame)
t=2.0s  Client sends another ping (fails silently — send to dead socket is swallowed)
t=2.0s  Liveness check runs: (2.0 - 0.1) = 1.9s since last message → not timed out
t=4.0s  Liveness check runs: (4.0 - 0.1) = 3.9s since last message → not timed out
t=4.1s  Liveness check runs: (4.1 - 0.1) = 4.0s since last message → TIMED OUT
        → Force close, set DISCONNECTED, start reconnect
t=9.1s  First reconnect attempt (5s reconnect interval)
```

**Worst case: ~4 seconds to detect, ~9 seconds to reconnect.**

Compare to current behavior: **60–120+ seconds to detect, or never.**

---

## Cloud ↔ Mini-App WebSockets

The same dead-connection problem exists between cloud and third-party app (TPA) servers. However:

- TPAs **can** detect 1006 close codes — the SDK runs in Node.js, not React Native, so it has full access to WebSocket close events.
- The SDK reconnection logic triggers immediately on disconnect.
- Cloud-side app resurrection handles the reconnect within seconds.

The TPA side may benefit from application-level ping/pong in the future, but it's lower priority because the detection + reconnection already works. The mobile client is where users directly feel the pain.

---

## Decision Log

| Decision                                         | Alternatives considered | Why we chose this                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2s ping interval                                 | 1s, 5s, 10s             | 1s is unnecessary — the 2s extra detection time isn't worth doubling message volume. 5s/10s means 10–20s worst-case detection, too slow for a connection users rely on every second. Audio streaming already dwarfs ping overhead. |
| 4s liveness timeout (2 missed pings)             | 6s (3 missed), 10s      | Single missed ping (2s) risks false positives from normal jitter. 2 missed pings (4s) is robust against transient delays while still catching real failures fast.                                                                  |
| Reset liveness on ANY message, not just pongs    | Only reset on pong      | If the server is sending display events or app state changes, the connection is obviously alive. Only resetting on pongs would cause false positives during high-traffic periods where the pong gets queued behind other messages. |
| Fix `actuallyReconnect()` ERROR bug in same work | Separate PR             | It's 2 lines and directly related — the ping/pong detects the dead connection, but the reconnect bug prevents recovery. Fixing one without the other still leaves users stuck.                                                     |
| Don't add ping/pong for cloud ↔ TPA yet         | Add it everywhere       | TPAs already detect 1006 and reconnect instantly. Adding complexity to the SDK for a problem that doesn't exist in practice isn't worth it right now.                                                                              |

---

## Next

See [design.md](./design.md) for implementation details.
