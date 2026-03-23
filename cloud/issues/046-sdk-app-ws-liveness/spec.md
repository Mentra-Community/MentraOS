# Issue 046 — SDK App-WS Liveness: Ping-Pong

## Background

We recently fixed WebSocket connection drops between the **phone/glasses and cloud** (issues 034/035)
by implementing an app-level ping/pong on the `glasses-ws` connection:

- Cloud sends `{type:"ping"}` to the phone every 2 seconds via `UserSession.appLevelPingInterval`
- Phone responds with `{type:"pong"}`
- Cloud consumes the pong silently in `bun-websocket.ts` (prevents relay to mini apps)
- This is tested on debug and appears to be working

The **same WebSocket dying problem exists on the `app-ws` connection** — between the SDK
(mini app server) and the cloud. Long-idle SDK connections drop because the load balancer /
nginx requires **bidirectional traffic** to keep a WebSocket connection alive. If either
direction goes quiet long enough, the infra kills the connection.

The existing `glasses-ws` fix cannot simply be mirrored on `app-ws` (cloud sends ping to SDK)
because of backwards compatibility:

> **Old SDK versions (`2.x`) have no `{type:"ping"}` handling.** They route every unrecognized
> message type through the `default` case in `handleMessage()` which emits an error event and
> logs a warning. A ping every few seconds would generate **thousands of error log entries per
> user per hour** across every deployed mini app in the ecosystem.

---

## Spike: Why SDK-Initiated Is the Right Direction

### Option A: Cloud sends ping → SDK responds with pong ❌

- Cloud mirrors `glasses-ws` approach: sends `{type:"ping"}` to SDK apps every N seconds
- **Problem:** Old SDK apps (`2.x`) receive unrecognized message → `MentraError("UNKNOWN_TYPE")`
  emitted, `this.logger.warn(...)` fires → at 1 ping/5s that's ~720 warnings/hour/user/app
- No way to gate this without knowing the SDK version of connected apps at runtime
- Cloud has no way to know which SDK version a connected app is running

### Option B: SDK sends ping → Cloud responds with pong ✅

- New SDK (`3.x hono`) sends `{type:"ping"}` to cloud every N seconds → **ingress traffic**
- Cloud responds `{type:"pong"}` → **egress traffic**
- Both directions have periodic traffic → load balancer stays happy → connection lives
- SDK consumes the pong silently — no warning, no error event, no liveness logic
- **Backwards compatible by design:** old SDK apps never send pings → cloud never responds →
  no noise on old deployments
- Only apps that upgrade to the new SDK get the keep-alive behaviour

### Option C: Rely on protocol-level WebSocket ping from cloud ❌

- Cloud already does `ws.ping()` (protocol-level) in `AppSession.ts`
- Protocol-level pings are handled at the TCP/kernel level but are **not visible to application
  message handlers** — they don't produce egress traffic visible to the load balancer in the
  way app-level messages do
- Does not reliably satisfy infra-level bidirectional traffic requirements

---

## Why Both Directions Matter

The infrastructure requirement is **bidirectional traffic**, not just one-way:

```
SDK → Cloud:  {type:"ping"}   ← satisfies ingress (SDK → cloud)
Cloud → SDK:  {type:"pong"}   ← satisfies egress  (cloud → SDK)
```

Sending pings without receiving pongs (e.g. connected to an old cloud that doesn't respond)
means only ingress is active. On some infra this is sufficient; on others the egress silence
still triggers a timeout. The cloud-side change is therefore required for full reliability.

However, the SDK should **not** do anything special if pongs don't arrive. The SDK has no
way to know whether it's connected to a new cloud (which responds) or an old cloud (which
doesn't). Adding a pong timeout would actively harm apps on old cloud deployments by
disconnecting healthy connections just because the cloud doesn't echo back.

The pong is consumed silently. That's all.

---

## Design

### Message format

`"ping"` / `"pong"` are raw string types that bypass the typed message system — infrastructure,
not application protocol. Same pattern as `glasses-ws`.

```
SDK → Cloud:   { type: "ping" }
Cloud → SDK:   { type: "pong" }
```

### Cloud change — `bun-websocket.ts` (3 lines)

In `handleAppMessage()`, before delegating to `userSession.handleAppMessage()`, add early
returns for ping/pong, mirroring the existing `handleGlassesMessage()` pattern:

```typescript
// App-level ping from SDK — respond immediately to satisfy egress requirement.
// Only new SDK versions (3.x hono+) send these. Old 2.x apps never send pings
// so this branch is never hit for legacy apps — fully backwards compatible.
// See: cloud/issues/046-sdk-app-ws-liveness
if ((parsed as any).type === "ping") {
  ws.send(JSON.stringify({type: "pong"}))
  return
}

// App-level pong — consume silently (future-proofing).
if ((parsed as any).type === "pong") {
  return
}
```

### SDK change — `AppSession`

#### 1. Ping interval

Start after `CONNECTION_ACK` is received. Stop and clear on disconnect.

```typescript
private pingInterval?: NodeJS.Timeout
private readonly PING_INTERVAL_MS = 15_000
```

Every 15 seconds, if the WebSocket is open, send `{type:"ping"}`. Guard against sending
when `readyState !== OPEN` — same pattern as `UserSession.appLevelPingInterval`.

Why 15 seconds? Well under Cloudflare's ~100s idle timeout and common LB 60s defaults.
At 100 concurrent apps: ~400 tiny messages/minute server-wide — negligible.

#### 2. Pong handling in `handleMessage()`

Add a silent branch before the unrecognized-message `else`:

```typescript
} else if ((message as any).type === "pong") {
  // Cloud acknowledged our ping — bidirectional traffic maintained.
  // No timeout, no liveness detection, no reconnect logic.
  // If the cloud doesn't respond (old deployment), the SDK keeps sending
  // pings regardless — the sending itself produces ingress traffic.
}
```

That's it. No `lastPongTime`. No forced reconnect on missing pong. No error if pong never
comes. The interval runs unconditionally for as long as the session is connected.

#### 3. Cleanup

Clear `pingInterval` on both temporary and permanent disconnect. Also clear on `dispose()`.

---

## What the SDK does NOT do

- ❌ Track `lastPongTime`
- ❌ Disconnect/reconnect if pong doesn't arrive
- ❌ Log warnings if pong is missing
- ❌ Expose ping interval as a developer config option
- ❌ Emit any event on ping/pong

The SDK simply sends traffic. The cloud sends traffic back. The connection stays alive.

---

## Backwards Compatibility

| SDK Version             | Sends ping?  | Cloud responds?    | Effect                          |
| ----------------------- | ------------ | ------------------ | ------------------------------- |
| `2.x` (old Express SDK) | ❌ No        | ❌ Never triggered | No change, zero noise           |
| `3.0.0-hono.7+` (new)   | ✅ Every 15s | ✅ Yes (new cloud) | Bidirectional traffic, stays up |
| `3.0.0-hono.7+` (new)   | ✅ Every 15s | ❌ No (old cloud)  | Ingress-only, may still help    |

---

## Files to Change

### Cloud (`cloud/packages/cloud/`)

| File                                      | Change                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| `src/services/websocket/bun-websocket.ts` | Add ping/pong early-return in `handleAppMessage()` (~6 lines) |

### SDK (`cloud/packages/sdk/`)

| File                       | Change                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/session/index.ts` | Add `pingInterval` + `PING_INTERVAL_MS`; start on `CONNECTION_ACK`; consume pong silently in `handleMessage()`; clear on disconnect |

---

## Implementation Order

1. **Cloud change first** — safe to deploy before SDK change because no current SDK sends
   `{type:"ping"}` on `app-ws`, so the new handler is never triggered.

2. **SDK change** — ping interval + silent pong consumption.

3. **Publish** `@mentra/sdk@3.0.0-hono.7 --tag hono`.

4. **Update live-captions** to `3.0.0-hono.7` as part of the Hono SDK refactor.

---

## Out of Scope

- Cloud-initiated ping to SDK apps (backwards-incompatible)
- Ping-pong on `glasses-ws` (already handled in 034/035)
- Promoting Hono SDK to the `latest` npm tag
- Pong-based liveness/reconnection logic (explicitly not doing this)
- Developer-configurable ping interval
