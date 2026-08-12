package com.mentra.asg_client.camera.lifecycle;

import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.util.Range;
import android.util.Size;

import androidx.annotation.Nullable;

import com.mentra.asg_client.camera.CameraConstants;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.diagnostics.CameraDiagnosticsLog;
import com.mentra.asg_client.camera.model.ActivePhotoCapture;
import com.mentra.asg_client.camera.model.CameraOperationError;
import com.mentra.asg_client.camera.model.CapturedPhoto;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.camera.model.QueuedPhotoRequest;
import com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import com.mentra.asg_client.camera.policy.CameraCapabilities;
import com.mentra.asg_client.camera.policy.JpegOrientationResolver;
import com.mentra.asg_client.camera.policy.ManualExposurePolicy;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;
import com.mentra.asg_client.camera.request.AeCaptureCallback;
import com.mentra.asg_client.camera.request.AePreviewController;
import com.mentra.asg_client.camera.request.HdrBurstBuilder;
import com.mentra.asg_client.camera.request.StillCaptureBuilder;
import com.mentra.asg_client.camera.request.StillCaptureCallback;
import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;
import com.mentra.asg_client.sensors.ImuRecorder;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

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

    /**
     * When non-null, the open session is being held "warm" (ISP/sensor powered, preview running)
     * for a {@code camera_warm_up} request rather than captured. The session is configured exactly
     * as a same-size SDK photo would be (so {@link #willReuseConfiguredCamera} returns true) but
     * the precapture/still path is never run — the camera parks at IDLE under the keep-alive timer.
     */
    @Nullable private volatile WarmUpRequest warmUpRequest;

    /**
     * Set when a photo is dispatched: {@code true} if the open HAL session was reused (kept-alive /
     * warm-up lease / prior shot) without close+reopen; {@code false} if this request paid a cold
     * open or reconfiguration. Logged at shutter so warm/cold is visible at the actual capture
     * moment, not only at BLE accept time.
     */
    private volatile boolean mCaptureDispatchedAsWarmReuse;

    private volatile Integer mLastMeteredIso;
    private volatile Long mLastMeteredExposureNs;
    private volatile Long mLastStillSensorTimestampNs;

    /** Wall-clock of last still {@code onCaptureCompleted}; used for ImageReader delivery lag. */
    private volatile long mLastStillCaptureCompletedWallMs;

    private volatile long mStillShutterSubmittedWallMs;
    private volatile long mStillShutterSubmittedElapsedNs;
    private volatile long mStillRequestedExposureNs;
    private volatile int mStillRequestedNrMode = -1;
    private volatile boolean mStillZslRequested;
    private volatile boolean mStillMfnrRequested;
    private volatile boolean mStillPreviewZslEnabled;
    @Nullable private volatile Boolean mStillControlEnableZsl;
    private volatile boolean mStillHalStartedLogged;
    private volatile long mStillHalStartedWallMs;

    /**
     * ImageReader already wrote estimated shutter→JPEG phases; ignore late HAL phase rows so they
     * don't land after storage steps.
     */
    private volatile boolean mStillTimingFinalizedByImageReader;

    /** Dedicated looper so HAL CaptureCallbacks are not queued behind ImageReader JPEG work. */
    @Nullable private HandlerThread stillCaptureCallbackThread;

    @Nullable private Handler stillCaptureCallbackHandler;

    private final HdrBurstCapture hdrBurstCapture = new HdrBurstCapture();

    /** True from HDR dispatch through its terminal frame/error, including late JPEG delivery. */
    private volatile boolean mCurrentShotUsesHdrBurst;

    /**
     * Background writer for deferred-persistence captures ({@link
     * ActivePhotoCapture#deferDiskWrite}). Single thread keeps writes ordered; daemon so it never
     * blocks process exit. Created lazily — classic captures never spin it up.
     */
    @Nullable private volatile ExecutorService persistenceExecutor;

    private final Object captureMetadataLock = new Object();
    @Nullable private JSONObject pendingStillCaptureMetadata;
    @Nullable private String pendingCapturedFilePath;
    @Nullable private CameraNeoService.PhotoCaptureCallback pendingCapturedCallback;
    @Nullable private CapturedPhoto pendingCapturedPhoto;
    private long pendingCapturedStartTimeMs;
    @Nullable private Runnable pendingCaptureMetadataTimeout;
    private boolean photoCapturedCallbackSent;

    /**
     * Bumped every time capture metadata state is reset (i.e. a new shot begins). A {@link
     * StillCaptureCallback} captures the generation in flight when it is created; a late {@code
     * onCaptureCompleted} from a previous shot is then dropped instead of being attached to the
     * next photo's {@code captured} status/callback.
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
                                                aeStateMachine,
                                                previewZslEnabled());
                                if (lockRequested) {
                                    shotState = AeStateMachine.ShotState.WAITING_AE_LOCK;
                                } else {
                                    capturePhoto();
                                }
                            }

                            @Override
                            public void capturePhoto() {
                                PhotoSession.this.onAeReadyForActiveRequest();
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
        return activeCapture != null ? activeCapture.captureSettings : PhotoCaptureSettings.EMPTY;
    }

    /**
     * Resolved ZSL for the active request. When the request omits {@code zsl}, inherit the global
     * default so EMPTY/unmerged settings stay default-on. ZSL and MFNR are independent capabilities
     * — ZSL being off should not be implied by MFNR being off, as ZSL reduces shutter lag
     * regardless of multi-frame processing.
     */
    private boolean resolveZslForCapture() {
        PhotoCaptureSettings settings = currentCaptureSettings();
        if (settings != null && settings.zsl != null) {
            return settings.zslEnabled();
        }
        return hooks.cameraSettings() != null && hooks.cameraSettings().mAsgSettings.isZslEnabled();
    }

    /**
     * Resolved MFNR for the active request. When the request omits {@code mfnr}, inherit the global
     * default.
     */
    private boolean resolveMfnrForCapture() {
        PhotoCaptureSettings settings = currentCaptureSettings();
        if (settings != null && settings.mfnr != null) {
            return settings.mfnrEnabled();
        }
        return hooks.cameraSettings() != null
                && hooks.cameraSettings().mAsgSettings.isMfnrEnabled();
    }

    /**
     * Preview ZSL buffering should match the pending capture: arm when either ZSL or MFNR is
     * resolved on (MFNR needs the circular buffer).
     */
    public boolean previewZslEnabled() {
        return resolveZslForCapture() || resolveMfnrForCapture();
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
            configuredCameraConfig = configFrom(pr);
        }
    }

    private ConfiguredCameraConfig configFrom(QueuedPhotoRequest request) {
        return new ConfiguredCameraConfig(
                request.size,
                request.isFromSdk,
                request.exposureTimeNs,
                resolveZslForRequest(request.captureSettings),
                resolveMfnrForRequest(request.captureSettings));
    }

    private ConfiguredCameraConfig configFrom(ActivePhotoCapture request) {
        return new ConfiguredCameraConfig(
                request.size,
                request.isFromSdk,
                request.exposureTimeNs,
                resolveZslForRequest(request.captureSettings),
                resolveMfnrForRequest(request.captureSettings));
    }

    /**
     * Resolved ZSL for a request shape (queue / warm prediction). Omitted {@code zsl} inherits the
     * global default.
     */
    private boolean resolveZslForRequest(@Nullable PhotoCaptureSettings settings) {
        if (settings != null && settings.zsl != null) {
            return settings.zslEnabled();
        }
        return hooks.cameraSettings() != null && hooks.cameraSettings().mAsgSettings.isZslEnabled();
    }

    /**
     * Resolved MFNR for a request shape (queue / warm prediction). Omitted {@code mfnr} inherits
     * the global default.
     */
    private boolean resolveMfnrForRequest(@Nullable PhotoCaptureSettings settings) {
        if (settings != null && settings.mfnr != null) {
            return settings.mfnrEnabled();
        }
        return hooks.cameraSettings() != null
                && hooks.cameraSettings().mAsgSettings.isMfnrEnabled();
    }

    /** Clears the configured-camera snapshot when the HAL session is torn down. */
    public void onCameraClosed() {
        configuredCameraConfig = null;
        quitStillCaptureCallbackThread();
    }

    /** Releases the dedicated still-capture callback thread; safe to call repeatedly. */
    private void quitStillCaptureCallbackThread() {
        HandlerThread thread = stillCaptureCallbackThread;
        stillCaptureCallbackThread = null;
        stillCaptureCallbackHandler = null;
        if (thread != null) {
            thread.quitSafely();
        }
    }

    private int getJpegQualityForSize() {
        if (currentIsFromSdk()) {
            // Normalize so legacy tiers (small→low, large→high, full→max) map correctly.
            String size = PhotoSizeTier.normalizeCaptureSize(currentSize());
            if (size == null) {
                return CameraConstants.SDK_JPEG_QUALITY_MEDIUM;
            }
            if (shouldUseScanExposure()) {
                return CameraConstants.SDK_JPEG_QUALITY_MAX;
            }
            switch (size) {
                case CameraConstants.SIZE_LOW:
                    return CameraConstants.SDK_JPEG_QUALITY_SMALL;
                case CameraConstants.SIZE_HIGH:
                    return CameraConstants.SDK_JPEG_QUALITY_LARGE;
                case CameraConstants.SIZE_MAX:
                case CameraConstants.SIZE_TEXT:
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
     * Compares {@code request} to the active session camera config (size, SDK flag, exposure,
     * preview-ZSL buffering need). Uses {@link #configuredCameraConfig} when {@link #activeCapture}
     * was cleared after a shot. Must be called before {@link
     * #activateQueuedRequest(QueuedPhotoRequest)} mutates current state.
     *
     * <p>Still ZSL/MFNR flags are applied per capture on the still builder; only the preview
     * circular buffer ({@code zsl || mfnr}) requires a session reopen when the request needs it and
     * the open session does not have it.
     */
    private boolean needsReconfigurationForQueued(QueuedPhotoRequest request) {
        if (request == null) {
            return true;
        }
        ConfiguredCameraConfig baseline = configuredCameraConfig;
        if (baseline == null && activeCapture != null) {
            baseline = configFrom(activeCapture);
        }
        if (baseline == null) {
            return false;
        }
        boolean reqZsl = resolveZslForRequest(request.captureSettings);
        boolean reqMfnr = resolveMfnrForRequest(request.captureSettings);
        return baseline.differsFrom(
                request.size, request.isFromSdk, request.exposureTimeNs, reqZsl, reqMfnr);
    }

    /**
     * Predicts whether a photo with the given parameters would reuse the currently configured HAL
     * session (a "warm" capture) instead of triggering a close + reopen reconfiguration.
     *
     * <p>The camera is reconfigured (and therefore effectively cold) when the requested size, SDK
     * flag, or manual exposure differs, or when the request needs preview-ZSL buffering ({@code zsl
     * || mfnr}) that the open session does not have — see {@link #needsReconfigurationForQueued}.
     * Per-shot ZSL/MFNR toggles that keep the same preview buffering do <em>not</em> force a
     * reopen. When there is no configured baseline (camera never opened or already torn down) this
     * returns {@code false}: a fresh open is a cold start.
     *
     * <p>When {@code captureSettings} is omitted, {@code zsl}/{@code mfnr} are resolved from the
     * global defaults (same as {@link PhotoCaptureSettings#EMPTY}).
     *
     * @return true if a capture with these params would reuse the open session, false otherwise.
     */
    public boolean willReuseConfiguredCamera(
            @Nullable String size, boolean isFromSdk, @Nullable Long exposureTimeNs) {
        return willReuseConfiguredCamera(size, isFromSdk, exposureTimeNs, null);
    }

    public boolean willReuseConfiguredCamera(
            @Nullable String size,
            boolean isFromSdk,
            @Nullable Long exposureTimeNs,
            @Nullable PhotoCaptureSettings captureSettings) {
        ConfiguredCameraConfig baseline = configuredCameraConfig;
        if (baseline == null && activeCapture != null) {
            baseline = configFrom(activeCapture);
        }
        if (baseline == null) {
            return false;
        }
        return !baseline.differsFrom(
                size,
                isFromSdk,
                exposureTimeNs,
                resolveZslForRequest(captureSettings),
                resolveMfnrForRequest(captureSettings));
    }

    public void dispatchNextPhotoRequest() {
        synchronized (hooks.serviceLock()) {
            QueuedPhotoRequestQueue queue = QueuedPhotoRequestQueue.getInstance();
            if (queue.isEmpty()) {
                Log.d(TAG, "No photo requests in queue");
                // Warm-aware: if a camera_warm_up lease is still within its TTL, keep the camera
                // warm for the lease's remaining time instead of the short photo keep-alive, so a
                // take_photo taken inside the warm window doesn't shorten the reserved lease.
                hooks.startPostCaptureKeepAlive();
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
                    ConfiguredCameraConfig baseline = configuredCameraConfig;
                    Log.d(
                            TAG,
                            "Configured camera needs reconfiguration for "
                                    + firstRequest.requestId
                                    + " — routing through setupCameraForQueuedRequest");
                    recordCaptureSessionForTiming(
                            false,
                            firstRequest.size,
                            warmSessionReasonMismatch(baseline, firstRequest));
                    Log.d(
                            TAG,
                            "warm/capture config mismatch: "
                                    + describeConfigMismatch(baseline, firstRequest));
                    setupCameraForQueuedRequest(firstRequest);
                    return;
                }
                QueuedPhotoRequest request = queue.poll();
                if (request == null) {
                    hooks.startKeepAliveTimer();
                    return;
                }
                mCaptureDispatchedAsWarmReuse = true;
                Log.d(TAG, "Dispatching queued photo with configured camera: " + request.requestId);
                recordCaptureSessionForTiming(true, request.size, null);
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
                // Do not stamp "cold open" here — setupCameraForQueuedRequest decides whether the
                // keep-alive lease is still holding a reusable session.
                queue.attachRegistryCallback(firstRequest);
                setupCameraForQueuedRequest(firstRequest);
            }
        }
    }

    public void setupCameraForQueuedRequest(QueuedPhotoRequest request) {
        if (request == null) return;

        Log.i(TAG, "📸 PHOTO E2E: Starting photo request " + request.requestId);

        // Snapshot before activateQueuedRequest overwrites the warm baseline.
        ConfiguredCameraConfig priorConfig = configuredCameraConfig;
        boolean needsReopen = needsReconfigurationForQueued(request);

        activateQueuedRequest(request);

        if (hooks.coordinator().isCameraKeptAlive() && hooks.coordinator().device() != null) {
            Log.d(TAG, "Camera already open, checking if reconfiguration needed");

            if (needsReopen) {
                mCaptureDispatchedAsWarmReuse = false;
                Log.d(TAG, "Camera config changed (reconfiguration required), reopening camera");
                recordCaptureSessionForTiming(
                        false, request.size, warmSessionReasonMismatch(priorConfig, request));
                Log.d(
                        TAG,
                        "warm/capture config mismatch (reopen): "
                                + describeConfigMismatch(priorConfig, request));
                hooks.cancelKeepAliveTimer();
                hooks.closeCamera();
                hooks.openCameraInternal(request.filePath, false);
            } else {
                mCaptureDispatchedAsWarmReuse = true;
                Log.d(TAG, "Camera config unchanged, taking photo immediately");
                recordCaptureSessionForTiming(true, request.size, null);
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
            mCaptureDispatchedAsWarmReuse = false;
            boolean keptAlive = hooks.coordinator().isCameraKeptAlive();
            boolean deviceGone = hooks.coordinator().device() == null;
            boolean sessionGone = hooks.coordinator().session() == null;
            // No HAL to reuse: either warm-up never ran, or the warm lease already closed.
            String coldReason =
                    priorConfig != null
                            ? BlePhotoTimingLog.WarmSessionReason.LEASE_EXPIRED
                            : BlePhotoTimingLog.WarmSessionReason.NO_WARMUP;
            Log.d(
                    TAG,
                    "Opening camera for photo capture ("
                            + coldReason
                            + " deviceGone="
                            + deviceGone
                            + " sessionGone="
                            + sessionGone
                            + " keepAliveFlag="
                            + keptAlive
                            + " priorTier="
                            + (priorConfig != null ? priorConfig.size : "none")
                            + ")");
            recordCaptureSessionForTiming(false, request.size, coldReason);
            hooks.wakeUpScreen();
            hooks.openCameraInternal(request.filePath, false);
        }
    }

    // ----- Warm-up (open + configure + preview, no capture) -----

    /**
     * Whether the open HAL session is currently being held warm for a {@code camera_warm_up}
     * request (preview running, parked at IDLE, no capture in flight).
     */
    public boolean isWarmingUp() {
        return warmUpRequest != null;
    }

    /**
     * Drop an opening warm-up after its last owner cancels. CameraNeoService owns the terminal
     * callback and camera close so this method only clears PhotoSession state.
     */
    public boolean cancelWarmUp() {
        synchronized (hooks.serviceLock()) {
            if (warmUpRequest == null) {
                return false;
            }
            warmUpRequest = null;
            clearActiveCapture();
            // A warm-up waits for repeating-preview AE results before reporting ready. Cancel the
            // wait as part of the same critical section so a late preview callback cannot turn a
            // cancelled warm-up into a still capture.
            aeStateMachine.clearWaitFlags();
            shotState = AeStateMachine.ShotState.IDLE;
            return true;
        }
    }

    /** Cancel the active still capture and mark the session idle before camera teardown. */
    public boolean cancelActiveCapture(String errorMessage) {
        synchronized (hooks.serviceLock()) {
            if (activeCapture == null && shotState == AeStateMachine.ShotState.IDLE) {
                return false;
            }
            hdrBurstCapture.cancel();
            hooks.cancelImuRecording();
            aeStateMachine.clearWaitFlags();
            notifyPhotoError(errorMessage);
            clearActiveCapture();
            shotState = AeStateMachine.ShotState.IDLE;
            return true;
        }
    }

    /**
     * Prepare and hold the camera "warm" for {@code durationMs} without capturing a photo. The
     * session is opened/reused and configured with the SAME parameters a same-size SDK photo would
     * use ({@code isFromSdk=true}, the requested {@code size}, optional {@code exposureTimeNs}), so
     * a later {@code take_photo} of that size reuses the configured session — see {@link
     * #willReuseConfiguredCamera}. No precapture, still capture, shutter sound, or file is
     * produced.
     *
     * <p>If the camera is already configured and idle for the same params, only the keep-alive
     * timer is restarted (re-warming) and {@code onReady} fires immediately.
     *
     * @param size requested resolution tier (already normalized)
     * @param exposureTimeNs optional manual shutter (nanoseconds); {@code null} = auto
     * @param captureSettings per-request tuning (may be {@link PhotoCaptureSettings#EMPTY})
     * @param durationMs keep-alive TTL in milliseconds
     * @param onReady invoked once preview is running and AE has begun settling
     * @param onError invoked if the camera could not be warmed
     */
    public void setupWarmUp(
            @Nullable String size,
            @Nullable Long exposureTimeNs,
            @Nullable PhotoCaptureSettings captureSettings,
            long durationMs,
            Runnable onReady,
            java.util.function.Consumer<CameraOperationError> onError) {
        synchronized (hooks.serviceLock()) {
            // Serialize warm-ups: the camera is a single shared resource. If a capture is in
            // flight,
            // or another warm-up is still opening, reject with a retryable busy error rather than
            // racing or deferring. The caller retries — and since the camera is about to be warm
            // anyway, the retry usually hits the already-warm fast path. This keeps a single
            // warm-up
            // in flight at a time and avoids the concurrency hazards of overlapping/deferred
            // starts.
            if (isWarmingUp() || shotState != AeStateMachine.ShotState.IDLE) {
                Log.d(
                        TAG,
                        "camera_warm_up rejected — busy (warming="
                                + isWarmingUp()
                                + " state="
                                + shotState
                                + ")");
                if (onError != null) {
                    onError.accept(CameraOperationError.cameraBusy());
                }
                return;
            }

            WarmUpRequest req =
                    new WarmUpRequest(
                            size, exposureTimeNs, captureSettings, durationMs, onReady, onError);

            // Build a synthetic queued request so the open/configure path and the
            // configured-camera baseline match a same-size SDK photo exactly.
            QueuedPhotoRequest synthetic =
                    new QueuedPhotoRequest(
                            req.warmFilePath(),
                            size,
                            false, // enableLed: warm-up never pulses the privacy LED
                            true, // isFromSdk: matches the SDK take_photo sizing/quality path
                            exposureTimeNs,
                            null, // iso: only meaningful for manual still capture
                            captureSettings != null ? captureSettings : PhotoCaptureSettings.EMPTY,
                            null);

            boolean needsReopen = needsReconfigurationForQueued(synthetic);

            warmUpRequest = req;
            activateQueuedRequest(synthetic);

            if (hooks.coordinator().isCameraKeptAlive() && hooks.coordinator().device() != null) {
                if (needsReopen) {
                    Log.d(TAG, "camera_warm_up: config changed, reopening camera");
                    hooks.cancelKeepAliveTimer();
                    hooks.closeCamera();
                    hooks.openCameraInternal(synthetic.filePath, false);
                } else {
                    // Already configured + idle for these params: just re-arm keep-alive.
                    Log.d(TAG, "camera_warm_up: camera already warm, restarting keep-alive");
                    hooks.cancelKeepAliveTimer();
                    finishWarmUpReady();
                }
            } else {
                Log.d(TAG, "camera_warm_up: opening camera to warm");
                hooks.wakeUpScreen();
                hooks.openCameraInternal(synthetic.filePath, false);
            }
        }
    }

    /**
     * Dispatched once the AE-convergence wait ends (converged/stable, locked, or the {@link
     * AeStateMachine#AE_WAIT_MAX_NS} worst-case timeout) for whichever request is active — a real
     * photo, or a {@code camera_warm_up} lease. Warm-up finishes here instead of capturing, so its
     * {@code onReady} callback only fires once AE has actually settled.
     */
    private void onAeReadyForActiveRequest() {
        synchronized (hooks.serviceLock()) {
            if (warmUpRequest != null) {
                finishWarmUpReady();
                return;
            }
            if (activeCapture == null) {
                // Cancellation/close may race a preview result that already decided AE was ready.
                // With no warm-up or photo request left, the callback is stale and must not fire a
                // still capture or consume a newly queued request.
                aeStateMachine.clearWaitFlags();
                shotState = AeStateMachine.ShotState.IDLE;
                Log.d(TAG, "Ignoring stale AE-ready callback with no active capture");
                return;
            }
        }
        capturePhoto();
    }

    /**
     * Called once AE convergence finishes for an active {@code camera_warm_up} lease (see {@link
     * #onAeReadyForActiveRequest()}). Parks the session at IDLE under the warm keep-alive timer and
     * reports {@code ready}; no capture is started.
     */
    private void finishWarmUpReady() {
        WarmUpRequest req = warmUpRequest;
        // AE has settled (or hit the worst-case timeout) — no capture is in flight.
        shotState = AeStateMachine.ShotState.IDLE;
        hooks.startWarmKeepAliveTimer(req != null ? req.durationMs : 0L);
        // The warm request is consumed once the camera is parked; the configured-camera baseline
        // (set by activateQueuedRequest) persists so a later take_photo reuses the session.
        clearActiveCapture();
        warmUpRequest = null;
        if (req != null && req.onReady != null) {
            hooks.executor().execute(req.onReady);
        }
        // A take_photo may have raced in while the camera was opening for warm-up; onConfigured
        // skips the queue poll during warm-up so it isn't dropped. Take it now on the freshly
        // warmed
        // session instead of stranding it on the queue until the lease expires.
        if (!QueuedPhotoRequestQueue.getInstance().isEmpty()) {
            dispatchNextPhotoRequest();
        }
    }

    private void failWarmUp(CameraOperationError error) {
        WarmUpRequest req = warmUpRequest;
        warmUpRequest = null;
        clearActiveCapture();
        if (req != null && req.onError != null) {
            hooks.executor().execute(() -> req.onError.accept(error));
        }
    }

    private void failWarmUpOrPhoto(String errorMessage) {
        failWarmUpOrPhoto(
                warmUpRequest != null
                        ? CameraOperationError.warmUpFailed(errorMessage)
                        : CameraOperationError.captureFailed(errorMessage));
    }

    private void failWarmUpOrPhoto(CameraOperationError error) {
        if (warmUpRequest != null) {
            failWarmUp(error);
        } else {
            notifyPhotoError(error);
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

        long imageAvailableStartMs = System.currentTimeMillis();
        long imageAvailableElapsedNs = SystemClock.elapsedRealtimeNanos();
        long halCompleteToImageMs =
                mLastStillCaptureCompletedWallMs > 0
                        ? imageAvailableStartMs - mLastStillCaptureCompletedWallMs
                        : -1L;
        Log.d(TAG, "Processing photo capture...");
        // HDR needs every bracket in capture order. acquireLatestImage() may discard an earlier
        // bracket when more than one JPEG is queued, leaving the three-frame burst permanently
        // incomplete and preventing its final-frame feedback callback.
        try (Image image = acquireStillImage(reader)) {
            int width = -1;
            int height = -1;
            long imgTs = -1L;
            try {
                if (image != null) {
                    width = image.getWidth();
                    height = image.getHeight();
                    imgTs = image.getTimestamp();
                }
                Long stillTs = mLastStillSensorTimestampNs;
                long deltaMs =
                        (stillTs != null && imgTs > 0) ? (stillTs - imgTs) / 1_000_000L : -1L;
                boolean match = (stillTs != null && imgTs > 0 && stillTs == imgTs);
                CameraDiagnosticsLog.savedFrameTimestampVsStill(imgTs, stillTs, match, deltaMs);
            } catch (Throwable t) {
                // Never let logging crash capture.
            }

            String frameDetail =
                    logStillShutterToImageBreakdown(
                            imageAvailableStartMs,
                            imageAvailableElapsedNs,
                            imgTs,
                            width,
                            height,
                            halCompleteToImageMs);
            BlePhotoTimingLog.capturePhase("still_frame_available", frameDetail);

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

            if (shouldNotifyPhotoFrameAvailable()) {
                notifyPhotoFrameAvailable(imgTs);
            }

            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            int remaining = buffer.remaining();
            byte[] bytes = new byte[remaining];
            buffer.get(bytes);
            BlePhotoTimingLog.capturePhase(
                    "still_buffer_extracted",
                    bytes.length
                            + " bytes ("
                            + String.format(java.util.Locale.US, "%.1f", bytes.length / 1024.0)
                            + "KB) copied in "
                            + (System.currentTimeMillis() - imageAvailableStartMs)
                            + "ms; routing captured bytes");

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

            ActivePhotoCapture capture = activeCapture;
            if (capture != null && capture.deferDiskWrite) {
                // RAM-first path: publish the bytes and fire the callback now. Saving, when
                // requested, happens in the background; save=false never persists the JPEG.
                handleDeferredPersistenceCapture(bytes, targetPath, capture.persistToDisk);
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

    @Nullable
    Image acquireStillImage(ImageReader reader) {
        return hdrBurstCapture.isActive()
                ? reader.acquireNextImage()
                : reader.acquireLatestImage();
    }

    /**
     * Splits shutter→ImageReader into queue / exposure / ISP+JPEG. Uses HAL callback marks when
     * they already arrived on the dedicated callback thread; otherwise estimates from {@link
     * Image#getTimestamp()} vs {@link SystemClock#elapsedRealtimeNanos()}.
     */
    private String logStillShutterToImageBreakdown(
            long imageAvailableWallMs,
            long imageAvailableElapsedNs,
            long imageSensorTimestampNs,
            int width,
            int height,
            long halCompleteToImageMs) {
        long submitWallMs = mStillShutterSubmittedWallMs;
        long shutterToImageMs =
                submitWallMs > 0 ? Math.max(0L, imageAvailableWallMs - submitWallMs) : -1L;
        long exposureBudgetMs =
                mStillRequestedExposureNs > 0
                        ? Math.max(1L, Math.round(mStillRequestedExposureNs / 1_000_000.0))
                        : 10L;
        boolean halStarted = mStillHalStartedLogged && mStillHalStartedWallMs > 0;
        boolean halCompleted = mLastStillCaptureCompletedWallMs > 0;

        long queueMs = -1L;
        long ispJpegMs = -1L;
        long sinceSensorStartMs = -1L;
        boolean estimated = false;
        String note;

        if (halStarted) {
            queueMs = Math.max(0L, mStillHalStartedWallMs - submitWallMs);
            if (halCompleted && mLastStillCaptureCompletedWallMs >= mStillHalStartedWallMs) {
                long startToComplete = mLastStillCaptureCompletedWallMs - mStillHalStartedWallMs;
                long ispAfterExposure = Math.max(0L, startToComplete - exposureBudgetMs);
                long completeToImage = halCompleteToImageMs >= 0 ? halCompleteToImageMs : 0L;
                ispJpegMs = ispAfterExposure + completeToImage;
                sinceSensorStartMs = startToComplete + completeToImage;
                note = "HAL callbacks arrived before ImageReader";
            } else {
                // ImageReader often beats onCaptureCompleted without ZSL/MFNR. Image.getTimestamp()
                // is not reliably elapsedRealtime on MTK — use wall-clock remainder instead.
                sinceSensorStartMs = Math.max(0L, shutterToImageMs - queueMs);
                ispJpegMs = Math.max(0L, sinceSensorStartMs - exposureBudgetMs);
                estimated = true;
                note =
                        halCompleted
                                ? "HAL start/complete marks inconsistent; wall-clock ISP/JPEG split"
                                : "HAL started; completed mark late — ISP/JPEG from wall-clock"
                                        + " remainder";
            }
        } else if (imageSensorTimestampNs > 0
                && mStillShutterSubmittedElapsedNs > 0
                && shutterToImageMs >= 0) {
            // Image.timestamp is normally the start of exposure (same timebase as elapsedRealtime).
            sinceSensorStartMs =
                    Math.max(0L, (imageAvailableElapsedNs - imageSensorTimestampNs) / 1_000_000L);
            if (sinceSensorStartMs > shutterToImageMs + 50) {
                // Timebase mismatch — fall back to wall-clock only.
                long sensorLagMs = sinceSensorStartMs;
                queueMs = 0L;
                sinceSensorStartMs = shutterToImageMs;
                ispJpegMs = Math.max(0L, shutterToImageMs - exposureBudgetMs);
                note =
                        "Image.timestamp timebase mismatch; falling back to wall-clock split"
                                + " (sensor_lag="
                                + sensorLagMs
                                + "ms vs shutter→image="
                                + shutterToImageMs
                                + "ms)";
            } else {
                queueMs = Math.max(0L, shutterToImageMs - sinceSensorStartMs);
                ispJpegMs = Math.max(0L, sinceSensorStartMs - exposureBudgetMs);
                note =
                        "ESTIMATED — HAL CaptureCallback marks missing/late at ImageReader"
                                + " (ZSL/MFNR often delivers JPEG before callbacks on shared"
                                + " handler; callbacks now use a dedicated thread)";
            }
            estimated = true;

            // Backfill phase rows so the main table shows the split with correct ΔSTEP values.
            long exposureStartWall = submitWallMs + queueMs;
            long exposureEndWall = exposureStartWall + exposureBudgetMs;
            BlePhotoTimingLog.capturePhaseAt(
                    "still_hal_started",
                    String.format(
                            java.util.Locale.US,
                            "ESTIMATED exposure start; submit→start=%dms; sensor_ts_ns=%d",
                            queueMs,
                            imageSensorTimestampNs),
                    exposureStartWall);
            BlePhotoTimingLog.capturePhaseAt(
                    "still_sensor_exposure_end",
                    String.format(
                            java.util.Locale.US,
                            "ESTIMATED shutter closed; exposure_budget=%dms; zsl_req=%s mfnr_req=%s"
                                    + " nr=%d",
                            exposureBudgetMs,
                            mStillZslRequested,
                            mStillMfnrRequested,
                            mStillRequestedNrMode),
                    exposureEndWall);
            mStillHalStartedLogged = true;
            mStillHalStartedWallMs = exposureStartWall;
            mStillTimingFinalizedByImageReader = true;
        } else {
            queueMs = 0L;
            ispJpegMs = Math.max(0L, shutterToImageMs - exposureBudgetMs);
            sinceSensorStartMs = shutterToImageMs;
            estimated = true;
            note = "no Image.timestamp / shutter marks; coarse wall-clock split only";
        }

        if (shutterToImageMs > 0 && queueMs >= 0 && ispJpegMs >= 0) {
            long maxIspMs = Math.max(0L, shutterToImageMs - queueMs - exposureBudgetMs);
            if (ispJpegMs > maxIspMs + 50) {
                ispJpegMs = maxIspMs;
                sinceSensorStartMs = Math.max(0L, shutterToImageMs - queueMs);
                estimated = true;
                note =
                        (note != null ? note + "; " : "")
                                + "ISP/JPEG clamped to shutter→ImageReader remainder ("
                                + maxIspMs
                                + "ms)";
            }
        }

        BlePhotoTimingLog.StillCaptureBreakdown breakdown =
                new BlePhotoTimingLog.StillCaptureBreakdown(
                        shutterToImageMs,
                        queueMs,
                        exposureBudgetMs,
                        ispJpegMs,
                        sinceSensorStartMs,
                        halStarted && halCompleted && !estimated,
                        estimated,
                        mStillZslRequested,
                        mStillMfnrRequested,
                        mStillPreviewZslEnabled,
                        mStillControlEnableZsl,
                        mStillRequestedNrMode,
                        note);
        BlePhotoTimingLog.recordStillCaptureBreakdown(breakdown);

        String sizePrefix = (width > 0 && height > 0) ? width + "x" + height + "; " : "";
        return String.format(
                java.util.Locale.US,
                "%ssubmit→ImageReader=%dms = queue=%dms + exposure=%dms + ISP/MFNR/JPEG=%dms"
                    + " (sensor→app=%dms); hal_complete→image=%s; zsl_req=%s mfnr_req=%s nr=%d; %s;"
                    + " starting buffer extraction",
                sizePrefix,
                shutterToImageMs,
                queueMs,
                exposureBudgetMs,
                ispJpegMs,
                sinceSensorStartMs,
                halCompleteToImageMs >= 0 ? halCompleteToImageMs + "ms" : "n/a",
                mStillZslRequested,
                mStillMfnrRequested,
                mStillRequestedNrMode,
                estimated ? "ESTIMATED" : "HAL-measured");
    }

    private Handler stillCaptureCallbackHandler() {
        if (stillCaptureCallbackHandler == null) {
            stillCaptureCallbackThread = new HandlerThread("StillCaptureCb");
            stillCaptureCallbackThread.start();
            stillCaptureCallbackHandler = new Handler(stillCaptureCallbackThread.getLooper());
        }
        return stillCaptureCallbackHandler;
    }

    private void finishImuRecording(String photoPath) {
        ImuRecorder imu = hooks.imuRecorderOrNull();
        if (imu == null) {
            BlePhotoTimingLog.capturePhase(
                    "still_imu_metadata_done", "no IMU metadata writer; capture file is ready");
            return;
        }
        long imuStartMs = System.currentTimeMillis();
        JSONObject payload = imu.stopRecordingAndBuildPayload();
        if (payload == null || payload.optInt("sampleCount", 0) <= 0) {
            BlePhotoTimingLog.capturePhase(
                    "still_imu_metadata_done",
                    "IMU metadata unavailable; file finalization took "
                            + (System.currentTimeMillis() - imuStartMs)
                            + "ms");
            return;
        }
        writeImuArtifacts(photoPath, payload, imu);
    }

    /** Writes IMU EXIF + sidecar for an already-assembled payload. Safe to run off-thread. */
    private void writeImuArtifacts(String photoPath, JSONObject payload, ImuRecorder imu) {
        long imuStartMs = System.currentTimeMillis();
        try {
            PhotoExifMetadataWriter.writeImuPayload(photoPath, payload);
            BlePhotoTimingLog.event(
                    "CAPTURE STORAGE",
                    "IMU EXIF write completed in "
                            + (System.currentTimeMillis() - imuStartMs)
                            + "ms");
        } catch (IOException e) {
            Log.w(TAG, "Failed to write IMU EXIF on photo: " + photoPath, e);
        }
        long sidecarStartMs = System.currentTimeMillis();
        String imuPath = imu.writeSidecar(photoPath, payload);
        if (imuPath != null) {
            Log.d(TAG, "IMU sidecar saved: " + imuPath);
        }
        BlePhotoTimingLog.capturePhase(
                "still_imu_metadata_done",
                "IMU sidecar write completed in "
                        + (System.currentTimeMillis() - sidecarStartMs)
                        + "ms; total metadata finalization="
                        + (System.currentTimeMillis() - imuStartMs)
                        + "ms");
    }

    /**
     * Deferred-persistence capture ({@link ActivePhotoCapture#deferDiskWrite}): stop the IMU
     * recorder and assemble its payload in memory, then fire {@code onPhotoCaptured} with the
     * complete capture attached. When persistence is requested, the JPEG + EXIF + IMU-sidecar write
     * runs on the background executor; otherwise no capture artifact is created.
     */
    private void handleDeferredPersistenceCapture(
            byte[] bytes, String targetPath, boolean persistToDisk) {
        ImuRecorder imu = hooks.imuRecorderOrNull();
        JSONObject payload = imu != null ? imu.stopRecordingAndBuildPayload() : null;
        if (payload != null && payload.optInt("sampleCount", 0) <= 0) {
            payload = null;
        }
        final JSONObject imuPayload = payload;
        final JSONObject callbackImuPayload = copyJsonPayload(imuPayload);
        Future<Boolean> persistence;
        if (persistToDisk) {
            persistence =
                    persistenceExecutor()
                            .submit(
                                    () -> {
                                        boolean ok = saveImageDataToFile(bytes, targetPath);
                                        if (!ok) {
                                            Log.e(
                                                    TAG,
                                                    "Deferred photo persistence failed: "
                                                            + targetPath);
                                            return false;
                                        }
                                        if (imuPayload != null && imu != null) {
                                            writeImuArtifacts(targetPath, imuPayload, imu);
                                        }
                                        Log.d(TAG, "Deferred photo persisted: " + targetPath);
                                        return true;
                                    });
        } else {
            persistence = CompletableFuture.completedFuture(false);
            Log.d(TAG, "RAM-only photo capture; persistence skipped: " + targetPath);
        }
        notifyPhotoCaptured(targetPath, new CapturedPhoto(bytes, callbackImuPayload, persistence));
    }

    /** Isolates the callback/encoder from the mutable payload used by background persistence. */
    @Nullable
    private static JSONObject copyJsonPayload(@Nullable JSONObject payload) {
        if (payload == null) {
            return null;
        }
        try {
            return new JSONObject(payload.toString());
        } catch (org.json.JSONException error) {
            Log.w(TAG, "Could not copy IMU payload for RAM-first callback", error);
            return null;
        }
    }

    private ExecutorService persistenceExecutor() {
        ExecutorService executor = persistenceExecutor;
        if (executor == null) {
            synchronized (this) {
                executor = persistenceExecutor;
                if (executor == null) {
                    executor =
                            Executors.newSingleThreadExecutor(
                                    r -> {
                                        Thread t = new Thread(r, "PhotoPersistence");
                                        t.setDaemon(true);
                                        return t;
                                    });
                    persistenceExecutor = executor;
                }
            }
        }
        return executor;
    }

    private boolean saveImageDataToFile(byte[] data, String filePath) {
        long storageStartMs = System.currentTimeMillis();
        try {
            File file = new File(filePath);

            File parentDir = file.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                long mkdirStartMs = System.currentTimeMillis();
                parentDir.mkdirs();
                BlePhotoTimingLog.event(
                        "CAPTURE STORAGE",
                        "capture directory creation took "
                                + (System.currentTimeMillis() - mkdirStartMs)
                                + "ms");
            }

            long fileWriteStartMs = System.currentTimeMillis();
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(data);
            }
            long fileWriteMs = System.currentTimeMillis() - fileWriteStartMs;
            long fileSize = file.length();
            BlePhotoTimingLog.capturePhase(
                    "still_jpeg_write_done",
                    "JPEG file write/close took "
                            + fileWriteMs
                            + "ms; expected="
                            + data.length
                            + " bytes, on_disk="
                            + fileSize
                            + " bytes");

            // Stamp the capture ID (directory name, carries the SDK requestId) into EXIF
            // ImageUniqueID so the correlation survives renames and camera-roll export.
            // Runs before finishImuRecording's EXIF pass; saveAttributes preserves it.
            long exifStartMs = System.currentTimeMillis();
            PhotoExifMetadataWriter.writeCaptureIdFromPath(filePath);
            BlePhotoTimingLog.capturePhase(
                    "still_capture_id_exif_done",
                    "capture ID EXIF write took "
                            + (System.currentTimeMillis() - exifStartMs)
                            + "ms");

            Log.d(TAG, "Saved image to: " + filePath);
            BlePhotoTimingLog.capturePhase(
                    "still_image_save_done",
                    "image save completed in "
                            + (System.currentTimeMillis() - storageStartMs)
                            + "ms");
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
            pendingCapturedPhoto = null;
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
            @Nullable CapturedPhoto capturedPhoto,
            @Nullable CameraNeoService.PhotoCaptureCallback callback,
            long startMs) {
        long e2eTimeMs = (startMs > 0) ? (System.currentTimeMillis() - startMs) : -1L;
        Log.i(
                TAG,
                "📸 PHOTO E2E: Photo capture completed in "
                        + e2eTimeMs
                        + "ms (e2e) | Capture key: "
                        + filePath);

        if (callback != null) {
            hooks.executor()
                    .execute(
                            () ->
                                    callback.onPhotoCaptured(
                                            filePath, captureMetadata, capturedPhoto));
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
        notifyPhotoCaptured(filePath, null, true);
    }

    private void notifyPhotoCaptured(String filePath, CapturedPhoto capturedPhoto) {
        notifyPhotoCaptured(filePath, capturedPhoto, true);
    }

    /**
     * @param waitForStillMetadata when {@code true}, briefly defer the {@code captured} callback to
     *     attach still-capture HAL metadata (single still path). HDR bursts have no {@link
     *     StillCaptureCallback} and never record that metadata, so they pass {@code false} to emit
     *     immediately instead of always hitting the {@link #CAPTURE_METADATA_WAIT_TIMEOUT_MS}
     *     timeout.
     */
    private void notifyPhotoCaptured(String filePath, boolean waitForStillMetadata) {
        notifyPhotoCaptured(filePath, null, waitForStillMetadata);
    }

    private void notifyPhotoCaptured(
            String filePath, @Nullable CapturedPhoto capturedPhoto, boolean waitForStillMetadata) {
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
                    pendingCapturedPhoto = capturedPhoto;
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
        emitPhotoCaptured(filePath, metadataToSend, capturedPhoto, callback, startMs);
    }

    private void scheduleCaptureMetadataTimeoutLocked(String filePath) {
        if (pendingCaptureMetadataTimeout != null) {
            return;
        }
        Runnable timeout =
                () -> {
                    CameraNeoService.PhotoCaptureCallback callback;
                    CapturedPhoto capturedPhoto;
                    long startMs;
                    synchronized (captureMetadataLock) {
                        if (!Objects.equals(pendingCapturedFilePath, filePath)
                                || photoCapturedCallbackSent) {
                            return;
                        }
                        callback = pendingCapturedCallback;
                        capturedPhoto = pendingCapturedPhoto;
                        startMs = pendingCapturedStartTimeMs;
                        pendingCapturedFilePath = null;
                        pendingCapturedCallback = null;
                        pendingCapturedPhoto = null;
                        pendingCapturedStartTimeMs = 0L;
                        pendingCaptureMetadataTimeout = null;
                        photoCapturedCallbackSent = true;
                    }
                    Log.w(
                            TAG,
                            "Still capture metadata was not available within "
                                    + CAPTURE_METADATA_WAIT_TIMEOUT_MS
                                    + "ms; emitting captured status without captureMetadata");
                    emitPhotoCaptured(filePath, null, capturedPhoto, callback, startMs);
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
        CapturedPhoto capturedPhoto = null;
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
            capturedPhoto = pendingCapturedPhoto;
            startMs = pendingCapturedStartTimeMs;
            timeoutToCancel = pendingCaptureMetadataTimeout;
            pendingCapturedFilePath = null;
            pendingCapturedCallback = null;
            pendingCapturedPhoto = null;
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
        emitPhotoCaptured(filePathToNotify, captureMetadata, capturedPhoto, callback, startMs);
    }

    private void notifyPhotoError(String errorMessage) {
        notifyPhotoError(CameraOperationError.captureFailed(errorMessage));
    }

    private void notifyPhotoError(CameraOperationError error) {
        resetCaptureMetadataState();
        CameraNeoService.PhotoCaptureCallback callback =
                activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            try {
                callback.onPhotoFailureDetected();
            } catch (RuntimeException callbackError) {
                Log.e(TAG, "Photo failure-boundary callback threw", callbackError);
            }
            hooks.executor().execute(() -> callback.onPhotoError(error));
        }
    }

    private static void putIfNotNull(JSONObject json, String key, Object value)
            throws JSONException {
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
            metered.put(
                    "totalLightProxy",
                    (mLastMeteredExposureNs / 1_000_000.0) * mLastMeteredIso.doubleValue());
        }
        return metered.length() > 0 ? metered : null;
    }

    @Nullable
    private JSONObject buildRequestedCaptureConfig(CaptureRequest captureRequest, boolean useManual)
            throws JSONException {
        if (captureRequest == null) {
            return null;
        }
        JSONObject requested = new JSONObject();
        requested.put("manual", useManual);
        putIfNotNull(
                requested,
                "exposureTimeNs",
                captureRequest.get(CaptureRequest.SENSOR_EXPOSURE_TIME));
        putIfNotNull(requested, "iso", captureRequest.get(CaptureRequest.SENSOR_SENSITIVITY));
        putIfNotNull(
                requested,
                "frameDurationNs",
                captureRequest.get(CaptureRequest.SENSOR_FRAME_DURATION));
        putIfNotNull(requested, "aeMode", captureRequest.get(CaptureRequest.CONTROL_AE_MODE));
        putIfNotNull(requested, "aeLock", captureRequest.get(CaptureRequest.CONTROL_AE_LOCK));
        putIfNotNull(
                requested,
                "aeExposureCompensation",
                captureRequest.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION));
        putIfNotNull(
                requested,
                "noiseReductionMode",
                captureRequest.get(CaptureRequest.NOISE_REDUCTION_MODE));
        putIfNotNull(requested, "edgeMode", captureRequest.get(CaptureRequest.EDGE_MODE));
        putIfNotNull(requested, "afMode", captureRequest.get(CaptureRequest.CONTROL_AF_MODE));
        putIfNotNull(requested, "zsl", captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL));
        JSONObject fpsRange =
                rangeToJson(captureRequest.get(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE));
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
            @Nullable JSONObject requestedCaptureConfig, @Nullable JSONObject meteredPreview) {
        CameraNeoService.PhotoCaptureCallback callback =
                activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            hooks.executor()
                    .execute(
                            () ->
                                    callback.onPhotoCapturing(
                                            requestedCaptureConfig, meteredPreview));
        }
    }

    /** Deliver a bound shutter boundary inline, dropping callbacks from an older queued shot. */
    void notifyPhotoExposureStartedForCapture(
            long captureGeneration,
            @Nullable CameraNeoService.PhotoCaptureCallback callback,
            long sensorTimestampNs,
            long estimatedExposureDurationNs) {
        synchronized (captureMetadataLock) {
            if (captureGeneration != captureMetadataGeneration) {
                Log.w(TAG, "Ignoring stale exposure-start callback from a previous shot");
                return;
            }
        }
        if (callback != null) {
            callback.onPhotoExposureStarted(sensorTimestampNs, estimatedExposureDurationNs);
        }
    }

    /** Deliver ImageReader arrival inline, before buffer extraction or persistence. */
    private void notifyPhotoFrameAvailable(long sensorTimestampNs) {
        CameraNeoService.PhotoCaptureCallback callback =
                activeCapture != null ? activeCapture.callback : null;
        if (callback != null) {
            callback.onPhotoFrameAvailable(sensorTimestampNs);
        }
    }

    private void notifyCurrentPhotoConfigured() {
        Size size = jpegSize();
        if (size != null) {
            notifyPhotoConfigured(size, previewJpegQuality());
        }
    }

    public void notifyPhotoConfigured(Size size, int jpegQuality) {
        CameraNeoService.PhotoCaptureCallback callback =
                activeCapture != null ? activeCapture.callback : null;
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
                failWarmUpOrPhoto("Camera session not ready");
                hooks.closeCamera();
                hooks.stopService();
                return;
            }

            Handler backgroundHandler = hooks.backgroundHandler();
            if (backgroundHandler == null || hooks.coordinator().device() == null) {
                Log.e(TAG, "Camera handler or device not ready in startPreviewWithAeMonitoring");
                failWarmUpOrPhoto("Camera handler not ready");
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

            // Warm-up shares the normal AE-convergence wait (startPrecaptureSequence /
            // onAeReadyForActiveRequest) instead of reporting ready immediately: firing "ready"
            // before AE has physically settled defeats the point of warming up, because a
            // take_photo sent right after would still pay the full convergence wait. Capped at the
            // same AeStateMachine#AE_WAIT_MAX_NS worst case as a real capture.
            if (warmUpRequest != null) {
                Log.d(
                        TAG,
                        "camera_warm_up: preview running, waiting for AE to settle before ready");
            }

            startPrecaptureSequence();

        } catch (CameraAccessException | IllegalArgumentException | IllegalStateException e) {
            // IllegalArgumentException: a teardown racing this call abandoned the preview
            // surface ("Surface was abandoned", OS-1816). IllegalStateException: the session
            // was closed under us. Both must fail the request, not crash the process.
            Log.e(TAG, "Error starting preview with AE monitoring", e);
            if (warmUpRequest != null) {
                failWarmUp(
                        CameraOperationError.warmUpFailed(
                                "Error starting preview: " + e.getMessage()));
            } else {
                notifyPhotoError("Error starting preview: " + e.getMessage());
            }
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
                Runnable runCapture = this::onAeReadyForActiveRequest;
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
                    hooks.cameraSettings() != null
                            && hooks.cameraSettings().isZslSupported()
                            && previewZslEnabled();
            boolean mfnrEnabled = resolveMfnrForCapture();

            Log.d(TAG, "DIAGNOSTIC: startPrecaptureSequence() called");
            Log.d(TAG, "ZSL enabled (preview): " + zslEnabled + "; MFNR enabled: " + mfnrEnabled);
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
                clearAeWait,
                previewZslEnabled());
    }

    /**
     * Whether {@link #capturePhoto()} would dispatch to the HDR burst path. EV-bracket HDR needs
     * AE, so manual/scan exposure disables HDR.
     */
    boolean wouldCaptureHdrBurst() {
        return hooks.cameraSettings() != null
                && hooks.cameraSettings().mAsgSettings.isHdrBurstEnabled()
                && !currentIsFromSdk()
                && !shouldUseManualExposure();
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

        if (wouldCaptureHdrBurst()) {
            captureHdrBurst();
            return;
        }

        mCurrentShotUsesHdrBurst = false;

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
            String imuStartPath =
                    (currentFilePath() != null) ? currentFilePath() : listenerFallbackPhotoPath;
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
                                + "; AE disabled)");
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

            boolean requestedZsl = resolveZslForCapture();
            boolean requestedMfnr = resolveMfnrForCapture();
            // Fixed SENSOR_* controls and the MediaTek ZSL/MFNR pipeline are mutually exclusive:
            // the vendor pipeline may select a buffered frame and replace the requested exposure.
            // Manual and scan captures therefore take precedence over their resolved flags.
            boolean zsl = !useManual && requestedZsl;
            boolean mfnr = !useManual && requestedMfnr;
            String appliedSource =
                    captureSettings != null
                                    && (captureSettings.zsl != null || captureSettings.mfnr != null)
                            ? "request"
                            : "global";
            if (!StillCaptureBuilder.allowsVendorZslMfnr(useManual)) {
                // The MediaTek ZSL/MFNR vendor pipeline owns exposure decisions and can override
                // fixed SENSOR_* values. Keep the manual still request on the plain Camera2 path.
                // CONTROL_ENABLE_ZSL is safe to set explicitly; the vendor keys are intentionally
                // omitted so MFNR/AIS cannot fight the requested exposure and sensitivity.
                stillBuilder.set(CaptureRequest.CONTROL_ENABLE_ZSL, false);
                BlePhotoTimingLog.capturePhase(
                        "still_vendor_config_skipped",
                        "manual SENSOR_* capture; requested ZSL="
                                + (requestedZsl ? "on" : "off")
                                + " MFNR="
                                + (requestedMfnr ? "on" : "off")
                                + "; both forced off for still request");
            } else if (hooks.cameraSettings() != null) {
                hooks.cameraSettings().configureCaptureBuilder(stillBuilder, zsl, mfnr);
                BlePhotoTimingLog.capturePhase(
                        "still_vendor_config_applied",
                        "ZSL="
                                + (zsl ? "on" : "off")
                                + " MFNR="
                                + (mfnr ? "on" : "off")
                                + " (source="
                                + appliedSource
                                + ")");
            }

            CaptureRequest captureRequest = stillBuilder.build();

            Boolean zslInCapture = captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            if (zslInCapture != null && zslInCapture) {
                Log.d(TAG, "ZSL verified in capture request: CONTROL_ENABLE_ZSL = true");
            } else {
                Log.w(
                        TAG,
                        "ZSL NOT enabled in capture request (CONTROL_ENABLE_ZSL = "
                                + zslInCapture
                                + ")");
            }

            boolean globalZsl =
                    hooks.cameraSettings() != null
                            && hooks.cameraSettings().mAsgSettings.isZslEnabled();
            boolean globalMfnr =
                    hooks.cameraSettings() != null
                            && hooks.cameraSettings().mAsgSettings.isMfnrEnabled();
            PhotoCaptureSettings.logAppliedAtCapture(
                    currentFilePath() != null ? currentFilePath() : "unknown",
                    captureSettings,
                    useManual,
                    mLastMeteredExposureNs,
                    useManual ? Long.valueOf(manualClampedNs) : currentExposureTimeNs(),
                    useManual ? manualIso : captureRequest.get(CaptureRequest.SENSOR_SENSITIVITY),
                    globalZsl,
                    globalMfnr);

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
            final CameraNeoService.PhotoCaptureCallback captureCallback =
                    activeCapture != null ? activeCapture.callback : null;
            mLastStillCaptureCompletedWallMs = 0L;
            mStillHalStartedLogged = false;
            mStillHalStartedWallMs = 0L;
            mStillTimingFinalizedByImageReader = false;
            mStillShutterSubmittedWallMs = System.currentTimeMillis();
            mStillShutterSubmittedElapsedNs = SystemClock.elapsedRealtimeNanos();
            Long reqExpNs = captureRequest.get(CaptureRequest.SENSOR_EXPOSURE_TIME);
            Integer reqIso = captureRequest.get(CaptureRequest.SENSOR_SENSITIVITY);
            Boolean reqZsl = captureRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            Integer reqNr = captureRequest.get(CaptureRequest.NOISE_REDUCTION_MODE);
            // AUTO path often leaves SENSOR_EXPOSURE_TIME null on the request; use last metered
            // preview exposure so bottleneck math has a real shutter budget.
            if (reqExpNs != null && reqExpNs > 0) {
                mStillRequestedExposureNs = reqExpNs;
            } else if (mLastMeteredExposureNs != null && mLastMeteredExposureNs > 0) {
                mStillRequestedExposureNs = mLastMeteredExposureNs;
            } else {
                mStillRequestedExposureNs = 10_000_000L; // 10ms fallback
            }
            mStillRequestedNrMode = reqNr != null ? reqNr : -1;
            mStillZslRequested = zsl;
            mStillMfnrRequested = mfnr;
            mStillPreviewZslEnabled = previewZslEnabled();
            mStillControlEnableZsl = reqZsl;
            int jpegQ = getJpegQualityForSize();
            String sizeLabel =
                    jpegSize != null ? jpegSize.getWidth() + "x" + jpegSize.getHeight() : "unknown";
            String expLabel =
                    String.format(
                            java.util.Locale.US, "%.2fms", mStillRequestedExposureNs / 1_000_000.0);
            if (reqExpNs == null) {
                expLabel += "(metered)";
            }
            BlePhotoTimingLog.capturePhase(
                    "still_shutter_submitted",
                    String.format(
                            java.util.Locale.US,
                            "%s jpegQ=%d mode=%s req_exp=%s req_iso=%s zsl=%s nr=%s mfnr=%s —"
                                    + " waiting for HAL onCaptureStarted",
                            sizeLabel,
                            jpegQ,
                            useManual ? "MANUAL" : "AUTO",
                            expLabel,
                            reqIso != null ? reqIso.toString() : "ae",
                            String.valueOf(reqZsl),
                            reqNr != null ? reqNr.toString() : "?",
                            mStillMfnrRequested));
            activeSession.capture(
                    captureRequest,
                    new StillCaptureCallback(
                            new StillCaptureCallback.Hooks() {
                                @Override
                                public void recordStillSensorTimestampNs(Long timestampNs) {
                                    mLastStillSensorTimestampNs = timestampNs;
                                }

                                @Override
                                public void recordStillHalStartedWallMs(long startedWallMs) {
                                    if (!mStillHalStartedLogged) {
                                        mStillHalStartedLogged = true;
                                        mStillHalStartedWallMs = startedWallMs;
                                    }
                                }

                                @Override
                                public void notifyPhotoExposureStarted(
                                        long sensorTimestampNs, long estimatedExposureDurationNs) {
                                    notifyPhotoExposureStartedForCapture(
                                            captureGeneration,
                                            captureCallback,
                                            sensorTimestampNs,
                                            estimatedExposureDurationNs);
                                }

                                @Override
                                public boolean stillHalStartedAlreadyLogged() {
                                    return mStillHalStartedLogged;
                                }

                                @Override
                                public boolean stillTimingFinalizedByImageReader() {
                                    return mStillTimingFinalizedByImageReader;
                                }

                                @Override
                                public void recordStillCaptureCompletedWallMs(
                                        long completedWallMs) {
                                    mLastStillCaptureCompletedWallMs = completedWallMs;
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
                            },
                            mStillRequestedExposureNs),
                    // Dedicated thread: ImageReader JPEG work must not delay HAL timing callbacks.
                    stillCaptureCallbackHandler());

        } catch (CameraAccessException | IllegalArgumentException | IllegalStateException e) {
            // IllegalArgumentException: the still surface was abandoned by a racing
            // teardown (OS-1816). IllegalStateException: the session was closed under us.
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
        mCurrentShotUsesHdrBurst = true;
        final long captureGeneration;
        synchronized (captureMetadataLock) {
            captureGeneration = captureMetadataGeneration;
        }
        final CameraNeoService.PhotoCaptureCallback captureCallback =
                activeCapture != null ? activeCapture.callback : null;
        try {
            shotState = AeStateMachine.ShotState.SHOOTING;

            ImuRecorder imu = hooks.ensureImuRecorder();
            String imuStartPath =
                    (currentFilePath() != null) ? currentFilePath() : listenerFallbackPhotoPath;
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

            boolean zsl = resolveZslForCapture();
            boolean mfnr = resolveMfnrForCapture();

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
                    zsl,
                    mfnr,
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

                        @Override
                        public void onFinalCaptureStarted(long sensorTimestampNs) {
                            // Duration is unknown for the AE-bracketed frame. Stop prep at the
                            // hardware boundary, then let final JPEG arrival trigger the snap.
                            notifyPhotoExposureStartedForCapture(
                                    captureGeneration, captureCallback, sensorTimestampNs, 0L);
                        }
                    });

        } catch (CameraAccessException | IllegalArgumentException | IllegalStateException e) {
            // Same teardown races as capturePhoto(): abandoned still surface or closed
            // session must fail the burst, not crash the process (OS-1816).
            Log.e(TAG, "Error during HDR burst capture", e);
            hdrBurstCapture.cancel();
            hooks.cancelImuRecording();
            notifyPhotoError("HDR burst error: " + e.getMessage());
            shotState = AeStateMachine.ShotState.IDLE;
            hooks.closeCamera();
            hooks.stopService();
        }
    }

    /**
     * A failed/cancelled HDR burst is inactive but is not a normal still. Preserve the dispatch
     * mode separately so a late JPEG cannot produce a success snap during the error callback race.
     */
    boolean shouldNotifyPhotoFrameAvailable() {
        if (!mCurrentShotUsesHdrBurst) {
            return true;
        }
        return hdrBurstCapture.isActive()
                && hdrBurstCapture.framesReceived() == HdrBurstBuilder.HDR_BURST_COUNT - 1;
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
        notifyHostPhotoError(
                warmUpRequest != null
                        ? CameraOperationError.warmUpFailed(errorMessage)
                        : CameraOperationError.captureFailed(errorMessage));
    }

    /** Called when setup/open/session code has classified the failure. */
    public void notifyHostPhotoError(CameraOperationError error) {
        if (warmUpRequest != null) {
            failWarmUp(error);
            return;
        }
        notifyPhotoError(error);
    }

    public int previewJpegQuality() {
        return getJpegQualityForSize();
    }

    /** In-flight {@code camera_warm_up} request held while the session opens/configures. */
    private static final class WarmUpRequest {
        @Nullable final String size;
        @Nullable final Long exposureTimeNs;
        @Nullable final PhotoCaptureSettings captureSettings;
        final long durationMs;
        @Nullable final Runnable onReady;
        @Nullable final java.util.function.Consumer<CameraOperationError> onError;

        WarmUpRequest(
                @Nullable String size,
                @Nullable Long exposureTimeNs,
                @Nullable PhotoCaptureSettings captureSettings,
                long durationMs,
                @Nullable Runnable onReady,
                @Nullable java.util.function.Consumer<CameraOperationError> onError) {
            this.size = size;
            this.exposureTimeNs = exposureTimeNs;
            this.captureSettings = captureSettings;
            this.durationMs = durationMs;
            this.onReady = onReady;
            this.onError = onError;
        }

        /**
         * Transient placeholder path; warm-up never writes a file, but the open path expects one.
         */
        String warmFilePath() {
            return "warmup_" + System.currentTimeMillis() + ".jpg";
        }
    }

    private void recordCaptureSessionForTiming(
            boolean reusedWarmSession, @Nullable String sizeTier, @Nullable String note) {
        Size size = jpegSize;
        BlePhotoTimingLog.captureSession(
                reusedWarmSession,
                sizeTier,
                size != null ? size.getWidth() : 0,
                size != null ? size.getHeight() : 0,
                note);
    }

    /** Short PHASE SUMMARY reason when warm and capture camera configs differ. */
    private static String warmSessionReasonMismatch(
            @Nullable ConfiguredCameraConfig baseline, QueuedPhotoRequest request) {
        if (baseline == null) {
            return BlePhotoTimingLog.WarmSessionReason.NO_WARMUP;
        }
        if (!Objects.equals(baseline.size, request.size)) {
            return BlePhotoTimingLog.WarmSessionReason.mismatchSize(baseline.size, request.size);
        }
        if (baseline.isFromSdk != request.isFromSdk) {
            return BlePhotoTimingLog.WarmSessionReason.MISMATCH_SDK;
        }
        if (!Objects.equals(baseline.exposureTimeNs, request.exposureTimeNs)) {
            return BlePhotoTimingLog.WarmSessionReason.MISMATCH_EXPOSURE;
        }
        return BlePhotoTimingLog.WarmSessionReason.MISMATCH;
    }

    /**
     * Detailed mismatch dump for Log.d only — the PHASE SUMMARY uses the short reason codes from
     * {@link #warmSessionReasonMismatch}.
     */
    private static String describeConfigMismatch(
            @Nullable ConfiguredCameraConfig baseline, QueuedPhotoRequest request) {
        if (baseline == null) {
            return "warmTier=none captureTier=" + request.size;
        }
        return "warmTier="
                + baseline.size
                + " captureTier="
                + request.size
                + " warmIsFromSdk="
                + baseline.isFromSdk
                + " captureIsFromSdk="
                + request.isFromSdk
                + " warmExposureNs="
                + baseline.exposureTimeNs
                + " captureExposureNs="
                + request.exposureTimeNs;
    }

    /** Immutable snapshot of camera pipeline parameters for burst reuse decisions. */
    private static final class ConfiguredCameraConfig {
        @Nullable final String size;
        final boolean isFromSdk;
        @Nullable final Long exposureTimeNs;

        /** Resolved ZSL applied to the open preview/still path. */
        final boolean zsl;

        /** Resolved MFNR applied to the open still path. */
        final boolean mfnr;

        ConfiguredCameraConfig(
                @Nullable String size,
                boolean isFromSdk,
                @Nullable Long exposureTimeNs,
                boolean zsl,
                boolean mfnr) {
            this.size = size;
            this.isFromSdk = isFromSdk;
            this.exposureTimeNs = exposureTimeNs;
            this.zsl = zsl;
            this.mfnr = mfnr;
        }

        /**
         * Session reopen is required for size/SDK/exposure changes, or when the request needs
         * preview-ZSL buffering ({@code otherZsl || otherMfnr}) that this baseline does not have.
         * Turning MFNR/ZSL off (or swapping which of the two is on) while preview buffering stays
         * available is applied on the still CaptureRequest and must not cold-start the camera —
         * that was breaking {@code camera_warm_up} (global defaults) → {@code take_photo}
         * (per-request zsl/mfnr).
         */
        boolean differsFrom(
                @Nullable String otherSize,
                boolean otherIsFromSdk,
                @Nullable Long otherExposureTimeNs,
                boolean otherZsl,
                boolean otherMfnr) {
            if (!Objects.equals(size, otherSize)) {
                return true;
            }
            if (isFromSdk != otherIsFromSdk) {
                return true;
            }
            if (!Objects.equals(exposureTimeNs, otherExposureTimeNs)) {
                return true;
            }
            boolean baselinePreviewZsl = zsl || mfnr;
            boolean requestPreviewZsl = otherZsl || otherMfnr;
            // Need a buffer we don't have → reopen. Already buffered when request doesn't need it
            // (or only changes still-side MFNR/ZSL) → reuse.
            return requestPreviewZsl && !baselinePreviewZsl;
        }
    }

    /** Service-level bridge for threading, wake, camera open, and shared builders. */
    public interface Hooks {
        Object serviceLock();

        void openCameraInternal(String filePath, boolean forVideo);

        void closeCamera();

        void startKeepAliveTimer();

        /** Keep-alive with a caller-supplied TTL used by {@code camera_warm_up}. */
        void startWarmKeepAliveTimer(long durationMs);

        /**
         * Post-photo keep-alive: the warm lease's remaining TTL if one is active, else the normal
         * short photo keep-alive. Use after a capture so a take_photo inside a warm window doesn't
         * shorten the lease.
         */
        void startPostCaptureKeepAlive();

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
