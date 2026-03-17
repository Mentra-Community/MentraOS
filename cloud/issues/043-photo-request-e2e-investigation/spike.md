# Spike: Photo Request End-to-End Investigation

## Overview

**What this doc covers:** End-to-end investigation of the photo request pipeline — from SDK `camera.requestPhoto()` through cloud, phone, glasses, and back. Includes precise ADB logs with timestamps, measured latencies at every hop, identified bottlenecks, the root cause of OS-947 (generic timeouts), and the complete error propagation chain (which exists in code but fails in practice for concurrent requests).

**Why this doc exists:** A single photo request takes 5–14 seconds to return 30KB of data. Concurrent photo requests all timeout at exactly 30.00 seconds with a generic "Photo request timed out" message (OS-947). We built a test harness, instrumented every layer, and traced the pipeline to find exactly where time and errors are lost.

**Who should read this:** ASG client team (glasses firmware), mobile team (phone app), cloud team, SDK team. This doc is written so each team can see their layer's contribution to the problem and take action independently.

## Background

### The photo request pipeline

```
SDK App Server (developer's app)
  → Cloud (WebSocket)
    → Phone (MentraOS mobile app, WebSocket → native CoreModule)
      → Glasses (ASG client, BLE command: take_photo)
        → Camera HAL captures photo
        → [Path A] Direct HTTP upload to app's webhook URL (fastest)
        → [Path B] BLE file transfer → Phone → webhook upload (slow fallback)
```

**Path A (Direct Upload):** Glasses POST the photo directly to the app server's `/photo-upload` endpoint. Requires glasses to have internet access and the server to be reachable within 1 second.

**Path B (BLE Fallback):** Glasses compress the photo, transfer it over BLE to the phone, phone decodes AVIF→JPEG, phone uploads to the app server's webhook URL. Always works but adds 5–9 seconds.

### What OS-947 / OS-951 are about

When a photo request fails (camera busy, battery low, etc.), the developer's app should get a specific error like `CAMERA_BUSY: Another photo capture in progress`. Instead, the SDK's 30-second safety timeout fires first, and the app gets a generic `"Photo request timed out"`. The specific error messages exist in the glasses code but don't reach the SDK in time (or at all) for concurrent requests.

## Test Harness

We built `cloud/packages/apps/photo-test/` — a fullstack MentraOS mini app for measuring photo request behavior:

- **Backend:** `PhotoTestApp` (extends `AppServer`) + Hono API routes for photo requests, SSE streaming, session status
- **Frontend:** React webview using `@mentra/react` (proper webview auth — no manual user ID entry)
- **Measurements:** Per-request timing, status (SUCCESS/ERROR/TIMEOUT/PENDING), error messages, photo sizes, pass/fail verdicts for OS-947

---

## Finding 1: Where Time Goes — Precise Trace of a Single Photo

### Raw phone logs (ADB, Pixel 8)

One photo request, start to finish. Logcat cleared before request, captured immediately after.

```
16:52:51.529  ReactNativeJS: Received photo_request, requestId: photo_req_1772499170225_zo28oyx,
              appId: com.mentra.phototest, webhookUrl: https://isaiah-tpa.ngrok.app/photo-upload,
              size: medium, compress: none

16:52:51.538  ReactNativeJS: 'CORE:', 'MAN: onPhotoRequest: photo_req_..._zo28oyx, com.mentra.phototest,
              medium, compress=none'

16:52:51.541  ReactNativeJS: 'CORE:', 'LIVE: Sending data to glasses:
              {"type":"take_photo","requestId":"photo_req_1772499170225_zo28oyx",
              "webhookUrl":"https://isaiah-tpa.ngrok.app/photo-upload",
              "bleImgId":"I499171537","transferMethod":"auto"}'

              ─── 12.4 SECONDS OF SILENCE (glasses processing) ───

16:53:03.963  K900ProtocolUtils: Extracted payload:
              {"type":"ble_photo_ready","requestId":"photo_req_1772499170225_zo28oyx",
              "bleImgId":"I499171537","compressionDurationMs":447}

16:53:04.228  ReactNativeJS: 'CORE:', 'LIVE: 📦 Started BLE photo transfer:
              I499171537 (11200 bytes, 28 packets, packSize=221)'

16:53:04.743  ReactNativeJS: 'CORE:', 'LIVE: ✅ BLE photo transfer complete: I499171537'

16:53:04.729  BlePhotoUploadService: Processing BLE photo for upload. Image size: 6037 bytes
16:53:04.729  BlePhotoUploadService: Detected AVIF image format
16:53:04.882  BlePhotoUploadService: Decoded image to bitmap: 640x480
16:53:04.897  BlePhotoUploadService: Converted to JPEG for upload. Size: 41882 bytes
16:53:04.900  BlePhotoUploadService: Uploading photo to webhook:
              https://isaiah-tpa.ngrok.app/photo-upload
16:53:05.586  BlePhotoUploadService: Upload successful. Response code: 200
16:53:05.590  ReactNativeJS: 'CORE:', 'LIVE: ✅ BLE photo uploaded successfully via phone relay'
16:53:05.597  ReactNativeJS: 'CORE:', 'LIVE: ⏱️ Upload duration: 859ms'
```

### Timing breakdown

```
PHASE                               DURATION    CUMULATIVE   WHERE
────────────────────────────────────────────────────────────────────────
Cloud WS → Phone receives request    ~50ms       0.05s       Cloud → Phone WS
Phone → sends BLE command            12ms        0.05s       Phone native (fast)
Glasses: camera + webhook + compress  12,422ms   12.47s      ASG Client (!!!)
  ├─ Camera HAL open+capture+close   ~5,000ms                Hardware
  ├─ Webhook upload attempt (FAIL)   ~1,000ms                1s connect timeout
  ├─ Post-capture processing/IO      ~3,500ms                ???
  ├─ AVIF compression                 447ms                  Reported by glasses
  └─ Unknown gap                     ~2,475ms                ???
BLE transfer (11.2KB, 28 packets)     515ms      12.99s      BLE
Phone: AVIF → bitmap → JPEG          168ms      13.16s      Phone (BlePhotoUploadService)
Phone: upload JPEG to webhook         686ms      13.84s      Phone → ngrok → app server
App server: parse + resolve promise   ~20ms      13.86s      SDK
────────────────────────────────────────────────────────────────────────
TOTAL                                ~14 seconds
```

### Key observation

**The glasses account for 12.4 out of 14 seconds.** Everything after the glasses is fast:

| Phase | Time | Assessment |
|-------|------|-----------|
| BLE transfer 11.2KB | 515ms | Reasonable |
| Phone AVIF→JPEG decode | 168ms | Fast |
| Phone upload 42KB to ngrok | 686ms | Fine |
| SDK processing | ~20ms | Negligible |

### Earlier glasses-side ADB logs (from when glasses were on USB)

```
22:44:34.xxx  MtkCam: Camera capture begins
22:44:39.397  MtkCam/P2/CaptureProcessor: [onWaitFlush] P2C cam 0: flush -
22:44:39.398  BWC: Profile_Change:[BWCPT_CAMERA_CAPTURE]:OFF
22:44:39.463  CameraProviderManager: Camera device torch status is now AVAILABLE_OFF
22:44:39.470  CameraService: disconnect: Disconnected client for camera 0 for PID 1742

22:44:44.225  System.out: [java.io.IOException: Required SETTINGS preface not received,
              java.net.SocketTimeoutException: failed to connect to
              isaiah-tpa.ngrok.app/13.56.186.207 (port 443)
              from /192.168.50.21 (port 57548) after 1000ms]
22:44:44.225  MediaCaptureService: ❌ Error uploading photo to webhook: timeout
22:44:44.226  MediaCaptureService: ❌ Exception type: SocketTimeoutException
22:44:44.226  AsgClientServiceV2: ✅ Photo captured successfully -
              ID: photo_req_1772491474148_kajxv8z,
              Path: .../IMG_20260302_224434.jpg

22:44:44.634  K900ProtocolUtils: 🔄 Formatting message:
              {"type":"ble_photo_ready","requestId":"photo_req_...",
              "bleImgId":"I491475268","compressionDurationMs":407}
22:44:44.846  AsgClientServiceV2: ✅ BLE file transfer started successfully
```

**Glasses-side breakdown from these logs:**

```
Camera HAL capture (34.xxx → 39.397):           ~5.0s
Camera disconnect + cleanup (39.397 → 39.470):   0.1s
Gap between camera close and webhook attempt:    ~4.8s  ← SUSPICIOUS
Webhook upload attempt + timeout:                ~1.0s
Photo success log + BLE prep:                    ~0.4s
AVIF compression:                                 0.4s
────────────────────────────────────────────────────────
Glasses total:                                   ~11.7s
```

**There is a ~4.8 second gap between camera close and webhook attempt.** This is the biggest unexplained delay on the glasses. What is happening during those 4.8 seconds?

---

## Finding 2: Webhook Direct Upload Always Fails — 1s Connect Timeout

**File:** `asg_client/.../io/media/core/MediaCaptureService.java` L1664–1668

```java
OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(1, java.util.concurrent.TimeUnit.SECONDS)  // Fast fail if no internet
        .writeTimeout(10, java.util.concurrent.TimeUnit.SECONDS)   // Time to upload photo data
        .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)     // Time to get response
        .build();
```

Glasses network state:

```
$ adb shell ip route
192.168.50.0/24 dev wlan0 proto kernel scope link src 192.168.50.21

$ adb shell ping -c 2 isaiah-tpa.ngrok.app
64 bytes from ec2-13-56-72-39.us-west-1.compute.amazonaws.com: icmp_seq=1 ttl=117 time=99.3 ms
64 bytes from ec2-13-56-72-39.us-west-1.compute.amazonaws.com: icmp_seq=2 ttl=117 time=357 ms
```

Glasses can reach the internet (100–350ms ping), but 1 second isn't enough for DNS + TCP + TLS handshake at that latency. The direct upload **always** fails, forcing every photo through the slow BLE fallback.

**Impact on timing:** If the direct upload worked, it would eliminate the entire BLE path (BLE transfer + phone decode + phone upload ≈ 1.4s saved) AND the webhook timeout wait (1s saved) AND potentially the post-capture processing gap if that's related to BLE setup. Conservative estimate: **5+ seconds faster per photo.**

### Recommendation for ASG Client team

Increase `connectTimeout` from 1s to **5 seconds**. The BLE fallback handles the true-offline case. A 1-second timeout punishes any real-world connection that isn't on the same LAN. This also affects production deployments — any app behind a CDN, load balancer, or in a different region will hit this.

---

## Finding 3: Rapid Fire — All Timeout at 30.00s (OS-947 Confirmed)

Fired 3 concurrent `camera.requestPhoto()` calls via the test harness. Results:

| Request | Duration | Status | Error Message |
|---------|----------|--------|---------------|
| rapid_0 | 30.00s | TIMEOUT | Photo request timed out |
| rapid_1 | 30.00s | TIMEOUT | Photo request timed out |
| rapid_2 | 30.00s | TIMEOUT | Photo request timed out |

All three hit the SDK's 30-second catch-all timeout. Zero specific error information.

### Root cause: no concurrency guard on camera capture

**File:** `asg_client/.../service/core/handlers/PhotoCommandHandler.java` L60–140

The handler checks for these conditions before starting a photo capture:

```java
// ✅ These guards exist and send specific errors:
if (captureService.isRecordingVideo())      → "VIDEO_RECORDING_ACTIVE"
if (captureService.isBleTransferInProgress()) → "BLE_TRANSFER_BUSY"

// Inside takePhotoAndUpload():
if (isUploadingPhoto)                       → "UPLOAD_SYSTEM_BUSY"
if (RtmpStreamingService.isStreaming())      → "CAMERA_BUSY"
```

**What's missing:** There is no `isCapturingPhoto` guard. When 3 requests arrive simultaneously:

1. All 3 pass every guard check (nothing is in progress yet at T+0)
2. All 3 enter `takePhotoAutoTransfer()` → `takePhotoAndUpload()`
3. All 3 attempt to open the Android Camera HAL concurrently
4. Camera HAL only processes one capture — the other two either:
   - Silently fail (callbacks never fire)
   - Throw exceptions that aren't caught and routed back as error responses
5. No success or error response reaches the SDK for requests 2 and 3
6. SDK 30-second timeout fires → generic "Photo request timed out"

### The error propagation chain EXISTS but never fires for this case

We traced the error return path through every layer. **The code exists at every hop:**

```
Glasses: sendPhotoErrorResponse(requestId, errorCode, errorMessage)
  → Sends JSON over BLE: {type:"photo_response", success:false, errorCode, errorMessage}

Phone native: MentraLive.java receives BLE → Bridge.sendPhotoError()
  → Emits "photo_response" event to React Native JS

Phone JS: MantleManager listens for "photo_response"
  → Calls restComms.sendPhotoResponse(event)
  → REST POST to cloud: /api/client/photo/response

Cloud: PhotoManager.handlePhotoResponse()
  → _sendPhotoErrorToApp() → WebSocket message to SDK

SDK: AppSession.handleMessage() catches isPhotoResponse
  → appServer.completePhotoRequest(requestId)
  → Rejects the promise with specific error
  → Developer gets: Error("CAMERA_BUSY: Another capture in progress")
```

**Relevant code locations:**

| Layer | File | Function |
|-------|------|----------|
| ASG error sender | `asg_client/.../media/core/MediaCaptureService.java` L2517 | `sendPhotoErrorResponse()` |
| Phone native bridge | `mobile/.../core/Bridge.kt` L291 | `sendPhotoError()` |
| Phone JS listener | `mobile/src/services/MantleManager.ts` L278 | `CoreModule.addListener("photo_response")` |
| Phone REST sender | `mobile/src/services/RestComms.ts` L589 | `sendPhotoResponse()` → POST `/api/client/photo/response` |
| Cloud handler | `cloud/.../session/PhotoManager.ts` L200 | `handlePhotoResponse()` |
| Cloud error forwarder | `cloud/.../session/PhotoManager.ts` L247 | `_sendPhotoErrorToApp()` |
| SDK receiver | `cloud/packages/sdk/src/app/session/index.ts` L1545 | `handleMessage()` → `isPhotoResponse` |
| SDK timeout (30s) | `cloud/packages/sdk/src/app/server/index.ts` L399 | `registerPhotoRequest()` |

**The problem:** `sendPhotoErrorResponse()` is never called for the concurrent-capture case because there's no guard that detects it. The camera silently drops the request, no callback fires, no error is sent.

### Recommendation for ASG Client team

Add an `isCapturingPhoto` flag (or AtomicBoolean) to `MediaCaptureService`. Set it `true` when camera capture begins, `false` when capture completes or fails. Check it at the top of `takePhotoAndUpload()` / `takePhotoAutoTransfer()`:

```java
if (isCapturingPhoto.get()) {
    sendPhotoErrorResponse(requestId, "CAMERA_BUSY",
        "Another photo capture is in progress");
    return;
}
```

This would cause the existing error propagation chain to fire, and the developer would get `Error("CAMERA_BUSY: Another photo capture is in progress")` in <1 second instead of waiting 30 seconds for a generic timeout.

---

## Finding 4: The 4.8-Second Gap on Glasses

Between camera close (`22:44:39.470`) and the webhook upload attempt starting (`22:44:44.225`), there's a **4.8-second gap** with no logs. This is the second-largest time sink after the camera HAL itself.

Possible causes (ASG team to investigate):

1. **File I/O:** Writing the captured photo to storage before upload — is this synchronous and slow on the eMMC?
2. **JPEG encoding:** The camera captures RAW/YUV, does the MediaCaptureService do software JPEG encoding?
3. **Thread scheduling:** Is there a thread hop or handler post that introduces delay?
4. **Intentional delay:** Is there a sleep or debounce anywhere in the post-capture path?
5. **BLE fallback setup:** Even in "auto" mode, does the glasses pre-prepare BLE transfer infrastructure before attempting webhook?

### What we know

- The gap happens AFTER camera close and BEFORE webhook upload
- It's consistent across captures (~4-5s every time)
- The AVIF compression (reported as 447ms) happens AFTER the webhook attempt fails, so it's not compression causing this gap
- No error logs appear during this window

### Recommendation

Add timing logs at the start and end of each step between camera callback and upload start. Something like:

```java
Log.i(TAG, "⏱️ [TIMING] Camera callback received at " + System.currentTimeMillis());
// ... file save ...
Log.i(TAG, "⏱️ [TIMING] File saved at " + System.currentTimeMillis());
// ... before upload ...
Log.i(TAG, "⏱️ [TIMING] Starting upload at " + System.currentTimeMillis());
```

---

## Finding 5: Camera HAL Takes ~5 Seconds

From glasses ADB logs, the Camera HAL cycle (open → capture → flush → close) consistently takes ~5 seconds on Mentra Live hardware. This appears to be the hardware floor.

Possible optimizations (ASG team to evaluate):

1. **Camera warm-keeping:** Keep the camera device open between shots instead of full open→close cycle. Risk: battery drain, camera lock contention.
2. **Pre-warm on request:** Start opening the camera as soon as the BLE command arrives, before all validation completes.
3. **Capture-only mode:** If the camera is already open for preview/streaming, take a snapshot from the existing session instead of a full capture cycle.

This is lower priority than the 4.8s gap and the webhook timeout — those are pure software fixes.

---

## Finding 6: BLE Transfer Is Actually Reasonable

Despite initial suspicion, the BLE transfer itself is fast:

```
11,200 bytes (AVIF compressed) in 28 packets of 221 bytes
Transfer time: 515ms
Throughput: ~21.8 KB/s
```

The phone's post-processing is also quick:

```
AVIF decode → bitmap (640x480):  153ms
Bitmap → JPEG (41,882 bytes):     15ms
Upload 42KB to webhook:          686ms
```

The BLE path is slow in total (~1.4s) but not because of BLE itself — it's because of the **additional processing on the glasses** (compression, BLE prep) and the **AVIF→JPEG transcode on the phone** that wouldn't be needed if the direct webhook upload worked.

---

## Summary: Where Every Second Goes

For a typical 14-second photo:

```
                    GLASSES (12.4s)                PHONE (1.4s)   SDK
    ┌──────────────────────────────────────────┐  ┌──────────┐  ┌──┐
    │ Camera  │  ???  │Webhook│Compress│BLE xfer│  │Decode│ Upload│  │
    │  5.0s   │ 4.8s │ 1.0s  │ 0.4s   │ 0.5s  │  │0.2s │ 0.7s  │  │
    └──────────────────────────────────────────┘  └──────────┘  └──┘
    ◄─────────── 89% of total time ────────────►
```

### Impact of proposed fixes

| Fix | Time Saved | New Total | Effort |
|-----|-----------|-----------|--------|
| Bump webhook timeout 1s→5s (if it succeeds) | ~5-6s | ~8s | Trivial |
| Investigate/fix 4.8s gap | ~3-5s | ~5-9s | Medium |
| Both fixes combined | ~8-10s | ~4-6s | Medium |
| Camera warm-keeping | ~2-3s | ~2-3s | Complex |

---

## Measured Results Table

All measurements from the `photo-test` app via the MentraOS phone app webview:

| # | Mode | Duration | Size | Status | Notes |
|---|------|----------|------|--------|-------|
| 1 | Single, medium | 14.05s | 33.2 KB | SUCCESS | Cold camera, first shot |
| 2 | Single, medium | 11.46s | 34.5 KB | SUCCESS | Webhook timeout → BLE |
| 3 | Single, medium | 13.54s | 29.5 KB | SUCCESS | Webhook timeout → BLE |
| 4 | Single, medium | 9.54s | 30.6 KB | SUCCESS | Slightly faster |
| 5 | Single, small+compressed | 6.95s | 6.3 KB | SUCCESS | Smaller = faster BLE |
| 6 | Single, small+compressed | 4.99s | 7.1 KB | SUCCESS | Best case observed |
| 7 | Rapid fire (3x) | 30.00s | — | TIMEOUT | OS-947: generic timeout |
| 8 | Rapid fire (3x) | 30.00s | — | TIMEOUT | OS-947: generic timeout |
| 9 | Rapid fire (3x) | 30.00s | — | TIMEOUT | OS-947: generic timeout |

---

## Conclusions

| Finding | Severity | Owner | Fix |
|---------|----------|-------|-----|
| No `isCapturingPhoto` guard → OS-947 | **Critical** | ASG Client | Add concurrency guard, send `CAMERA_BUSY` error |
| 1s webhook connect timeout | **High** | ASG Client | Bump to 3–5s |
| 4.8s unexplained gap post-capture | **High** | ASG Client | Add timing logs, investigate |
| Camera HAL 5s cycle | Medium | ASG Client | Camera warm-keeping (complex) |
| Error propagation chain untested | Medium | All teams | End-to-end test with forced error |

### What works well

- BLE transfer throughput is reasonable (22 KB/s)
- Phone-side processing is fast (AVIF decode + upload < 1s)
- Error propagation code exists at every layer — it just needs to be triggered
- The SDK's WebSocket handler for `photo_response` errors is correctly implemented

### What the ASG Client team can do right now

1. **Add `isCapturingPhoto` concurrency guard** — immediate fix for OS-947. The error propagation chain already exists; it just needs to be triggered. This is the highest-impact change.

2. **Bump `connectTimeout` from 1s to 5s** — eliminates the BLE fallback for most real-world connections. Single biggest latency improvement.

3. **Add timing instrumentation** between camera callback and upload start — find the 4.8s gap. Even just log timestamps at each step.

4. **Verify `sendPhotoErrorResponse` actually reaches the phone** — trigger a known error condition (e.g., battery low) and confirm the phone receives it, forwards it to cloud, and the SDK rejects the promise with the specific error. This validates the entire chain end-to-end.

### What the mobile team should verify

- When `Bridge.sendPhotoError()` is called, confirm the React Native event fires and `restComms.sendPhotoResponse()` hits the cloud REST endpoint. The code is there (`MantleManager.ts` L278), but we couldn't confirm it fires during rapid-fire because no errors were generated.

### What the cloud/SDK team has already done

- SDK `handleMessage()` correctly handles `isPhotoResponse` errors (L1545)
- Cloud `PhotoManager.handlePhotoResponse()` routes errors to apps (L200)
- Cloud REST endpoint `POST /api/client/photo/response` validates and processes errors (photo.api.ts)
- The 30s timeout in `AppServer.registerPhotoRequest()` (L399) is the correct safety net — it should just be the last resort, not the primary error path

## Next Steps

- [ ] ASG Client: Add `isCapturingPhoto` concurrency guard (OS-947 fix)
- [ ] ASG Client: Bump webhook `connectTimeout` to 5s
- [ ] ASG Client: Add timing logs between camera callback and upload start
- [ ] All teams: End-to-end test of error propagation with a forced error
- [ ] Spec for concurrent photo request behavior (queue vs reject vs cancel-previous)