# Spike: HLS URL Not Delivered to v2 Apps on Debug Cloud

## Overview

**What this doc covers:** Why v2 SDK apps (specifically Livestreamer) fail to receive HLS URLs when starting managed streams on the debug cloud, while working correctly on production.
**Why this doc exists:** CTO bug report — Livestreamer couldn't get HLS URL when streaming to Twitter via debug cloud. Works on prod.
**Who should read this:** Cloud engineers, SDK developers.

## Background

The debug cloud runs branch `cloud/issues-048` which includes all v3 SDK cloud support changes. The production cloud runs `dev`. A v2 SDK app (Livestreamer) works on prod but fails on debug — confirming a backward compatibility regression introduced by the v3 changes.

The Livestreamer app uses the v2 SDK's `startManagedStream()` with restream destinations (Twitter RTMP URL). In restream mode, the cloud uses SRT ingest with HLS/DASH playback (not WebRTC). The app expects `managed_stream_status` with `hlsUrl` in the response.

## Findings

### 1. `deliverActiveStreamState()` runs for ALL apps, including v2

In `AppManager.attachAppSocket()` (the shared connection path for both v2 and v3 apps), two new calls were added on the 048 branch:

```typescript
// cloud/packages/cloud/src/services/session/AppManager.ts, attachAppSocket()
this.userSession.managedStreamingExtension.clearLastSentStatus(packageName);
this.deliverActiveStreamState(packageName, ws);
```

These run unconditionally — no `isV3` check. Every app that connects gets proactive stream state delivery.

### 2. `deliverActiveStreamState()` sends stale `managed_stream_status` with `status: "active"`

If the cloud's `StreamRegistry` has a leftover managed stream from a previous session (common on debug — streams persist across app restarts), `deliverActiveStreamState()` sends:

```typescript
{
  type: "managed_stream_status",
  status: "active",
  streamId: "<stale_stream_id>",
  hlsUrl: "<stale_url>",
  dashUrl: "<stale_url>",
  webrtcUrl: "<stale_url>",
  resumed: true,
  timestamp: new Date(),
}
```

### 3. The v2 SDK's `handleManagedStreamStatus` sets `isManagedStreaming = true`

When the v2 SDK's `CameraManagedExtension` receives `managed_stream_status` with `status: "active"`, it unconditionally sets internal state:

```typescript
// cloud/packages/sdk/src/app/session/modules/camera-managed-extension.ts, line ~385
if (status.status === "active") {
  this.isManagedStreaming = true;           // ← poisoned
  this.currentManagedStreamId = status.streamId;  // ← stale ID
  // ...
}
```

This happens BEFORE the user has started any stream. The SDK now thinks a managed stream is active.

### 4. `startManagedStream()` throws "Already streaming"

When the user clicks "Stream to Twitter" in the Livestreamer app, it calls `startManagedStream()`. The first thing that method does:

```typescript
// cloud/packages/sdk/src/app/session/modules/camera-managed-extension.ts, line ~151
if (this.isManagedStreaming) {
  throw new Error("Already streaming. Stop the current managed stream before starting a new one.");
}
```

Since `isManagedStreaming` was set to `true` by the stale proactive delivery, the call throws immediately. The user never gets an HLS URL because the stream never starts.

### 5. This only happens when the StreamRegistry has a stale stream

If the debug cloud has no leftover streams (fresh restart, no previous streaming), `deliverActiveStreamState()` sends nothing and v2 apps work fine. This explains why the bug is intermittent — it depends on whether a previous stream exists in memory.

### 6. Production is not affected

The production cloud runs the `dev` branch which does NOT have `deliverActiveStreamState()` or `clearLastSentStatus()`. V2 apps connect with the original `handleAppInit()` code path which never sends unsolicited `managed_stream_status`.

## Root Cause

`deliverActiveStreamState()` was designed for v3 apps that expect proactive stream state on connect. It was added to the shared `attachAppSocket()` code path without gating on `isV3`, so v2 apps also receive unsolicited `managed_stream_status` messages. The v2 SDK's internal state machine doesn't expect this and sets `isManagedStreaming = true` from the stale data, blocking all subsequent `startManagedStream()` calls.

## Conclusions

| Finding | Impact | Fix |
|---------|--------|-----|
| `deliverActiveStreamState()` runs for v2 apps | Breaks managed streaming for v2 apps when stale streams exist | Gate on `isV3` |
| `clearLastSentStatus()` runs for v2 apps | Lower risk but unnecessary for v2 | Gate on `isV3` |
| v2 SDK trusts unsolicited `managed_stream_status` | Sets internal state that blocks new streams | Can't fix in published v2 SDK — must fix cloud-side |

## Next Steps

Write spec for gating `deliverActiveStreamState()` and `clearLastSentStatus()` on `connectedAppSession.isV3` in `attachAppSocket()`.