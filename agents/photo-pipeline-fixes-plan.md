# Photo Pipeline Fixes: Concurrency Guard, WiFi-Aware Upload, Timing Instrumentation

**Status: IMPLEMENTED** — Build verified (`assembleDebug` passes).

## Context

Photo requests from the SDK take 5-14 seconds for a single photo. Concurrent photo requests all timeout at exactly 30 seconds with a generic "Photo request timed out" (OS-947) because CameraNeo silently queues them instead of rejecting. The webhook direct-upload path always wastes 2s on a doomed connection attempt even when there's no WiFi. There is no per-request timing instrumentation to diagnose the unexplained 4.8s post-capture gap.

Three targeted fixes on the ASG client side only. All changes in `MediaCaptureService.java` and `PhotoCommandHandler.java`.

---

## Change 1: `isCapturingPhoto` Concurrency Guard (OS-947 Fix)

**Problem:** Multiple SDK photo requests pass all existing guards (video recording, BLE transfer, upload busy), enter CameraNeo's `globalRequestQueue`, and silently wait. The queue processes them sequentially (~12s each), but the SDK's 30s timeout fires first → generic "Photo request timed out" error. The specific error propagation chain (glasses→phone→cloud→SDK) exists at every hop but is never triggered because CameraNeo doesn't generate an error — it just queues.

**Fix:** Add an `AtomicBoolean isCapturingPhoto` to `MediaCaptureService`. Set it atomically before calling CameraNeo, clear it in the capture callback (both success and error). Reject concurrent SDK requests with `CAMERA_BUSY` error via the existing `sendPhotoErrorResponse()` chain. Also add an early check in `PhotoCommandHandler` as a first line of defense.

**Result:** Developer gets `Error("CAMERA_BUSY: Another photo capture is in progress")` in <1 second instead of waiting 30 seconds for a generic timeout. CameraNeo's queue still exists for non-SDK use cases (physical button presses).

### Files to modify

**`MediaCaptureService.java`** (`asg_client/app/src/main/java/com/mentra/asg_client/io/media/core/MediaCaptureService.java`)

1. **Add import** (top of file):
   ```java
   import java.util.concurrent.atomic.AtomicBoolean;
   ```

2. **Add field** after line 288 (`private final Object uploadLock = new Object();`):
   ```java
   // Capture state tracking - prevent concurrent camera captures from SDK
   private final AtomicBoolean isCapturingPhoto = new AtomicBoolean(false);
   ```

3. **Add public accessor** (near `isUploadingPhoto()` at line 1456):
   ```java
   public boolean isCapturingPhoto() {
       return isCapturingPhoto.get();
   }
   ```

4. **Guard in `takePhotoAndUpload()`** — after the `isUploadingPhoto` check (line 1349), before line 1351:
   ```java
   // Check if camera capture is already in progress - reject concurrent SDK requests
   if (!isCapturingPhoto.compareAndSet(false, true)) {
       Log.w(TAG, "🚫 Camera busy - photo capture already in progress: " + requestId);
       sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Another photo capture is in progress");
       return;
   }
   ```
   Note: `compareAndSet` is atomic — no synchronized block needed. It sets to `true` only if currently `false`, preventing race conditions between concurrent requests.

5. **Clear in `onPhotoCaptured` callback** (line 1403, start of callback body):
   ```java
   isCapturingPhoto.set(false);
   ```

6. **Clear in `onPhotoError` callback** (line 1428, start of callback body):
   ```java
   isCapturingPhoto.set(false);
   ```

7. **Clear in catch block** (line 1441, before error handling):
   ```java
   isCapturingPhoto.set(false);
   ```

8. **Same pattern for `takePhotoForBleTransfer()`**:
   - Guard after storage check (line 2195), before line 2197: same `compareAndSet` check
   - Clear in `onPhotoCaptured` callback (line 2238, start of body)
   - Clear in `onPhotoError` callback (line 2259, start of body)
   - Clear in catch block (line 2273, before error handling)

9. **`takePhotoAutoTransfer()`** — no guard needed here since it delegates to `takePhotoAndUpload()` (or after Change 2, to `takePhotoForBleTransfer()`), both of which already have the guard.

**`PhotoCommandHandler.java`** (`asg_client/app/src/main/java/com/mentra/asg_client/service/core/handlers/PhotoCommandHandler.java`)

10. **Add early guard** after the BLE transfer check (line 130), before line 132:
    ```java
    // CAPTURE CHECK: Reject if another photo capture is already in progress
    if (captureService.isCapturingPhoto()) {
        Log.w(TAG, "🚫 Photo request rejected - capture already in progress");
        logCommandResult("take_photo", false, "Photo capture in progress - request rejected");
        captureService.sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Another photo capture is in progress");
        return false;
    }
    ```

This gives two layers of defense: handler-level early rejection (fast path, no method call overhead) + MediaCaptureService-level atomic guard (catches race conditions if two requests slip past the handler check simultaneously).

### Safety timeout (prevents permanent lockout)

CameraNeo has edge cases where neither `onPhotoCaptured` nor `onPhotoError` callback fires (e.g., `cameraOpenCloseLock.tryAcquire` timeout throws uncaught `RuntimeException` in `onOpened()`, service destroy race conditions). If `isCapturingPhoto` stays true, users are permanently locked out of photos until app restart.

**Fix:** A 15-second safety timeout on `mainHandler` that force-resets `isCapturingPhoto` and sends a `CAPTURE_TIMEOUT` error if no callback fires. Started alongside every `compareAndSet(false, true)`, cancelled alongside every `set(false)`. Uses `compareAndSet(true, false)` itself to be safe against double-fire.

---

## Change 2: WiFi-Aware Webhook Upload

**Problem:** `isWiFiConnected()` exists at line 2104 but uses the deprecated `NetworkInfo` API, which was unreliable on modern Android. Someone removed it from the call path (line 2146 comment: "internet test removed due to unreliability"). Now every auto-transfer photo blindly attempts the webhook, waits for the 2s connect timeout to fail, THEN falls back to BLE. This adds 2 wasted seconds to every photo when glasses have no WiFi.

**Fix:** Replace with modern `ConnectivityManager.getActiveNetwork()` + `NetworkCapabilities` API (reliable on API 23+). Re-add the WiFi check in `takePhotoAutoTransfer()` — skip straight to BLE when no WiFi. When WiFi IS present, bump connect timeout to 5s to give direct upload a fair shot (DNS+TCP+TLS needs more than 2s at 100-350ms ping latency).

**Result:** No-WiFi photos save 2+ seconds (skip doomed webhook attempt). WiFi photos get a real chance at direct upload, which eliminates the entire BLE path when it works (~1.4s saved).

### Files to modify

**`MediaCaptureService.java`**

1. **Add import**:
   ```java
   import android.net.NetworkCapabilities;
   ```

2. **Replace `isWiFiConnected()` method** (lines 2101-2113) with modern API:
   ```java
   /**
    * Check if WiFi is connected using modern NetworkCapabilities API.
    * Used to decide whether to attempt direct webhook upload or skip to BLE.
    */
   private boolean isWiFiConnected() {
       try {
           ConnectivityManager cm = (ConnectivityManager) mContext.getSystemService(Context.CONNECTIVITY_SERVICE);
           if (cm == null) return false;
           android.net.Network activeNetwork = cm.getActiveNetwork();
           if (activeNetwork == null) return false;
           NetworkCapabilities caps = cm.getNetworkCapabilities(activeNetwork);
           return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
       } catch (Exception e) {
           Log.e(TAG, "Error checking WiFi connectivity", e);
           return false;
       }
   }
   ```

3. **Update `takePhotoAutoTransfer()`** — replace the unconditional call to `takePhotoAndUpload` with WiFi-aware routing. **Key detail:** tracking map storage (`photoBleIds`, `photoOriginalPaths`, etc.) is moved inside the WiFi branch since `takePhotoForBleTransfer()` manages its own tracking internally — prevents map entry leaks:
   ```java
   if (isWiFiConnected()) {
       // Store tracking data needed by webhook's BLE fallback path
       photoSaveFlags.put(requestId, save);
       photoBleIds.put(requestId, bleImgId);
       photoOriginalPaths.put(requestId, photoFilePath);
       photoRequestedSizes.put(requestId, size);

       Log.d(TAG, "📶 WiFi connected - attempting direct upload for " + requestId);
       takePhotoAndUpload(photoFilePath, requestId, webhookUrl, authToken, save, size, enableFlash, enableSound, compress);
   } else {
       // No WiFi - skip webhook entirely, go straight to BLE (saves 2-5s timeout wait)
       Log.d(TAG, "📵 No WiFi - skipping webhook, using BLE transfer for " + requestId);
       takePhotoForBleTransfer(photoFilePath, requestId, bleImgId, save, size, enableFlash, enableSound);
   }
   ```

4. **Bump `connectTimeout` in `performDirectUpload()`** — change line 1691 from 2s to 5s, and update the stale comment on line 1686-1689:
   ```java
   // Create multipart form request with WiFi-appropriate timeouts:
   // - 5 seconds to connect (allows time for DNS+TCP+TLS over WiFi)
   // - 10 seconds to write the photo data
   // - 5 seconds to read the response
   OkHttpClient client = new OkHttpClient.Builder()
           .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)  // Allow time for DNS+TCP+TLS on WiFi
           .writeTimeout(10, java.util.concurrent.TimeUnit.SECONDS)   // Time to upload photo data
           .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)     // Time to get response
           .build();
   ```

5. **Remove old import** if `NetworkInfo` is no longer used elsewhere:
   ```java
   // Remove: import android.net.NetworkInfo;
   ```
   (Check if `NetworkInfo` is referenced anywhere else in the file first.)

---

## Change 3: Per-Request Timing Instrumentation

**Problem:** There's a ~4.8s unexplained gap between camera callback and upload start. The existing `ENABLE_PHOTO_TIMING_LOGS` flag only has 2 timing points (request start, capture complete). We need granular per-request timing across all phases to identify where the time goes.

**Fix:** Add a lightweight `Map<String, Map<String, Long>>` timing tracker that records timestamps at each phase boundary, keyed by requestId. Dump the full timing map when the request completes (success, error, or BLE done). Gate behind the existing `ENABLE_PHOTO_TIMING_LOGS` flag (which we'll enable by default — overhead is negligible: just `HashMap.put()` + `System.currentTimeMillis()` per phase).

**Result:** Logcat output like:
```
⏱️ [TIMING] Request photo_req_123 phases:
  request_start: +0ms (delta: 0ms)
  enqueue_camera: +15ms (delta: 15ms)
  photo_captured: +5023ms (delta: 5008ms)
  upload_start: +9845ms (delta: 4822ms)     ← THE 4.8s GAP
  webhook_upload_begin: +9850ms (delta: 5ms)
  direct_upload_thread_start: +9855ms (delta: 5ms)
  direct_upload_response: +11901ms (delta: 2046ms)
  upload_failed_ble_fallback: +11905ms (delta: 4ms)
  ble_compress_start: +11910ms (delta: 5ms)
  ble_compress_done: +12357ms (delta: 447ms)
  ble_send_start: +12360ms (delta: 3ms)
  ble_ready_msg: +12365ms (delta: 5ms)
  ble_file_transfer_start: +12570ms (delta: 205ms)
  ble_transfer_done: +13085ms (delta: 515ms)
  TOTAL: 13085ms
```

### Files to modify

**`MediaCaptureService.java`**

1. **Enable the flag** — change line 198:
   ```java
   private static final boolean ENABLE_PHOTO_TIMING_LOGS = true;
   ```

2. **Add timing map field** near the other tracking maps (after line ~284):
   ```java
   // Per-request timing instrumentation (gated by ENABLE_PHOTO_TIMING_LOGS)
   private final Map<String, Map<String, Long>> photoTimings = new HashMap<>();
   ```

3. **Add helper methods** (near the other photo utility methods):
   ```java
   /**
    * Record a timing checkpoint for a photo request.
    * No-op if ENABLE_PHOTO_TIMING_LOGS is false.
    */
   private void recordTiming(String requestId, String phase) {
       if (!ENABLE_PHOTO_TIMING_LOGS) return;
       photoTimings.computeIfAbsent(requestId, k -> new java.util.LinkedHashMap<>())
           .put(phase, System.currentTimeMillis());
   }

   /**
    * Dump all recorded timings for a photo request and clean up.
    * Shows cumulative time from start and delta between each phase.
    * No-op if ENABLE_PHOTO_TIMING_LOGS is false.
    */
   private void dumpTimings(String requestId) {
       if (!ENABLE_PHOTO_TIMING_LOGS) return;
       Map<String, Long> timings = photoTimings.remove(requestId);
       if (timings == null || timings.isEmpty()) return;

       StringBuilder sb = new StringBuilder();
       sb.append("⏱️ [TIMING] Request ").append(requestId).append(" phases:\n");
       long firstTime = 0;
       long prevTime = 0;
       for (Map.Entry<String, Long> entry : timings.entrySet()) {
           long time = entry.getValue();
           if (firstTime == 0) { firstTime = time; prevTime = time; }
           sb.append("  ").append(entry.getKey())
             .append(": +").append(time - firstTime).append("ms")
             .append(" (delta: ").append(time - prevTime).append("ms)\n");
           prevTime = time;
       }
       sb.append("  TOTAL: ").append(prevTime - firstTime).append("ms");
       Log.i(TAG, sb.toString());
   }
   ```

4. **Instrument `takePhotoAndUpload()` flow**:
   | Location | Line | Call |
   |----------|------|------|
   | Method entry | 1299 | `recordTiming(requestId, "request_start");` |
   | Before CameraNeo enqueue | 1395 | `recordTiming(requestId, "enqueue_camera");` |
   | onPhotoCaptured callback | 1403 | `recordTiming(requestId, "photo_captured");` |
   | Before upload call | 1423 | `recordTiming(requestId, "upload_start");` |

5. **Instrument `uploadPhotoToWebhook()`**:
   | Location | Line | Call |
   |----------|------|------|
   | Method entry | 1478 | `recordTiming(requestId, "webhook_upload_begin");` |

6. **Instrument `performDirectUpload()`**:
   | Location | Line | Call |
   |----------|------|------|
   | Thread start | 1672 | `recordTiming(requestId, "direct_upload_thread_start");` |
   | After HTTP execute | 1722 | `recordTiming(requestId, "direct_upload_response");` |
   | Success path | 1728 | `recordTiming(requestId, "upload_success"); dumpTimings(requestId);` |
   | BLE fallback trigger | 1771 | `recordTiming(requestId, "upload_failed_ble_fallback");` |

7. **Instrument `compressAndSendViaBle()`**:
   | Location | Line | Call |
   |----------|------|------|
   | Thread start | 2317 | `recordTiming(requestId, "ble_compress_start");` |
   | Compression done | 2381 | `recordTiming(requestId, "ble_compress_done");` |
   | Before BLE send | 2393 | `recordTiming(requestId, "ble_send_start");` |

8. **Instrument `sendCompressedPhotoViaBle()`**:
   | Location | Line | Call |
   |----------|------|------|
   | Before ready msg | 2459 | `recordTiming(requestId, "ble_ready_msg");` |
   | Before file transfer | 2471 | `recordTiming(requestId, "ble_file_transfer_start");` |
   | Transfer success | after 2473 | `recordTiming(requestId, "ble_transfer_done"); dumpTimings(requestId);` |

9. **Instrument `takePhotoForBleTransfer()` flow**:
   | Location | Line | Call |
   |----------|------|------|
   | Method entry | 2163 | `recordTiming(requestId, "ble_request_start");` |
   | Before camera | 2233 | `recordTiming(requestId, "enqueue_camera");` |
   | onPhotoCaptured | 2238 | `recordTiming(requestId, "photo_captured");` |
   | Before compress | 2255 | `recordTiming(requestId, "start_compress_for_ble");` |

10. **Dump on error paths**: Call `dumpTimings(requestId)` alongside any `sendPhotoErrorResponse()` call where a `recordTiming` was previously called for that requestId, so we get timing data even on failures.

---

## Verification

1. **Build**: `cd asg_client && ./gradlew assembleDebug` — must compile cleanly
2. **Concurrency guard test**: Use the photo-test app to fire 3 concurrent `camera.requestPhoto()` calls. Expect: first succeeds, other two get `CAMERA_BUSY` error within <1s (not 30s timeout)
3. **WiFi-aware upload**:
   - With WiFi off: photo should skip webhook entirely, go straight to BLE (check logcat for "No WiFi - skipping webhook")
   - With WiFi on: photo should attempt 5s webhook upload, fall back to BLE if it fails
4. **Timing instrumentation**: Take a photo, check logcat for the full timing dump showing all phases with deltas. Look for the 4.8s gap between `photo_captured` and `upload_start`.

---

## Files Modified (Summary)

| File | Changes |
|------|---------|
| `MediaCaptureService.java` | `isCapturingPhoto` AtomicBoolean + guard, WiFi check fix, connect timeout bump, timing instrumentation |
| `PhotoCommandHandler.java` | Early `isCapturingPhoto()` check before dispatching to capture methods |
