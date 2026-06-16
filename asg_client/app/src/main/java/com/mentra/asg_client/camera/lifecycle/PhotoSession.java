package com.mentra.asg_client.camera.lifecycle;

import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
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
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
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
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Objects;
import java.util.concurrent.Executor;
import org.json.JSONObject;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Owns photo capture lifecycle: queue dispatch, AE precapture, still/HDR capture, image save, and
 * metering timestamps. Bridges to {@link CameraNeoService} via {@link Hooks}.
 *
 * <p><b>Request model (see {@code camera.model}):</b>
 *
 * <ul>
 *   <li>{@link com.mentra.asg_client.camera.model.QueuedPhotoRequest} — waiting in {@link
 *       com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue}
 *   <li>{@link com.mentra.asg_client.camera.model.ActivePhotoCapture} — frozen snapshot in {@link
 *       #activeCapture} while this session runs AE/capture
 * </ul>
 *
 * Promotion happens in {@link #activateQueuedRequest}; {@link #clearActiveCapture} runs after each
 * shot.
 */
public final class PhotoSession {

    private static final String TAG = "CameraNeo";
    private static final long CAPTURE_METADATA_WAIT_TIMEOUT_MS = 750;

    /** Fallback output path for still {@link ImageReader} callback (openCamera path param). */
    private String listenerFallbackPhotoPath;

    private ImageReaderTwin imageReaders;
    private Size jpegSize;

    /**
     * Non-null while a {@link QueuedPhotoRequest} is being captured (AE → still → JPEG). Cleared
     * after each shot; see {@link #activateQueuedRequest} and {@link #clearActiveCapture}.
     */
    private volatile ActivePhotoCapture activeCapture;

    /**
     * Last camera pipeline config (size / SDK / exposure) applied to the open session. Survives
     * {@link #clearActiveCapture()} so queued burst shots can reuse the session without a
     * false-positive reconfiguration after the previous shot completes.
     */
    @Nullable private volatile ConfiguredCameraConfig configuredCameraConfig;

    private volatile AeStateMachine.ShotState shotState = AeStateMachine.ShotState.IDLE;
    private final AeStateMachine aeStateMachine = new AeStateMachine();

    private volatile Integer mLastMeteredIso;
    private volatile Long mLastMeteredExposureNs;
    private volatile Long mLastStillSensorTimestampNs;

    private final HdrBurstCapture hdrBurstCapture = new HdrBurstCapture();
    private final Object captureMetadataLock = new Object();
    @Nullable
    private JSONObject pendingStillCaptureMetadata;
    @Nullable
    private String pendingCapturedFilePath;
    @Nullable
    private CameraNeoService.PhotoCaptureCallback pendingCapturedCallback;
    private long pendingCapturedStartTimeMs;
    @Nullable
    private Runnable pendingCaptureMetadataTimeout;
    private boolean photoCapturedCallbackSent;

    /**
     * Bumped every time capture metadata state is reset (i.e. a new shot begins). A {@link
     * StillCaptureCallback} captures the generation in flight when it is created; a late
     * {@code onCaptureCompleted} from a previous shot is then dropped instead of being attached to
     * the next photo's {@code captured} status/callback.
     */
    private long captureMetadataGeneration;

    private final Hooks hooks;
    private final AeCaptureCallback aeCallback;

    public PhotoSession(Hooks hooks) {
        this.hooks = hooks;
        this.aeCallback =
                new AeCaptureCallback(
                        aeStateMachine,
                        new AeCaptureCallback.Hooks() {
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
                                boolean lockRequested =
                                        AePreviewController.requestAeLock(
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
        imageReaders =
                new ImageReaderTwin(jpegSize, backgroundHandler, this::onStillImageAvailable);
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
                Log.d(
                        TAG,
                        "Camera ready, processing "
                                + QueuedPhotoRequestQueue.getInstance().size()
                                + " queued requests");
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
        if (activeCapture != null
                && activeCapture.exposureTimeNs != null
                && activeCapture.exposureTimeNs > 0) {
            return activeCapture.exposureTimeNs;
        }
        PhotoCaptureSettings settings = currentCaptureSettings();
        if (settings.usesScanExposure()
                && mLastMeteredExposureNs != null
                && mLastMeteredExposureNs > 0
                && settings.aeExposureDivisor != null) {
            return mLastMeteredExposureNs / settings.aeExposureDivisor;
        }
        return activeCapture != null ? activeCapture.exposureTimeNs : null;
    }

    private boolean shouldUseScanExposure() {
        PhotoCaptureSettings settings = currentCaptureSettings();
        if (!settings.usesScanExposure()) {
            return false;
        }
        if (mLastMeteredExposureNs == null || mLastMeteredExposureNs <= 0) {
            return false;
        }
        CameraCapabilities caps = hooks.capabilities();
        return caps != null
                && caps.manualSensorSupported
                && caps.sensorExposureTimeRange != null
                && caps.sensorSensitivityRange != null;
    }

    private Integer currentIso() {
        return activeCapture != null ? activeCapture.iso : null;
    }

    private PhotoCaptureSettings currentCaptureSettings() {
        return activeCapture != null
                ? activeCapture.captureSettings
                : PhotoCaptureSettings.EMPTY;
    }

    /**
     * Explicit {@code zsl} on the request wins; otherwise let the global device setting apply.
     * ZSL and MFNR are independent capabilities — ZSL being off should not be implied by MFNR
     * being off, as ZSL reduces shutter lag regardless of multi-frame processing.
     */
    private static Boolean resolveRequestZsl(PhotoCaptureSettings captureSettings) {
        if (captureSettings != null && captureSettings.zsl != null) {
            return captureSettings.zsl;
        }
        return null;
    }

    private long currentStartTimeMs() {
        return activeCapture != null ? activeCapture.startTimeMs : 0L;
    }

    /**
     * Dequeue handoff: copy the queued job into {@link #activeCapture} before AE/capture. The queue
     * entry may still be mutated for callback binding until this runs.
     */
    private void activateQueuedRequest(QueuedPhotoRequest queued) {
        resetCaptureMetadataState();
        // Scan exposure is derived from the AE-metered readings of the CURRENT scene. Clear the
        // previous shot's metering so a warm/burst session reuse or a camera reopen cannot make
        // shouldUseScanExposure()/shouldUseManualExposure() short-circuit AE convergence and apply
        // a stale exposure/ISO to this request. The AE callback re-populates these after metering.
        mLastMeteredExposureNs = null;
        mLastMeteredIso = null;
        activeCapture = ActivePhotoCapture.fromQueued(queued);
        rememberConfiguredCamera(queued);
    }

    /**
     * Shot finished or aborted; {@link #configuredCameraConfig} may still describe the open HAL
     * session.
     */
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
            if (currentCaptureSettings().usesScanExposure()) {
                return CameraConstants.SDK_JPEG_QUALITY_MAX;
            }
            switch (size) {
                case CameraConstants.SIZE_LOW:
                    return CameraConstants.SDK_JPEG_QUALITY_SMALL;
                case CameraConstants.SIZE_HIGH:
                    return CameraConstants.SDK_JPEG_QUALITY_LARGE;
                case CameraConstants.SIZE_MAX:
                    return CameraConstants.SDK_JPEG_QUALITY_MAX;
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
     * Compares {@code request} to the active session camera config (size, SDK flag, exposure). Uses
     * {@link #configuredCameraConfig} when {@link #activeCapture} was cleared after a shot. Must be
     * called before {@link #activateQueuedRequest(QueuedPhotoRequest)} mutates current state.
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

    /**
     * Predicts whether a photo with the given parameters would reuse the currently configured HAL
     * session (a "warm" capture) instead of triggering a close + reopen reconfiguration.
     *
     * <p>The camera is reconfigured (and therefore effectively cold) when the requested size, SDK
     * flag, or manual exposure differs from the open session — see {@link
     * #needsReconfigurationForQueued}. When there is no configured baseline (camera never opened or
     * already torn down) this returns {@code false}: a fresh open is a cold start.
     *
     * @return true if a capture with these params would reuse the open session, false otherwise.
     */
    public boolean willReuseConfiguredCamera(
            @Nullable String size, boolean isFromSdk, @Nullable Long exposureTimeNs) {
        ConfiguredCameraConfig baseline = configuredCameraConfig;
        if (baseline == null && activeCapture != null) {
            baseline = ConfiguredCameraConfig.from(activeCapture);
        }
        if (baseline == null) {
            return false;
        }
        return !baseline.differsFrom(size, isFromSdk, exposureTimeNs);
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
                    Log.d(
                            TAG,
                            "Configured camera needs reconfiguration for "
                                    + firstRequest.requestId
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
                notifyCurrentPhotoConfigured();
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

                notifyCurrentPhotoConfigured();
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
                long deltaMs =
                        (stillTs != null && imgTs > 0) ? (stillTs - imgTs) / 1_000_000L : -1L;
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

            if (hdrBurstCapture.handleFrame(
                    bytes,
                    targetPath,
                    this::saveImageDataToFile,
                    new HdrBurstCapture.Callback() {
                        @Override
                        public void onBurstComplete(String basePath) {
                            finishImuRecording(basePath);
                            // HDR has no StillCaptureCallback metadata to wait for.
                            notifyPhotoCaptured(basePath, false);
                        }

                        @Override
                        public void onBurstFailed(String reason) {
                            notifyPhotoError(reason);
                        }

                        @Override
                        public void onAllCaptureRequestsCompleted(CameraCaptureSession session) {
                            // Image routing handles completion here; preview restoration happens
                            // from capture callbacks.
                        }
                    })) {
                return;
            }

            boolean success = saveImageDataToFile(bytes, targetPath);

            if (success) {
                finishImuRecording(targetPath);

                notifyPhotoCaptured(targetPath);
                Log.d(TAG, "Photo saved successfully: " + targetPath);
            } else {
                ImuRecorder imu = hooks.imuRecorderOrNull();
                if (imu != null) {
                    imu.cancel();
                }
                finishFailedPhotoCapture("Failed to save image");
            }
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

    private void finishImuRecording(String photoPath) {
        ImuRecorder imu = hooks.imuRecorderOrNull();
        if (imu == null) {
            return;
        }
        JSONObject payload = imu.stopRecordingAndBuildPayload();
        if (payload == null || payload.optInt("sampleCount", 0) <= 0) {
            return;
        }
        try {
            PhotoExifMetadataWriter.writeImuPayload(photoPath, payload);
        } catch (IOException e) {
            Log.w(TAG, "Failed to write IMU EXIF on photo: " + photoPath, e);
        }
        String imuPath = imu.writeSidecar(photoPath, payload);
        if (imuPath != null) {
            Log.d(TAG, "IMU sidecar saved: " + imuPath);
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

    private void resetCaptureMetadataState() {
        Runnable timeoutToCancel;
        synchronized (captureMetadataLock) {
            timeoutToCancel = pendingCaptureMetadataTimeout;
            pendingStillCaptureMetadata = null;
            pendingCapturedFilePath = null;
            pendingCapturedCallback = null;
            pendingCapturedStartTimeMs = 0L;
            pendingCaptureMetadataTimeout = null;
            photoCapturedCallbackSent = false;
            captureMetadataGeneration++;
        }
        if (timeoutToCancel != null) {
            Handler h = hooks.backgroundHandler();
            if (h != null) {
                h.removeCallbacks(timeoutToCancel);
            }
        }
    }

    private void emitPhotoCaptured(
            String filePath,
            @Nullable JSONObject captureMetadata,
            @Nullable CameraNeoService.PhotoCaptureCallback callback,
            long startMs) {
        long e2eTimeMs = (startMs > 0) ? (System.currentTimeMillis() - startMs) : -1L;
        Log.i(
                TAG,
                "📸 PHOTO E2E: Photo captured and saved in "
                        + e2eTimeMs
                        + "ms (e2e) | Path: "
                        + filePath);

        if (callback != null) {
            hooks.executor().execute(() -> callback.onPhotoCaptured(filePath, captureMetadata));
        }
        finishSuccessfulPhotoCapture();
    }

    private void finishSuccessfulPhotoCapture() {
        clearActiveCapture();
        shotState = AeStateMachine.ShotState.IDLE;
        dispatchNextPhotoRequest();
    }

    private void finishFailedPhotoCapture(String errorMessage) {
        notifyPhotoError(errorMessage);
        clearActiveCapture();
        shotState = AeStateMachine.ShotState.IDLE;
        dispatchNextPhotoRequest();
    }

    private void notifyPhotoCaptured(String filePath) {
        notifyPhotoCaptured(filePath, true);
    }

    /**
     * @param waitForStillMetadata when {@code true}, briefly defer the {@code captured} callback to
     *     attach still-capture HAL metadata (single still path). HDR bursts have no {@link
     *     StillCaptureCallback} and never record that metadata, so they pass {@code false} to emit
     *     immediately instead of always hitting the {@link #CAPTURE_METADATA_WAIT_TIMEOUT_MS}
     *     timeout.
     */
    private void notifyPhotoCaptured(String filePath, boolean waitForStillMetadata) {
        long startMs = currentStartTimeMs();
        CameraNeoService.PhotoCaptureCallback callback =
                activeCapture != null ? activeCapture.callback : null;
        JSONObject metadataToSend;
        synchronized (captureMetadataLock) {
            if (photoCapturedCallbackSent) {
                return;
            }
            metadataToSend = pendingStillCaptureMetadata;
            if (metadataToSend == null) {
                if (waitForStillMetadata) {
                    if (pendingCapturedFilePath != null) {
                        if (!Objects.equals(pendingCapturedFilePath, filePath)) {
                            Log.w(
                                    TAG,
                                    "Ignoring duplicate photo captured callback while waiting for "
                                            + "metadata. pending="
                                            + pendingCapturedFilePath
                                            + " duplicate="
                                            + filePath);
                        }
                        return;
                    }
                    pendingCapturedFilePath = filePath;
                    pendingCapturedCallback = callback;
                    pendingCapturedStartTimeMs = startMs;
                    scheduleCaptureMetadataTimeoutLocked(filePath);
                    return;
                }
                // No still metadata is coming (e.g. HDR burst); emit immediately.
                photoCapturedCallbackSent = true;
            } else {
                pendingStillCaptureMetadata = null;
                photoCapturedCallbackSent = true;
            }
        }
        emitPhotoCaptured(filePath, metadataToSend, callback, startMs);
    }

    private void scheduleCaptureMetadataTimeoutLocked(String filePath) {
        if (pendingCaptureMetadataTimeout != null) {
            return;
        }
        Runnable timeout = () -> {
            CameraNeoService.PhotoCaptureCallback callback;
            long startMs;
            synchronized (captureMetadataLock) {
                if (!Objects.equals(pendingCapturedFilePath, filePath)
                        || photoCapturedCallbackSent) {
                    return;
                }
                callback = pendingCapturedCallback;
                startMs = pendingCapturedStartTimeMs;
                pendingCapturedFilePath = null;
                pendingCapturedCallback = null;
                pendingCapturedStartTimeMs = 0L;
                pendingCaptureMetadataTimeout = null;
                photoCapturedCallbackSent = true;
            }
            Log.w(
                    TAG,
                    "Still capture metadata was not available within "
                            + CAPTURE_METADATA_WAIT_TIMEOUT_MS
                            + "ms; emitting captured status without captureMetadata");
            emitPhotoCaptured(filePath, null, callback, startMs);
        };
        pendingCaptureMetadataTimeout = timeout;

        Handler h = hooks.backgroundHandler();
        if (h != null) {
            h.postDelayed(timeout, CAPTURE_METADATA_WAIT_TIMEOUT_MS);
        } else {
            timeout.run();
        }
    }

    private void recordStillCaptureMetadata(long captureGeneration, JSONObject captureMetadata) {
        String filePathToNotify = null;
        CameraNeoService.PhotoCaptureCallback callback = null;
        long startMs = 0L;
        Runnable timeoutToCancel = null;

        synchronized (captureMetadataLock) {
            if (captureGeneration != captureMetadataGeneration) {
                // Late completion from a previous shot; do not attach to the current photo.
                Log.w(
                        TAG,
                        "Ignoring stale still capture metadata from a previous shot (gen "
                                + captureGeneration
                                + " != "
                                + captureMetadataGeneration
                                + ")");
                return;
            }
            if (photoCapturedCallbackSent) {
                return;
            }
            if (pendingCapturedFilePath == null) {
                pendingStillCaptureMetadata = captureMetadata;
                return;
            }
            filePathToNotify = pendingCapturedFilePath;
            callback = pendingCapturedCallback;
            startMs = pendingCapturedStartTimeMs;
            timeoutToCancel = pendingCaptureMetadataTimeout;
            pendingCapturedFilePath = null;
            pendingCapturedCallback = null;
            pendingCapturedStartTimeMs = 0L;
            pendingCaptureMetadataTimeout = null;
            pendingStillCaptureMetadata = null;
            photoCapturedCallbackSent = true;
        }

        if (timeoutToCancel != null) {
            Handler h = hooks.backgroundHandler();
            if (h != null) {
                h.removeCallbacks(timeoutToCancel);
            }
        }
        emitPhotoCaptured(filePathToNotify, captureMetadata, callback, startMs);
    }

    private void notifyPhotoError(String errorMessage) {
        resetCaptureMetadataState();
        CameraNeoService.PhotoCaptureCallback callback =
                activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            hooks.executor().execute(() -> callback.onPhotoError(errorMessage));
        }
    }

    private static void putIfNotNull(JSONObject json, String key, Object value) throws JSONException {
        if (value != null) {
            json.put(key, value);
        }
    }

    @Nullable
    private JSONObject rangeToJson(@Nullable Range<Integer> range) throws JSONException {
        if (range == null) {
            return null;
        }
        JSONObject json = new JSONObject();
        json.put("min", range.getLower());
        json.put("max", range.getUpper());
        return json;
    }

    @Nullable
    private JSONObject buildMeteredPreview() throws JSONException {
        JSONObject metered = new JSONObject();
        putIfNotNull(metered, "iso", mLastMeteredIso);
        putIfNotNull(metered, "exposureTimeNs", mLastMeteredExposureNs);
        if (mLastMeteredIso != null && mLastMeteredExposureNs != null) {
            metered.put("totalLightProxy",
                    (mLastMeteredExposureNs / 1_000_000.0) * mLastMeteredIso.doubleValue());
        }
        return metered.length() > 0 ? metered : null;
    }

    @Nullable
    private JSONObject buildRequestedCaptureConfig(CaptureRequest captureRequest, boolean useManual) throws JSONException {
        if (captureRequest == null) {
            return null;
        }
        JSONObject requested = new JSONObject();
        requested.put("manual", useManual);
        putIfNotNull(requested, "exposureTimeNs", captureRequest.get(CaptureRequest.SENSOR_EXPOSURE_TIME));
        putIfNotNull(requested, "iso", captureRequest.get(CaptureRequest.SENSOR_SENSITIVITY));
        putIfNotNull(requested, "frameDurationNs", captureRequest.get(CaptureRequest.SENSOR_FRAME_DURATION));
        putIfNotNull(requested, "aeMode", captureRequest.get(CaptureRequest.CONTROL_AE_MODE));
        putIfNotNull(requested, "aeLock", captureRequest.get(CaptureRequest.CONTROL_AE_LOCK));
        putIfNotNull(requested, "aeExposureCompensation",
                captureRequest.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION));
        putIfNotNull(requested, "noiseReductionMode", captureRequest.get(CaptureRequest.NOISE_REDUCTION_MODE));
        putIfNotNull(requested, "edgeMode", captureRequest.get(CaptureRequest.EDGE_MODE));
        putIfNotNull(requested, "afMode", captureRequest.get(CaptureRequest.CONTROL_AF_MODE));
        putIfNotNull(requested, "zsl", captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL));
        JSONObject fpsRange = rangeToJson(captureRequest.get(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE));
        if (fpsRange != null) {
            requested.put("aeTargetFpsRange", fpsRange);
        }
        if (jpegSize != null) {
            requested.put("width", jpegSize.getWidth());
            requested.put("height", jpegSize.getHeight());
        }
        currentCaptureSettings().appendWarningsTo(requested);
        return requested;
    }

    private void notifyPhotoCapturing(
            @Nullable JSONObject requestedCaptureConfig,
            @Nullable JSONObject meteredPreview) {
        CameraNeoService.PhotoCaptureCallback callback = activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            hooks.executor().execute(() -> callback.onPhotoCapturing(requestedCaptureConfig, meteredPreview));
        }
    }

    private void notifyCurrentPhotoConfigured() {
        Size size = jpegSize();
        if (size != null) {
            notifyPhotoConfigured(size, previewJpegQuality());
        }
    }

    public void notifyPhotoConfigured(Size size, int jpegQuality) {
        CameraNeoService.PhotoCaptureCallback callback = activeCapture != null ? activeCapture.callback : null;
        if (callback == null || size == null) {
            return;
        }

        try {
            JSONObject resolvedConfig = new JSONObject();
            resolvedConfig.put("format", "jpeg");
            resolvedConfig.put("width", size.getWidth());
            resolvedConfig.put("height", size.getHeight());
            resolvedConfig.put("quality", jpegQuality);

            String requestedSize = currentSize();
            if (requestedSize != null) {
                resolvedConfig.put("requestedSize", requestedSize);
            }
            resolvedConfig.put("source", currentIsFromSdk() ? "sdk" : "button");

            Long exposureTimeNs = currentExposureTimeNs();
            if (exposureTimeNs != null) {
                resolvedConfig.put("exposureTimeNs", exposureTimeNs);
            }

            Integer iso = currentIso();
            if (iso != null) {
                resolvedConfig.put("iso", iso);
            }

            currentCaptureSettings().appendWarningsTo(resolvedConfig);

            hooks.executor().execute(() -> callback.onPhotoConfigured(resolvedConfig));
        } catch (JSONException e) {
            Log.e(TAG, "Error building resolved photo config", e);
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

            Handler backgroundHandler = hooks.backgroundHandler();
            if (backgroundHandler == null || hooks.coordinator().device() == null) {
                Log.e(TAG, "Camera handler or device not ready in startPreviewWithAeMonitoring");
                notifyPhotoError("Camera handler not ready");
                hooks.closeCamera();
                hooks.stopService();
                return;
            }

            CaptureRequest previewRequest = hooks.previewBuilder().build();
            Boolean zslInPreview = previewRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            if (zslInPreview != null && zslInPreview) {
                Log.d(
                        TAG,
                        "✓ ZSL verified in preview request: CONTROL_ENABLE_ZSL = true (buffer"
                                + " filling)");
            } else {
                Log.w(TAG, "⚠ ZSL NOT enabled in preview request - ZSL buffer will not fill!");
            }

            activeSession.setRepeatingRequest(previewRequest, aeCallback, backgroundHandler);

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
                Log.i(
                        TAG,
                        "Manual exposure (exposureTimeNs="
                                + currentExposureTimeNs()
                                + "): skipping AE convergence");
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

            boolean zslEnabled =
                    (hooks.cameraSettings() != null
                            && hooks.cameraSettings().isZslSupported()
                            && hooks.cameraSettings().mAsgSettings.isZslEnabled());

            Log.d(TAG, "🔍 DIAGNOSTIC: startPrecaptureSequence() called");
            Log.d(TAG, "🔍 ZSL enabled: " + zslEnabled);
            Log.d(TAG, "🔍 Current shot state: " + shotState);
            Log.d(
                    TAG,
                    "🔍 Waiting for AE convergence: " + aeStateMachine.waitingForAeConvergence());

            Log.d(TAG, "Starting AE convergence (monitoring via repeating request callback)...");
            Log.d(
                    TAG,
                    "🔍 XyCamera2 MODE: No precapture trigger - monitoring AE via repeating request"
                            + " callback");

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
        Handler backgroundHandler = hooks.backgroundHandler();
        if (backgroundHandler == null || hooks.coordinator().device() == null) {
            Log.w(TAG, "Cannot restore AE preview: camera handler or device not ready");
            return;
        }
        // A late still/HDR completion can run after a new photo has entered precapture; do not
        // clear AE wait flags in that case or the repeating callback will ignore convergence
        // forever.
        boolean clearAeWait =
                shotState != AeStateMachine.ShotState.WAITING_AE
                        && shotState != AeStateMachine.ShotState.WAITING_AE_LOCK;
        AePreviewController.restorePreview(
                session,
                true,
                hooks.previewBuilder(),
                aeCallback,
                backgroundHandler,
                hooks.cameraSettings(),
                aeStateMachine,
                clearAeWait);
    }

    private boolean shouldUseManualExposure() {
        if (shouldUseScanExposure()) {
            return true;
        }
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
            Log.w(
                    TAG,
                    "Manual exposure requested but MANUAL_SENSOR not supported; using auto"
                            + " exposure");
            decision = false;
            reason = "MANUAL_SENSOR unsupported";
        } else if (expRange == null || isoRange == null) {
            Log.w(
                    TAG,
                    "Manual exposure requested but sensor ranges unavailable; using auto exposure");
            decision = false;
            reason = "sensor ranges null";
        } else {
            decision = true;
            reason = "manual path engaged";
        }
        try {
            CameraDiagnosticsLog.manualExposureDecision(
                    decision, reason, exposureNs, manualSupported);
        } catch (Throwable t) {
            /* never let logging crash capture */
        }
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
        if (caps.sensorExposureTimeRange == null || caps.sensorSensitivityRange == null) {
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
        Integer requestedIso = currentIso();
        Integer last = mLastMeteredIso;
        Long meteredExposureNs = mLastMeteredExposureNs;
        CameraCapabilities caps = hooks.capabilities();
        Range<Integer> isoRange = (caps != null) ? caps.sensorSensitivityRange : null;

        if (requestedIso != null && requestedIso > 0) {
            int clampedIso = requestedIso;
            if (isoRange != null) {
                clampedIso =
                        Math.max(isoRange.getLower(), Math.min(isoRange.getUpper(), clampedIso));
            }
            Log.i(
                    TAG,
                    "Using requested manual ISO "
                            + clampedIso
                            + " for still capture (requested="
                            + requestedIso
                            + ")");
            return clampedIso;
        }

        int isoBeforeScale =
                (last != null && last > 0) ? last.intValue() : ManualExposurePolicy.DEFAULT_ISO;
        double evScaleApplied = 1.0;
        int isoAfterScale = isoBeforeScale;
        if (meteredExposureNs != null
                && meteredExposureNs > 0
                && targetExposureNs > 0
                && isoBeforeScale > 0) {
            evScaleApplied = (double) meteredExposureNs / (double) targetExposureNs;
            isoAfterScale = (int) Math.round(isoBeforeScale * evScaleApplied);
        }

        int iso =
                ManualExposurePolicy.pickSensitivityForManualCapture(
                        targetExposureNs, last, meteredExposureNs, isoRange);

        PhotoCaptureSettings settings = currentCaptureSettings();
        if (settings.isoCap != null && settings.isoCap > 0) {
            iso = Math.min(iso, settings.isoCap);
            if (isoRange != null) {
                iso = Math.max(isoRange.getLower(), Math.min(isoRange.getUpper(), iso));
            }
        }

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
        } catch (Throwable t) {
            /* never let logging crash capture */
        }
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

        boolean hdrEnabled =
                hooks.cameraSettings() != null
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
            String imuStartPath = (currentFilePath() != null) ? currentFilePath() : listenerFallbackPhotoPath;
            imu.startRecording(imuStartPath);

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
                Log.i(
                        TAG,
                        "Using manual exposure time for still capture: SENSOR_EXPOSURE_TIME="
                                + manualClampedNs
                                + " ns, SENSOR_SENSITIVITY="
                                + manualIso
                                + ", SENSOR_FRAME_DURATION="
                                + manualFrameDurationNs
                                + " (requestedNs="
                                + requestedExposureNs
                                + ", requestedIso="
                                + (currentIso() != null ? currentIso() : "auto")
                                + "; AE disabled; ZSL/MFNR vendor path skipped)");
            } else {
                Log.d(TAG, "Using auto exposure / AE lock path");
            }

            int displayOrientation = hooks.displayRotation();
            int jpegOrientation =
                    JpegOrientationResolver.lookupJpegOrientation(
                            displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);

            PhotoCaptureSettings captureSettings = currentCaptureSettings();
            boolean edgeEnhancementEnabled = captureSettings.edgeEnhancementEnabled();

            StillCaptureBuilder.configure(
                    StillCaptureBuilder.wrap(stillBuilder),
                    useManual,
                    manualClampedNs,
                    manualIso,
                    manualFrameDurationNs,
                    hooks.userExposureCompensation(),
                    hooks.selectedFpsRange(),
                    hooks.hasAutoFocus(),
                    jpegSize,
                    getJpegQualityForSize(),
                    jpegOrientation,
                    edgeEnhancementEnabled);

            Log.d(
                    TAG,
                    "Capturing photo with JPEG orientation: "
                            + jpegOrientation
                            + " for display orientation: "
                            + displayOrientation);

            if (hooks.cameraSettings() != null) {
                Boolean requestMfnr =
                        captureSettings.mfnr != null ? captureSettings.mfnr : null;
                Boolean requestZsl = resolveRequestZsl(captureSettings);
                if (!useManual) {
                    if (requestMfnr != null || requestZsl != null) {
                        hooks.cameraSettings()
                                .configureCaptureBuilder(stillBuilder, requestMfnr, requestZsl);
                    } else if (hooks.cameraSettings().mAsgSettings.isZslEnabled()
                            || hooks.cameraSettings().mAsgSettings.isMfnrEnabled()) {
                        hooks.cameraSettings().configureCaptureBuilder(stillBuilder);
                    }
                } else if ((requestMfnr != null && !requestMfnr)
                        || (requestZsl != null && !requestZsl)) {
                    hooks.cameraSettings()
                            .configureCaptureBuilder(
                                    stillBuilder,
                                    requestMfnr != null ? requestMfnr : false,
                                    requestZsl != null ? requestZsl : false);
                }
            }

            CaptureRequest captureRequest = stillBuilder.build();

            Boolean zslInCapture = captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            if (zslInCapture != null && zslInCapture) {
                Log.d(TAG, "✓ ZSL verified in capture request: CONTROL_ENABLE_ZSL = true");
            } else {
                Log.w(
                        TAG,
                        "⚠ ZSL NOT enabled in capture request (CONTROL_ENABLE_ZSL = "
                                + zslInCapture
                                + ")");
            }

            Boolean requestMfnrForLog =
                    captureSettings.mfnr != null ? captureSettings.mfnr : null;
            Boolean requestZslForLog = resolveRequestZsl(captureSettings);
            boolean globalMfnr =
                    hooks.cameraSettings() != null
                            && hooks.cameraSettings().mAsgSettings.isMfnrEnabled();
            boolean globalZsl =
                    hooks.cameraSettings() != null
                            && hooks.cameraSettings().mAsgSettings.isZslEnabled();
            PhotoCaptureSettings.logAppliedAtCapture(
                    currentFilePath() != null ? currentFilePath() : "unknown",
                    captureSettings,
                    useManual,
                    mLastMeteredExposureNs,
                    useManual
                            ? Long.valueOf(manualClampedNs)
                            : currentExposureTimeNs(),
                    useManual
                            ? manualIso
                            : captureRequest.get(CaptureRequest.SENSOR_SENSITIVITY),
                    requestMfnrForLog,
                    requestZslForLog,
                    globalMfnr,
                    globalZsl);

            if (useManual) {
                Log.i(
                        TAG,
                        "📸 SHOT firing: MANUAL exposureTimeNs="
                                + manualClampedNs
                                + " (requested="
                                + requestedExposureNs
                                + ") iso="
                                + manualIso
                                + " frameDurationNs="
                                + manualFrameDurationNs);
            } else {
                Log.i(TAG, "📸 SHOT firing: AUTO — " + describeAutoExposureStillPath());
            }

            JSONObject requestedCaptureConfig = null;
            JSONObject meteredPreview = null;
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
                Range<Integer> reqFps =
                        captureRequest.get(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE);
                Integer reqExpComp =
                        captureRequest.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION);
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
                requestedCaptureConfig = buildRequestedCaptureConfig(captureRequest, useManual);
                meteredPreview = buildMeteredPreview();
            } catch (Throwable t) {
                /* never let logging crash capture */
            }

            notifyPhotoCapturing(requestedCaptureConfig, meteredPreview);
            final long captureGeneration;
            synchronized (captureMetadataLock) {
                captureGeneration = captureMetadataGeneration;
            }
            activeSession.capture(
                    captureRequest,
                    new StillCaptureCallback(
                            new StillCaptureCallback.Hooks() {
                                @Override
                                public void recordStillSensorTimestampNs(Long timestampNs) {
                                    mLastStillSensorTimestampNs = timestampNs;
                                }

                                @Override
                                public void recordCaptureMetadata(JSONObject captureMetadata) {
                                    if (captureMetadata != null) {
                                        currentCaptureSettings().appendWarningsTo(captureMetadata);
                                    }
                                    recordStillCaptureMetadata(captureGeneration, captureMetadata);
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
                            }),
                    hooks.backgroundHandler());

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
            String imuStartPath = (currentFilePath() != null) ? currentFilePath() : listenerFallbackPhotoPath;
            imu.startRecording(imuStartPath);

            Log.i(
                    TAG,
                    "HDR: Starting burst capture with brackets "
                            + java.util.Arrays.toString(HdrBurstBuilder.HDR_EV_BRACKETS));

            int displayOrientation = hooks.displayRotation();
            int jpegOrientation =
                    JpegOrientationResolver.lookupJpegOrientation(
                            displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);
            int jpegQuality = getJpegQualityForSize();

            hdrBurstCapture.start(
                    hooks.coordinator().session(),
                    hooks.coordinator().device(),
                    imageReaders.getStillSurface(),
                    hooks.backgroundHandler(),
                    hooks.selectedFpsRange(),
                    hooks.hasAutoFocus(),
                    jpegQuality,
                    jpegOrientation,
                    hooks.cameraSettings(),
                    new HdrBurstCapture.Callback() {
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

    /** Immutable snapshot of camera pipeline parameters for burst reuse decisions. */
    private static final class ConfiguredCameraConfig {
        @Nullable final String size;
        final boolean isFromSdk;
        @Nullable final Long exposureTimeNs;

        ConfiguredCameraConfig(
                @Nullable String size, boolean isFromSdk, @Nullable Long exposureTimeNs) {
            this.size = size;
            this.isFromSdk = isFromSdk;
            this.exposureTimeNs = exposureTimeNs;
        }

        static ConfiguredCameraConfig from(QueuedPhotoRequest request) {
            return new ConfiguredCameraConfig(
                    request.size, request.isFromSdk, request.exposureTimeNs);
        }

        static ConfiguredCameraConfig from(ActivePhotoCapture request) {
            return new ConfiguredCameraConfig(
                    request.size, request.isFromSdk, request.exposureTimeNs);
        }

        boolean differsFrom(QueuedPhotoRequest request) {
            return differsFrom(request.size, request.isFromSdk, request.exposureTimeNs);
        }

        boolean differsFrom(
                @Nullable String otherSize,
                boolean otherIsFromSdk,
                @Nullable Long otherExposureTimeNs) {
            if (!Objects.equals(size, otherSize)) {
                return true;
            }
            if (isFromSdk != otherIsFromSdk) {
                return true;
            }
            return !Objects.equals(exposureTimeNs, otherExposureTimeNs);
        }
    }

    /** Service-level bridge for threading, wake, camera open, and shared builders. */
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
