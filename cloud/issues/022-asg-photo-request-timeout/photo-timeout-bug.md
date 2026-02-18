# Photo Timeout Bug - Root Cause Analysis

## Problem

Photo requests intermittently time out after exactly 30 seconds. Pattern observed:

- Several photos succeed (1-2 second response time)
- Random photo times out (exactly 30 seconds)
- Next photo succeeds again

Example log pattern:

```
#27 ✅ success (2.3s)
#28 ❌ timeout (30.0s)
#29 ✅ success (2.2s)
#30 ❌ timeout (30.0s)
#31 ✅ success (2.3s)
```

## Root Cause

**Bug Location**: `CameraNeo.java` line 448-464

In `enqueuePhotoRequest()`, when the camera is "ready and idle", the fast path processes the request immediately but **does NOT cancel the keep-alive timer** from the previous photo.

```java
// CameraNeo.java line 446-464
if (isServiceRunning && isCameraReady && sInstance != null) {
    if (sInstance.shotState == ShotState.IDLE) {
        Log.d(TAG, "Camera ready and idle - processing request immediately");
        // ❌ BUG: No cancelKeepAliveTimer() call here!
        PhotoRequest queuedRequest = globalRequestQueue.poll();
        if (queuedRequest != null) {
            sInstance.sPhotoCallback = queuedRequest.callback;
            sInstance.pendingPhotoPath = queuedRequest.filePath;
            sInstance.pendingRequestedSize = queuedRequest.size;
            sInstance.pendingIsFromSdk = queuedRequest.isFromSdk;
            sInstance.shotState = ShotState.WAITING_AE;

            if (sInstance.backgroundHandler != null) {
                sInstance.backgroundHandler.post(sInstance::startPrecaptureSequence);
            } else {
                sInstance.startPrecaptureSequence();
            }
        }
    }
}
```

## Failure Timeline

```
T=0.000s    Photo A completes, processQueuedPhotoRequests() called
T=0.001s    Queue empty → startKeepAliveTimer(3000ms) ← Timer starts counting
T=0.700s    Photo B request arrives
T=0.701s    Camera is "ready and idle" → fast path triggers
T=0.702s    shotState = WAITING_AE, startPrecaptureSequence() called
T=0.703s    AE convergence begins (timer still running!)
T=1.500s    AE converges, capture request submitted (timer still running!)
T=3.001s    ⚠️ TIMER FIRES: closeCamera() + stopSelf()
T=3.002s    Camera closes MID-CAPTURE, image never saved
T=3.003s    No upload occurs, SDK never receives response
T=30.700s   SDK timeout fires → "Photo request timed out"
```

## Evidence from Logs

**ASG Client Logcat** (glasses side):

```
21:30:38.030  ✅ Photo uploaded successfully - ID: photo_req_...dhqk2fb (Photo A)
21:30:38.030  ✅ Upload completed - system marked as available

21:30:38.771  📸 Enqueued photo request: ...7hygoyz | Queue size: 1 | Service state: RUNNING
21:30:38.771  Camera ready and idle - processing request immediately
21:30:38.771  📸 Photo capturing started - ID: photo_req_...7hygoyz
21:30:38.771  🔍 DIAGNOSTIC: startPrecaptureSequence() called
21:30:38.836  🔍 AE converged! Requesting AE lock

21:30:40.734  Camera keep-alive timer expired, closing camera  ← TIMER FIRED!
21:30:41.545  CameraNeo service destroying - Setting state to IDLE

(No "Photo saved successfully" or "Upload completed" log for ...7hygoyz)
```

**SDK Logs** (app server side):

```
13:30:39.900  📸 Added photo request to pending queue - requestId: photo_req_...7hygoyz
13:30:39.901  📸 Photo request sent
...
(No "📸 Received photo response" for ...7hygoyz)
...
13:31:09.902  📸 Photo request timed out - requestId: photo_req_...7hygoyz
```

## Comparison with Working Code Paths

Every other code path that starts a new photo capture **cancels the timer**:

| Location                                           | Line    | Cancels Timer? |
| -------------------------------------------------- | ------- | -------------- |
| `setupCameraForPhotoRequest()` - reusing camera    | 817     | ✅ Yes         |
| `setupCameraAndTakePicture()` - camera kept alive  | 860     | ✅ Yes         |
| `processQueuedPhotoRequests()` - processing queued | 2200    | ✅ Yes         |
| `enqueuePhotoRequest()` - fast path                | 448-464 | ❌ **NO**      |

## Fix

Add `sInstance.cancelKeepAliveTimer();` at line 449:

```java
if (sInstance.shotState == ShotState.IDLE) {
    Log.d(TAG, "Camera ready and idle - processing request immediately");
    sInstance.cancelKeepAliveTimer();  // ✅ ADD THIS LINE
    PhotoRequest queuedRequest = globalRequestQueue.poll();
    // ... rest unchanged
}
```

**File**: `asg_client/app/src/main/java/com/mentra/asg_client/camera/CameraNeo.java`

## Testing

1. Run an app that takes consecutive photos (e.g., capturing once previous response completes)
2. Observe photo capture logs
3. Verify no more "Camera keep-alive timer expired" mid-capture
4. Verify all photo requests complete successfully

## Risk Assessment

**Low risk** - This is consistent with the pattern used in all other code paths. The `cancelKeepAliveTimer()` function is idempotent (safe to call multiple times) and simply cancels any pending timer.

## Related Code

- **Keep-alive timer start**: Line 2148-2178 (`startKeepAliveTimer()`)
- **Keep-alive timer cancel**: Line 2266-2271 (`cancelKeepAliveTimer()`)
- **Timer duration**: Line 131 (`CAMERA_KEEP_ALIVE_MS = 3000`)
