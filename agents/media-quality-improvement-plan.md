# Media Quality Improvement Plan

## Context

Photos and videos captured on Mentra Live (asg_client, MT8766 SoC) are synced to the phone (mobile app) with **zero post-processing**. Alternatives captures raw fisheye frames + 3 bracketed exposures + IMU data on the glasses, then performs HDR merge, lens distortion correction, video stabilization, and color science **on the phone**.

Our pipeline currently captures a single JPEG on the glasses and ships it unchanged to the phone. This plan addresses the gap.

### Hardware Context
- **SoC**: MediaTek MT8766 (entry-level IoT platform)
- **Camera sensor**: 118-degree FOV
- **HEVC**: MT8766 does **NOT** support hardware H.265 encode (H.264 only) — HEVC is off the table
- **EIS firmware**: Not ready — skip glasses-side EIS for now
- **Stabilization delay (475ms)**: Already tuned through testing, do not reduce

### What Meta Does That We Don't
| Step | Alternatives | MentraOS (Current) |
|---|---|---|
| Raw capture | Fisheye, 3 bracketed exposures | Single JPEG, quality 90 |
| HDR | 3-exposure stacking on phone | None |
| Noise reduction | MFNR on glasses + phone denoise | MFNR configured but may not be triggering |
| Lens correction | Fisheye -> rectilinear on phone | None |
| Video stabilization | EIS + gyro-based on phone | EIS detected but firmware not ready |
| IMU bundling | IMU data bundled with media | IMU completely separate |
| Phone processing | Full computational photography | Zero - files stored as-is |

---

## Phase 1: Glasses-Side Quick Wins

Changes only in `asg_client/`. No mobile changes needed. Can ship independently.

### 1A. Bump Button Photo JPEG Quality: 90 -> 95

**File:** `asg_client/app/src/main/java/com/mentra/asg_client/camera/CameraConstants.java:43`

Change `BUTTON_JPEG_QUALITY` from `90` to `95`. SDK photo quality stays unchanged (70/75/80/85).

At 3264x2448 native resolution, 90 -> 95 is the difference between "decent" and "phone-camera quality." ~30% larger files but visibly sharper in fine detail and gradients.

**Effort:** 5 minutes
**Impact:** Medium — subtle but real quality bump

### 1B. Enable 3DNR (Temporal Noise Reduction) for Video

The vendor key `com.mediatek.nrfeature.3dnrmode` is already detected at runtime in `CameraSettings.java:72-74` and stored in `mKey3DNRMode`, but **never set on any capture builder**. It's dead code.

**Changes:**

1. **`CameraSettings.java`** — Add methods:
   - `is3DNRSupported()` — returns `mKey3DNRMode != null`
   - `configure3DNRBuilder(CaptureRequest.Builder builder)` — sets `mKey3DNRMode` to `new int[]{1}`

2. **`CameraNeo.java:~1780`** — In `createCameraSessionInternal()`, alongside the existing EIS block:
   ```java
   // Existing EIS block
   if (forVideo && eisEnabled) {
       enableEIS(previewBuilder, true);
   }
   // NEW: Enable 3DNR for video
   if (forVideo && mCameraSettings != null && mCameraSettings.is3DNRSupported()) {
       mCameraSettings.configure3DNRBuilder(previewBuilder);
   }
   ```

3. **`CircularVideoBufferInternal.java`** — Apply 3DNR to circular buffer recording sessions too (if capture builder is accessible there).

**Effort:** 1-2 hours
**Impact:** High — significant noise reduction in low-light video

### 1C. MFNR Diagnostic Logging

MFNR (Multi-Frame Noise Reduction) is configured with mode 255 (full), but it only triggers when ISO > 800. If the auto-exposure algorithm rarely pushes ISO that high, MFNR is effectively dead code.

**File:** `CameraNeo.java` — In the capture result callback (onCaptureCompleted or similar)

Log on every button photo capture:
- `CaptureResult.SENSOR_SENSITIVITY` (actual ISO used)
- `CaptureResult.SENSOR_EXPOSURE_TIME` (actual exposure time)
- Whether ISO > 800 (i.e., whether MFNR would have triggered)

**Effort:** 30 minutes
**Impact:** Diagnostic — tells us if our biggest photo quality feature is actually working

---

## Phase 2: Phone-Side Processing Pipeline

Build the foundation for processing images after they're downloaded from glasses but before saving to camera roll. This is cross-platform (iOS + Android) via the existing Expo native module pattern.

### 2A. Native Image Processing Module

Add a new async function to the existing `CoreModule` native module:

**TypeScript interface** (`mobile/modules/core/src/CoreModule.ts`):
```typescript
processGalleryImage(
  inputPath: string,
  outputPath: string,
  options: { lensCorrection: boolean, colorCorrection: boolean }
): Promise<{ success: boolean, processedPath: string, error?: string }>
```

**Android** (`mobile/modules/core/android/`):
- Use `Bitmap` + `Canvas` + `ColorMatrix` APIs (no external dependencies)
- Load image -> apply processing steps -> write JPEG at quality 95

**iOS** (`mobile/modules/core/ios/`):
- Use `CoreImage` framework (`CIImage`, `CIFilter`)
- Load image -> apply CIFilter chain -> write JPEG

Start with a **pass-through** (read + write unchanged) to validate the pipeline, then add processing steps incrementally.

**Effort:** 2-3 days
**Impact:** Foundation — enables everything else in Phase 2

### 2B. Wire Processing into Gallery Sync

**File:** `mobile/src/services/asg/gallerySyncService.ts:~1270`

Insert processing call between download and camera roll save:
```
downloadFile() -> filePath
updateFileInQueue()
[NEW] CoreModule.processGalleryImage(filePath, processedPath, options)
saveToLibrary(processedPath)  // save processed version
```

**File:** `mobile/src/services/asg/gallerySettingsService.ts`

Add settings:
```typescript
enableImageProcessing: boolean  // default: true
```

If processing fails, fall through and save the original (never lose a photo due to processing error).

**Effort:** 2-3 hours
**Impact:** Foundation — connects native processing to the sync flow

### 2C. Lens Distortion Correction

118-degree FOV. The barrel distortion is significant — every photo screams "wearable camera" without correction.

**Implementation:**
- Brown-Conrady distortion model with **hardcoded calibration coefficients** (we control the hardware, coefficients are constants)
- Precompute a pixel remapping LUT on first use, cache it in memory
- **Android:** Pixel remapping via `Bitmap.getPixels()` / `setPixels()` with bilinear interpolation
- **iOS:** `CIFilter` with custom `CIWarpKernel` or `vImage_Buffer` warp functions

**Calibration:** Shoot a checkerboard pattern with the glasses, extract k1/k2/p1/p2/fx/fy/cx/cy coefficients using OpenCV's `calibrateCamera()`. Do this once, hardcode the values.

**Effort:** 3-5 days (including calibration)
**Impact:** Very High — the single biggest "looks like a normal photo" change

### 2D. Auto White Balance / Color Correction

Wearable camera sensors often have poor AWB and flat color. Apply subtle corrections:

- Slight warmth shift (reduce blue cast common in small sensors)
- Gentle saturation boost (~10-15%)
- Contrast S-curve (lift shadows, tame highlights)
- Optional sharpening pass (unsharp mask)

**Android:** `ColorMatrix` on `Paint` applied via `Canvas.drawBitmap()`
**iOS:** `CIColorMatrix`, `CITemperatureAndTint`, `CIUnsharpMask`

Start conservative. Tunable coefficients hardcoded initially.

**Effort:** 1-2 days
**Impact:** Medium — makes colors feel "phone-like" instead of "security camera-like"

---

## Phase 3: IMU Bundling + Advanced Processing

These require changes to both glasses and mobile, and depend on Phase 2 being complete.

### 3A. Capture IMU Data During Photo/Video

**Files:**
- `asg_client/.../sensors/ImuManager.java` — Add `startRecordingToBuffer()` / `stopRecordingToBuffer()` methods that accumulate timestamped accel+gyro samples at ~100Hz into an in-memory list
- `asg_client/.../camera/CameraNeo.java` — Start IMU recording when capture begins, stop when it ends. Write sidecar JSON file alongside the media (e.g., `IMG_20260302_123456.imu.json` next to `IMG_20260302_123456.jpg`)

Sidecar format:
```json
{
  "sampleRate": 100,
  "samples": [
    { "t": 0, "ax": 0.1, "ay": 9.8, "az": 0.2, "gx": 0.01, "gy": 0.02, "gz": 0.0 },
    ...
  ]
}
```

**Effort:** 1-2 days
**Impact:** Foundation — enables gyro stabilization and motion-compensated HDR

### 3B. Transfer IMU Data Alongside Media

**Files:**
- Glasses HTTP server (`/api/sync`, `/api/download` endpoints) — Include `.imu.json` sidecar files in the sync manifest
- `mobile/src/services/asg/asgCameraApi.ts` — Download sidecar files alongside media, store in same directory

**Effort:** 1 day
**Impact:** Foundation — gets IMU data to the phone

### 3C. Phone-Side Gyro Video Stabilization

Using IMU sidecar data, apply motion-compensated frame warping. This replaces the missing EIS firmware.

**Pipeline:**
1. Parse IMU sidecar → build rotation model per frame
2. Decode video frames
3. Apply inverse-rotation warp per frame (removing head motion)
4. Re-encode stabilized video

**Android:** `MediaCodec` decode → `Bitmap` warp using rotation matrix from gyro → `MediaCodec` encode
**iOS:** `AVAssetReader` → `CIFilter` perspective/affine transform → `AVAssetWriter`

Start with basic rotation correction only. Add full 3-axis stabilization iteratively.

**Effort:** 1-2 weeks
**Impact:** Very High — biggest video quality win, replaces missing EIS

### 3D. HDR via captureBurst() + Exposure Bracketing

Modify the capture flow in `CameraNeo.java`:

1. After AE convergence + 475ms stabilization, **lock AE** (`CONTROL_AE_LOCK = true`)
2. Build 3 capture requests with different `CONTROL_AE_EXPOSURE_COMPENSATION` values: -2, 0, +2
3. Send via `cameraCaptureSession.captureBurst()` instead of single `capture()`
4. Save all 3 frames as separate files
5. Phone-side: align + tone-map merge in the native processing module

**Key insight:** By locking AE after first convergence, shots 2 and 3 skip the 475ms stabilization delay entirely. Total burst time drops from ~2200ms to ~1300ms.

Requires Phase 2 processing pipeline on the phone side for the merge step.

**Effort:** 1-2 weeks (glasses capture + phone merge)
**Impact:** Very High — dramatically improves dynamic range

---

## Summary: Implementation Order

| # | Item | Where | Effort | Impact |
|---|------|-------|--------|--------|
| **1A** | JPEG quality 90->95 | glasses | 5 min | Medium |
| **1B** | Enable 3DNR for video | glasses | 1-2 hrs | High |
| **1C** | MFNR diagnostic logging | glasses | 30 min | Diagnostic |
| **2A** | Native processing module | mobile (iOS+Android) | 2-3 days | Foundation |
| **2B** | Wire into gallery sync | mobile | 2-3 hrs | Foundation |
| **2C** | Lens distortion correction | mobile (iOS+Android) | 3-5 days | Very High |
| **2D** | AWB / color correction | mobile (iOS+Android) | 1-2 days | Medium |
| **3A** | IMU capture during media | glasses | 1-2 days | Foundation |
| **3B** | IMU transfer in sync | glasses+mobile | 1 day | Foundation |
| **3C** | Phone-side gyro stabilization | mobile (iOS+Android) | 1-2 weeks | Very High |
| **3D** | HDR burst capture + merge | glasses+mobile | 1-2 weeks | Very High |

---

## Verification

| Item | How to Test |
|---|---|
| **1A** | Compare JPEG file sizes and visual quality before/after on same scene |
| **1B** | Record video in low light with 3DNR on/off, compare noise levels frame-by-frame |
| **1C** | Check logcat for `SENSOR_SENSITIVITY` values — if never >800, MFNR is not firing |
| **2A-2B** | Sync a photo, confirm processing function is called (log output), confirm original preserved as fallback on error |
| **2C** | Shoot a straight-line scene (building edge, doorframe), confirm barrel distortion is corrected |
| **2D** | Compare skin tones and white surfaces before/after |
| **3A-3B** | Sync media, confirm `.imu.json` sidecar arrives alongside media file |
| **3C** | Record while walking, compare stabilized vs raw video side by side |
| **3D** | Shoot a high-contrast scene (window + dark room), compare dynamic range of single vs HDR |
