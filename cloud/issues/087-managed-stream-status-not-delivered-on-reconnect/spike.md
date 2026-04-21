# 087 — Managed Stream Status Not Delivered on App Reconnect

## Spike: Investigation & Findings

**Date:** April 5, 2026
**Author:** Isaiah, with Claude
**Status:** Root cause identified, fix designed
**Related:** Issue 085 (orphaned stream cleanup), Issue 084 (app not running race)

---

## Summary

When a mini app restarts (developer Ctrl+C, server crash, `bun --watch` reload)
while a managed stream is active, the reconnected app cannot start or resume the
stream. The cloud silently skips sending `managed_stream_status` to the new app
connection because a deduplication cache treats it as a repeat delivery. The SDK
never receives a response, and the `startStream()` promise times out after 30
seconds.

The user experience: glasses keep streaming (LED on), the webview says "Starting
managed stream…" for 30 seconds, then shows "Managed stream request timeout."
The only recovery is to restart the glasses.

---

## How We Found It

### Setup

- **App:** `examples/stream-test/` — v3 SDK test app for managed streaming
- **Cloud:** `cloud-debug` (us-central-debug)
- **Glasses:** Mentra Live, connected via WiFi
- **Tools:** BetterStack log query via MCP (source: `mentra-us-central`, ID 2321796)

### Reproduction steps

1. Start the stream-test app, connect glasses, start a managed stream — works
2. Stream is live, WebRTC player shows video, LED is on
3. Ctrl+C the app (kill the server)
4. Glasses keep streaming (LED stays on) — expected, stream should survive
5. Restart the app (`bun run dev`)
6. Cloud resurrects the session, app reconnects
7. App calls `checkExistingStream()` — cloud returns the active stream info
8. App tries to adopt the stream, UI shows "● Streaming" with old WebRTC URL
9. WebRTC player gets 409 "Live broadcast not started yet" from Cloudflare (stale)
10. User hits "Stop" then "Start Stream" to get a fresh stream
11. **Bug:** `startStream()` hangs for 30 seconds → "Managed stream request timeout"
12. LED stays on, glasses stuck in zombie streaming state

### BetterStack log query

```sql
SELECT dt, level, service, msg, pkg
FROM s3Cluster(primary, t373499_mentra_us_central_s3)
WHERE _row_type = 1
  AND dt > now() - INTERVAL 2 HOUR
  AND userId = 'isaiahballah@gmail.com'
  AND (service LIKE '%Stream%' OR msg LIKE '%managed%' OR level >= 50)
ORDER BY dt DESC
LIMIT 50
```

### What the logs showed

**23:12:21 UTC — App sends MANAGED_STREAM_REQUEST:**

```
📡 Starting managed stream in WebRTC mode (WHIP ingest → WHEP playback, low latency)
    packageName: dev.mentra.streamtest

Added viewer to existing managed stream
    service: StreamRegistry

Skipping duplicate managed stream status       ← ROOT CAUSE
    packageName: dev.mentra.streamtest
    service: ManagedStreamingExtension

Managed stream request processed
    packageName: dev.mentra.streamtest
    service: AppMessageHandler
```

The cloud found the existing managed stream, added the app as a viewer (correct),
then checked its `lastSentStatus` deduplication cache and found a matching entry
from the previous session. Since all fields matched (same stream ID, same URLs,
same status), it skipped sending `managed_stream_status`. The SDK never received
a response. The 30-second timeout fired.

**23:12:27 – 23:15:12 — Keep-alive ACKs flowing:**

The managed stream was technically still alive on the cloud side. The cloud sent
keep-alive pings every 15 seconds, and the glasses responded with ACKs. But
Cloudflare's WHEP endpoint returned 409 because the actual SRT media flow had
stopped (the glasses' SRT connection silently died at some earlier point).

**23:15:27 – 23:16:07 — Keep-alive failure cascade:**

After we force-stopped the ASG client via ADB (`am force-stop com.mentra.asg_client`),
the glasses stopped responding to keep-alive pings:

```
Keep-alive ACK timeout
Keep-alive ACK missed for managed stream
Keep-alive ACK missed for managed stream     (3 misses)
Maximum missed ACKs reached; triggering timeout
Managed stream timed out after missed keep-alive ACKs
Cleaning up managed stream
Lifecycle disposed
Sent managed stream status to app             (sent "stopped" status)
Removed stream
```

The cloud's keep-alive mechanism eventually cleaned up the stream — but only
because we manually killed the glasses app. Under normal circumstances (app
restart without touching glasses), the glasses keep ACKing keep-alives
indefinitely, the stale stream persists, and the app can never start a new one.

---

## Root Cause

### The deduplication cache

`ManagedStreamingExtension.sendManagedStreamStatus()` maintains a `lastSentStatus`
map keyed by `${streamId}:${packageName}`. Before sending a status message, it
compares all fields against the cached entry. If they match, it logs "Skipping
duplicate managed stream status" and returns without sending.

**File:** `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`

```typescript
// Line ~1120
const statusKey = `${streamId}:${packageName}`
const lastStatus = this.lastSentStatus.get(statusKey)

if (lastStatus) {
  const isDuplicate =
    lastStatus.status === statusMessage.status &&
    lastStatus.hlsUrl === statusMessage.hlsUrl &&
    lastStatus.dashUrl === statusMessage.dashUrl &&
    lastStatus.webrtcUrl === statusMessage.webrtcUrl &&
    lastStatus.message === statusMessage.message &&
    JSON.stringify(lastStatus.outputs) === JSON.stringify(statusMessage.outputs)

  if (isDuplicate) {
    this.logger.debug({packageName, status, streamId}, "Skipping duplicate managed stream status")
    return // ← Bug: SDK is waiting for this message
  }
}
```

### Why the cache is stale

The `lastSentStatus` map lives on the `ManagedStreamingExtension` instance, which
lives on the `UserSession`. The `UserSession` survives app disconnects and
reconnects — it represents the user, not the app. When the app restarts:

1. Old app connection dies → `UserSession` stays alive, `lastSentStatus` intact
2. Cloud resurrects the app → new WebSocket, same `UserSession`
3. App sends `MANAGED_STREAM_REQUEST` → cloud finds existing stream
4. Cloud calls `sendManagedStreamStatus()` → dedup check finds cached entry
5. All fields match (same stream!) → **skipped**
6. SDK has a pending promise waiting for `managed_stream_status` → **timeout**

The dedup cache is correct for its original purpose: preventing duplicate status
messages during normal streaming (e.g., when Cloudflare webhooks fire multiple
times for the same state transition). But it's wrong for the reconnection case
because the new app connection has never received this status.

### Why the stream can't be stopped either

Once the app is in this state:

- `stopStream()` may fail because the cloud's `isAppRunning()` check returns
  false (issue 084 — race condition on fresh connection)
- Even if stop succeeds on the cloud side, the glasses' ASG client doesn't
  release the camera (the streaming process is stuck)
- The only recovery is to restart the glasses or `adb shell am force-stop`

### Secondary finding: zombie glasses state

After the app restarts, the glasses' SRT connection to Cloudflare silently dies
(Cloudflare times out the ingest), but the ASG client doesn't detect this. The
camera stays on, the LED stays lit, and the glasses keep ACKing cloud keep-alives
(which are cloud-to-glasses pings, not SRT health checks). We confirmed via ADB:

```
$ adb shell netstat -tn
# Only 2 TCP connections: Cloudflare cloud WS + ADB
# No active SRT/UDP connections to Cloudflare ingest
# Yet camera was active: dumpsys media.camera showed Camera ID 0 in use
```

The glasses were using the camera but sending data nowhere. This is an ASG client
bug (no SRT health watchdog) but is out of scope for this issue.

---

## Impact

| Scenario                                               | Impact                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Developer restarts app during managed stream           | Stream hangs, 30s timeout, must restart glasses              |
| `bun --watch` auto-restart during stream               | Same — every save while streaming is broken                  |
| Production app server restart/deploy                   | Stream survives but app can't resume control                 |
| User stops app from phone, opens a streaming app again | May hit stale dedup cache if same Cloudflare input is reused |

This makes managed streaming unusable during development and fragile in production.

---

## Related Issues

| Issue                             | Relationship                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **085** — Orphaned stream cleanup | Parent issue. The dedup bug blocks the "deliver stream state on reconnect" fix designed in the 085 spec. |
| **084** — App not running race    | Compounds the problem. Even if dedup is fixed, `isAppRunning()` may reject the first message.            |
| **086** — SDK fast shutdown       | Mitigates developer pain (fast Ctrl+C) but doesn't fix the stream lifecycle.                             |
| **083** — Unified streaming API   | Where the bugs were originally discovered.                                                               |

---

## Conclusion

The root cause is a deduplication cache (`lastSentStatus`) that doesn't account
for app reconnections. The cache must be cleared — or bypassed — when an app
reconnects so the new connection receives the stream state it needs. The fix is
small and surgical. See `spec.md` for the proposed implementation.
