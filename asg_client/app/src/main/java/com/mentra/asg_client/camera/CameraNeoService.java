package com.mentra.asg_client.camera;

import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.SysControl;

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

import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.utils.WakeLockManager;

import androidx.annotation.NonNull;
import androidx.lifecycle.LifecycleService;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

import com.mentra.asg_client.camera.lifecycle.CameraCoordinator;
import com.mentra.asg_client.camera.lifecycle.CameraOpener;
import com.mentra.asg_client.camera.lifecycle.CameraRecoveryHelper;
import com.mentra.asg_client.camera.lifecycle.CameraServiceNotification;
import com.mentra.asg_client.camera.lifecycle.ImageReaderTwin;
import com.mentra.asg_client.camera.lifecycle.PhotoSession;
import com.mentra.asg_client.camera.lifecycle.VideoRecordingSession;
import com.mentra.asg_client.camera.model.QueuedPhotoRequest;
import com.mentra.asg_client.camera.model.QueuedPhotoRequestQueue;
import com.mentra.asg_client.camera.policy.AeStateMachine;
import com.mentra.asg_client.camera.policy.CameraCapabilities;
import com.mentra.asg_client.camera.policy.FpsRangePolicy;
import com.mentra.asg_client.camera.policy.JpegOrientationResolver;
import com.mentra.asg_client.camera.request.PreviewRequestConfigurator;

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
    private static final long CAMERA_KEEP_ALIVE_MS = 3000; // Keep camera open for 3 seconds after photo

    private IHardwareManager hardwareManager;
    
    // MediaTek vendor-specific camera settings (ZSL, MFNR)
    private CameraSettings mCameraSettings;

    /** Photo capture lifecycle (queue, AE, still/HDR, image save). */
    private PhotoSession photoSession;

    // IMU recorder for bundling sensor data with captured media
    private com.mentra.asg_client.sensors.ImuRecorder mImuRecorder;

    // Camera characteristics for dynamic auto-exposure and autofocus
    private int[] availableAeModes;
    private Range<Integer> exposureCompensationRange;
    private Rational exposureCompensationStep;
    private Range<Integer>[] availableFpsRanges;
    private Range<Integer> selectedFpsRange;

    /** Cached for per-request manual still capture (not persisted). */
    /**
     * Phase 3 prep: bundled AF + manual-sensor capabilities for the currently open camera.
     * Replaces the prior scattered {@code manualSensorSupported}/{@code sensorExposureTimeRange}/
     * {@code sensorMaxFrameDurationNs}/{@code sensorSensitivityRange}/{@code availableAfModes}/
     * {@code minimumFocusDistance}/{@code hasAutoFocus} fields. Null until
     * {@link #queryCameraCapabilities} runs.
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
    public static final String ACTION_START_VIDEO_RECORDING = "com.augmentos.camera.ACTION_START_VIDEO_RECORDING";
    public static final String ACTION_STOP_VIDEO_RECORDING = "com.augmentos.camera.ACTION_STOP_VIDEO_RECORDING";
    public static final String EXTRA_VIDEO_FILE_PATH = "com.augmentos.camera.EXTRA_VIDEO_FILE_PATH";
    public static final String EXTRA_VIDEO_ID = "com.augmentos.camera.EXTRA_VIDEO_ID";
    public static final String EXTRA_VIDEO_SETTINGS = "com.augmentos.camera.EXTRA_VIDEO_SETTINGS";

    // Callback interface for photo capture
    public interface PhotoCaptureCallback {
        void onPhotoCaptured(String filePath);
        void onPhotoError(String errorMessage);
    }

    // Video recording — owned by VideoRecordingSession (Phase 2.1).
    private VideoRecordingSession videoSession;

    private final PhotoSession.Hooks photoSessionHooks = new PhotoSession.Hooks() {
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
        public com.mentra.asg_client.sensors.ImuRecorder imuRecorderOrNull() {
            return mImuRecorder;
        }

        @Override
        public com.mentra.asg_client.sensors.ImuRecorder ensureImuRecorder() {
            if (mImuRecorder == null) {
                mImuRecorder = new com.mentra.asg_client.sensors.ImuRecorder(CameraNeoService.this);
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

    /**
     * Interface for video recording callbacks
     */
    public interface VideoRecordingCallback {
        void onRecordingStarted(String videoId);

        void onRecordingProgress(String videoId, long durationMs);

        void onRecordingStopped(String videoId, String filePath);

        void onRecordingError(String videoId, String errorMessage);
    }

    /**
     * Check if the camera is currently in use for photo capture or video recording.
     * This relies on the service instance being available.
     * 
     * IMPORTANT: This returns false when camera is only kept alive for rapid photos,
     * allowing the kept-alive camera to be closed if needed for other operations.
     *
     * @return true if the camera is actively busy, false if idle or just kept alive.
     */
    public static boolean isCameraInUse() {
        if (sInstance != null) {
            // If camera is kept alive but idle (waiting for next photo), don't block other operations
            if (sInstance.cameraCoordinator.isCameraKeptAlive()
                    && sInstance.photoSession.shotState() == AeStateMachine.ShotState.IDLE) {
                // Camera is kept alive but not actively taking a photo
                // This allows other operations to close the camera if needed
                return false;
            }
            
            boolean recording = sInstance.videoSession != null && sInstance.videoSession.isRecording();

            // Check if a photo capture session is active (actively taking a photo)
            boolean photoSessionActive = (sInstance.cameraCoordinator.device() != null && sInstance.photoSession.imageReaders() != null &&
                                         !recording && sInstance.photoSession.shotState() != AeStateMachine.ShotState.IDLE);

            // Return true if actively recording video or taking a photo
            return photoSessionActive || recording;
        }
        return false; // Service not running or instance not set
    }

    /**
     * Force close the camera if it's only kept alive (not actively in use).
     * This is called when other operations like video/streaming need the camera.
     * @return true if camera was closed, false if camera was busy or not open
     */
    public static boolean closeKeptAliveCamera() {
        if (sInstance != null && sInstance.cameraCoordinator.isCameraKeptAlive()
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
        Log.i(TAG, "📹 Initializing EIS (Electronic Image Stabilization) - Default state: " + 
                  (eisEnabled ? "ENABLED" : "DISABLED"));
        
        createNotificationChannel();
        showNotification("Camera Service", "Service is running");
        startBackgroundThread();

        // Phase 2.1: video session owns MediaRecorder, recorder surface, IMU sync, timer.
        videoSession = new VideoRecordingSession(this, backgroundHandler, executor, videoHooks);
    }

    /** Bridges {@link VideoRecordingSession} back into the camera service lifecycle. */
    private final VideoRecordingSession.Hooks videoHooks = new VideoRecordingSession.Hooks() {
        @Override
        public com.mentra.asg_client.sensors.ImuRecorder ensureImuRecorder() {
            if (mImuRecorder == null) {
                mImuRecorder = new com.mentra.asg_client.sensors.ImuRecorder(CameraNeoService.this);
            }
            return mImuRecorder;
        }

        @Override
        public com.mentra.asg_client.sensors.ImuRecorder currentImuRecorder() {
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
        @Override public void onRecordingStarted(String videoId) {
            VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
            if (cb != null) cb.onRecordingStarted(videoId);
        }
        @Override public void onRecordingProgress(String videoId, long durationMs) {
            VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
            if (cb != null) cb.onRecordingProgress(videoId, durationMs);
        }
        @Override public void onRecordingStopped(String videoId, String filePath) {
            VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
            if (cb != null) cb.onRecordingStopped(videoId, filePath);
        }
        @Override public void onRecordingError(String videoId, String errorMessage) {
            VideoRecordingCallback cb = VideoRecordingSession.pendingVideoCallback();
            if (cb != null) cb.onRecordingError(videoId, errorMessage);
        }
    };

    /**
     * Primary entry point for photo requests - uses global queue to prevent race conditions
     * This method immediately queues the request and ensures only one service instance exists
     *
     * @param context Application context
     * @param filePath File path to save the photo
     * @param size Photo size (small/medium/large)
     * @param enableLed Whether to enable LED flash for this photo
     * @param isFromSdk true for SDK photos (optimized sizes), false for button photos (high quality)
     * @param exposureTimeNs optional sensor exposure time in nanoseconds for this shot only; {@code null} = auto exposure
     * @param callback Callback to be notified when photo is captured
     */
    public static void enqueuePhotoRequest(Context context, String filePath, String size, boolean enableLed, boolean isFromSdk, Long exposureTimeNs, PhotoCaptureCallback callback) {
        synchronized (SERVICE_LOCK) {
            // Create and queue the request immediately
            QueuedPhotoRequest request =
                    new QueuedPhotoRequest(filePath, size, enableLed, isFromSdk, exposureTimeNs, callback);
            QueuedPhotoRequestQueue.getInstance().offer(request);
            
            Log.d(TAG, "📸 Enqueued photo request: " + request.requestId + 
                      " | Queue size: " + QueuedPhotoRequestQueue.getInstance().size() + 
                      " | Service active: " + (sInstance != null));
            
            // Check current service state and act accordingly
            boolean cameraReady = sInstance != null
                    && sInstance.cameraCoordinator.hasConfiguredCamera();
            if (cameraReady) {
                // Fast path - camera is ready, check if idle
                if (sInstance.photoSession.shotState() == AeStateMachine.ShotState.IDLE) {
                    Log.d(TAG, "Camera ready and idle - processing request immediately");
                    // Cancel any pending keep-alive timer to prevent it from closing camera mid-capture
                    sInstance.cancelKeepAliveTimer();
                    sInstance.dispatchNextPhotoRequest();
                } else {
                    Log.d(TAG, "Camera ready but busy (state: " + sInstance.photoSession.shotState() + ") - request queued");
                }
            } else if (sInstance != null) {
                // Service exists but camera/session is not ready yet.
                Log.d(TAG, "Service active but camera not ready - request will be processed when ready");
            } else {
                // Need to start the service
                Log.d(TAG, "Starting service to process photo request");
                
                Intent intent = new Intent(context, CameraNeoService.class);
                intent.setAction(ACTION_TAKE_PHOTO);
                intent.putExtra("USE_GLOBAL_QUEUE", true);
                context.startForegroundService(intent);
            }
        }
    }

    /**
     * Legacy method - redirects to enqueuePhotoRequest for backward compatibility
     * Defaults to SDK photo (isFromSdk=true) for optimized transfer sizes
     *
     * @deprecated Use enqueuePhotoRequest instead
     */
    @Deprecated
    public static void takePictureWithCallback(Context context, String filePath, PhotoCaptureCallback callback) {
        enqueuePhotoRequest(context, filePath, null, false, true, null, callback);
    }

    /**
     * Start video recording and get notified through callback
     *
     * @param context  Application context
     * @param videoId  Unique ID for this video recording session
     * @param filePath File path to save the video
     * @param callback Callback for recording events
     */
    public static void startVideoRecording(Context context, String videoId, String filePath, VideoRecordingCallback callback) {
        startVideoRecording(context, videoId, filePath, null, callback);
    }
    
    /**
     * Start video recording with custom settings
     *
     * @param context  Application context
     * @param videoId  Unique ID for this video recording session
     * @param filePath File path to save the video
     * @param settings Video settings (resolution, fps) or null for defaults
     * @param callback Callback for recording events
     */
    public static void startVideoRecording(Context context, String videoId, String filePath, VideoSettings settings, VideoRecordingCallback callback) {
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
                    // The legacy intent-extras path (USE_GLOBAL_QUEUE=false) had zero callers and was
                    // removed; CameraNeoService is always started via the queue dispatcher now.
                    Log.d(TAG, "Processing photo requests from global queue");
                    dispatchNextPhotoRequest();
                    break;
                case ACTION_START_VIDEO_RECORDING: {
                    String videoId = intent.getStringExtra(EXTRA_VIDEO_ID);
                    String videoPath = intent.getStringExtra(EXTRA_VIDEO_FILE_PATH);
                    if (videoPath == null || videoPath.isEmpty()) {
                        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                        String videoCaptureDir = "VID_" + timeStamp;
                        File videoCaptureDirFile = new File(getExternalFilesDir(null), videoCaptureDir);
                        videoCaptureDirFile.mkdirs();
                        videoPath = new File(videoCaptureDirFile, "base.mp4").getAbsolutePath();
                    }
                    int width = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_width", 0);
                    int height = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_height", 0);
                    int fps = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_fps", 0);
                    VideoSettings settings = (width > 0 && height > 0 && fps > 0)
                            ? new VideoSettings(width, height, fps) : null;
                    if (settings != null) {
                        Log.d(TAG, "Using custom video settings: " + settings);
                    }
                    SysControl.setEisEnable(this, true);
                    setupCameraAndStartRecording(videoId, videoPath, settings);
                    break;
                }
                case ACTION_STOP_VIDEO_RECORDING:
                    String videoIdToStop = intent.getStringExtra(EXTRA_VIDEO_ID);
                    videoSession.stopRecording(videoIdToStop);
                    SysControl.setEisEnable(this, false);
                    break;
            }
        }
        return START_STICKY;
    }

    private void dispatchNextPhotoRequest() {
        photoSession.dispatchNextPhotoRequest();
    }

    private void setupCameraForQueuedRequest(QueuedPhotoRequest request) {
        photoSession.setupCameraForQueuedRequest(request);
    }

    private void setupCameraAndStartRecording(String videoId, String filePath, VideoSettings settings) {
        videoSession.setCallback(videoSessionCallback);
        if (!videoSession.prepareRequest(videoId, filePath, settings)) {
            notifyVideoError(videoId, "Already recording another video.");
            return;
        }
        wakeUpScreen();
        openCameraInternal(filePath, true); // true indicates for video
    }

    /**
     * Conditional stop self.
     */
    private void conditionalStopSelf() {
        stopSelf();
    }

    @SuppressLint("MissingPermission")
    private void openCameraInternal(String filePath, boolean forVideo) {
        CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            Log.e(TAG, "Could not get camera manager");
            if (forVideo) notifyVideoError(videoSession.currentVideoId(), "Camera service unavailable");
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
                    if (forVideo) notifyVideoError(videoSession.currentVideoId(), "Camera permission not granted");
                    else photoSession.notifyHostPhotoError("Camera permission not granted");
                    conditionalStopSelf();
                    return;
                }
            }

            this.cameraId = CameraOpener.selectPrimaryCameraId(manager);

            // Verify that we have a valid camera ID
            if (this.cameraId == null) {
                if (forVideo) notifyVideoError(videoSession.currentVideoId(), "No suitable camera found");
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
                Log.d(TAG, "Vendor feature support - ZSL: " + zslSupported + ", MFNR: " + mfnrSupported);
            }

            // Query camera capabilities for dynamic auto-exposure
            queryCameraCapabilities(characteristics);

            // Check if this camera supports JPEG format
            StreamConfigurationMap map = CameraOpener.streamMapOrNull(characteristics);
            if (map == null) {
                if (forVideo)
                    notifyVideoError(videoSession.currentVideoId(), "Camera " + this.cameraId + " doesn't support configuration maps");
                else
                    photoSession.notifyHostPhotoError("Camera " + this.cameraId + " doesn't support configuration maps");
                stopSelf();
                return;
            }

            // If this is for video, set up video size only
            if (forVideo) {
                // Find a suitable video size
                Size[] videoSizes = CameraOpener.videoOutputSizes(map);

                if (videoSizes == null || videoSizes.length == 0) {
                    notifyVideoError(videoSession.currentVideoId(), "Camera doesn't support MediaRecorder");
                    conditionalStopSelf();
                    return;
                }

                // Log available video sizes with detailed analysis
                Log.i(TAG, "📹 VIDEO RESOLUTION DEBUG - Available video sizes for camera " + this.cameraId + " (" + videoSizes.length + " options):");
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
                Log.i(TAG, "📹 Resolution support: 4K=" + has4K + ", 1080p=" + has1080p + ", 720p=" + has720p);

                Size chosenVideoSize = CameraOpener.resolveVideoSize(videoSizes, videoSession.pendingSettings());
                if (chosenVideoSize == null) {
                    notifyVideoError(videoSession.currentVideoId(), "Camera doesn't support MediaRecorder");
                    conditionalStopSelf();
                    return;
                }

                videoSession.setVideoSize(chosenVideoSize);
                try {
                    videoSession.setupMediaRecorder();
                } catch (IOException ioe) {
                    Log.e(TAG, "Error setting up MediaRecorder", ioe);
                    notifyVideoError(videoSession.currentVideoId(),
                            "Failed to set up video recorder: " + ioe.getMessage());
                }
            } else {
                // For photos, find the closest available JPEG size to our target
                Size[] jpegSizes = CameraOpener.jpegOutputSizes(map);
                if (jpegSizes == null || jpegSizes.length == 0) {
                    photoSession.notifyHostPhotoError("Camera doesn't support JPEG format");
                    stopSelf();
                    return;
                }

                boolean fromSdk = photoSession.photoRequestFromSdk();
                String requestedSizeTier = photoSession.photoRequestSizeTier();
                Log.d(TAG, fromSdk
                        ? "SDK photo - using optimized resolution"
                        : "Button photo - using high quality resolution");
                Size chosenJpeg = CameraOpener.resolveJpegSize(jpegSizes, fromSdk, requestedSizeTier);
                if (chosenJpeg == null) {
                    photoSession.notifyHostPhotoError("Camera doesn't support JPEG format");
                    stopSelf();
                    return;
                }

                // Phase 0: preview + still readers are siblings. Still reader is the ONLY target of
                // explicit cameraCaptureSession.capture() calls; preview repeating request targets the
                // small YUV preview reader, so manual-exposure captures no longer compete with auto-exposed
                // preview frames in the same buffer queue.
                photoSession.setJpegSize(chosenJpeg);
                photoSession.prepareStillReaders(filePath, chosenJpeg, backgroundHandler);
            }

            // Open the camera
            if (!cameraCoordinator.tryAcquireOpenCloseLock(2500)) {
                throw new RuntimeException("Time out waiting to lock camera opening.");
            }

            Log.d(TAG, "Opening camera ID: " + this.cameraId);
            manager.openCamera(this.cameraId, newCameraOpenStateCallback(forVideo), backgroundHandler);

        } catch (CameraAccessException e) {
            // Handle camera access exceptions more specifically
            Log.e(TAG, "Camera access exception: " + e.getReason(), e);
            String errorMsg = "Could not access camera";

            // Check for specific error reasons
            if (e.getReason() == CameraAccessException.CAMERA_DISABLED) {
                errorMsg = "Camera disabled by policy - please check camera permissions in Settings";
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
            photoSession.notifyHostPhotoError("Camera operation interrupted");
            stopSelf();
        } catch (Exception e) {
            Log.e(TAG, "Error setting up camera", e);
            photoSession.notifyHostPhotoError("Error setting up camera: " + e.getMessage());
            stopSelf();
        }
    }

    /**
     * Single camera-open callback for both photo and video; behavior matches the former
     * {@code photoStateCallback} / {@code videoStateCallback} pair (Phase 2f prep).
     */
    private CameraDevice.StateCallback newCameraOpenStateCallback(final boolean forVideo) {
        return new CameraDevice.StateCallback() {
            @Override
            public void onOpened(@NonNull CameraDevice camera) {
                Log.d(TAG, "Camera device opened successfully");
                cameraCoordinator.releaseOpenCloseLock();
                cameraCoordinator.setDevice(camera);

                createCameraSessionInternal(forVideo);
            }

            @Override
            public void onDisconnected(@NonNull CameraDevice camera) {
                Log.d(TAG, "Camera device disconnected");
                cameraCoordinator.releaseOpenCloseLock();
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
                Log.e(TAG, "Camera device error: " + error);
                cameraCoordinator.releaseOpenCloseLock();
                camera.close();
                cameraCoordinator.clearDevice();
                if (forVideo) {
                    notifyVideoError(videoSession.currentVideoId(), "Camera device error: " + error);
                } else {
                    photoSession.notifyHostPhotoError("Camera device error: " + error);
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
                if (forVideo) notifyVideoError(videoSession.currentVideoId(), "Camera not initialized");
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
                previewBuilder = activeCameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
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

                previewBuilder = activeCameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                previewBuilder.addTarget(readers.getPreviewSurface());
                Log.d(TAG, "🔍 Using TEMPLATE_PREVIEW for repeating request, target=previewReader (ZSL compatible)");
            }

            VideoSettings pendingSettings = videoSession.pendingSettings();
            int videoFps = (pendingSettings != null) ? pendingSettings.fps : 30;
            Size sizeForMetering =
                    forVideo ? videoSession.videoSize() : new Size(ImageReaderTwin.PREVIEW_WIDTH, ImageReaderTwin.PREVIEW_HEIGHT);
            int displayOrientation = getDisplayRotation();
            int jpegOrientation = JpegOrientationResolver.lookupJpegOrientation(
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
                    mCameraSettings);

            CameraCaptureSession.StateCallback sessionStateCallback = new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(@NonNull CameraCaptureSession session) {
                    // Store the session atomically
                    synchronized (SERVICE_LOCK) {
                        cameraCoordinator.setSession(session);
                    }
                    
                    if (forVideo) {
                        try {
                            videoSession.startRecording(cameraCoordinator.session(), previewBuilder);
                        } catch (CameraAccessException ce) {
                            Log.e(TAG, "Failed to start video recording", ce);
                            notifyVideoError(videoSession.currentVideoId(),
                                    "Failed to start recording: " + ce.getMessage());
                        }
                    } else {
                        Log.d(TAG, "Camera session configured and ready");

                        photoSession.pollFirstQueuedRequestIntoCurrent();

                        // Start proper preview for photos with AE state monitoring
                        photoSession.startPreviewWithAeMonitoring();
                    }
                }

                @Override
                public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                    Log.e(TAG, "Failed to configure camera session for " + (forVideo ? "video" : "photo"));
                    if (forVideo)
                        notifyVideoError(videoSession.currentVideoId(), "Failed to configure camera for video");
                    else photoSession.notifyHostPhotoError("Failed to configure camera for photo");
                    conditionalStopSelf();
                }
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                List<OutputConfiguration> outputConfigurations = new ArrayList<>();
                for (Surface surface : surfaces) {
                    outputConfigurations.add(new OutputConfiguration(surface));
                }
                SessionConfiguration config = new SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outputConfigurations, executor, sessionStateCallback);
                activeCameraDevice.createCaptureSession(config);
            } else {
                activeCameraDevice.createCaptureSession(surfaces, sessionStateCallback, backgroundHandler);
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
        synchronized (SERVICE_LOCK) {
            Log.d(TAG, "CameraNeoService service destroying");
            
            // Cancel keep-alive timer if it's running
            cancelKeepAliveTimer();
            if (videoSession != null && videoSession.isRecording()) {
                videoSession.stopRecording(videoSession.currentVideoId());
            }
            closeCamera();
            stopBackgroundThread();
            releaseWakeLocks();
            
            sInstance = null;
            
            QueuedPhotoRequestQueue.getInstance().failAllPending("Camera service terminated unexpectedly");
        }
    }

    /**
     * Start background thread
     */
    private void startBackgroundThread() {
        backgroundHandler = cameraCoordinator.startBackgroundThread("CameraNeoBackground");
    }

    /**
     * Stop background thread
     */
    private void stopBackgroundThread() {
        cameraCoordinator.stopBackgroundThread();
        backgroundHandler = null;
    }

    /**
     * Close camera resources
     */
    private void closeCamera() {
        boolean lockAcquired = false;
        try {
            lockAcquired = cameraCoordinator.tryAcquireOpenCloseLock(5000);
            if (!lockAcquired) {
                Log.e(TAG, "closeCamera: Failed to acquire lock within 5 seconds, proceeding with cleanup anyway");
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

    /**
     * Start the keep-alive timer to keep camera open for rapid successive shots
     */
    private void startKeepAliveTimer() {
        cameraCoordinator.startKeepAlive(
                CAMERA_KEEP_ALIVE_MS,
                () -> photoSession.shotState() != AeStateMachine.ShotState.IDLE,
                () -> {
                    closeCamera();
                    stopSelf();
                });
    }
    
    /**
     * Cancel the keep-alive timer
     */
    private void cancelKeepAliveTimer() {
        cameraCoordinator.cancelKeepAlive();
    }

    /**
     * Release wake locks to avoid battery drain
     */
    private void releaseWakeLocks() {
        // Use the WakeLockManager to release all wake locks
        WakeLockManager.releaseAllWakeLocks();
    }

    /**
     * Force the screen to turn on so camera can be accessed
     */
    private void wakeUpScreen() {
        Log.d(TAG, "Waking up screen for camera access");
        // Use the WakeLockManager to acquire both CPU and screen wake locks
        WakeLockManager.acquireFullWakeLockAndBringToForeground(this, 180000, 5000);
    }

    /**
     * Attempt to restart the camera service with different parameters if needed
     */
    private void restartCameraServiceIfNeeded() {
        CameraRecoveryHelper.restartCameraServiceIfNeeded(
                this::releaseCameraResources,
                this,
                () -> cameraId,
                id -> cameraId = id,
                this::wakeUpScreen,
                () -> cameraCoordinator.closeDeviceAndSession());
    }

    /**
     * Release all camera system resources
     */
    private void releaseCameraResources() {
        CameraRecoveryHelper.releaseCameraResources(
                this::closeCamera,
                () -> cameraCoordinator.closeDeviceAndSession(),
                this);
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

    /**
     * Query camera capabilities for dynamic auto-exposure
     */
    private void queryCameraCapabilities(CameraCharacteristics characteristics) {
        // Get available AE modes
        availableAeModes = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES);
        if (availableAeModes == null) {
            availableAeModes = new int[]{CaptureRequest.CONTROL_AE_MODE_ON};
        }

        // Get exposure compensation range and step
        exposureCompensationRange = characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        if (exposureCompensationRange == null) {
            exposureCompensationRange = Range.create(-2, 2); // Default range
        }

        exposureCompensationStep = characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        if (exposureCompensationStep == null) {
            exposureCompensationStep = new Rational(1, 6); // Default 1/6 EV step
        }

        // Get available FPS ranges; selection logic lives in {@link FpsRangePolicy}.
        availableFpsRanges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (availableFpsRanges == null || availableFpsRanges.length == 0) {
            selectedFpsRange = FpsRangePolicy.DEFAULT_FPS_RANGE;
        } else {
            selectedFpsRange = FpsRangePolicy.chooseOptimalFpsRange(availableFpsRanges);
            Log.d(TAG, "Selected FPS range: " + selectedFpsRange + " from "
                    + availableFpsRanges.length + " advertised ranges");
        }

        // Phase 3 prep: AF + manual-sensor capabilities bundled into one immutable value object.
        cameraCapabilities = CameraCapabilities.from(characteristics);
        hasAutoFocus = cameraCapabilities.hasContinuousPictureAf;

        Log.d(TAG, "Camera capabilities - AE modes: " + java.util.Arrays.toString(availableAeModes));
        Log.d(TAG, "Exposure compensation range: " + exposureCompensationRange + ", step: " + exposureCompensationStep);
        Log.d(TAG, "Selected FPS range: " + selectedFpsRange);
        Log.d(TAG, "Autofocus available: " + hasAutoFocus
                + ", min focus distance: " + cameraCapabilities.minimumFocusDistance);
        Log.d(TAG, "Manual sensor: supported=" + cameraCapabilities.manualSensorSupported
                + ", exposureNsRange=" + cameraCapabilities.sensorExposureTimeRange
                + ", maxFrameDurationNs=" + cameraCapabilities.sensorMaxFrameDurationNs
                + ", isoRange=" + cameraCapabilities.sensorSensitivityRange);
    }

}
