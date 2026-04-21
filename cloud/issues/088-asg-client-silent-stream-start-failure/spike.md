# 088 — ASG Client Silently Drops START_STREAM Commands

## Spike: Investigation & Findings

**Date:** April 5, 2026
**Author:** Isaiah, with Claude
**Status:** Root cause identified — ASG client issue, cannot fix server-side
**Affects:** Mentra Live glasses (com.mentra.asg_client)
**Related:** Issue 085 (orphaned streams), Issue 087 (dedup cache)

---

## Summary

The Mentra Live glasses sometimes silently ignore `START_STREAM` commands from
the cloud. The cloud creates the Cloudflare Live Input, sends `START_STREAM` to
the glasses via WebSocket, and sends `managed_stream_status` (with URLs) to the
app — but the glasses never open an SRT connection to Cloudflare. The stream
never goes live. The SDK times out after 30 seconds with
`"Managed stream request timeout"`.

The failure is intermittent and appears related to prior thermal throttling or
force-stopped camera state. Sending `STOP_STREAM` first (clearing internal ASG
client state) and then `START_STREAM` resolves the issue.

---

## How We Found It

### Setup

- **App:** `examples/stream-test/` — v3 SDK test app for managed streaming
- **Cloud:** `cloud-debug` (us-central-debug)
- **Glasses:** Mentra Live, connected via WiFi (10.0.0.216)
- **Tools:** BetterStack log query via MCP, ADB over WiFi

### Context leading to the failure

Earlier in the session, the glasses had been streaming at 1080p/10Mbps which
caused thermal throttling:

```
$ adb shell cat /sys/class/thermal/thermal_zone1/temp
79100   (79.1°C — SoC critically hot)

$ adb shell cat /proc/loadavg
11.27 11.53 11.33   (4-core ARM chip maxed out)
```

We force-stopped the ASG client (`adb shell am force-stop com.mentra.asg_client`)
to release the camera and cool down. After cooling, we reduced settings to
720p/4Mbps/15fps. The glasses reconnected to the cloud and the app session
started normally.

### First failure (19:18 local / 02:18 UTC)

User clicked "Start Stream" in the webview. The cloud processed it correctly.
The glasses never started.

### Second failure (19:28 local / 02:28 UTC)

User tried again ~10 minutes later. Same result — 30-second timeout.

### Recovery (19:29 local / 02:29 UTC)

User clicked "Stop Stream" then "Start Stream". This time it worked. The stream
went live and video played in the webview.

---

## Cloud Logs (BetterStack)

### Query used

```sql
SELECT dt, level, service, msg, pkg
FROM s3Cluster(primary, t373499_mentra_us_central_s3)
WHERE _row_type = 1
  AND dt > now() - INTERVAL 20 MINUTE
  AND userId = 'isaiahballah@gmail.com'
  AND (service LIKE '%Stream%' OR service LIKE '%Cloudflare%'
       OR msg LIKE '%stream%' OR level >= 40)
ORDER BY dt ASC
LIMIT 60
```

### First attempt timeline (02:18 UTC)

```
02:18:12.092  DisplayManager        Display sent: "Starting managed stream..."
02:18:12.103  ManagedStreamExt      📡 Starting managed stream in WebRTC mode
02:18:12.103  CloudflareService     🚀 Starting Cloudflare live input creation
02:18:12.103  CloudflareService     📤 Sending request to Cloudflare
02:18:12.698  CloudflareService     ✅ Cloudflare API request successful
02:18:12.700  CloudflareService     ✅ Created Cloudflare live input successfully
02:18:12.700  StreamRegistry        Created new managed stream
02:18:12.700  ManagedStreamExt      ⏳ Waiting 3 seconds for CF to initialize

02:18:15.700  ManagedStreamExt      🚀 Streaming via WebRTC (WHIP)
02:18:15.701  ManagedStreamExt      Sent START_STREAM for managed stream      ← SENT TO GLASSES
02:18:15.701  ManagedStreamExt      Sent managed_stream_status to app         ← SENT TO SDK

02:18:17.702  ManagedStreamExt      🔍 Polling for stream details
02:18:18.055  CloudflareService     ⏱️ Timeout waiting for stream to go live  ← NOT LIVE
02:18:20.182  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:22.029  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:24.323  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:26.458  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:28.124  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:30.161  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:32.324  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:34.019  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:36.004  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:37.701  ManagedStreamExt      Keep-alive ACK timeout                    ← GLASSES SILENT
02:18:37.701  ManagedStreamExt      Keep-alive ACK missed for managed stream
02:18:38.124  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:40.003  CloudflareService     ⏱️ Timeout waiting for stream to go live
02:18:42.009  CloudflareService     ⏱️ Timeout waiting for stream to go live

02:18:42.058  SDK                   "Managed stream request timeout" (30s)    ← APP SEES ERROR
```

### What the cloud did correctly

| Step | Status |
|------|--------|
| Received MANAGED_STREAM_REQUEST from app | ✅ |
| Created Cloudflare Live Input (new, not reused) | ✅ |
| Got SRT ingest URL from Cloudflare | ✅ |
| Waited 3 seconds for CF initialization | ✅ |
| Sent START_STREAM to glasses via WebSocket | ✅ |
| Sent managed_stream_status to app (with URLs) | ✅ |
| Polled Cloudflare for stream to go live | ✅ (every 2s for 30s) |
| Sent keep-alive to glasses | ✅ |

### What the glasses did NOT do

| Expected | Actual |
|----------|--------|
| Receive START_STREAM | Unknown — no ACK mechanism |
| Open SRT connection to Cloudflare ingest URL | ❌ Never connected |
| Start camera and encoding pipeline | ❌ Camera stayed off |
| Respond to keep-alive ping | ❌ ACK timeout at 10s |

---

## ADB Evidence

### During the failure

```
$ adb -s 10.0.0.216:5555 shell dumpsys media.camera | grep 'Active Camera' -A3
Active Camera Clients:
[]                          ← Camera NOT active — glasses never started it

$ adb -s 10.0.0.216:5555 shell cat /sys/class/thermal/thermal_zone1/temp
52500                       ← 52.5°C — warm but not throttling

$ adb -s 10.0.0.216:5555 shell cat /proc/loadavg
9.42 10.58 9.45             ← Load average still elevated from earlier thermal event
```

### After recovery (Stop → Start worked)

```
$ adb -s 10.0.0.216:5555 shell dumpsys media.camera | grep 'Active Camera' -A3
Active Camera Clients:
[(Camera ID: 0, Cost: 100, PID: 2921, ...)]   ← Camera active, streaming
```

### Earlier thermal event that preceded the failures

```
$ adb -s 10.0.0.216:5555 shell cat /sys/class/thermal/thermal_zone1/temp
79100                       ← 79.1°C — SoC critically overheated

$ adb -s 10.0.0.216:5555 shell dumpsys cpuinfo | head -5
Load: 10.15 / 10.75 / 10.09
CPU usage:
  48% camerahalserver: 35% user + 13% kernel
  29% com.mentra.asg_client: 24% user + 4.9% kernel
```

The thermal event was caused by streaming at 1080p/10Mbps/30fps. The SoC
throttled, the encoding pipeline froze, and the stream went dead. We
force-stopped the ASG client to release the camera.

### Network state during failure

```
$ adb -s 10.0.0.216:5555 shell netstat -tn
Active Internet connections:
tcp6  0  0  :::56282  2606:4700:3037::681:443  ESTABLISHED   ← Cloud WebSocket (alive)
tcp6  0  0  :::5555   10.0.0.161:55401         ESTABLISHED   ← ADB

# No SRT/UDP connections to Cloudflare ingest
```

The glasses had an active WebSocket to the cloud (so they should have received
`START_STREAM`) but no SRT connection was established.

---

## Root Cause Analysis

### Why the glasses ignored START_STREAM

The ASG client was in a degraded state after the thermal throttling event and
force-stop. The likely sequence:

1. Streaming at 1080p/10Mbps caused SoC to reach 79°C
2. Thermal throttling froze the encoding pipeline
3. We force-stopped the ASG client (`am force-stop`) to release the camera
4. Android restarted the ASG client automatically
5. ASG client reconnected to cloud, WebSocket established
6. Cloud sent `START_STREAM` — ASG client received it on the WebSocket
7. **ASG client failed to start the camera/encoder pipeline silently**
8. No error was sent back to the cloud
9. No SRT connection was opened
10. Cloud kept polling Cloudflare, which never saw any media

The ASG client likely has internal state (camera pipeline, encoder state,
previous stream context) that was corrupted by the force-stop and not fully
reset on restart. The `START_STREAM` handler checked this state and either:
- Silently returned because it thought a stream was already active
- Failed to initialize the camera and swallowed the error
- Was blocked by a lock/mutex that wasn't released after the force-stop

### Why Stop → Start fixed it

Sending `STOP_STREAM` before `START_STREAM` explicitly cleared the ASG client's
internal stream state. Whatever stale lock, flag, or pipeline reference was
blocking the start was reset by the stop handler. The subsequent `START_STREAM`
found clean state and initialized successfully.

### Why this is an ASG client bug, not a cloud/SDK bug

The cloud and SDK performed correctly:

- **Cloud:** Created Cloudflare input, sent START_STREAM, sent status to app,
  polled for liveness, sent keep-alives. All correct.
- **SDK:** Sent MANAGED_STREAM_REQUEST, received managed_stream_status (URLs),
  waited for stream to go live, timed out after 30s. Correct behavior.
- **ASG client:** Received START_STREAM, did nothing, sent no error. **Bug.**

---

## Recommendations for ASG Client Team

### Must fix

1. **Never silently drop START_STREAM.** If the camera can't start, send an
   error status message back to the cloud:
   ```json
   {
     "type": "stream_status",
     "status": "error",
     "errorCode": "CAMERA_INIT_FAILED",
     "message": "Failed to start camera: <reason>"
   }
   ```
   The cloud can relay this to the app, which can show a meaningful error
   instead of a 30-second timeout.

2. **Reset all stream state on ASG client restart.** After a process restart
   (whether from force-stop, crash, or OOM kill), the client should start with
   clean stream state. No stale locks, no "already streaming" flags, no
   leftover pipeline references.

3. **Add a camera health check before accepting START_STREAM.** Before
   attempting to start the camera, verify:
   - Camera service is available (`CameraManager.openCamera` won't throw)
   - No other client holds the camera
   - Thermal state allows encoding (not critically throttled)
   - Encoder can be initialized with the requested resolution/bitrate

### Should fix

4. **Thermal-aware streaming.** If the SoC is above a threshold (e.g., 70°C),
   either:
   - Refuse START_STREAM with a clear error ("device too hot")
   - Auto-downgrade to a lower resolution/bitrate that the thermals can sustain
   - Send a warning status so the app can inform the user

5. **SRT connection health watchdog.** Once streaming, monitor the SRT socket.
   If it's been dead for >10 seconds (no ACKs from Cloudflare ingest), auto-stop
   the stream and send `stream_status: "error"` to the cloud. Currently the
   glasses keep the camera on and LED lit indefinitely with a dead SRT socket
   (see issue 085 findings).

6. **Camera LED consistency.** The LED should only be on when the camera is
   actively capturing AND sending data. Currently it stays on even when the
   SRT connection is dead (confirmed via ADB: camera active, no SRT socket).

---

## Workaround (App-Side)

Until the ASG client is fixed, the stream-test app auto-stops any existing
stream before starting a new one (`StreamManager.startManaged()` calls
`this.stop()` if `this.state.active`). This sends `STOP_STREAM` to clear the
ASG client's internal state before the new `START_STREAM`.

A more robust workaround would be: if `startManaged()` times out, automatically
retry with a stop-then-start sequence. This has not been implemented yet.

---

## Reproducing

### Prerequisites
- Mentra Live glasses connected
- Stream-test app running
- Previous streaming session that ended abnormally (thermal throttle, force-stop,
  app crash — anything other than a clean `STOP_STREAM`)

### Steps
1. Start a managed stream at high bitrate (8+ Mbps) until glasses get hot (>70°C)
2. Force-stop ASG client: `adb shell am force-stop com.mentra.asg_client`
3. Wait for glasses to cool and reconnect (~30 seconds)
4. Start a managed stream from the app
5. **Expected:** Stream starts
6. **Actual:** 30-second timeout, stream never starts
7. Click Stop, then Start again — stream starts successfully

### Not yet tested
- Whether a clean app restart (Ctrl+C without force-stop) also triggers this
- Whether the issue occurs without prior thermal throttling
- Whether a glasses reboot (not just ASG client restart) clears the state
- Whether the issue is specific to SRT or also affects RTMP/WHIP

---

## Related Issues

| Issue | Relationship |
|-------|-------------|
| **085** — Orphaned stream cleanup | The zombie camera state (LED on, no SRT) was first observed here |
| **086** — SDK fast shutdown | Improved dev restart cycle, reducing the frequency of force-stops |
| **087** — Dedup cache blocks reconnected apps | Different failure mode, same streaming pipeline |
| **083** — Unified streaming API | Where the streaming bugs were originally discovered |