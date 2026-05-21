package com.mentra.asg_client.camera.lifecycle;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.util.Log;
import android.util.Range;
import android.util.Size;

import androidx.annotation.Nullable;

import com.mentra.asg_client.camera.CameraConstants;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.diagnostics.CameraDiagnosticsLog;
import com.mentra.asg_client.camera.model.ActivePhotoCapture;
import com.mentra.asg_client.camera.model.QueuedPhotoRequest;
import com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import com.mentra.asg_client.camera.policy.CameraCapabilities;
import com.mentra.asg_client.camera.policy.JpegOrientationResolver;
import com.mentra.asg_client.camera.policy.ManualExposurePolicy;
import com.mentra.asg_client.camera.request.AeCaptureCallback;
import com.mentra.asg_client.camera.request.AePreviewController;
import com.mentra.asg_client.camera.request.HdrBurstBuilder;
import com.mentra.asg_client.camera.request.StillCaptureBuilder;
import com.mentra.asg_client.camera.request.StillCaptureCallback;
import com.mentra.asg_client.sensors.ImuRecorder;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.Objects;
import java.util.concurrent.Executor;

/**
 * Owns photo capture lifecycle: queue dispatch, AE precapture, still/HDR capture, image save,
 * and metering timestamps. Bridges to {@link CameraNeoService} via {@link Hooks}.
 *
 * <p><b>Request model (see {@code camera.model}):</b>
 * <ul>
 *   <li>{@link com.mentra.asg_client.camera.model.QueuedPhotoRequest} — waiting in
 *       {@link com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue}</li>
 *   <li>{@link com.mentra.asg_client.camera.model.ActivePhotoCapture} — frozen snapshot in
 *       {@link #activeCapture} while this session runs AE/capture</li>
 * </ul>
 * Promotion happens in {@link #activateQueuedRequest}; {@link #clearActiveCapture} runs after each shot.
 */
public final class PhotoSession {

    private static final String TAG = "CameraNeo";

    /** Fallback output path for still {@link ImageReader} callback (openCamera path param). */
    private String listenerFallbackPhotoPath;

    private ImageReaderTwin imageReaders;
    private Size jpegSize;

    /**
     * Non-null while a {@link QueuedPhotoRequest} is being captured (AE → still → JPEG).
     * Cleared after each shot; see {@link #activateQueuedRequest} and {@link #clearActiveCapture}.
     */
    private volatile ActivePhotoCapture activeCapture;

    /**
     * Last camera pipeline config (size / SDK / exposure) applied to the open session.
     * Survives {@link #clearActiveCapture()} so queued burst shots can reuse the session
     * without a false-positive reconfiguration after the previous shot completes.
     */
    @Nullable
    private volatile ConfiguredCameraConfig configuredCameraConfig;

    private volatile AeStateMachine.ShotState shotState = AeStateMachine.ShotState.IDLE;
    private final AeStateMachine aeStateMachine = new AeStateMachine();

    private volatile Integer mLastMeteredIso;
    private volatile Long mLastMeteredExposureNs;
    private volatile Long mLastStillSensorTimestampNs;

    private final HdrBurstCapture hdrBurstCapture = new HdrBurstCapture();

    private final Hooks hooks;
    private final AeCaptureCallback aeCallback;

    public PhotoSession(Hooks hooks) {
        this.hooks = hooks;
        this.aeCallback = new AeCaptureCallback(aeStateMachine, new AeCaptureCallback.Hooks() {
            @Override
            public AeStateMachine.ShotState shotState() {
                return shotState;
            }

            @Override
            public void setShotState(AeStateMachine.ShotState nextShotState) {
                shotState = nextShotState;
            }

            @Override
            public void recordMeteredIso(Integer iso) {
                mLastMeteredIso = iso;
            }

            @Override
            public void recordMeteredExposureNs(Long exposureNs) {
                mLastMeteredExposureNs = exposureNs;
            }

            @Override
            public void postDelayed(Runnable runnable, long delayMs) {
                Handler h = hooks.backgroundHandler();
                if (h != null) {
                    h.postDelayed(runnable, delayMs);
                } else {
                    runnable.run();
                }
            }

            @Override
            public void requestAeLock(CameraCaptureSession session) {
                boolean lockRequested = AePreviewController.requestAeLock(
                        session,
                        hooks.coordinator().device() != null,
                        hooks.previewBuilder(),
                        aeCallback,
                        hooks.backgroundHandler(),
                        hooks.cameraSettings(),
                        aeStateMachine);
                if (lockRequested) {
                    shotState = AeStateMachine.ShotState.WAITING_AE_LOCK;
                } else {
                    capturePhoto();
                }
            }

            @Override
            public void capturePhoto() {
                PhotoSession.this.capturePhoto();
            }

            @Override
            public void notifyPhotoError(String errorMessage) {
                PhotoSession.this.notifyPhotoError(errorMessage);
            }

            @Override
            public void cancelKeepAliveTimer() {
                hooks.cancelKeepAliveTimer();
            }

            @Override
            public void closeCamera() {
                hooks.closeCamera();
            }

            @Override
            public void stopSelf() {
                hooks.stopService();
            }
        });
    }

    public AeCaptureCallback aeCallback() {
        return aeCallback;
    }

    public AeStateMachine.ShotState shotState() {
        return shotState;
    }

    @Nullable
    public ImageReaderTwin imageReaders() {
        return imageReaders;
    }

    public void setJpegSize(Size size) {
        this.jpegSize = size;
    }

    @Nullable
    public Size jpegSize() {
        return jpegSize;
    }

    public void prepareStillReaders(String filePath, Size jpegSize, Handler backgroundHandler) {
        this.jpegSize = jpegSize;
        listenerFallbackPhotoPath = filePath;
        imageReaders = new ImageReaderTwin(jpegSize, backgroundHandler, this::onStillImageAvailable);
    }

    public void closeImageReadersIfPresent() {
        if (imageReaders != null) {
            imageReaders.close();
            imageReaders = null;
        }
    }

    /** Called from session onConfigured after camera is ready for photo pipeline. */
    public void pollFirstQueuedRequestIntoCurrent() {
        synchronized (hooks.serviceLock()) {
            if (!QueuedPhotoRequestQueue.getInstance().isEmpty()) {
                Log.d(TAG, "Camera ready, processing " + QueuedPhotoRequestQueue.getInstance().size() + " queued requests");
                QueuedPhotoRequest firstRequest = QueuedPhotoRequestQueue.getInstance().poll();
                if (firstRequest != null) {
                    activateQueuedRequest(firstRequest);
                }
            }
        }
    }

    // ----- Active capture helpers (read {@link #activeCapture}) -----

    private String currentFilePath() {
        return activeCapture != null ? activeCapture.filePath : null;
    }

    private String currentSize() {
        return activeCapture != null ? activeCapture.size : null;
    }

    private boolean currentIsFromSdk() {
        return activeCapture != null && activeCapture.isFromSdk;
    }

    private Long currentExposureTimeNs() {
        return activeCapture != null ? activeCapture.exposureTimeNs : null;
    }

    private long currentStartTimeMs() {
        return activeCapture != null ? activeCapture.startTimeMs : 0L;
    }

    /**
     * Dequeue handoff: copy the queued job into {@link #activeCapture} before AE/capture.
     * The queue entry may still be mutated for callback binding until this runs.
     */
    private void activateQueuedRequest(QueuedPhotoRequest queued) {
        activeCapture = ActivePhotoCapture.fromQueued(queued);
        rememberConfiguredCamera(queued);
    }

    /** Shot finished or aborted; {@link #configuredCameraConfig} may still describe the open HAL session. */
    private void clearActiveCapture() {
        activeCapture = null;
    }

    private void rememberConfiguredCamera(QueuedPhotoRequest pr) {
        if (pr != null) {
            configuredCameraConfig = ConfiguredCameraConfig.from(pr);
        }
    }

    /** Clears the configured-camera snapshot when the HAL session is torn down. */
    public void onCameraClosed() {
        configuredCameraConfig = null;
    }

    private int getJpegQualityForSize() {
        if (currentIsFromSdk()) {
            String size = currentSize();
            if (size == null) {
                return CameraConstants.SDK_JPEG_QUALITY_MEDIUM;
            }
            switch (size) {
                case CameraConstants.SIZE_SMALL:
                    return CameraConstants.SDK_JPEG_QUALITY_SMALL;
                case CameraConstants.SIZE_LARGE:
                    return CameraConstants.SDK_JPEG_QUALITY_LARGE;
                case CameraConstants.SIZE_FULL:
                    return CameraConstants.SDK_JPEG_QUALITY_FULL;
                case CameraConstants.SIZE_MEDIUM:
                default:
                    return CameraConstants.SDK_JPEG_QUALITY_MEDIUM;
            }
        } else {
            return CameraConstants.BUTTON_JPEG_QUALITY;
        }
    }

    // ----- Dispatch -----

    /**
     * Compares {@code request} to the active session camera config (size, SDK flag, exposure).
     * Uses {@link #configuredCameraConfig} when {@link #activeCapture} was cleared after a shot.
     * Must be called before {@link #activateQueuedRequest(QueuedPhotoRequest)} mutates current state.
     */
    private boolean needsReconfigurationForQueued(QueuedPhotoRequest request) {
        if (request == null) {
            return true;
        }
        ConfiguredCameraConfig baseline = configuredCameraConfig;
        if (baseline == null && activeCapture != null) {
            baseline = ConfiguredCameraConfig.from(activeCapture);
        }
        if (baseline == null) {
            return false;
        }
        return baseline.differsFrom(request);
    }

    public void dispatchNextPhotoRequest() {
        synchronized (hooks.serviceLock()) {
            QueuedPhotoRequestQueue queue = QueuedPhotoRequestQueue.getInstance();
            if (queue.isEmpty()) {
                Log.d(TAG, "No photo requests in queue");
                hooks.startKeepAliveTimer();
                return;
            }
            if (shotState != AeStateMachine.ShotState.IDLE) {
                Log.d(TAG, "Camera busy (state: " + shotState + ") - request remains queued");
                return;
            }

            if (hooks.coordinator().hasConfiguredCamera()) {
                QueuedPhotoRequest firstRequest = queue.peek();
                if (firstRequest == null) {
                    hooks.startKeepAliveTimer();
                    return;
                }
                queue.attachRegistryCallback(firstRequest);
                if (needsReconfigurationForQueued(firstRequest)) {
                    Log.d(TAG, "Configured camera needs reconfiguration for " + firstRequest.requestId
                            + " — routing through setupCameraForQueuedRequest");
                    setupCameraForQueuedRequest(firstRequest);
                    return;
                }
                QueuedPhotoRequest request = queue.poll();
                if (request == null) {
                    hooks.startKeepAliveTimer();
                    return;
                }
                Log.d(TAG, "Dispatching queued photo with configured camera: " + request.requestId);
                hooks.cancelKeepAliveTimer();
                activateQueuedRequest(request);
                shotState = AeStateMachine.ShotState.WAITING_AE;
                // Arm AE wait on this thread so the camera Handler sees a published true
                // immediately (Bluetooth thread is not the preview callback looper).
                if (!shouldUseManualExposure()) {
                    aeStateMachine.beginWaitingForAe();
                }
                Handler h = hooks.backgroundHandler();
                if (h != null) {
                    // Run before any already-queued repeating-request callbacks so
                    // beginWaitingForAe() runs before AE sees shotState WAITING_AE.
                    h.postAtFrontOfQueue(this::startPrecaptureSequence);
                } else {
                    startPrecaptureSequence();
                }
                return;
            }

            QueuedPhotoRequest firstRequest = queue.peek();
            if (firstRequest != null) {
                Log.d(TAG, "Opening camera for queued photo request: " + firstRequest.requestId);
                queue.attachRegistryCallback(firstRequest);
                setupCameraForQueuedRequest(firstRequest);
            }
        }
    }

    public void setupCameraForQueuedRequest(QueuedPhotoRequest request) {
        if (request == null) return;

        Log.i(TAG, "📸 PHOTO E2E: Starting photo request " + request.requestId);

        boolean needsReopen = needsReconfigurationForQueued(request);

        activateQueuedRequest(request);

        if (hooks.coordinator().isCameraKeptAlive() && hooks.coordinator().device() != null) {
            Log.d(TAG, "Camera already open, checking if reconfiguration needed");

            if (needsReopen) {
                Log.d(TAG, "Camera config changed (reconfiguration required), reopening camera");
                hooks.cancelKeepAliveTimer();
                hooks.closeCamera();
                hooks.openCameraInternal(request.filePath, false);
            } else {
                Log.d(TAG, "Camera config unchanged, taking photo immediately");
                hooks.cancelKeepAliveTimer();

                shotState = AeStateMachine.ShotState.WAITING_AE;
                if (!shouldUseManualExposure()) {
                    aeStateMachine.beginWaitingForAe();
                }
                Handler h = hooks.backgroundHandler();
                if (h != null) {
                    h.postAtFrontOfQueue(this::startPrecaptureSequence);
                } else {
                    startPrecaptureSequence();
                }
            }
        } else {
            Log.d(TAG, "Opening camera for photo capture");
            hooks.wakeUpScreen();
            hooks.openCameraInternal(request.filePath, false);
        }
    }

    // ----- Image path -----

    private void onStillImageAvailable(ImageReader reader) {
        if (shotState != AeStateMachine.ShotState.SHOOTING) {
            try (Image image = reader.acquireLatestImage()) {
                // Drain stray buffers
            }
            return;
        }

        Log.d(TAG, "Processing photo capture...");
        try (Image image = reader.acquireLatestImage()) {
            try {
                long imgTs = (image != null) ? image.getTimestamp() : -1L;
                Long stillTs = mLastStillSensorTimestampNs;
                long deltaMs = (stillTs != null && imgTs > 0) ? (stillTs - imgTs) / 1_000_000L : -1L;
                boolean match = (stillTs != null && imgTs > 0 && stillTs == imgTs);
                CameraDiagnosticsLog.savedFrameTimestampVsStill(imgTs, stillTs, match, deltaMs);
            } catch (Throwable t) {
                // Never let logging crash capture.
            }
            if (image == null) {
                Log.e(TAG, "Acquired image is null");
                if (!hdrBurstCapture.isActive()) {
                    notifyPhotoError("Failed to acquire image data");
                    shotState = AeStateMachine.ShotState.IDLE;
                    hooks.closeCamera();
                    hooks.stopService();
                }
                return;
            }

            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);

            String currentPath = currentFilePath();
            String targetPath = (currentPath != null) ? currentPath : listenerFallbackPhotoPath;

            if (hdrBurstCapture.handleFrame(bytes, targetPath, this::saveImageDataToFile,
                    new HdrBurstCapture.Callback() {
                        @Override
                        public void onBurstComplete(String basePath) {
                            ImuRecorder imu = hooks.imuRecorderOrNull();
                            if (imu != null) {
                                String imuPath = imu.stopRecordingAndSave(basePath);
                                if (imuPath != null) {
                                    Log.d(TAG, "IMU sidecar saved: " + imuPath);
                                }
                            }
                            notifyPhotoCaptured(basePath);
                            clearActiveCapture();
                            shotState = AeStateMachine.ShotState.IDLE;
                            dispatchNextPhotoRequest();
                        }

                        @Override
                        public void onBurstFailed(String reason) {
                            notifyPhotoError(reason);
                        }

                        @Override
                        public void onAllCaptureRequestsCompleted(CameraCaptureSession session) {
                            // Image routing handles completion here; preview restoration happens from capture callbacks.
                        }
                    })) {
                return;
            }

            boolean success = saveImageDataToFile(bytes, targetPath);

            if (success) {
                ImuRecorder imu = hooks.imuRecorderOrNull();
                if (imu != null) {
                    String imuPath = imu.stopRecordingAndSave(targetPath);
                    if (imuPath != null) {
                        Log.d(TAG, "IMU sidecar saved: " + imuPath);
                    }
                }

                notifyPhotoCaptured(targetPath);
                Log.d(TAG, "Photo saved successfully: " + targetPath);
                clearActiveCapture();
            } else {
                ImuRecorder imu = hooks.imuRecorderOrNull();
                if (imu != null) {
                    imu.cancel();
                }
                notifyPhotoError("Failed to save image");
            }

            shotState = AeStateMachine.ShotState.IDLE;
            dispatchNextPhotoRequest();
        } catch (Exception e) {
            Log.e(TAG, "Error handling image data", e);
            notifyPhotoError("Error processing photo: " + e.getMessage());
            ImuRecorder imu = hooks.imuRecorderOrNull();
            if (imu != null) {
                imu.cancel();
            }
            shotState = AeStateMachine.ShotState.IDLE;

            if (!QueuedPhotoRequestQueue.getInstance().isEmpty()) {
                dispatchNextPhotoRequest();
            } else {
                hooks.cancelKeepAliveTimer();
                clearActiveCapture();
                hooks.closeCamera();
                hooks.stopService();
            }
        }
    }

    private boolean saveImageDataToFile(byte[] data, String filePath) {
        try {
            File file = new File(filePath);

            File parentDir = file.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }

            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(data);
            }

            Log.d(TAG, "Saved image to: " + filePath);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error saving image", e);
            return false;
        }
    }

    private void notifyPhotoCaptured(String filePath) {
        long startMs = currentStartTimeMs();
        long e2eTimeMs = (startMs > 0) ? (System.currentTimeMillis() - startMs) : -1L;
        Log.i(TAG, "📸 PHOTO E2E: Photo captured and saved in " + e2eTimeMs + "ms (e2e) | Path: " + filePath);

        CameraNeoService.PhotoCaptureCallback callback = activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            hooks.executor().execute(() -> callback.onPhotoCaptured(filePath));
        }
    }

    private void notifyPhotoError(String errorMessage) {
        CameraNeoService.PhotoCaptureCallback callback = activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            hooks.executor().execute(() -> callback.onPhotoError(errorMessage));
        }
    }

    // ----- Preview / AE -----

    public void startPreviewWithAeMonitoring() {
        try {
            CameraCaptureSession activeSession = hooks.coordinator().session();
            if (activeSession == null) {
                Log.e(TAG, "Camera capture session is null in startPreviewWithAeMonitoring");
                notifyPhotoError("Camera session not ready");
                hooks.closeCamera();
                hooks.stopService();
                return;
            }

            CaptureRequest previewRequest = hooks.previewBuilder().build();
            Boolean zslInPreview = previewRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            if (zslInPreview != null && zslInPreview) {
                Log.d(TAG, "✓ ZSL verified in preview request: CONTROL_ENABLE_ZSL = true (buffer filling)");
            } else {
                Log.w(TAG, "⚠ ZSL NOT enabled in preview request - ZSL buffer will not fill!");
            }

            activeSession.setRepeatingRequest(previewRequest,
                    aeCallback, hooks.backgroundHandler());

            startPrecaptureSequence();

        } catch (CameraAccessException e) {
            Log.e(TAG, "Error starting preview with AE monitoring", e);
            notifyPhotoError("Error starting preview: " + e.getMessage());
            hooks.cancelKeepAliveTimer();
            hooks.closeCamera();
            hooks.stopService();
        }
    }

    public void startPrecaptureSequence() {
        try {
            shotState = AeStateMachine.ShotState.WAITING_AE;

            if (shouldUseManualExposure()) {
                Log.i(TAG, "Manual exposure (exposureTimeNs=" + currentExposureTimeNs() + "): skipping AE convergence");
                aeStateMachine.skipAeForManualCapture();
                Runnable runCapture = this::capturePhoto;
                Handler h = hooks.backgroundHandler();
                if (h != null) {
                    h.post(runCapture);
                } else {
                    runCapture.run();
                }
                return;
            }

            aeStateMachine.beginWaitingForAe();

            boolean zslEnabled = (hooks.cameraSettings() != null && hooks.cameraSettings().isZslSupported() &&
                    hooks.cameraSettings().mAsgSettings.isZslEnabled());

            Log.d(TAG, "🔍 DIAGNOSTIC: startPrecaptureSequence() called");
            Log.d(TAG, "🔍 ZSL enabled: " + zslEnabled);
            Log.d(TAG, "🔍 Current shot state: " + shotState);
            Log.d(TAG, "🔍 Waiting for AE convergence: " + aeStateMachine.waitingForAeConvergence());

            Log.d(TAG, "Starting AE convergence (monitoring via repeating request callback)...");
            Log.d(TAG, "🔍 XyCamera2 MODE: No precapture trigger - monitoring AE via repeating request callback");

        } catch (Exception e) {
            Log.e(TAG, "Error starting AE convergence", e);
            notifyPhotoError("Error starting AE convergence: " + e.getMessage());
            shotState = AeStateMachine.ShotState.IDLE;
            aeStateMachine.clearWaitFlags();
            hooks.cancelKeepAliveTimer();
            hooks.closeCamera();
            hooks.stopService();
        }
    }

    public void restoreAePreview(CameraCaptureSession session) {
        // A late still/HDR completion can run after a new photo has entered precapture; do not
        // clear AE wait flags in that case or the repeating callback will ignore convergence forever.
        boolean clearAeWait = shotState != AeStateMachine.ShotState.WAITING_AE
                && shotState != AeStateMachine.ShotState.WAITING_AE_LOCK;
        AePreviewController.restorePreview(
                session,
                hooks.coordinator().device() != null,
                hooks.previewBuilder(),
                aeCallback,
                hooks.backgroundHandler(),
                hooks.cameraSettings(),
                aeStateMachine,
                clearAeWait);
    }

    private boolean shouldUseManualExposure() {
        Long exposureNs = currentExposureTimeNs();
        CameraCapabilities caps = hooks.capabilities();
        boolean manualSupported = caps != null && caps.manualSensorSupported;
        Range<Long> expRange = (caps != null) ? caps.sensorExposureTimeRange : null;
        Range<Integer> isoRange = (caps != null) ? caps.sensorSensitivityRange : null;
        boolean decision;
        String reason;
        if (exposureNs == null || exposureNs <= 0) {
            decision = false;
            reason = "no/invalid activeCapture.exposureTimeNs";
        } else if (!manualSupported) {
            Log.w(TAG, "Manual exposure requested but MANUAL_SENSOR not supported; using auto exposure");
            decision = false;
            reason = "MANUAL_SENSOR unsupported";
        } else if (expRange == null || isoRange == null) {
            Log.w(TAG, "Manual exposure requested but sensor ranges unavailable; using auto exposure");
            decision = false;
            reason = "sensor ranges null";
        } else {
            decision = true;
            reason = "manual path engaged";
        }
        try {
            CameraDiagnosticsLog.manualExposureDecision(decision, reason, exposureNs, manualSupported);
        } catch (Throwable t) { /* never let logging crash capture */ }
        return decision;
    }

    private String describeAutoExposureStillPath() {
        Long exposureNs = currentExposureTimeNs();
        if (exposureNs == null) {
            return "no pending exposureNs (auto AE)";
        }
        if (exposureNs <= 0) {
            return "pending exposureNs invalid (" + exposureNs + ")";
        }
        CameraCapabilities caps = hooks.capabilities();
        if (caps == null || !caps.manualSensorSupported) {
            return "manual requested but MANUAL_SENSOR unsupported";
        }
        if (caps.sensorExposureTimeRange == null
                || caps.sensorSensitivityRange == null) {
            return "manual requested but sensor ranges unavailable";
        }
        return "auto AE path";
    }

    private long clampExposureTimeNs(long requestedNs) {
        CameraCapabilities caps = hooks.capabilities();
        Range<Long> range = (caps != null) ? caps.sensorExposureTimeRange : null;
        return ManualExposurePolicy.clampExposureTimeNs(requestedNs, range);
    }

    private int pickSensitivityForManualCapture(long targetExposureNs) {
        Integer last = mLastMeteredIso;
        Long meteredExposureNs = mLastMeteredExposureNs;
        CameraCapabilities caps = hooks.capabilities();
        Range<Integer> isoRange = (caps != null) ? caps.sensorSensitivityRange : null;

        int isoBeforeScale = (last != null && last > 0) ? last.intValue() : ManualExposurePolicy.DEFAULT_ISO;
        double evScaleApplied = 1.0;
        int isoAfterScale = isoBeforeScale;
        if (meteredExposureNs != null && meteredExposureNs > 0 && targetExposureNs > 0 && isoBeforeScale > 0) {
            evScaleApplied = (double) meteredExposureNs / (double) targetExposureNs;
            isoAfterScale = (int) Math.round(isoBeforeScale * evScaleApplied);
        }

        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                targetExposureNs, last, meteredExposureNs, isoRange);

        try {
            Integer isoLow = (isoRange != null) ? isoRange.getLower() : null;
            Integer isoHigh = (isoRange != null) ? isoRange.getUpper() : null;
            CameraDiagnosticsLog.manualIsoComputation(
                    last,
                    meteredExposureNs,
                    targetExposureNs,
                    evScaleApplied,
                    isoBeforeScale,
                    isoAfterScale,
                    iso,
                    isoLow,
                    isoHigh);
        } catch (Throwable t) { /* never let logging crash capture */ }
        return iso;
    }

    private long pickFrameDurationForManualCapture(long exposureNs) {
        CameraCapabilities caps = hooks.capabilities();
        Long maxFrameNs = (caps != null) ? caps.sensorMaxFrameDurationNs : null;
        return ManualExposurePolicy.pickFrameDurationForManualCapture(exposureNs, maxFrameNs);
    }

    public void capturePhoto() {
        if (shotState == AeStateMachine.ShotState.SHOOTING) {
            Log.d(TAG, "capturePhoto() skipped — another capture already in-flight");
            return;
        }

        boolean hdrEnabled = hooks.cameraSettings() != null
                && hooks.cameraSettings().mAsgSettings.isHdrBurstEnabled()
                && !currentIsFromSdk();

        if (hdrEnabled) {
            captureHdrBurst();
            return;
        }

        try {
            CameraDevice activeCameraDevice = hooks.coordinator().device();
            CameraCaptureSession activeSession = hooks.coordinator().session();
            if (activeCameraDevice == null || activeSession == null) {
                notifyPhotoError("Camera not ready for capture");
                shotState = AeStateMachine.ShotState.IDLE;
                return;
            }
            shotState = AeStateMachine.ShotState.SHOOTING;

            ImuRecorder imu = hooks.ensureImuRecorder();
            imu.startRecording();

            CaptureRequest.Builder stillBuilder =
                    activeCameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            stillBuilder.addTarget(imageReaders.getStillSurface());

            boolean useManual = shouldUseManualExposure();

            long manualClampedNs = 0L;
            int manualIso = 0;
            long manualFrameDurationNs = 0L;

            Long requestedExposureNs = currentExposureTimeNs();
            if (useManual) {
                manualClampedNs = clampExposureTimeNs(requestedExposureNs);
                manualIso = pickSensitivityForManualCapture(manualClampedNs);
                manualFrameDurationNs = pickFrameDurationForManualCapture(manualClampedNs);
                Log.i(TAG, "Using manual exposure time for still capture: SENSOR_EXPOSURE_TIME="
                        + manualClampedNs + " ns, SENSOR_SENSITIVITY=" + manualIso
                        + ", SENSOR_FRAME_DURATION=" + manualFrameDurationNs
                        + " (requestedNs=" + requestedExposureNs + "; AE disabled; ZSL/MFNR vendor path skipped)");
            } else {
                Log.d(TAG, "Using auto exposure / AE lock path");
            }

            int displayOrientation = hooks.displayRotation();
            int jpegOrientation = JpegOrientationResolver.lookupJpegOrientation(
                    displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);

            StillCaptureBuilder.configure(StillCaptureBuilder.wrap(stillBuilder), useManual,
                    manualClampedNs, manualIso, manualFrameDurationNs, hooks.userExposureCompensation(),
                    hooks.selectedFpsRange(), hooks.hasAutoFocus(), jpegSize, getJpegQualityForSize(),
                    jpegOrientation);

            Log.d(TAG, "Capturing photo with JPEG orientation: " + jpegOrientation
                    + " for display orientation: " + displayOrientation);

            if (!useManual && hooks.cameraSettings() != null
                    && (hooks.cameraSettings().mAsgSettings.isZslEnabled()
                    || hooks.cameraSettings().mAsgSettings.isMfnrEnabled())) {
                hooks.cameraSettings().configureCaptureBuilder(stillBuilder);
            }

            CaptureRequest captureRequest = stillBuilder.build();

            Boolean zslInCapture = captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            if (zslInCapture != null && zslInCapture) {
                Log.d(TAG, "✓ ZSL verified in capture request: CONTROL_ENABLE_ZSL = true");
            } else {
                Log.w(TAG, "⚠ ZSL NOT enabled in capture request (CONTROL_ENABLE_ZSL = " + zslInCapture + ")");
            }

            if (useManual) {
                Log.i(TAG, "📸 SHOT firing: MANUAL exposureTimeNs=" + manualClampedNs
                        + " (requested=" + requestedExposureNs + ") iso=" + manualIso
                        + " frameDurationNs=" + manualFrameDurationNs);
            } else {
                Log.i(TAG, "📸 SHOT firing: AUTO — " + describeAutoExposureStillPath());
            }

            try {
                Long reqExp = captureRequest.get(CaptureRequest.SENSOR_EXPOSURE_TIME);
                Integer reqIso = captureRequest.get(CaptureRequest.SENSOR_SENSITIVITY);
                Long reqFrameDur = captureRequest.get(CaptureRequest.SENSOR_FRAME_DURATION);
                Integer reqAeMode = captureRequest.get(CaptureRequest.CONTROL_AE_MODE);
                Integer reqNrMode = captureRequest.get(CaptureRequest.NOISE_REDUCTION_MODE);
                Integer reqEdgeMode = captureRequest.get(CaptureRequest.EDGE_MODE);
                Integer reqAfMode = captureRequest.get(CaptureRequest.CONTROL_AF_MODE);
                Boolean reqZsl = captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
                Boolean reqAeLock = captureRequest.get(CaptureRequest.CONTROL_AE_LOCK);
                Range<Integer> reqFps = captureRequest.get(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE);
                Integer reqExpComp = captureRequest.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION);
                CameraDiagnosticsLog.stillRequestKeysBeforeCapture(
                        useManual,
                        reqExp,
                        reqIso,
                        reqFrameDur,
                        reqAeMode,
                        reqNrMode,
                        reqEdgeMode,
                        reqAfMode,
                        reqZsl,
                        reqAeLock,
                        reqExpComp,
                        reqFps);
            } catch (Throwable t) { /* never let logging crash capture */ }

            activeSession.capture(captureRequest, new StillCaptureCallback(new StillCaptureCallback.Hooks() {
                @Override
                public void recordStillSensorTimestampNs(Long timestampNs) {
                    mLastStillSensorTimestampNs = timestampNs;
                }

                @Override
                public void restorePreview(CameraCaptureSession session) {
                    restoreAePreview(session);
                }

                @Override
                public void notifyPhotoError(String errorMessage) {
                    PhotoSession.this.notifyPhotoError(errorMessage);
                }

                @Override
                public void cancelImuRecording() {
                    hooks.cancelImuRecording();
                }

                @Override
                public void setShotState(AeStateMachine.ShotState nextShotState) {
                    shotState = nextShotState;
                }

                @Override
                public void clearAeWaitFlags() {
                    aeStateMachine.clearWaitFlags();
                }

                @Override
                public void cancelKeepAliveTimer() {
                    hooks.cancelKeepAliveTimer();
                }

                @Override
                public void closeCamera() {
                    hooks.closeCamera();
                }

                @Override
                public void stopSelf() {
                    hooks.stopService();
                }
            }), hooks.backgroundHandler());

        } catch (CameraAccessException e) {
            Log.e(TAG, "Error during photo capture", e);
            notifyPhotoError("Error capturing photo: " + e.getMessage());
            hooks.cancelImuRecording();
            shotState = AeStateMachine.ShotState.IDLE;
            hooks.cancelKeepAliveTimer();
            hooks.closeCamera();
            hooks.stopService();
        }
    }

    private void captureHdrBurst() {
        try {
            shotState = AeStateMachine.ShotState.SHOOTING;

            ImuRecorder imu = hooks.ensureImuRecorder();
            imu.startRecording();

            Log.i(TAG, "HDR: Starting burst capture with brackets "
                    + java.util.Arrays.toString(HdrBurstBuilder.HDR_EV_BRACKETS));

            int displayOrientation = hooks.displayRotation();
            int jpegOrientation = JpegOrientationResolver.lookupJpegOrientation(
                    displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);
            int jpegQuality = getJpegQualityForSize();

            hdrBurstCapture.start(hooks.coordinator().session(), hooks.coordinator().device(), imageReaders.getStillSurface(),
                    hooks.backgroundHandler(), hooks.selectedFpsRange(), hooks.hasAutoFocus(), jpegQuality, jpegOrientation,
                    hooks.cameraSettings(), new HdrBurstCapture.Callback() {
                        @Override
                        public void onBurstComplete(String basePath) {
                            // Frame completion is handled from the ImageReader listener.
                        }

                        @Override
                        public void onBurstFailed(String reason) {
                            hooks.cancelImuRecording();
                            notifyPhotoError(reason);
                            shotState = AeStateMachine.ShotState.IDLE;
                            hooks.closeCamera();
                            hooks.stopService();
                        }

                        @Override
                        public void onAllCaptureRequestsCompleted(CameraCaptureSession session) {
                            restoreAePreview(session);
                        }
                    });

        } catch (CameraAccessException e) {
            Log.e(TAG, "Error during HDR burst capture", e);
            hdrBurstCapture.cancel();
            hooks.cancelImuRecording();
            notifyPhotoError("HDR burst error: " + e.getMessage());
            shotState = AeStateMachine.ShotState.IDLE;
            hooks.closeCamera();
            hooks.stopService();
        }
    }

    public boolean photoRequestFromSdk() {
        return activeCapture != null && activeCapture.isFromSdk;
    }

    @Nullable
    public String photoRequestSizeTier() {
        return activeCapture != null ? activeCapture.size : null;
    }

    /** Called from {@link CameraNeoService} when setup/open/session errors occur before capture. */
    public void notifyHostPhotoError(String errorMessage) {
        notifyPhotoError(errorMessage);
    }

    public int previewJpegQuality() {
        return getJpegQualityForSize();
    }

    /**
     * Immutable snapshot of camera pipeline parameters for burst reuse decisions.
     */
    private static final class ConfiguredCameraConfig {
        @Nullable
        final String size;
        final boolean isFromSdk;
        @Nullable
        final Long exposureTimeNs;

        ConfiguredCameraConfig(@Nullable String size, boolean isFromSdk, @Nullable Long exposureTimeNs) {
            this.size = size;
            this.isFromSdk = isFromSdk;
            this.exposureTimeNs = exposureTimeNs;
        }

        static ConfiguredCameraConfig from(QueuedPhotoRequest request) {
            return new ConfiguredCameraConfig(request.size, request.isFromSdk, request.exposureTimeNs);
        }

        static ConfiguredCameraConfig from(ActivePhotoCapture request) {
            return new ConfiguredCameraConfig(request.size, request.isFromSdk, request.exposureTimeNs);
        }

        boolean differsFrom(QueuedPhotoRequest request) {
            if (!Objects.equals(size, request.size)) {
                return true;
            }
            if (isFromSdk != request.isFromSdk) {
                return true;
            }
            return !Objects.equals(exposureTimeNs, request.exposureTimeNs);
        }
    }

    /**
     * Service-level bridge for threading, wake, camera open, and shared builders.
     */
    public interface Hooks {
        Object serviceLock();

        void openCameraInternal(String filePath, boolean forVideo);

        void closeCamera();

        void startKeepAliveTimer();

        void cancelKeepAliveTimer();

        void wakeUpScreen();

        void stopService();

        CameraCoordinator coordinator();

        @Nullable
        CameraCapabilities capabilities();

        Range<Integer> selectedFpsRange();

        boolean hasAutoFocus();

        CameraSettings cameraSettings();

        Executor executor();

        @Nullable
        Handler backgroundHandler();

        int displayRotation();

        boolean videoRecording();

        CaptureRequest.Builder previewBuilder();

        int userExposureCompensation();

        @Nullable
        ImuRecorder imuRecorderOrNull();

        /** Creates {@link ImuRecorder} if needed (shared with video path). */
        ImuRecorder ensureImuRecorder();

        void cancelImuRecording();
    }
}
