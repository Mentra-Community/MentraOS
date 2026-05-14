package com.mentra.asg_client.camera;

import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.service.utils.ServiceUtils;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.SysControl;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.Surface;

import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.utils.WakeLockManager;
import com.mentra.asg_client.io.storage.StorageManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.lifecycle.LifecycleService;

import com.mentra.asg_client.R;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

public class CameraNeo extends LifecycleService {
    private static final String TAG = "CameraNeo";

    private static final String CHANNEL_ID = "CameraNeoServiceChannel";
    private static final int NOTIFICATION_ID = 1;

    // =======================================================================
    // STATIC STATE MANAGEMENT FOR TRUE SINGLETON PATTERN
    // =======================================================================
    
    // Static state flags - set IMMEDIATELY to prevent race conditions
    private static volatile boolean isServiceStarting = false;
    private static volatile boolean isServiceRunning = false;
    private static volatile boolean isCameraReady = false;
    private static final Object SERVICE_LOCK = new Object();
    
    // Service state for debugging
    private static enum ServiceState { 
        IDLE,        // No service exists
        STARTING,    // Service created but camera not initialized  
        RUNNING,     // Camera initialized and ready
        STOPPING     // Service is shutting down
    }
    private static volatile ServiceState serviceState = ServiceState.IDLE;
    
    // =======================================================================

    // Camera variables
    private CameraDevice cameraDevice = null;
    private CaptureRequest.Builder previewBuilder; // Separate builder for preview
    private CameraCaptureSession cameraCaptureSession;
    private ImageReaderTwin imageReaders;
    private HandlerThread backgroundThread;
    private Handler backgroundHandler;
    private Semaphore cameraOpenCloseLock = new Semaphore(1);
    private Size jpegSize;
    private String cameraId;

    // Photo resolution and quality constants are defined in CameraConstants.java
    
    // JPEG orientation mapping moved to {@link JpegOrientationResolver}.

    
    // Camera keep-alive settings
    private static final long CAMERA_KEEP_ALIVE_MS = 3000; // Keep camera open for 3 seconds after photo
    private Timer cameraKeepAliveTimer;
    private boolean isCameraKeptAlive = false;

    /**
     * Phase 1: single source of truth for the in-flight photo request.
     * Replaces the prior scattered {@code pending*} fields (filePath, size, isFromSdk,
     * exposureTimeNs, startTimeMs). Null when no capture is in flight.
     */
    private volatile CurrentRequest currentRequest;
    /** Fallback output path for still {@link ImageReader} callback (openCamera path param). */
    private String listenerFallbackPhotoPath;

    // LED control - tracks whether the LED is currently ON, not the request's intent.
    // Reset to false when the camera closes; intent comes from currentRequest.ledEnabled.
    private static volatile boolean pendingLedEnabled = false;
    private IHardwareManager hardwareManager;
    
    // MediaTek vendor-specific camera settings (ZSL, MFNR)
    private CameraSettings mCameraSettings;

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
    private volatile Integer mLastMeteredIso;
    private volatile Long mLastMeteredExposureNs;
    // #region agent log
    // Sensor timestamp of the last still-capture frame as reported by the HAL
    // in onCaptureCompleted. Used in onImageAvailable to verify that the
    // ImageReader actually delivered the still frame (not a leftover preview).
    private volatile Long mLastStillSensorTimestampNs;
    // #endregion

    // Autofocus + manual-sensor capabilities are bundled into {@link #cameraCapabilities}.

    
    /** Delegates to {@link JpegOrientationResolver#getDisplayRotation(Context)}. */
    private int getDisplayRotation() {
        return JpegOrientationResolver.getDisplayRotation(this);
    }

    /**
     * SIMPLIFIED AUTOEXPOSURE SYSTEM
     *
     * 1. WAITING_AE: Trigger AE precapture, wait up to 0.5 seconds for convergence
     *    - Waits for AE_STATE_CONVERGED/FLASH_REQUIRED/LOCKED
     *    - CONTINUOUS_PICTURE autofocus runs automatically in background
     *
     * 2. SHOOTING: Capture the photo immediately with high quality settings
     *    - Relies on Camera2 API auto-exposure and continuous autofocus
     */

    // Simplified AE system — state enum, timing, and pure AE step logic live in {@link AeStateMachine}.
    private volatile AeStateMachine.ShotState shotState = AeStateMachine.ShotState.IDLE;
    private boolean mWaitingForAeConvergence = false;  // Flag to track if waiting for AE (XyCamera2 pattern)
    private boolean mAeLockRequested = false;  // Flag to track if AE lock requested (XyCamera2 pattern)
    private long aeStartTimeNs;

    private final SimplifiedAeCallback aeCallback = new SimplifiedAeCallback();

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

    // Static callback for photo capture
    private static volatile PhotoCaptureCallback sPhotoCallback;
    
    // Video recording components
    private MediaRecorder mediaRecorder;
    private Surface recorderSurface;
    private boolean isRecording = false;
    private String currentVideoId;
    private String currentVideoPath;
    private static volatile VideoRecordingCallback sVideoCallback;
    private long recordingStartTime;
    private Timer recordingTimer;
    private Size videoSize; // To store selected video size
    private VideoSettings pendingVideoSettings; // Settings for next recording

    // Static instance for checking camera status
    private static CameraNeo sInstance;

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
     * @deprecated No callers; last path is not tracked for external APIs.
     */
    @Deprecated
    public static String getLastPhotoPath() {
        return null;
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
            if (sInstance.isCameraKeptAlive && sInstance.shotState == AeStateMachine.ShotState.IDLE) {
                // Camera is kept alive but not actively taking a photo
                // This allows other operations to close the camera if needed
                return false;
            }
            
            // Check if a photo capture session is active (actively taking a photo)
            boolean photoSessionActive = (sInstance.cameraDevice != null && sInstance.imageReaders != null &&
                                         !sInstance.isRecording && sInstance.shotState != AeStateMachine.ShotState.IDLE);

            // Return true if actively recording video or taking a photo
            return photoSessionActive || sInstance.isRecording;
        }
        return false; // Service not running or instance not set
    }

    /**
     * Force close the camera if it's only kept alive (not actively in use).
     * This is called when other operations like video/streaming need the camera.
     * @return true if camera was closed, false if camera was busy or not open
     */
    public static boolean closeKeptAliveCamera() {
        if (sInstance != null && sInstance.isCameraKeptAlive && sInstance.shotState == AeStateMachine.ShotState.IDLE) {
            Log.d(TAG, "Force closing kept-alive camera for other operation");
            sInstance.cancelKeepAliveTimer();
            sInstance.isCameraKeptAlive = false;
            sInstance.closeCamera();
            sInstance.stopSelf();
            return true;
        }
        return false;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        synchronized (SERVICE_LOCK) {
            Log.d(TAG, "CameraNeo Camera2 service created - Setting state to RUNNING");
            isServiceStarting = false;
            isServiceRunning = true;
            serviceState = ServiceState.RUNNING;
            sInstance = this;
        }
        // Initialize hardware manager for LED control
        hardwareManager = HardwareManagerFactory.getInstance(this);
        // Initialize camera settings for vendor-specific features (ZSL, MFNR)
        mCameraSettings = new CameraSettings(this);
        
        // Initialize EIS (Electronic Image Stabilization)
        Log.i(TAG, "📹 Initializing EIS (Electronic Image Stabilization) - Default state: " + 
                  (eisEnabled ? "ENABLED" : "DISABLED"));
        
        createNotificationChannel();
        showNotification("Camera Service", "Service is running");
        startBackgroundThread();
    }

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
            PhotoRequest request = new PhotoRequest(filePath, size, enableLed, isFromSdk, exposureTimeNs, callback);
            PhotoRequestQueue.getInstance().offer(request);
            
            Log.d(TAG, "📸 Enqueued photo request: " + request.requestId + 
                      " | Queue size: " + PhotoRequestQueue.getInstance().size() + 
                      " | Service state: " + serviceState);
            
            // Check current service state and act accordingly
            if (isServiceRunning && isCameraReady && sInstance != null) {
                // Fast path - camera is ready, check if idle
                if (sInstance.shotState == AeStateMachine.ShotState.IDLE) {
                    Log.d(TAG, "Camera ready and idle - processing request immediately");
                    // Cancel any pending keep-alive timer to prevent it from closing camera mid-capture
                    sInstance.cancelKeepAliveTimer();
                    // Don't call processNextPhotoRequest as it might try to reopen camera
                    // Instead, directly process the request we just queued
                    PhotoRequest queuedRequest = PhotoRequestQueue.getInstance().poll();
                    if (queuedRequest != null) {
                        sInstance.sPhotoCallback = queuedRequest.callback;
                        sInstance.loadCurrentRequest(queuedRequest);
                        sInstance.shotState = AeStateMachine.ShotState.WAITING_AE;
                        
                        if (sInstance.backgroundHandler != null) {
                            sInstance.backgroundHandler.post(sInstance::startPrecaptureSequence);
                        } else {
                            sInstance.startPrecaptureSequence();
                        }
                    }
                } else {
                    Log.d(TAG, "Camera ready but busy (state: " + sInstance.shotState + ") - request queued");
                }
            } else if (isServiceStarting) {
                // Service is already starting, request will be processed when ready
                Log.d(TAG, "Service is starting - request will be processed when camera ready");
            } else {
                // Need to start the service
                Log.d(TAG, "Starting service to process photo request");
                isServiceStarting = true;
                serviceState = ServiceState.STARTING;
                
                Intent intent = new Intent(context, CameraNeo.class);
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
        sVideoCallback = callback;

        Intent intent = new Intent(context, CameraNeo.class);
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
        Intent intent = new Intent(context, CameraNeo.class);
        intent.setAction(ACTION_STOP_VIDEO_RECORDING);
        intent.putExtra(EXTRA_VIDEO_ID, videoId);
        context.startForegroundService(intent);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);

        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            Log.d(TAG, "CameraNeo received action: " + action);

            switch (action) {
                case ACTION_TAKE_PHOTO:
                    // Phase 1: only the global-queue path is wired up via enqueuePhotoRequest().
                    // The legacy intent-extras path (USE_GLOBAL_QUEUE=false) had zero callers and was
                    // removed; CameraNeo is always started via the queue dispatcher now.
                    Log.d(TAG, "Processing photo requests from global queue");
                    processAllQueuedPhotoRequests();
                    break;
                case ACTION_START_VIDEO_RECORDING:
                    currentVideoId = intent.getStringExtra(EXTRA_VIDEO_ID);
                    currentVideoPath = intent.getStringExtra(EXTRA_VIDEO_FILE_PATH);
                    if (currentVideoPath == null || currentVideoPath.isEmpty()) {
                        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                        String videoCaptureDir = "VID_" + timeStamp;
                        File videoCaptureDirFile = new File(getExternalFilesDir(null), videoCaptureDir);
                        videoCaptureDirFile.mkdirs();
                        currentVideoPath = new File(videoCaptureDirFile, "base.mp4").getAbsolutePath();
                    }
                    // Extract video settings if provided
                    int width = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_width", 0);
                    int height = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_height", 0);
                    int fps = intent.getIntExtra(EXTRA_VIDEO_SETTINGS + "_fps", 0);
                    if (width > 0 && height > 0 && fps > 0) {
                        pendingVideoSettings = new VideoSettings(width, height, fps);
                        Log.d(TAG, "Using custom video settings: " + pendingVideoSettings);
                    } else {
                        pendingVideoSettings = null; // Will use defaults
                    }
                    SysControl.setEisEnable(this, true);
                    setupCameraAndStartRecording(currentVideoId, currentVideoPath);
                    break;
                case ACTION_STOP_VIDEO_RECORDING:
                    String videoIdToStop = intent.getStringExtra(EXTRA_VIDEO_ID);
                    stopCurrentVideoRecording(videoIdToStop);
                    SysControl.setEisEnable(this, false);
                    break;
            }
        }
        return START_STICKY;
    }

    // ===== Phase 1 helpers: in-flight request state via {@link #currentRequest} =====
    private String currentFilePath() {
        return currentRequest != null ? currentRequest.filePath : null;
    }

    private String currentSize() {
        return currentRequest != null ? currentRequest.size : null;
    }

    private boolean currentIsFromSdk() {
        return currentRequest != null && currentRequest.isFromSdk;
    }

    private Long currentExposureTimeNs() {
        return currentRequest != null ? currentRequest.exposureTimeNs : null;
    }

    private long currentStartTimeMs() {
        return currentRequest != null ? currentRequest.startTimeMs : 0L;
    }

    private void loadCurrentRequest(PhotoRequest pr) {
        currentRequest = CurrentRequest.from(pr);
    }

    private void clearCurrentRequest() {
        currentRequest = null;
    }

    /**
     * Get the appropriate JPEG quality based on the requested size tier and source.
     * SDK photos use lower quality for faster transfer; button photos use high quality.
     */
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

    /**
     * Process all queued photo requests from the global queue
     * This is called when the service starts with USE_GLOBAL_QUEUE flag
     */
    private void processAllQueuedPhotoRequests() {
        synchronized (SERVICE_LOCK) {
            if (PhotoRequestQueue.getInstance().isEmpty()) {
                Log.d(TAG, "No photo requests in global queue");
                return;
            }
            
            Log.d(TAG, "Processing " + PhotoRequestQueue.getInstance().size() + " queued photo requests");
            
            // Process the first request to open camera
            PhotoRequest firstRequest = PhotoRequestQueue.getInstance().peek();
            if (firstRequest != null) {
                PhotoRequestQueue.getInstance().attachRegistryCallback(firstRequest);
                // Open camera with the first request
                setupCameraForPhotoRequest(firstRequest);
            }
        }
    }
    
    /**
     * Process the next photo request from the global queue
     * Called after each photo is captured successfully
     */
    private void processNextPhotoRequest() {
        synchronized (SERVICE_LOCK) {
            // Get next request from queue
            PhotoRequest request = PhotoRequestQueue.getInstance().poll();
            if (request == null) {
                Log.d(TAG, "No more photo requests in queue");
                // Start keep-alive timer for rapid capture
                startKeepAliveTimer();
                return;
            }
            
            Log.d(TAG, "Processing photo request: " + request.requestId);
            
            // Set the current callback
            sPhotoCallback = request.callback;
            
            // If camera is already open and ready, just take the photo
            // Don't try to open it again!
            if (cameraDevice != null && cameraCaptureSession != null) {
                Log.d(TAG, "Camera already open, taking next photo from queue");
                loadCurrentRequest(request);

                // Check if we're already processing a photo
                if (shotState == AeStateMachine.ShotState.IDLE) {
                    // Start capture sequence
                    shotState = AeStateMachine.ShotState.WAITING_AE;
                    if (backgroundHandler != null) {
                        backgroundHandler.post(this::startPrecaptureSequence);
                    } else {
                        startPrecaptureSequence();
                    }
                } else {
                    // Camera is busy, re-queue the request
                    Log.d(TAG, "Camera busy (state: " + shotState + "), re-queuing request");
                    PhotoRequestQueue.getInstance().offer(request);
                }
            } else {
                // Camera not ready, need to open it
                setupCameraForPhotoRequest(request);
            }
        }
    }
    
    /**
     * Setup camera for a specific photo request
     */
    private void setupCameraForPhotoRequest(PhotoRequest request) {
        if (request == null) return;

        Log.i(TAG, "📸 PHOTO E2E: Starting photo request " + request.requestId);

        // Check if size or SDK flag has changed BEFORE loading the new request.
        // This is critical for detecting when the camera needs to be reopened.
        String previousSize = currentSize();
        boolean previousIsFromSdk = currentIsFromSdk();
        Long previousExposureNs = currentExposureTimeNs();

        boolean sizeChanged = false;
        if (previousSize != null && request.size != null) {
            sizeChanged = !previousSize.equals(request.size);
        } else if (previousSize == null && request.size != null) {
            sizeChanged = true;
        } else if (previousSize != null && request.size == null) {
            sizeChanged = true;
        }
        boolean sdkFlagChanged = (previousIsFromSdk != request.isFromSdk);
        boolean exposureChanged = !Objects.equals(previousExposureNs, request.exposureTimeNs);

        // Phase 1: bundle the in-flight slot in one assignment.
        loadCurrentRequest(request);
        sPhotoCallback = request.callback;

        // Update LED state if any request needs LED
        if (request.enableLed) {
            pendingLedEnabled = true;
        }

        // Check if camera is already open and kept alive
        if (isCameraKeptAlive && cameraDevice != null) {
            Log.d(TAG, "Camera already open, checking if reconfiguration needed");

            // Need to reopen camera if size changed OR if SDK flag changed
            // (SDK flag affects resolution selection even for same size tier)
            // or manual exposure vs auto changes pipeline characteristics
            boolean needsReopen = sizeChanged || sdkFlagChanged || exposureChanged;

            if (needsReopen) {
                Log.d(TAG, "Camera config changed (sizeChanged=" + sizeChanged +
                          ", sdkFlagChanged=" + sdkFlagChanged +
                          ", exposureChanged=" + exposureChanged + "), reopening camera");
                cancelKeepAliveTimer();
                closeCamera();
                openCameraInternal(request.filePath, false);
            } else {
                // Cancel keep-alive timer and take photo with existing config
                Log.d(TAG, "Camera config unchanged, taking photo immediately");
                cancelKeepAliveTimer();
                // currentRequest is already loaded with this request's filePath.

                // Start capture sequence
                shotState = AeStateMachine.ShotState.WAITING_AE;
                if (backgroundHandler != null) {
                    backgroundHandler.post(this::startPrecaptureSequence);
                } else {
                    startPrecaptureSequence();
                }
            }
        } else {
            // Open camera from scratch
            Log.d(TAG, "Opening camera for photo capture");
            wakeUpScreen();
            openCameraInternal(request.filePath, false);
        }
    }
    
    private void setupCameraAndStartRecording(String videoId, String filePath) {
        if (isRecording) {
            notifyVideoError(videoId, "Already recording another video.");
            return;
        }
        wakeUpScreen();
        currentVideoId = videoId;
        currentVideoPath = filePath;
        openCameraInternal(filePath, true); // true indicates for video
    }

    private void stopCurrentVideoRecording(String videoIdToStop) {
        if (!isRecording) {
            Log.w(TAG, "Stop recording requested, but not currently recording.");
            // Optionally notify error or just ignore if it's a common race condition
            if (sVideoCallback != null && videoIdToStop != null) {
                sVideoCallback.onRecordingError(videoIdToStop, "Not recording");
            }
            return;
        }
        if (videoIdToStop == null || !videoIdToStop.equals(currentVideoId)) {
            Log.w(TAG, "Stop recording requested for ID " + videoIdToStop + " but current is " + currentVideoId);
            if (sVideoCallback != null && videoIdToStop != null) {
                sVideoCallback.onRecordingError(videoIdToStop, "Video ID mismatch");
            }
            return;
        }

        try {
            if (mediaRecorder != null) {
                // Check minimum recording duration to prevent corruption
                long recordingDuration = System.currentTimeMillis() - recordingStartTime;
                if (recordingDuration < VideoRecorderPolicy.MIN_RECORDING_DURATION_WARN_MS) {
                    Log.w(TAG, "Recording duration too short (" + recordingDuration + "ms), file may be corrupted");
                    // Still try to stop, but warn about potential corruption
                    if (sVideoCallback != null) {
                        Log.w(TAG, "Warning: Video recording was very short, file may be corrupted");
                    }
                }
                
                mediaRecorder.stop();
                mediaRecorder.reset();
            }
            Log.d(TAG, "Video recording stopped for: " + currentVideoId);

            // Stop IMU recording and save sidecar alongside the video
            if (mImuRecorder != null && currentVideoPath != null) {
                String imuPath = mImuRecorder.stopRecordingAndSave(currentVideoPath);
                if (imuPath != null) {
                    Log.d(TAG, "Video IMU sidecar saved: " + imuPath);
                }
            }

            if (sVideoCallback != null) {
                sVideoCallback.onRecordingStopped(currentVideoId, currentVideoPath);
            }
        } catch (RuntimeException stopErr) {
            Log.e(TAG, "MediaRecorder.stop() failed", stopErr);
            // Cancel IMU recording on error
            if (mImuRecorder != null) {
                mImuRecorder.cancel();
            }
            // Delete the corrupt/incomplete video file so it's never synced
            deleteCorruptCapture(currentVideoPath);
            if (sVideoCallback != null) {
                sVideoCallback.onRecordingError(currentVideoId, "Failed to stop recorder: " + stopErr.getMessage());
            }
        } finally {
            isRecording = false;
            if (recordingTimer != null) {
                recordingTimer.cancel();
                recordingTimer = null;
            }
            closeCamera();
            conditionalStopSelf(); // Changed to conditional stop
        }
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
            if (forVideo) notifyVideoError(currentVideoId, "Camera service unavailable");
            else notifyPhotoError("Camera service unavailable");
            conditionalStopSelf();
            return;
        }

        try {
            // First check if camera permission is granted
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                int cameraPermission = checkSelfPermission(android.Manifest.permission.CAMERA);
                if (cameraPermission != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    Log.e(TAG, "Camera permission not granted");
                    if (forVideo) notifyVideoError(currentVideoId, "Camera permission not granted");
                    else notifyPhotoError("Camera permission not granted");
                    conditionalStopSelf();
                    return;
                }
            }

            String[] cameraIds = manager.getCameraIdList();

            // Find the back camera (primary camera)
            for (String id : cameraIds) {
                CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
                Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    this.cameraId = id;
                    break;
                }
            }

            // If no back camera found, use the first available camera
            if (this.cameraId == null && cameraIds.length > 0) {
                this.cameraId = cameraIds[0];
                Log.d(TAG, "No back camera found, using camera ID: " + this.cameraId);
            }

            // Verify that we have a valid camera ID
            if (this.cameraId == null) {
                if (forVideo) notifyVideoError(currentVideoId, "No suitable camera found");
                else notifyPhotoError("No suitable camera found");
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
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) {
                if (forVideo)
                    notifyVideoError(currentVideoId, "Camera " + this.cameraId + " doesn't support configuration maps");
                else
                    notifyPhotoError("Camera " + this.cameraId + " doesn't support configuration maps");
                stopSelf();
                return;
            }

            // If this is for video, set up video size only
            if (forVideo) {
                // Find a suitable video size
                Size[] videoSizes = map.getOutputSizes(MediaRecorder.class);

                if (videoSizes == null || videoSizes.length == 0) {
                    notifyVideoError(currentVideoId, "Camera doesn't support MediaRecorder");
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

                // Use pending video settings if available, otherwise default to 1080p
                int targetVideoWidth;
                int targetVideoHeight;
                if (pendingVideoSettings != null && pendingVideoSettings.isValid()) {
                    targetVideoWidth = pendingVideoSettings.width;
                    targetVideoHeight = pendingVideoSettings.height;
                    Log.i(TAG, "📹 Using CUSTOM video settings from command: " + pendingVideoSettings);
                } else {
                    targetVideoWidth = 1920;
                    targetVideoHeight = 1080;
                    Log.i(TAG, "📹 Using DEFAULT video settings: 1920x1080@30fps (no custom settings provided)");
                }
                Log.i(TAG, "📹 TARGET resolution: " + targetVideoWidth + "x" + targetVideoHeight);
                videoSize = chooseOptimalSize(videoSizes, targetVideoWidth, targetVideoHeight);
                if (videoSize == null) {
                    Log.e(TAG, "chooseOptimalSize returned null for video, falling back to first available size");
                    videoSize = videoSizes[0];
                }
                Log.i(TAG, "📹 SELECTED resolution: " + videoSize.getWidth() + "x" + videoSize.getHeight());

                // Warn if we didn't get what we asked for
                if (videoSize.getWidth() != targetVideoWidth || videoSize.getHeight() != targetVideoHeight) {
                    Log.w(TAG, "⚠️ VIDEO RESOLUTION MISMATCH: Requested " + targetVideoWidth + "x" + targetVideoHeight +
                          " but got " + videoSize.getWidth() + "x" + videoSize.getHeight() +
                          " - camera may not support requested resolution for MediaRecorder");
                }

                setupMediaRecorder(currentVideoPath);
            } else {
                // For photos, find the closest available JPEG size to our target
                Size[] jpegSizes = map.getOutputSizes(ImageFormat.JPEG);
                if (jpegSizes == null || jpegSizes.length == 0) {
                    notifyPhotoError("Camera doesn't support JPEG format");
                    stopSelf();
                    return;
                }

                // Select resolution based on source (SDK vs button) and size tier
                int desiredW, desiredH;
                boolean fromSdk = currentIsFromSdk();
                String requestedSizeTier = currentSize();
                if (fromSdk) {
                    // SDK photos - optimized for fast WiFi transfer
                    if (requestedSizeTier == null) {
                        desiredW = CameraConstants.SDK_WIDTH_MEDIUM;
                        desiredH = CameraConstants.SDK_HEIGHT_MEDIUM;
                    } else {
                        switch (requestedSizeTier) {
                            case CameraConstants.SIZE_SMALL:
                                desiredW = CameraConstants.SDK_WIDTH_SMALL;
                                desiredH = CameraConstants.SDK_HEIGHT_SMALL;
                                break;
                            case CameraConstants.SIZE_LARGE:
                                desiredW = CameraConstants.SDK_WIDTH_LARGE;
                                desiredH = CameraConstants.SDK_HEIGHT_LARGE;
                                break;
                            case CameraConstants.SIZE_FULL:
                                desiredW = CameraConstants.SDK_WIDTH_FULL;
                                desiredH = CameraConstants.SDK_HEIGHT_FULL;
                                break;
                            case CameraConstants.SIZE_MEDIUM:
                            default:
                                desiredW = CameraConstants.SDK_WIDTH_MEDIUM;
                                desiredH = CameraConstants.SDK_HEIGHT_MEDIUM;
                                break;
                        }
                    }
                    Log.d(TAG, "SDK photo - using optimized resolution");
                } else {
                    // Button photos - high quality for local storage
                    if (requestedSizeTier == null) {
                        desiredW = CameraConstants.BUTTON_WIDTH_MEDIUM;
                        desiredH = CameraConstants.BUTTON_HEIGHT_MEDIUM;
                    } else {
                        switch (requestedSizeTier) {
                            case CameraConstants.SIZE_SMALL:
                                desiredW = CameraConstants.BUTTON_WIDTH_SMALL;
                                desiredH = CameraConstants.BUTTON_HEIGHT_SMALL;
                                break;
                            case CameraConstants.SIZE_LARGE:
                                desiredW = CameraConstants.BUTTON_WIDTH_LARGE;
                                desiredH = CameraConstants.BUTTON_HEIGHT_LARGE;
                                break;
                            case CameraConstants.SIZE_MEDIUM:
                            default:
                                desiredW = CameraConstants.BUTTON_WIDTH_MEDIUM;
                                desiredH = CameraConstants.BUTTON_HEIGHT_MEDIUM;
                                break;
                        }
                    }
                    Log.d(TAG, "Button photo - using high quality resolution");
                }
                jpegSize = chooseOptimalSize(jpegSizes, desiredW, desiredH);
                if (jpegSize == null) {
                    Log.e(TAG, "chooseOptimalSize returned null for JPEG, falling back to first available size");
                    jpegSize = jpegSizes[0];
                }
                Log.d(TAG, "Selected JPEG size: " + jpegSize.getWidth() + "x" + jpegSize.getHeight() +
                          " (requested: " + desiredW + "x" + desiredH + ", isFromSdk: " + fromSdk + ")");

                // Phase 0: preview + still readers are siblings. Still reader is the ONLY target of
                // explicit cameraCaptureSession.capture() calls; preview repeating request targets the
                // small YUV preview reader, so manual-exposure captures no longer compete with auto-exposed
                // preview frames in the same buffer queue.
                listenerFallbackPhotoPath = filePath;
                imageReaders = new ImageReaderTwin(jpegSize, backgroundHandler, this::onStillImageAvailable);
            }

            // Open the camera
            if (!cameraOpenCloseLock.tryAcquire(2500, TimeUnit.MILLISECONDS)) {
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

            if (forVideo) notifyVideoError(currentVideoId, errorMsg);
            else notifyPhotoError(errorMsg);
            stopSelf();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted while trying to lock camera", e);
            notifyPhotoError("Camera operation interrupted");
            stopSelf();
        } catch (Exception e) {
            Log.e(TAG, "Error setting up camera", e);
            notifyPhotoError("Error setting up camera: " + e.getMessage());
            stopSelf();
        }
    }

    /**
     * Still-capture buffer arrived. Routed from {@link ImageReaderTwin}'s JPEG reader only
     * (preview frames are routed to a separate YUV reader so they no longer compete here).
     */
    private void onStillImageAvailable(ImageReader reader) {
        if (shotState != AeStateMachine.ShotState.SHOOTING) {
            try (Image image = reader.acquireLatestImage()) {
                // Drain stray buffers that arrive outside of an explicit capture.
            }
            return;
        }

        Log.d(TAG, "Processing photo capture...");
        try (Image image = reader.acquireLatestImage()) {
            // #region agent log
            try {
                long imgTs = (image != null) ? image.getTimestamp() : -1L;
                Long stillTs = mLastStillSensorTimestampNs;
                long deltaMs = (stillTs != null && imgTs > 0) ? (stillTs - imgTs) / 1_000_000L : -1L;
                boolean match = (stillTs != null && imgTs > 0 && stillTs == imgTs);
                android.util.Log.i("MentraDbg",
                    "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H6\",\"location\":\"CameraNeo:onImageAvailable:savedFrame\",\"timestamp\":" + System.currentTimeMillis()
                    + ",\"message\":\"saved frame timestamp vs still capture timestamp\",\"data\":{"
                    + "\"image_timestamp_ns\":" + imgTs
                    + ",\"still_SENSOR_TIMESTAMP_ns\":" + stillTs
                    + ",\"timestamps_match\":" + match
                    + ",\"delta_ms_still_minus_image\":" + deltaMs
                    + "}}");
            } catch (Throwable t) {
                // Never let logging crash capture.
            }
            // #endregion
            if (image == null) {
                Log.e(TAG, "Acquired image is null");
                if (!mHdrBurstActive) {
                    notifyPhotoError("Failed to acquire image data");
                    shotState = AeStateMachine.ShotState.IDLE;
                    closeCamera();
                    stopSelf();
                }
                return;
            }

            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);

            String currentPath = currentFilePath();
            String targetPath = (currentPath != null) ? currentPath : listenerFallbackPhotoPath;

            if (mHdrBurstActive) {
                int frameIdx = mHdrBurstFramesReceived;
                mHdrBurstFramesReceived++;
                File parentDir = new File(targetPath).getParentFile();
                String bracketPath = new File(parentDir,
                        HdrBurstBuilder.bracketFileSuffix(frameIdx) + ".jpg").getAbsolutePath();
                boolean saved = saveImageDataToFile(bytes, bracketPath);
                Log.d(TAG, "HDR: Saved bracket " + (frameIdx + 1) + "/" + HdrBurstBuilder.HDR_BURST_COUNT
                        + " -> " + bracketPath + " (success=" + saved + ")");

                if (mHdrBurstFramesReceived >= HdrBurstBuilder.HDR_BURST_COUNT) {
                    mHdrBurstActive = false;

                    File ev0ParentDir = new File(targetPath).getParentFile();
                    String ev0Path = new File(ev0ParentDir, "ev0.jpg").getAbsolutePath();
                    try {
                        java.nio.file.Files.copy(
                            new File(ev0Path).toPath(),
                            new File(targetPath).toPath(),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    } catch (Exception copyErr) {
                        Log.w(TAG, "HDR: Could not copy EV0 as base file", copyErr);
                    }

                    if (mImuRecorder != null) {
                        String imuPath = mImuRecorder.stopRecordingAndSave(targetPath);
                        if (imuPath != null) {
                            Log.d(TAG, "IMU sidecar saved: " + imuPath);
                        }
                    }

                    notifyPhotoCaptured(targetPath);
                    Log.i(TAG, "HDR: Burst complete, base saved: " + targetPath);
                    clearCurrentRequest();

                    shotState = AeStateMachine.ShotState.IDLE;
                    processQueuedPhotoRequests();
                }
                return;
            }

            boolean success = saveImageDataToFile(bytes, targetPath);

            if (success) {
                if (mImuRecorder != null) {
                    String imuPath = mImuRecorder.stopRecordingAndSave(targetPath);
                    if (imuPath != null) {
                        Log.d(TAG, "IMU sidecar saved: " + imuPath);
                    }
                }

                notifyPhotoCaptured(targetPath);
                Log.d(TAG, "Photo saved successfully: " + targetPath);
                clearCurrentRequest();
            } else {
                if (mImuRecorder != null) {
                    mImuRecorder.cancel();
                }
                notifyPhotoError("Failed to save image");
            }

            shotState = AeStateMachine.ShotState.IDLE;
            processQueuedPhotoRequests();
        } catch (Exception e) {
            Log.e(TAG, "Error handling image data", e);
            notifyPhotoError("Error processing photo: " + e.getMessage());
            if (mImuRecorder != null) {
                mImuRecorder.cancel();
            }
            shotState = AeStateMachine.ShotState.IDLE;

            if (!PhotoRequestQueue.getInstance().isEmpty()) {
                processQueuedPhotoRequests();
            } else {
                cancelKeepAliveTimer();
                clearCurrentRequest();
                closeCamera();
                stopSelf();
            }
        }
    }

    /**
     * Setup MediaRecorder for video recording
     */
    private void setupMediaRecorder(String filePath) {
        try {
            // Check storage space before setting up recorder
            StorageManager storageManager = StorageManager.getInstance(this);
            if (!storageManager.canRecordVideo()) {
                throw new IOException("Insufficient storage space for video recording");
            }
            
            if (mediaRecorder == null) {
                mediaRecorder = new MediaRecorder();
            } else {
                mediaRecorder.reset();
            }

            // Set up media recorder sources and formats
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            mediaRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);

            // Set output format
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);

            // Set output file
            mediaRecorder.setOutputFile(filePath);

            // Set video encoding parameters
            // Use higher bitrate for better reliability and to prevent encoder issues
            int bitRate = VideoRecorderPolicy.videoEncodingBitRateForWidth(videoSize.getWidth());
            mediaRecorder.setVideoEncodingBitRate(bitRate);

            int frameRate = VideoRecorderPolicy.videoFrameRate(pendingVideoSettings);
            mediaRecorder.setVideoFrameRate(frameRate);
            Log.i(TAG, "Setting video resolution: " + videoSize.getWidth() + "x" + videoSize.getHeight());
            mediaRecorder.setVideoSize(videoSize.getWidth(), videoSize.getHeight());
            mediaRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            
            Log.d(TAG, "MediaRecorder configured: " + videoSize.getWidth() + "x" + videoSize.getHeight() + 
                      "@" + frameRate + "fps, bitrate: " + bitRate);

            // Set audio encoding parameters
            mediaRecorder.setAudioEncodingBitRate(VideoRecorderPolicy.AUDIO_ENCODING_BIT_RATE);
            mediaRecorder.setAudioSamplingRate(VideoRecorderPolicy.AUDIO_SAMPLING_RATE);
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);

            // Set dynamic orientation based on device rotation
            int displayOrientation = getDisplayRotation();
            int videoOrientation = JpegOrientationResolver.lookupJpegOrientation(
                    displayOrientation, JpegOrientationResolver.DEFAULT_VIDEO_ORIENTATION);
            mediaRecorder.setOrientationHint(videoOrientation);
            
            // Set maximum file size and duration based on available storage
            long maxFileSize = storageManager.getMaxVideoFileSize();
            int maxDuration = storageManager.getMaxVideoDuration(bitRate);
            
            try {
                mediaRecorder.setMaxFileSize(maxFileSize);
                Log.d(TAG, "Set max file size: " + (maxFileSize / (1024 * 1024)) + " MB");
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Failed to set max file size: " + e.getMessage());
            }
            
            try {
                mediaRecorder.setMaxDuration(maxDuration);
                Log.d(TAG, "Set max duration: " + (maxDuration / 1000) + " seconds");
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Failed to set max duration: " + e.getMessage());
            }
            
            // Set error listener to handle recording failures
            mediaRecorder.setOnErrorListener((mr, what, extra) -> {
                Log.e(TAG, "MediaRecorder error: what=" + what + ", extra=" + extra);
                isRecording = false;
                String errorMsg = VideoRecorderPolicy.mediaRecorderErrorMessage(what);
                // Delete the corrupt/incomplete video file so it's never synced
                deleteCorruptCapture(currentVideoPath);
                notifyVideoError(currentVideoId, errorMsg);
                // Try to clean up
                try {
                    if (mediaRecorder != null) {
                        mediaRecorder.reset();
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error resetting MediaRecorder after error", e);
                }
            });
            
            // Set info listener for recording events
            mediaRecorder.setOnInfoListener((mr, what, extra) -> {
                Log.d(TAG, "MediaRecorder info: what=" + what + ", extra=" + extra);
                if (VideoRecorderPolicy.isInfoMaxDurationReached(what)) {
                    Log.w(TAG, "Max duration reached, stopping recording");
                    stopCurrentVideoRecording(currentVideoId);
                } else if (VideoRecorderPolicy.isInfoMaxFileSizeReached(what)) {
                    Log.w(TAG, "Max file size reached, stopping recording");
                    stopCurrentVideoRecording(currentVideoId);
                } else if (VideoRecorderPolicy.isInfoMaxFileSizeApproaching(what)) {
                    Log.w(TAG, "Approaching max file size limit");
                }
            });

            // Prepare the recorder
            mediaRecorder.prepare();

            // Get the surface from the recorder
            recorderSurface = mediaRecorder.getSurface();

            Log.d(TAG, "MediaRecorder setup complete for: " + filePath);
        } catch (Exception e) {
            Log.e(TAG, "Error setting up MediaRecorder", e);
            if (mediaRecorder != null) {
                mediaRecorder.release();
                mediaRecorder = null;
            }
            notifyVideoError(currentVideoId, "Failed to set up video recorder: " + e.getMessage());
        }
    }

    /**
     * Save image data to file
     */
    private boolean saveImageDataToFile(byte[] data, String filePath) {
        try {
            File file = new File(filePath);

            // Ensure parent directory exists
            File parentDir = file.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }

            // Write image data to file
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

    /**
     * Single camera-open callback for both photo and video; behavior matches the former
     * {@code photoStateCallback} / {@code videoStateCallback} pair (Phase 2f prep).
     */
    private CameraDevice.StateCallback newCameraOpenStateCallback(final boolean forVideo) {
        return new CameraDevice.StateCallback() {
            @Override
            public void onOpened(@NonNull CameraDevice camera) {
                Log.d(TAG, "Camera device opened successfully");
                cameraOpenCloseLock.release();
                cameraDevice = camera;

                if (!forVideo) {
                    synchronized (SERVICE_LOCK) {
                        isCameraReady = true;
                        Log.d(TAG, "Camera marked as ready - processing any queued requests");
                    }
                }

                createCameraSessionInternal(forVideo);
            }

            @Override
            public void onDisconnected(@NonNull CameraDevice camera) {
                Log.d(TAG, "Camera device disconnected");
                cameraOpenCloseLock.release();
                camera.close();
                cameraDevice = null;
                if (forVideo) {
                    notifyVideoError(currentVideoId, "Camera disconnected");
                } else {
                    notifyPhotoError("Camera disconnected");
                }
                stopSelf();
            }

            @Override
            public void onError(@NonNull CameraDevice camera, int error) {
                Log.e(TAG, "Camera device error: " + error);
                cameraOpenCloseLock.release();
                camera.close();
                cameraDevice = null;
                if (forVideo) {
                    notifyVideoError(currentVideoId, "Camera device error: " + error);
                } else {
                    notifyPhotoError("Camera device error: " + error);
                }
                stopSelf();
            }
        };
    }

    private void createCameraSessionInternal(boolean forVideo) {
        try {
            if (cameraDevice == null) {
                Log.e(TAG, "Camera device is null in createCameraSessionInternal");
                if (forVideo) notifyVideoError(currentVideoId, "Camera not initialized");
                else notifyPhotoError("Camera not initialized");
                stopSelf();
                return;
            }

            List<Surface> surfaces = new ArrayList<>();
            if (forVideo) {
                if (recorderSurface == null) {
                    notifyVideoError(currentVideoId, "Recorder surface null");
                    conditionalStopSelf();
                    return;
                }
                surfaces.add(recorderSurface);
                previewBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                previewBuilder.addTarget(recorderSurface);
            } else {
                if (imageReaders == null) {
                    notifyPhotoError("ImageReader surface null");
                    stopSelf();
                    return;
                }
                // Phase 0: both surfaces are session outputs; preview repeating request targets the
                // YUV preview reader only — still reader is reserved for explicit capture() calls.
                surfaces.addAll(imageReaders.surfaces());

                previewBuilder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                previewBuilder.addTarget(imageReaders.getPreviewSurface());
                Log.d(TAG, "🔍 Using TEMPLATE_PREVIEW for repeating request, target=previewReader (ZSL compatible)");
            }

            // Configure auto-exposure settings for better photo quality
            previewBuilder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            previewBuilder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);

            // Use appropriate FPS range based on mode
            if (forVideo) {
                // For video: use fixed FPS range to ensure consistent frame rate
                // Using flexible range (like 5-30fps) allows AE to drop frame rate in low light
                int targetFps = (pendingVideoSettings != null) ? pendingVideoSettings.fps : 30;
                Range<Integer> videoFpsRange = Range.create(targetFps, targetFps);
                previewBuilder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, videoFpsRange);
                Log.d(TAG, "Video: Using fixed FPS range " + videoFpsRange + " for consistent frame rate");
            } else {
                // For photo: use dynamic FPS range to allow longer exposure times for MFNR
                previewBuilder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, selectedFpsRange);
                Log.d(TAG, "Photo: Using dynamic FPS range " + selectedFpsRange + " for exposure flexibility");
            }

            // Apply EIS (Electronic Image Stabilization) - VIDEO ONLY
            if (forVideo && eisEnabled) {
                enableEIS(previewBuilder, true);
                Log.d(TAG, "📹 EIS applied to video capture request");
            } else if (forVideo) {
                Log.d(TAG, "📹 EIS disabled for video");
            }

            // Apply 3DNR (temporal noise reduction) - VIDEO ONLY
            if (forVideo && mCameraSettings != null) {
                mCameraSettings.configure3DNR(previewBuilder);
            }

            // Apply user exposure compensation BEFORE capture (not during)
            previewBuilder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, userExposureCompensation);

            // Preview repeating request uses the small YUV surface; meter/AF in that coordinate space.
            Size sizeForMetering =
                    forVideo ? videoSize : new Size(ImageReaderTwin.PREVIEW_WIDTH, ImageReaderTwin.PREVIEW_HEIGHT);
            previewBuilder.set(CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[]{
                new MeteringRectangle(0, 0, sizeForMetering.getWidth(), sizeForMetering.getHeight(), MeteringRectangle.METERING_WEIGHT_MAX)
            });

            // Enable autofocus with center-weighted focus region for better subject focus
            if (hasAutoFocus) {
                previewBuilder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);

                // Add center-weighted AF region for better subject focus
                int centerX = sizeForMetering.getWidth() / 2;
                int centerY = sizeForMetering.getHeight() / 2;
                int regionSize = Math.min(sizeForMetering.getWidth(), sizeForMetering.getHeight()) / 3; // 1/3 of image size
                int left = Math.max(0, centerX - regionSize / 2);
                int top = Math.max(0, centerY - regionSize / 2);
                int right = Math.min(sizeForMetering.getWidth() - 1, centerX + regionSize / 2);
                int bottom = Math.min(sizeForMetering.getHeight() - 1, centerY + regionSize / 2);

                previewBuilder.set(CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[]{
                    new MeteringRectangle(left, top, right - left, bottom - top, MeteringRectangle.METERING_WEIGHT_MAX)
                });

                Log.d(TAG, "AF region set to center area: " + left + "," + top + " -> " + right + "," + bottom);
            } else {
                Log.d(TAG, "Autofocus not available, using fixed focus");
            }

            // Set auto white balance
            previewBuilder.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);

            // Enhanced image quality settings
            previewBuilder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
            previewBuilder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);

            if (!forVideo) {
                // Photo-specific settings - quality varies by size tier
                previewBuilder.set(CaptureRequest.JPEG_QUALITY, (byte) getJpegQualityForSize());
                int displayOrientation = getDisplayRotation();
                int jpegOrientation = JpegOrientationResolver.lookupJpegOrientation(
                        displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);
                previewBuilder.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation);
                Log.d(TAG, "Setting JPEG orientation: " + jpegOrientation + " for display orientation: " + displayOrientation);
                
                // Apply ZSL settings for photo preview (enables ZSL buffer for MFNR)
                if (mCameraSettings != null && mCameraSettings.isZslSupported()) {
                    mCameraSettings.configurePreviewBuilder(previewBuilder);
                }
            }

            CameraCaptureSession.StateCallback sessionStateCallback = new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(@NonNull CameraCaptureSession session) {
                    // Store the session atomically
                    synchronized (SERVICE_LOCK) {
                        cameraCaptureSession = session;
                    }
                    
                    if (forVideo) {
                        startRecordingInternal();
                    } else {
                        // Mark camera as fully ready
                        synchronized (SERVICE_LOCK) {
                            isCameraReady = true;
                            Log.d(TAG, "Camera session configured and ready");
                        }
                        
                        // Check if we have any pending global queue requests to process
                        synchronized (SERVICE_LOCK) {
                            if (!PhotoRequestQueue.getInstance().isEmpty()) {
                                Log.d(TAG, "Camera ready, processing " + PhotoRequestQueue.getInstance().size() + " queued requests");
                                // Don't call processNextPhotoRequest here as it might try to reopen camera
                                // Instead, start the preview and then trigger the first photo
                                PhotoRequest firstRequest = PhotoRequestQueue.getInstance().poll(); // Changed from peek() to poll() to remove from queue
                                if (firstRequest != null) {
                                    // Set up for the first queued photo
                                    sPhotoCallback = firstRequest.callback;
                                    loadCurrentRequest(firstRequest);
                                    // Store LED state from request
                                    pendingLedEnabled = firstRequest.enableLed;
                                }
                            }
                        }
                        
                        // Start proper preview for photos with AE state monitoring
                        startPreviewWithAeMonitoring();
                    }
                }

                @Override
                public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                    Log.e(TAG, "Failed to configure camera session for " + (forVideo ? "video" : "photo"));
                    if (forVideo)
                        notifyVideoError(currentVideoId, "Failed to configure camera for video");
                    else notifyPhotoError("Failed to configure camera for photo");
                    conditionalStopSelf();
                }
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                List<OutputConfiguration> outputConfigurations = new ArrayList<>();
                for (Surface surface : surfaces) {
                    outputConfigurations.add(new OutputConfiguration(surface));
                }
                SessionConfiguration config = new SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outputConfigurations, executor, sessionStateCallback);
                cameraDevice.createCaptureSession(config);
            } else {
                cameraDevice.createCaptureSession(surfaces, sessionStateCallback, backgroundHandler);
            }
        } catch (CameraAccessException e) {
            Log.e(TAG, "Camera access exception in createCameraSessionInternal", e);
            if (forVideo) notifyVideoError(currentVideoId, "Camera access error");
            else notifyPhotoError("Camera access error");
            conditionalStopSelf();
        } catch (IllegalStateException e) {
            Log.e(TAG, "Illegal state in createCameraSessionInternal", e);
            if (forVideo) notifyVideoError(currentVideoId, "Camera illegal state");
            else notifyPhotoError("Camera illegal state");
            conditionalStopSelf();
        }
    }

    private void startRecordingInternal() {
        if (cameraDevice == null || cameraCaptureSession == null || mediaRecorder == null) {
            notifyVideoError(currentVideoId, "Cannot start recording, camera not ready.");
            return;
        }
        try {
            cameraCaptureSession.setRepeatingRequest(previewBuilder.build(), null, backgroundHandler);
            
            // Add small delay to ensure camera surface is connected and first frames are captured
            // This helps prevent audio-only recordings
            backgroundHandler.postDelayed(() -> {
                try {
                    if (cameraCaptureSession == null || recorderSurface == null || !recorderSurface.isValid()) {
                        Log.e(TAG, "Camera not ready for recording - surface invalid");
                        notifyVideoError(currentVideoId, "Camera not ready for recording");
                        return;
                    }
                    
                    mediaRecorder.start();
                    isRecording = true;
                    recordingStartTime = System.currentTimeMillis();

                    // Start IMU recording for video
                    if (mImuRecorder == null) {
                        mImuRecorder = new com.mentra.asg_client.sensors.ImuRecorder(CameraNeo.this);
                    }
                    mImuRecorder.startRecording();

                    // Clear pending settings after use
                    pendingVideoSettings = null;
                    if (sVideoCallback != null) {
                        sVideoCallback.onRecordingStarted(currentVideoId);
                    }
                    // Start progress timer if callback is interested
                    if (sVideoCallback != null) {
                        recordingTimer = new Timer();
                        recordingTimer.schedule(new TimerTask() {
                            @Override
                            public void run() {
                                if (isRecording && sVideoCallback != null) {
                                    long duration = System.currentTimeMillis() - recordingStartTime;
                                    sVideoCallback.onRecordingProgress(currentVideoId, duration);
                                }
                            }
                        }, 1000, 1000); // Update every second
                    }
                    Log.d(TAG, "Video recording started for: " + currentVideoId);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to start recording after delay", e);
                    notifyVideoError(currentVideoId, "Failed to start recording: " + e.getMessage());
                    isRecording = false;
                }
            }, 900); // 600ms delay to ensure surface is ready
        } catch (CameraAccessException | IllegalStateException e) {
            Log.e(TAG, "Failed to start video recording", e);
            notifyVideoError(currentVideoId, "Failed to start recording: " + e.getMessage());
            isRecording = false;
        }
    }

        /**
     * Choose the optimal size from available choices based on desired dimensions.
     * Finds the size with the smallest total difference between requested and available dimensions.
     *
     * @param choices Available size options
     * @param desiredWidth Target width
     * @param desiredHeight Target height
     * @return The closest matching size, or null if no choices available
     */
    private Size chooseOptimalSize(Size[] choices, int desiredWidth, int desiredHeight) {
        if (choices == null || choices.length == 0) {
            Log.w(TAG, "No size choices available");
            return null;
        }

        // First, try to find an exact match
        for (Size option : choices) {
            if (option.getWidth() == desiredWidth && option.getHeight() == desiredHeight) {
                Log.i(TAG, "Found exact size match: " + option.getWidth() + "x" + option.getHeight());
                return option;
            }
        }

        // No exact match found, find the size with smallest total dimensional difference
        Log.i(TAG, "No exact match found for " + desiredWidth + "x" + desiredHeight + ", finding closest size");
        Log.i(TAG, "Available size options (" + choices.length + " total):");

        Size bestSize = choices[0];
        int smallestDifference = Integer.MAX_VALUE;

        for (Size option : choices) {
            int widthDiff = Math.abs(option.getWidth() - desiredWidth);
            int heightDiff = Math.abs(option.getHeight() - desiredHeight);
            int totalDifference = widthDiff + heightDiff;

            // Log each candidate with its difference
            Log.i(TAG, "  " + option.getWidth() + "x" + option.getHeight() + 
                  " (diff: " + totalDifference + " = width+" + widthDiff + " height+" + heightDiff + ")");

            if (totalDifference < smallestDifference) {
                smallestDifference = totalDifference;
                bestSize = option;
            }
        }

        Log.i(TAG, "Selected optimal size: " + bestSize.getWidth() + "x" + bestSize.getHeight() +
              " (total difference: " + smallestDifference + " from requested " + desiredWidth + "x" + desiredHeight + ")");

        return bestSize;
    }

    /**
     * Delete a corrupt or incomplete capture directory to prevent it from being
     * synced to the mobile app. Called when MediaRecorder.stop() fails or an
     * error callback fires during recording.
     */
    private void deleteCorruptCapture(String videoPath) {
        if (videoPath == null) return;
        try {
            File videoFile = new File(videoPath);
            File captureDir = videoFile.getParentFile();
            if (captureDir != null && captureDir.exists() && captureDir.isDirectory()) {
                String dirName = captureDir.getName();
                if (dirName.startsWith("VID_") || dirName.startsWith("IMG_")) {
                    File[] files = captureDir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            f.delete();
                        }
                    }
                    captureDir.delete();
                    Log.w(TAG, "Deleted corrupt capture directory: " + captureDir.getAbsolutePath());
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to delete corrupt capture at " + videoPath, e);
        }
    }

    private void notifyVideoError(String videoId, String errorMessage) {
        if (sVideoCallback != null && videoId != null) {
            executor.execute(() -> sVideoCallback.onRecordingError(videoId, errorMessage));
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        synchronized (SERVICE_LOCK) {
            Log.d(TAG, "CameraNeo service destroying - Setting state to IDLE");
            serviceState = ServiceState.STOPPING;
            
            // Cancel keep-alive timer if it's running
            cancelKeepAliveTimer();
            if (isRecording) {
                stopCurrentVideoRecording(currentVideoId);
            }
            closeCamera();
            stopBackgroundThread();
            releaseWakeLocks();
            
            // Update static state
            isServiceRunning = false;
            isServiceStarting = false;
            isCameraReady = false;
            serviceState = ServiceState.IDLE;
            sInstance = null;
            
            PhotoRequestQueue.getInstance().failAllPending("Camera service terminated unexpectedly");
        }
    }

    private void notifyPhotoCaptured(String filePath) {
        long startMs = currentStartTimeMs();
        long e2eTimeMs = (startMs > 0) ? (System.currentTimeMillis() - startMs) : -1L;
        Log.i(TAG, "📸 PHOTO E2E: Photo captured and saved in " + e2eTimeMs + "ms (e2e) | Path: " + filePath);

        if (sPhotoCallback != null) {
            executor.execute(() -> sPhotoCallback.onPhotoCaptured(filePath));
        }
    }

    private void notifyPhotoError(String errorMessage) {
        if (sPhotoCallback != null) {
            executor.execute(() -> sPhotoCallback.onPhotoError(errorMessage));
        }
    }

    /**
     * Start background thread
     */
    private void startBackgroundThread() {
        backgroundThread = new HandlerThread("CameraNeoBackground");
        backgroundThread.start();
        backgroundHandler = new Handler(backgroundThread.getLooper());
    }

    /**
     * Stop background thread
     */
    private void stopBackgroundThread() {
        if (backgroundThread != null) {
            backgroundThread.quitSafely();
            try {
                backgroundThread.join();
                backgroundThread = null;
                backgroundHandler = null;
            } catch (InterruptedException e) {
                Log.e(TAG, "Interrupted when stopping background thread", e);
            }
        }
    }

    /**
     * Close camera resources
     */
    private void closeCamera() {
        boolean lockAcquired = false;
        try {
            lockAcquired = cameraOpenCloseLock.tryAcquire(5000, TimeUnit.MILLISECONDS);
            if (!lockAcquired) {
                Log.e(TAG, "closeCamera: Failed to acquire lock within 5 seconds, proceeding with cleanup anyway");
            }
            if (cameraCaptureSession != null) {
                cameraCaptureSession.close();
                cameraCaptureSession = null;
            }
            if (cameraDevice != null) {
                cameraDevice.close();
                cameraDevice = null;
            }
            if (imageReaders != null) {
                imageReaders.close();
                imageReaders = null;
            }
            if (mediaRecorder != null) {
                mediaRecorder.release();
                mediaRecorder = null;
            }
            if (recorderSurface != null) {
                recorderSurface.release();
                recorderSurface = null;
            }
            // Reset keep-alive flag when camera is actually closed
            isCameraKeptAlive = false;

            // Reset LED state when camera closes (flash already completed automatically)
            if (pendingLedEnabled) {
                pendingLedEnabled = false;  // Reset LED state
            }

            releaseWakeLocks();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted while closing camera", e);
        } finally {
            if (lockAcquired) {
                cameraOpenCloseLock.release();
            }
        }
    }

    /**
     * Start the keep-alive timer to keep camera open for rapid successive shots
     */
    private void startKeepAliveTimer() {
        Log.d(TAG, "Starting camera keep-alive timer for " + CAMERA_KEEP_ALIVE_MS + "ms");
        
        // Cancel any existing timer first
        cancelKeepAliveTimer();
        
        // Mark camera as kept alive
        isCameraKeptAlive = true;
        
        // Create new timer
        cameraKeepAliveTimer = new Timer();
        cameraKeepAliveTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                // Run on background handler to ensure proper thread
                if (backgroundHandler != null) {
                    backgroundHandler.post(() -> {
                        // Don't close camera if capture is in progress - extend the timer instead
                        if (shotState != AeStateMachine.ShotState.IDLE) {
                            Log.w(TAG, "⚠️ Keep-alive expired but capture in progress (state: " + shotState +
                                  ") - extending timer");
                            startKeepAliveTimer();
                            return;
                        }
                        Log.d(TAG, "Camera keep-alive timer expired, closing camera");
                        isCameraKeptAlive = false;
                        closeCamera();
                        stopSelf();
                    });
                } else {
                    // Fallback if handler is not available
                    if (shotState != AeStateMachine.ShotState.IDLE) {
                        Log.w(TAG, "⚠️ Keep-alive expired but capture in progress (state: " + shotState +
                              ") - cannot extend (no handler)");
                        return;
                    }
                    Log.d(TAG, "Camera keep-alive timer expired, closing camera");
                    isCameraKeptAlive = false;
                    closeCamera();
                    stopSelf();
                }
            }
        }, CAMERA_KEEP_ALIVE_MS);
    }
    
    /**
     * Process any queued photo requests after completing current photo
     */
    private void processQueuedPhotoRequests() {
        // First check the global queue (primary)
        synchronized (SERVICE_LOCK) {
            if (!PhotoRequestQueue.getInstance().isEmpty() && shotState == AeStateMachine.ShotState.IDLE) {
                PhotoRequest nextRequest = PhotoRequestQueue.getInstance().poll();
                if (nextRequest != null) {
                    Log.d(TAG, "Processing queued photo from GLOBAL queue: " + nextRequest.filePath);
                    
                    // Update the callback for this request
                    sPhotoCallback = nextRequest.callback;

                    // Cancel any pending keep-alive timer
                    cancelKeepAliveTimer();

                    Log.i(TAG, "📸 PHOTO E2E: Starting queued photo request " + nextRequest.requestId);

                    // Process the queued request (timestamp + filePath + size + isFromSdk + exposure bundled)
                    loadCurrentRequest(nextRequest);

                    // Update LED state if this request needs LED
                    if (nextRequest.enableLed) {
                        pendingLedEnabled = true;
                    }

                    // IMPORTANT: Only start capture if camera is ready
                    // Don't try to open camera again if it's already open
                    if (cameraDevice != null && cameraCaptureSession != null) {
                        // Start new capture sequence
                        shotState = AeStateMachine.ShotState.WAITING_AE;
                        if (backgroundHandler != null) {
                            backgroundHandler.post(() -> startPrecaptureSequence());
                        } else {
                            startPrecaptureSequence();
                        }
                    } else {
                        // Camera not ready yet, re-queue the request
                        Log.d(TAG, "Camera not ready yet, re-queuing request");
                        PhotoRequestQueue.getInstance().offer(nextRequest);
                    }
                    return;
                }
            }
        }
        
        // No more requests in global queue, start keep-alive timer
        if (PhotoRequestQueue.getInstance().isEmpty()) {
            startKeepAliveTimer();
        }
    }
    
    /**
     * Cancel the keep-alive timer
     */
    private void cancelKeepAliveTimer() {
        if (cameraKeepAliveTimer != null) {
            Log.d(TAG, "Cancelling camera keep-alive timer");
            cameraKeepAliveTimer.cancel();
            cameraKeepAliveTimer = null;
        }
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
        try {
            // First, release all current camera resources
            releaseCameraResources();

            Log.d(TAG, "Camera service restart attempt made - waiting for system to release camera");

            // Implement retry mechanism with delay to handle policy-disabled errors
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Log.d(TAG, "Attempting camera restart with delayed retry");

                // Try with a different camera ID if available
                CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
                if (manager != null) {
                    try {
                        String[] cameraIds = manager.getCameraIdList();
                        // If we were using camera "0", try a different one if available
                        if (cameraIds.length > 1 && "0".equals(cameraId)) {
                            this.cameraId = "1";
                            Log.d(TAG, "Switching to alternate camera ID: " + this.cameraId);
                        }
                    } catch (CameraAccessException e) {
                        Log.e(TAG, "Error accessing camera during retry", e);
                    }
                }

                // Request camera focus - this can help on some devices by signaling
                // to the system that camera is needed
                wakeUpScreen();

                // Try releasing all app camera resources forcibly
                if (cameraDevice != null) {
                    cameraDevice.close();
                    cameraDevice = null;
                }

                if (cameraCaptureSession != null) {
                    cameraCaptureSession.close();
                    cameraCaptureSession = null;
                }

                System.gc(); // Request garbage collection
            }, 1000); // Short delay before retry
        } catch (Exception e) {
            Log.e(TAG, "Error in camera service restart", e);
        }
    }

    /**
     * Release all camera system resources
     */
    private void releaseCameraResources() {
        try {
            // Request to release system-wide camera resources
            closeCamera();

            // For policy-based restrictions, we need to ensure camera resources are fully released
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // On newer Android versions, encourage system resource release
                CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
                if (manager != null) {
                    // Nothing we can directly do to force release, but we can
                    // make sure our resources are gone
                    if (cameraDevice != null) {
                        cameraDevice.close();
                        cameraDevice = null;
                    }
                    System.gc();
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing camera resources", e);
        }
    }

    // -----------------------------------------------------------------------------------
    // Notification handling
    // -----------------------------------------------------------------------------------

    private void showNotification(String title, String message) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(false);

        // Start in foreground
        startForeground(NOTIFICATION_ID, builder.build());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Camera Neo Service Channel",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
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

    /**
     * Start preview with AE monitoring - called when camera session is ready
     */
    private void startPreviewWithAeMonitoring() {
        try {
            // Check if session is still valid before using it
            if (cameraCaptureSession == null) {
                Log.e(TAG, "Camera capture session is null in startPreviewWithAeMonitoring");
                notifyPhotoError("Camera session not ready");
                closeCamera();
                stopSelf();
                return;
            }
            
            // Build preview request and verify ZSL is configured
            CaptureRequest previewRequest = previewBuilder.build();
            Boolean zslInPreview = previewRequest.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            if (zslInPreview != null && zslInPreview) {
                Log.d(TAG, "✓ ZSL verified in preview request: CONTROL_ENABLE_ZSL = true (buffer filling)");
            } else {
                Log.w(TAG, "⚠ ZSL NOT enabled in preview request - ZSL buffer will not fill!");
            }
            
            // Start repeating preview request with AE monitoring
            cameraCaptureSession.setRepeatingRequest(previewRequest,
                aeCallback, backgroundHandler);

            // Trigger the capture sequence immediately
            startPrecaptureSequence();

        } catch (CameraAccessException e) {
            Log.e(TAG, "Error starting preview with AE monitoring", e);
            notifyPhotoError("Error starting preview: " + e.getMessage());
            cancelKeepAliveTimer();
            closeCamera();
            stopSelf();
        }
    }

    /**
     * Start simplified AE convergence sequence
     * Following XyCamera2 pattern: set waiting flag, let repeating request callback monitor AE
     */
    private void startPrecaptureSequence() {
        try {
            shotState = AeStateMachine.ShotState.WAITING_AE;

            if (shouldUseManualExposure()) {
                Log.i(TAG, "Manual exposure (exposureTimeNs=" + currentExposureTimeNs() + "): skipping AE convergence");
                mWaitingForAeConvergence = false;
                mAeLockRequested = false;
                Runnable runCapture = () -> capturePhoto();
                if (backgroundHandler != null) {
                    backgroundHandler.post(runCapture);
                } else {
                    runCapture.run();
                }
                return;
            }

            mWaitingForAeConvergence = true;
            mAeLockRequested = false;
            aeStartTimeNs = System.nanoTime();

            // Check if ZSL is enabled
            boolean zslEnabled = (mCameraSettings != null && mCameraSettings.isZslSupported() &&
                                 mCameraSettings.mAsgSettings.isZslEnabled());

            Log.d(TAG, "🔍 DIAGNOSTIC: startPrecaptureSequence() called");
            Log.d(TAG, "🔍 ZSL enabled: " + zslEnabled);
            Log.d(TAG, "🔍 Current shot state: " + shotState);
            Log.d(TAG, "🔍 Waiting for AE convergence: " + mWaitingForAeConvergence);

            // Start AE convergence - autofocus runs automatically in CONTINUOUS_PICTURE mode
            Log.d(TAG, "Starting AE convergence (monitoring via repeating request callback)...");
            
            // XyCamera2 pattern: Don't send any triggers, just set the waiting flag
            // The repeating request callback (aeCallback) will monitor AE state and trigger capture when ready
            Log.d(TAG, "🔍 XyCamera2 MODE: No precapture trigger - monitoring AE via repeating request callback");

        } catch (Exception e) {
            Log.e(TAG, "Error starting AE convergence", e);
            notifyPhotoError("Error starting AE convergence: " + e.getMessage());
            shotState = AeStateMachine.ShotState.IDLE;
            mWaitingForAeConvergence = false;
            cancelKeepAliveTimer();
            closeCamera();
            stopSelf();
        }
    }

    /**
     * Simplified AE callback that waits briefly for exposure convergence
     * Following XyCamera2 pattern: monitor AE in repeating request, request lock, then capture
     */
    private class SimplifiedAeCallback extends CameraCaptureSession.CaptureCallback {
        private int callbackCount = 0;  // Diagnostic counter
        
        @Override
        public void onCaptureCompleted(@NonNull CameraCaptureSession session,
                                     @NonNull CaptureRequest request,
                                     @NonNull TotalCaptureResult result) {

            callbackCount++;

            Integer sensEarly = result.get(CaptureResult.SENSOR_SENSITIVITY);
            if (sensEarly != null && sensEarly > 0) {
                mLastMeteredIso = sensEarly;
            }
            Long exposureEarly = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            if (exposureEarly != null && exposureEarly > 0) {
                mLastMeteredExposureNs = exposureEarly;
            }
            
            // Log first few callbacks to verify it's being invoked
            if (callbackCount <= 10 || callbackCount % 30 == 0) {
                Log.d(TAG, "🔍 AE callback #" + callbackCount + " | Shot state: " + shotState + " | Waiting: " + mWaitingForAeConvergence + " | LockRequested: " + mAeLockRequested);
            }

            // Only process if we're waiting for AE convergence
            if (!mWaitingForAeConvergence) {
                return;
            }

            Integer aeState = result.get(CaptureResult.CONTROL_AE_STATE);

            // Check if this callback is from the repeating request or one-shot precapture
            Integer precaptureTrigger = request.get(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER);
            Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);

            if (callbackCount <= 5) {
                Log.d(TAG, "🔍 Request details - ZSL: " + zslInRequest + ", Precapture trigger: "
                        + precaptureTrigger + ", AE state: " + AeStateMachine.getAeStateName(aeState));
            }

            long elapsedNs = System.nanoTime() - aeStartTimeNs;
            AeStateMachine.AeRepeatCaptureDecision decision =
                    AeStateMachine.evaluateRepeatingRequestAeStep(
                            mWaitingForAeConvergence, mAeLockRequested, aeState, elapsedNs);

            switch (decision) {
                case CONTINUE_WAITING_NULL_AE:
                    Log.w(TAG, "AE_STATE is null in callback");
                    if (callbackCount % 10 == 0) {
                        Log.w(TAG, "🔍 Still waiting for AE state... (callback #" + callbackCount + ")");
                    }
                    break;
                case CAPTURE_NOW_TIMEOUT: {
                    long elapsedMs = elapsedNs / 1_000_000;
                    Log.w(TAG, "🔍 ⚠️ AE CONVERGENCE TIMEOUT after " + elapsedMs + "ms (limit: "
                            + (AeStateMachine.AE_WAIT_NS / 1_000_000) + "ms), forcing capture");
                    mWaitingForAeConvergence = false;
                    mAeLockRequested = false;
                    capturePhoto();
                    break;
                }
                case CAPTURE_NOW_LOCK_CONFIRMED: {
                    long totalElapsedMs = elapsedNs / 1_000_000;
                    Log.i(TAG, "🔍 ✅ AE LOCKED in " + totalElapsedMs + "ms total! State: "
                            + AeStateMachine.getAeStateName(aeState) + ", capturing photo");
                    mAeLockRequested = false;
                    mWaitingForAeConvergence = false;
                    capturePhoto();
                    break;
                }
                case CONTINUE_WAITING_FOR_LOCK:
                    if (callbackCount % 10 == 0) {
                        Log.d(TAG, "🔍 Waiting for AE lock... State: "
                                + AeStateMachine.getAeStateName(aeState));
                    }
                    break;
                case CAPTURE_AFTER_STABILIZATION_DELAY: {
                    long elapsedMs = elapsedNs / 1_000_000;
                    Log.i(TAG, "🔍 ✅ AE CONVERGED in " + elapsedMs + "ms! State: "
                            + AeStateMachine.getAeStateName(aeState) + ", waiting "
                            + AeStateMachine.EXPOSURE_STABILIZATION_DELAY_MS
                            + "ms for exposure stabilization [FAST MODE]");
                    mWaitingForAeConvergence = false;
                    mAeLockRequested = false;
                    backgroundHandler.postDelayed(() -> {
                        Log.i(TAG, "🔍 Exposure stabilization complete, capturing photo");
                        capturePhoto();
                    }, AeStateMachine.EXPOSURE_STABILIZATION_DELAY_MS);
                    break;
                }
                case REQUEST_AE_LOCK: {
                    long elapsedMs = elapsedNs / 1_000_000;
                    Log.i(TAG, "🔍 ✅ AE CONVERGED in " + elapsedMs + "ms! State: "
                            + AeStateMachine.getAeStateName(aeState)
                            + ", requesting AE lock [LEGACY MODE]");
                    requestAeLock(session);
                    break;
                }
                case CONTINUE_WAITING_FOR_CONVERGENCE:
                    if (callbackCount % 10 == 0) {
                        Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                        Long exposureTime = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                        Log.d(TAG, "🔍 Waiting for AE convergence... State: "
                                + AeStateMachine.getAeStateName(aeState)
                                + ", ISO: " + iso + ", Exposure: "
                                + (exposureTime != null ? exposureTime / 1_000_000.0 : "null") + "ms");
                    }
                    break;
                case IGNORE_NOT_WAITING:
                    break;
            }
        }

        @Override
        public void onCaptureFailed(@NonNull CameraCaptureSession session,
                                  @NonNull CaptureRequest request,
                                  @NonNull CaptureFailure failure) {
            // Diagnostic: Check what type of request failed
            Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
            Integer precaptureTrigger = request.get(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER);
            Boolean aeLock = request.get(CaptureRequest.CONTROL_AE_LOCK);
            
            Log.e(TAG, "🔍 DIAGNOSTIC: Capture failed during AE sequence");
            Log.e(TAG, "🔍 Failure reason: " + failure.getReason());
            Log.e(TAG, "🔍 ZSL in request: " + zslInRequest);
            Log.e(TAG, "🔍 AE lock in request: " + aeLock);
            Log.e(TAG, "🔍 Precapture trigger in request: " + precaptureTrigger);
            Log.e(TAG, "🔍 Shot state: " + shotState);
            Log.e(TAG, "🔍 Waiting flags - AE convergence: " + mWaitingForAeConvergence + ", Lock requested: " + mAeLockRequested);
            Log.e(TAG, "🔍 Frame number: " + failure.getFrameNumber());
            Log.e(TAG, "🔍 Was image captured: " + failure.wasImageCaptured());
            
            // XyCamera2 pattern: Failures from repeating request during SHOOTING are normal, ignore them
            if (shotState == AeStateMachine.ShotState.SHOOTING) {
                Log.d(TAG, "🔍 Failure during SHOOTING state - likely from repeating request, ignoring");
                return;
            }
            
            notifyPhotoError("AE sequence failed: " + failure.getReason());
            shotState = AeStateMachine.ShotState.IDLE;
            mWaitingForAeConvergence = false;
            mAeLockRequested = false;
            cancelKeepAliveTimer();
            closeCamera();
            stopSelf();
        }
    }
    
    /**
     * Request AE lock (XyCamera2 pattern)
     * Updates the repeating request to lock AE, then waits for lock confirmation
     */
    private void requestAeLock(CameraCaptureSession session) {
        if (session == null || cameraDevice == null) {
            Log.w(TAG, "Cannot lock AE: session/camera is null");
            return;
        }

        try {
            Log.d(TAG, "🔍 Requesting AE lock by updating repeating request");
            
            // Update preview builder to request AE lock
            previewBuilder.set(CaptureRequest.CONTROL_AE_LOCK, true);
            
            // Keep ZSL settings applied
            if (mCameraSettings != null && mCameraSettings.isZslSupported()) {
                mCameraSettings.configurePreviewBuilder(previewBuilder);
            }
            
            // Update the repeating request with AE lock
            session.setRepeatingRequest(previewBuilder.build(), aeCallback, backgroundHandler);
            mAeLockRequested = true;
            shotState = AeStateMachine.ShotState.WAITING_AE_LOCK;
            Log.d(TAG, "🔍 AE lock requested via repeating request (CONTROL_AE_LOCK=true)");
        } catch (Exception e) {
            Log.e(TAG, "Failed to lock AE: " + e.getMessage());
            mAeLockRequested = false;
            mWaitingForAeConvergence = false;
            // Force capture on error
            capturePhoto();
        }
    }
    
    /**
     * Restore preview after capture (XyCamera2 pattern)
     * Unlocks AE and restores repeating request with ZSL enabled
     */
    private void restorePreview(CameraCaptureSession session) {
        try {
            if (session == null || cameraDevice == null) {
                Log.w(TAG, "Cannot restore preview: session/camera is null");
                return;
            }
            
            Log.d(TAG, "🔍 Restoring preview after capture (unlocking AE)");
            
            // Unlock AE and restore preview settings
            previewBuilder.set(CaptureRequest.CONTROL_AE_LOCK, false);
            mAeLockRequested = false;
            
            // Apply ZSL settings for preview
            if (mCameraSettings != null && mCameraSettings.isZslSupported()) {
                mCameraSettings.configurePreviewBuilder(previewBuilder);
            }
            
            // Restore repeating preview request
            session.setRepeatingRequest(previewBuilder.build(), aeCallback, backgroundHandler);
            Log.d(TAG, "🔍 Preview restored (AE unlocked, repeating request restarted)");
        } catch (Exception e) {
            Log.e(TAG, "Failed to restore preview: " + e.getMessage());
        }
    }

    private boolean shouldUseManualExposure() {
        Long exposureNs = currentExposureTimeNs();
        boolean manualSupported = cameraCapabilities != null && cameraCapabilities.manualSensorSupported;
        Range<Long> expRange = (cameraCapabilities != null) ? cameraCapabilities.sensorExposureTimeRange : null;
        Range<Integer> isoRange = (cameraCapabilities != null) ? cameraCapabilities.sensorSensitivityRange : null;
        boolean decision;
        String reason;
        if (exposureNs == null || exposureNs <= 0) {
            decision = false;
            reason = "no/invalid currentRequest.exposureTimeNs";
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
        // #region agent log
        try {
            android.util.Log.i("MentraDbg",
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H0\",\"location\":\"CameraNeo:shouldUseManualExposure\",\"timestamp\":" + System.currentTimeMillis()
                + ",\"message\":\"manual exposure decision\",\"data\":{"
                + "\"decision\":" + decision
                + ",\"reason\":\"" + reason + "\""
                + ",\"pendingExposureTimeNs\":" + exposureNs
                + ",\"manualSensorSupported\":" + manualSupported
                + "}}");
        } catch (Throwable t) { /* never let logging crash capture */ }
        // #endregion
        return decision;
    }

    /**
     * Explains why the still capture path uses auto exposure ({@link #capturePhoto}), for a single INFO line in logcat.
     */
    private String describeAutoExposureStillPath() {
        Long exposureNs = currentExposureTimeNs();
        if (exposureNs == null) {
            return "no pending exposureNs (auto AE)";
        }
        if (exposureNs <= 0) {
            return "pending exposureNs invalid (" + exposureNs + ")";
        }
        if (cameraCapabilities == null || !cameraCapabilities.manualSensorSupported) {
            return "manual requested but MANUAL_SENSOR unsupported";
        }
        if (cameraCapabilities.sensorExposureTimeRange == null
                || cameraCapabilities.sensorSensitivityRange == null) {
            return "manual requested but sensor ranges unavailable";
        }
        return "auto AE path";
    }

    private long clampExposureTimeNs(long requestedNs) {
        Range<Long> range = (cameraCapabilities != null) ? cameraCapabilities.sensorExposureTimeRange : null;
        return ManualExposurePolicy.clampExposureTimeNs(requestedNs, range);
    }

    private int pickSensitivityForManualCapture(long targetExposureNs) {
        Integer last = mLastMeteredIso;
        Long meteredExposureNs = mLastMeteredExposureNs;
        Range<Integer> isoRange = (cameraCapabilities != null) ? cameraCapabilities.sensorSensitivityRange : null;

        int isoBeforeScale = (last != null && last > 0) ? last.intValue() : ManualExposurePolicy.DEFAULT_ISO;
        double evScaleApplied = 1.0;
        int isoAfterScale = isoBeforeScale;
        if (meteredExposureNs != null && meteredExposureNs > 0 && targetExposureNs > 0 && isoBeforeScale > 0) {
            evScaleApplied = (double) meteredExposureNs / (double) targetExposureNs;
            isoAfterScale = (int) Math.round(isoBeforeScale * evScaleApplied);
        }

        int iso = ManualExposurePolicy.pickSensitivityForManualCapture(
                targetExposureNs, last, meteredExposureNs, isoRange);

        // #region agent log
        try {
            Integer isoLow = (isoRange != null) ? isoRange.getLower() : null;
            Integer isoHigh = (isoRange != null) ? isoRange.getUpper() : null;
            android.util.Log.i("MentraDbg",
                "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H1\",\"location\":\"CameraNeo:pickSensitivityForManualCapture\",\"timestamp\":" + System.currentTimeMillis()
                + ",\"message\":\"manual ISO computation\",\"data\":{"
                + "\"meteredIso\":" + last
                + ",\"meteredExposureNs\":" + meteredExposureNs
                + ",\"targetExposureNs\":" + targetExposureNs
                + ",\"evScale\":" + String.format(java.util.Locale.US, "%.4f", evScaleApplied)
                + ",\"isoBeforeScale\":" + isoBeforeScale
                + ",\"isoAfterScale\":" + isoAfterScale
                + ",\"isoFinalClamped\":" + iso
                + ",\"sensorIsoLow\":" + isoLow
                + ",\"sensorIsoHigh\":" + isoHigh
                + ",\"xyCamera2WouldUseIso\":" + ManualExposurePolicy.DEFAULT_ISO
                + "}}");
        } catch (Throwable t) { /* never let logging crash capture */ }
        // #endregion
        return iso;
    }

    private long pickFrameDurationForManualCapture(long exposureNs) {
        Long maxFrameNs = (cameraCapabilities != null) ? cameraCapabilities.sensorMaxFrameDurationNs : null;
        return ManualExposurePolicy.pickFrameDurationForManualCapture(exposureNs, maxFrameNs);
    }

    /**
     * Simplified photo capture - relies on AE convergence and automatic CONTINUOUS_PICTURE autofocus
     */
    private void capturePhoto() {
        if (shotState == AeStateMachine.ShotState.SHOOTING) {
            Log.d(TAG, "capturePhoto() skipped — another capture already in-flight");
            return;
        }

        // Check if HDR burst is enabled and we're capturing a button photo (not SDK)
        boolean hdrEnabled = mCameraSettings != null
                && mCameraSettings.mAsgSettings.isHdrBurstEnabled()
                && !currentIsFromSdk();

        if (hdrEnabled) {
            captureHdrBurst();
            return;
        }

        try {
            shotState = AeStateMachine.ShotState.SHOOTING;

            // Start IMU recording for this capture
            if (mImuRecorder == null) {
                mImuRecorder = new com.mentra.asg_client.sensors.ImuRecorder(this);
            }
            mImuRecorder.startRecording();

            // Create still capture request with high quality settings.
            // Phase 0: target the still reader only. The repeating preview request targets the
            // separate preview reader, so the stop-repeating + drain workaround is no longer needed
            // to guarantee that acquireLatestImage() returns the manual still frame.
            CaptureRequest.Builder stillBuilder =
                cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
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

            int displayOrientation = getDisplayRotation();
            int jpegOrientation = JpegOrientationResolver.lookupJpegOrientation(
                    displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);

            // Phase 2c: stamp the full still-capture recipe via the extracted builder helper.
            StillCaptureBuilder.configure(StillCaptureBuilder.wrap(stillBuilder), useManual,
                    manualClampedNs, manualIso, manualFrameDurationNs, userExposureCompensation,
                    selectedFpsRange, hasAutoFocus, jpegSize, getJpegQualityForSize(),
                    jpegOrientation);

            Log.d(TAG, "Capturing photo with JPEG orientation: " + jpegOrientation
                    + " for display orientation: " + displayOrientation);

            // Apply ZSL + MFNR settings for photo capture (if supported) — skipped for manual exposure
            // because manual SENSOR_* keys conflict with the vendor MFNR pipeline.
            if (!useManual && mCameraSettings != null
                    && (mCameraSettings.mAsgSettings.isZslEnabled()
                        || mCameraSettings.mAsgSettings.isMfnrEnabled())) {
                mCameraSettings.configureCaptureBuilder(stillBuilder);
            }

            // Capture the photo immediately
            // CRITICAL: Do NOT call stopRepeating() before capture — this would clear the ZSL buffer
            // ZSL buffer is required for MFNR to access historical frames for multi-frame merging
            // The repeating request must continue running to maintain the circular buffer
            // Build the capture request
            CaptureRequest captureRequest = stillBuilder.build();

            // Verify ZSL is actually configured in the request (when enabled via settings)
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

            // #region agent log
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
                android.util.Log.i("MentraDbg",
                    "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H1+H2+H3+H4\",\"location\":\"CameraNeo:capturePhoto:beforeCapture\",\"timestamp\":" + System.currentTimeMillis()
                    + ",\"message\":\"still request keys (what HAL will see)\",\"data\":{"
                    + "\"useManual\":" + useManual
                    + ",\"req_SENSOR_EXPOSURE_TIME_ns\":" + reqExp
                    + ",\"req_SENSOR_SENSITIVITY\":" + reqIso
                    + ",\"req_SENSOR_FRAME_DURATION_ns\":" + reqFrameDur
                    + ",\"req_CONTROL_AE_MODE\":" + reqAeMode
                    + ",\"req_NOISE_REDUCTION_MODE\":" + reqNrMode
                    + ",\"req_EDGE_MODE\":" + reqEdgeMode
                    + ",\"req_CONTROL_AF_MODE\":" + reqAfMode
                    + ",\"req_CONTROL_ENABLE_ZSL\":" + reqZsl
                    + ",\"req_CONTROL_AE_LOCK\":" + reqAeLock
                    + ",\"req_CONTROL_AE_EXPOSURE_COMPENSATION\":" + reqExpComp
                    + ",\"req_CONTROL_AE_TARGET_FPS_RANGE\":\"" + reqFps + "\""
                    + "}}");
            } catch (Throwable t) { /* never let logging crash capture */ }
            // #endregion

            cameraCaptureSession.capture(captureRequest, new CameraCaptureSession.CaptureCallback() {
                @Override
                public void onCaptureCompleted(@NonNull CameraCaptureSession session,
                                             @NonNull CaptureRequest request,
                                             @NonNull TotalCaptureResult result) {
                    Log.i(TAG, "Photo capture completed successfully");  // Keep as INFO level

                    // Verify ZSL was actually used by checking the request
                    Boolean zslInRequest = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
                    if (zslInRequest != null && zslInRequest) {
                        Log.d(TAG, "✓ ZSL confirmed active in capture result");
                    }

                    // MFNR diagnostic: log ISO and exposure to verify MFNR triggers
                    Integer captureIso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                    Long captureExposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                    Integer captureNrMode = result.get(CaptureResult.NOISE_REDUCTION_MODE);
                    double captureExposureMs = (captureExposureNs != null) ? captureExposureNs / 1_000_000.0 : -1;
                    boolean mfnrLikelyTriggered = (captureIso != null && captureIso > 800);
                    Log.i(TAG, "MFNR_DIAG: ISO=" + captureIso
                            + " exposure=" + String.format("%.2f", captureExposureMs) + "ms"
                            + " NR_MODE=" + captureNrMode
                            + " MFNR_likely=" + mfnrLikelyTriggered);

                    // #region agent log
                    // Remember the SENSOR_TIMESTAMP of THIS still frame so the
                    // ImageReader callback can verify it received the same frame.
                    try {
                        Long stillSensorTs = result.get(CaptureResult.SENSOR_TIMESTAMP);
                        mLastStillSensorTimestampNs = stillSensorTs;
                        android.util.Log.i("MentraDbg",
                            "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H6\",\"location\":\"CameraNeo:onCaptureCompleted:stillTs\",\"timestamp\":" + System.currentTimeMillis()
                            + ",\"message\":\"still capture sensor timestamp recorded\",\"data\":{"
                            + "\"still_SENSOR_TIMESTAMP_ns\":" + stillSensorTs
                            + ",\"exp_ms\":" + String.format(java.util.Locale.US, "%.2f", captureExposureMs)
                            + ",\"iso\":" + captureIso
                            + "}}");
                    } catch (Throwable t) { /* never let logging crash capture */ }
                    // #endregion

                    // #region agent log
                    try {
                        Long reqExp2 = request.get(CaptureRequest.SENSOR_EXPOSURE_TIME);
                        Integer reqIso2 = request.get(CaptureRequest.SENSOR_SENSITIVITY);
                        Integer reqAeMode2 = request.get(CaptureRequest.CONTROL_AE_MODE);
                        Integer reqNrMode2 = request.get(CaptureRequest.NOISE_REDUCTION_MODE);
                        Integer reqEdgeMode2 = request.get(CaptureRequest.EDGE_MODE);
                        Boolean reqZsl2 = request.get(CaptureRequest.CONTROL_ENABLE_ZSL);
                        Integer resAeMode = result.get(CaptureResult.CONTROL_AE_MODE);
                        Integer resAeState = result.get(CaptureResult.CONTROL_AE_STATE);
                        Integer resEdgeMode = result.get(CaptureResult.EDGE_MODE);
                        Long resFrameDur = result.get(CaptureResult.SENSOR_FRAME_DURATION);
                        Boolean isManualAttempt = (reqAeMode2 != null && reqAeMode2 == CaptureRequest.CONTROL_AE_MODE_OFF);
                        // Compute total light proxy (relative): exposure_ms * iso
                        double totalLightProxy = -1;
                        if (captureExposureNs != null && captureIso != null) {
                            totalLightProxy = (captureExposureNs / 1_000_000.0) * captureIso.doubleValue();
                        }
                        // Compute what XyCamera2 would have produced for same exposure
                        double xyCam2TotalLight = -1;
                        if (reqExp2 != null) {
                            xyCam2TotalLight = (reqExp2 / 1_000_000.0) * 400.0;
                        }
                        android.util.Log.i("MentraDbg",
                            "{\"sessionId\":\"d2b1f4\",\"hypothesisId\":\"H1+H2+H3+H5\",\"location\":\"CameraNeo:onCaptureCompleted\",\"timestamp\":" + System.currentTimeMillis()
                            + ",\"message\":\"actual HAL-applied values vs requested\",\"data\":{"
                            + "\"isManualAttempt\":" + isManualAttempt
                            + ",\"req_exp_ns\":" + reqExp2
                            + ",\"actual_exp_ns\":" + captureExposureNs
                            + ",\"exp_match\":" + (reqExp2 != null && captureExposureNs != null && reqExp2.equals(captureExposureNs))
                            + ",\"req_iso\":" + reqIso2
                            + ",\"actual_iso\":" + captureIso
                            + ",\"iso_match\":" + (reqIso2 != null && captureIso != null && reqIso2.equals(captureIso))
                            + ",\"req_AE_MODE\":" + reqAeMode2
                            + ",\"actual_AE_MODE\":" + resAeMode
                            + ",\"actual_AE_STATE\":" + resAeState
                            + ",\"req_NR_MODE\":" + reqNrMode2
                            + ",\"actual_NR_MODE\":" + captureNrMode
                            + ",\"req_EDGE_MODE\":" + reqEdgeMode2
                            + ",\"actual_EDGE_MODE\":" + resEdgeMode
                            + ",\"req_ZSL\":" + reqZsl2
                            + ",\"actual_FRAME_DUR_ns\":" + resFrameDur
                            + ",\"totalLightProxy_actual\":" + String.format(java.util.Locale.US, "%.1f", totalLightProxy)
                            + ",\"totalLightProxy_xyCamera2_at400ISO\":" + String.format(java.util.Locale.US, "%.1f", xyCam2TotalLight)
                            + "}}");
                    } catch (Throwable t) { /* never let logging crash capture */ }
                    // #endregion

                    // XyCamera2 pattern: Restore preview after capture (unlock AE, restore repeating request)
                    restorePreview(session);
                    
                    // Image processing will happen in ImageReader callback
                }

                @Override
                public void onCaptureFailed(@NonNull CameraCaptureSession session,
                                          @NonNull CaptureRequest request,
                                          @NonNull CaptureFailure failure) {
                    Log.e(TAG, "Photo capture failed: " + failure.getReason());
                    notifyPhotoError("Photo capture failed: " + failure.getReason());

                    // Cancel IMU recording since capture failed
                    if (mImuRecorder != null) {
                        mImuRecorder.cancel();
                    }

                    // XyCamera2 pattern: Restore preview even on failure
                    restorePreview(session);

                    shotState = AeStateMachine.ShotState.IDLE;
                    mWaitingForAeConvergence = false;
                    mAeLockRequested = false;
                    cancelKeepAliveTimer();
                    closeCamera();
                    stopSelf();
                }
            }, backgroundHandler);

        } catch (CameraAccessException e) {
            Log.e(TAG, "Error during photo capture", e);
            notifyPhotoError("Error capturing photo: " + e.getMessage());
            if (mImuRecorder != null) {
                mImuRecorder.cancel();
            }
            shotState = AeStateMachine.ShotState.IDLE;
            cancelKeepAliveTimer();
            closeCamera();
            stopSelf();
        }
    }

    // ========== HDR BURST CAPTURE ==========
    // Bracket constants live in {@link HdrBurstBuilder}.

    /** Counter for HDR burst frames received in the ImageReader. */
    private volatile int mHdrBurstFramesReceived = 0;
    /** Flag indicating we're in HDR burst mode (ImageReader should save multiple frames). */
    private volatile boolean mHdrBurstActive = false;

    /**
     * Capture 3 exposure-bracketed photos via captureBurst() for phone-side HDR merge.
     * Locks AE first, then shoots 3 frames at -2, 0, +2 EV.
     * Frames 2 and 3 skip the AE convergence delay since AE is locked.
     */
    private void captureHdrBurst() {
        try {
            shotState = AeStateMachine.ShotState.SHOOTING;
            mHdrBurstActive = true;
            mHdrBurstFramesReceived = 0;

            // Start IMU recording
            if (mImuRecorder == null) {
                mImuRecorder = new com.mentra.asg_client.sensors.ImuRecorder(this);
            }
            mImuRecorder.startRecording();

            Log.i(TAG, "HDR: Starting burst capture with brackets "
                    + java.util.Arrays.toString(HdrBurstBuilder.HDR_EV_BRACKETS));

            int displayOrientation = getDisplayRotation();
            int jpegOrientation = JpegOrientationResolver.lookupJpegOrientation(
                    displayOrientation, JpegOrientationResolver.DEFAULT_JPEG_ORIENTATION);
            int jpegQuality = getJpegQualityForSize();

            // Build the bracketed capture requests via the extracted builder helper.
            List<CaptureRequest> burstRequests = new ArrayList<>();
            for (int ev : HdrBurstBuilder.HDR_EV_BRACKETS) {
                CaptureRequest.Builder builder =
                    cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                builder.addTarget(imageReaders.getStillSurface());

                HdrBurstBuilder.configureBracket(StillCaptureBuilder.wrap(builder), ev,
                        selectedFpsRange, hasAutoFocus, jpegQuality, jpegOrientation);

                // Apply ZSL/MFNR if enabled in settings (vendor-specific, kept outside the helper).
                if (mCameraSettings != null
                        && (mCameraSettings.mAsgSettings.isZslEnabled()
                            || mCameraSettings.mAsgSettings.isMfnrEnabled())) {
                    mCameraSettings.configureCaptureBuilder(builder);
                }

                burstRequests.add(builder.build());
            }

            cameraCaptureSession.captureBurst(burstRequests, new CameraCaptureSession.CaptureCallback() {
                private int completedCount = 0;

                @Override
                public void onCaptureCompleted(@NonNull CameraCaptureSession session,
                                             @NonNull CaptureRequest request,
                                             @NonNull TotalCaptureResult result) {
                    completedCount++;
                    Integer ev = request.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION);
                    Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                    Long expNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                    Log.i(TAG, "HDR: Frame " + completedCount + "/" + HdrBurstBuilder.HDR_BURST_COUNT
                            + " completed (EV=" + ev + " ISO=" + iso
                            + " exp=" + (expNs != null ? expNs / 1_000_000.0 : "?") + "ms)");

                    if (completedCount == HdrBurstBuilder.HDR_BURST_COUNT) {
                        Log.i(TAG, "HDR: All burst frames captured");
                        restorePreview(session);
                    }
                }

                @Override
                public void onCaptureFailed(@NonNull CameraCaptureSession session,
                                          @NonNull CaptureRequest request,
                                          @NonNull CaptureFailure failure) {
                    Log.e(TAG, "HDR: Burst frame failed: " + failure.getReason());
                    mHdrBurstActive = false;
                    if (mImuRecorder != null) {
                        mImuRecorder.cancel();
                    }
                    notifyPhotoError("HDR burst capture failed");
                    restorePreview(session);
                    shotState = AeStateMachine.ShotState.IDLE;
                    closeCamera();
                    stopSelf();
                }
            }, backgroundHandler);

        } catch (CameraAccessException e) {
            Log.e(TAG, "Error during HDR burst capture", e);
            mHdrBurstActive = false;
            if (mImuRecorder != null) {
                mImuRecorder.cancel();
            }
            notifyPhotoError("HDR burst error: " + e.getMessage());
            shotState = AeStateMachine.ShotState.IDLE;
            closeCamera();
            stopSelf();
        }
    }

    /**
     * Get human-readable AF state name for logging
     */
    private String getAfStateName(int afState) {
        switch (afState) {
            case CaptureResult.CONTROL_AF_STATE_INACTIVE: return "INACTIVE";
            case CaptureResult.CONTROL_AF_STATE_PASSIVE_SCAN: return "PASSIVE_SCAN";
            case CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED: return "PASSIVE_FOCUSED";
            case CaptureResult.CONTROL_AF_STATE_PASSIVE_UNFOCUSED: return "PASSIVE_UNFOCUSED";
            case CaptureResult.CONTROL_AF_STATE_ACTIVE_SCAN: return "ACTIVE_SCAN";
            case CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED: return "FOCUSED_LOCKED";
            case CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED: return "NOT_FOCUSED_LOCKED";
            default: return "UNKNOWN(" + afState + ")";
        }
    }

    // ========== EIS (Electronic Image Stabilization) ==========
    
    /**
     * Enable or disable Electronic Image Stabilization (EIS) for camera capture.
     * This method configures hardware-level image stabilization using vendor-specific
     * capture request parameters (Pixsmart EIS feature).
     * 
     * @param builder The CaptureRequest.Builder to configure
     * @param bEnable true to enable EIS, false to disable
     */
    private void enableEIS(CaptureRequest.Builder builder, boolean bEnable) {
        Log.i(TAG, "📹 ========== enableEIS ========== Enable: " + bEnable);
        
        try {
            CaptureRequest.Key<Integer> PIXSMART_EISFEATURE_EISENABLE = null;
            
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                PIXSMART_EISFEATURE_EISENABLE = new CaptureRequest.Key<>(
                        "com.pixsmart.eisfeature.eisEnable", Integer.class);
                Log.d(TAG, "📹 EIS feature key created for API " + android.os.Build.VERSION.SDK_INT);
            } else {
                Log.w(TAG, "📹 EIS not supported on API " + android.os.Build.VERSION.SDK_INT + " (requires Q+)");
            }
            
            if (bEnable) {
                Log.d(TAG, "📹 Enabling EIS - Setting SPORTS scene mode");
                builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_SPORTS);
                if (PIXSMART_EISFEATURE_EISENABLE != null) {
                    builder.set(PIXSMART_EISFEATURE_EISENABLE, 1);
                    Log.d(TAG, "📹 EIS hardware feature enabled");
                }
            } else {
                Log.d(TAG, "📹 Disabling EIS - Setting DISABLED scene mode");
                builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_DISABLED);
                if (PIXSMART_EISFEATURE_EISENABLE != null) {
                    builder.set(PIXSMART_EISFEATURE_EISENABLE, 0);
                    Log.d(TAG, "📹 EIS hardware feature disabled");
                }
            }
            
            Log.i(TAG, "📹 EIS configured successfully: " + (bEnable ? "ENABLED" : "DISABLED"));
            
        } catch (Exception e) {
            Log.e(TAG, "💥 Error configuring EIS", e);
        }
    }

}
