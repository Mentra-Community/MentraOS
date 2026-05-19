### CameraNeoService (Camera2) – Architecture and Usage Guide

This document explains how `CameraNeoService` works end-to-end and how to use it to capture photos and record videos. It is designed for developers integrating or extending the camera service.

- **Location**: `asg_client/app/src/main/java/com/mentra/asg_client/camera/CameraNeoService.java`
- **Type**: Android `LifecycleService` using Camera2 API
- **Primary responsibilities**:
  - Foreground service that owns camera lifecycle
  - Photo capture with brief auto-exposure convergence
  - Single video recording with `MediaRecorder`

#### Package layout (`com.mentra.asg_client.camera`)

- **Root**: `CameraNeoService`, `CameraConstants`, `CameraSettings`, this README.
- **`lifecycle/`**: `CameraCoordinator`, `PhotoSession`, `VideoRecordingSession`, `HdrBurstCapture`, `ImageReaderTwin`, `CameraOpener`, `CameraRecoveryHelper`, `CameraServiceNotification`.
- **`request/`**: `PreviewRequestConfigurator`, `StillCaptureBuilder`, `StillCaptureCallback`, `HdrBurstBuilder`, `AeCaptureCallback`, `AePreviewController`.
- **`policy/`**: `AeStateMachine`, `ManualExposurePolicy`, `FpsRangePolicy`, `VideoRecorderPolicy`, `PhotoResolutionPolicy`, `CameraSizeSelector`, `JpegOrientationResolver`, `MeteringRegions`, `EisController`, `CameraCapabilities`.
- **`model/`**: `QueuedPhotoRequest` (FIFO waiting), `ActivePhotoCapture` (in-flight snapshot), `QueuedPhotoRequestQueue`.
- **`diagnostics/`**: `CameraDiagnosticsLog` (structured `MentraDbg` JSON for logcat parsers).

---

### TL;DR – Public API (static entry points)

All APIs are fire-and-forget static helpers that start the foreground service with an intent and communicate results via callbacks.

```java
// 1) Take a photo
CameraNeoService.takePictureWithCallback(
    context,
    filePath, // if null/empty, a default path is generated
    new CameraNeoService.PhotoCaptureCallback() {
      @Override public void onPhotoCaptured(String filePath) {}
      @Override public void onPhotoError(String error) {}
    }
);

// 2) Start/stop a single video recording
CameraNeoService.startVideoRecording(
    context,
    videoId,               // any unique string you track on the caller side
    videoOutputFilePath,   // if null/empty, a default path is generated
    new CameraNeoService.VideoRecordingCallback() {
      @Override public void onRecordingStarted(String videoId) {}
      @Override public void onRecordingProgress(String videoId, long durationMs) {}
      @Override public void onRecordingStopped(String videoId, String filePath) {}
      @Override public void onRecordingError(String videoId, String error) {}
    }
);
CameraNeoService.stopVideoRecording(context, videoId);
```

Utility status check:

```java
boolean isBusy = CameraNeoService.isCameraInUse();
```

---

### High-level Design

- **Foreground service**: Keeps the process alive and visible to the system via a persistent notification. Creates a background `HandlerThread` for camera work.
- **Single owner of the camera**: All camera operations are owned by the service, avoiding lifecycle coupling with activities.
- **Intents as commands**: Public static methods build intents and start the service. `onStartCommand` routes actions to internal methods.
- **Callbacks for results**: Static callbacks (`PhotoCaptureCallback`, `VideoRecordingCallback`) deliver asynchronous results back to the caller.
- **State machines**:
  - Photo: simplified AE wait → capture
  - Video: start `MediaRecorder` and stream frames via a capture session

---

### Threading and Concurrency

- A dedicated `HandlerThread` processes Camera2 and `ImageReader` events.
- A `Semaphore` (`cameraOpenCloseLock`) guards open/close sequences.
- A single-threaded `Executor` dispatches callback events cleanly.
- Main thread is used for service lifecycle and some timers/handlers.

---

### Key Constants and Defaults

- Photo target size: `1440x1080` (4:3)
- JPEG quality: `90`
- Orientation hint: `270` degrees
- Default video size: closest to `1280x720`
- AE wait timeout before capture: `0.5 s`

You can tweak these via the constants in `CameraConstants.java` and `CameraNeoService.java`.

---

### Lifecycle Overview

1. `onCreate`
   - Creates notification channel, shows foreground notification
   - Starts background thread and sets a static instance

2. `onStartCommand`
   - Dispatches actions:
     - `ACTION_TAKE_PHOTO` → `setupCameraAndTakePicture`
     - `ACTION_START_VIDEO_RECORDING` → `setupCameraAndStartRecording`
     - `ACTION_STOP_VIDEO_RECORDING` → `stopCurrentVideoRecording`

3. `onDestroy`
   - Ensures recording is stopped, closes camera, stops background thread, releases wake locks

---

### Permissions and Power

- Requires `android.permission.CAMERA` and microphone permission for video.
- Uses `WakeLockManager.acquireFullWakeLockAndBringToForeground(context, keepCpuMs, brightenMs)` to wake the screen and CPU during camera use, and releases wake locks in `closeCamera`/`onDestroy`.
- Runs as a foreground service with a low-importance notification to reduce the risk of being killed.

---

### Photo Capture Flow

1. API layer calls `takePictureWithCallback(context, filePath, callback)` → starts service with `ACTION_TAKE_PHOTO`.
2. Service wakes screen and calls `openCameraInternal(filePath, forVideo=false)`.
3. Camera selection and configuration:
   - Chooses the back camera if present, otherwise first available.
   - Queries capabilities: AE modes, exposure compensation, FPS ranges, AF modes, min focus distance.
   - Picks JPEG size closest to `1440x1080`.
   - Creates an `ImageReader` for JPEG and registers a listener.
4. Camera open → `photoStateCallback.onOpened` → `createCameraSessionInternal(false)`.
5. Session setup for still capture:
   - Builds a `TEMPLATE_STILL_CAPTURE` request with:
     - `CONTROL_MODE = AUTO`, `AE_MODE = ON`
     - Chosen FPS range to avoid very long exposures
     - Optional exposure compensation (`userExposureCompensation`)
     - Center-weighted AE/AF regions if AF is supported
     - High quality noise reduction and edge enhancement
     - `JPEG_QUALITY` and `JPEG_ORIENTATION`
6. `startPreviewWithAeMonitoring()`:
   - Starts a repeating preview request with `SimplifiedAeCallback`
   - Triggers AE precapture (`CONTROL_AE_PRECAPTURE_TRIGGER_START`)
7. `SimplifiedAeCallback` waits until AE is `CONVERGED`/`LOCKED`/`FLASH_REQUIRED` or a 0.5s timeout, then calls `capturePhoto()`.
8. `capturePhoto()` builds and submits a still capture request. Upon completion, the actual byte processing occurs in the `ImageReader` listener.
9. `ImageReader` listener saves bytes to `filePath`, calls `onPhotoCaptured(filePath)`, closes camera, and stops the service.

Notes:

- AF runs in `CONTINUOUS_PICTURE` mode; no manual AF trigger is used.
- If any step fails, `onPhotoError` is invoked and resources are torn down.

---

### Single Video Recording Flow

1. API layer calls `startVideoRecording(context, videoId, filePath, callback)` → `ACTION_START_VIDEO_RECORDING`.
2. Service wakes screen and calls `openCameraInternal(filePath, forVideo=true)`.
3. Video configuration:
   - Chooses video size close to `1280x720` from `StreamConfigurationMap.getOutputSizes(MediaRecorder.class)`.
   - Initializes and prepares a single `MediaRecorder`.
4. Camera open → `videoStateCallback.onOpened` → `createCameraSessionInternal(true)`.
5. Session setup for record:
   - Uses `TEMPLATE_RECORD` and targets the `MediaRecorder` surface
   - Applies AE/AWB, FPS range, exposure compensation, and AF/AE regions similar to photo
6. Start recording:
   - `startRecordingInternal()` sets repeating request and calls `mediaRecorder.start()`
   - Service emits `onRecordingStarted(videoId)` and then `onRecordingProgress` every second
7. Stop recording:
   - Caller invokes `stopVideoRecording(context, videoId)` → `stopCurrentVideoRecording(videoId)`
   - Calls `mediaRecorder.stop()` and `reset()`, emits `onRecordingStopped(videoId, path)`, closes camera, and may stop the service (`conditionalStopSelf`)

Notes:

- Errors (e.g., illegal state on stop) are surfaced via `onRecordingError`.
- Orientation hint is set to `270` degrees via `MediaRecorder.setOrientationHint`.

---

### Error Handling and Recovery

- Permission checks are performed before opening the camera; missing permissions are reported via callbacks.
- `CameraAccessException` reasons are mapped to user-friendly messages. The service tries to release resources and, in some cases, suggests a delayed retry (`restartCameraServiceIfNeeded`).
- Any failure during session configuration or capture triggers the appropriate error callback and ensures resources are cleaned up.

---

### Important Members and Their Roles

- Camera core: `CameraDevice cameraDevice`, `CameraCaptureSession cameraCaptureSession`, `ImageReader imageReader`
- Threads: `HandlerThread backgroundThread`, `Handler backgroundHandler`, `Executor executor`
- Synchronization: `Semaphore cameraOpenCloseLock`
- Photo params: `Size jpegSize`, `JPEG_QUALITY`, `JPEG_ORIENTATION`
- AE/AF config: `availableAeModes`, `exposureCompensationRange`, `exposureCompensationStep`, `availableFpsRanges`, `selectedFpsRange`, `availableAfModes`, `hasAutoFocus`, `minimumFocusDistance`
- Photo state machine: `ShotState { IDLE, WAITING_AE, SHOOTING }`, `SimplifiedAeCallback`, `AE_WAIT_NS`
- Video: `MediaRecorder mediaRecorder`, `Surface recorderSurface`, `Size videoSize`, `isRecording`, timers

---

### Quick Reference: Callback Interfaces

```java
public interface PhotoCaptureCallback {
  void onPhotoCaptured(String filePath);
  void onPhotoError(String errorMessage);
}

public interface VideoRecordingCallback {
  void onRecordingStarted(String videoId);
  void onRecordingProgress(String videoId, long durationMs);
  void onRecordingStopped(String videoId, String filePath);
  void onRecordingError(String videoId, String errorMessage);
}
```
