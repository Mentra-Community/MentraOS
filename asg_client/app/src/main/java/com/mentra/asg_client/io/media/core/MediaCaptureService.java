package com.mentra.asg_client.io.media.core;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.upload.MediaUploadService;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.media.interfaces.ServiceCallbackInterface;
import com.mentra.asg_client.camera.CameraNeo;
import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.hardware.K900RgbLedController;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.io.storage.StorageManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Random;

import android.net.ConnectivityManager;
import android.net.NetworkInfo;

import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import com.radzivon.bartoshyk.avif.coder.HeifCoder;
import com.radzivon.bartoshyk.avif.coder.PreciseMode;

/**
 * PHOTO CAPTURE TESTING FRAMEWORK
 * 
 * Master controls for testing error scenarios in real-time
 * Set these variables to test different failure points
 */
class PhotoCaptureTestFramework {
    // ===== MASTER CONTROLS =====
    public static final boolean ENABLE_FAKE_FAILURES = false;  // Master switch
    public static final boolean ENABLE_FAKE_DELAYS = false;    // Add artificial delays
    
    // ===== FAILURE TYPES =====
    public static final String FAILURE_TYPE_CAMERA_INIT = "CAMERA_INIT_FAILED";
    public static final String FAILURE_TYPE_CAMERA_CAPTURE = "CAMERA_CAPTURE_FAILED";
    public static final String FAILURE_TYPE_BLE_TRANSFER = "BLE_TRANSFER_FAILED";
    public static final String FAILURE_TYPE_UPLOAD = "UPLOAD_FAILED";
    public static final String FAILURE_TYPE_COMPRESSION = "COMPRESSION_FAILED";
    public static final String FAILURE_TYPE_RANDOM = "RANDOM_FAILURE";
    
    // ===== CURRENT TEST CONFIGURATION =====
    public static String FAILURE_TYPE = FAILURE_TYPE_CAMERA_CAPTURE;  // Which failure to simulate
    public static final double FAILURE_PROBABILITY = 1.0;          // 0.0 to 1.0 (100% when enabled)
    public static final int FAKE_DELAY_MS = 5000;                  // Artificial delay in milliseconds
    
    // ===== STEP-SPECIFIC CONTROLS =====
    public static final boolean FAIL_CAMERA_INIT = false;          // Camera initialization
    public static final boolean FAIL_CAMERA_CAPTURE = false;        // Photo capture
    public static final boolean FAIL_IMAGE_COMPRESSION = false;    // Image compression
    public static final boolean FAIL_BLE_TRANSFER = false;         // BLE file transfer
    public static final boolean FAIL_CLOUD_UPLOAD = false;         // Cloud upload
    public static final boolean FAIL_RANDOM_STEP = false;          // Random failure
    
    private static final Random random = new Random();
    
    /**
     * Check if we should simulate a failure at this step
     */
    public static boolean shouldFail(String step) {
        if (!ENABLE_FAKE_FAILURES) return false;
        
        // Check step-specific controls first
        switch (step) {
            case "CAMERA_INIT":
                return FAIL_CAMERA_INIT || FAILURE_TYPE.equals(FAILURE_TYPE_CAMERA_INIT);
            case "CAMERA_CAPTURE":
                return FAIL_CAMERA_CAPTURE || FAILURE_TYPE.equals(FAILURE_TYPE_CAMERA_CAPTURE);
            case "COMPRESSION":
                return FAIL_IMAGE_COMPRESSION || FAILURE_TYPE.equals(FAILURE_TYPE_COMPRESSION);
            case "BLE_TRANSFER":
                return FAIL_BLE_TRANSFER || FAILURE_TYPE.equals(FAILURE_TYPE_BLE_TRANSFER);
            case "UPLOAD":
                return FAIL_CLOUD_UPLOAD || FAILURE_TYPE.equals(FAILURE_TYPE_UPLOAD);
            case "RANDOM":
                return FAIL_RANDOM_STEP || FAILURE_TYPE.equals(FAILURE_TYPE_RANDOM);
            default:
                return false;
        }
    }
    
    /**
     * Get the error code for the current failure type based on which flag is enabled
     */
    public static String getErrorCode() {
        if (FAIL_CAMERA_INIT) return FAILURE_TYPE_CAMERA_INIT;
        if (FAIL_CAMERA_CAPTURE) return FAILURE_TYPE_CAMERA_CAPTURE;
        if (FAIL_IMAGE_COMPRESSION) return FAILURE_TYPE_COMPRESSION;
        if (FAIL_BLE_TRANSFER) return FAILURE_TYPE_BLE_TRANSFER;
        if (FAIL_CLOUD_UPLOAD) return FAILURE_TYPE_UPLOAD;
        if (FAIL_RANDOM_STEP) return FAILURE_TYPE_RANDOM;
        return FAILURE_TYPE; // Fallback to manual setting
    }
    
    /**
     * Get a descriptive error message based on which flag is enabled
     */
    public static String getErrorMessage() {
        if (FAIL_CAMERA_INIT) return "TESTING: Fake camera initialization failure";
        if (FAIL_CAMERA_CAPTURE) return "TESTING: Fake photo capture failure";
        if (FAIL_IMAGE_COMPRESSION) return "TESTING: Fake compression failure";
        if (FAIL_BLE_TRANSFER) return "TESTING: Fake BLE transfer failure";
        if (FAIL_CLOUD_UPLOAD) return "TESTING: Fake upload failure";
        if (FAIL_RANDOM_STEP) return "TESTING: Random fake failure";
        
        // Fallback to manual setting
        switch (FAILURE_TYPE) {
            case FAILURE_TYPE_CAMERA_INIT:
                return "TESTING: Fake camera initialization failure";
            case FAILURE_TYPE_CAMERA_CAPTURE:
                return "TESTING: Fake photo capture failure";
            case FAILURE_TYPE_BLE_TRANSFER:
                return "TESTING: Fake BLE transfer failure";
            case FAILURE_TYPE_UPLOAD:
                return "TESTING: Fake upload failure";
            case FAILURE_TYPE_COMPRESSION:
                return "TESTING: Fake compression failure";
            case FAILURE_TYPE_RANDOM:
                return "TESTING: Random fake failure";
            default:
                return "TESTING: Unknown fake failure";
        }
    }
    
    /**
     * Add artificial delay for testing timeout scenarios
     */
    public static void addFakeDelay(String step) {
        if (ENABLE_FAKE_DELAYS) {
            Log.d("PhotoTest", "Adding " + FAKE_DELAY_MS + "ms delay at step: " + step);
            try {
                Thread.sleep(FAKE_DELAY_MS);
            } catch (InterruptedException e) {
                Log.e("PhotoTest", "Delay interrupted", e);
            }
        }
    }
    
    /**
     * Log current test configuration
     */
    public static void logTestConfig() {
        Log.d("PhotoTest", "=== PHOTO CAPTURE TEST CONFIG ===");
        Log.d("PhotoTest", "ENABLE_FAKE_FAILURES: " + ENABLE_FAKE_FAILURES);
        Log.d("PhotoTest", "ENABLE_FAKE_DELAYS: " + ENABLE_FAKE_DELAYS);
        Log.d("PhotoTest", "FAILURE_TYPE: " + FAILURE_TYPE);
        Log.d("PhotoTest", "FAIL_CAMERA_INIT: " + FAIL_CAMERA_INIT);
        Log.d("PhotoTest", "FAIL_CAMERA_CAPTURE: " + FAIL_CAMERA_CAPTURE);
        Log.d("PhotoTest", "FAIL_IMAGE_COMPRESSION: " + FAIL_IMAGE_COMPRESSION);
        Log.d("PhotoTest", "FAIL_BLE_TRANSFER: " + FAIL_BLE_TRANSFER);
        Log.d("PhotoTest", "FAIL_CLOUD_UPLOAD: " + FAIL_CLOUD_UPLOAD);
        Log.d("PhotoTest", "FAIL_RANDOM_STEP: " + FAIL_RANDOM_STEP);
        Log.d("PhotoTest", "================================");
    }
}

/**
 * Service that handles media capturing (photo and video) and uploading functionality.
 * Replaces PhotoCaptureService to support both photos and videos.
 *
 * <p><b>Thread Safety:</b> All public methods MUST be called from the main thread.
 * Methods will throw {@link IllegalStateException} if called from other threads.
 *
 * <p><b>Lifecycle:</b> Call {@link #cleanup()} before destroying the service
 * to prevent memory leaks.
 */
public class MediaCaptureService {
    private static final String TAG = "MediaCaptureService";

    // Debug flag: Enable detailed end-to-end photo capture timing logs
    // true = log timing from request to capture, false = suppress timing logs
    private static final boolean ENABLE_PHOTO_TIMING_LOGS = false;

    private final Context mContext;
    private final MediaUploadQueueManager mMediaQueueManager;
    private MediaCaptureListener mMediaCaptureListener;
    private ServiceCallbackInterface mServiceCallback;
    private CircularVideoBuffer mVideoBuffer;
    private final IHardwareManager hardwareManager;

    // Track current video recording
    private boolean isRecordingVideo = false;
    private String currentVideoId = null;
    private String currentVideoPath = null;
    private long recordingStartTime = 0;
    private boolean currentVideoLedEnabled = false; // Track if LED was enabled for current recording

    // Max recording time check
    private final Handler recordingTimeHandler = new Handler(Looper.getMainLooper());
    private Runnable recordingTimeCheckRunnable;

    // Battery monitoring for video recording
    private Handler mBatteryMonitorHandler = null;
    private Runnable mBatteryCheckRunnable = null;

    // StateManager for battery level checks (not final - can be set after construction)
    private IStateManager mStateManager;

    // Stop reason tracking to prevent duplicate feedback
    private enum StopReason {
        USER_REQUESTED,      // User/TPA explicitly stopped
        LOW_BATTERY,         // Battery dropped below threshold
        MAX_DURATION,        // Hit max recording time
        ERROR                // Error occurred
    }
    private StopReason mCurrentStopReason = null;

    // Default BLE params (used if size unspecified)
    public static final int bleImageTargetWidth = 480;
    public static final int bleImageTargetHeight = 480;
    public static final int bleImageAvifQuality = 40;

    private static class BleParams {
        final int targetWidth;
        final int targetHeight;
        final int avifQuality;
        final int jpegFallbackQuality;

        BleParams(int targetWidth, int targetHeight, int avifQuality, int jpegFallbackQuality) {
            this.targetWidth = targetWidth;
            this.targetHeight = targetHeight;
            this.avifQuality = avifQuality;
            this.jpegFallbackQuality = jpegFallbackQuality;
        }
    }

    private BleParams resolveBleParams(String requestedSize) {
        // BLE transfer is limited by BES2700 TX buffer (~88 packets before overflow)
        // With 221-byte pack size, max reliable transfer is ~19KB
        // Target file sizes accordingly with aggressive compression
        switch (requestedSize) {
            case "small":
                // Target ~8KB: 400x400 @ quality 28
                return new BleParams(400, 400, 28, 20);
            case "large":
                // Target ~25KB: 800x800 @ quality 32 (may hit BLE limit)
                return new BleParams(800, 800, 32, 28);
            case "full":
                // Target ~35KB: 1024x1024 @ quality 35 (will likely hit BLE limit)
                return new BleParams(1024, 1024, 35, 30);
            case "medium":
            default:
                // Target ~15KB: 640x640 @ quality 30 - safe for BLE
                return new BleParams(640, 640, 30, 25);
        }
    }

    // Track which photos should be saved to gallery
    private Map<String, Boolean> photoSaveFlags = new HashMap<>();

    // Track BLE IDs for auto fallback mode
    private Map<String, String> photoBleIds = new HashMap<>();

    // Track original photo paths for BLE fallback
    private Map<String, String> photoOriginalPaths = new HashMap<>();
    // Track requested photo size per request for proper fallback handling
    private Map<String, String> photoRequestedSizes = new HashMap<>();
    
    // Upload state tracking - prevent concurrent uploads
    private volatile boolean isUploadingPhoto = false;
    private final Object uploadLock = new Object();
    
    private final FileManager fileManager;

    /**
     * Interface for listening to media capture and upload events
     */
    public interface MediaCaptureListener {
        // Photo events
        void onPhotoCapturing(String requestId);

        void onPhotoCaptured(String requestId, String filePath);

        void onPhotoUploading(String requestId);

        void onPhotoUploaded(String requestId, String url);

        // Video events
        void onVideoRecordingStarted(String requestId, String filePath);

        void onVideoRecordingStopped(String requestId, String filePath);

        void onVideoUploading(String requestId);

        void onVideoUploaded(String requestId, String url);

        // Common events
        void onMediaError(String requestId, String error, int mediaType);
    }

    /**
     * Constructor
     *
     * @param context           Application context
     * @param mediaQueueManager MediaUploadQueueManager instance
     * @param fileManager       FileManager instance
     * @param stateManager      StateManager for battery level checks
     */
    public MediaCaptureService(@NonNull Context context, @NonNull MediaUploadQueueManager mediaQueueManager, FileManager fileManager, @NonNull IStateManager stateManager) {
        mContext = context.getApplicationContext();
        mMediaQueueManager = mediaQueueManager;
        this.fileManager = fileManager;
        this.mStateManager = stateManager;
        
        // Initialize hardware manager
        hardwareManager = HardwareManagerFactory.getInstance(context);
        Log.d(TAG, "Hardware manager initialized: " + hardwareManager.getDeviceModel());
        
        // Initialize video buffer
        mVideoBuffer = new CircularVideoBuffer(context);
        mVideoBuffer.setCallback(new CircularVideoBuffer.BufferCallback() {
            @Override
            public void onBufferingStarted() {
                Log.d(TAG, "Video buffering started");
            }

            @Override
            public void onBufferingStopped() {
                Log.d(TAG, "Video buffering stopped");
            }

            @Override
            public void onSegmentRecorded(int segmentIndex, String filePath) {
                Log.d(TAG, "Buffer segment " + segmentIndex + " recorded: " + filePath);
            }

            @Override
            public void onBufferSaved(String outputPath, int durationSeconds) {
                Log.d(TAG, "Buffer saved: " + outputPath + " (" + durationSeconds + " seconds)");
                // Notify listener if needed
                if (mMediaCaptureListener != null) {
                    // Use a special ID for buffer saves
                    mMediaCaptureListener.onVideoUploaded("buffer_save", outputPath);
                }
                
                // Send gallery status update to phone after buffer video save
                sendGalleryStatusUpdate();
            }

            @Override
            public void onBufferError(String error) {
                Log.e(TAG, "Buffer error: " + error);
                // Turn off LED on buffer error
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF (buffer error)");
                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onMediaError("buffer", error, MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                }
            }
        });
    }

    /**
     * Set a listener for media capture events
     */
    public void setMediaCaptureListener(MediaCaptureListener listener) {
        this.mMediaCaptureListener = listener;
    }

    /**
     * Set the service callback for communication with AsgClientService
     */
    public void setServiceCallback(ServiceCallbackInterface callback) {
        this.mServiceCallback = callback;
    }

    /**
     * Verify we're on the main thread.
     * All public methods must run on main thread for thread safety.
     */
    private void assertMainThread() {
        if (Looper.getMainLooper() != Looper.myLooper()) {
            throw new IllegalStateException(
                "MediaCaptureService methods must be called from main thread. " +
                "Current: " + Thread.currentThread().getName()
            );
        }
    }

    /**
     * Play battery low sound to alert user.
     */
    public void playBatteryLowSound() {
        if (hardwareManager != null && hardwareManager.supportsAudioPlayback()) {
            hardwareManager.playAudioAsset(AudioAssets.BATTERY_LOW);
            Log.d(TAG, "🔋 Playing battery low sound");
        } else {
            Log.w(TAG, "⚠️ Cannot play battery low sound - hardware manager not available");
        }
    }

    /**
     * Static helper for contexts without MediaCaptureService instance.
     * Used by RtmpCommandHandler and other handlers.
     */
    public static void playBatteryLowSound(Context context) {
        IHardwareManager hwManager = HardwareManagerFactory.getInstance(context);
        if (hwManager != null && hwManager.supportsAudioPlayback()) {
            hwManager.playAudioAsset(AudioAssets.BATTERY_LOW);
            Log.d("MediaCaptureService", "🔋 Playing battery low sound (static)");
        }
    }

    /**
     * Play storage full sound to alert user.
     */
    public void playStorageFullSound() {
        if (hardwareManager != null && hardwareManager.supportsAudioPlayback()) {
            hardwareManager.playAudioAsset(AudioAssets.STORAGE_FULL);
            Log.d(TAG, "💾 Playing storage full sound");
        } else {
            Log.w(TAG, "⚠️ Cannot play storage full sound - hardware manager not available");
        }
    }

    /**
     * Set or update the StateManager reference.
     * Used when StateManager is initialized after MediaCaptureService creation.
     */
    public void setStateManager(IStateManager stateManager) {
        this.mStateManager = stateManager;
        Log.d(TAG, "✅ StateManager updated for battery monitoring");
    }

    private void playShutterSound() {
        if (hardwareManager == null) {
            Log.w(TAG, "⚠️ hardwareManager is null, cannot play shutter sound");
            return;
        }

        if (!hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "⚠️ hardwareManager does not support audio playback");
            return;
        }

        hardwareManager.playAudioAsset(AudioAssets.CAMERA_SOUND);
    }
    
    /**
     * Flash privacy LED synchronized with shutter sound for photo capture
     */
    private void flashPrivacyLedForPhoto() {
        if (hardwareManager == null) {
            Log.w(TAG, "⚠️ hardwareManager is null, cannot flash privacy LED");
            return;
        }

        if (!hardwareManager.supportsRecordingLed()) {
            Log.w(TAG, "⚠️ Privacy LED not supported on this device");
            return;
        }

        Log.d(TAG, "📸 Flashing privacy LED synchronized with shutter sound at 50% brightness");
        // TODO: RESTORE LOWER LED BRIGHTNESS LATER
        // hardwareManager.setRecordingLedBrightness(50, 1000); // 50% brightness, 1000ms flash duration
        hardwareManager.flashRecordingLed(1000);
    }
    
    /**
     * Trigger white LED flash for photo capture (synchronized with shutter sound, default brightness)
     */
    private void triggerPhotoFlashLed() {
        triggerPhotoFlashLed(K900RgbLedController.DEFAULT_RGB_LED_BRIGHTNESS);
    }

    /**
     * Trigger white LED flash for photo capture with specified brightness
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    private void triggerPhotoFlashLed(int brightness) {
        Log.i(TAG, "📸 triggerPhotoFlashLed() called with brightness: " + brightness);

        if (hardwareManager != null && hardwareManager.supportsRgbLed()) {
            hardwareManager.flashRgbLedWhite(2200, brightness); // 2.2 second flash
            Log.i(TAG, "📸 Photo flash LED (white) triggered via hardware manager at brightness " + brightness);
        } else {
            Log.w(TAG, "⚠️ RGB LED not supported on this device");
        }
    }
    
    /**
     * Trigger solid white LED for video recording duration (default brightness)
     */
    private void triggerVideoRecordingLed() {
        triggerVideoRecordingLed(K900RgbLedController.DEFAULT_RGB_LED_BRIGHTNESS);
    }

    /**
     * Trigger solid white LED for video recording duration with specified brightness
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    private void triggerVideoRecordingLed(int brightness) {
        Log.i(TAG, "🎥 triggerVideoRecordingLed() called with brightness: " + brightness);

        if (hardwareManager != null && hardwareManager.supportsRgbLed()) {
            hardwareManager.setRgbLedSolidWhite(1800000, brightness); // 30 minute solid white LED
            Log.i(TAG, "🎥 Video recording LED (solid white) triggered via hardware manager at brightness " + brightness);
        } else {
            Log.w(TAG, "⚠️ RGB LED not supported on this device");
        }
    }
    
    /**
     * Stop video recording LED (turn off LED)
     */
    private void stopVideoRecordingLed() {
        Log.d(TAG, "stopVideoRecordingLed called");

        if (hardwareManager != null && hardwareManager.supportsRgbLed()) {
            hardwareManager.setRgbLedOff();
            Log.d(TAG, "🎥 Video recording LED stopped via hardware manager");
        } else {
            Log.w(TAG, "⚠️ RGB LED not supported on this device");
        }
    }

    private void playVideoStartSound() {
        if (hardwareManager != null && hardwareManager.supportsAudioPlayback()) {
            hardwareManager.playAudioAsset(AudioAssets.VIDEO_RECORDING_START);
        }
    }

    private void playVideoStopSound() {
        if (hardwareManager != null && hardwareManager.supportsAudioPlayback()) {
            hardwareManager.playAudioAsset(AudioAssets.VIDEO_RECORDING_STOP);
        }
    }
    
    /**
     * Start video recording with specific settings
     * @param settings Video settings (resolution, fps)
     * @param enableLed Whether to enable recording LED
     * @param maxRecordingTimeMinutes Maximum recording time in minutes (0 = no limit)
     * @param initialBatteryLevel Initial battery level (for monitoring during recording, -1 = unknown)
     */
    public void startVideoRecording(VideoSettings settings, boolean enableLed, int maxRecordingTimeMinutes, int initialBatteryLevel) {
        // Note: Removed assertMainThread() - this is called from Bluetooth worker thread via command handlers
        // Thread safety is maintained through CameraNeo's internal threading and Handler usage
        Log.d(TAG, "startVideoRecording called with settings: " + settings + ", enableLed: " + enableLed + ", maxRecordingTimeMinutes: " + maxRecordingTimeMinutes + ", initialBatteryLevel: " + initialBatteryLevel);

        // Check if battery is too low to start recording (query current level for accuracy)
        if (mStateManager != null) {
            int currentBatteryLevel = mStateManager.getBatteryLevel();
            if (currentBatteryLevel >= 0 && currentBatteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Battery too low to start recording: " + currentBatteryLevel + "% (minimum " + BatteryConstants.MIN_BATTERY_LEVEL + "% required)");
                playBatteryLowSound();
                return;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for video recording");
        }

        if (isRecordingVideo) {
            Log.d(TAG, "Stopping video recording");
            stopVideoRecording();
        } else {
            Log.d(TAG, "Starting video recording with settings: " + settings + ", max time: " + maxRecordingTimeMinutes + " minutes, battery: " + initialBatteryLevel + "%");
            // Generate IDs for local recording
            String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
            int randomSuffix = (int)(Math.random() * 1000);
            String requestId = "local_video_" + timeStamp + "_" + randomSuffix;
            String videoFilePath = fileManager.getDefaultMediaDirectory() + File.separator + "VID_" + timeStamp + "_" + randomSuffix + ".mp4";
            startVideoRecording(videoFilePath, requestId, settings, enableLed, maxRecordingTimeMinutes);
        }
    }

    /**
     * Handle start video recording command from phone
     * Similar to takePhotoAndUpload but for video
     * @param requestId Unique request ID for tracking
     * @param save Whether to keep the video on device after upload
     */
    public void handleStartVideoCommand(String requestId, boolean save, boolean enableLed) {
        handleStartVideoCommand(requestId, save, null, enableLed);
    }
    
    /**
     * Handle start video recording command from phone with settings
     * @param requestId Unique request ID for tracking
     * @param save Whether to keep the video on device after upload
     * @param settings Video settings (resolution, fps) or null for defaults
     */
    public void handleStartVideoCommand(String requestId, boolean save, VideoSettings settings, boolean enableLed) {
        Log.d(TAG, "handleStartVideoCommand called with requestId: " + requestId + ", save: " + save + ", settings: " + settings + ", enableLed: " + enableLed);
        
        // Check if already recording
        if (isRecordingVideo) {
            Log.w(TAG, "Already recording video, ignoring start command");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Already recording", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

                            // Generate filename with requestId
                            String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
                            int randomSuffix = (int)(Math.random() * 1000);
                            String videoFilePath = fileManager.getDefaultMediaDirectory() + File.separator + "VID_" + timeStamp + "_" + randomSuffix + "_" + requestId + ".mp4";

        // Start video recording with the provided requestId and settings (or null for defaults)
        startVideoRecording(videoFilePath, requestId, settings, enableLed);
    }

    /**
     * Handle stop video recording command from phone
     * @param requestId Request ID of the video to stop (must match current recording)
     */
    public void handleStopVideoCommand(String requestId) {
        Log.d(TAG, "handleStopVideoCommand called with requestId: " + requestId);

        if (!isRecordingVideo) {
            Log.w(TAG, "No video recording to stop");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Not recording", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Verify the requestId matches current recording
        if (!requestId.equals(currentVideoId)) {
            Log.w(TAG, "Stop command requestId doesn't match current recording");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Request ID mismatch", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        stopVideoRecording();
    }

    /**
     * Start video recording locally with auto-generated IDs
     */
    private void startVideoRecording() {
        // Generate IDs for local recording
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
        int randomSuffix = (int)(Math.random() * 1000);
        String requestId = "local_video_" + timeStamp + "_" + randomSuffix;
        String videoFilePath = fileManager.getDefaultMediaDirectory() + File.separator + "VID_" + timeStamp + "_" + randomSuffix + ".mp4";

        startVideoRecording(videoFilePath, requestId, false);
    }

    /**
     * Start video recording with specific parameters
     */
    private void startVideoRecording(String videoFilePath, String requestId, boolean enableLed) {
        startVideoRecording(videoFilePath, requestId, null, enableLed, 0);
    }

    /**
     * Start video recording with specific parameters and settings
     */
    private void startVideoRecording(String videoFilePath, String requestId, VideoSettings settings, boolean enableLed) {
        startVideoRecording(videoFilePath, requestId, settings, enableLed, 0);
    }

    /**
     * Start video recording with specific parameters, settings, and max time
     */
    private void startVideoRecording(String videoFilePath, String requestId, VideoSettings settings, boolean enableLed, int maxRecordingTimeMinutes) {
        // Check if RTMP streaming is active - videos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot start video - RTMP streaming active");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Camera busy with streaming", 
                    MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }
        
        // Check if camera is actively in use (this will return false for kept-alive idle camera)
        if (CameraNeo.isCameraInUse()) {
            Log.e(TAG, "Cannot start video - camera actively in use");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Camera busy", 
                    MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }
        
        // Check storage availability before recording
        if (!isExternalStorageAvailable()) {
            Log.e(TAG, "External storage is not available for video capture");
            return;
        }

        // Close kept-alive camera if it exists to free resources for video recording
        CameraNeo.closeKeptAliveCamera();

        // Save info for the current recording session
        currentVideoId = requestId;
        currentVideoPath = videoFilePath;
        currentVideoLedEnabled = enableLed; // Track LED state for this recording

        try {
            // Play video start sound
            playVideoStartSound();
            if (enableLed) {
                triggerVideoRecordingLed(); // Trigger solid white LED for video recording duration
            }

            // Start video recording using CameraNeo
            CameraNeo.startVideoRecording(mContext, requestId, videoFilePath, settings, new CameraNeo.VideoRecordingCallback() {
                @Override
                public void onRecordingStarted(String videoId) {
                    Log.d(TAG, "Video recording started with ID: " + videoId);
                    isRecordingVideo = true;
                    recordingStartTime = System.currentTimeMillis();

                    // Start battery monitoring on main thread (callback runs on background thread)
                    new Handler(Looper.getMainLooper()).post(() -> startBatteryMonitoring());

                    // Turn on recording flash LED if enabled with controlled brightness
                    if (enableLed && hardwareManager.supportsLedBrightness()) {
                        // TODO: RESTORE LOWER LED BRIGHTNESS LATER
                        //hardwareManager.setRecordingLedBrightness(50); // 50% brightness for video
                        hardwareManager.setRecordingLedOn();
                        Log.d(TAG, "Recording flash LED turned ON at 50% brightness");
                    } else if (enableLed && hardwareManager.supportsRecordingLed()) {
                        hardwareManager.setRecordingLedOn();
                        Log.d(TAG, "Recording flash LED turned ON (full brightness)");
                    }

                    // Notify listener
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onVideoRecordingStarted(requestId, videoFilePath);
                    }

                    // Set up max recording time check if specified
                    if (maxRecordingTimeMinutes > 0) {
                        long maxRecordingTimeMs = maxRecordingTimeMinutes * 60 * 1000L;
                        Log.d(TAG, "Setting max recording time: " + maxRecordingTimeMinutes + " minutes (" + maxRecordingTimeMs + " ms)");

                        // Create a runnable that checks if max time has been reached
                        recordingTimeCheckRunnable = new Runnable() {
                            @Override
                            public void run() {
                                if (isRecordingVideo) {
                                    long elapsedTime = System.currentTimeMillis() - recordingStartTime;
                                    if (elapsedTime >= maxRecordingTimeMs) {
                                        Log.d(TAG, "⏱️ Max recording time reached (" + maxRecordingTimeMinutes + " minutes), stopping recording");
                                        stopVideoRecording(StopReason.MAX_DURATION);  // ← USE REASON
                                    } else {
                                        // Check again in 1 second
                                        recordingTimeHandler.postDelayed(this, 1000);
                                    }
                                }
                            }
                        };

                        // Start checking after 1 second
                        recordingTimeHandler.postDelayed(recordingTimeCheckRunnable, 1000);
                    }
                }

                @Override
                public void onRecordingStopped(String videoId, String filePath) {
                    Log.d(TAG, "Video recording stopped: " + videoId + ", file: " + filePath);
                    isRecordingVideo = false;

                    // Cancel max recording time check
                    if (recordingTimeCheckRunnable != null) {
                        recordingTimeHandler.removeCallbacks(recordingTimeCheckRunnable);
                        recordingTimeCheckRunnable = null;
                    }

                    // Note: RGB white LED already turned off in stopVideoRecording() synchronized with sound

                    // Turn off recording LED if it was enabled
                    if (enableLed && hardwareManager.supportsRecordingLed()) {
                        hardwareManager.setRecordingLedOff();
                        Log.d(TAG, "Recording LED turned OFF");
                    }

                    // Notify listener
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onVideoRecordingStopped(requestId, filePath);
                    }

                    // Send gallery status update to phone after video recording
                    sendGalleryStatusUpdate();

                    // Call upload stub (which just logs for now)
                    uploadVideo(filePath, requestId);

                    // Reset state
                    currentVideoId = null;
                    currentVideoPath = null;
                }

                @Override
                public void onRecordingError(String videoId, String errorMessage) {
                    Log.e(TAG, "Video recording error: " + videoId + ", error: " + errorMessage);
                    isRecordingVideo = false;
                    
                    // Turn off RGB white LED on error (error path may not go through stopVideoRecording)
                    stopVideoRecordingLed();
                    
                    // Turn off recording LED on error if it was enabled
                    if (enableLed && hardwareManager.supportsRecordingLed()) {
                        hardwareManager.setRecordingLedOff();
                        Log.d(TAG, "Recording LED turned OFF (due to error)");
                    }

                    // Notify listener
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onMediaError(requestId, errorMessage, MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                    }

                    // Reset state
                    currentVideoId = null;
                    currentVideoPath = null;
                }

                @Override
                public void onRecordingProgress(String videoId, long durationMs) {
                    // Optional: Track recording duration if needed
                    // Not notifying the listener for this event as it would be too noisy
                    Log.v(TAG, "Video recording progress: " + videoId + ", duration: " + durationMs + "ms");
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error starting video recording", e);

            // Turn off RGB white LED if error occurred during start
            stopVideoRecordingLed();

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Error starting video: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }

            // Reset state on error
            currentVideoId = null;
            currentVideoPath = null;
        }
    }

    /**
     * Stop the current video recording
     */
    /**
     * Stop video recording with specific reason.
     * @param reason Why recording is stopping
     */
    private void stopVideoRecording(StopReason reason) {
        // Prevent recursive calls
        if (mCurrentStopReason != null) {
            Log.w(TAG, "⚠️ stopVideoRecording already in progress (reason: " +
                mCurrentStopReason + "), ignoring recursive call with reason: " + reason);
            return;
        }

        mCurrentStopReason = reason;
        Log.d(TAG, "🛑 Stopping video recording - Reason: " + reason);

        try {
            // Stop battery monitoring first
            stopBatteryMonitoring();

            if (!isRecordingVideo || currentVideoId == null) {
                Log.w(TAG, "⚠️ Not currently recording, nothing to stop");
                return;
            }

            // Handle based on reason
            switch (reason) {
                case LOW_BATTERY:
                    Log.i(TAG, "🔋 Video stopped due to low battery");
                    playBatteryLowSound();
                    // Don't play stop sound - already playing battery sound
                    break;

                case MAX_DURATION:
                    Log.i(TAG, "⏱️ Video stopped - max duration reached");
                    playVideoStopSound();
                    break;

                case USER_REQUESTED:
                    Log.i(TAG, "👤 Video stopped by user request");
                    playVideoStopSound();
                    break;

                case ERROR:
                    Log.e(TAG, "❌ Video stopped due to error");
                    // Error sound/handling already done
                    break;
            }

            stopVideoRecordingLed(); // Stop white LED when video recording stops

            // Stop the recording via CameraNeo
            CameraNeo.stopVideoRecording(mContext, currentVideoId);

        } catch (Exception e) {
            Log.e(TAG, "Error stopping video recording", e);

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(currentVideoId, "Error stopping video: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }

            // Reset state in case of error
            isRecordingVideo = false;
            currentVideoId = null;
            currentVideoPath = null;

            // Ensure LED is turned off even if stop fails (if it was enabled)
            if (currentVideoLedEnabled && hardwareManager.supportsRecordingLed()) {
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF (stop error recovery)");
            }
        } finally {
            mCurrentStopReason = null;  // Reset for next recording
        }
    }

    /**
     * Stop video recording (public API for external callers).
     * Maintains backward compatibility.
     * Note: Called from Bluetooth worker thread via command handlers - no thread assertion.
     */
    public void stopVideoRecording() {
        stopVideoRecording(StopReason.USER_REQUESTED);
    }

    /**
     * Check if currently recording video
     */
    public boolean isRecordingVideo() {
        return isRecordingVideo;
    }

    /**
     * Get the current recording duration in milliseconds
     * @return Duration in milliseconds, or 0 if not recording
     */
    public long getRecordingDurationMs() {
        if (!isRecordingVideo || recordingStartTime == 0) {
            return 0;
        }

        return System.currentTimeMillis() - recordingStartTime;
    }

    /**
     * Start buffer recording - continuously records last 30 seconds
     */
    public void startBufferRecording() {
        // Check battery level before proceeding
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Buffer recording rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onMediaError("buffer", "Battery too low to start buffer recording (" + batteryLevel + "%)", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                }
                return;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for buffer recording");
        }

        // Check if camera is already in use
        if (CameraNeo.isCameraInUse()) {
            Log.w(TAG, "Cannot start buffer recording - camera is in use");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError("buffer", "Camera is busy", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Close kept-alive camera if it exists to free resources for buffer recording
        CameraNeo.closeKeptAliveCamera();

        Log.d(TAG, "Starting buffer recording via CameraNeo");

        // Use CameraNeo's buffer mode instead of local CircularVideoBuffer
        CameraNeo.startBufferRecording(mContext, new CameraNeo.BufferCallback() {
            @Override
            public void onBufferStarted() {
                Log.d(TAG, "Buffer recording started");
                // Start blinking LED for buffer recording mode
                hardwareManager.setRecordingLedBlinking(1000, 2000); // On for 1s, off for 2s
                Log.d(TAG, "Recording LED set to BLINKING mode (buffer recording)");
            }

            @Override
            public void onBufferStopped() {
                Log.d(TAG, "Buffer recording stopped");
                // Turn off LED when buffer recording stops
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF (buffer stopped)");
            }

            @Override
            public void onBufferSaved(String filePath, int durationSeconds) {
                Log.d(TAG, "Buffer saved: " + filePath + " (" + durationSeconds + " seconds)");
                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onVideoUploaded("buffer_save", filePath);
                }
            }

            @Override
            public void onBufferError(String error) {
                Log.e(TAG, "Buffer error: " + error);
                // Turn off LED on buffer error
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF (buffer error)");
                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onMediaError("buffer", error, MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                }
            }
        });
    }

    /**
     * Stop buffer recording
     */
    public void stopBufferRecording() {
        Log.d(TAG, "Stopping buffer recording via CameraNeo");
        CameraNeo.stopBufferRecording(mContext);
        // Ensure LED is turned off when manually stopping buffer
        hardwareManager.setRecordingLedOff();
        Log.d(TAG, "Recording LED turned OFF (manual buffer stop)");
    }

    /**
     * Save the last N seconds from buffer
     * @param secondsToSave Number of seconds to save (max 30)
     * @param requestId Request ID for tracking
     */
    public void saveBufferVideo(int secondsToSave, String requestId) {
        Log.d(TAG, "Saving last " + secondsToSave + " seconds of buffer, requestId: " + requestId);
        CameraNeo.saveBufferVideo(mContext, secondsToSave, requestId);
    }

    /**
     * Get buffer recording status
     * Note: This would need to be implemented via a callback or service binding
     * For now, returning a basic status
     */
    public JSONObject getBufferStatus() {
        JSONObject status = new JSONObject();
        try {
            // Basic status - would need proper implementation with CameraNeo
            status.put("isBuffering", false); // Would need to track this
            status.put("availableDuration", 0);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating buffer status", e);
        }
        return status;
    }

    /**
     * Check if buffer is currently recording
     */
    public boolean isBuffering() {
        return CameraNeo.isInBufferMode();
    }

    /**
     * Takes a photo locally when offline or when server communication fails
     * Uses default medium size
     */
    public void takePhotoLocally() {
        takePhotoLocally("medium", false);
    }
    
    /**
     * Takes a photo locally with specified size
     * @param size Photo size ("small", "medium", or "large")
     * @param enableLed Whether to enable camera LED flash
     */
    public void takePhotoLocally(String size, boolean enableLed) {
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        if (ENABLE_PHOTO_TIMING_LOGS) {
            Log.i(TAG, "⏱️ [TIMING] LOCAL Photo request START");
        }
        
        // Check if RTMP streaming is active - photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - RTMP streaming active");
            sendPhotoErrorResponse("local", "CAMERA_BUSY", "Camera busy with RTMP streaming");
            return;
        }
        
        // Check if video recording is active - photos cannot interrupt video recording
        if (isRecordingVideo) {
            Log.e(TAG, "Cannot take photo - video recording in progress");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError("local", "Camera busy with video recording",
                    MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
            return;
        }

        // BATTERY CHECK: Reject if battery too low
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onMediaError("local",
                        "Battery level too low (" + batteryLevel + "%) - minimum " +
                        BatteryConstants.MIN_BATTERY_LEVEL + "% required",
                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                }
                return;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for local photo");
        }

        // STORAGE CHECK: Reject if insufficient storage
        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (!storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Photo rejected - insufficient storage");
            playStorageFullSound();
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError("local",
                    "Insufficient storage space for photo capture",
                    MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
            return;
        }

        // Note: No need to check CameraNeo.isCameraInUse() for photos
        // The camera's keep-alive system handles rapid photo taking gracefully

        // Add milliseconds and a random component to ensure uniqueness even in rapid capture
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
        int randomSuffix = (int)(Math.random() * 1000);

        String photoFilePath = fileManager.getDefaultMediaDirectory() + File.separator + "IMG_" + timeStamp + "_" + randomSuffix + ".jpg";

        Log.d(TAG, "Taking photo locally at: " + photoFilePath + " with size: " + size + ", LED: " + enableLed);
        
        // Log test configuration for debugging
        PhotoCaptureTestFramework.logTestConfig();
        
        // Generate a temporary requestId first
        String requestId = "local_" + timeStamp;
        
        // TESTING: Check for fake camera initialization failure
        if (PhotoCaptureTestFramework.shouldFail("CAMERA_INIT")) {
            Log.e(TAG, "TESTING: Simulating camera initialization failure");
            sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                PhotoCaptureTestFramework.getErrorMessage());
            return;
        }
        
        // TESTING: Add fake delay for camera init
        PhotoCaptureTestFramework.addFakeDelay("CAMERA_INIT");

        // RGB LED always flashes for photos (user visibility indicator)
        triggerPhotoFlashLed();

        // enableLed (from silent param) controls sound and privacy LED only
        if (enableLed) {
            playShutterSound();
            flashPrivacyLedForPhoto(); // Flash privacy LED synchronized with shutter sound
        }

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestFramework.shouldFail("CAMERA_CAPTURE")) {
            Log.e(TAG, "TESTING: Simulating camera capture failure");
            sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                PhotoCaptureTestFramework.getErrorMessage());
            return;
        }
        
        // TESTING: Add fake delay for camera capture
        PhotoCaptureTestFramework.addFakeDelay("CAMERA_CAPTURE");

        // Use the new enqueuePhotoRequest for thread-safe rapid capture
        // isFromSdk=false because this is a button-triggered photo (local storage, high quality)
        CameraNeo.enqueuePhotoRequest(
                mContext,
                photoFilePath,
                size,
                enableLed,
                false,  // isFromSdk - button photo, use high quality resolution
                new CameraNeo.PhotoCaptureCallback() {
                    @Override
                    public void onPhotoCaptured(String filePath) {
                        // Calculate end-to-end timing from request to capture
                        long totalElapsedMs = System.currentTimeMillis() - requestStartTimeMs;
                        if (ENABLE_PHOTO_TIMING_LOGS) {
                            Log.i(TAG, "⏱️ [TIMING] LOCAL Photo CAPTURED in " + totalElapsedMs + "ms");
                        }
                        
                        Log.d(TAG, "Local photo captured successfully at: " + filePath);
                        
                        // LED is now managed by CameraNeo and will turn off when camera closes
                        
                        // Notify through standard capture listener if set up
                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                            mMediaCaptureListener.onPhotoUploading(requestId);
                        }
                        
                        // Send gallery status update to phone after photo capture
                        sendGalleryStatusUpdate();
                    }

                    @Override
                    public void onPhotoError(String errorMessage) {
                        Log.e(TAG, "Failed to capture offline photo: " + errorMessage);

                        // LED is now managed by CameraNeo and will turn off when camera closes

                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onMediaError(requestId, errorMessage, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                        }
                    }
                }
        );
    }

    /**
     * Take a photo and upload it to the specified destination
     * @param photoFilePath Local path where photo will be saved
     * @param requestId Unique request ID for tracking
     * @param webhookUrl Optional webhook URL for direct upload to app
     * @param authToken Auth token for webhook authentication
     * @param save Whether to keep the photo on device after upload
     * @param size Photo size
     * @param enableLed Whether to enable camera LED flash
     * @param compress Compression level (none, medium, heavy)
     */
    public void takePhotoAndUpload(String photoFilePath, String requestId, String webhookUrl, String authToken, boolean save, String size, boolean enableLed, String compress) {
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        if (ENABLE_PHOTO_TIMING_LOGS) {
            Log.i(TAG, "⏱️ [TIMING] Photo request START - ID: " + requestId);
        }
        
        Log.d(TAG, "Taking photo and uploading to " + webhookUrl + " with compression: " + compress);

        // Check if RTMP streaming is active - photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - RTMP streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with RTMP streaming");
            return;
        }

        // Check battery level before proceeding
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(requestId, "BATTERY_LOW", "Battery too low to take photo (" + batteryLevel + "%)");
                return;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for photo upload");
        }

        // STORAGE CHECK: Reject if insufficient storage
        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (!storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Photo rejected - insufficient storage");
            playStorageFullSound();
            sendPhotoErrorResponse(requestId, "INSUFFICIENT_STORAGE", "Insufficient storage space for photo capture");
            return;
        }

        // Check if already uploading - skip request if busy
        synchronized (uploadLock) {
            if (isUploadingPhoto) {
                Log.w(TAG, "🚫 Upload busy - skipping photo request: " + requestId);

                // Send error response to phone using existing photo error function
                sendPhotoErrorResponse(requestId, "UPLOAD_SYSTEM_BUSY", "Upload system busy - request skipped");

                // Also notify local listener
                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onMediaError(requestId, "Upload system busy - request skipped", MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                }
                return;
            }
        }
        
        // Store the save flag for this request
        photoSaveFlags.put(requestId, save);
        // Track requested size for potential fallbacks
        photoRequestedSizes.put(requestId, size);

        Log.d(TAG, "Taking photo and uploading to " + webhookUrl);

        // Proceed directly with upload attempt (internet test removed due to unreliability)
        Log.d(TAG, "Proceeding with photo upload for " + requestId);

        // Notify that we're about to take a photo
        if (mMediaCaptureListener != null) {
            mMediaCaptureListener.onPhotoCapturing(requestId);
        }

        // LED control is now handled by CameraNeo tied to camera lifecycle

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestFramework.shouldFail("CAMERA_CAPTURE")) {
            Log.e(TAG, "TESTING: Simulating camera capture failure");
            sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                PhotoCaptureTestFramework.getErrorMessage());
            return;
        } else {
            Log.d(TAG, "Camera capture failure not simulated");
        }
        
        // TESTING: Add fake delay for camera capture
        PhotoCaptureTestFramework.addFakeDelay("CAMERA_CAPTURE");

        try {
            // RGB LED always flashes for photos (user visibility indicator)
            triggerPhotoFlashLed();

            // enableLed (from silent param) controls sound and privacy LED only
            if (enableLed) {
                playShutterSound();
                flashPrivacyLedForPhoto(); // Flash privacy LED synchronized with shutter sound
            }

            // Use the new enqueuePhotoRequest for thread-safe rapid capture
            // isFromSdk=true because this is an SDK-requested photo (take_photo command)
            CameraNeo.enqueuePhotoRequest(
                    mContext,
                    photoFilePath,
                    size,
                    enableLed,
                    true,  // isFromSdk - use optimized resolution for fast transfer
                    new CameraNeo.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoCaptured(String filePath) {
                            // Calculate end-to-end timing from request to capture
                            long totalElapsedMs = System.currentTimeMillis() - requestStartTimeMs;
                            if (ENABLE_PHOTO_TIMING_LOGS) {
                                Log.i(TAG, "⏱️ [TIMING] Photo CAPTURED in " + totalElapsedMs + "ms - ID: " + requestId);
                            }
                            
                            Log.d(TAG, "Photo captured successfully at: " + filePath);

                            // LED is now managed by CameraNeo and will turn off when camera closes

                            // Notify that we've captured the photo
                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                                mMediaCaptureListener.onPhotoUploading(requestId);
                            }

                            // Choose upload destination based on webhookUrl
                            if (webhookUrl != null && !webhookUrl.isEmpty()) {
                                // Upload directly to app webhook
                                uploadPhotoToWebhook(filePath, requestId, webhookUrl, authToken, compress);
                            }
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            Log.e(TAG, "Failed to capture photo: " + errorMessage);
                            
                            // LED is now managed by CameraNeo and will turn off when camera closes
                            
                            sendMediaErrorResponse(requestId, errorMessage, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(requestId, errorMessage, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    }
            );
        } catch (Exception e) {
            Log.e(TAG, "Error taking photo", e);
            sendMediaErrorResponse(requestId, "Error taking photo: " + e.getMessage(), MediaUploadQueueManager.MEDIA_TYPE_PHOTO);

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Error taking photo: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
        }
    }

    /**
     * Check if currently uploading a photo
     * @return true if upload is in progress, false otherwise
     */
    public boolean isUploadingPhoto() {
        synchronized (uploadLock) {
            return isUploadingPhoto;
        }
    }

    /**
     * Upload photo directly to app webhook
     */
    private void uploadPhotoToWebhook(String photoFilePath, String requestId, String webhookUrl, String authToken, String compress) {
        // TESTING: Check for fake upload failure
        if (PhotoCaptureTestFramework.shouldFail("UPLOAD")) {
            Log.e(TAG, "TESTING: Simulating upload failure");
            sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                PhotoCaptureTestFramework.getErrorMessage());
            return;
        }
        
        // TESTING: Add fake delay for upload
        PhotoCaptureTestFramework.addFakeDelay("UPLOAD");

        // Set upload state to busy
        synchronized (uploadLock) {
            isUploadingPhoto = true;
            Log.d(TAG, "📤 Starting upload - system marked as busy: " + requestId);
        }

        // Process upload based on SDK compression setting
        processUploadWithCompression(photoFilePath, requestId, webhookUrl, authToken, compress);
    }

    /**
     * Process upload with compression based on SDK setting
     */
    private void processUploadWithCompression(String photoFilePath, String requestId, String webhookUrl, String authToken, String compress) {
        Log.d(TAG, "📸 Processing photo upload with SDK compression setting: " + compress);
        
        // Check SDK compression setting
        if ("none".equals(compress) || compress == null || compress.isEmpty()) {
            Log.d(TAG, "📸 No compression requested - uploading original image");
            performDirectUpload(photoFilePath, requestId, webhookUrl, authToken);
        } else {
            Log.d(TAG, "🗜️ Compression requested - applying SDK compression setting: " + compress);
            
            compressImageForUpload(photoFilePath, requestId, webhookUrl, authToken, compress);
        }
    }

    /**
     * Compress image based on SDK compression level
     */
    private void compressImageForUpload(String originalPath, String requestId, String webhookUrl, String authToken, String compress) {
        new Thread(() -> {
            try {
                Log.d(TAG, "🗜️ Starting image compression for " + compress + " level");
                long compressionStartTime = System.currentTimeMillis();
                
                // Load original image
                android.graphics.Bitmap original = android.graphics.BitmapFactory.decodeFile(originalPath);
                if (original == null) {
                    Log.e(TAG, "❌ Failed to load original image for compression");
                    performDirectUpload(originalPath, requestId, webhookUrl, authToken);
                    return;
                }
                
                // Calculate compression parameters based on SDK compression level
                int originalWidth = original.getWidth();
                int originalHeight = original.getHeight();
                Log.d(TAG, "📐 Original image dimensions: " + originalWidth + "x" + originalHeight);
                
                // Compression parameters based on SDK compression level
                float compressionRatio;
                int jpegQuality;
                String compressionStrategy;
                
                if ("heavy".equals(compress)) {
                    compressionRatio = 0.50f; // 50% of original size
                    jpegQuality = 60;
                    compressionStrategy = "50% size + 60% quality (HEAVY)";
                } else { // "medium"
                    compressionRatio = 0.75f; // 75% of original size
                    jpegQuality = 80;
                    compressionStrategy = "75% size + 80% quality (MEDIUM)";
                }
                
                Log.d(TAG, "🎯 Compression strategy: " + compressionStrategy);
                
                // Calculate compressed dimensions
                int compressedWidth = (int)(originalWidth * compressionRatio);
                int compressedHeight = (int)(originalHeight * compressionRatio);
                
                // Maintain aspect ratio
                float aspectRatio = (float) originalWidth / originalHeight;
                if (aspectRatio > 1) {
                    compressedHeight = (int) (compressedWidth / aspectRatio);
                } else {
                    compressedWidth = (int) (compressedHeight * aspectRatio);
                }
                
                Log.d(TAG, "📐 Compressed image dimensions: " + compressedWidth + "x" + compressedHeight);
                
                // Create compressed bitmap
                android.graphics.Bitmap compressed = android.graphics.Bitmap.createScaledBitmap(
                    original, compressedWidth, compressedHeight, true);
                original.recycle();
                
                // Save compressed image to temporary file
                String compressedPath = originalPath.replace(".jpg", "_compressed_" + compress + ".jpg");
                java.io.FileOutputStream fos = new java.io.FileOutputStream(compressedPath);
                compressed.compress(android.graphics.Bitmap.CompressFormat.JPEG, jpegQuality, fos);
                fos.close();
                compressed.recycle();
                
                long compressionDuration = System.currentTimeMillis() - compressionStartTime;
                Log.d(TAG, "⏱️ Image compression completed in: " + compressionDuration + "ms");
                Log.d(TAG, "✅ Compressed image saved: " + compressedPath);
                
                // Calculate compression ratio achieved
                File originalFile = new File(originalPath);
                File compressedFile = new File(compressedPath);
                long originalSize = originalFile.length();
                long compressedSize = compressedFile.length();
                float sizeReduction = ((float)(originalSize - compressedSize) / originalSize) * 100;
                
                Log.d(TAG, "📊 Compression stats:");
                Log.d(TAG, "📊 Original size: " + originalSize + " bytes");
                Log.d(TAG, "📊 Compressed size: " + compressedSize + " bytes");
                Log.d(TAG, "📊 Size reduction: " + String.format("%.1f", sizeReduction) + "%");
                
                // Upload compressed version
                performDirectUpload(compressedPath, requestId, webhookUrl, authToken);
                
                // Clean up compressed file after upload
                new File(compressedPath).deleteOnExit();
                
            } catch (Exception e) {
                Log.e(TAG, "❌ Error compressing image, falling back to original: " + e.getMessage());
                performDirectUpload(originalPath, requestId, webhookUrl, authToken);
            }
        }).start();
    }

    /**
     * Compress image for poor connection scenarios (legacy method - kept for compatibility)
     */
    private void compressImageForPoorConnection(String originalPath, String requestId, String webhookUrl, String authToken) {
        new Thread(() -> {
            try {
                Log.d(TAG, "🗜️ Compressing image for poor connection: " + originalPath);
                long compressionStartTime = System.currentTimeMillis();
                
                // Load original image
                android.graphics.Bitmap original = android.graphics.BitmapFactory.decodeFile(originalPath);
                if (original == null) {
                    Log.e(TAG, "❌ Failed to load original image for compression");
                    performDirectUpload(originalPath, requestId, webhookUrl, authToken);
                    return;
                }
                
                // Calculate compression parameters for poor connection
                int originalWidth = original.getWidth();
                int originalHeight = original.getHeight();
                Log.d(TAG, "📐 Original image dimensions: " + originalWidth + "x" + originalHeight);
                
                // Reduce to 50% of original size for poor connections
                int compressedWidth = originalWidth / 2;
                int compressedHeight = originalHeight / 2;
                
                // Maintain aspect ratio
                float aspectRatio = (float) originalWidth / originalHeight;
                if (aspectRatio > 1) {
                    compressedHeight = (int) (compressedWidth / aspectRatio);
                } else {
                    compressedWidth = (int) (compressedHeight * aspectRatio);
                }
                
                Log.d(TAG, "📐 Compressed image dimensions: " + compressedWidth + "x" + compressedHeight);
                
                // Create compressed bitmap
                android.graphics.Bitmap compressed = android.graphics.Bitmap.createScaledBitmap(
                    original, compressedWidth, compressedHeight, true);
                original.recycle();
                
                // Save compressed image to temporary file
                String compressedPath = originalPath.replace(".jpg", "_compressed.jpg");
                java.io.FileOutputStream fos = new java.io.FileOutputStream(compressedPath);
                compressed.compress(android.graphics.Bitmap.CompressFormat.JPEG, 60, fos); // 60% quality
                fos.close();
                compressed.recycle();
                
                long compressionDuration = System.currentTimeMillis() - compressionStartTime;
                Log.d(TAG, "⏱️ Image compression completed in: " + compressionDuration + "ms");
                Log.d(TAG, "✅ Image compressed for poor connection: " + compressedPath);
                
                // Upload compressed version
                performDirectUpload(compressedPath, requestId, webhookUrl, authToken);
                
                // Clean up compressed file after upload
                new File(compressedPath).deleteOnExit();
                
            } catch (Exception e) {
                Log.e(TAG, "❌ Error compressing image, falling back to original: " + e.getMessage());
                performDirectUpload(originalPath, requestId, webhookUrl, authToken);
            }
        }).start();
    }

    /**
     * Perform the actual upload operation
     */
    private void performDirectUpload(String photoFilePath, String requestId, String webhookUrl, String authToken) {
        Log.d(TAG, "📤 Starting direct upload operation");
        Log.d(TAG, "📸 Upload file: " + photoFilePath);
        Log.d(TAG, "🆔 Request ID: " + requestId);
        
        // Create a new thread for the upload
        new Thread(() -> {
            try {
                File photoFile = new File(photoFilePath);
                if (!photoFile.exists()) {
                    Log.e(TAG, "❌ Photo file does not exist: " + photoFilePath);
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onMediaError(requestId, "Photo file not found", MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                    }
                    return;
                }

                Log.d(TAG, "📊 Photo file size: " + photoFile.length() + " bytes");
                Log.d(TAG, "🌐 Sending photo request to: " + webhookUrl);

                // Create multipart form request with smarter timeouts:
                // - 1 second to connect (fails fast if no internet)
                // - 10 seconds to write the photo data
                // - 5 seconds to read the response
                OkHttpClient client = new OkHttpClient.Builder()
                        .connectTimeout(1, java.util.concurrent.TimeUnit.SECONDS)  // Fast fail if no internet
                        .writeTimeout(10, java.util.concurrent.TimeUnit.SECONDS)   // Time to upload photo data
                        .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)     // Time to get response
                        .build();

                RequestBody fileBody = RequestBody.create(okhttp3.MediaType.parse("image/jpeg"), photoFile);
                RequestBody requestBody = new MultipartBody.Builder()
                        .setType(MultipartBody.FORM)
                        .addFormDataPart("photo", photoFile.getName(), fileBody)
                        .addFormDataPart("requestId", requestId)
                        .addFormDataPart("type", "photo_upload")
                        .addFormDataPart("success", "true")
                        .build();

                // Build request with optional Authorization header
                Request.Builder requestBuilder = new Request.Builder()
                        .url(webhookUrl)
                        .post(requestBody);

                // Add Authorization header if auth token is available
                if (authToken != null && !authToken.isEmpty()) {
                    requestBuilder.header("Authorization", "Bearer " + authToken);
                    Log.d(TAG, "🔐 Adding Authorization header to webhook request");
                } else {
                    Log.d(TAG, "⚠️ No auth token available for webhook request");
                }

                Request request = requestBuilder.build();
                Log.d(TAG, "🚀 Executing HTTP request...");
                
                long uploadStartTime = System.currentTimeMillis();
                Response response = client.newCall(request).execute();
                long uploadTime = System.currentTimeMillis() - uploadStartTime;
                
                Log.d(TAG, "⏱️ Upload completed in: " + uploadTime + "ms");
                Log.d(TAG, "📈 Response code: " + response.code());

                if (response.isSuccessful()) {
                    String responseBody = response.body() != null ? response.body().string() : "";
                    Log.d(TAG, "✅ Photo uploaded successfully to webhook");
                    Log.d(TAG, "📄 Response body: " + responseBody);

                    // Check if we should save the photo
                    Boolean save = photoSaveFlags.get(requestId);
                    if (save == null || !save) {
                        // Delete the photo file to save storage
                        try {
                            if (photoFile.delete()) {
                                Log.d(TAG, "🗑️ Deleted photo file after successful upload");
                            } else {
                                Log.w(TAG, "⚠️ Failed to delete photo file");
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "❌ Error deleting photo file after upload", e);
                        }
                    } else {
                        Log.d(TAG, "💾 Keeping photo file as requested");
                    }

                    // Clean up the flag
                    photoSaveFlags.remove(requestId);
                    photoRequestedSizes.remove(requestId);

                    // Notify success
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onPhotoUploaded(requestId, webhookUrl);
                    }
                    
                    // Reset upload state
                    synchronized (uploadLock) {
                        isUploadingPhoto = false;
                        Log.d(TAG, "✅ Upload completed - system marked as available");
                    }
                } else {
                    String errorMessage = "Upload failed with status: " + response.code();
                    Log.e(TAG, "❌ " + errorMessage + " to webhook: " + webhookUrl);

                    // Check if we can fallback to BLE
                    String bleImgId = photoBleIds.get(requestId);
                    if (bleImgId != null) {
                        Log.d(TAG, "📱 Webhook upload failed, attempting BLE fallback");
                        Log.d(TAG, "🔄 BLE Image ID: " + bleImgId);

                        // Clean up tracking (will be re-added by BLE transfer)
                        photoBleIds.remove(requestId);
                        photoOriginalPaths.remove(requestId);

                        // Trigger BLE fallback - reuse the existing photo instead of taking a new one
                        boolean shouldSave = Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                        String requestedSize = photoRequestedSizes.get(requestId);
                        if (requestedSize == null || requestedSize.isEmpty()) requestedSize = "medium";
                        // Reuse the existing photo file that was already captured
                        Log.d(TAG, "♻️ Reusing existing photo for BLE transfer");
                        
                        // Reset upload state before BLE fallback
                        synchronized (uploadLock) {
                            isUploadingPhoto = false;
                            Log.d(TAG, "🔄 Upload failed, switching to BLE - system marked as available");
                        }
                        
                        reusePhotoForBleTransfer(photoFilePath, requestId, bleImgId, shouldSave, requestedSize);
                        return; // Exit early - BLE transfer will handle cleanup
                    }

                    // No BLE fallback available
                    Log.d(TAG, "❌ No BLE fallback available, handling as normal failure");
                    
                    // Check if we should save the photo
                    Boolean save = photoSaveFlags.get(requestId);
                    if (save == null || !save) {
                        // Delete the photo file on failure
                        try {
                            if (photoFile.delete()) {
                                Log.d(TAG, "🗑️ Deleted photo file after failed upload");
                            } else {
                                Log.w(TAG, "⚠️ Failed to delete photo file");
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "❌ Error deleting photo file after failed upload", e);
                        }
                    } else {
                        Log.d(TAG, "💾 Keeping photo file despite failed upload as requested");
                    }

                    // Clean up tracking
                    photoSaveFlags.remove(requestId);
                    photoBleIds.remove(requestId);
                    photoOriginalPaths.remove(requestId);
                    photoRequestedSizes.remove(requestId);

                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onMediaError(requestId, errorMessage, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                    }
                    
                    // Reset upload state
                    synchronized (uploadLock) {
                        isUploadingPhoto = false;
                        Log.d(TAG, "❌ Upload failed - system marked as available");
                    }
                }

                response.close();

            } catch (Exception e) {
                Log.e(TAG, "❌ Error uploading photo to webhook: " + e.getMessage());
                Log.e(TAG, "❌ Exception type: " + e.getClass().getSimpleName());

                // Check if we can fallback to BLE on exception
                String bleImgId = photoBleIds.get(requestId);
                if (bleImgId != null) {
                    Log.d(TAG, "📱 Webhook upload exception, attempting BLE fallback");
                    Log.d(TAG, "🔄 BLE Image ID: " + bleImgId);

                    // Clean up tracking (will be re-added by BLE transfer)
                    photoBleIds.remove(requestId);
                    photoOriginalPaths.remove(requestId);

                    // Trigger BLE fallback - reuse the existing photo instead of taking a new one
                    boolean shouldSaveFallback1 = Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                    String requestedSizeFallback1 = photoRequestedSizes.get(requestId);
                    if (requestedSizeFallback1 == null || requestedSizeFallback1.isEmpty()) requestedSizeFallback1 = "medium";
                    // Reuse the existing photo file that was already captured
                    Log.d(TAG, "♻️ Reusing existing photo for BLE transfer");
                    
                    // Reset upload state before BLE fallback
                    synchronized (uploadLock) {
                        isUploadingPhoto = false;
                        Log.d(TAG, "🔄 Upload exception, switching to BLE - system marked as available");
                    }
                    
                    reusePhotoForBleTransfer(photoFilePath, requestId, bleImgId, shouldSaveFallback1, requestedSizeFallback1);
                    return; // Exit early - BLE transfer will handle cleanup
                }

                // No BLE fallback available
                Log.d(TAG, "❌ No BLE fallback available, handling exception");
                
                // Check if we should save the photo on exception
                Boolean save = photoSaveFlags.get(requestId);
                if (save == null || !save) {
                    // Delete the photo file on exception
                    try {
                        File photoFile = new File(photoFilePath);
                        if (photoFile.exists() && photoFile.delete()) {
                            Log.d(TAG, "🗑️ Deleted photo file after webhook upload exception");
                        } else {
                            Log.w(TAG, "⚠️ Failed to delete photo file");
                        }
                    } catch (Exception deleteEx) {
                            Log.e(TAG, "❌ Error deleting photo file after webhook upload exception", deleteEx);
                    }
                } else {
                    Log.d(TAG, "💾 Keeping photo file despite upload exception as requested");
                }

                // Clean up tracking
                photoSaveFlags.remove(requestId);
                photoBleIds.remove(requestId);
                photoOriginalPaths.remove(requestId);
                photoRequestedSizes.remove(requestId);
                

                if (mMediaCaptureListener != null) {
                    mMediaCaptureListener.onMediaError(requestId, "Upload error: " + e.getMessage(), MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                }
                
                // Reset upload state
                synchronized (uploadLock) {
                    isUploadingPhoto = false;
                    Log.d(TAG, "💥 Upload exception - system marked as available");
                }
            }
        }).start();
    }


    /**
     * Upload a video file to AugmentOS Cloud
     * Currently a stub - videos are kept on device
     */
    public void uploadVideo(String videoFilePath, String requestId) {
        Log.d(TAG, "Video upload not implemented yet. Video saved locally: " + videoFilePath);
        // TODO: Implement WiFi upload when needed
        // For now, videos remain on device

        if (mMediaCaptureListener != null) {
            // Notify that video is "uploaded" (actually just saved locally)
            mMediaCaptureListener.onVideoUploaded(requestId, videoFilePath);
        }
    }

    /**
     * Upload media to AugmentOS Cloud
     */
    private void uploadMediaToCloud(String mediaFilePath, String requestId, int mediaType) {
        // First save the media to device gallery
        saveMediaToGallery(mediaFilePath, mediaType);

        // Upload the media to AugmentOS Cloud
        MediaUploadService.uploadMedia(
                mContext,
                mediaFilePath,
                requestId,
                mediaType,
                new MediaUploadService.UploadCallback() {
                    @Override
                    public void onSuccess(String url) {
                        String mediaTypeStr = mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO ? "Photo" : "Video";
                        Log.d(TAG, mediaTypeStr + " uploaded successfully: " + url);
                        sendMediaSuccessResponse(requestId, url, mediaType);

                        // Check if we should save the photo
                        Boolean save = photoSaveFlags.get(requestId);
                        if (save == null || !save) {
                            // Delete the original file to save storage
                            try {
                                File file = new File(mediaFilePath);
                                if (file.exists() && file.delete()) {
                                    Log.d(TAG, "🗑️ Deleted " + mediaTypeStr.toLowerCase() + " file after successful upload: " + mediaFilePath);
                                } else {
                                    Log.w(TAG, "Failed to delete " + mediaTypeStr.toLowerCase() + " file: " + mediaFilePath);
                                }
                            } catch (Exception e) {
                                Log.e(TAG, "Error deleting " + mediaTypeStr.toLowerCase() + " file after upload", e);
                            }
                        } else {
                            Log.d(TAG, "💾 Keeping " + mediaTypeStr.toLowerCase() + " file as requested: " + mediaFilePath);
                        }

                        // Clean up all tracking
                        photoSaveFlags.remove(requestId);
                        photoBleIds.remove(requestId);
                        photoOriginalPaths.remove(requestId);
    

                        // Notify listener about successful upload
                        if (mMediaCaptureListener != null) {
                            if (mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO) {
                                mMediaCaptureListener.onPhotoUploaded(requestId, url);
                            } else {
                                mMediaCaptureListener.onVideoUploaded(requestId, url);
                            }
                        }
                    }

                    @Override
                    public void onFailure(String errorMessage) {
                        String mediaTypeStr = mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO ? "Photo" : "Video";
                        Log.e(TAG, mediaTypeStr + " upload failed: " + errorMessage);
                        sendMediaErrorResponse(requestId, errorMessage, mediaType);

                        // Check if we can fallback to BLE for photos
                        String bleImgId = photoBleIds.get(requestId);
                        if (mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO && bleImgId != null) {
                            Log.d(TAG, "📱 WiFi upload failed, attempting BLE fallback for " + requestId);

                            // Don't delete the photo yet - we need it for BLE
                            // Clean up tracking (will be re-added by BLE transfer)
                            photoBleIds.remove(requestId);
                            photoOriginalPaths.remove(requestId);

                            // Trigger BLE fallback - reuse the existing photo instead of taking a new one
                            boolean shouldSaveFallback2 = Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                            String requestedSizeFallback2 = photoRequestedSizes.get(requestId);
                            if (requestedSizeFallback2 == null || requestedSizeFallback2.isEmpty()) requestedSizeFallback2 = "medium";
                            // Reuse the existing photo file that was already captured
                            Log.d(TAG, "♻️ Reusing existing photo for BLE transfer: " + mediaFilePath);
                            reusePhotoForBleTransfer(mediaFilePath, requestId, bleImgId, shouldSaveFallback2, requestedSizeFallback2);
                            return; // Exit early - BLE transfer will handle cleanup
                        }

                        // No BLE fallback available, handle as normal failure
                        // Check if we should save the photo
                        Boolean save = photoSaveFlags.get(requestId);
                        if (save == null || !save) {
                            // Delete the file even on failure to prevent storage buildup
                            try {
                                File file = new File(mediaFilePath);
                                if (file.exists() && file.delete()) {
                                    Log.d(TAG, "🗑️ Deleted " + mediaTypeStr.toLowerCase() + " file after failed upload: " + mediaFilePath);
                                } else {
                                    Log.w(TAG, "Failed to delete " + mediaTypeStr.toLowerCase() + " file: " + mediaFilePath);
                                }
                            } catch (Exception e) {
                                Log.e(TAG, "Error deleting " + mediaTypeStr.toLowerCase() + " file after failed upload", e);
                            }
                        } else {
                            Log.d(TAG, "💾 Keeping " + mediaTypeStr.toLowerCase() + " file despite failed upload as requested: " + mediaFilePath);
                        }

                        // Clean up tracking
                        photoSaveFlags.remove(requestId);
                        photoBleIds.remove(requestId);
                        photoOriginalPaths.remove(requestId);
    

                        // Notify listener about error
                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onMediaError(requestId, "Upload failed: " + errorMessage, mediaType);
                        }
                    }
                }
        );
    }

    /**
     * Save media to local app directory
     */
    private void saveMediaToGallery(String mediaFilePath, int mediaType) {
        try {
            // Create a File object from the path
            File mediaFile = new File(mediaFilePath);
            if (!mediaFile.exists()) {
                Log.e(TAG, "Media file does not exist: " + mediaFilePath);
                return;
            }

            // Get this class's directory
            String classDirectory = fileManager.getDefaultMediaDirectory() + File.separator + "MediaCaptureService";
            File directory = new File(classDirectory);
            if (!directory.exists()) {
                directory.mkdirs();
            }

            // Create destination file in the same directory as this class
            String fileName = mediaFile.getName();
            File destinationFile = new File(directory, fileName);

            // Copy the file
            try (FileInputStream in = new FileInputStream(mediaFile);
                 java.io.FileOutputStream out = new FileOutputStream(destinationFile)) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) > 0) {
                    out.write(buf, 0, len);
                }
            }

            Log.d(TAG, "Media saved locally: " + destinationFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Error saving media locally", e);
        }
    }

    /**
     * Send a success response for a media request
     * This should be overridden by the service that uses this class
     */
    protected void sendMediaSuccessResponse(String requestId, String mediaUrl, int mediaType) {
        // Default implementation is empty
        // This should be overridden by the service that uses this class
    }

    /**
     * Send an error response for a media request
     * This should be overridden by the service that uses this class
     */
    protected void sendMediaErrorResponse(String requestId, String errorMessage, int mediaType) {
        // Default implementation is empty
        // This should be overridden by the service that uses this class
    }

    /**
     * Check if external storage is available for read/write
     */
    private boolean isExternalStorageAvailable() {
        String state = android.os.Environment.getExternalStorageState();
        return android.os.Environment.MEDIA_MOUNTED.equals(state);
    }

    /**
     * Check if WiFi is connected
     */
    private boolean isWiFiConnected() {
        try {
            ConnectivityManager cm = (ConnectivityManager) mContext.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo wifiInfo = cm.getNetworkInfo(ConnectivityManager.TYPE_WIFI);
            return wifiInfo != null && wifiInfo.isConnected();
        } catch (Exception e) {
            Log.e(TAG, "Error checking WiFi connectivity", e);
            return false;
        }
    }



    /**
     * Take a photo with auto transfer (WiFi with BLE fallback)
     * @param photoFilePath Path to save the original photo
     * @param requestId Request ID for tracking
     * @param webhookUrl Webhook URL for upload
     * @param bleImgId BLE image ID for fallback
     * @param save Whether to keep the photo on device
     * @param compress Compression level (none, medium, heavy)
     */
    public void takePhotoAutoTransfer(String photoFilePath, String requestId, String webhookUrl, String authToken, String bleImgId, boolean save, String size, boolean enableLed, String compress) {
        // Check battery level before proceeding (defense-in-depth)
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(requestId, "BATTERY_LOW", "Battery too low to take photo (" + batteryLevel + "%)");
                return;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for auto transfer");
        }

        // Store the save flag and BLE ID for this request
        photoSaveFlags.put(requestId, save);
        photoBleIds.put(requestId, bleImgId);
        photoOriginalPaths.put(requestId, photoFilePath);
        photoRequestedSizes.put(requestId, size);

        // Attempt direct upload (internet test removed due to unreliability)
        Log.d(TAG, "Attempting direct upload for " + requestId);
            takePhotoAndUpload(photoFilePath, requestId, webhookUrl, authToken, save, size, enableLed, compress);
        
        // Note: BLE fallback will be handled automatically by upload failure detection
        Log.d(TAG, "BLE fallback will be used if upload fails");
    }

    /**
     * Take a photo for BLE transfer with compression
     * @param photoFilePath Path to save the original photo
     * @param requestId Request ID for tracking
     * @param bleImgId BLE image ID to use as filename
     * @param save Whether to keep the original photo on device
     */
    public void takePhotoForBleTransfer(String photoFilePath, String requestId, String bleImgId, boolean save, String size, boolean enableLed) {
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        if (ENABLE_PHOTO_TIMING_LOGS) {
            Log.i(TAG, "⏱️ [TIMING] BLE Photo request START - ID: " + requestId);
        }
        
        // Check if RTMP streaming is active - photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - RTMP streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with RTMP streaming");
            return;
        }

        // Check battery level before proceeding
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(requestId, "BATTERY_LOW", "Battery too low to take photo (" + batteryLevel + "%)");
                return;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for BLE transfer");
        }

        // STORAGE CHECK: Reject if insufficient storage
        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (!storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Photo rejected - insufficient storage");
            playStorageFullSound();
            sendPhotoErrorResponse(requestId, "INSUFFICIENT_STORAGE", "Insufficient storage space for photo capture");
            return;
        }

        // Store the save flag for this request
        photoSaveFlags.put(requestId, save);
        // Track requested size for BLE compression
        photoRequestedSizes.put(requestId, size);
        // Notify that we're about to take a photo
        if (mMediaCaptureListener != null) {
            mMediaCaptureListener.onPhotoCapturing(requestId);
        }

        // LED control is now handled by CameraNeo tied to camera lifecycle

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestFramework.shouldFail("CAMERA_CAPTURE")) {
            Log.e(TAG, "TESTING: Simulating camera capture failure for BLE transfer - " + 
                PhotoCaptureTestFramework.getErrorCode() + ": " + PhotoCaptureTestFramework.getErrorMessage());
            sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                PhotoCaptureTestFramework.getErrorMessage());
            return;
        }
        
        // TESTING: Add fake delay for camera capture
        PhotoCaptureTestFramework.addFakeDelay("CAMERA_CAPTURE");

        // RGB LED always flashes for photos (user visibility indicator)
        triggerPhotoFlashLed();

        // enableLed (from silent param) controls sound and privacy LED only
        if (enableLed) {
            playShutterSound();
            flashPrivacyLedForPhoto(); // Flash privacy LED synchronized with shutter sound
        }

        try {
            // Use CameraNeo for photo capture
            CameraNeo.takePictureWithCallback(
                    mContext,
                    photoFilePath,
                    new CameraNeo.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoCaptured(String filePath) {
                            // Calculate end-to-end timing from request to capture
                            long totalElapsedMs = System.currentTimeMillis() - requestStartTimeMs;
                            if (ENABLE_PHOTO_TIMING_LOGS) {
                                Log.i(TAG, "⏱️ [TIMING] BLE Photo CAPTURED in " + totalElapsedMs + "ms - ID: " + requestId);
                            }
                            
                            Log.d(TAG, "Photo captured successfully for BLE transfer: " + filePath);

                            // LED is now managed by CameraNeo and will turn off when camera closes

                            // Notify that we've captured the photo
                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                            }

                            // Compress and send via BLE
                            compressAndSendViaBle(filePath, requestId, bleImgId);
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            Log.e(TAG, "Failed to capture photo for BLE: " + errorMessage);
                            
                            // LED is now managed by CameraNeo and will turn off when camera closes
                            
                            sendPhotoErrorResponse(requestId, "CAMERA_CAPTURE_FAILED", errorMessage);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(requestId, errorMessage, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    },
                    size
            );
        } catch (Exception e) {
            Log.e(TAG, "Error taking photo for BLE", e);
            sendMediaErrorResponse(requestId, "Error taking photo: " + e.getMessage(), MediaUploadQueueManager.MEDIA_TYPE_PHOTO);

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(requestId, "Error taking photo: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
        }
    }

    /**
     * Reuse existing photo for BLE transfer (when webhook fails)
     * This avoids taking a duplicate photo
     */
    private void reusePhotoForBleTransfer(String existingPhotoPath, String requestId, String bleImgId, boolean save, String size) {
        // Check if RTMP streaming is active - avoid BLE transfers during streams
        if (RtmpStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot transfer photo via BLE - RTMP streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with RTMP streaming");
            return;
        }

        // Store the save flag for this request
        photoSaveFlags.put(requestId, save);
        // Track requested size for BLE compression
        photoRequestedSizes.put(requestId, size);

        Log.d(TAG, "♻️ Reusing existing photo for BLE transfer: " + existingPhotoPath);
        
        // Notify that we're using an existing photo
        if (mMediaCaptureListener != null) {
            mMediaCaptureListener.onPhotoCaptured(requestId, existingPhotoPath);
        }
        
        // Compress and send via BLE using the existing photo
        compressAndSendViaBle(existingPhotoPath, requestId, bleImgId);
    }

    /**
     * Compress photo and send via BLE
     */
    private void compressAndSendViaBle(String originalPath, String requestId, String bleImgId) {
        new Thread(() -> {
            long startTime = System.currentTimeMillis();
            Log.d(TAG, "🚀 BLE photo transfer started for " + bleImgId);

            // TESTING: Check for fake compression failure
            if (PhotoCaptureTestFramework.shouldFail("COMPRESSION")) {
                Log.e(TAG, "TESTING: Simulating compression failure");
                sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                    PhotoCaptureTestFramework.getErrorMessage());
                return;
            }
            
            // TESTING: Add fake delay for compression
            PhotoCaptureTestFramework.addFakeDelay("COMPRESSION");

            try {
                // 1. Load original image
                android.graphics.Bitmap original = android.graphics.BitmapFactory.decodeFile(originalPath);
                if (original == null) {
                    throw new Exception("Failed to decode image file");
                }

                // 2. Resolve BLE resize and quality parameters based on requested size
                String requestedSize = photoRequestedSizes.get(requestId);
                if (requestedSize == null || requestedSize.isEmpty()) {
                    requestedSize = "medium";
                }

                BleParams bleParams = resolveBleParams(requestedSize);

                // Calculate new dimensions maintaining aspect ratio, constrained by requested target
                int targetWidth = bleParams.targetWidth;
                int targetHeight = bleParams.targetHeight;
                float aspectRatio = (float) original.getWidth() / original.getHeight();

                if (aspectRatio > targetWidth / (float) targetHeight) {
                    targetHeight = (int) (targetWidth / aspectRatio);
                } else {
                    targetWidth = (int) (targetHeight * aspectRatio);
                }

                // 3. Resize bitmap
                android.graphics.Bitmap resized = android.graphics.Bitmap.createScaledBitmap(original, targetWidth, targetHeight, true);
                original.recycle();

                // 4. Encode as AVIF with aggressive compression
                byte[] compressedData;
                try {
                    // Use avif-coder library for AVIF encoding
                    HeifCoder heifCoder = new HeifCoder();
                    compressedData = heifCoder.encodeAvif(
                        resized,
                            bleParams.avifQuality,  // quality (0-100)
                        PreciseMode.LOSSY   // Use FAST mode for reasonable compression speed
                    );
                    Log.d(TAG, "Successfully encoded as AVIF");
                } catch (Exception e) {
                    Log.w(TAG, "AVIF encoding failed, falling back to JPEG: " + e.getMessage());
                    // Fallback to JPEG if AVIF fails
                    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                    resized.compress(android.graphics.Bitmap.CompressFormat.JPEG, bleParams.jpegFallbackQuality, baos);
                    compressedData = baos.toByteArray();
                }
                resized.recycle();

                long compressionTime = System.currentTimeMillis() - startTime;
                Log.d(TAG, "✅ Compressed photo for BLE: " + originalPath + " -> " + compressedData.length + " bytes");
                Log.d(TAG, "⏱️ Compression took: " + compressionTime + "ms");

                // 5. Save compressed data to temporary file with bleImgId as name
                // For BLE, we ALWAYS use AVIF (no extension in filename due to 16-char limit)
                String compressedPath = fileManager.getDefaultMediaDirectory() + "/" + bleImgId;
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(compressedPath)) {
                    fos.write(compressedData);
                }

                // 6. Send via BLE using K900BluetoothManager
                sendCompressedPhotoViaBle(compressedPath, bleImgId, requestId, startTime);

                // 7. Delete original photo if not saving to gallery
                Boolean save = photoSaveFlags.get(requestId);
                if (save == null || !save) {
                    try {
                        File originalFile = new File(originalPath);
                        if (originalFile.exists() && originalFile.delete()) {
                            Log.d(TAG, "🗑️ Deleted original photo after BLE compression: " + originalPath);
                        } else {
                            Log.w(TAG, "Failed to delete original photo: " + originalPath);
                        }
                    } catch (Exception deleteEx) {
                        Log.e(TAG, "Error deleting original photo after BLE compression", deleteEx);
                    }
                } else {
                    Log.d(TAG, "💾 Keeping original photo as requested: " + originalPath);
                }

                // Clean up the flag
                photoSaveFlags.remove(requestId);
            } catch (Exception e) {
                Log.e(TAG, "Error compressing photo for BLE", e);
                sendPhotoErrorResponse(requestId, "BLE_TRANSFER_FAILED", e.getMessage());

                // Clean up flag on error too
                photoSaveFlags.remove(requestId);
            }
        }).start();
    }

    /**
     * Send compressed photo via BLE
     */
    private void sendCompressedPhotoViaBle(String compressedPath, String bleImgId, String requestId, long transferStartTime) {
        Log.d(TAG, "Ready to send compressed photo via BLE: " + compressedPath + " with ID: " + bleImgId);

        // TESTING: Check for fake BLE transfer failure
        if (PhotoCaptureTestFramework.shouldFail("BLE_TRANSFER")) {
            Log.e(TAG, "TESTING: Simulating BLE transfer failure");
            sendPhotoErrorResponse(requestId, PhotoCaptureTestFramework.getErrorCode(), 
                PhotoCaptureTestFramework.getErrorMessage());
            return;
        }
        
        // TESTING: Add fake delay for BLE transfer
        PhotoCaptureTestFramework.addFakeDelay("BLE_TRANSFER");

        boolean transferStarted = false;
        try {
            if (mServiceCallback != null) {
                // CRITICAL: Check if BLE is busy BEFORE sending ANY data to BES2700
                if (mServiceCallback.isBleTransferInProgress()) {
                    Log.e(TAG, "❌ BLE transfer already in progress - queuing error message to avoid BES2700 overload");
                    
                    // Send error response immediately
                    sendPhotoErrorResponse(requestId, "BLE_TRANSFER_BUSY", "BLE transfer busy - another transfer in progress");
                    
                    // Also notify local listener
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onMediaError(requestId, "BLE transfer busy - another transfer in progress", MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                    }
                    return;
                }
                
                // BLE is available - send the ready message first (phone expects this for timing tracking)
                sendBlePhotoReadyMsg(compressedPath, bleImgId, requestId, transferStartTime);

                // Add delay to ensure JSON packet completes transmission through MCU before file packets start
                // This prevents packet interleaving at the BLE MTU boundary
                try {
                    Thread.sleep(200); // 200ms delay for JSON packet to fully transmit over BLE
                    Log.d(TAG, "⏱️ Waited 200ms for JSON packet to complete BLE transmission");
                } catch (InterruptedException e) {
                    Log.w(TAG, "Delay interrupted", e);
                }

                // Then try to start the file transfer
                transferStarted = mServiceCallback.sendFileViaBluetooth(compressedPath);
                
                if (transferStarted) {
                    Log.i(TAG, "✅ BLE file transfer started for: " + bleImgId);
                } else {
                    // This shouldn't happen since we checked above, but handle it anyway
                    Log.e(TAG, "Failed to start BLE file transfer despite availability check");
                    sendPhotoErrorResponse(requestId, "BLE_TRANSFER_FAILED_TO_START", "BLE transfer failed to start");
                }
            } else {
                Log.e(TAG, "Service callback not available for BLE file transfer");
                sendPhotoErrorResponse(requestId, "BLE_TRANSFER_FAILED", "Service callback not available");
            }
        } finally {
            // Critical: Clean up compressed file if transfer didn't start
            if (!transferStarted) {
                try {
                    File compressedFile = new File(compressedPath);
                    if (compressedFile.exists()) {
                        if (compressedFile.delete()) {
                            Log.d(TAG, "🗑️ Deleted compressed file after BLE transfer failure: " + compressedPath);
                        } else {
                            Log.w(TAG, "⚠️ Failed to delete compressed file: " + compressedPath);
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error deleting compressed file: " + compressedPath, e);
                }
            }
        }
    }

    /**
     * Request BLE file transfer through AsgClientService
     */
    private void sendBlePhotoReadyMsg(String filePath, String bleImgId, String requestId, long transferStartTime) {
        try {
            // Calculate compression duration on glasses side
            long compressionDuration = System.currentTimeMillis() - transferStartTime;

            JSONObject json = new JSONObject();
            json.put("type", "ble_photo_ready");
            json.put("requestId", requestId);
            json.put("bleImgId", bleImgId);
            json.put("compressionDurationMs", compressionDuration);  // Send duration, not timestamp

            // Send through bluetooth if available
            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating BLE transfer request", e);
        }
    }

    /**
     * Send BLE transfer error
     */
    private void sendBleTransferError(String requestId, String error) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "ble_photo_error");
            json.put("requestId", requestId);
            json.put("error", error);

            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating BLE transfer error", e);
        }
    }

    /**
     * Send simplified photo error response with only essential fields
     */
    public void sendPhotoErrorResponse(String requestId, String errorCode, String errorMessage) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_response");
            json.put("requestId", requestId);
            json.put("success", false);
            json.put("errorCode", errorCode);
            json.put("errorMessage", errorMessage);

            Log.e(TAG, "📸 SENDING PHOTO ERROR: " + errorCode + " - " + errorMessage + " for requestId: " + requestId);
            
            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
                Log.e(TAG, "📸 SENT VIA BLE: " + json.toString());
            } else {
                Log.e(TAG, "❌ Service callback not available for BLE file transfer");
            }
        } catch (JSONException e) {
            Log.e(TAG, "❌ Error creating photo error response", e);
        }
    }


    /**
     * Check if BLE transfer is currently in progress.
     * Used for cooldown mechanism to reject new photo requests.
     */
    public boolean isBleTransferInProgress() {
        return mServiceCallback != null && mServiceCallback.isBleTransferInProgress();
    }

    /**
     * Get BLE connection state for error diagnostics
     */
    private JSONObject getBleConnectionState() {
        JSONObject ble = new JSONObject();
        try {
            boolean transferInProgress = mServiceCallback != null && mServiceCallback.isBleTransferInProgress();
            ble.put("connected", mServiceCallback != null); // Assume connected if callback exists
            ble.put("transferInProgress", transferInProgress);
        } catch (Exception e) {
            Log.e(TAG, "Error getting BLE state", e);
            try {
                ble.put("connected", false);
                ble.put("transferInProgress", false);
            } catch (JSONException jsonE) {
                Log.e(TAG, "Error creating fallback BLE state JSON", jsonE);
            }
        }
        return ble;
    }

    /**
     * Start monitoring battery during video recording.
     * Stops recording if battery drops below minimum threshold.
     */
    private void startBatteryMonitoring() {
        assertMainThread();

        // Early return if StateManager not available (will be retried by runnable)
        if (mStateManager == null) {
            Log.w(TAG, "⚠️ StateManager not set - cannot start battery monitoring (will retry if StateManager becomes available)");
            // Note: We don't return here because the runnable will check again later
            // This allows monitoring to start even if StateManager is set after recording begins
        }

        stopBatteryMonitoring(); // Clean up any existing monitor

        if (mBatteryMonitorHandler == null) {
            mBatteryMonitorHandler = new Handler(Looper.getMainLooper());
        }

        mBatteryCheckRunnable = new Runnable() {
            @Override
            public void run() {
                if (isRecordingVideo) {
                    // Null check for StateManager (might not be initialized yet or cleared)
                    if (mStateManager == null) {
                        Log.w(TAG, "⚠️ StateManager not available during battery monitoring - skipping check");
                        // Reschedule to try again later in case StateManager gets initialized
                        if (isRecordingVideo && mBatteryMonitorHandler != null) {
                            mBatteryMonitorHandler.postDelayed(this,
                                BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
                        }
                        return;
                    }

                    int batteryLevel = mStateManager.getBatteryLevel();

                    if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                        Log.w(TAG, "🔋⚠️ Battery dropped to " + batteryLevel +
                            "% during recording - stopping");

                        // Stop with specific reason - prevents duplicate feedback
                        stopVideoRecording(StopReason.LOW_BATTERY);

                    } else {
                        // Check again after interval
                        mBatteryMonitorHandler.postDelayed(this,
                            BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
                    }
                }
            }
        };

        // Start monitoring after first interval
        mBatteryMonitorHandler.postDelayed(mBatteryCheckRunnable,
            BatteryConstants.BATTERY_CHECK_INTERVAL_MS);

        Log.d(TAG, "🔋 Started battery monitoring for video recording");
    }

    /**
     * Stop battery monitoring.
     * Safe to call multiple times.
     */
    private void stopBatteryMonitoring() {
        if (mBatteryMonitorHandler != null) {
            if (mBatteryCheckRunnable != null) {
                mBatteryMonitorHandler.removeCallbacks(mBatteryCheckRunnable);
                mBatteryCheckRunnable = null;
            }

            // Safety net: remove ALL callbacks/messages to ensure nothing lingers
            mBatteryMonitorHandler.removeCallbacksAndMessages(null);

            Log.d(TAG, "🔋 Stopped battery monitoring");
        }
    }

    /**
     * Cleanup resources and stop all monitoring.
     * MUST be called before service is destroyed to prevent leaks.
     */
    public void cleanup() {
        assertMainThread();
        Log.d(TAG, "🧹 MediaCaptureService cleanup() called");

        try {
            // Stop battery monitoring
            stopBatteryMonitoring();

            // Stop any active recording
            if (isRecordingVideo) {
                Log.w(TAG, "⚠️ Video still recording during cleanup - force stopping");
                stopVideoRecording(StopReason.ERROR);
            }

            // Release video buffer
            if (mVideoBuffer != null) {
                try {
                    mVideoBuffer.release();
                } catch (Exception e) {
                    Log.e(TAG, "Error releasing video buffer", e);
                }
                mVideoBuffer = null;
            }

            // Nuclear cleanup of handlers
            if (mBatteryMonitorHandler != null) {
                mBatteryMonitorHandler.removeCallbacksAndMessages(null);
                mBatteryMonitorHandler = null;
            }

            Log.d(TAG, "✅ MediaCaptureService cleanup complete");

        } catch (Exception e) {
            Log.e(TAG, "💥 Error during MediaCaptureService cleanup", e);
            // Don't rethrow - cleanup should be best-effort
        }
    }

    /**
     * Send gallery status update to phone after photo capture
     * Uses GalleryStatusHelper to avoid code duplication with GalleryCommandHandler
     */
    private void sendGalleryStatusUpdate() {
        try {
            Log.d(TAG, "📸 Sending gallery status update after photo capture");

            if (fileManager == null) {
                Log.w(TAG, "📸 Cannot send gallery status: FileManager not available");
                return;
            }

            // Build gallery status using shared utility
            JSONObject response = com.mentra.asg_client.utils.GalleryStatusHelper.buildGalleryStatus(fileManager);

            // Send through bluetooth if available
            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(response.toString().getBytes());
                Log.d(TAG, "📸 Gallery status update sent successfully");
            } else {
                Log.w(TAG, "📸 Cannot send gallery status update: service callback not available");
            }
        } catch (Exception e) {
            Log.e(TAG, "📸 Error creating gallery status update", e);
        }
    }

    // ========== CIRCULAR VIDEO BUFFER METHODS ==========
}
