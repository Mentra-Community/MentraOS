# RTMP Reconnection & Status Reporting Issues

## Executive Summary

**StreamPackLite has NO built-in retry mechanism**. All reconnection logic is custom-built in RtmpStreamingService.java. There are two critical issues causing TPAs to lose track of stream state:

1. **Issue #1**: During reconnection attempts, glasses report "stopped"/"disconnected" status, causing TPAs to think the stream is dead when it's actually reconnecting
2. **Issue #2**: Custom reconnection system sometimes fails to trigger, leaving streams permanently dead despite network recovery

---

## StreamPackLite Analysis

### ❌ NO Built-in Retry Mechanism

**Location**: `asg_client/StreamPackLite/extensions/rtmp/src/main/java/.../RtmpProducer.kt`

```kotlin
// Lines 52-68: connect() method
override suspend fun connect(url: String) {
    withContext(coroutineDispatcher) {
        try {
            socket.connect("$url live=1 flashver=FMLE/3.0...")
            _isConnected = true
            onConnectionListener?.onSuccess()  // ✅ Success callback
        } catch (e: Exception) {
            socket = Rtmp()
            _isConnected = false
            onConnectionListener?.onFailed(e.message)  // ❌ Failure callback - NO RETRY
            throw e
        }
    }
}

// Lines 78-100: write() method
override fun write(packet: Packet) {
    synchronized(this) {
        try {
            socket.write(packet.buffer)
        } catch (e: Exception) {
            disconnect()
            isOnError = true
            _isConnected = false
            onConnectionListener?.onLost(e.message)  // ❌ Lost callback - NO RETRY
            throw e
        }
    }
}
```

**Conclusion**: StreamPackLite just calls `onSuccess()`, `onFailed()`, or `onLost()` callbacks. **All reconnection logic must be implemented in RtmpStreamingService.java**.

---

## Complete Status Flow Chain

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          GLASSES (asg_client)                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. StreamPackLite calls:                                               │
│     - onSuccess()  → RtmpStreamingService:396                           │
│     - onFailed()   → RtmpStreamingService:448                           │
│     - onLost()     → RtmpStreamingService:505                           │
│                                                                           │
│  2. RtmpStreamingService schedules reconnection:                        │
│     scheduleReconnect() → RtmpStreamingService:1043                     │
│                                                                           │
│  3. Status callbacks fired:                                             │
│     - onStreamStarting()  → MediaManager:279                            │
│     - onStreamStarted()   → MediaManager:297                            │
│     - onReconnecting()    → MediaManager:344  ⚠️                        │
│     - onReconnected()     → MediaManager:368  ⚠️                        │
│     - onStreamStopped()   → MediaManager:323  🚨 ISSUE #1              │
│     - onStreamError()     → MediaManager:413                            │
│                                                                           │
│  4. MediaManager sends BLE message:                                     │
│     {                                                                    │
│       "type": "rtmp_stream_status",                                     │
│       "status": "reconnecting" | "stopped" | "error" | ...,  🚨         │
│       "streamId": "s1a2b3c"                                             │
│     }                                                                    │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓ BLE
┌─────────────────────────────────────────────────────────────────────────┐
│                        PHONE (android_core / iOS)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  5. Relays message to cloud via WebSocket                               │
│     (no transformation - just forwards)                                  │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓ WebSocket
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLOUD (MentraOS Cloud)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  6. UnmanagedStreamingExtension.handleRtmpStreamStatus()                │
│     Location: UnmanagedStreamingExtension.ts:508                        │
│                                                                           │
│     ⚠️ MAPPING LOGIC (lines 544-594):                                   │
│     switch (status) {                                                    │
│       case "reconnecting":                                              │
│         mappedStatus = "initializing";  // ⚠️ Cloud internal state     │
│         break;                                                           │
│       case "disconnected":                                              │
│       case "stopped":                                                    │
│         mappedStatus = "stopped";       // 🚨 ISSUE #1                  │
│         break;                                                           │
│       case "streaming":                                                  │
│       case "reconnected":                                               │
│         mappedStatus = "active";                                        │
│         break;                                                           │
│     }                                                                    │
│                                                                           │
│  7. sendStreamStatusToApp() → lines 657-141                             │
│     Sends BOTH internal status AND original glasses status:             │
│     - Updates internal state with mappedStatus                          │
│     - BUT forwards ORIGINAL glasses status to TPA  🚨 ISSUE #1          │
│                                                                           │
│     const appOwnerMessage = {                                           │
│       type: "RTMP_STREAM_STATUS",                                       │
│       status: status,  // ← Original glasses status! Not mapped!        │
│       streamId,                                                          │
│       errorDetails,                                                      │
│       stats,                                                             │
│       appId: packageName                                                │
│     };                                                                   │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓ WebSocket
┌─────────────────────────────────────────────────────────────────────────┐
│                            SDK / TPA (App)                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  8. CameraModule.updateStreamState()                                    │
│     Location: camera.ts:619                                             │
│                                                                           │
│     🚨 TERMINAL STATE DETECTION (lines 660-674):                        │
│     if (                                                                 │
│       status.status === "stopped" ||                                    │
│       status.status === "error" ||                                      │
│       status.status === "timeout"                                       │
│     ) {                                                                  │
│       this.isStreaming = false;        // 💀 Stream considered dead     │
│       this.currentStreamUrl = undefined;                                │
│     }                                                                    │
│                                                                           │
│  9. TPA receives status via onStreamStatus() handler                    │
│     - TPA sees "stopped" and thinks stream is dead                      │
│     - But glasses might be reconnecting!                                │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Issue #1: TPAs Receive "Stopped" During Reconnection

### Problem

When glasses experience network issues and begin reconnection:

1. **Glasses call `onStreamStopped()` callback** (MediaManager.java:323)
   - Sends status: `"stopped"` via BLE

2. **Cloud receives and maps it**:
   - Internally maps `"stopped"` → `"stopped"` (correct)
   - BUT forwards **original "stopped" status** to TPA (UnmanagedStreamingExtension.ts:674)

3. **SDK treats "stopped" as terminal** (camera.ts:661):

   ```typescript
   if (status.status === "stopped") {
     this.isStreaming = false // Stream considered dead
     this.currentStreamUrl = undefined
   }
   ```

4. **Meanwhile**, glasses are attempting reconnection:
   - `onReconnecting()` callback fires → sends `"reconnecting"` status
   - `onReconnected()` callback fires → sends `"reconnected"` status
   - **BUT TPA already thinks stream is dead!**

### Root Cause

**Location**: `MediaManager.java:323-340`

```java
@Override
public void onStreamStopped() {
    Log.d(TAG, "RTMP Stream stopped");

    try {
        JSONObject status = new JSONObject();
        status.put("type", "rtmp_stream_status");
        status.put("status", "stopped");  // 🚨 Sends "stopped" even during reconnection!
        String streamId = RtmpStreamingService.getCurrentStreamId();
        if (streamId != null && !streamId.isEmpty()) {
            status.put("streamId", streamId);
        }

        sendRtmpStatusResponse(true, status);
    } catch (JSONException e) {
        Log.e(TAG, "Error creating RTMP stopped status", e);
    }
}
```

This callback is fired by `forceStopStreamingInternal()` which is called both for:

- **Legitimate stops**: User requests stop
- **Reconnection prep**: Cleaning up resources before reconnecting

### Evidence

From `RtmpStreamingService.java:638-669`:

```java
public void startStreaming() {
    synchronized (mStateLock) {
        // Force clean stop before starting
        if (mStreamState != StreamState.IDLE) {
            forceStopStreamingInternal();  // 🚨 Calls onStreamStopped()!
        }
        // ... reconnection attempt continues
    }
}
```

So during reconnection:

1. `startStreaming()` is called (line 638)
2. `forceStopStreamingInternal()` is called (line 656)
3. `onStreamStopped()` callback fires → sends "stopped" to TPA
4. **TPA thinks stream is dead**
5. But immediately after, `startStreaming()` continues and attempts reconnection
6. Later, `onReconnecting()` fires → but TPA already lost context

---

## Issue #2: Fatal Error Handling Leaves Service in Zombie State 🔥

### Problem

**This is the PRIMARY cause of "stream disconnects and doesn't come back"** that the user reported.

**Location**: `RtmpStreamingService.java:465-470` (onFailed callback)

When `onFailed()` detects a "fatal" (non-retryable) error:

```java
if (!isRetryableErrorString(message)) {
    Log.w(TAG, "Fatal error detected - notifying server to stop stream");
    if (sStatusCallback != null) {
        sStatusCallback.onStreamError("RTMP connection failed: " + message);
    }
    return; // ⚠️ Returns WITHOUT calling stopStreaming()!
}
```

**The bug**: It returns early without calling `stopStreaming()` to clean up.

### Zombie State Symptoms

After a "fatal" error, the service is left in a zombie state:

- `mStreamState` is still `STARTING` (or `STREAMING`)
- `mIsStreaming` might still be `true`
- `mReconnecting` is `false`
- No reconnection will ever be scheduled
- No cleanup happens (surface, camera, etc. still held)

**What happens next:**

1. User experiences: "Stream stopped, won't come back"
2. Manual restart: User calls `startStreaming()` again
3. Line 646: Detects `mStreamState != IDLE` (still STARTING!)
4. Line 656: Calls `forceStopStreamingInternal()` to clean up zombie
5. Then starts fresh → **works perfectly!**

### When This Happens

This zombie state occurs when any error is misclassified as "fatal" by `isRetryableErrorString()`:

**Common cellular/WiFi errors that might be misclassified:**

- "Broken pipe" - NOT matched by any pattern, but defaults to retryable ✅
- "Connection reset" - Matched by "Connection" ✅
- "Network unreachable" - Matched by "Network" ✅
- "Host is unreachable" - NOT matched! Could be misclassified ❌
- "Peer disconnected" - NOT matched! Could be misclassified ❌
- "Socket closed" - NOT matched (only checks "SocketException") ❌

Also, the error classification is **case-sensitive**:

- "Connection" matches ✅
- "connection" does NOT match ❌

### Cellular Tower Handoff Scenario

**This is the EXACT bug the user is experiencing**:

When phone switches between cellular towers or networks:

1. **T+0s**: Stream is active, RTMP connected
2. **T+1s**: Phone begins tower handoff → TCP connection briefly drops
3. **T+1.5s**: TCP socket error occurs (e.g., "Host is unreachable", "Socket closed", "Broken pipe")
4. **T+1.5s**: StreamPackLite fires `onFailed("Host is unreachable")`
5. **T+1.5s**: Error doesn't match known patterns → classified as FATAL ❌
6. **T+1.5s**: onFailed() sends error notification BUT returns without cleanup → **ZOMBIE STATE**
7. **T+2s**: Tower handoff completes, network restored
8. **T+2s-∞**: Service stuck in zombie state, no reconnection attempts
9. **User**: "Stream stopped, won't come back"
10. **Manual restart**: startStreaming() → detects non-IDLE state → force cleanup → works ✅

**Key insight**: The network error occurs at the exact moment when WiFi/cellular is TEMPORARILY unavailable, not permanently broken. By the time the user notices (5-10 seconds later), the network has recovered. That's why manual restart works immediately - the network is fine, but the service is stuck in zombie state.

### Compare to onError() Callback

The `onError()` callback handles fatal errors CORRECTLY (lines 384-390):

```java
} else {
    Log.e(TAG, "Fatal error - sending immediate error status");
    if (sStatusCallback != null) {
        sStatusCallback.onStreamError("Fatal streaming error: " + error.getMessage());
    }
    stopStreaming(); // ✅ Properly calls stopStreaming()!
}
```

So `onError()` cleans up properly, but `onFailed()` doesn't.

---

## Issue #3: Additional Reconnection Failure Modes

### Problem

Even when errors are correctly classified as retryable, the reconnection system has additional failure modes:

#### 3a. Race Condition with StreamPack Internal Recovery

**Location**: `RtmpStreamingService.java:473-502`

```java
@Override
public void onFailed(String message) {
    // ...

    // Wait 1 second for library internal recovery
    final int currentSequence = mReconnectionSequence;

    mReconnectHandler.postDelayed(() -> {
        if (currentSequence != mReconnectionSequence) {
            return;  // Stale handler
        }

        if (mStreamState == StreamState.STREAMING && mIsStreaming) {
            Log.d(TAG, "Library recovered internally");
            // ✅ No reconnection needed
        } else if (mStreamState == StreamState.STARTING) {
            scheduleReconnect("connection_failed");  // ✅ Trigger reconnection
        }
        // ...
    }, 1000);  // 1 second delay
}
```

**Problem**: If network recovers between 17ms and 1000ms, state becomes inconsistent:

- StreamPack thinks connection failed
- But state shows STARTING (not STREAMING)
- Reconnection may or may not trigger

#### 3b. First Keep-Alive Race Condition ✅ ALREADY FIXED

**Status**: ⚠️ **This issue is ALREADY FIXED in the current codebase** through two mechanisms:

**1. Cloud-side timing fix**:

- Current code: `KEEP_ALIVE_INTERVAL_MS = 15000` (15 seconds) in UnmanagedStreamingExtension.ts:30
- Keep-alives only start AFTER cloud receives "streaming" status from glasses
- First keep-alive sent ~15 seconds after stream becomes active

**2. Glasses-side fallback protection**:

- RtmpCommandHandler.java:169-173 already has fallback logic
- If `resetStreamTimeout()` fails BUT `isStreaming()` is true, ACKs anyway
- Doesn't force-stop on unknown streamId (just logs warning)

**Current Timeline**:

```
T+0s:    Cloud sends START_RTMP_STREAM
T+0s:    Glasses receive, set mCurrentStreamId, state = STARTING
T+0-2s:  RTMP connection in progress
T+1.2s:  RTMP connects → scheduleStreamTimeout() → mIsStreamingActive = true
T+1.2s:  Glasses send "streaming" status to cloud
T+1.2s:  Cloud receives → lifecycle.setActive(true) → starts keep-alive timer
T+16.2s: First keep-alive sent (15s after activation)
T+16.2s: Both mCurrentStreamId and mIsStreamingActive already set ✅
```

**Current RtmpCommandHandler code** (lines 148-180):

```java
public boolean handleKeepAliveCommand(JSONObject data) {
    String streamId = data.optString("streamId", "");
    String ackId = data.optString("ackId", "");

    boolean streamIdValid = RtmpStreamingService.resetStreamTimeout(streamId);
    if (streamIdValid) {
        // Stream is active and recognized
        streamingManager.sendKeepAliveAck(streamId, ackId);
        return true;
    } else {
        // ✅ FALLBACK: Check if we're still streaming
        if (RtmpStreamingService.isStreaming()) {
            // We're in the process of streaming but not fully active yet
            Log.d(TAG, "Stream still initializing, ACKing keep-alive anyway (streamId: " + streamId + ")");
            streamingManager.sendKeepAliveAck(streamId, ackId);
            return true;
        } else {
            // Not streaming at all - this is an orphaned keep-alive
            Log.w(TAG, "Keep-alive for unknown stream, not currently streaming: " + streamId);
            // ✅ Don't forcefully stop - let cloud timeout naturally
            return false;
        }
    }
}
```

**Conclusion**: The old documentation referenced a 1-second keep-alive interval that no longer exists. Current 15-second interval + fallback logic provides robust protection against this race condition.

#### 3c. Reconnection Counter Reset Too Early

**Location**: `RtmpStreamingService.java:403-416`

```java
@Override
public void onSuccess() {
    synchronized (mStateLock) {
        mStreamState = StreamState.STREAMING;
        mIsStreaming = true;

        mReconnectAttempts = 0;  // 🚨 Reset before callback fires!
        boolean wasReconnecting = mReconnecting;
        mReconnecting = false;

        if (wasReconnecting) {
            if (sStatusCallback != null) {
                sStatusCallback.onReconnected(mRtmpUrl, mReconnectAttempts);
                                                        // ↑ Always 0!
            }
        }
    }
}
```

**Impact**: TPAs never know how many reconnection attempts actually occurred, making it impossible to implement heuristics like "if more than 5 reconnections in 1 minute, show warning to user".

#### 3d. Max Reconnect Attempts Exhausted

**Location**: `RtmpStreamingService.java:1043-1060`

```java
private void scheduleReconnect(String reason) {
    if (mReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {  // 10 attempts
        Log.w(TAG, "Maximum reconnection attempts reached, giving up.");

        if (sStatusCallback != null) {
            sStatusCallback.onReconnectFailed(MAX_RECONNECT_ATTEMPTS);
        }

        stopStreaming();  // 🚨 Permanent stop - no more reconnections!
        return;
    }
    // ...
}
```

**Problem**: After 10 failed reconnection attempts (which can happen quickly with exponential backoff), stream is permanently stopped. If WiFi recovers later, **no automatic reconnection** will occur.

**Reconnection delays** (calculated by line 1116-1120):

```
Attempt 1: ~1 second
Attempt 2: ~1.5 seconds
Attempt 3: ~2.25 seconds
Attempt 4: ~3.4 seconds
Attempt 5: ~5.1 seconds
Attempt 6: ~7.6 seconds
Attempt 7: ~11.4 seconds
Attempt 8: ~17.1 seconds
Attempt 9: ~25.7 seconds
Attempt 10: ~38.5 seconds
Total: ~113 seconds
```

So if WiFi is unstable for **less than 2 minutes**, stream gives up permanently!

---

## Proposed Fixes

### 🔥 **CRITICAL - Fix #1: Stop Streaming After Fatal Errors**

**Location**: `RtmpStreamingService.java:465-470`

This is the PRIMARY fix for "stream disconnects and doesn't come back" issue.

**Current code**:

```java
if (!isRetryableErrorString(message)) {
    Log.w(TAG, "Fatal error detected - notifying server to stop stream");
    if (sStatusCallback != null) {
        sStatusCallback.onStreamError("RTMP connection failed: " + message);
    }
    return; // ⚠️ BUG: Returns without cleanup!
}
```

**Fixed code**:

```java
if (!isRetryableErrorString(message)) {
    Log.w(TAG, "Fatal error detected - stopping stream");
    if (sStatusCallback != null) {
        sStatusCallback.onStreamError("RTMP connection failed: " + message);
    }
    stopStreaming(); // ✅ Clean up properly!
    return;
}
```

**Impact**: This single line prevents the zombie state that requires manual restart.

---

### 🔥 **CRITICAL - Fix #2: Improve Error Classification**

**Location**: `RtmpStreamingService.java:363-414`

Make error classification case-insensitive and add more network error patterns:

**Current code** (line 373-380):

```java
if (message.contains("SocketException") ||
    message.contains("Connection") ||
    message.contains("Timeout") ||
    // ...
```

**Fixed code**:

```java
// Convert to lowercase for case-insensitive matching
String lowerMessage = message.toLowerCase();

if (lowerMessage.contains("socket") ||
    lowerMessage.contains("connection") ||
    lowerMessage.contains("timeout") ||
    lowerMessage.contains("network") ||
    lowerMessage.contains("unreachable") ||
    lowerMessage.contains("disconnected") ||
    lowerMessage.contains("pipe") ||  // "Broken pipe"
    lowerMessage.contains("refused") ||
    lowerMessage.contains("reset") ||
    lowerMessage.contains("host") ||
    lowerMessage.contains("ioexception") ||
    lowerMessage.contains("econnrefused") ||
    lowerMessage.contains("etimedout")) {
    Log.d(TAG, "Error classified as RETRYABLE (network issue)");
    return true;
}
```

**Impact**: Prevents legitimate network errors from being misclassified as fatal.

---

### 🔴 **HIGH Priority - Fix #3: Don't Send "Stopped" Status During Reconnection**

**Location**: `MediaManager.java:323-340` (onStreamStopped callback)

**Current code**:

```java
@Override
public void onStreamStopped() {
    try {
        JSONObject status = new JSONObject();
        status.put("type", "rtmp_stream_status");
        status.put("status", "stopped");  // 🚨 Always "stopped"
        // ...
        sendRtmpStatusResponse(true, status);
    }
}
```

**Proposed fix**:

```java
@Override
public void onStreamStopped() {
    // Check if we're reconnecting - if so, don't send "stopped" status
    if (RtmpStreamingService.isReconnecting()) {
        Log.d(TAG, "Stream stopped for reconnection - not sending stopped status to TPA");
        return;  // ✅ Skip status update during reconnection
    }

    try {
        JSONObject status = new JSONObject();
        status.put("type", "rtmp_stream_status");
        status.put("status", "stopped");
        // ...
        sendRtmpStatusResponse(true, status);
    }
}
```

**Alternative approach**: Send "reconnecting" status instead:

```java
@Override
public void onStreamStopped() {
    try {
        JSONObject status = new JSONObject();
        status.put("type", "rtmp_stream_status");

        // If reconnecting, send "reconnecting" instead of "stopped"
        if (RtmpStreamingService.isReconnecting()) {
            status.put("status", "reconnecting");
            status.put("attempt", RtmpStreamingService.getReconnectAttempt());
            status.put("maxAttempts", 10);
        } else {
            status.put("status", "stopped");
        }

        String streamId = RtmpStreamingService.getCurrentStreamId();
        if (streamId != null && !streamId.isEmpty()) {
            status.put("streamId", streamId);
        }

        sendRtmpStatusResponse(true, status);
    }
}
```

### Fix #2: Improve Reconnection Reliability

#### 2a. ~~Fix First Keep-Alive Race~~ ✅ NOT NEEDED

**Status**: ⚠️ **This fix is NOT NEEDED** - the race condition is already resolved through:

1. Cloud-side: 15-second keep-alive interval (plenty of time for RTMP to connect)
2. Glasses-side: Fallback logic in RtmpCommandHandler that ACKs during initialization

**Verification**: See Issue #3b above for detailed analysis of current timing and protections.

**Recommendation**: ❌ **Remove this fix from implementation plan** - resources better spent on Critical fixes #1 and #2.

_Additional improvements (deferred for future consideration):_

- Increase max reconnection attempts beyond 10
- Preserve reconnection counter for TPA heuristics
- Add WiFi state monitoring for proactive reconnection

---

## Testing Plan

### Test Case 1: WiFi Toggle During Stream

**Setup**: Start RTMP stream

**Steps**:

1. Turn off WiFi for 5 seconds
2. Turn WiFi back on
3. Monitor TPA status updates

**Expected**:

- TPA should receive "reconnecting" status (NOT "stopped")
- After reconnection, receive "streaming" or "reconnected" status
- TPA should never think stream is dead

### Test Case 2: Extended WiFi Outage

**Setup**: Start RTMP stream

**Steps**:

1. Turn off WiFi for 3 minutes
2. Turn WiFi back on
3. Monitor reconnection behavior

**Expected (with 20 max attempts)**:

- Stream should reconnect automatically after ~10 minutes of retries
- TPA receives reconnection status updates throughout
- Final "streaming" status when successful

### ~~Test Case 3: First Keep-Alive Race~~ ✅ NOT NEEDED

**Status**: Test case removed - issue is already fixed in current codebase through 15-second keep-alive interval and fallback logic.

### Test Case 4: Rapid WiFi Fluctuations

**Setup**: Simulate WiFi that connects/disconnects every 10 seconds

**Steps**:

1. Start RTMP stream
2. Cycle WiFi 10 times (connect 10s, disconnect 10s)
3. Monitor TPA status

**Expected**:

- TPA always knows stream is reconnecting
- Never receives "stopped" unless explicitly stopped by user
- Stream eventually succeeds when WiFi stabilizes

---

## Summary

1. **StreamPackLite has NO retry mechanism** - all reconnection is custom-built

2. **Issue #1**: TPAs receive "stopped" status during reconnection because:
   - `onStreamStopped()` fires during cleanup before reconnection
   - Cloud forwards raw status to TPA
   - SDK treats "stopped" as terminal state

3. **Issue #2** 🔥: **Fatal error handling leaves service in zombie state** (PRIMARY CAUSE):
   - When `onFailed()` detects "fatal" error, it returns without calling `stopStreaming()`
   - Service left in zombie state: `mStreamState` still STARTING, no reconnection scheduled
   - **Symptoms**: "Stream disconnects and doesn't come back, but manual restart works"
   - **Fix**: Call `stopStreaming()` before returning

4. **Issue #3**: Additional reconnection failure modes:
   - ~~First keep-alive race condition~~ ✅ ALREADY FIXED
   - Max 10 attempts exhausted too quickly (~2 minutes)
   - Reconnection counter reset too early
   - Error classification too rigid (case-sensitive, missing patterns)

**Implemented fixes** (completed 2025-10-15):

1. ✅ **CRITICAL**: Fix #1 - Call stopStreaming() after fatal errors (RtmpStreamingService.java:470)
2. ✅ **CRITICAL**: Fix #2 - Improve error classification (RtmpStreamingService.java:1406-1464)
3. ✅ **HIGH**: Fix #3 - Don't send "stopped" during reconnection (MediaManager.java:323-330)
4. ~~🔴 **HIGH**: Fix #4 - Fix first keep-alive race~~ ✅ **ALREADY FIXED** (15s interval + fallback logic)

_Additional improvements deferred for future consideration:_

- Increase max reconnection attempts beyond 10
- Preserve reconnection counter for TPA heuristics
- Add WiFi state monitoring for proactive reconnection
