package com.mentra.asg_client.camera;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.os.Build;
import android.os.Handler;
import android.util.Log;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.Surface;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.lifecycle.LifecycleService;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.lifecycle.CameraCoordinator;
import com.mentra.asg_client.camera.lifecycle.CameraOpener;
import com.mentra.asg_client.camera.lifecycle.CameraRecoveryHelper;
import com.mentra.asg_client.camera.lifecycle.CameraServiceNotification;
import com.mentra.asg_client.camera.lifecycle.HandlerExecutor;
import com.mentra.asg_client.camera.lifecycle.ImageReaderTwin;
import com.mentra.asg_client.camera.lifecycle.PhotoSession;
import com.mentra.asg_client.camera.lifecycle.VideoRecordingSession;
import com.mentra.asg_client.camera.model.CameraOperationError;
import com.mentra.asg_client.camera.model.CapturedPhoto;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.camera.model.QueuedPhotoRequest;
import com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import com.mentra.asg_client.camera.policy.CameraCapabilities;
import com.mentra.asg_client.camera.policy.FpsRangePolicy;
import com.mentra.asg_client.camera.policy.JpegOrientationResolver;
import com.mentra.asg_client.camera.policy.PhotoMode;
import com.mentra.asg_client.camera.request.PreviewRequestConfigurator;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.media.utils.MediaStorage;
import com.mentra.asg_client.sensors.ImuRecorder;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.utils.WakeLockManager;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class CameraNeoService extends LifecycleService {
    private static final String TAG = "CameraNeo";

    private static final String CHANNEL_ID = "CameraNeoServiceChannel";
    private static final int NOTIFICATION_ID = 1;

    // =======================================================================
    // STATIC STATE MANAGEMENT FOR TRUE SINGLETON PATTERN
    // =======================================================================

    private static final Object SERVICE_LOCK = new Object();

    // =======================================================================

    // Camera variables
    private CaptureRequest.Builder previewBuilder; // Separate builder for preview
    private final CameraCoordinator cameraCoordinator = new CameraCoordinator();
    private Handler backgroundHandler;
    private String cameraId;

    // Photo resolution and quality constants are defined in CameraConstants.java

    // JPEG orientation mapping moved to {@link JpegOrientationResolver}.

    // Camera keep-alive settings
    private static final long CAMERA_KEEP_ALIVE_MS =
            3000; // Keep camera open for 3 seconds after photo

    private IHardwareManager hardwareManager;

    // MediaTek vendor-specific camera settings (ZSL, MFNR)
    private CameraSettings mCameraSettings;

    /** Photo capture lifecycle (queue, AE, still/HDR, image save). */
    private PhotoSession photoSession;

    // IMU recorder for bundling sensor data with captured media
    private ImuRecorder mImuRecorder;

    // Camera characteristics for dynamic auto-exposure and autofocus
    private int[] availableAeModes;
    private Range<Integer> exposureCompensationRange;
    private Rational exposureCompensationStep;
    private Range<Integer>[] availableFpsRanges;
    private Range<Integer> selectedFpsRange;

    /** Cached for per-request manual still capture (not persisted). */
    /**
     * Phase 3 prep: bundled AF + manual-sensor capabilities for the currently open camera. Replaces
     * the prior scattered {@code manualSensorSupported}/{@code sensorExposureTimeRange}/ {@code
     * sensorMaxFrameDurationNs}/{@code sensorSensitivityRange}/{@code availableAfModes}/ {@code
     * minimumFocusDistance}/{@code hasAutoFocus} fields. Null until {@link
     * #queryCameraCapabilities} runs.
     */
    private CameraCapabilities cameraCapabilities;

    /** Cached convenience flag mirroring {@link CameraCapabilities#hasContinuousPictureAf}. */
    private boolean hasAutoFocus;

    // Autofocus + manual-sensor capabilities are bundled into {@link #cameraCapabilities}.

    /** Delegates to {@link JpegOrientationResolver#getDisplayRotation(Context)}. */
    private int getDisplayRotation() {
        return JpegOrientationResolver.getDisplayRotation(this);
    }

    // User-settable exposure compensation (apply BEFORE capture, not during)
    private int userExposureCompensation = 0;

    // Electronic Image Stabilization (EIS) state
    private boolean eisEnabled = true; // Enabled by default

    // Callback and execution handling
    private final Executor executor = Executors.newSingleThreadExecutor();

    // Intent action definitions (MOVED TO TOP)
    public static final String ACTION_TAKE_PHOTO = "com.augmentos.camera.ACTION_TAKE_PHOTO";
    public static final String EXTRA_PHOTO_FILE_PATH = "com.augmentos.camera.EXTRA_PHOTO_FILE_PATH";
    public static final String ACTION_START_VIDEO_RECORDING =
            "com.augmentos.camera.ACTION_START_VIDEO_RECORDING";
    public static final String ACTION_STOP_VIDEO_RECORDING =
            "com.augmentos.camera.ACTION_STOP_VIDEO_RECORDING";
    public static final String ACTION_WARM_UP_CAMERA = "com.augmentos.camera.ACTION_WARM_UP_CAMERA";
    private static final String EXTRA_WARM_UP_SIZE = "com.augmentos.camera.EXTRA_WARM_UP_SIZE";
    private static final String EXTRA_WARM_UP_DURATION_MS =
            "com.augmentos.camera.EXTRA_WARM_UP_DURATION_MS";
    private static final String EXTRA_WARM_UP_EXPOSURE_NS =
            "com.augmentos.camera.EXTRA_WARM_UP_EXPOSURE_NS";
    private static final String EXTRA_WARM_UP_MODE = "com.augmentos.camera.EXTRA_WARM_UP_MODE";
    private static final String EXTRA_WARM_UP_ZSL = "com.augmentos.camera.EXTRA_WARM_UP_ZSL";
    private static final String EXTRA_WARM_UP_MFNR = "com.augmentos.camera.EXTRA_WARM_UP_MFNR";
    public static final String EXTRA_VIDEO_FILE_PATH = "com.augmentos.camera.EXTRA_VIDEO_FILE_PATH";
    public static final String EXTRA_VIDEO_ID = "com.augmentos.camera.EXTRA_VIDEO_ID";
    public static final String EXTRA_VIDEO_SETTINGS = "com.augmentos.camera.EXTRA_VIDEO_SETTINGS";

    // Callback interface for photo capture
    public interface PhotoCaptureCallback {
        default void onPhotoConfigured(JSONObject resolvedConfig) {}

        default void onPhotoCapturing() {}

        default void onPhotoCapturing(
                JSONObject requestedCaptureConfig, JSONObject meteredPreview) {
            onPhotoCapturing();
        }

        /**
         * Called when Camera2 reports that the sensor has started exposing the still frame. {@code
         * estimatedExposureDurationNs} is exact for manual capture and uses the most recent
         * preview-metered duration for auto exposure.
         */
        default void onPhotoExposureStarted(
                long sensorTimestampNs, long estimatedExposureDurationNs) {}

        /** Called as soon as the completed JPEG frame reaches Camera2's ImageReader. */
        default void onPhotoFrameAvailable(long sensorTimestampNs) {}

        /**
         * Called inline when the camera pipeline detects a terminal failure, before the detailed
         * error is dispatched asynchronously. Keep this callback lightweight.
         */
        default void onPhotoFailureDetected() {}

        default void onPhotoCaptured(String filePath) {
            onPhotoCaptured(filePath, null);
        }

        void onPhotoCaptured(String filePath, @Nullable JSONObject captureMetadata);

        /**
         * RAM-first result delivery. Classic file-backed callbacks keep using the two-argument
         * overload; consumers that request deferred persistence receive the capture directly so
         * queued callbacks cannot lose it through a process-global side channel.
         */
        default void onPhotoCaptured(
                String filePath,
                @Nullable JSONObject captureMetadata,
                @Nullable CapturedPhoto capturedPhoto) {
            onPhotoCaptured(filePath, captureMetadata);
        }

        void onPhotoError(String errorMessage);

        default void onPhotoError(CameraOperationError error) {
            onPhotoError(error.message());
        }
    }

    /** Callback for {@code camera_warm_up} lifecycle (no capture). */
    public interface CameraWarmUpCallback {
        /**
         * Warm-up accepted — the camera is spinning up. Emitted only once the request is committed
         * (not for a busy rejection), so callers never see {@code warming} followed by {@code
         * error}.
         */
        void onWarming();

        /** Session configured and preview/AE running — next take_photo will be warm. */
        void onCameraReady();

        /** Keep-alive expired / camera closed without capturing. */
        void onCameraStopped();

        /** Warm-up failed (open/configure failure). */
        void onCameraError(String errorMessage);

        default void onCameraError(CameraOperationError error) {
            onCameraError(error.message());
        }

        /**
         * The phone-side request this warm-up belongs to, or {@code null} if none. Used to keep at
         * most one pending {@code stopped} callback per request so a re-armed warm-up doesn't send
         * the phone duplicate {@code stopped} events. Defaults to {@code null} for callers that
         * don't track a requestId (those are appended without de-duplication).
         */
        default String getRequestId() {
            return null;
        }

        /** Requested ready-state lease duration, after ASG clamping. */
        default long getDurationMs() {
            return AsgConstants.CAMERA_WARM_UP_DEFAULT_DURATION_MS;
        }
    }

    // Warm-up callbacks. Several camera_warm_up commands can be in flight at once (e.g. two
    // miniapps warming the shared camera, or one app firing warmUp twice quickly); a single slot
    // would drop all but the last and leave those phone-side promises hanging. Pending callbacks
    // accumulate here (set by the static entry) until performWarmUp binds them to the instance.
    private static final List<CameraWarmUpCallback> sPendingWarmCallbacks = new ArrayList<>();

    /** Bound warm-up callbacks awaiting ready/error. All resolve together — one shared camera. */
    private final List<CameraWarmUpCallback> warmCallbacks = new ArrayList<>();

    /** Ready leases keyed by phone-owned request ID. Compatible leases share one camera session. */
    private final Map<String, WarmLease> warmLeases = new LinkedHashMap<>();

    private final Set<String> warmReadyRequestIds = new HashSet<>();

    /**
     * Wall-clock deadline (ms) of the active {@code camera_warm_up} lease, or 0 when none. Lets a
     * take_photo taken inside the warm window re-arm the warm keep-alive for the remaining lease
     * time instead of the short photo keep-alive. Cleared when the camera closes.
     */
    private volatile long warmLeaseDeadlineMs = 0;

    private String warmLeaseMode;
    private String openingWarmMode;

    private static final class WarmLease {
        final CameraWarmUpCallback callback;
        final long deadlineMs;

        WarmLease(CameraWarmUpCallback callback, long deadlineMs) {
            this.callback = callback;
            this.deadlineMs = deadlineMs;
        }
    }

    // Video recording — owned by VideoRecordingSession (Phase 2.1).
    private VideoRecordingSession videoSession;

    private final PhotoSession.Hooks photoSessionHooks =
            new PhotoSession.Hooks() {
                @Override
                public Object serviceLock() {
                    return SERVICE_LOCK;
                }

                @Override
                public void openCameraInternal(String filePath, boolean forVideo) {
                    CameraNeoService.this.openCameraInternal(filePath, forVideo);
                }

                @Override
                public void closeCamera() {
                    CameraNeoService.this.closeCamera();
                }

                @Override
                public void startKeepAliveTimer() {
                    CameraNeoService.this.startKeepAliveTimer();
                }

                @Override
                public void startWarmKeepAliveTimer(long durationMs) {
                    CameraNeoService.this.startWarmKeepAliveTimer(durationMs);
                }

                @Override
                public void startPostCaptureKeepAlive() {
                    CameraNeoService.this.startPostCaptureKeepAlive();
                }

                @Override
                public void cancelKeepAliveTimer() {
                    CameraNeoService.this.cancelKeepAliveTimer();
                }

                @Override
                public void wakeUpScreen() {
                    CameraNeoService.this.wakeUpScreen();
                }

                @Override
                public void stopService() {
                    CameraNeoService.this.stopSelf();
                }

                @Override
                public CameraCoordinator coordinator() {
                    return cameraCoordinator;
                }

                @Override
                public CameraCapabilities capabilities() {
                    return cameraCapabilities;
                }

                @Override
                public Range<Integer> selectedFpsRange() {
                    return selectedFpsRange;
                }

                @Override
                public boolean hasAutoFocus() {
                    return hasAutoFocus;
                }

                @Override
                public CameraSettings cameraSettings() {
                    return mCameraSettings;
                }

                @Override
                public Executor executor() {
                    return executor;
                }

                @Override
                public Handler backgroundHandler() {
                    return backgroundHandler;
                }

                @Override
                public int displayRotation() {
                    return getDisplayRotation();
                }

                @Override
                public boolean videoRecording() {
                    return videoSession != null && videoSession.isRecording();
                }

                @Override
                public CaptureRequest.Builder previewBuilder() {
                    return previewBuilder;
                }

                @Override
                public int userExposureCompensation() {
                    return userExposureCompensation;
                }

                @Override
                public ImuRecorder imuRecorderOrNull() {
                    return mImuRecorder;
                }

                @Override
                public ImuRecorder ensureImuRecorder() {
                    if (mImuRecorder == null) {
                        mImuRecorder = new ImuRecorder(CameraNeoService.this);
                    }
                    return mImuRecorder;
                }

                @Override
                public void cancelImuRecording() {
                    if (mImuRecorder != null) {
                        mImuRecorder.cancel();
                    }
                }
            };

    // Static instance for checking camera status
    private static CameraNeoService sInstance;

    /** Interface for video recording callbacks */
    public interface VideoRecordingCallback {
        void onRecordingStarted(String videoId);

        void onRecordingProgress(String videoId, long durationMs);

        void onRecordingStopped(String videoId, String filePath);

        void onRecordingError(String videoId, String errorMessage);
    }

    /**
     * Check if the camera is currently in use for photo capture or video recording. This relies on
     * the service instance being available.
     *
     * <p>IMPORTANT: This returns false when camera is only kept alive for rapid photos, allowing
     * the kept-alive camera to be closed if needed for other operations.
     *
     * @return true if the camera is actively busy, false if idle or just kept alive.
     */
    public static boolean isCameraInUse() {
        if (sInstance != null) {
            // If camera is kept alive but idle (waiting for next photo), don't block other
            // operations
            if (sInstance.cameraCoordinator.isCameraKeptAlive()
                    && sInstance.photoSession.shotState() == AeStateMachine.ShotState.IDLE) {
                // Camera is kept alive but not actively taking a photo
                // This allows other operations to close the camera if needed
                return false;
            }

            boolean recording =
                    sInstance.videoSession != null && sInstance.videoSession.isRecording();

            // Check if a photo capture session is active (actively taking a photo)
            boolean photoSessionActive =
                    (sInstance.cameraCoordinator.device() != null
                            && sInstance.photoSession.imageReaders() != null
                            && !recording
                            && sInstance.photoSession.shotState() != AeStateMachine.ShotState.IDLE);

            // Return true if actively recording video or taking a photo
            return photoSessionActive || recording;
        }
        return false; // Service not running or instance not set
    }

    /**
     * Predicts whether a photo with the given parameters would be a "warm" capture — one that
     * reuses the already-open camera/ISP instead of paying the 1–2s cold startup cost on Mentra
     * Live. Callers use this to choose between a short feedback sound (warm, capture is quick) and
     * a long one (cold, capture lags behind the button press while the camera spins up).
     *
     * <p>A capture is warm when both hold:
     *
     * <ul>
     *   <li>The HAL session is already open. This includes the case where a previous capture is
     *       still in progress — a rapid second press simply queues behind it (see {@code
     *       enqueuePhotoRequest}) and runs without a cold ISP start, so we must NOT gate on the
     *       shot state being idle.
     *   <li>The open session won't be reconfigured for this request. A differing size, SDK flag,
     *       manual exposure, or a request that needs preview-ZSL buffering ({@code zsl || mfnr})
     *       the open session lacks forces a close + reopen (see {@code
     *       PhotoSession#willReuseConfiguredCamera}), which is effectively a cold start.
     * </ul>
     *
     * @param size requested photo size for the upcoming capture (nullable)
     * @param isFromSdk whether the upcoming capture is an SDK request (vs. a button photo)
     * @param exposureTimeNs requested manual exposure for the upcoming capture, or null for auto
     * @param captureSettings per-request tuning used for resolved {@code zsl}/{@code mfnr}
     *     (nullable / {@link PhotoCaptureSettings#EMPTY} inherits the global defaults)
     * @return true if the upcoming capture would reuse the open camera; false otherwise.
     */
    public static boolean isCameraWarm(
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            @Nullable PhotoCaptureSettings captureSettings) {
        // Read the open-session state under SERVICE_LOCK — the same lock enqueuePhotoRequest()
        // holds — so this prediction is consistent with the state that request will actually see.
        // Without it, a keep-alive expiry / closeCamera() on the background thread could tear down
        // the HAL session between this read and the enqueue, making the short "hot" cue play for a
        // capture that ends up cold-starting.
        synchronized (SERVICE_LOCK) {
            return sInstance != null
                    && sInstance.cameraCoordinator.hasConfiguredCamera()
                    && sInstance.photoSession.willReuseConfiguredCamera(
                            size, isFromSdk, exposureTimeNs, captureSettings);
        }
    }

    /**
     * @deprecated Prefer {@link #isCameraWarm(String, boolean, Long, PhotoCaptureSettings)}.
     */
    @Deprecated
    public static boolean isCameraWarm(String size, boolean isFromSdk, Long exposureTimeNs) {
        return isCameraWarm(size, isFromSdk, exposureTimeNs, null);
    }

    /**
     * Force close the camera if it's only kept alive (not actively in use). This is called when
     * other operations like video/streaming need the camera.
     *
     * @return true if camera was closed, false if camera was busy or not open
     */
    public static boolean closeKeptAliveCamera() {
        if (sInstance != null
                && sInstance.cameraCoordinator.isCameraKeptAlive()
                && sInstance.photoSession.shotState() == AeStateMachine.ShotState.IDLE) {
            Log.d(TAG, "Force closing kept-alive camera for other operation");
            sInstance.cameraCoordinator.closeIfKeptAlive(sInstance::closeCamera);
            sInstance.stopSelf();
            return true;
        }
        return false;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // Initialize hardware manager for LED control
        hardwareManager = HardwareManagerFactory.getInstance(this);
        // Initialize camera settings for vendor-specific features (ZSL, MFNR)
        mCameraSettings = new CameraSettings(this);
        photoSession = new PhotoSession(photoSessionHooks);
        synchronized (SERVICE_LOCK) {
            Log.d(TAG, "CameraNeoService Camera2 service created");
            sInstance = this;
        }
        Log.i(
                TAG,
                "📹 Initializing EIS (Electronic Image Stabilization) - Default state: "
                        + (eisEnabled ? "ENABLED" : "DISABLED"));

        createNotificationChannel();
        showNotification("Camera Service", "Service is running");
        startBackgroundThread();

        // Phase 2.1: video session owns MediaRecorder, recorder surface, IMU sync, timer.
        videoSession = new VideoRecordingSession(this, backgroundHandler, executor, videoHooks);
    }

    /** Bridges {@link VideoRecordingSession} back into the camera service lifecycle. */
    private final VideoRecordingSession.Hooks videoHooks =
            new VideoRecordingSession.Hooks() {
                @Override
                public ImuRecorder ensureImuRecorder() {
                    if (mImuRecorder == null) {
                        mImuRecorder = new ImuRecorder(CameraNeoService.this);
                    }
                    return mImuRecorder;
                }

                @Override
                public ImuRecorder currentImuRecorder() {
                    return mImuRecorder;
                }

                @Override
                public int videoOrientation() {
                    int displayOrientation = getDisplayRotation();
                    return JpegOrientationResolver.lookupJpegOrientation(
                            displayOrientation, JpegOrientationResolver.DEFAULT_VIDEO_ORIENTATION);
                }

                @Override
                public void onSessionTerminated() {
                    closeCamera();
                    conditionalStopSelf();
                }
            };

    /** Bridge {@link VideoRecordingCallback} → {@link VideoRecordingSession.Callback}. */
    private final VideoRecordingSession.Callback videoSessionCallback =
            new VideoRecordingSession.Callback() {
                @Override
                public void onRecordingStarted(String videoId) {
                    VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
                    if (cb != null) cb.onRecordingStarted(videoId);
                }

                @Override
                public void onRecordingProgress(String videoId, long durationMs) {
                    VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
                    if (cb != null) cb.onRecordingProgress(videoId, durationMs);
                }

                @Override
                public void onRecordingStopped(String videoId, String filePath) {
                    VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
                    if (cb != null) cb.onRecordingStopped(videoId, filePath);
                }

                @Override
                public void onRecordingError(String videoId, String errorMessage) {
                    VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
                    if (cb != null) cb.onRecordingError(videoId, errorMessage);
                }
            };

    /**
     * Primary entry point for photo requests - uses global queue to prevent race conditions This
     * method immediately queues the request and ensures only one service instance exists
     *
     * @param context Application context
     * @param filePath File path to save the photo
     * @param size Photo size (small/medium/large)
     * @param enableLed Whether to enable LED flash for this photo
     * @param isFromSdk true for SDK photos (optimized sizes), false for button photos (high
     *     quality)
     * @param exposureTimeNs optional sensor exposure time in nanoseconds for this shot only; {@code
     *     null} = auto exposure
     * @param callback Callback to be notified when photo is captured
     */
    public static void enqueuePhotoRequest(
            Context context,
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            PhotoCaptureCallback callback) {
        enqueuePhotoRequest(
                context, filePath, size, enableLed, isFromSdk, exposureTimeNs, null, callback);
    }

    /**
     * Primary entry point for photo requests - uses global queue to prevent race conditions.
     *
     * @param iso optional sensor sensitivity for manual exposure captures only; {@code null} =
     *     derive ISO from preview metering
     */
    public static void enqueuePhotoRequest(
            Context context,
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureCallback callback) {
        enqueuePhotoRequest(
                context,
                filePath,
                size,
                enableLed,
                isFromSdk,
                exposureTimeNs,
                iso,
                PhotoCaptureSettings.EMPTY,
                callback);
    }

    public static void enqueuePhotoRequest(
            Context context,
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings,
            PhotoCaptureCallback callback) {
        enqueuePhotoRequest(
                context,
                filePath,
                size,
                enableLed,
                isFromSdk,
                exposureTimeNs,
                iso,
                captureSettings,
                false,
                callback);
    }

    /**
     * @param deferDiskWrite when {@code true}, {@code onPhotoCaptured} receives a {@link
     *     CapturedPhoto} as soon as the JPEG bytes are in memory; the disk write runs in the
     *     background. Callers that need the file MUST gate access on its persistence future. See
     *     {@link QueuedPhotoRequest#deferDiskWrite}.
     */
    public static void enqueuePhotoRequest(
            Context context,
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings,
            boolean deferDiskWrite,
            PhotoCaptureCallback callback) {
        enqueuePhotoRequest(
                context,
                filePath,
                size,
                enableLed,
                isFromSdk,
                exposureTimeNs,
                iso,
                captureSettings,
                deferDiskWrite,
                true,
                callback);
    }

    /**
     * RAM-first capture entry point.
     *
     * @param persistToDisk whether the in-memory JPEG should also become a durable photo artifact
     */
    public static void enqueuePhotoRequest(
            Context context,
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings,
            boolean deferDiskWrite,
            boolean persistToDisk,
            PhotoCaptureCallback callback) {
        synchronized (SERVICE_LOCK) {
            // Create and queue the request immediately
            QueuedPhotoRequest request =
                    new QueuedPhotoRequest(
                            filePath,
                            size,
                            enableLed,
                            isFromSdk,
                            exposureTimeNs,
                            iso,
                            captureSettings,
                            deferDiskWrite,
                            persistToDisk,
                            callback);
            QueuedPhotoRequestQueue.getInstance().offer(request);

            Log.d(
                    TAG,
                    "📸 Enqueued photo request: "
                            + request.requestId
                            + " | Queue size: "
                            + QueuedPhotoRequestQueue.getInstance().size()
                            + " | Service active: "
                            + (sInstance != null));
            if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
                Log.i(
                        TAG,
                        "SCAN_PARAMS enqueued requestId="
                                + request.requestId
                                + " isFromSdk="
                                + isFromSdk
                                + " size="
                                + size
                                + " exposureTimeNs="
                                + exposureTimeNs
                                + " iso="
                                + iso
                                + " captureTuning={"
                                + (captureSettings != null
                                        ? captureSettings.describeForLog()
                                        : "null")
                                + "}");
            }

            // Check current service state and act accordingly
            boolean cameraReady =
                    sInstance != null && sInstance.cameraCoordinator.hasConfiguredCamera();
            if (cameraReady) {
                // Fast path - camera is ready, check if idle
                if (sInstance.photoSession.shotState() == AeStateMachine.ShotState.IDLE) {
                    Log.d(TAG, "Camera ready and idle - processing request immediately");
                    // Cancel any pending keep-alive timer to prevent it from closing camera
                    // mid-capture
                    sInstance.cancelKeepAliveTimer();
                    sInstance.dispatchNextPhotoRequest();
                } else {
                    Log.d(
                            TAG,
                            "Camera ready but busy (state: "
                                    + sInstance.photoSession.shotState()
                                    + ") - request queued");
                }
            } else if (sInstance != null) {
                // Service exists but camera/session is not ready yet.
                Log.d(
                        TAG,
                        "Service active but camera not ready - request will be processed when"
                                + " ready");
            } else {
                // Need to start the service
                Log.d(TAG, "Starting service to process photo request");

                Intent intent = new Intent(context, CameraNeoService.class);
                intent.setAction(ACTION_TAKE_PHOTO);
                intent.putExtra("USE_GLOBAL_QUEUE", true);
                try {
                    context.startForegroundService(intent);
                } catch (RuntimeException e) {
                    QueuedPhotoRequestQueue.getInstance().remove(request);
                    throw e;
                }
            }
        }
    }

    /**
     * Warm up the camera without taking a photo: open (if needed) + configure the capture session +
     * start the preview (powering the ISP/sensor and running AE), then hold it warm for {@code
     * durationMs} under the keep-alive timer. A subsequent {@link #enqueuePhotoRequest} of the same
     * {@code size}/{@code exposureTimeNs} reuses the configured session and captures
     * near-instantly.
     *
     * <p>Re-invoking while already warm simply restarts the keep-alive (that IS "keep alive"). No
     * capture, shutter sound, or file is produced.
     *
     * @param size requested resolution tier ("low"/"medium"/"high"/"max")
     * @param exposureTimeNs optional manual shutter in nanoseconds; {@code null} = auto
     * @param durationMs keep-alive TTL in ms; {@code <= 0} uses the ASG default
     * @param mode capture mode ("photo"/"text"); text mode still uses text sensor size/crop
     *     constants on capture, but no longer injects an AE exposure divisor
     * @param callback warm-up lifecycle callback (ready / stopped / error)
     */
    public static void warmUpCamera(
            Context context,
            String size,
            Long exposureTimeNs,
            long durationMs,
            String mode,
            @Nullable PhotoCaptureSettings captureSettings,
            CameraWarmUpCallback callback) {
        CameraWarmUpCallback rejectBusy = null;
        PhotoCaptureSettings warmSettings =
                captureSettings != null ? captureSettings : PhotoCaptureSettings.EMPTY;
        synchronized (SERVICE_LOCK) {
            long ttl = clampWarmUpDuration(durationMs);
            boolean cameraReady =
                    sInstance != null && sInstance.cameraCoordinator.hasConfiguredCamera();
            boolean idle =
                    sInstance != null
                            && sInstance.photoSession.shotState() == AeStateMachine.ShotState.IDLE;
            boolean warmUpInFlight =
                    (sInstance != null && sInstance.photoSession.isWarmingUp())
                            || !sPendingWarmCallbacks.isEmpty();
            boolean warmReusable =
                    cameraReady
                            && idle
                            && !warmUpInFlight
                            && sInstance.photoSession.willReuseConfiguredCamera(
                                    size, true, exposureTimeNs, warmSettings)
                            && (sInstance.warmLeases.isEmpty()
                                    || PhotoMode.normalize(mode).equals(sInstance.warmLeaseMode));

            if (warmReusable) {
                // Already configured + idle for these params — just re-arm the keep-alive.
                Log.d(TAG, "camera_warm_up: camera already warm, restarting keep-alive");
                if (callback != null) {
                    sInstance.addWarmLease(callback, ttl, mode);
                }
                sInstance.armWarmLeaseTimer();
                if (callback != null) {
                    final CameraWarmUpCallback cb = callback;
                    sInstance.executor.execute(
                            () -> {
                                cb.onWarming();
                                sInstance.deliverWarmReady(cb);
                            });
                }
                return;
            }

            // A different camera configuration cannot coexist with ready leases. Keep the current
            // owners valid and let the incompatible caller retry after those leases stop.
            if (cameraReady
                    && idle
                    && !warmUpInFlight
                    && sInstance != null
                    && !sInstance.warmLeases.isEmpty()) {
                rejectBusy = callback;
            }

            // Serialize: keep a single warm-up in flight, and never start one while a capture is in
            // progress. Reject overlapping/mid-capture warm-ups with a retryable busy error that
            // settles only this caller (it isn't bound, so it never reaches the shared callbacks).
            // The caller retries; the camera is about to be warm, so the retry usually hits the
            // already-warm fast path above.
            boolean busy =
                    warmUpInFlight
                            || (sInstance != null
                                    && sInstance.photoSession.shotState()
                                            != AeStateMachine.ShotState.IDLE);
            if (rejectBusy != null || busy) {
                rejectBusy = callback;
            } else {
                sPendingWarmCallbacks.add(callback);

                Intent intent = new Intent(context, CameraNeoService.class);
                intent.setAction(ACTION_WARM_UP_CAMERA);
                intent.putExtra(EXTRA_WARM_UP_SIZE, size);
                intent.putExtra(EXTRA_WARM_UP_DURATION_MS, ttl);
                intent.putExtra(EXTRA_WARM_UP_MODE, mode);
                if (exposureTimeNs != null) {
                    intent.putExtra(EXTRA_WARM_UP_EXPOSURE_NS, exposureTimeNs.longValue());
                }
                if (warmSettings.zsl != null) {
                    intent.putExtra(EXTRA_WARM_UP_ZSL, warmSettings.zsl.booleanValue());
                }
                if (warmSettings.mfnr != null) {
                    intent.putExtra(EXTRA_WARM_UP_MFNR, warmSettings.mfnr.booleanValue());
                }
                context.startForegroundService(intent);
            }
        }
        // Fire outside the lock (this sends a camera_status over BLE). Only the busy rejection is
        // settled here; an accepted warm-up emits `warming` later in performWarmUp, once
        // PhotoSession.setupWarmUp clears its own busy check and actually starts. Emitting
        // `warming`
        // at the entry gate could race a capture that starts before setupWarmUp runs, letting the
        // phone see `warming` immediately followed by `error` (camera_busy).
        if (rejectBusy != null) {
            rejectBusy.onCameraError(CameraOperationError.cameraBusy());
        }
    }

    /**
     * Release one warm-up request. Cancelling while opening rejects the original promise with a
     * terminal cancellation error; releasing a ready lease emits stopped and keeps compatible
     * leases alive.
     */
    public static void stopCameraWarmUp(String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }

        CameraWarmUpCallback cancelled = null;
        CameraWarmUpCallback stopped = null;
        boolean cancelledOpening = false;
        synchronized (SERVICE_LOCK) {
            for (int i = sPendingWarmCallbacks.size() - 1; i >= 0; i--) {
                CameraWarmUpCallback callback = sPendingWarmCallbacks.get(i);
                if (requestId.equals(callback.getRequestId())) {
                    cancelled = callback;
                    cancelledOpening = true;
                    sPendingWarmCallbacks.remove(i);
                    break;
                }
            }

            if (sInstance != null) {
                if (cancelled == null) {
                    for (int i = sInstance.warmCallbacks.size() - 1; i >= 0; i--) {
                        CameraWarmUpCallback callback = sInstance.warmCallbacks.get(i);
                        if (requestId.equals(callback.getRequestId())) {
                            cancelled = callback;
                            cancelledOpening = true;
                            sInstance.warmCallbacks.remove(i);
                            break;
                        }
                    }
                }

                WarmLease lease = sInstance.warmLeases.remove(requestId);
                if (lease != null) {
                    if (sInstance.warmReadyRequestIds.remove(requestId)) {
                        stopped = lease.callback;
                    } else {
                        cancelled = lease.callback;
                    }
                    sInstance.recomputeWarmLeaseDeadline();
                }

                if (cancelledOpening && sInstance.warmCallbacks.isEmpty()) {
                    sInstance.openingWarmMode = null;
                    sInstance.photoSession.cancelWarmUp();
                    sInstance.cancelKeepAliveTimer();
                    sInstance.closeCamera();
                    sInstance.stopSelf();
                } else if (lease != null) {
                    if (sInstance.warmLeases.isEmpty()) {
                        sInstance.warmLeaseMode = null;
                        sInstance.cancelKeepAliveTimer();
                        sInstance.closeCamera();
                        sInstance.stopSelf();
                    } else {
                        sInstance.armWarmLeaseTimer();
                    }
                }
            }
        }

        if (cancelled != null) {
            cancelled.onCameraError(CameraOperationError.warmUpCancelled());
        }
        if (stopped != null) {
            stopped.onCameraStopped();
        }
    }

    private static long clampWarmUpDuration(long durationMs) {
        long ttl = durationMs > 0 ? durationMs : AsgConstants.CAMERA_WARM_UP_DEFAULT_DURATION_MS;
        return Math.min(ttl, AsgConstants.CAMERA_WARM_UP_MAX_DURATION_MS);
    }

    /**
     * Legacy method - redirects to enqueuePhotoRequest for backward compatibility Defaults to SDK
     * photo (isFromSdk=true) for optimized transfer sizes
     *
     * @deprecated Use enqueuePhotoRequest instead
     */
    @Deprecated
    public static void takePictureWithCallback(
            Context context, String filePath, PhotoCaptureCallback callback) {
        enqueuePhotoRequest(context, filePath, null, false, true, null, callback);
    }

    /**
     * Start video recording and get notified through callback
     *
     * @param context Application context
     * @param videoId Unique ID for this video recording session
     * @param filePath File path to save the video
     * @param callback Callback for recording events
     */
    public static void startVideoRecording(
            Context context, String videoId, String filePath, VideoRecordingCallback callback) {
        startVideoRecording(context, videoId, filePath, null, callback);
    }

    /**
     * Start video recording with custom settings
     *
     * @param context Application context
     * @param videoId Unique ID for this video recording session
     * @param filePath File path to save the video
     * @param settings Video settings (resolution, fps) or null for defaults
     * @param callback Callback for recording events
     */
    public static void startVideoRecording(
            Context context,
            String videoId,
            String filePath,
            VideoSettings settings,
            VideoRecordingCallback callback) {
        VideoRecordingSession.setPendingVideoCallback(callback);

        Intent intent = new Intent(context, CameraNeoService.class);
        intent.setAction(ACTION_START_VIDEO_RECORDING);
        intent.putExtra(EXTRA_VIDEO_ID, videoId);
        intent.putExtra(EXTRA_VIDEO_FILE_PATH, filePath);
        if (settings != null) {
            intent.putExtra(EXTRA_VIDEO_SETTINGS + "_width", settings.width);
            intent.putExtra(EXTRA_VIDEO_SETTINGS + "_height", settings.height);
            intent.putExtra(EXTRA_VIDEO_SETTINGS + "_fps", settings.fps);
        }
        context.startForegroundService(intent);
    }

    /**
     * Stop the current video recording session
     *
     * @param context Application context
     * @param videoId ID of the video recording session to stop (must match active session)
     */
    public static void stopVideoRecording(Context context, String videoId) {
        Intent intent = new Intent(context, CameraNeoService.class);
        intent.setAction(ACTION_STOP_VIDEO_RECORDING);
        intent.putExtra(EXTRA_VIDEO_ID, videoId);
        context.startForegroundService(intent);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);

        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            Log.d(TAG, "CameraNeoService received action: " + action);

            switch (action) {
                case ACTION_TAKE_PHOTO:
                    // Phase 1: only the global-queue path is wired up via enqueuePhotoRequest().
                    // The legacy intent-extras path (USE_GLOBAL_QUEUE=false) had zero callers and
                    // was
                    // removed; CameraNeoService is always started via the queue dispatcher now.
                    Log.d(TAG, "Processing photo requests from global queue");
                    dispatchNextPhotoRequest();
                    break;
                case ACTION_START_VIDEO_RECORDING:
                    {
                        String videoId = intent.getStringExtra(EXTRA_VIDEO_ID);
                        String videoPath = intent.getStringExtra(EXTRA_VIDEO_FILE_PATH);
                        if (videoPath == null || videoPath.isEmpty()) {
                            String timeStamp =
                                    new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
                                            .format(new Date());
                            String videoCaptureDir = "VID_" + timeStamp;
                            File videoCaptureDirFile =
                                    new File(MediaStorage.getMediaRoot(this), videoCaptureDir);
                            videoCaptureDirFile.mkdirs();
                            videoPath = new File(videoCaptureDirFile, "base.mp4").getAbsolutePath();
                        }
                        int width = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_width", 0);
                        int height = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_height", 0);
                        int fps = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_fps", 0);
                        VideoSettings settings =
                                (width > 0 && height > 0 && fps > 0)
                                        ? new VideoSettings(width, height, fps)
                                        : null;
                        if (settings != null) {
                            Log.d(TAG, "Using custom video settings: " + settings);
                        }
                        SystemControllerFactory.get(this).setEisEnabled(true);
                        setupCameraAndStartRecording(videoId, videoPath, settings);
                        break;
                    }
                case ACTION_STOP_VIDEO_RECORDING:
                    String videoIdToStop = intent.getStringExtra(EXTRA_VIDEO_ID);
                    videoSession.stopRecording(videoIdToStop);
                    SystemControllerFactory.get(this).setEisEnabled(false);
                    break;
                case ACTION_WARM_UP_CAMERA:
                    {
                        String warmSize = intent.getStringExtra(EXTRA_WARM_UP_SIZE);
                        long warmDuration =
                                intent.getLongExtra(
                                        EXTRA_WARM_UP_DURATION_MS,
                                        AsgConstants.CAMERA_WARM_UP_DEFAULT_DURATION_MS);
                        Long warmExposureNs =
                                intent.hasExtra(EXTRA_WARM_UP_EXPOSURE_NS)
                                        ? intent.getLongExtra(EXTRA_WARM_UP_EXPOSURE_NS, 0L)
                                        : null;
                        String warmMode = intent.getStringExtra(EXTRA_WARM_UP_MODE);
                        PhotoCaptureSettings.Builder warmTuning =
                                new PhotoCaptureSettings.Builder();
                        if (intent.hasExtra(EXTRA_WARM_UP_ZSL)) {
                            warmTuning.zsl(intent.getBooleanExtra(EXTRA_WARM_UP_ZSL, true));
                        }
                        if (intent.hasExtra(EXTRA_WARM_UP_MFNR)) {
                            warmTuning.mfnr(intent.getBooleanExtra(EXTRA_WARM_UP_MFNR, true));
                        }
                        performWarmUp(
                                warmSize,
                                warmExposureNs,
                                warmDuration,
                                warmMode,
                                warmTuning.build());
                        break;
                    }
            }
        }
        return START_STICKY;
    }

    private void dispatchNextPhotoRequest() {
        photoSession.dispatchNextPhotoRequest();
    }

    /**
     * Open (if needed) + configure + preview the camera and hold it warm for {@code durationMs}
     * without capturing. Bridges the warm-up callback into {@link PhotoSession} so {@code ready} is
     * emitted once preview is running and {@code error} on any open/configure failure. Keep-alive
     * expiry emits {@code stopped} (see {@link #startWarmKeepAliveTimer}).
     */
    private void performWarmUp(
            String size,
            Long exposureTimeNs,
            long durationMs,
            String mode,
            @Nullable PhotoCaptureSettings captureSettings) {
        // Use the request's capture settings as-is. Text mode no longer injects an AE exposure
        // divisor; explicit aeExposureDivisor / zsl / mfnr on the request (or globals when omitted)
        // apply the same way as take_photo.
        PhotoCaptureSettings warmCaptureSettings =
                captureSettings != null ? captureSettings : PhotoCaptureSettings.EMPTY;
        // Bind the pending callback(s) AND drive setupWarmUp under one continuous SERVICE_LOCK
        // hold,
        // so warmUpRequest is set before the lock is released. Splitting them lets a second
        // warmUpCamera slip through the entry guard in the gap between clearing the pending list
        // and
        // setupWarmUp setting warmUpRequest; its busy-reject (fireWarmError) would then fail the
        // first caller's callback too. setupWarmUp re-acquires SERVICE_LOCK reentrantly.
        final List<CameraWarmUpCallback> warming;
        synchronized (SERVICE_LOCK) {
            warmCallbacks.addAll(sPendingWarmCallbacks);
            sPendingWarmCallbacks.clear();
            // The owner may have cancelled after the service intent was queued but before it was
            // handled. Do not open an unowned camera.
            if (warmCallbacks.isEmpty()) {
                stopSelf();
                return;
            }
            openingWarmMode = PhotoMode.normalize(mode);
            photoSession.setupWarmUp(
                    size,
                    exposureTimeNs,
                    warmCaptureSettings,
                    durationMs,
                    this::fireWarmReady,
                    this::fireWarmError);
            // setupWarmUp runs its own busy check synchronously and, if a capture slipped in, has
            // already fired fireWarmError (clearing warmCallbacks). The callbacks still bound here
            // are the ones that actually started warming — emit `warming` only for them, so a
            // busy-rejected request never sees `warming` before its `error`. ready/error resolve
            // asynchronously later, so this `warming` always precedes them.
            warming = new ArrayList<>(warmCallbacks);
        }
        for (CameraWarmUpCallback callback : warming) {
            callback.onWarming();
        }
    }

    /** Resolve every in-flight warm-up: the shared camera is warm for all of them. */
    private void fireWarmReady() {
        final List<CameraWarmUpCallback> ready;
        synchronized (SERVICE_LOCK) {
            ready = new ArrayList<>(warmCallbacks);
            warmCallbacks.clear();
            for (CameraWarmUpCallback callback : ready) {
                addWarmLease(callback, callback.getDurationMs(), openingWarmMode);
            }
            openingWarmMode = null;
            armWarmLeaseTimer();
        }
        for (CameraWarmUpCallback callback : ready) {
            deliverWarmReady(callback);
        }
    }

    /** Fail every in-flight warm-up (open/configure failure). */
    private void fireWarmError(CameraOperationError error) {
        final List<CameraWarmUpCallback> failed;
        synchronized (SERVICE_LOCK) {
            failed = new ArrayList<>(warmCallbacks);
            warmCallbacks.clear();
            openingWarmMode = null;
        }
        for (CameraWarmUpCallback callback : failed) {
            callback.onCameraError(error);
        }
    }

    /** Register or refresh one ready request-owned lease. Caller holds {@code SERVICE_LOCK}. */
    private void addWarmLease(CameraWarmUpCallback callback, long durationMs, String mode) {
        if (warmLeases.isEmpty()) {
            warmLeaseMode = PhotoMode.normalize(mode);
        }
        String requestId = warmLeaseKey(callback);
        long deadline = System.currentTimeMillis() + clampWarmUpDuration(durationMs);
        warmReadyRequestIds.remove(requestId);
        warmLeases.put(requestId, new WarmLease(callback, deadline));
        recomputeWarmLeaseDeadline();
    }

    /** Atomically order ready before any concurrent stop for this request. */
    private void deliverWarmReady(CameraWarmUpCallback callback) {
        synchronized (SERVICE_LOCK) {
            String requestId = warmLeaseKey(callback);
            if (!warmLeases.containsKey(requestId)) {
                return;
            }
            warmReadyRequestIds.add(requestId);
            callback.onCameraReady();
        }
    }

    private static String warmLeaseKey(CameraWarmUpCallback callback) {
        String requestId = callback.getRequestId();
        return requestId == null || requestId.isEmpty()
                ? "local-" + System.identityHashCode(callback)
                : requestId;
    }

    /** Remove and return every ready lease. Caller holds {@code SERVICE_LOCK}. */
    private List<CameraWarmUpCallback> drainWarmLeases() {
        List<CameraWarmUpCallback> stopped = new ArrayList<>();
        for (WarmLease lease : warmLeases.values()) {
            stopped.add(lease.callback);
        }
        warmLeases.clear();
        warmReadyRequestIds.clear();
        warmLeaseDeadlineMs = 0;
        warmLeaseMode = null;
        return stopped;
    }

    private void recomputeWarmLeaseDeadline() {
        long latest = 0;
        for (WarmLease lease : warmLeases.values()) {
            latest = Math.max(latest, lease.deadlineMs);
        }
        warmLeaseDeadlineMs = latest;
    }

    private void setupCameraForQueuedRequest(QueuedPhotoRequest request) {
        photoSession.setupCameraForQueuedRequest(request);
    }

    private void setupCameraAndStartRecording(
            String videoId, String filePath, VideoSettings settings) {
        videoSession.setCallback(videoSessionCallback);
        if (!videoSession.prepareRequest(videoId, filePath, settings)) {
            notifyVideoError(videoId, "Already recording another video.");
            return;
        }
        wakeUpScreen();
        openCameraInternal(filePath, true); // true indicates for video
    }

    /** Conditional stop self. */
    private void conditionalStopSelf() {
        stopSelf();
    }

    @SuppressLint("MissingPermission")
    private void openCameraInternal(String filePath, boolean forVideo) {
        CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            Log.e(TAG, "Could not get camera manager");
            if (forVideo)
                notifyVideoError(videoSession.currentVideoId(), "Camera service unavailable");
            else photoSession.notifyHostPhotoError("Camera service unavailable");
            conditionalStopSelf();
            return;
        }

        try {
            // First check if camera permission is granted
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                int cameraPermission = checkSelfPermission(android.Manifest.permission.CAMERA);
                if (cameraPermission != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    Log.e(TAG, "Camera permission not granted");
                    if (forVideo)
                        notifyVideoError(
                                videoSession.currentVideoId(), "Camera permission not granted");
                    else photoSession.notifyHostPhotoError("Camera permission not granted");
                    conditionalStopSelf();
                    return;
                }
            }

            this.cameraId = CameraOpener.selectPrimaryCameraId(manager);

            // Verify that we have a valid camera ID
            if (this.cameraId == null) {
                if (forVideo)
                    notifyVideoError(videoSession.currentVideoId(), "No suitable camera found");
                else photoSession.notifyHostPhotoError("No suitable camera found");
                conditionalStopSelf();
                return;
            }

            // Get characteristics for the selected camera
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(this.cameraId);

            // Initialize MediaTek vendor keys for ZSL/MFNR (if available)
            if (mCameraSettings != null) {
                mCameraSettings.init(characteristics);
                boolean zslSupported = mCameraSettings.isZslSupported();
                boolean mfnrSupported = mCameraSettings.isMfnrSupported();
                Log.d(
                        TAG,
                        "Vendor feature support - ZSL: "
                                + zslSupported
                                + ", MFNR: "
                                + mfnrSupported);
            }

            // Query camera capabilities for dynamic auto-exposure
            queryCameraCapabilities(characteristics);

            // Check if this camera supports JPEG format
            StreamConfigurationMap map = CameraOpener.streamMapOrNull(characteristics);
            if (map == null) {
                if (forVideo)
                    notifyVideoError(
                            videoSession.currentVideoId(),
                            "Camera " + this.cameraId + " doesn't support configuration maps");
                else
                    photoSession.notifyHostPhotoError(
                            "Camera " + this.cameraId + " doesn't support configuration maps");
                stopSelf();
                return;
            }

            // If this is for video, set up video size only
            if (forVideo) {
                // Find a suitable video size
                Size[] videoSizes = CameraOpener.videoOutputSizes(map);

                if (videoSizes == null || videoSizes.length == 0) {
                    notifyVideoError(
                            videoSession.currentVideoId(), "Camera doesn't support MediaRecorder");
                    conditionalStopSelf();
                    return;
                }

                // Log available video sizes with detailed analysis
                Log.i(
                        TAG,
                        "📹 VIDEO RESOLUTION DEBUG - Available video sizes for camera "
                                + this.cameraId
                                + " ("
                                + videoSizes.length
                                + " options):");
                boolean has1080p = false;
                boolean has720p = false;
                boolean has4K = false;
                for (Size size : videoSizes) {
                    String marker = "";
                    if (size.getWidth() == 1920 && size.getHeight() == 1080) {
                        has1080p = true;
                        marker = " ← 1080p";
                    } else if (size.getWidth() == 1280 && size.getHeight() == 720) {
                        has720p = true;
                        marker = " ← 720p";
                    } else if (size.getWidth() == 3840 && size.getHeight() == 2160) {
                        has4K = true;
                        marker = " ← 4K";
                    }
                    Log.i(TAG, "  " + size.getWidth() + "x" + size.getHeight() + marker);
                }
                Log.i(
                        TAG,
                        "📹 Resolution support: 4K="
                                + has4K
                                + ", 1080p="
                                + has1080p
                                + ", 720p="
                                + has720p);

                Size chosenVideoSize =
                        CameraOpener.resolveVideoSize(videoSizes, videoSession.pendingSettings());
                if (chosenVideoSize == null) {
                    notifyVideoError(
                            videoSession.currentVideoId(), "Camera doesn't support MediaRecorder");
                    conditionalStopSelf();
                    return;
                }

                videoSession.setVideoSize(chosenVideoSize);
                try {
                    videoSession.setupMediaRecorder();
                } catch (IOException ioe) {
                    Log.e(TAG, "Error setting up MediaRecorder", ioe);
                    notifyVideoError(
                            videoSession.currentVideoId(),
                            "Failed to set up video recorder: " + ioe.getMessage());
                }
            } else {
                // For photos, find the closest available JPEG size to our target
                Size[] jpegSizes = CameraOpener.jpegOutputSizes(map);
                if (jpegSizes != null) {
                    Log.d(
                            TAG,
                            "AAACamera "
                                    + this.cameraId
                                    + " JPEG output sizes: "
                                    + Arrays.toString(jpegSizes));
                    for (Size size : jpegSizes) {
                        Log.d(
                                TAG,
                                "Camera "
                                        + this.cameraId
                                        + " JPEG size: "
                                        + size.getWidth()
                                        + "x"
                                        + size.getHeight());
                    }
                }
                if (jpegSizes == null || jpegSizes.length == 0) {
                    photoSession.notifyHostPhotoError("Camera doesn't support JPEG format");
                    stopSelf();
                    return;
                }

                boolean fromSdk = photoSession.photoRequestFromSdk();
                String requestedSizeTier = photoSession.photoRequestSizeTier();
                Log.d(
                        TAG,
                        fromSdk
                                ? "SDK photo - using optimized resolution"
                                : "Button photo - using high quality resolution");
                Size chosenJpeg =
                        CameraOpener.resolveJpegSize(jpegSizes, fromSdk, requestedSizeTier);
                if (chosenJpeg == null) {
                    photoSession.notifyHostPhotoError("Camera doesn't support JPEG format");
                    stopSelf();
                    return;
                }

                // Phase 0: preview + still readers are siblings. Still reader is the ONLY target of
                // explicit cameraCaptureSession.capture() calls; preview repeating request targets
                // the
                // small YUV preview reader, so manual-exposure captures no longer compete with
                // auto-exposed
                // preview frames in the same buffer queue.
                photoSession.setJpegSize(chosenJpeg);
                photoSession.prepareStillReaders(filePath, chosenJpeg, backgroundHandler);
            }

            // Open the camera
            if (!cameraCoordinator.tryAcquireOpenCloseLock(2500)) {
                throw new RuntimeException("Time out waiting to lock camera opening.");
            }

            Log.d(TAG, "Opening camera ID: " + this.cameraId);
            try {
                manager.openCamera(
                        this.cameraId, newCameraOpenStateCallback(forVideo), backgroundHandler);
            } catch (Exception e) {
                // The state callback owns the permit only once the open is in flight. If
                // openCamera throws synchronously no callback will ever fire, so release
                // here or every later open times out and every close falls into the
                // 5s proceed-anyway teardown.
                cameraCoordinator.releaseOpenCloseLock();
                throw e;
            }

        } catch (CameraAccessException e) {
            // Handle camera access exceptions more specifically
            Log.e(TAG, "Camera access exception: " + e.getReason(), e);
            String errorMsg = "Could not access camera";

            // Check for specific error reasons
            if (e.getReason() == CameraAccessException.CAMERA_DISABLED) {
                errorMsg =
                        "Camera disabled by policy - please check camera permissions in Settings";
                // Try to recover by restarting the camera service
                Log.d(TAG, "Attempting to restart camera service in safe mode");
                restartCameraServiceIfNeeded();
            } else if (e.getReason() == CameraAccessException.CAMERA_ERROR) {
                errorMsg = "Camera device encountered an error";
            } else if (e.getReason() == CameraAccessException.CAMERA_IN_USE) {
                errorMsg = "Camera is already in use by another app";
                // Try to close other camera sessions
                releaseCameraResources();
            }

            if (forVideo) notifyVideoError(videoSession.currentVideoId(), errorMsg);
            else photoSession.notifyHostPhotoError(errorMsg);
            stopSelf();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted while trying to lock camera", e);
            if (forVideo)
                notifyVideoError(videoSession.currentVideoId(), "Camera operation interrupted");
            else photoSession.notifyHostPhotoError("Camera operation interrupted");
            stopSelf();
        } catch (Exception e) {
            Log.e(TAG, "Error setting up camera", e);
            if (forVideo)
                notifyVideoError(
                        videoSession.currentVideoId(),
                        "Error setting up camera: " + e.getMessage());
            else photoSession.notifyHostPhotoError("Error setting up camera: " + e.getMessage());
            stopSelf();
        }
    }

    /**
     * Single camera-open callback for both photo and video; behavior matches the former {@code
     * photoStateCallback} / {@code videoStateCallback} pair (Phase 2f prep).
     */
    private CameraDevice.StateCallback newCameraOpenStateCallback(final boolean forVideo) {
        return new CameraDevice.StateCallback() {
            // The in-flight open owns exactly one open/close permit, surrendered to the
            // FIRST terminal callback. onDisconnected/onError also fire long after
            // onOpened (HAL eviction, cable events); an unconditional release there
            // inflated the Semaphore(1) past one permit, after which the open/close
            // lock excluded nothing and teardown could interleave with any open — the
            // cheap way to hit the OS-1816 crash repeatedly.
            private final AtomicBoolean openPermitReleased = new AtomicBoolean(false);

            private void releaseOpenPermitOnce() {
                if (openPermitReleased.compareAndSet(false, true)) {
                    cameraCoordinator.releaseOpenCloseLock();
                }
            }

            @Override
            public void onOpened(@NonNull CameraDevice camera) {
                Log.d(TAG, "Camera device opened successfully");
                cameraCoordinator.setDevice(camera);

                // Hold the open/close lock until the session surfaces have been handed to
                // the framework: releasing it first lets closeCamera() close the
                // ImageReaders on another thread mid-setup, abandoning the surfaces this
                // session is about to wrap (OS-1816).
                try {
                    createCameraSessionInternal(forVideo);
                } finally {
                    releaseOpenPermitOnce();
                }
            }

            @Override
            public void onDisconnected(@NonNull CameraDevice camera) {
                Log.d(TAG, "Camera device disconnected");
                releaseOpenPermitOnce();
                camera.close();
                cameraCoordinator.clearDevice();
                if (forVideo) {
                    notifyVideoError(videoSession.currentVideoId(), "Camera disconnected");
                } else {
                    photoSession.notifyHostPhotoError("Camera disconnected");
                }
                stopSelf();
            }

            @Override
            public void onError(@NonNull CameraDevice camera, int error) {
                CameraOperationError cameraError =
                        CameraOperationError.fromCameraDeviceError(error);
                Log.e(
                        TAG,
                        "Camera open failed: "
                                + cameraError.code()
                                + " (Android code "
                                + error
                                + ")");
                releaseOpenPermitOnce();
                camera.close();
                cameraCoordinator.clearDevice();
                if (forVideo) {
                    notifyVideoError(videoSession.currentVideoId(), cameraError.message());
                } else {
                    photoSession.notifyHostPhotoError(cameraError);
                }
                stopSelf();
            }
        };
    }

    private void createCameraSessionInternal(boolean forVideo) {
        try {
            CameraDevice activeCameraDevice = cameraCoordinator.device();
            if (activeCameraDevice == null) {
                Log.e(TAG, "Camera device is null in createCameraSessionInternal");
                if (forVideo)
                    notifyVideoError(videoSession.currentVideoId(), "Camera not initialized");
                else photoSession.notifyHostPhotoError("Camera not initialized");
                stopSelf();
                return;
            }

            List<Surface> surfaces = new ArrayList<>();
            if (forVideo) {
                Surface recSurface = videoSession.recorderSurface();
                if (recSurface == null) {
                    notifyVideoError(videoSession.currentVideoId(), "Recorder surface null");
                    conditionalStopSelf();
                    return;
                }
                surfaces.add(recSurface);
                previewBuilder =
                        activeCameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                previewBuilder.addTarget(recSurface);
            } else {
                ImageReaderTwin readers = photoSession.imageReaders();
                if (readers == null) {
                    photoSession.notifyHostPhotoError("ImageReader surface null");
                    stopSelf();
                    return;
                }
                // Phase 0: both surfaces are session outputs; preview repeating request targets the
                // YUV preview reader only — still reader is reserved for explicit capture() calls.
                surfaces.addAll(readers.surfaces());

                previewBuilder =
                        activeCameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                previewBuilder.addTarget(readers.getPreviewSurface());
                Log.d(
                        TAG,
                        "🔍 Using TEMPLATE_PREVIEW for repeating request, target=previewReader (ZSL"
                                + " compatible)");
            }

            VideoSettings pendingSettings = videoSession.pendingSettings();
            int videoFps = (pendingSettings != null) ? pendingSettings.fps : 30;
            Size sizeForMetering =
                    forVideo
                            ? videoSession.videoSize()
                            : new Size(
                                    ImageReaderTwin.PREVIEW_WIDTH, ImageReaderTwin.PREVIEW_HEIGHT);
            int displayOrientation = getDisplayRotation();
            int jpegOrientation =
                    JpegOrientationResolver.lookupJpegOrientation(
                            displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);

            PreviewRequestConfigurator.configure(
                    previewBuilder,
                    forVideo,
                    videoFps,
                    eisEnabled,
                    selectedFpsRange,
                    hasAutoFocus,
                    userExposureCompensation,
                    sizeForMetering,
                    photoSession.previewJpegQuality(),
                    jpegOrientation,
                    mCameraSettings,
                    forVideo ? false : photoSession.previewZslEnabled());

            CameraCaptureSession.StateCallback sessionStateCallback =
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(@NonNull CameraCaptureSession session) {
                            Handler handler;
                            CameraDevice device;
                            synchronized (SERVICE_LOCK) {
                                handler = backgroundHandler;
                                device = cameraCoordinator.device();
                                if (handler == null || device == null) {
                                    Log.w(
                                            TAG,
                                            "onConfigured after camera teardown; closing session");
                                    session.close();
                                    return;
                                }
                                cameraCoordinator.setSession(session);
                            }

                            if (forVideo) {
                                try {
                                    videoSession.startRecording(
                                            cameraCoordinator.session(), previewBuilder);
                                } catch (CameraAccessException
                                        | IllegalArgumentException
                                        | IllegalStateException ce) {
                                    // IllegalArgumentException: the recorder surface was
                                    // released by a racing teardown. IllegalStateException:
                                    // the session was closed under us. Same crash family as
                                    // the photo path (OS-1816). Tear down like
                                    // onConfigureFailed does — reporting the error while
                                    // leaving device/session/recorder alive would hold the
                                    // camera hostage for every later open.
                                    Log.e(TAG, "Failed to start video recording", ce);
                                    notifyVideoError(
                                            videoSession.currentVideoId(),
                                            "Failed to start recording: " + ce.getMessage());
                                    closeCamera();
                                    conditionalStopSelf();
                                }
                            } else {
                                Log.d(TAG, "Camera session configured and ready");

                                // During a warm-up the synthetic warm request is already the active
                                // capture; polling here would let a take_photo that raced in hijack
                                // it and then get dropped when warm-up parks. Skip the poll while
                                // warming — finishWarmUpReady() dispatches any queued photo after
                                // the
                                // session is warm.
                                if (!photoSession.isWarmingUp()) {
                                    photoSession.pollFirstQueuedRequestIntoCurrent();
                                }

                                // Start proper preview for photos with AE state monitoring
                                photoSession.startPreviewWithAeMonitoring();
                            }
                        }

                        @Override
                        public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                            Handler handler;
                            CameraDevice device;
                            synchronized (SERVICE_LOCK) {
                                handler = backgroundHandler;
                                device = cameraCoordinator.device();
                            }
                            if (handler == null || device == null) {
                                Log.w(TAG, "onConfigureFailed after camera teardown; ignoring");
                                session.close();
                                return;
                            }
                            Log.e(
                                    TAG,
                                    "Failed to configure camera session for "
                                            + (forVideo ? "video" : "photo"));
                            if (forVideo)
                                notifyVideoError(
                                        videoSession.currentVideoId(),
                                        "Failed to configure camera for video");
                            else
                                photoSession.notifyHostPhotoError(
                                        "Failed to configure camera for photo");
                            conditionalStopSelf();
                        }
                    };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                List<OutputConfiguration> outputConfigurations = new ArrayList<>();
                for (Surface surface : surfaces) {
                    outputConfigurations.add(new OutputConfiguration(surface));
                }
                Executor sessionExecutor =
                        backgroundHandler != null
                                ? new HandlerExecutor(backgroundHandler)
                                : executor;
                SessionConfiguration config =
                        new SessionConfiguration(
                                SessionConfiguration.SESSION_REGULAR,
                                outputConfigurations,
                                sessionExecutor,
                                sessionStateCallback);
                activeCameraDevice.createCaptureSession(config);
            } else {
                activeCameraDevice.createCaptureSession(
                        surfaces, sessionStateCallback, backgroundHandler);
            }
        } catch (CameraAccessException e) {
            Log.e(TAG, "Camera access exception in createCameraSessionInternal", e);
            if (forVideo) notifyVideoError(videoSession.currentVideoId(), "Camera access error");
            else photoSession.notifyHostPhotoError("Camera access error");
            conditionalStopSelf();
        } catch (IllegalStateException e) {
            Log.e(TAG, "Illegal state in createCameraSessionInternal", e);
            if (forVideo) notifyVideoError(videoSession.currentVideoId(), "Camera illegal state");
            else photoSession.notifyHostPhotoError("Camera illegal state");
            conditionalStopSelf();
        } catch (IllegalArgumentException e) {
            // A teardown that raced this setup abandons the reader/recorder surfaces;
            // OutputConfiguration and createCaptureSession then throw
            // IllegalArgumentException ("Surface was abandoned"). Fail the request
            // instead of crashing the process (OS-1816).
            Log.e(TAG, "Camera surface no longer valid in createCameraSessionInternal", e);
            if (forVideo)
                notifyVideoError(videoSession.currentVideoId(), "Camera surface no longer valid");
            else photoSession.notifyHostPhotoError("Camera surface no longer valid");
            conditionalStopSelf();
        }
    }

    private void notifyVideoError(String videoId, String errorMessage) {
        if (videoSession != null) {
            videoSession.notifyError(videoId, errorMessage);
        } else {
            VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
            if (cb != null && videoId != null) {
                executor.execute(() -> cb.onRecordingError(videoId, errorMessage));
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        List<CameraWarmUpCallback> warmErrors = new ArrayList<>();
        List<CameraWarmUpCallback> warmStops = new ArrayList<>();
        synchronized (SERVICE_LOCK) {
            Log.d(TAG, "CameraNeoService service destroying");

            // Cancel keep-alive timer if it's running
            cancelKeepAliveTimer();
            if (videoSession != null && videoSession.isRecording()) {
                videoSession.stopRecording(videoSession.currentVideoId());
            }
            closeCamera();
            releaseWakeLocks();

            sInstance = null;

            QueuedPhotoRequestQueue.getInstance()
                    .failAllPending("Camera service terminated unexpectedly");
            warmErrors.addAll(sPendingWarmCallbacks);
            sPendingWarmCallbacks.clear();
            warmErrors.addAll(warmCallbacks);
            warmCallbacks.clear();
            warmStops.addAll(drainWarmLeases());
        }
        for (CameraWarmUpCallback callback : warmErrors) {
            callback.onCameraError("Camera service terminated unexpectedly");
        }
        for (CameraWarmUpCallback callback : warmStops) {
            callback.onCameraStopped();
        }
        // API 28+ session callbacks run on backgroundHandler and also take SERVICE_LOCK to detect
        // teardown. Do not join the handler thread while holding that lock.
        stopBackgroundThread();
    }

    /** Start background thread */
    private void startBackgroundThread() {
        backgroundHandler = cameraCoordinator.startBackgroundThread("CameraNeoBackground");
    }

    /** Stop background thread */
    private void stopBackgroundThread() {
        cameraCoordinator.stopBackgroundThread();
        backgroundHandler = null;
    }

    /** Close camera resources */
    private void closeCamera() {
        warmLeaseDeadlineMs = 0;
        boolean lockAcquired = false;
        try {
            lockAcquired = cameraCoordinator.tryAcquireOpenCloseLock(5000);
            if (!lockAcquired) {
                Log.e(
                        TAG,
                        "closeCamera: Failed to acquire lock within 5 seconds, proceeding with"
                                + " cleanup anyway");
            }
            cameraCoordinator.closeDeviceAndSession();
            photoSession.closeImageReadersIfPresent();
            photoSession.onCameraClosed();
            if (videoSession != null) {
                videoSession.release();
            }
            // Reset keep-alive flag when camera is actually closed
            cameraCoordinator.markCameraClosed();

            releaseWakeLocks();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted while closing camera", e);
        } finally {
            if (lockAcquired) {
                cameraCoordinator.releaseOpenCloseLock();
            }
        }
    }

    /** Start the keep-alive timer to keep camera open for rapid successive shots */
    private void startKeepAliveTimer() {
        cameraCoordinator.startKeepAlive(
                CAMERA_KEEP_ALIVE_MS,
                () -> photoSession.shotState() != AeStateMachine.ShotState.IDLE,
                () -> {
                    // Tear down under SERVICE_LOCK so this background-thread close is atomic with
                    // respect to isCameraWarm() and enqueuePhotoRequest(), which both take the same
                    // lock. Otherwise the close could land between a warm read and the enqueue,
                    // making the short "hot" cue play for a capture that actually cold-starts.
                    // Lock order is SERVICE_LOCK -> openCloseLock (closeCamera takes openCloseLock
                    // internally), matching every other path, so this cannot deadlock.
                    synchronized (SERVICE_LOCK) {
                        closeCamera();
                        stopSelf();
                    }
                });
    }

    /**
     * Keep-alive used by {@code camera_warm_up}: holds the open/configured camera (preview running,
     * parked at IDLE) for {@code durationMs} so a subsequent take_photo reuses the warm session.
     * When the timer expires the camera is closed and the service stops, emitting {@code stopped}.
     * The {@code shouldExtend} predicate is identical to the photo keep-alive — it never tears down
     * the camera out from under an in-flight capture.
     */
    private void startWarmKeepAliveTimer(long durationMs) {
        long ttl = clampWarmUpDuration(durationMs);
        cameraCoordinator.startKeepAlive(
                ttl,
                () -> photoSession.shotState() != AeStateMachine.ShotState.IDLE,
                this::expireWarmLeases);
    }

    /** Arm the next per-owner lease deadline while leaving later compatible leases intact. */
    private void armWarmLeaseTimer() {
        if (warmLeases.isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        long earliest = Long.MAX_VALUE;
        for (WarmLease lease : warmLeases.values()) {
            earliest = Math.min(earliest, lease.deadlineMs);
        }
        long delay = Math.max(1L, earliest - now);
        cameraCoordinator.startKeepAlive(
                delay,
                () -> photoSession.shotState() != AeStateMachine.ShotState.IDLE,
                this::expireWarmLeases);
    }

    private void expireWarmLeases() {
        expireWarmLeases(true);
    }

    private void expireWarmLeases(boolean closeWhenEmpty) {
        List<CameraWarmUpCallback> expired = new ArrayList<>();
        boolean close;
        synchronized (SERVICE_LOCK) {
            long now = System.currentTimeMillis();
            warmLeases
                    .entrySet()
                    .removeIf(
                            entry -> {
                                if (entry.getValue().deadlineMs <= now) {
                                    expired.add(entry.getValue().callback);
                                    warmReadyRequestIds.remove(entry.getKey());
                                    return true;
                                }
                                return false;
                            });
            recomputeWarmLeaseDeadline();
            close = warmLeases.isEmpty();
            if (close) {
                warmLeaseMode = null;
                if (closeWhenEmpty) {
                    closeCamera();
                    stopSelf();
                }
            } else {
                armWarmLeaseTimer();
            }
        }
        for (CameraWarmUpCallback callback : expired) {
            callback.onCameraStopped();
        }
    }

    /**
     * Arm the keep-alive that should run after a photo settles. If a {@code camera_warm_up} lease
     * is still within its TTL, re-arm the warm keep-alive for the lease's remaining time (never
     * shorter than the normal photo keep-alive) so a take_photo taken inside the warm window
     * doesn't shorten the lease the caller reserved or swallow its {@code stopped} event. Otherwise
     * use the normal short photo keep-alive.
     */
    private void startPostCaptureKeepAlive() {
        long remaining = warmLeaseDeadlineMs - System.currentTimeMillis();
        if (remaining > 0) {
            // Expire any shorter owner leases that elapsed during capture, then keep the camera for
            // the next live owner. armWarmLeaseTimer() uses the next independent deadline.
            expireWarmLeases();
        } else {
            if (warmLeaseDeadlineMs > 0) {
                // The warm lease expired while a capture was in flight — the warm keep-alive had
                // been cancelled for the capture, so its expiry never fired notifyWarmStopped. Emit
                // the lease's stopped event now so clients still see the lease end per the
                // contract,
                // then fall back to the normal short photo keep-alive for rapid-fire grace.
                expireWarmLeases(false);
            }
            if (warmLeases.isEmpty()) {
                startKeepAliveTimer();
            }
        }
    }

    /** Cancel the keep-alive timer */
    private void cancelKeepAliveTimer() {
        cameraCoordinator.cancelKeepAlive();
    }

    /** Release wake locks to avoid battery drain */
    private void releaseWakeLocks() {
        // Use the WakeLockManager to release all wake locks
        WakeLockManager.release(WakeLockManager.WakeOwner.CAMERA);
    }

    /** Force the screen to turn on so camera can be accessed */
    private void wakeUpScreen() {
        Log.d(TAG, "Waking up screen for camera access");
        // Use the WakeLockManager to acquire both CPU and screen wake locks
        WakeLockManager.acquireFullWakeLockAndBringToForeground(
                this, WakeLockManager.WakeOwner.CAMERA, 180000, 5000);
    }

    /** Attempt to restart the camera service with different parameters if needed */
    private void restartCameraServiceIfNeeded() {
        CameraRecoveryHelper.restartCameraServiceIfNeeded(
                this::releaseCameraResources,
                this,
                () -> cameraId,
                id -> cameraId = id,
                this::wakeUpScreen,
                () -> cameraCoordinator.closeDeviceAndSession());
    }

    /** Release all camera system resources */
    private void releaseCameraResources() {
        CameraRecoveryHelper.releaseCameraResources(
                this::closeCamera, () -> cameraCoordinator.closeDeviceAndSession(), this);
    }

    // -----------------------------------------------------------------------------------
    // Notification handling
    // -----------------------------------------------------------------------------------

    private void showNotification(String title, String message) {
        CameraServiceNotification.showForeground(this, CHANNEL_ID, NOTIFICATION_ID, title, message);
    }

    private void createNotificationChannel() {
        CameraServiceNotification.createNotificationChannel(this, CHANNEL_ID);
    }

    /** Query camera capabilities for dynamic auto-exposure */
    private void queryCameraCapabilities(CameraCharacteristics characteristics) {
        // Get available AE modes
        availableAeModes = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES);
        if (availableAeModes == null) {
            availableAeModes = new int[] {CaptureRequest.CONTROL_AE_MODE_ON};
        }

        // Get exposure compensation range and step
        exposureCompensationRange =
                characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        if (exposureCompensationRange == null) {
            exposureCompensationRange = Range.create(-2, 2); // Default range
        }

        exposureCompensationStep =
                characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        if (exposureCompensationStep == null) {
            exposureCompensationStep = new Rational(1, 6); // Default 1/6 EV step
        }

        // Get available FPS ranges; selection logic lives in {@link FpsRangePolicy}.
        availableFpsRanges =
                characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (availableFpsRanges == null || availableFpsRanges.length == 0) {
            selectedFpsRange = FpsRangePolicy.DEFAULT_FPS_RANGE;
        } else {
            selectedFpsRange = FpsRangePolicy.chooseOptimalFpsRange(availableFpsRanges);
            Log.d(
                    TAG,
                    "Selected FPS range: "
                            + selectedFpsRange
                            + " from "
                            + availableFpsRanges.length
                            + " advertised ranges");
        }

        // Phase 3 prep: AF + manual-sensor capabilities bundled into one immutable value object.
        cameraCapabilities = CameraCapabilities.from(characteristics);
        hasAutoFocus = cameraCapabilities.hasContinuousPictureAf;

        Log.d(
                TAG,
                "Camera capabilities - AE modes: " + java.util.Arrays.toString(availableAeModes));
        Log.d(
                TAG,
                "Exposure compensation range: "
                        + exposureCompensationRange
                        + ", step: "
                        + exposureCompensationStep);
        Log.d(TAG, "Selected FPS range: " + selectedFpsRange);
        Log.d(
                TAG,
                "Autofocus available: "
                        + hasAutoFocus
                        + ", min focus distance: "
                        + cameraCapabilities.minimumFocusDistance);
        Log.d(
                TAG,
                "Manual sensor: supported="
                        + cameraCapabilities.manualSensorSupported
                        + ", exposureNsRange="
                        + cameraCapabilities.sensorExposureTimeRange
                        + ", maxFrameDurationNs="
                        + cameraCapabilities.sensorMaxFrameDurationNs
                        + ", isoRange="
                        + cameraCapabilities.sensorSensitivityRange);
    }
}
