package com.mentra.asg_client.io.media.core;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;
import com.mentra.asg_client.camera.lifecycle.PhotoExifMetadataWriter;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;
import com.mentra.asg_client.io.media.interfaces.ServiceCallbackInterface;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.media.upload.MediaUploadService;
import com.mentra.asg_client.io.storage.StorageManager;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.service.core.CameraRestartCooldown;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.utils.CaptureRequestId;
import com.mentra.asg_client.utils.GalleryStatusHelper;
import com.mentra.asg_client.utils.GallerySyncFilter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.URI;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Service that handles media capturing (photo and video) and uploading functionality. Replaces
 * PhotoCaptureService to support both photos and videos.
 *
 * <p><b>Thread Safety:</b> All public methods MUST be called from the main thread. Methods will
 * throw {@link IllegalStateException} if called from other threads.
 *
 * <p><b>Lifecycle:</b> Call {@link #cleanup()} before destroying the service to prevent memory
 * leaks.
 */
public class MediaCaptureService {
    private static final String TAG = "MediaCaptureService";

    // Debug flag: Enable detailed end-to-end photo capture timing logs
    // true = log timing from request to capture, false = suppress timing logs
    private static final boolean ENABLE_PHOTO_TIMING_LOGS = true;

    private final Context mContext;
    private final MediaUploadQueueManager mMediaQueueManager;
    private MediaCaptureListener mMediaCaptureListener;
    private ServiceCallbackInterface mServiceCallback;
    private final IHardwareManager hardwareManager;

    // Track current video recording
    private boolean isRecordingVideo = false;
    private String currentVideoId = null;
    // volatile: read in the stop prologue (BLE worker / main looper) to derive the upload-target
    // captureId key, while written on the start/callback threads — needs cross-thread visibility.
    private volatile String currentVideoPath = null;
    private long recordingStartTime = 0;
    private boolean currentVideoLedEnabled =
            false; // Track if LED was enabled for current recording
    private boolean currentVideoSoundEnabled =
            false; // Track if sound was enabled for current recording

    // Stop-time upload decision, bound to the recording's captureId (its capture-dir name, which is
    // unique per recording). Registered when the recording is stopped and consumed exactly once by
    // that recording's onRecordingStopped. Keying by captureId — instead of shared mutable fields —
    // means: the FIRST stop for a recording wins (putIfAbsent), so a user stop that races or follows
    // an auto-stop can't turn a "no upload" auto-stop into an upload; a new recording (different
    // captureId) can't overwrite a prior recording's still-pending target; and every onRecordingStopped
    // exit path removes its own entry, so a target can't leak into a later recording.
    private final ConcurrentHashMap<String, UploadTarget> uploadTargetsByCaptureId =
            new ConcurrentHashMap<>();

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
        USER_REQUESTED, // User/TPA explicitly stopped
        LOW_BATTERY, // Battery dropped below threshold
        MAX_DURATION, // Hit max recording time
        ERROR // Error occurred
    }

    private StopReason mCurrentStopReason = null;

    /** Stop-time upload target bound to a specific recording. Empty/null webhook = keep on device. */
    private static final class UploadTarget {
        final String webhookUrl;
        final String authToken;

        UploadTarget(String webhookUrl, String authToken) {
            this.webhookUrl = webhookUrl;
            this.authToken = authToken;
        }
    }

    // Guards the stop prologue (mCurrentStopReason + pending-upload target) so the
    // check-and-set is atomic across threads. The user stop arrives on the BLE worker
    // thread while auto-stops (max-duration/battery/error) fire on the main looper; without
    // this lock a late user stop could inject a webhook into an auto-stop that already
    // committed to "no upload".
    private final Object mStopLock = new Object();

    // Default BLE params (used if size unspecified)
    public static final int bleImageTargetWidth = 480;
    public static final int bleImageTargetHeight = 480;
    public static final int bleImageAvifQuality = 40;

    // Flip to false to fall back to the legacy full-color BLE pipeline (full-res ARGB decode +
    // createScaledBitmap + RGB BleImageSharpener + YUV420 AVIF). BLE photos exist to be read
    // (documents/signs/screens), not viewed, so grayscale is the default - true here also cuts
    // the per-photo peak transient memory from ~36MB down to ~4MB (see GrayscaleBleProcessor)
    // and encodes a true monochrome (YUV400) AVIF with no chroma planes.
    private static final boolean ENABLE_GRAYSCALE_BLE_PHOTOS = true;

    // AOM cpu-used for the mono BLE encode (0..9, higher = faster; -1 = plugin default). The
    // MTK8766 has no hardware AV1 encoder, so software encode time dominates the BLE photo
    // pipeline (4-5.5s of ~7.4s end-to-end at plugin default). Benchmarked at 1920x1440: speed 8
    // encodes ~2.6x faster than the default with comparable output size.
    private static final int BLE_AVIF_ENCODE_SPEED = 8;

    // Crop BLE photos to the detected text/document region before encode (grayscale path only).
    // The crop keeps native resolution on the region OCR actually reads instead of downscaling
    // the whole frame; detection is conservative and falls back to full frame on weak signal
    // (see TextRegionDetector). Kill switch for on-device tuning.
    private static final boolean ENABLE_BLE_TEXT_ROI_CROP = true;

    private static class BleParams {
        final int targetWidth;
        final int targetHeight;
        final int avifQuality;

        BleParams(int targetWidth, int targetHeight, int avifQuality) {
            this.targetWidth = targetWidth;
            this.targetHeight = targetHeight;
            this.avifQuality = avifQuality;
        }
    }

    private BleParams resolveBleParams(String requestedSize) {
        // Sized for the push-mode/batched-ack BLE pipe (~45-70 KB/s), not the old
        // ~19KB single-notification ceiling. Two rules drive the ladder:
        //  - Resolution first: text is readable only when glyphs survive the
        //    downscale (~10px x-height), so every tier keeps the long edge at or
        //    above the old ladder's.
        //  - Quality stays out of the AVIF smear zone (q >= ~45): below that, AV1's
        //    loop filters melt text strokes no matter how many pixels there are.
        // Values are width/height CAPS - the resize preserves aspect ratio, so a
        // 4:3 capture lands at e.g. 1280x960. Constant-quality mode self-adapts
        // bytes to content: scenery compresses small, text spends what it needs.
        String tier = PhotoSizeTier.normalize(requestedSize);
        switch (tier) {
            case "low":
                // ~15-25KB typical: readable large text, fastest transfer
                return new BleParams(800, 800, 50);
            case "high":
                // ~50-90KB typical: document text comfortably readable
                return new BleParams(1600, 1600, 48);
            case "max":
                // ~90-160KB typical: document-grade
                return new BleParams(1920, 1920, 55);
            case "medium":
            default:
                // ~30-55KB typical: matches the WiFi medium resolution
                return new BleParams(1280, 1280, 50);
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

    // Photo job state tracking - one photo job (capture + upload/BLE-handoff) in flight at a time.
    // Set on entry to takePhotoAndUpload / takePhotoForBleTransfer; cleared only at terminal
    // exits (success or failure) of the full pipeline, NOT on the capture→upload transition.
    // Concurrent SDK photo requests are rejected with CAMERA_BUSY while this is true.
    private final AtomicReference<String> activePhotoJobRequestId = new AtomicReference<>(null);
    private final AtomicBoolean isCleaningUp = new AtomicBoolean(false);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /**
     * Capture IDs blocked from Wi‑Fi sync from the moment the output path is created until
     * post-stop integrity validation completes (or the capture is cleaned up on error).
     */
    private final Set<String> videoCaptureIdsInFlight = ConcurrentHashMap.newKeySet();

    /**
     * Subset of in-flight captures that have stopped recording and are awaiting integrity check.
     */
    private final Set<String> videoCaptureIdsPendingIntegrityCheck = ConcurrentHashMap.newKeySet();

    private final ExecutorService videoIntegrityExecutor =
            Executors.newSingleThreadExecutor(
                    r -> {
                        Thread t = new Thread(r, "RecordedVideoIntegrity");
                        t.setPriority(Thread.NORM_PRIORITY - 1);
                        return t;
                    });
    // Safety timeout covers the full job (capture + upload/BLE-handoff). Sized to outlast a
    // slow webhook upload on flaky WiFi so we don't prematurely free the flag while the upload
    // is still grinding. Force-resets isPhotoJobInFlight if no terminal callback fires.
    private static final long CAPTURE_SAFETY_TIMEOUT_MS = 45000; // 45 seconds
    private final Object captureSafetyTimeoutLock = new Object();
    private Runnable captureSafetyTimeout;
    private String captureSafetyTimeoutRequestId;

    // Per-request timing instrumentation (gated by ENABLE_PHOTO_TIMING_LOGS)
    private final Map<String, Map<String, Long>> photoTimings = new HashMap<>();

    private final FileManager fileManager;

    /** Interface for listening to media capture and upload events */
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
     * @param context Application context
     * @param mediaQueueManager MediaUploadQueueManager instance
     * @param fileManager FileManager instance
     * @param stateManager StateManager for battery level checks
     */
    public MediaCaptureService(
            @NonNull Context context,
            @NonNull MediaUploadQueueManager mediaQueueManager,
            FileManager fileManager,
            @NonNull IStateManager stateManager) {
        mContext = context.getApplicationContext();
        mMediaQueueManager = mediaQueueManager;
        this.fileManager = fileManager;
        this.mStateManager = stateManager;

        // Initialize hardware manager
        hardwareManager = HardwareManagerFactory.getInstance(context);
        Log.d(TAG, "Hardware manager initialized: " + hardwareManager.getDeviceModel());
    }

    /** Set a listener for media capture events */
    public void setMediaCaptureListener(MediaCaptureListener listener) {
        this.mMediaCaptureListener = listener;
    }

    /** Set the service callback for communication with AsgClientService */
    public void setServiceCallback(ServiceCallbackInterface callback) {
        this.mServiceCallback = callback;
    }

    /**
     * Verify we're on the main thread. All public methods must run on main thread for thread
     * safety.
     */
    private void assertMainThread() {
        if (Looper.getMainLooper() != Looper.myLooper()) {
            throw new IllegalStateException(
                    "MediaCaptureService methods must be called from main thread. "
                            + "Current: "
                            + Thread.currentThread().getName());
        }
    }

    /** Play battery low sound to alert user. */
    public void playBatteryLowSound() {
        if (hardwareManager != null && hardwareManager.supportsAudioPlayback()) {
            hardwareManager.playAudioAsset(AudioAssets.BATTERY_LOW);
            Log.d(TAG, "🔋 Playing battery low sound");
        } else {
            Log.w(TAG, "⚠️ Cannot play battery low sound - hardware manager not available");
        }
    }

    /**
     * Static helper for contexts without MediaCaptureService instance. Used by StreamCommandHandler
     * and other handlers.
     */
    public static void playBatteryLowSound(Context context) {
        IHardwareManager hwManager = HardwareManagerFactory.getInstance(context);
        if (hwManager != null && hwManager.supportsAudioPlayback()) {
            hwManager.playAudioAsset(AudioAssets.BATTERY_LOW);
            Log.d("MediaCaptureService", "🔋 Playing battery low sound (static)");
        }
    }

    /** Play storage full sound to alert user. */
    public void playStorageFullSound() {
        if (hardwareManager != null && hardwareManager.supportsAudioPlayback()) {
            hardwareManager.playAudioAsset(AudioAssets.STORAGE_FULL);
            Log.d(TAG, "💾 Playing storage full sound");
        } else {
            Log.w(TAG, "⚠️ Cannot play storage full sound - hardware manager not available");
        }
    }

    /**
     * Set or update the StateManager reference. Used when StateManager is initialized after
     * MediaCaptureService creation.
     */
    public void setStateManager(IStateManager stateManager) {
        this.mStateManager = stateManager;
        Log.d(TAG, "✅ StateManager updated for battery monitoring");
    }

    private boolean shouldSuppressPhotoFeedback() {
        return CameraRestartCooldown.isActive();
    }

    /**
     * Plays the photo feedback sound, choosing a short "hot" clip when the upcoming capture will
     * reuse the already-running camera and a long "cold" clip when it will pay the 1–2s camera/ISP
     * startup on Mentra Live. The decision is made synchronously here, at button-press time and
     * before the request is enqueued, so it predicts whether THIS capture is fast or slow. The
     * upcoming-capture parameters must match those passed to {@code enqueuePhotoRequest} so the
     * warmth prediction lines up with the path the request actually takes.
     *
     * @param size requested photo size for the upcoming capture (nullable)
     * @param isFromSdk whether the upcoming capture is an SDK request (vs. a button photo)
     * @param exposureTimeNs requested manual exposure for the upcoming capture, or null for auto
     */
    private void playShutterSound(String size, boolean isFromSdk, Long exposureTimeNs) {
        if (hardwareManager == null) {
            Log.w(TAG, "⚠️ hardwareManager is null, cannot play shutter sound");
            return;
        }

        if (!hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "⚠️ hardwareManager does not support audio playback");
            return;
        }

        // A warm capture reuses the open camera (including queuing behind an in-flight shot), so a
        // short "hot" sound matches the quick capture. A cold capture needs a longer "cold" sound
        // that spans the camera/ISP warmup so the user keeps still until the photo actually lands.
        boolean cameraWarm = CameraNeoService.isCameraWarm(size, isFromSdk, exposureTimeNs);
        String shutterAsset =
                cameraWarm ? AudioAssets.TAKE_PHOTO_HOT : AudioAssets.TAKE_PHOTO_COLD;
        Log.d(TAG, "📸 Playing " + (cameraWarm ? "HOT (short)" : "COLD (long)") + " shutter sound");
        hardwareManager.playAudioAsset(shutterAsset);
    }

    /** Flash privacy LED synchronized with shutter sound for photo capture */
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
        // hardwareManager.setRecordingLedBrightness(50, 1000); // 50% brightness, 1000ms flash
        // duration
        hardwareManager.flashRecordingLed(1000);
    }

    /**
     * Trigger white LED flash for photo capture (synchronized with shutter sound, default
     * brightness)
     */
    private void triggerPhotoFlashLed() {
        triggerPhotoFlashLed(RgbLedConstants.DEFAULT_BRIGHTNESS);
    }

    /**
     * Trigger white LED flash for photo capture with specified brightness
     *
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    private void triggerPhotoFlashLed(int brightness) {
        Log.i(TAG, "📸 triggerPhotoFlashLed() called with brightness: " + brightness);

        if (hardwareManager != null && hardwareManager.supportsRgbLed()) {
            hardwareManager.flashRgbLedWhite(2200, brightness); // 2.2 second flash
            Log.i(
                    TAG,
                    "📸 Photo flash LED (white) triggered via hardware manager at brightness "
                            + brightness);
        } else {
            Log.w(TAG, "⚠️ RGB LED not supported on this device");
        }
    }

    /** Trigger solid white LED for video recording duration (default brightness) */
    private void triggerVideoRecordingLed() {
        triggerVideoRecordingLed(RgbLedConstants.DEFAULT_BRIGHTNESS);
    }

    /**
     * Trigger solid white LED for video recording duration with specified brightness
     *
     * @param brightness Brightness level (0-255, where 255 is maximum brightness)
     */
    private void triggerVideoRecordingLed(int brightness) {
        Log.i(TAG, "🎥 triggerVideoRecordingLed() called with brightness: " + brightness);

        if (hardwareManager != null && hardwareManager.supportsRgbLed()) {
            hardwareManager.setRgbLedSolidWhite(1800000, brightness); // 30 minute solid white LED
            Log.i(
                    TAG,
                    "🎥 Video recording LED (solid white) triggered via hardware manager at brightness "
                            + brightness);
        } else {
            Log.w(TAG, "⚠️ RGB LED not supported on this device");
        }
    }

    /** Stop video recording LED (turn off LED) */
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
     *
     * @param settings Video settings (resolution, fps)
     * @param enableLed Whether to enable recording LED
     * @param maxRecordingTimeMinutes Maximum recording time in minutes (0 = no limit)
     * @param initialBatteryLevel Initial battery level (for monitoring during recording, -1 =
     *     unknown)
     */
    public void startVideoRecording(
            VideoSettings settings,
            boolean enableFlash,
            int maxRecordingTimeMinutes,
            int initialBatteryLevel) {
        // Note: Removed assertMainThread() - this is called from Bluetooth worker thread via
        // command handlers
        // Thread safety is maintained through CameraNeoService's internal threading and Handler
        // usage
        Log.d(
                TAG,
                "startVideoRecording called with settings: "
                        + settings
                        + ", enableFlash: "
                        + enableFlash
                        + ", maxRecordingTimeMinutes: "
                        + maxRecordingTimeMinutes
                        + ", initialBatteryLevel: "
                        + initialBatteryLevel);

        // Check if battery is too low to start recording (query current level for accuracy)
        if (mStateManager != null) {
            int currentBatteryLevel = mStateManager.getBatteryLevel();
            if (currentBatteryLevel >= 0
                    && currentBatteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(
                        TAG,
                        "🚫 Battery too low to start recording: "
                                + currentBatteryLevel
                                + "% (minimum "
                                + BatteryConstants.MIN_BATTERY_LEVEL
                                + "% required)");
                playBatteryLowSound();
                return;
            }
        } else {
            Log.w(
                    TAG,
                    "⚠️ StateManager not initialized - skipping battery check for video recording");
        }

        if (isRecordingVideo) {
            Log.d(TAG, "Stopping video recording");
            stopVideoRecording();
        } else {
            Log.d(
                    TAG,
                    "Starting video recording with settings: "
                            + settings
                            + ", max time: "
                            + maxRecordingTimeMinutes
                            + " minutes, battery: "
                            + initialBatteryLevel
                            + "%");
            // Generate IDs for local recording
            String timeStamp =
                    new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
            int randomSuffix = (int) (Math.random() * 1000);
            String requestId = "local_video_" + timeStamp + "_" + randomSuffix;
            String captureDir = "VID_" + timeStamp + "_" + randomSuffix;
            File captureDirFile = new File(fileManager.getDefaultMediaDirectory(), captureDir);
            captureDirFile.mkdirs();
            String videoFilePath = new File(captureDirFile, "base.mp4").getAbsolutePath();
            startVideoRecording(
                    videoFilePath,
                    requestId,
                    settings,
                    enableFlash,
                    true,
                    maxRecordingTimeMinutes,
                    false);
        }
    }

    /**
     * Handle start video recording command from phone Similar to takePhotoAndUpload but for video
     *
     * @param requestId Unique request ID for tracking
     * @param save Whether to keep the video on device after upload
     */
    public void handleStartVideoCommand(
            String requestId, boolean save, boolean enableFlash, boolean enableSound) {
        handleStartVideoCommand(requestId, save, null, enableFlash, enableSound);
    }

    /**
     * Handle start video recording command from phone with settings
     *
     * @param requestId Unique request ID for tracking
     * @param save Whether to keep the video on device after upload
     * @param settings Video settings (resolution, fps) or null for defaults
     */
    public void handleStartVideoCommand(
            String requestId,
            boolean save,
            VideoSettings settings,
            boolean enableFlash,
            boolean enableSound) {
        handleStartVideoCommand(requestId, save, settings, enableFlash, enableSound, 0);
    }

    /**
     * Handle start video recording command from phone with settings and a max recording time.
     *
     * @param requestId Unique request ID for tracking
     * @param save Whether to keep the video on device after upload
     * @param settings Video settings (resolution, fps) or null for defaults
     * @param maxRecordingTimeMinutes Maximum recording time in minutes (0 = no limit)
     */
    public void handleStartVideoCommand(
            String requestId,
            boolean save,
            VideoSettings settings,
            boolean enableFlash,
            boolean enableSound,
            int maxRecordingTimeMinutes) {
        Log.d(
                TAG,
                "handleStartVideoCommand called with requestId: "
                        + requestId
                        + ", save: "
                        + save
                        + ", settings: "
                        + settings
                        + ", enableFlash: "
                        + enableFlash
                        + ", enableSound: "
                        + enableSound
                        + ", maxRecordingTimeMinutes: "
                        + maxRecordingTimeMinutes);

        // Check if already recording
        if (isRecordingVideo) {
            Log.w(TAG, "Already recording video, ignoring start command");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId, "Already recording", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Generate filename with requestId
        String timeStamp =
                new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
        int randomSuffix = (int) (Math.random() * 1000);
        String embeddedRequestId = CaptureRequestId.sanitizeForDirName(requestId);
        String captureDir =
                "VID_"
                        + timeStamp
                        + "_"
                        + randomSuffix
                        + (embeddedRequestId.isEmpty() ? "" : "_" + embeddedRequestId);
        File captureDirFile = new File(fileManager.getDefaultMediaDirectory(), captureDir);
        captureDirFile.mkdirs();
        String videoFilePath = new File(captureDirFile, "base.mp4").getAbsolutePath();

        // Start video recording with the provided requestId and settings (or null for defaults)
        startVideoRecording(
                videoFilePath,
                requestId,
                settings,
                enableFlash,
                enableSound,
                maxRecordingTimeMinutes,
                save);
    }

    /**
     * Handle stop video recording command from phone
     *
     * @param requestId Request ID of the video to stop (must match current recording)
     */
    public void handleStopVideoCommand(String requestId, String webhookUrl, String authToken) {
        Log.d(TAG, "handleStopVideoCommand called with requestId: " + requestId);

        if (!isRecordingVideo) {
            Log.w(TAG, "No video recording to stop");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId, "Not recording", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Verify the requestId matches current recording
        if (!requestId.equals(currentVideoId)) {
            Log.w(TAG, "Stop command requestId doesn't match current recording");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId, "Request ID mismatch", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        stopVideoRecording(webhookUrl, authToken);
    }

    /** Start video recording locally with auto-generated IDs */
    private void startVideoRecording() {
        // Generate IDs for local recording
        String timeStamp =
                new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
        int randomSuffix = (int) (Math.random() * 1000);
        String requestId = "local_video_" + timeStamp + "_" + randomSuffix;
        String captureDir = "VID_" + timeStamp + "_" + randomSuffix;
        File captureDirFile = new File(fileManager.getDefaultMediaDirectory(), captureDir);
        captureDirFile.mkdirs();
        String videoFilePath = new File(captureDirFile, "base.mp4").getAbsolutePath();

        startVideoRecording(videoFilePath, requestId, false);
    }

    /** Start video recording with specific parameters */
    private void startVideoRecording(String videoFilePath, String requestId, boolean enableFlash) {
        startVideoRecording(videoFilePath, requestId, null, enableFlash, true, 0, false);
    }

    /** Start video recording with specific parameters and settings */
    private void startVideoRecording(
            String videoFilePath,
            String requestId,
            VideoSettings settings,
            boolean enableFlash,
            boolean enableSound,
            boolean save) {
        startVideoRecording(videoFilePath, requestId, settings, enableFlash, enableSound, 0, save);
    }

    /** Start video recording with specific parameters, settings, and max time */
    private void startVideoRecording(
            String videoFilePath,
            String requestId,
            VideoSettings settings,
            boolean enableFlash,
            boolean enableSound,
            int maxRecordingTimeMinutes,
            boolean save) {
        // Check if any streaming is active - videos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot start video - streaming active");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId,
                        "Camera busy with streaming",
                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Check if camera is actively in use (this will return false for kept-alive idle camera)
        if (CameraNeoService.isCameraInUse()) {
            Log.e(TAG, "Cannot start video - camera actively in use");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId, "Camera busy", MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Check storage availability before recording
        if (!isExternalStorageAvailable()) {
            Log.e(TAG, "External storage is not available for video capture");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId,
                        "External storage is not available",
                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }
            return;
        }

        // Close kept-alive camera if it exists to free resources for video recording
        CameraNeoService.closeKeptAliveCamera();

        // Save info for the current recording session
        currentVideoId = requestId;
        currentVideoPath = videoFilePath;
        currentVideoLedEnabled = enableFlash; // Track LED state for this recording
        currentVideoSoundEnabled = enableSound; // Track sound state for this recording
        final String captureIdAtStart = captureIdFromVideoAbsPath(videoFilePath);
        if (captureIdAtStart != null) {
            videoCaptureIdsInFlight.add(captureIdAtStart);
            Log.d(TAG, "Video capture blocked from sync (in-flight): " + captureIdAtStart);
        }

        try {
            // Play video start sound if enabled
            if (enableSound) {
                playVideoStartSound();
            }
            if (enableFlash) {
                triggerVideoRecordingLed(); // Trigger solid white LED for video recording duration
            }

            // Start video recording using CameraNeoService
            CameraNeoService.startVideoRecording(
                    mContext,
                    requestId,
                    videoFilePath,
                    settings,
                    new CameraNeoService.VideoRecordingCallback() {
                        @Override
                        public void onRecordingStarted(String videoId) {
                            Log.d(TAG, "Video recording started with ID: " + videoId);
                            isRecordingVideo = true;
                            recordingStartTime = System.currentTimeMillis();

                            // Start battery monitoring on main thread (callback runs on background
                            // thread)
                            new Handler(Looper.getMainLooper())
                                    .post(() -> startBatteryMonitoring());

                            // Turn on recording flash LED if enabled with controlled brightness
                            if (enableFlash && hardwareManager.supportsLedBrightness()) {
                                // TODO: RESTORE LOWER LED BRIGHTNESS LATER
                                // hardwareManager.setRecordingLedBrightness(50); // 50% brightness
                                // for video
                                hardwareManager.setRecordingLedOn();
                                Log.d(TAG, "Recording flash LED turned ON at 50% brightness");
                            } else if (enableFlash && hardwareManager.supportsRecordingLed()) {
                                hardwareManager.setRecordingLedOn();
                                Log.d(TAG, "Recording flash LED turned ON (full brightness)");
                            }

                            // Notify listener
                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onVideoRecordingStarted(
                                        requestId, videoFilePath);
                            }

                            // Set up max recording time check if specified
                            if (maxRecordingTimeMinutes > 0) {
                                long maxRecordingTimeMs = maxRecordingTimeMinutes * 60 * 1000L;
                                Log.d(
                                        TAG,
                                        "Setting max recording time: "
                                                + maxRecordingTimeMinutes
                                                + " minutes ("
                                                + maxRecordingTimeMs
                                                + " ms)");

                                // Create a runnable that checks if max time has been reached
                                recordingTimeCheckRunnable =
                                        new Runnable() {
                                            @Override
                                            public void run() {
                                                if (isRecordingVideo) {
                                                    long elapsedTime =
                                                            System.currentTimeMillis()
                                                                    - recordingStartTime;
                                                    if (elapsedTime >= maxRecordingTimeMs) {
                                                        Log.d(
                                                                TAG,
                                                                "⏱️ Max recording time reached ("
                                                                        + maxRecordingTimeMinutes
                                                                        + " minutes), stopping recording");
                                                        stopVideoRecording(
                                                                StopReason.MAX_DURATION); // ← USE
                                                        // REASON
                                                    } else {
                                                        // Check again in 1 second
                                                        recordingTimeHandler.postDelayed(
                                                                this, 1000);
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
                            Log.d(
                                    TAG,
                                    "Video recording stopped: " + videoId + ", file: " + filePath);

                            // Cancel max recording time check
                            if (recordingTimeCheckRunnable != null) {
                                recordingTimeHandler.removeCallbacks(recordingTimeCheckRunnable);
                                recordingTimeCheckRunnable = null;
                            }

                            // Note: RGB white LED already turned off in stopVideoRecording()
                            // synchronized with sound

                            // Turn off recording LED if it was enabled
                            if (enableFlash && hardwareManager.supportsRecordingLed()) {
                                hardwareManager.setRecordingLedOff();
                                Log.d(TAG, "Recording LED turned OFF");
                            }

                            final String pendingRequestId = requestId;
                            // Prefer the path-derived ID so the integrity check uses the actual
                            // file written.
                            // Fall back to the start-time ID so we always release the in-flight
                            // block we added,
                            // even when the recorder reports a null/altered path.
                            final String captureIdFromCallback =
                                    captureIdFromVideoAbsPath(filePath);
                            final String captureId =
                                    captureIdFromCallback != null
                                            ? captureIdFromCallback
                                            : captureIdAtStart;

                            // Consume this recording's upload decision exactly once, up front, so it
                            // is dropped on every exit path below (null file path, cleanup, integrity
                            // failure) and can never leak into a later recording.
                            final UploadTarget uploadTarget =
                                    captureId != null
                                            ? uploadTargetsByCaptureId.remove(captureId)
                                            : null;

                            // Block sync before clearing session state — no gap between active and
                            // pending.
                            // Add to pending BEFORE removing from in-flight so a concurrent
                            // getPendingVideoIntegrityCaptureIds() snapshot always observes the
                            // captureId in
                            // at least one of the two sets (their union is what callers actually
                            // consume).
                            if (captureId != null) {
                                videoCaptureIdsPendingIntegrityCheck.add(captureId);
                                Log.d(TAG, "Video capture pending integrity check: " + captureId);
                            }
                            if (captureIdAtStart != null) {
                                videoCaptureIdsInFlight.remove(captureIdAtStart);
                            }

                            isRecordingVideo = false;
                            currentVideoId = null;
                            currentVideoPath = null;

                            if (filePath == null || captureIdFromCallback == null) {
                                Log.e(
                                        TAG,
                                        "onRecordingStopped received null filePath for "
                                                + pendingRequestId);
                                if (captureId != null) {
                                    // Nothing to verify; release the pending block we just added.
                                    videoCaptureIdsPendingIntegrityCheck.remove(captureId);
                                }
                                if (mMediaCaptureListener != null) {
                                    mMediaCaptureListener.onMediaError(
                                            pendingRequestId,
                                            "Video recording stopped with no file path",
                                            MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                }
                                sendGalleryStatusUpdate();
                                return;
                            }

                            if (isCleaningUp.get()) {
                                Log.w(
                                        TAG,
                                        "Skipping video integrity check because cleanup is already in progress");
                                sendGalleryStatusUpdate();
                                return;
                            }

                            try {
                                videoIntegrityExecutor.execute(
                                        () -> {
                                            try {
                                                final boolean ok =
                                                        RecordedVideoIntegrityChecker.verify(
                                                                filePath);
                                                mainHandler.post(
                                                        () -> {
                                                            videoCaptureIdsPendingIntegrityCheck
                                                                    .remove(captureId);
                                                            // Upload target was captured up front
                                                            // and bound to this recording's
                                                            // captureId; null = keep on device.
                                                            final String uploadWebhookUrl =
                                                                    uploadTarget != null
                                                                            ? uploadTarget.webhookUrl
                                                                            : null;
                                                            final String uploadAuthToken =
                                                                    uploadTarget != null
                                                                            ? uploadTarget.authToken
                                                                            : null;
                                                            if (ok) {
                                                                if (mMediaCaptureListener != null) {
                                                                    mMediaCaptureListener
                                                                            .onVideoRecordingStopped(
                                                                                    pendingRequestId,
                                                                                    filePath);
                                                                }
                                                                sendGalleryStatusUpdate();
                                                                uploadVideo(
                                                                        filePath,
                                                                        pendingRequestId,
                                                                        uploadWebhookUrl,
                                                                        uploadAuthToken,
                                                                        save);
                                                            } else {
                                                                final boolean cleaningUp =
                                                                        isCleaningUp.get();
                                                                if (!cleaningUp) {
                                                                    File bad = new File(filePath);
                                                                    if (bad.exists()
                                                                            && !bad.delete()) {
                                                                        Log.w(
                                                                                TAG,
                                                                                "Could not delete failed video file: "
                                                                                        + filePath);
                                                                    }
                                                                } else {
                                                                    Log.w(
                                                                            TAG,
                                                                            "Skipping failed video deletion because cleanup is in progress");
                                                                }
                                                                if (mMediaCaptureListener != null) {
                                                                    mMediaCaptureListener
                                                                            .onMediaError(
                                                                                    pendingRequestId,
                                                                                    cleaningUp
                                                                                            ? "Video integrity check aborted during cleanup; file preserved"
                                                                                            : "Video file failed integrity check and was removed",
                                                                                    MediaUploadQueueManager
                                                                                            .MEDIA_TYPE_VIDEO);
                                                                }
                                                                sendGalleryStatusUpdate();
                                                            }
                                                        });
                                            } catch (Throwable t) {
                                                Log.e(
                                                        TAG,
                                                        "Unexpected error during video integrity check",
                                                        t);
                                                mainHandler.post(
                                                        () -> {
                                                            videoCaptureIdsPendingIntegrityCheck
                                                                    .remove(captureId);
                                                            if (mMediaCaptureListener != null) {
                                                                mMediaCaptureListener.onMediaError(
                                                                        pendingRequestId,
                                                                        "Video integrity check error: "
                                                                                + t.getMessage(),
                                                                        MediaUploadQueueManager
                                                                                .MEDIA_TYPE_VIDEO);
                                                            }
                                                            sendGalleryStatusUpdate();
                                                        });
                                            }
                                        });
                            } catch (RejectedExecutionException e) {
                                Log.w(
                                        TAG,
                                        "Video integrity check rejected because cleanup is in progress",
                                        e);
                                videoCaptureIdsPendingIntegrityCheck.remove(captureId);
                                mainHandler.post(
                                        () -> {
                                            if (mMediaCaptureListener != null) {
                                                mMediaCaptureListener.onMediaError(
                                                        pendingRequestId,
                                                        "Video integrity check unavailable during cleanup",
                                                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                            }
                                            sendGalleryStatusUpdate();
                                        });
                            }
                        }

                        @Override
                        public void onRecordingError(String videoId, String errorMessage) {
                            Log.e(
                                    TAG,
                                    "Video recording error: "
                                            + videoId
                                            + ", error: "
                                            + errorMessage);
                            // Release the exact ID we registered at start so the in-flight block
                            // can't
                            // leak even if currentVideoPath has already been cleared.
                            if (captureIdAtStart != null) {
                                videoCaptureIdsInFlight.remove(captureIdAtStart);
                                videoCaptureIdsPendingIntegrityCheck.remove(captureIdAtStart);
                                Log.d(
                                        TAG,
                                        "Video capture unblocked from sync filters (error): "
                                                + captureIdAtStart);
                            } else {
                                clearVideoCaptureSyncBlocks(currentVideoPath);
                            }

                            // onRecordingError is the mutually-exclusive alternative to
                            // onRecordingStopped (exactly one fires per stop), so consume this
                            // recording's upload decision here too. Otherwise a USER_REQUESTED stop
                            // that already registered a webhook target would leak it (auth token
                            // included) and the planned upload would silently never run.
                            if (captureIdAtStart != null) {
                                uploadTargetsByCaptureId.remove(captureIdAtStart);
                            }

                            isRecordingVideo = false;

                            // Turn off RGB white LED on error (error path may not go through
                            // stopVideoRecording)
                            stopVideoRecordingLed();

                            // Turn off recording LED on error if it was enabled
                            if (enableFlash && hardwareManager.supportsRecordingLed()) {
                                hardwareManager.setRecordingLedOff();
                                Log.d(TAG, "Recording LED turned OFF (due to error)");
                            }

                            // Notify listener
                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(
                                        requestId,
                                        errorMessage,
                                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                            }

                            // Reset state
                            currentVideoId = null;
                            currentVideoPath = null;
                        }

                        @Override
                        public void onRecordingProgress(String videoId, long durationMs) {
                            // Optional: Track recording duration if needed
                            // Not notifying the listener for this event as it would be too noisy
                            Log.v(
                                    TAG,
                                    "Video recording progress: "
                                            + videoId
                                            + ", duration: "
                                            + durationMs
                                            + "ms");
                        }
                    });
        } catch (Exception e) {
            Log.e(TAG, "Error starting video recording", e);

            // Turn off RGB white LED if error occurred during start
            stopVideoRecordingLed();

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId,
                        "Error starting video: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }

            // Reset state on error
            clearVideoCaptureSyncBlocks(videoFilePath);
            currentVideoId = null;
            currentVideoPath = null;
        }
    }

    /** Stop the current video recording */
    /**
     * Stop video recording with specific reason.
     *
     * @param reason Why recording is stopping
     */
    private void stopVideoRecording(StopReason reason) {
        stopVideoRecording(reason, null, null);
    }

    /**
     * Stop video recording with a reason and an optional upload target.
     *
     * <p>The reason guard + {@code mCurrentStopReason} write are serialized under {@link #mStopLock}.
     * The upload target is registered only once the stop is actually dispatched to the recorder
     * (below the "not recording" guard), keyed by the recording's captureId via {@code putIfAbsent}
     * (first-stop-wins): only a {@code USER_REQUESTED} stop carries a webhook, and a stop already in
     * progress — or a user stop racing/following an auto-stop that already committed to "no upload" —
     * can't flip the outcome. The entry is consumed in {@code onRecordingStopped} and dropped on
     * every other terminal path ({@code onRecordingError}, the catch below, {@code cleanup}).
     *
     * @param reason Why recording is stopping
     * @param webhookUrl Upload target (USER_REQUESTED only); null/empty keeps the video on device
     * @param authToken Bearer token for the webhook upload
     */
    private void stopVideoRecording(StopReason reason, String webhookUrl, String authToken) {
        synchronized (mStopLock) {
            // Prevent recursive/concurrent stops
            if (mCurrentStopReason != null) {
                Log.w(
                        TAG,
                        "⚠️ stopVideoRecording already in progress (reason: "
                                + mCurrentStopReason
                                + "), ignoring call with reason: "
                                + reason);
                return;
            }

            mCurrentStopReason = reason;
        }
        Log.d(TAG, "🛑 Stopping video recording - Reason: " + reason);

        // captureId of the active recording: the key under which the upload decision is registered
        // (below, just before dispatch) and later consumed/removed. Read from the (volatile)
        // current path so it is published across the worker/callback/main threads.
        final String captureId = captureIdFromVideoAbsPath(currentVideoPath);

        try {
            // Stop battery monitoring first
            stopBatteryMonitoring();

            if (!isRecordingVideo || currentVideoId == null) {
                Log.w(TAG, "⚠️ Not currently recording, nothing to stop");
                // No dispatch → no camera callback → nothing was registered for this stop, so
                // there is nothing to leak (registration happens below, only on dispatch).
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
                    if (currentVideoSoundEnabled) {
                        playVideoStopSound();
                    }
                    break;

                case USER_REQUESTED:
                    Log.i(TAG, "👤 Video stopped by user request");
                    if (currentVideoSoundEnabled) {
                        playVideoStopSound();
                    }
                    break;

                case ERROR:
                    Log.e(TAG, "❌ Video stopped due to error");
                    // Error sound/handling already done
                    break;
            }

            stopVideoRecordingLed(); // Stop white LED when video recording stops

            // Bind the upload decision to this recording's captureId, first-stop-wins, only now that
            // the stop is actually being dispatched to the recorder — so an early-return above can
            // never orphan it. Only a USER_REQUESTED stop may upload; any auto-stop
            // (battery/max-duration/error) registers a "no upload" decision. putIfAbsent means a
            // later or racing stop (e.g. a user stop landing after an auto-stop already committed to
            // "no upload", once the stop-reason guard has reset) cannot flip the outcome. The entry
            // is consumed once in onRecordingStopped and dropped on every terminal path
            // (onRecordingError, the catch below, cleanup) so it can never leak.
            if (captureId != null) {
                UploadTarget target =
                        reason == StopReason.USER_REQUESTED
                                ? new UploadTarget(webhookUrl, authToken)
                                : new UploadTarget(null, null);
                uploadTargetsByCaptureId.putIfAbsent(captureId, target);
            }

            // Stop the recording via CameraNeoService
            CameraNeoService.stopVideoRecording(mContext, currentVideoId);

        } catch (Exception e) {
            Log.e(TAG, "Error stopping video recording", e);

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        currentVideoId,
                        "Error stopping video: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
            }

            // Reset state in case of error. No camera callback will fire after a failed dispatch,
            // so drop this recording's upload target here to mirror onRecordingStopped/onRecordingError.
            isRecordingVideo = false;
            currentVideoId = null;
            currentVideoPath = null;
            if (captureId != null) {
                uploadTargetsByCaptureId.remove(captureId);
            }

            // Ensure LED is turned off even if stop fails (if it was enabled)
            if (currentVideoLedEnabled && hardwareManager.supportsRecordingLed()) {
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF (stop error recovery)");
            }
        } finally {
            synchronized (mStopLock) {
                mCurrentStopReason = null; // Reset for next recording
            }
        }
    }

    /**
     * Stop video recording (public API for external callers). Maintains backward compatibility.
     * Note: Called from Bluetooth worker thread via command handlers - no thread assertion.
     */
    public void stopVideoRecording() {
        // No-webhook variant (button / power / toggle): no upload target.
        stopVideoRecording(StopReason.USER_REQUESTED, null, null);
    }

    /**
     * Stop the active recording and upload the result to {@code webhookUrl} via multipart, mirroring
     * the photo snapshot flow. The webhook URL + auth token are supplied at STOP time so the token
     * is fresh when the upload runs. An empty/null webhook keeps the video on device (no upload).
     */
    public void stopVideoRecording(String webhookUrl, String authToken) {
        stopVideoRecording(StopReason.USER_REQUESTED, webhookUrl, authToken);
    }

    /** Check if currently recording video */
    public boolean isRecordingVideo() {
        return isRecordingVideo;
    }

    /**
     * Get the capture directory name (e.g. "VID_20250322_120000_123") of the actively recording
     * video, or null if idle. Used by AsgCameraServer to exclude the entire capture group from
     * sync/download while recording is in progress.
     */
    public String getActiveRecordingCaptureId() {
        if (currentVideoPath == null) {
            return null;
        }
        return captureIdFromVideoAbsPath(currentVideoPath);
    }

    /**
     * Capture directory names excluded from Wi‑Fi sync/download: in-flight recordings (path created
     * through MediaRecorder prepare/start) and captures awaiting integrity validation.
     */
    public Set<String> getPendingVideoIntegrityCaptureIds() {
        Set<String> blocked = new HashSet<>();
        blocked.addAll(videoCaptureIdsInFlight);
        blocked.addAll(videoCaptureIdsPendingIntegrityCheck);
        return Collections.unmodifiableSet(blocked);
    }

    private void clearVideoCaptureSyncBlocks(String videoAbsPath) {
        String captureId = captureIdFromVideoAbsPath(videoAbsPath);
        if (captureId == null) {
            return;
        }
        videoCaptureIdsInFlight.remove(captureId);
        videoCaptureIdsPendingIntegrityCheck.remove(captureId);
        Log.d(TAG, "Video capture unblocked from sync filters: " + captureId);
    }

    private static String captureIdFromVideoAbsPath(String absolutePath) {
        if (absolutePath == null) {
            return null;
        }
        File f = new File(absolutePath);
        File parentDir = f.getParentFile();
        return parentDir != null ? parentDir.getName() : f.getName();
    }

    /**
     * Get the current recording duration in milliseconds
     *
     * @return Duration in milliseconds, or 0 if not recording
     */
    public long getRecordingDurationMs() {
        if (!isRecordingVideo || recordingStartTime == 0) {
            return 0;
        }

        return System.currentTimeMillis() - recordingStartTime;
    }

    /**
     * Takes a photo locally when offline or when server communication fails Uses default medium
     * size
     */
    public void takePhotoLocally() {
        takePhotoLocally("medium", false, false);
    }

    /**
     * Takes a photo locally with specified size
     *
     * @param size Photo size ("small", "medium", or "large")
     * @param enableFlash Whether to enable privacy flash LED
     * @param enableSound Whether to enable shutter sound
     */
    public void takePhotoLocally(String size, boolean enableFlash, boolean enableSound) {
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        if (ENABLE_PHOTO_TIMING_LOGS) {
            Log.i(TAG, "⏱️ [TIMING] LOCAL Photo request START");
        }

        // Check if any streaming is active - photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - streaming active");
            sendPhotoErrorResponse("local", "CAMERA_BUSY", "Camera busy with streaming");
            return;
        }

        // Check if camera HAL is restarting after FOV change
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse("local", "CAMERA_BUSY", "Camera restarting after FOV change");
            return;
        }

        // Check if video recording is active - photos cannot interrupt video recording
        if (isRecordingVideo) {
            Log.e(TAG, "Cannot take photo - video recording in progress");
            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        "local",
                        "Camera busy with video recording",
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
                    mMediaCaptureListener.onMediaError(
                            "local",
                            "Battery level too low ("
                                    + batteryLevel
                                    + "%) - minimum "
                                    + BatteryConstants.MIN_BATTERY_LEVEL
                                    + "% required",
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
                mMediaCaptureListener.onMediaError(
                        "local",
                        "Insufficient storage space for photo capture",
                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
            return;
        }

        // Note: No isCapturingPhoto guard here — button photos enqueue into QueuedPhotoRequestQueue
        // so rapid presses serialize through CameraNeoService burst reuse (not CAMERA_BUSY).

        // Add milliseconds and a random component to ensure uniqueness even in rapid capture
        String timeStamp =
                new SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(new Date());
        int randomSuffix = (int) (Math.random() * 1000);

        String captureDir = "IMG_" + timeStamp + "_" + randomSuffix;
        File captureDirFile = new File(fileManager.getDefaultMediaDirectory(), captureDir);
        captureDirFile.mkdirs();
        String photoFilePath = new File(captureDirFile, "base.jpg").getAbsolutePath();

        AsgSettings asgSettings = new AsgSettings(mContext);
        PhotoCaptureSettings captureSettings =
                PhotoCaptureSettings.mergeWithStoredDefaults(PhotoCaptureSettings.EMPTY, asgSettings);
        Boolean storedSound = asgSettings.getButtonPhotoSound();
        boolean effectiveSound = storedSound != null ? storedSound : enableSound;

        String storedCompress = asgSettings.getButtonPhotoCompress();
        String effectiveCompress = storedCompress != null ? storedCompress : "none";

        Log.i(
                TAG,
                "📸 take_photo (button/local) resolved params"
                        + " requestId="
                        + captureDir
                        + " size="
                        + size
                        + " compress="
                        + effectiveCompress
                        + " flash="
                        + enableFlash
                        + " sound="
                        + effectiveSound
                        + " save=true"
                        + " transferMethod=local"
                        + " exposureTimeNs=null"
                        + " iso=null"
                        + " captureTuning={"
                        + captureSettings.describeForLog()
                        + "}");
        Log.d(TAG, "Taking photo locally at: " + photoFilePath);

        // Log test configuration for debugging
        PhotoCaptureTestHooks.logTestConfig();

        // Button captures have no phone-originated requestId; the capture directory name is
        // their stable ID (it is what gallery sync exposes as capture_id), so status messages
        // carry it instead of a throwaway local_<timestamp> string.
        String requestId = captureDir;
        sendPhotoStatus(requestId, "queued");

        // TESTING: Check for fake camera initialization failure
        if (PhotoCaptureTestHooks.shouldFail("CAMERA_INIT")) {
            Log.e(TAG, "TESTING: Simulating camera initialization failure");
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            return;
        }

        // TESTING: Add fake delay for camera init
        PhotoCaptureTestHooks.addFakeDelay("CAMERA_INIT");

        // Skip sound and flash during camera HAL restart cooldown (e.g. after FOV change)
        if (!shouldSuppressPhotoFeedback()) {
            // RGB LED always flashes for photos (user visibility indicator)
            triggerPhotoFlashLed();
            if (effectiveSound) {
                // Button photo: isFromSdk=false, auto exposure (null) — matches the
                // enqueuePhotoRequest call below so the warm/cold prediction lines up.
                playShutterSound(size, false, null);
            }
            if (enableFlash) {
                flashPrivacyLedForPhoto(); // Flash privacy LED
            }
        }

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestHooks.shouldFail("CAMERA_CAPTURE")) {
            Log.e(TAG, "TESTING: Simulating camera capture failure");
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            return;
        }

        // TESTING: Add fake delay for camera capture
        PhotoCaptureTestHooks.addFakeDelay("CAMERA_CAPTURE");

        // Use the new enqueuePhotoRequest for thread-safe rapid capture
        // isFromSdk=false because this is a button-triggered photo (local storage, high quality)
        CameraNeoService.enqueuePhotoRequest(
                mContext,
                photoFilePath,
                size,
                enableFlash,
                false, // isFromSdk - button photo, use high quality resolution
                null, // exposureTimeNs — auto exposure for button photos
                null,
                captureSettings,
                new CameraNeoService.PhotoCaptureCallback() {
                    @Override
                    public void onPhotoConfigured(JSONObject resolvedConfig) {
                        sendPhotoStatus(
                                requestId,
                                "configuring",
                                addPhotoTransferDetails(
                                        resolvedConfig, true, "local", effectiveCompress),
                                null,
                                null);
                    }

                    @Override
                    public void onPhotoCapturing(
                            JSONObject requestedCaptureConfig, JSONObject meteredPreview) {
                        sendPhotoStatus(
                                requestId,
                                "capturing",
                                null,
                                null,
                                null,
                                requestedCaptureConfig,
                                meteredPreview,
                                null);
                    }

                    @Override
                    public void onPhotoCaptured(String filePath) {
                        onPhotoCaptured(filePath, null);
                    }

                    @Override
                    public void onPhotoCaptured(String filePath, JSONObject captureMetadata) {
                        // Calculate end-to-end timing from request to capture
                        long totalElapsedMs = System.currentTimeMillis() - requestStartTimeMs;
                        if (ENABLE_PHOTO_TIMING_LOGS) {
                            Log.i(
                                    TAG,
                                    "⏱️ [TIMING] LOCAL Photo CAPTURED in " + totalElapsedMs + "ms");
                        }

                        Log.d(TAG, "Local photo captured successfully at: " + filePath);
                        sendPhotoStatus(
                                requestId,
                                "captured",
                                null,
                                null,
                                null,
                                null,
                                null,
                                captureMetadata);

                        // LED is now managed by CameraNeoService and will turn off when camera
                        // closes

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
                        sendPhotoStatus(
                                requestId, "failed", null, "CAMERA_CAPTURE_FAILED", errorMessage);

                        // LED is now managed by CameraNeoService and will turn off when camera
                        // closes

                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onMediaError(
                                    requestId,
                                    errorMessage,
                                    MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                        }
                    }
                });
    }

    /**
     * Capture a photo that is only saved to the gallery: an SDK take_photo with save=true
     * and no upload target. There is no delivery leg (no webhook upload, no BLE transfer),
     * so this bypasses the single-flight photo-job gate and enqueues straight into the
     * camera queue, exactly like button photos — rapid bursts serialize at the camera
     * instead of failing CAMERA_BUSY. The terminal photo_response carries the captureId
     * (the requestId-stamped capture directory name) for sync-time correlation.
     */
    public boolean takePhotoForLocalSave(
            String photoFilePath,
            String requestId,
            String size,
            boolean enableFlash,
            boolean enableSound,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (captureSettings == null) {
            captureSettings = PhotoCaptureSettings.EMPTY;
        }

        // Photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take local-save photo - streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with streaming");
            return false;
        }

        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take local-save photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            return false;
        }

        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (!storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Local-save photo rejected - insufficient storage");
            playStorageFullSound();
            sendPhotoErrorResponse(
                    requestId,
                    "INSUFFICIENT_STORAGE",
                    "Insufficient storage space for photo capture");
            return false;
        }

        Log.i(
                TAG,
                "📸 take_photo (local-save) accepted requestId="
                        + requestId
                        + " size="
                        + size
                        + " path="
                        + photoFilePath);
        sendPhotoStatus(requestId, "queued");

        // The capture directory name is the stable capture_id exposed by gallery sync.
        File captureDirFile = new File(photoFilePath).getParentFile();
        final String captureId = captureDirFile != null ? captureDirFile.getName() : "";

        if (!shouldSuppressPhotoFeedback()) {
            triggerPhotoFlashLed();
            if (enableSound) {
                // Local-save SDK photo: isFromSdk=true, matching the enqueue below.
                playShutterSound(size, true, exposureTimeNs);
            }
            if (enableFlash) {
                flashPrivacyLedForPhoto();
            }
        }

        try {
            CameraNeoService.enqueuePhotoRequest(
                    mContext,
                    photoFilePath,
                    size,
                    enableFlash,
                    true, // isFromSdk — honor the SDK size tier
                    exposureTimeNs,
                    iso,
                    captureSettings,
                    new CameraNeoService.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoConfigured(JSONObject resolvedConfig) {
                            sendPhotoStatus(
                                    requestId,
                                    "configuring",
                                    addPhotoTransferDetails(resolvedConfig, true, "local", "none"),
                                    null,
                                    null);
                        }

                        @Override
                        public void onPhotoCapturing(
                                JSONObject requestedCaptureConfig, JSONObject meteredPreview) {
                            sendPhotoStatus(
                                    requestId,
                                    "capturing",
                                    null,
                                    null,
                                    null,
                                    requestedCaptureConfig,
                                    meteredPreview,
                                    null);
                        }

                        @Override
                        public void onPhotoCaptured(String filePath) {
                            onPhotoCaptured(filePath, null);
                        }

                        @Override
                        public void onPhotoCaptured(String filePath, JSONObject captureMetadata) {
                            Log.d(TAG, "Local-save photo captured: " + filePath);
                            sendPhotoStatus(
                                    requestId,
                                    "captured",
                                    null,
                                    null,
                                    null,
                                    null,
                                    null,
                                    captureMetadata);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                            }

                            sendLocalSaveSuccessResponse(requestId, captureId);
                            sendGalleryStatusUpdate();
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            Log.e(TAG, "Failed to capture local-save photo: " + errorMessage);
                            sendPhotoErrorResponse(
                                    requestId, "CAMERA_CAPTURE_FAILED", errorMessage);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(
                                        requestId,
                                        errorMessage,
                                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    });
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error taking local-save photo", e);
            sendPhotoErrorResponse(
                    requestId, "CAMERA_CAPTURE_FAILED", "Error taking photo: " + e.getMessage());
            return false;
        }
    }

    /**
     * Terminal success for a local-save capture: no uploadUrl (nothing was delivered);
     * carries the captureId so the caller can match the file at gallery-sync time.
     */
    private void sendLocalSaveSuccessResponse(String requestId, String captureId) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_response");
            json.put("requestId", requestId);
            json.put("state", "success");
            json.put("success", true);
            json.put("saved", true);
            json.put("captureId", captureId);
            json.put("timestamp", System.currentTimeMillis());

            Log.i(TAG, "📸 SENDING LOCAL-SAVE COMPLETE: requestId=" + requestId);

            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
                Log.i(TAG, "📸 SENT VIA BLE: " + json);
            } else {
                Log.e(TAG, "❌ Service callback not available for local-save photo response");
            }
        } catch (JSONException e) {
            Log.e(TAG, "❌ Error creating local-save photo response", e);
        }
    }

    /**
     * Take a photo and upload it to the specified destination
     *
     * @param photoFilePath Local path where photo will be saved
     * @param requestId Unique request ID for tracking
     * @param webhookUrl Optional webhook URL for direct upload to app
     * @param authToken Auth token for webhook authentication
     * @param save Whether to keep the photo on device after upload
     * @param size Photo size
     * @param enableFlash Whether to enable privacy flash LED
     * @param enableSound Whether to enable shutter sound
     * @param compress Compression level (none, medium, heavy)
     * @param exposureTimeNs optional sensor exposure time in nanoseconds for this capture only;
     *     {@code null} = auto
     * @param iso optional sensor sensitivity for manual exposure captures only; {@code null} =
     *     derive ISO from preview metering
     */
    public boolean takePhotoAndUpload(
            String photoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            boolean save,
            String size,
            boolean enableFlash,
            boolean enableSound,
            String compress,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (captureSettings == null) {
            captureSettings = PhotoCaptureSettings.EMPTY;
        }
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        recordTiming(requestId, "request_start");
        if (ENABLE_PHOTO_TIMING_LOGS) {
            Log.i(TAG, "⏱️ [TIMING] Photo request START - ID: " + requestId);
        }

        Log.d(
                TAG,
                "Taking photo and uploading to " + webhookUrl + " with compression: " + compress);

        // Check if any streaming is active - photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with streaming");
            return false;
        }

        // Check if camera HAL is restarting after FOV change
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            return false;
        }

        // Check battery level before proceeding
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(
                        requestId,
                        "BATTERY_LOW",
                        "Battery too low to take photo (" + batteryLevel + "%)");
                return false;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for photo upload");
        }

        // STORAGE CHECK: Reject if insufficient storage
        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (!storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Photo rejected - insufficient storage");
            playStorageFullSound();
            sendPhotoErrorResponse(
                    requestId,
                    "INSUFFICIENT_STORAGE",
                    "Insufficient storage space for photo capture");
            return false;
        }

        // Single-flight guard: reject if any photo job (capture or upload) is already in progress.
        // The flag stays set across capture → upload; cleared only at terminal exits below.
        if (!acquirePhotoJob(requestId)) {
            Log.w(TAG, "🚫 Photo job in flight - rejecting concurrent request: " + requestId);
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Another photo job is in progress");
            return false;
        }
        startCaptureSafetyTimeout(requestId);
        sendPhotoStatus(requestId, "accepted");

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
        sendPhotoStatus(requestId, "queued");

        // LED control is now handled by CameraNeoService tied to camera lifecycle

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestHooks.shouldFail("CAMERA_CAPTURE")) {
            releasePhotoJob(requestId);
            Log.e(TAG, "TESTING: Simulating camera capture failure");
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            return false;
        } else {
            Log.d(TAG, "Camera capture failure not simulated");
        }

        // TESTING: Add fake delay for camera capture
        PhotoCaptureTestHooks.addFakeDelay("CAMERA_CAPTURE");

        try {
            // Skip sound and flash during camera HAL restart cooldown (e.g. after FOV change)
            if (!shouldSuppressPhotoFeedback()) {
                triggerPhotoFlashLed();
                if (enableSound) {
                    // SDK photo: isFromSdk=true; size and exposure match the enqueuePhotoRequest
                    // call below so the warm/cold prediction lines up.
                    playShutterSound(size, true, exposureTimeNs);
                }
                if (enableFlash) {
                    flashPrivacyLedForPhoto();
                }
            }

            // Use the new enqueuePhotoRequest for thread-safe rapid capture
            // isFromSdk=true because this is an SDK-requested photo (take_photo command)
            recordTiming(requestId, "enqueue_camera");
            if (exposureTimeNs != null && exposureTimeNs > 0L) {
                Log.i(
                        TAG,
                        "Using manual exposure time right before picture request - ID: "
                                + requestId
                                + ", exposureTimeNs="
                                + exposureTimeNs
                                + " ns, iso="
                                + (iso != null ? iso : "auto"));
            }
            CameraNeoService.enqueuePhotoRequest(
                    mContext,
                    photoFilePath,
                    size,
                    enableFlash,
                    true, // isFromSdk - use optimized resolution for fast transfer
                    exposureTimeNs,
                    iso,
                    captureSettings,
                    new CameraNeoService.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoConfigured(JSONObject resolvedConfig) {
                            sendPhotoStatus(
                                    requestId,
                                    "configuring",
                                    addPhotoTransferDetails(
                                            resolvedConfig,
                                            save,
                                            webhookUrl != null && !webhookUrl.isEmpty()
                                                    ? "webhook"
                                                    : "local",
                                            compress),
                                    null,
                                    null);
                        }

                        @Override
                        public void onPhotoCapturing(
                                JSONObject requestedCaptureConfig, JSONObject meteredPreview) {
                            sendPhotoStatus(
                                    requestId,
                                    "capturing",
                                    null,
                                    null,
                                    null,
                                    requestedCaptureConfig,
                                    meteredPreview,
                                    null);
                        }

                        @Override
                        public void onPhotoCaptured(String filePath) {
                            onPhotoCaptured(filePath, null);
                        }

                        @Override
                        public void onPhotoCaptured(String filePath, JSONObject captureMetadata) {
                            // NOTE: do NOT clear isPhotoJobInFlight here — the job continues
                            // through the webhook upload phase below. Flag is cleared only at
                            // terminal exits inside uploadPhotoToWebhook (or its BLE fallback).
                            // Safety timeout stays armed to cover the upload phase too.
                            recordTiming(requestId, "photo_captured");

                            // Calculate end-to-end timing from request to capture
                            long totalElapsedMs = System.currentTimeMillis() - requestStartTimeMs;
                            if (ENABLE_PHOTO_TIMING_LOGS) {
                                Log.i(
                                        TAG,
                                        "⏱️ [TIMING] Photo CAPTURED in "
                                                + totalElapsedMs
                                                + "ms - ID: "
                                                + requestId);
                            }

                            Log.d(TAG, "Photo captured successfully at: " + filePath);
                            sendPhotoStatus(
                                    requestId,
                                    "captured",
                                    null,
                                    null,
                                    null,
                                    null,
                                    null,
                                    captureMetadata);

                            // LED is now managed by CameraNeoService and will turn off when camera
                            // closes

                            // Notify that we've captured the photo
                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                                mMediaCaptureListener.onPhotoUploading(requestId);
                            }

                            // Choose upload destination based on webhookUrl
                            if (webhookUrl != null && !webhookUrl.isEmpty()) {
                                // Upload directly to app webhook
                                recordTiming(requestId, "upload_start");
                                uploadPhotoToWebhook(
                                        filePath, requestId, webhookUrl, authToken, compress);
                            } else {
                                // No webhook → no upload phase to run. Job ends here.
                                sendPhotoSuccessResponse(requestId, "");
                                releasePhotoJob(requestId);
                            }
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            releasePhotoJob(requestId);

                            Log.e(TAG, "Failed to capture photo: " + errorMessage);
                            sendPhotoErrorResponse(
                                    requestId, "CAMERA_CAPTURE_FAILED", errorMessage);

                            // LED is now managed by CameraNeoService and will turn off when camera
                            // closes

                            dumpTimings(requestId);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(
                                        requestId,
                                        errorMessage,
                                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    });
            return true;
        } catch (Exception e) {
            releasePhotoJob(requestId);
            Log.e(TAG, "Error taking photo", e);
            sendPhotoErrorResponse(
                    requestId, "CAMERA_CAPTURE_FAILED", "Error taking photo: " + e.getMessage());

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId,
                        "Error taking photo: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
            return false;
        }
    }

    /**
     * Check if a photo job (capture or upload/BLE-handoff) is currently in progress. Used to reject
     * concurrent SDK photo requests with CAMERA_BUSY.
     */
    public boolean isPhotoJobInFlight() {
        return activePhotoJobRequestId.get() != null;
    }

    private boolean acquirePhotoJob(String requestId) {
        return activePhotoJobRequestId.compareAndSet(null, requestId);
    }

    private void releasePhotoJob(String requestId) {
        if (activePhotoJobRequestId.compareAndSet(requestId, null)) {
            cancelCaptureSafetyTimeout(requestId);
        } else {
            Log.w(
                    TAG,
                    "Ignoring stale photo job release for "
                            + requestId
                            + "; active job is "
                            + activePhotoJobRequestId.get());
        }
    }

    /**
     * Start the photo-job safety timeout. If no terminal callback fires (e.g., CameraNeo crashes,
     * lock timeout, upload thread dies), force-reset isPhotoJobInFlight after
     * CAPTURE_SAFETY_TIMEOUT_MS to prevent permanent lockout. Sized to outlast a slow webhook
     * upload.
     */
    private void startCaptureSafetyTimeout(String requestId) {
        Runnable timeout =
                new Runnable() {
                    @Override
                    public void run() {
                        if (!activePhotoJobRequestId.compareAndSet(requestId, null)) {
                            return;
                        }
                        synchronized (captureSafetyTimeoutLock) {
                            if (captureSafetyTimeout == this) {
                                captureSafetyTimeout = null;
                                captureSafetyTimeoutRequestId = null;
                            }
                        }
                        Log.e(
                                TAG,
                                "⚠️ SAFETY TIMEOUT: isPhotoJobInFlight force-reset after "
                                        + CAPTURE_SAFETY_TIMEOUT_MS
                                        + "ms - no terminal callback fired for "
                                        + requestId);
                        dumpTimings(requestId);
                        sendPhotoErrorResponse(
                                requestId,
                                "CAPTURE_TIMEOUT",
                                "Photo job timed out on glasses - no terminal callback fired");
                    }
                };
        synchronized (captureSafetyTimeoutLock) {
            captureSafetyTimeout = timeout;
            captureSafetyTimeoutRequestId = requestId;
        }
        mainHandler.postDelayed(timeout, CAPTURE_SAFETY_TIMEOUT_MS);
    }

    /** Cancel the capture safety timeout (called when callback fires normally). */
    private void cancelCaptureSafetyTimeout(String requestId) {
        synchronized (captureSafetyTimeoutLock) {
            if (captureSafetyTimeout != null && requestId.equals(captureSafetyTimeoutRequestId)) {
                mainHandler.removeCallbacks(captureSafetyTimeout);
                captureSafetyTimeout = null;
                captureSafetyTimeoutRequestId = null;
            }
        }
    }

    /**
     * Record a timing checkpoint for a photo request. No-op if ENABLE_PHOTO_TIMING_LOGS is false.
     */
    private void recordTiming(String requestId, String phase) {
        if (!ENABLE_PHOTO_TIMING_LOGS) return;
        photoTimings
                .computeIfAbsent(requestId, k -> new java.util.LinkedHashMap<>())
                .put(phase, System.currentTimeMillis());
    }

    /**
     * Dump all recorded timings for a photo request and clean up. Shows cumulative time from start
     * and delta between each phase. No-op if ENABLE_PHOTO_TIMING_LOGS is false.
     */
    private void dumpTimings(String requestId) {
        if (!ENABLE_PHOTO_TIMING_LOGS) return;
        Map<String, Long> timings = photoTimings.remove(requestId);
        if (timings == null || timings.isEmpty()) return;

        StringBuilder sb = new StringBuilder();
        sb.append("⏱️ [TIMING] Request ").append(requestId).append(" phases:\n");
        long firstTime = 0;
        long prevTime = 0;
        for (Map.Entry<String, Long> entry : timings.entrySet()) {
            long time = entry.getValue();
            if (firstTime == 0) {
                firstTime = time;
                prevTime = time;
            }
            sb.append("  ")
                    .append(entry.getKey())
                    .append(": +")
                    .append(time - firstTime)
                    .append("ms")
                    .append(" (delta: ")
                    .append(time - prevTime)
                    .append("ms)\n");
            prevTime = time;
        }
        sb.append("  TOTAL: ").append(prevTime - firstTime).append("ms");
        Log.i(TAG, sb.toString());
    }

    private void tracePhotoWifiRoute(
            String requestId, String route, String reason, String webhookUrl, File photoFile) {
        JSONObject payload = createPhotoWifiPayload(requestId, webhookUrl, photoFile);
        putJson(payload, "route", route);
        putJson(payload, "reason", reason);
        putJson(payload, "timestampMs", System.currentTimeMillis());
        logPhotoWifiTrace("glasses_network", "wifi_route", "photo_upload_route", payload);
    }

    private void tracePhotoUploadStart(
            String requestId,
            String webhookUrl,
            File photoFile,
            boolean hasAuthToken,
            long startMs) {
        JSONObject payload = createPhotoWifiPayload(requestId, webhookUrl, photoFile);
        putJson(payload, "bearerHeaderPresent", hasAuthToken);
        putJson(payload, "startMs", startMs);
        logPhotoWifiTrace("glasses_to_wifi", "wifi_http_output", "photo_upload_start", payload);
    }

    private void tracePhotoUploadEnd(
            String requestId,
            String webhookUrl,
            File photoFile,
            long startMs,
            long endMs,
            int statusCode,
            boolean success,
            String outcome) {
        JSONObject payload = createPhotoWifiPayload(requestId, webhookUrl, photoFile);
        putJson(payload, "startMs", startMs);
        putJson(payload, "endMs", endMs);
        putJson(payload, "durationMs", endMs - startMs);
        putJson(payload, "statusCode", statusCode);
        putJson(payload, "success", success);
        putJson(payload, "outcome", outcome);
        logPhotoWifiTrace("wifi_to_glasses", "wifi_http_input", "photo_upload_end", payload);
    }

    private void tracePhotoUploadError(
            String requestId,
            String webhookUrl,
            File photoFile,
            long startMs,
            Exception error,
            String outcome) {
        long endMs = System.currentTimeMillis();
        JSONObject payload = createPhotoWifiPayload(requestId, webhookUrl, photoFile);
        if (startMs > 0) {
            putJson(payload, "startMs", startMs);
            putJson(payload, "durationMs", endMs - startMs);
        }
        putJson(payload, "endMs", endMs);
        putJson(payload, "success", false);
        putJson(payload, "outcome", outcome);
        if (error != null) {
            putJson(payload, "errorClass", error.getClass().getSimpleName());
            putJson(payload, "errorMessage", error.getMessage());
        }
        logPhotoWifiTrace("wifi_to_glasses", "wifi_http_input", "photo_upload_error", payload);
    }

    private void tracePhotoUploadFallback(
            String requestId, String webhookUrl, File photoFile, String reason, String bleImgId) {
        JSONObject payload = createPhotoWifiPayload(requestId, webhookUrl, photoFile);
        putJson(payload, "fallback", "ble");
        putJson(payload, "reason", reason);
        putJson(payload, "hasBleImageId", bleImgId != null && !bleImgId.isEmpty());
        putJson(payload, "timestampMs", System.currentTimeMillis());
        logPhotoWifiTrace("glasses_network", "wifi_route", "photo_upload_fallback", payload);
    }

    private JSONObject createPhotoWifiPayload(String requestId, String webhookUrl, File photoFile) {
        JSONObject payload = new JSONObject();
        putJson(payload, "requestId", requestId);
        if (photoFile != null) {
            putJson(payload, "fileName", photoFile.getName());
            putJson(payload, "fileExists", photoFile.exists());
            putJson(payload, "fileBytes", photoFile.exists() ? photoFile.length() : 0);
        }
        putWebhookSummary(payload, webhookUrl);
        putActiveNetworkSummary(payload);
        return payload;
    }

    private void putWebhookSummary(JSONObject payload, String webhookUrl) {
        if (webhookUrl == null || webhookUrl.isEmpty()) {
            return;
        }

        try {
            URI uri = URI.create(webhookUrl);
            putJson(payload, "urlScheme", uri.getScheme());
            putJson(payload, "urlHost", uri.getHost());
            if (uri.getPort() != -1) {
                putJson(payload, "urlPort", uri.getPort());
            }
            String path = uri.getRawPath();
            putJson(payload, "urlPath", path == null || path.isEmpty() ? "/" : path);
            putJson(
                    payload,
                    "urlHasQuery",
                    uri.getRawQuery() != null && !uri.getRawQuery().isEmpty());
        } catch (Exception e) {
            putJson(payload, "urlParseError", e.getClass().getSimpleName());
        }
    }

    private void putActiveNetworkSummary(JSONObject payload) {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) mContext.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) {
                putJson(payload, "networkAvailable", false);
                return;
            }

            android.net.Network activeNetwork = cm.getActiveNetwork();
            if (activeNetwork == null) {
                putJson(payload, "networkAvailable", false);
                return;
            }

            NetworkCapabilities caps = cm.getNetworkCapabilities(activeNetwork);
            if (caps == null) {
                putJson(payload, "networkAvailable", true);
                putJson(payload, "networkCapabilitiesAvailable", false);
                return;
            }

            putJson(payload, "networkAvailable", true);
            putJson(
                    payload,
                    "wifiConnected",
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
            putJson(
                    payload,
                    "cellularConnected",
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
            putJson(
                    payload,
                    "internetCapable",
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
            putJson(
                    payload,
                    "internetValidated",
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        } catch (Exception e) {
            putJson(payload, "networkSummaryError", e.getClass().getSimpleName());
        }
    }

    private void putJson(JSONObject payload, String key, Object value) {
        if (payload == null || key == null || value == null) {
            return;
        }
        try {
            payload.put(key, value);
        } catch (JSONException ignored) {
            // Keep trace logging non-fatal.
        }
    }

    private void logPhotoWifiTrace(
            String direction, String layer, String type, JSONObject payload) {
        try {
            BleTraceLogger.logEvent(direction, layer, type, payload);
        } catch (Exception e) {
            Log.w(TAG, "Failed to write WiFi trace log", e);
        }
    }

    /** Upload photo directly to app webhook */
    private void uploadPhotoToWebhook(
            String photoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            String compress) {
        // TESTING: Check for fake upload failure
        if (PhotoCaptureTestHooks.shouldFail("UPLOAD")) {
            releasePhotoJob(requestId);
            Log.e(TAG, "TESTING: Simulating upload failure");
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            return;
        }

        // TESTING: Add fake delay for upload
        PhotoCaptureTestHooks.addFakeDelay("UPLOAD");

        // isPhotoJobInFlight is already true from takePhotoAndUpload entry; the job continues
        // through the upload phase and is cleared at terminal exits in performDirectUpload
        // (success, no-fallback failure, no-fallback exception) or by the BLE handoff path
        // when a fallback runs.
        recordTiming(requestId, "webhook_upload_begin");
        sendPhotoStatus(requestId, "uploading");
        Log.d(TAG, "📤 Starting upload for: " + requestId);

        // Process upload based on SDK compression setting
        processUploadWithCompression(photoFilePath, requestId, webhookUrl, authToken, compress);
    }

    /** Process upload with compression based on SDK setting */
    private void processUploadWithCompression(
            String photoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            String compress) {
        Log.d(TAG, "📸 Processing photo upload with SDK compression setting: " + compress);

        // Check SDK compression setting
        if ("none".equals(compress) || compress == null || compress.isEmpty()) {
            Log.d(TAG, "📸 No compression requested - uploading original image");
            performDirectUpload(photoFilePath, requestId, webhookUrl, authToken);
        } else {
            Log.d(TAG, "🗜️ Compression requested - applying SDK compression setting: " + compress);
            sendPhotoStatus(requestId, "compressing");

            compressImageForUpload(photoFilePath, requestId, webhookUrl, authToken, compress);
        }
    }

    /** Compress image based on SDK compression level */
    private void compressImageForUpload(
            String originalPath,
            String requestId,
            String webhookUrl,
            String authToken,
            String compress) {
        new Thread(
                        () -> {
                            try {
                                Log.d(
                                        TAG,
                                        "🗜️ Starting image compression for "
                                                + compress
                                                + " level");
                                long compressionStartTime = System.currentTimeMillis();

                                // Load original image
                                android.graphics.Bitmap original =
                                        android.graphics.BitmapFactory.decodeFile(originalPath);
                                if (original == null) {
                                    Log.e(TAG, "❌ Failed to load original image for compression");
                                    performDirectUpload(
                                            originalPath, requestId, webhookUrl, authToken);
                                    return;
                                }

                                // Calculate compression parameters based on SDK compression level
                                int originalWidth = original.getWidth();
                                int originalHeight = original.getHeight();
                                Log.d(
                                        TAG,
                                        "📐 Original image dimensions: "
                                                + originalWidth
                                                + "x"
                                                + originalHeight);

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
                                int compressedWidth = (int) (originalWidth * compressionRatio);
                                int compressedHeight = (int) (originalHeight * compressionRatio);

                                // Maintain aspect ratio
                                float aspectRatio = (float) originalWidth / originalHeight;
                                if (aspectRatio > 1) {
                                    compressedHeight = (int) (compressedWidth / aspectRatio);
                                } else {
                                    compressedWidth = (int) (compressedHeight * aspectRatio);
                                }

                                Log.d(
                                        TAG,
                                        "📐 Compressed image dimensions: "
                                                + compressedWidth
                                                + "x"
                                                + compressedHeight);

                                // Create compressed bitmap
                                android.graphics.Bitmap compressed =
                                        android.graphics.Bitmap.createScaledBitmap(
                                                original, compressedWidth, compressedHeight, true);
                                original.recycle();

                                // Save compressed image to temporary file
                                String compressedPath =
                                        originalPath.replace(
                                                ".jpg", "_compressed_" + compress + ".jpg");
                                FileOutputStream fos = new FileOutputStream(compressedPath);
                                compressed.compress(
                                        android.graphics.Bitmap.CompressFormat.JPEG,
                                        jpegQuality,
                                        fos);
                                fos.close();
                                compressed.recycle();

                                PhotoExifMetadataWriter.copyImuMetadata(
                                        originalPath, compressedPath);

                                long compressionDuration =
                                        System.currentTimeMillis() - compressionStartTime;
                                Log.d(
                                        TAG,
                                        "⏱️ Image compression completed in: "
                                                + compressionDuration
                                                + "ms");
                                Log.d(TAG, "✅ Compressed image saved: " + compressedPath);

                                // Calculate compression ratio achieved
                                File originalFile = new File(originalPath);
                                File compressedFile = new File(compressedPath);
                                long originalSize = originalFile.length();
                                long compressedSize = compressedFile.length();
                                float sizeReduction =
                                        ((float) (originalSize - compressedSize) / originalSize)
                                                * 100;

                                Log.d(TAG, "📊 Compression stats:");
                                Log.d(TAG, "📊 Original size: " + originalSize + " bytes");
                                Log.d(TAG, "📊 Compressed size: " + compressedSize + " bytes");
                                Log.d(
                                        TAG,
                                        "📊 Size reduction: "
                                                + String.format("%.1f", sizeReduction)
                                                + "%");

                                // Upload compressed version
                                performDirectUpload(
                                        compressedPath, requestId, webhookUrl, authToken);

                                // Clean up compressed file after upload
                                new File(compressedPath).deleteOnExit();

                            } catch (Exception e) {
                                Log.e(
                                        TAG,
                                        "❌ Error compressing image, falling back to original: "
                                                + e.getMessage());
                                performDirectUpload(originalPath, requestId, webhookUrl, authToken);
                            }
                        })
                .start();
    }

    /** Compress image for poor connection scenarios (legacy method - kept for compatibility) */
    private void compressImageForPoorConnection(
            String originalPath, String requestId, String webhookUrl, String authToken) {
        new Thread(
                        () -> {
                            try {
                                Log.d(
                                        TAG,
                                        "🗜️ Compressing image for poor connection: "
                                                + originalPath);
                                long compressionStartTime = System.currentTimeMillis();

                                // Load original image
                                android.graphics.Bitmap original =
                                        android.graphics.BitmapFactory.decodeFile(originalPath);
                                if (original == null) {
                                    Log.e(TAG, "❌ Failed to load original image for compression");
                                    performDirectUpload(
                                            originalPath, requestId, webhookUrl, authToken);
                                    return;
                                }

                                // Calculate compression parameters for poor connection
                                int originalWidth = original.getWidth();
                                int originalHeight = original.getHeight();
                                Log.d(
                                        TAG,
                                        "📐 Original image dimensions: "
                                                + originalWidth
                                                + "x"
                                                + originalHeight);

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

                                Log.d(
                                        TAG,
                                        "📐 Compressed image dimensions: "
                                                + compressedWidth
                                                + "x"
                                                + compressedHeight);

                                // Create compressed bitmap
                                android.graphics.Bitmap compressed =
                                        android.graphics.Bitmap.createScaledBitmap(
                                                original, compressedWidth, compressedHeight, true);
                                original.recycle();

                                // Save compressed image to temporary file
                                String compressedPath =
                                        originalPath.replace(".jpg", "_compressed.jpg");
                                FileOutputStream fos = new FileOutputStream(compressedPath);
                                compressed.compress(
                                        android.graphics.Bitmap.CompressFormat.JPEG,
                                        60,
                                        fos); // 60% quality
                                fos.close();
                                compressed.recycle();

                                PhotoExifMetadataWriter.copyImuMetadata(
                                        originalPath, compressedPath);

                                long compressionDuration =
                                        System.currentTimeMillis() - compressionStartTime;
                                Log.d(
                                        TAG,
                                        "⏱️ Image compression completed in: "
                                                + compressionDuration
                                                + "ms");
                                Log.d(
                                        TAG,
                                        "✅ Image compressed for poor connection: "
                                                + compressedPath);

                                // Upload compressed version
                                performDirectUpload(
                                        compressedPath, requestId, webhookUrl, authToken);

                                // Clean up compressed file after upload
                                new File(compressedPath).deleteOnExit();

                            } catch (Exception e) {
                                Log.e(
                                        TAG,
                                        "❌ Error compressing image, falling back to original: "
                                                + e.getMessage());
                                performDirectUpload(originalPath, requestId, webhookUrl, authToken);
                            }
                        })
                .start();
    }

    /** Perform the actual upload operation */
    private void performDirectUpload(
            String photoFilePath, String requestId, String webhookUrl, String authToken) {
        Log.d(TAG, "📤 Starting direct upload operation");
        Log.d(TAG, "📸 Upload file: " + photoFilePath);
        Log.d(TAG, "🆔 Request ID: " + requestId);

        // Create a new thread for the upload
        new Thread(
                        () -> {
                            recordTiming(requestId, "direct_upload_thread_start");
                            File photoFile = new File(photoFilePath);
                            long uploadStartTime = 0;
                            try {
                                if (!photoFile.exists()) {
                                    Log.e(TAG, "❌ Photo file does not exist: " + photoFilePath);
                                    String errorMessage = "Photo file not found";
                                    tracePhotoUploadError(
                                            requestId,
                                            webhookUrl,
                                            photoFile,
                                            uploadStartTime,
                                            new IllegalStateException(errorMessage),
                                            "file_missing");
                                    sendPhotoErrorResponse(
                                            requestId, "PHOTO_FILE_NOT_FOUND", errorMessage);
                                    photoSaveFlags.remove(requestId);
                                    photoBleIds.remove(requestId);
                                    photoOriginalPaths.remove(requestId);
                                    photoRequestedSizes.remove(requestId);
                                    releasePhotoJob(requestId);
                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onMediaError(
                                                requestId,
                                                errorMessage,
                                                MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                                    }
                                    return;
                                }

                                Log.d(TAG, "📊 Photo file size: " + photoFile.length() + " bytes");
                                Log.d(TAG, "🌐 Sending photo request to: " + webhookUrl);

                                // Large photos need generous write/call timeouts after a socket
                                // connects. Keep connect short so unreachable receivers fall back
                                // to BLE without waiting through a body-transfer-sized timeout.
                                long minThroughputBytesPerSec = 64L * 1024L; // ~0.5 Mbps floor
                                long callTimeoutSeconds =
                                        30L + (photoFile.length() / minThroughputBytesPerSec);
                                OkHttpClient client =
                                        new OkHttpClient.Builder()
                                                .connectTimeout(
                                                        5, java.util.concurrent.TimeUnit.SECONDS)
                                                .writeTimeout(
                                                        60, java.util.concurrent.TimeUnit.SECONDS)
                                                .readTimeout(
                                                        10, java.util.concurrent.TimeUnit.SECONDS)
                                                .callTimeout(
                                                        callTimeoutSeconds,
                                                        java.util.concurrent.TimeUnit.SECONDS)
                                                .build();

                                RequestBody fileBody =
                                        RequestBody.create(
                                                okhttp3.MediaType.parse("image/jpeg"), photoFile);
                                RequestBody requestBody =
                                        new MultipartBody.Builder()
                                                .setType(MultipartBody.FORM)
                                                .addFormDataPart(
                                                        "photo", photoFile.getName(), fileBody)
                                                .addFormDataPart("requestId", requestId)
                                                .addFormDataPart("type", "photo_upload")
                                                .addFormDataPart("success", "true")
                                                .build();

                                // Build request with optional Authorization header
                                Request.Builder requestBuilder =
                                        new Request.Builder().url(webhookUrl).post(requestBody);

                                // Add Authorization header if auth token is available
                                boolean hasAuthToken = authToken != null && !authToken.isEmpty();
                                if (hasAuthToken) {
                                    requestBuilder.header("Authorization", "Bearer " + authToken);
                                    Log.d(TAG, "🔐 Adding Authorization header to webhook request");
                                } else {
                                    Log.d(TAG, "⚠️ No auth token available for webhook request");
                                }

                                Request request = requestBuilder.build();
                                Log.d(TAG, "🚀 Executing HTTP request...");

                                uploadStartTime = System.currentTimeMillis();
                                tracePhotoUploadStart(
                                        requestId,
                                        webhookUrl,
                                        photoFile,
                                        hasAuthToken,
                                        uploadStartTime);
                                Response response = client.newCall(request).execute();
                                long uploadEndTime = System.currentTimeMillis();
                                long uploadTime = uploadEndTime - uploadStartTime;
                                recordTiming(requestId, "direct_upload_response");

                                Log.d(TAG, "⏱️ Upload completed in: " + uploadTime + "ms");
                                Log.d(TAG, "📈 Response code: " + response.code());

                                if (response.isSuccessful()) {
                                    tracePhotoUploadEnd(
                                            requestId,
                                            webhookUrl,
                                            photoFile,
                                            uploadStartTime,
                                            uploadEndTime,
                                            response.code(),
                                            true,
                                            "uploaded");
                                    recordTiming(requestId, "upload_success");
                                    dumpTimings(requestId);
                                    sendPhotoStatus(requestId, "uploaded");
                                    String responseBody =
                                            response.body() != null ? response.body().string() : "";
                                    Log.d(TAG, "✅ Photo uploaded successfully to webhook");
                                    Log.d(TAG, "📄 Response body: " + responseBody);

                                    // Check if we should save the photo
                                    Boolean save = photoSaveFlags.get(requestId);
                                    if (save == null || !save) {
                                        // Delete the photo file to save storage
                                        try {
                                            if (photoFile.delete()) {
                                                Log.d(
                                                        TAG,
                                                        "🗑️ Deleted photo file after successful upload");
                                            } else {
                                                Log.w(TAG, "⚠️ Failed to delete photo file");
                                            }
                                        } catch (Exception e) {
                                            Log.e(
                                                    TAG,
                                                    "❌ Error deleting photo file after upload",
                                                    e);
                                        }
                                    } else {
                                        Log.d(TAG, "💾 Keeping photo file as requested");
                                    }

                                    // Clean up the flag
                                    photoSaveFlags.remove(requestId);
                                    photoRequestedSizes.remove(requestId);

                                    // Notify success
                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onPhotoUploaded(
                                                requestId, webhookUrl);
                                    }
                                    sendPhotoSuccessResponse(requestId, webhookUrl, responseBody);

                                    // Terminal success — release the photo job.
                                    releasePhotoJob(requestId);
                                    Log.d(
                                            TAG,
                                            "✅ Photo job complete - system available: "
                                                    + requestId);
                                } else {
                                    String errorMessage =
                                            "Upload failed with status: " + response.code();
                                    Log.e(TAG, "❌ " + errorMessage + " to webhook: " + webhookUrl);

                                    // Check if we can fallback to BLE
                                    recordTiming(requestId, "upload_failed_ble_fallback");
                                    String bleImgId = photoBleIds.get(requestId);
                                    tracePhotoUploadEnd(
                                            requestId,
                                            webhookUrl,
                                            photoFile,
                                            uploadStartTime,
                                            uploadEndTime,
                                            response.code(),
                                            false,
                                            bleImgId != null ? "ble_fallback" : "http_failed");
                                    if (bleImgId != null) {
                                        Log.d(
                                                TAG,
                                                "📱 Webhook upload failed, attempting BLE fallback");
                                        Log.d(TAG, "🔄 BLE Image ID: " + bleImgId);
                                        tracePhotoUploadFallback(
                                                requestId,
                                                webhookUrl,
                                                photoFile,
                                                "http_status_" + response.code(),
                                                bleImgId);

                                        // Clean up tracking (will be re-added by BLE transfer)
                                        photoBleIds.remove(requestId);
                                        photoOriginalPaths.remove(requestId);

                                        // Trigger BLE fallback - reuse the existing photo instead
                                        // of taking a new one
                                        boolean shouldSave =
                                                Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                                        String requestedSize = photoRequestedSizes.get(requestId);
                                        if (requestedSize == null || requestedSize.isEmpty())
                                            requestedSize = "medium";
                                        // Reuse the existing photo file that was already captured
                                        Log.d(TAG, "♻️ Reusing existing photo for BLE transfer");

                                        // Job continues into BLE fallback — do NOT clear
                                        // isPhotoJobInFlight here.
                                        // compressAndSendViaBle's finally block owns the clear
                                        // after handoff.
                                        Log.d(
                                                TAG,
                                                "🔄 Webhook failed, handing off to BLE transfer: "
                                                        + requestId);
                                        response.close();
                                        reusePhotoForBleTransfer(
                                                photoFilePath,
                                                requestId,
                                                bleImgId,
                                                shouldSave,
                                                requestedSize);
                                        return; // Exit early - BLE transfer will handle cleanup
                                    }

                                    // No BLE fallback available
                                    dumpTimings(requestId);
                                    sendPhotoErrorResponse(
                                            requestId,
                                            "UPLOAD_FAILED",
                                            errorMessage);
                                    Log.d(
                                            TAG,
                                            "❌ No BLE fallback available, handling as normal failure");

                                    // Check if we should save the photo
                                    Boolean save = photoSaveFlags.get(requestId);
                                    if (save == null || !save) {
                                        // Delete the photo file on failure
                                        try {
                                            if (photoFile.delete()) {
                                                Log.d(
                                                        TAG,
                                                        "🗑️ Deleted photo file after failed upload");
                                            } else {
                                                Log.w(TAG, "⚠️ Failed to delete photo file");
                                            }
                                        } catch (Exception e) {
                                            Log.e(
                                                    TAG,
                                                    "❌ Error deleting photo file after failed upload",
                                                    e);
                                        }
                                    } else {
                                        Log.d(
                                                TAG,
                                                "💾 Keeping photo file despite failed upload as requested");
                                    }

                                    // Clean up tracking
                                    photoSaveFlags.remove(requestId);
                                    photoBleIds.remove(requestId);
                                    photoOriginalPaths.remove(requestId);
                                    photoRequestedSizes.remove(requestId);

                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onMediaError(
                                                requestId,
                                                errorMessage,
                                                MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                                    }

                                    // Terminal failure (no BLE fallback) — release the photo job.
                                    releasePhotoJob(requestId);
                                    Log.d(
                                            TAG,
                                            "❌ Photo job failed - system available: " + requestId);
                                }

                                response.close();

                            } catch (Exception e) {
                                Log.e(TAG, "❌ Error uploading photo to webhook: " + e.getMessage());
                                Log.e(TAG, "❌ Exception type: " + e.getClass().getSimpleName());

                                // Check if we can fallback to BLE on exception
                                recordTiming(requestId, "upload_exception_ble_fallback");
                                String bleImgId = photoBleIds.get(requestId);
                                tracePhotoUploadError(
                                        requestId,
                                        webhookUrl,
                                        photoFile,
                                        uploadStartTime,
                                        e,
                                        bleImgId != null ? "ble_fallback" : "upload_exception");
                                if (bleImgId != null) {
                                    Log.d(
                                            TAG,
                                            "📱 Webhook upload exception, attempting BLE fallback");
                                    Log.d(TAG, "🔄 BLE Image ID: " + bleImgId);
                                    tracePhotoUploadFallback(
                                            requestId,
                                            webhookUrl,
                                            photoFile,
                                            "exception",
                                            bleImgId);

                                    // Clean up tracking (will be re-added by BLE transfer)
                                    photoBleIds.remove(requestId);
                                    photoOriginalPaths.remove(requestId);

                                    // Trigger BLE fallback - reuse the existing photo instead of
                                    // taking a new one
                                    boolean shouldSaveFallback1 =
                                            Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                                    String requestedSizeFallback1 =
                                            photoRequestedSizes.get(requestId);
                                    if (requestedSizeFallback1 == null
                                            || requestedSizeFallback1.isEmpty())
                                        requestedSizeFallback1 = "medium";
                                    // Reuse the existing photo file that was already captured
                                    Log.d(TAG, "♻️ Reusing existing photo for BLE transfer");

                                    // Job continues into BLE fallback — do NOT clear
                                    // isPhotoJobInFlight here.
                                    // compressAndSendViaBle's finally block owns the clear after
                                    // handoff.
                                    Log.d(
                                            TAG,
                                            "🔄 Webhook exception, handing off to BLE transfer: "
                                                    + requestId);
                                    reusePhotoForBleTransfer(
                                            photoFilePath,
                                            requestId,
                                            bleImgId,
                                            shouldSaveFallback1,
                                            requestedSizeFallback1);
                                    return; // Exit early - BLE transfer will handle cleanup
                                }

                                // No BLE fallback available
                                Log.d(TAG, "❌ No BLE fallback available, handling exception");
                                sendPhotoErrorResponse(
                                        requestId,
                                        "UPLOAD_FAILED",
                                        "Upload error: " + e.getMessage());

                                // Check if we should save the photo on exception
                                Boolean save = photoSaveFlags.get(requestId);
                                if (save == null || !save) {
                                    // Delete the photo file on exception
                                    try {
                                        if (photoFile.exists() && photoFile.delete()) {
                                            Log.d(
                                                    TAG,
                                                    "🗑️ Deleted photo file after webhook upload exception");
                                        } else {
                                            Log.w(TAG, "⚠️ Failed to delete photo file");
                                        }
                                    } catch (Exception deleteEx) {
                                        Log.e(
                                                TAG,
                                                "❌ Error deleting photo file after webhook upload exception",
                                                deleteEx);
                                    }
                                } else {
                                    Log.d(
                                            TAG,
                                            "💾 Keeping photo file despite upload exception as requested");
                                }

                                // Clean up tracking
                                photoSaveFlags.remove(requestId);
                                photoBleIds.remove(requestId);
                                photoOriginalPaths.remove(requestId);
                                photoRequestedSizes.remove(requestId);

                                if (mMediaCaptureListener != null) {
                                    mMediaCaptureListener.onMediaError(
                                            requestId,
                                            "Upload error: " + e.getMessage(),
                                            MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                                }

                                // Terminal exception (no BLE fallback) — release the photo job.
                                releasePhotoJob(requestId);
                                Log.d(
                                        TAG,
                                        "💥 Photo job exception - system available: " + requestId);
                            }
                        })
                .start();
    }

    /** Upload a video file to AugmentOS Cloud Currently a stub - videos are kept on device */
    public void uploadVideo(
            String videoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            boolean save) {
        // No webhook configured → nothing to upload; keep the video on device (legacy behavior).
        // Whitespace-safe: a blank/whitespace-only webhook would otherwise attempt a doomed upload
        // to an empty URL instead of falling back to local-save.
        if (webhookUrl == null || webhookUrl.trim().isEmpty()) {
            Log.d(
                    TAG,
                    "No webhook URL for video "
                            + requestId
                            + " - keeping video on device: "
                            + videoFilePath);
            if (mMediaCaptureListener != null) {
                // Notify that video is "uploaded" (actually just saved locally)
                mMediaCaptureListener.onVideoUploaded(requestId, videoFilePath);
            }
            return;
        }

        performDirectVideoUpload(videoFilePath, requestId, webhookUrl.trim(), authToken, save);
    }

    /**
     * Upload a recorded video to a webhook URL via multipart/form-data, mirroring the photo snapshot
     * upload in {@link #performDirectUpload}. Runs on a background thread.
     *
     * <p>Unlike photos there is no BLE fallback — video files are far too large for BLE — so a
     * failed upload is terminal. Timeouts are much larger than the photo path: write/read are
     * per-stall (idle) timeouts and {@code callTimeout} bounds the whole upload end-to-end.
     *
     * <p>The receiving server gets a multipart body with: {@code video} (the .mp4 file),
     * {@code requestId}, {@code type=video_upload}, {@code success=true}, plus an optional
     * {@code Authorization: Bearer <authToken>} header.
     */
    private void performDirectVideoUpload(
            String videoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            boolean save) {
        Log.d(TAG, "📤 Starting direct video upload operation");
        Log.d(TAG, "🎥 Upload file: " + videoFilePath);
        Log.d(TAG, "🆔 Request ID: " + requestId);

        if (mMediaCaptureListener != null) {
            mMediaCaptureListener.onVideoUploading(requestId);
        }

        new Thread(
                        () -> {
                            File videoFile = new File(videoFilePath);
                            try {
                                if (!videoFile.exists()) {
                                    Log.e(TAG, "❌ Video file does not exist: " + videoFilePath);
                                    sendMediaErrorResponse(
                                            requestId,
                                            "Video file not found",
                                            MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onMediaError(
                                                requestId,
                                                "Video file not found",
                                                MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                    }
                                    return;
                                }

                                Log.d(TAG, "📊 Video file size: " + videoFile.length() + " bytes");
                                Log.d(TAG, "🌐 Sending video to: " + webhookUrl);

                                // Video files are large; use generous timeouts. write/read are
                                // per-stall (idle) timeouts that abort a truly stalled socket.
                                // The whole-call deadline is derived from the file size against a
                                // conservative throughput floor so a healthy-but-slow link isn't
                                // aborted mid-transfer on long recordings — it only guards against
                                // a connection that never stalls yet never finishes. A flat cap
                                // (e.g. 300s) would routinely fail multi-minute uploads even at
                                // healthy speeds, and video has no BLE fallback so that is terminal.
                                long minThroughputBytesPerSec = 64L * 1024L; // ~0.5 Mbps floor
                                long callTimeoutSeconds =
                                        60L + (videoFile.length() / minThroughputBytesPerSec);
                                OkHttpClient client =
                                        new OkHttpClient.Builder()
                                                .connectTimeout(
                                                        10, java.util.concurrent.TimeUnit.SECONDS)
                                                .writeTimeout(
                                                        120, java.util.concurrent.TimeUnit.SECONDS)
                                                .readTimeout(
                                                        30, java.util.concurrent.TimeUnit.SECONDS)
                                                .callTimeout(
                                                        callTimeoutSeconds,
                                                        java.util.concurrent.TimeUnit.SECONDS)
                                                .build();

                                RequestBody fileBody =
                                        RequestBody.create(
                                                okhttp3.MediaType.parse("video/mp4"), videoFile);
                                RequestBody requestBody =
                                        new MultipartBody.Builder()
                                                .setType(MultipartBody.FORM)
                                                .addFormDataPart(
                                                        "video", videoFile.getName(), fileBody)
                                                .addFormDataPart("requestId", requestId)
                                                .addFormDataPart("type", "video_upload")
                                                .addFormDataPart("success", "true")
                                                .build();

                                Request.Builder requestBuilder =
                                        new Request.Builder().url(webhookUrl).post(requestBody);

                                boolean hasAuthToken = authToken != null && !authToken.isEmpty();
                                if (hasAuthToken) {
                                    requestBuilder.header("Authorization", "Bearer " + authToken);
                                    Log.d(
                                            TAG,
                                            "🔐 Adding Authorization header to video webhook request");
                                } else {
                                    Log.d(
                                            TAG,
                                            "⚠️ No auth token available for video webhook request");
                                }

                                Request request = requestBuilder.build();
                                Log.d(TAG, "🚀 Executing video HTTP request...");

                                long uploadStartTime = System.currentTimeMillis();
                                Response response = client.newCall(request).execute();
                                long uploadTime = System.currentTimeMillis() - uploadStartTime;
                                Log.d(TAG, "⏱️ Video upload completed in: " + uploadTime + "ms");
                                Log.d(TAG, "📈 Response code: " + response.code());

                                if (response.isSuccessful()) {
                                    String responseBody =
                                            response.body() != null ? response.body().string() : "";
                                    Log.d(TAG, "✅ Video uploaded successfully to webhook");
                                    Log.d(TAG, "📄 Response body: " + responseBody);

                                    sendMediaSuccessResponse(
                                            requestId,
                                            webhookUrl,
                                            MediaUploadQueueManager.MEDIA_TYPE_VIDEO);

                                    if (!save) {
                                        try {
                                            if (videoFile.delete()) {
                                                Log.d(
                                                        TAG,
                                                        "🗑️ Deleted video file after successful upload");
                                            } else {
                                                Log.w(TAG, "⚠️ Failed to delete video file");
                                            }
                                        } catch (Exception e) {
                                            Log.e(
                                                    TAG,
                                                    "❌ Error deleting video file after upload",
                                                    e);
                                        }
                                    } else {
                                        Log.d(TAG, "💾 Keeping video file as requested");
                                    }

                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onVideoUploaded(requestId, webhookUrl);
                                    }
                                } else {
                                    String errorMessage =
                                            "Video upload failed with status: " + response.code();
                                    Log.e(TAG, "❌ " + errorMessage + " to webhook: " + webhookUrl);
                                    sendMediaErrorResponse(
                                            requestId,
                                            errorMessage,
                                            MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onMediaError(
                                                requestId,
                                                errorMessage,
                                                MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                    }
                                }
                                response.close();
                            } catch (Exception e) {
                                Log.e(TAG, "❌ Error uploading video to webhook", e);
                                sendMediaErrorResponse(
                                        requestId,
                                        "Video upload error: " + e.getMessage(),
                                        MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                if (mMediaCaptureListener != null) {
                                    mMediaCaptureListener.onMediaError(
                                            requestId,
                                            "Video upload error: " + e.getMessage(),
                                            MediaUploadQueueManager.MEDIA_TYPE_VIDEO);
                                }
                            }
                        },
                        "VideoWebhookUpload-" + requestId)
                .start();
    }

    /** Upload media to AugmentOS Cloud */
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
                        String mediaTypeStr =
                                mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO
                                        ? "Photo"
                                        : "Video";
                        Log.d(TAG, mediaTypeStr + " uploaded successfully: " + url);
                        sendMediaSuccessResponse(requestId, url, mediaType);

                        // Check if we should save the photo
                        Boolean save = photoSaveFlags.get(requestId);
                        if (save == null || !save) {
                            // Delete the original file to save storage
                            try {
                                File file = new File(mediaFilePath);
                                if (file.exists() && file.delete()) {
                                    Log.d(
                                            TAG,
                                            "🗑️ Deleted "
                                                    + mediaTypeStr.toLowerCase()
                                                    + " file after successful upload: "
                                                    + mediaFilePath);
                                } else {
                                    Log.w(
                                            TAG,
                                            "Failed to delete "
                                                    + mediaTypeStr.toLowerCase()
                                                    + " file: "
                                                    + mediaFilePath);
                                }
                            } catch (Exception e) {
                                Log.e(
                                        TAG,
                                        "Error deleting "
                                                + mediaTypeStr.toLowerCase()
                                                + " file after upload",
                                        e);
                            }
                        } else {
                            Log.d(
                                    TAG,
                                    "💾 Keeping "
                                            + mediaTypeStr.toLowerCase()
                                            + " file as requested: "
                                            + mediaFilePath);
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
                        String mediaTypeStr =
                                mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO
                                        ? "Photo"
                                        : "Video";
                        Log.e(TAG, mediaTypeStr + " upload failed: " + errorMessage);
                        sendMediaErrorResponse(requestId, errorMessage, mediaType);

                        // Check if we can fallback to BLE for photos
                        String bleImgId = photoBleIds.get(requestId);
                        if (mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO
                                && bleImgId != null) {
                            Log.d(
                                    TAG,
                                    "📱 WiFi upload failed, attempting BLE fallback for "
                                            + requestId);

                            // Don't delete the photo yet - we need it for BLE
                            // Clean up tracking (will be re-added by BLE transfer)
                            photoBleIds.remove(requestId);
                            photoOriginalPaths.remove(requestId);

                            // Trigger BLE fallback - reuse the existing photo instead of taking a
                            // new one
                            boolean shouldSaveFallback2 =
                                    Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                            String requestedSizeFallback2 = photoRequestedSizes.get(requestId);
                            if (requestedSizeFallback2 == null || requestedSizeFallback2.isEmpty())
                                requestedSizeFallback2 = "medium";
                            // Reuse the existing photo file that was already captured
                            Log.d(
                                    TAG,
                                    "♻️ Reusing existing photo for BLE transfer: " + mediaFilePath);
                            reusePhotoForBleTransfer(
                                    mediaFilePath,
                                    requestId,
                                    bleImgId,
                                    shouldSaveFallback2,
                                    requestedSizeFallback2);
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
                                    Log.d(
                                            TAG,
                                            "🗑️ Deleted "
                                                    + mediaTypeStr.toLowerCase()
                                                    + " file after failed upload: "
                                                    + mediaFilePath);
                                } else {
                                    Log.w(
                                            TAG,
                                            "Failed to delete "
                                                    + mediaTypeStr.toLowerCase()
                                                    + " file: "
                                                    + mediaFilePath);
                                }
                            } catch (Exception e) {
                                Log.e(
                                        TAG,
                                        "Error deleting "
                                                + mediaTypeStr.toLowerCase()
                                                + " file after failed upload",
                                        e);
                            }
                        } else {
                            Log.d(
                                    TAG,
                                    "💾 Keeping "
                                            + mediaTypeStr.toLowerCase()
                                            + " file despite failed upload as requested: "
                                            + mediaFilePath);
                        }

                        // Clean up tracking
                        photoSaveFlags.remove(requestId);
                        photoBleIds.remove(requestId);
                        photoOriginalPaths.remove(requestId);

                        // Notify listener about error
                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onMediaError(
                                    requestId, "Upload failed: " + errorMessage, mediaType);
                        }
                    }
                });
    }

    /** Save media to local app directory */
    private void saveMediaToGallery(String mediaFilePath, int mediaType) {
        try {
            // Create a File object from the path
            File mediaFile = new File(mediaFilePath);
            if (!mediaFile.exists()) {
                Log.e(TAG, "Media file does not exist: " + mediaFilePath);
                return;
            }

            // Get this class's directory
            String classDirectory =
                    fileManager.getDefaultMediaDirectory() + File.separator + "MediaCaptureService";
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
     * Send a success response for a media request This should be overridden by the service that
     * uses this class
     */
    protected void sendMediaSuccessResponse(String requestId, String mediaUrl, int mediaType) {
        // Default implementation is empty
        // This should be overridden by the service that uses this class
    }

    /**
     * Send an error response for a media request This should be overridden by the service that uses
     * this class
     */
    protected void sendMediaErrorResponse(String requestId, String errorMessage, int mediaType) {
        // Default implementation is empty
        // This should be overridden by the service that uses this class
    }

    /** Check if external storage is available for read/write */
    private boolean isExternalStorageAvailable() {
        String state = android.os.Environment.getExternalStorageState();
        return android.os.Environment.MEDIA_MOUNTED.equals(state);
    }

    /**
     * Check if WiFi is connected using modern NetworkCapabilities API. Used to decide whether to
     * attempt direct webhook upload or skip to BLE.
     */
    private boolean isWiFiConnected() {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) mContext.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            android.net.Network activeNetwork = cm.getActiveNetwork();
            if (activeNetwork == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(activeNetwork);
            return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        } catch (Exception e) {
            Log.e(TAG, "Error checking WiFi connectivity", e);
            return false;
        }
    }

    /**
     * Take a photo with auto transfer (WiFi with BLE fallback)
     *
     * @param photoFilePath Path to save the original photo
     * @param requestId Request ID for tracking
     * @param webhookUrl Webhook URL for upload
     * @param bleImgId BLE image ID for fallback
     * @param save Whether to keep the photo on device
     * @param compress Compression level (none, medium, heavy)
     * @param exposureTimeNs optional sensor exposure time in nanoseconds for this capture only;
     *     {@code null} = auto
     * @param iso optional sensor sensitivity for manual exposure captures only; {@code null} =
     *     derive ISO from preview metering
     */
    public boolean takePhotoAutoTransfer(
            String photoFilePath,
            String requestId,
            String webhookUrl,
            String authToken,
            String bleImgId,
            boolean save,
            String size,
            boolean enableFlash,
            boolean enableSound,
            String compress,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        // Check if camera HAL is restarting after FOV change
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            return false;
        }

        // Check battery level before proceeding (defense-in-depth)
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(
                        requestId,
                        "BATTERY_LOW",
                        "Battery too low to take photo (" + batteryLevel + "%)");
                return false;
            }
        } else {
            Log.w(
                    TAG,
                    "⚠️ StateManager not initialized - skipping battery check for auto transfer");
        }

        if (isWiFiConnected()) {
            // WiFi available - try direct webhook upload with BLE fallback on failure
            // Store tracking data needed by webhook's BLE fallback path
            photoSaveFlags.put(requestId, save);
            photoBleIds.put(requestId, bleImgId);
            photoOriginalPaths.put(requestId, photoFilePath);
            photoRequestedSizes.put(requestId, size);
            tracePhotoWifiRoute(requestId, "direct_webhook", "wifi_connected", webhookUrl, null);

            Log.d(TAG, "📶 WiFi connected - attempting direct upload for " + requestId);
            return takePhotoAndUpload(
                    photoFilePath,
                    requestId,
                    webhookUrl,
                    authToken,
                    save,
                    size,
                    enableFlash,
                    enableSound,
                    compress,
                    exposureTimeNs,
                    iso,
                    captureSettings);
        } else {
            // No WiFi - skip webhook entirely, go straight to BLE (saves 2-5s timeout wait)
            tracePhotoWifiRoute(requestId, "ble", "wifi_unavailable", webhookUrl, null);
            Log.d(TAG, "📵 No WiFi - skipping webhook, using BLE transfer for " + requestId);
            return takePhotoForBleTransfer(
                    photoFilePath,
                    requestId,
                    bleImgId,
                    save,
                    size,
                    enableFlash,
                    enableSound,
                    exposureTimeNs,
                    iso,
                    captureSettings);
        }
    }

    /**
     * Take a photo for BLE transfer with compression
     *
     * @param photoFilePath Path to save the original photo
     * @param requestId Request ID for tracking
     * @param bleImgId BLE image ID to use as filename
     * @param save Whether to keep the original photo on device
     * @param exposureTimeNs optional sensor exposure time in nanoseconds for this capture only;
     *     {@code null} = auto
     * @param iso optional sensor sensitivity for manual exposure captures only; {@code null} =
     *     derive ISO from preview metering
     */
    public boolean takePhotoForBleTransfer(
            String photoFilePath,
            String requestId,
            String bleImgId,
            boolean save,
            String size,
            boolean enableFlash,
            boolean enableSound,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (captureSettings == null) {
            captureSettings = PhotoCaptureSettings.EMPTY;
        }
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        recordTiming(requestId, "ble_request_start");
        if (ENABLE_PHOTO_TIMING_LOGS) {
            Log.i(TAG, "⏱️ [TIMING] BLE Photo request START - ID: " + requestId);
        }

        // Check if any streaming is active - photos cannot interrupt streams
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with streaming");
            return false;
        }

        // Check if camera HAL is restarting after FOV change
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            return false;
        }

        // Check battery level before proceeding
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(
                        requestId,
                        "BATTERY_LOW",
                        "Battery too low to take photo (" + batteryLevel + "%)");
                return false;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for BLE transfer");
        }

        // STORAGE CHECK: Reject if insufficient storage
        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (!storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Photo rejected - insufficient storage");
            playStorageFullSound();
            sendPhotoErrorResponse(
                    requestId,
                    "INSUFFICIENT_STORAGE",
                    "Insufficient storage space for photo capture");
            return false;
        }

        // Single-flight guard: reject if any photo job (capture or upload/BLE-handoff) is in
        // flight.
        // Flag stays set through capture → BLE compression → BLE handoff; cleared at terminal
        // exits.
        if (!acquirePhotoJob(requestId)) {
            Log.w(TAG, "🚫 Photo job in flight - rejecting concurrent BLE request: " + requestId);
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Another photo job is in progress");
            return false;
        }
        startCaptureSafetyTimeout(requestId);
        sendPhotoStatus(requestId, "accepted");

        // Store the save flag for this request
        photoSaveFlags.put(requestId, save);
        // Track requested size for BLE compression
        photoRequestedSizes.put(requestId, size);
        // Notify that we're about to take a photo
        if (mMediaCaptureListener != null) {
            mMediaCaptureListener.onPhotoCapturing(requestId);
        }
        sendPhotoStatus(requestId, "queued");

        // LED control is now handled by CameraNeoService tied to camera lifecycle

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestHooks.shouldFail("CAMERA_CAPTURE")) {
            releasePhotoJob(requestId);
            Log.e(
                    TAG,
                    "TESTING: Simulating camera capture failure for BLE transfer - "
                            + PhotoCaptureTestHooks.getErrorCode()
                            + ": "
                            + PhotoCaptureTestHooks.getErrorMessage());
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            return false;
        }

        // TESTING: Add fake delay for camera capture
        PhotoCaptureTestHooks.addFakeDelay("CAMERA_CAPTURE");

        // Skip sound and flash during camera HAL restart cooldown (e.g. after FOV change)
        if (!shouldSuppressPhotoFeedback()) {
            triggerPhotoFlashLed();
            if (enableSound) {
                // BLE-transfer SDK photo: isFromSdk=true; size and exposure match the
                // enqueuePhotoRequest call below so the warm/cold prediction lines up.
                playShutterSound(size, true, exposureTimeNs);
            }
            if (enableFlash) {
                flashPrivacyLedForPhoto();
            }
        }

        try {
            // Use CameraNeoService for photo capture
            recordTiming(requestId, "enqueue_camera");
            CameraNeoService.enqueuePhotoRequest(
                    mContext,
                    photoFilePath,
                    size,
                    enableFlash,
                    true, // isFromSdk — same sizing as webhook SDK path
                    exposureTimeNs,
                    iso,
                    captureSettings,
                    new CameraNeoService.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoConfigured(JSONObject resolvedConfig) {
                            sendPhotoStatus(
                                    requestId,
                                    "configuring",
                                    addPhotoTransferDetails(resolvedConfig, save, "ble", "ble"),
                                    null,
                                    null);
                        }

                        @Override
                        public void onPhotoCapturing(
                                JSONObject requestedCaptureConfig, JSONObject meteredPreview) {
                            sendPhotoStatus(
                                    requestId,
                                    "capturing",
                                    null,
                                    null,
                                    null,
                                    requestedCaptureConfig,
                                    meteredPreview,
                                    null);
                        }

                        @Override
                        public void onPhotoCaptured(String filePath) {
                            onPhotoCaptured(filePath, null);
                        }

                        @Override
                        public void onPhotoCaptured(String filePath, JSONObject captureMetadata) {
                            // NOTE: do NOT clear isPhotoJobInFlight here — the job continues
                            // through BLE compression + handoff. Flag is cleared in
                            // compressAndSendViaBle's finally block.
                            recordTiming(requestId, "photo_captured");

                            // Calculate end-to-end timing from request to capture
                            long totalElapsedMs = System.currentTimeMillis() - requestStartTimeMs;
                            if (ENABLE_PHOTO_TIMING_LOGS) {
                                Log.i(
                                        TAG,
                                        "⏱️ [TIMING] BLE Photo CAPTURED in "
                                                + totalElapsedMs
                                                + "ms - ID: "
                                                + requestId);
                            }

                            Log.d(TAG, "Photo captured successfully for BLE transfer: " + filePath);
                            sendPhotoStatus(
                                    requestId,
                                    "captured",
                                    null,
                                    null,
                                    null,
                                    null,
                                    null,
                                    captureMetadata);

                            // LED is now managed by CameraNeoService and will turn off when camera
                            // closes

                            // Notify that we've captured the photo
                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                            }

                            // Compress and send via BLE
                            recordTiming(requestId, "start_compress_for_ble");
                            compressAndSendViaBle(filePath, requestId, bleImgId);
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            releasePhotoJob(requestId);

                            Log.e(TAG, "Failed to capture photo for BLE: " + errorMessage);

                            // LED is now managed by CameraNeoService and will turn off when camera
                            // closes

                            dumpTimings(requestId);
                            sendPhotoErrorResponse(
                                    requestId, "CAMERA_CAPTURE_FAILED", errorMessage);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(
                                        requestId,
                                        errorMessage,
                                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    });
            return true;
        } catch (Exception e) {
            releasePhotoJob(requestId);
            Log.e(TAG, "Error taking photo for BLE", e);
            sendPhotoErrorResponse(
                    requestId, "CAMERA_CAPTURE_FAILED", "Error taking photo: " + e.getMessage());

            if (mMediaCaptureListener != null) {
                mMediaCaptureListener.onMediaError(
                        requestId,
                        "Error taking photo: " + e.getMessage(),
                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
            }
            return false;
        }
    }

    /**
     * Reuse existing photo for BLE transfer (when webhook fails) This avoids taking a duplicate
     * photo
     */
    private void reusePhotoForBleTransfer(
            String existingPhotoPath,
            String requestId,
            String bleImgId,
            boolean save,
            String size) {
        // Check if any streaming is active - avoid BLE transfers during streams
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot transfer photo via BLE - streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with streaming");
            photoSaveFlags.remove(requestId);
            photoBleIds.remove(requestId);
            photoOriginalPaths.remove(requestId);
            photoRequestedSizes.remove(requestId);
            releasePhotoJob(requestId);
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
        compressAndSendViaBle(existingPhotoPath, requestId, bleImgId, true);
    }

    /** Compress photo and send via BLE */
    private void compressAndSendViaBle(String originalPath, String requestId, String bleImgId) {
        compressAndSendViaBle(originalPath, requestId, bleImgId, false);
    }

    /** Compress photo and send via BLE */
    private void compressAndSendViaBle(
            String originalPath, String requestId, String bleImgId, boolean isWifiFallback) {
        new Thread(
                        () -> {
                            long startTime = System.currentTimeMillis();
                            recordTiming(requestId, "ble_compress_start");
                            sendPhotoStatus(
                                    requestId,
                                    isWifiFallback ? "ble_fallback_compression" : "compressing");
                            Log.d(TAG, "🚀 BLE photo transfer started for " + bleImgId);

                            // TESTING: Check for fake compression failure
                            if (PhotoCaptureTestHooks.shouldFail("COMPRESSION")) {
                                releasePhotoJob(requestId);
                                Log.e(TAG, "TESTING: Simulating compression failure");
                                sendPhotoErrorResponse(
                                        requestId,
                                        PhotoCaptureTestHooks.getErrorCode(),
                                        PhotoCaptureTestHooks.getErrorMessage());
                                return;
                            }

                            // TESTING: Add fake delay for compression
                            PhotoCaptureTestHooks.addFakeDelay("COMPRESSION");

                            try {
                                // 1. Resolve BLE resize and quality parameters based on requested
                                // size
                                String requestedSize = photoRequestedSizes.get(requestId);
                                if (requestedSize == null || requestedSize.isEmpty()) {
                                    requestedSize = "medium";
                                }

                                BleParams bleParams = resolveBleParams(requestedSize);

                                byte[] compressedData;
                                if (ENABLE_GRAYSCALE_BLE_PHOTOS) {
                                    // 2. Grayscale luma pipeline: detect the text region, then
                                    // decode subsampled, crop + contrast + unsharp on
                                    // 1-byte/pixel buffers, then hand the luma plane straight to
                                    // the monochrome (YUV400) AVIF encoder - no Bitmap/RGBA
                                    // round-trip anywhere. BLE photos exist to be read
                                    // (documents/signs/screens), not viewed, so color is dead
                                    // weight; this path never materializes the ~30MB full-res
                                    // ARGB bitmap the old decode+resize+sharpen chain used. The
                                    // ROI crop keeps native resolution on the region OCR reads;
                                    // null ROI (weak/spread signal) means full frame.
                                    android.graphics.Rect textRoi =
                                            ENABLE_BLE_TEXT_ROI_CROP
                                                    ? TextRegionDetector.detect(originalPath)
                                                    : null;
                                    GrayscaleBleProcessor.LumaImage lumaImage =
                                            GrayscaleBleProcessor.processToLuma(
                                                    originalPath,
                                                    textRoi,
                                                    bleParams.targetWidth,
                                                    bleParams.targetHeight);

                                    Log.d(
                                            TAG,
                                            "📐 BLE image ready for encode: "
                                                    + lumaImage.width
                                                    + "x"
                                                    + lumaImage.height
                                                    + " grayscale=true (mono AVIF, speed="
                                                    + BLE_AVIF_ENCODE_SPEED
                                                    + ")");

                                    // 3. Encode as monochrome AVIF only (no JPEG fallback over
                                    // BLE)
                                    compressedData =
                                            PhotoExifMetadataWriter.encodeAvifForBleMono(
                                                    lumaImage.luma,
                                                    lumaImage.width,
                                                    lumaImage.height,
                                                    bleParams.avifQuality,
                                                    BLE_AVIF_ENCODE_SPEED,
                                                    originalPath);
                                } else {
                                    // Legacy full-color path.
                                    android.graphics.Bitmap original =
                                            android.graphics.BitmapFactory.decodeFile(
                                                    originalPath);
                                    if (original == null) {
                                        throw new Exception("Failed to decode image file");
                                    }

                                    // Calculate new dimensions maintaining aspect ratio,
                                    // constrained by requested target
                                    int targetWidth = bleParams.targetWidth;
                                    int targetHeight = bleParams.targetHeight;
                                    float aspectRatio =
                                            (float) original.getWidth() / original.getHeight();

                                    if (aspectRatio > targetWidth / (float) targetHeight) {
                                        targetHeight = (int) (targetWidth / aspectRatio);
                                    } else {
                                        targetWidth = (int) (targetHeight * aspectRatio);
                                    }

                                    // Resize bitmap, then restore edge contrast: the downscale
                                    // low-pass-filters text strokes, and a mild unsharp costs
                                    // almost no bytes while visibly improving glyph legibility.
                                    android.graphics.Bitmap scaled =
                                            android.graphics.Bitmap.createScaledBitmap(
                                                    original, targetWidth, targetHeight, true);
                                    // createScaledBitmap returns the SAME object when the size
                                    // already matches (medium ladder == capture resolution), so
                                    // recycling unconditionally would kill the bitmap mid-pipeline.
                                    if (scaled != original) {
                                        original.recycle();
                                    }
                                    android.graphics.Bitmap resized =
                                            BleImageSharpener.sharpen(mContext, scaled);
                                    if (resized != scaled) {
                                        scaled.recycle();
                                    }

                                    Log.d(
                                            TAG,
                                            "📐 BLE image ready for encode: "
                                                    + resized.getWidth()
                                                    + "x"
                                                    + resized.getHeight()
                                                    + " grayscale=false");

                                    // 3. Encode as AVIF only (no JPEG fallback over BLE)
                                    Log.d(
                                            TAG,
                                            "BLE AVIF encode: originalPath="
                                                    + originalPath
                                                    + " hasImuMetadata="
                                                    + PhotoExifMetadataWriter.hasImuMetadata(
                                                            originalPath));
                                    try {
                                        compressedData =
                                                PhotoExifMetadataWriter.encodeAvifForBle(
                                                        resized,
                                                        bleParams.avifQuality,
                                                        originalPath);
                                    } finally {
                                        resized.recycle();
                                    }
                                }
                                Log.d(TAG, "Successfully encoded as AVIF for BLE");

                                long compressionTime = System.currentTimeMillis() - startTime;
                                recordTiming(requestId, "ble_compress_done");
                                File originalFileForSize = new File(originalPath);
                                long originalSizeBytes = originalFileForSize.length();
                                double originalSizeKb = originalSizeBytes / 1024.0;
                                double compressedSizeKb = compressedData.length / 1024.0;
                                Log.d(
                                        TAG,
                                        "✅ Compressed photo for BLE: "
                                                + originalPath
                                                + " ("
                                                + originalSizeBytes
                                                + " bytes / "
                                                + String.format(Locale.US, "%.1f", originalSizeKb)
                                                + " KB) -> AVIF "
                                                + compressedData.length
                                                + " bytes / "
                                                + String.format(
                                                        Locale.US, "%.1f", compressedSizeKb)
                                                + " KB, grayscale="
                                                + ENABLE_GRAYSCALE_BLE_PHOTOS);
                                Log.d(TAG, "⏱️ Compression took: " + compressionTime + "ms");

                                // 5. Save compressed data to temporary file with bleImgId as name
                                // For BLE, we ALWAYS use AVIF (no extension in filename due to
                                // 16-char limit)
                                String compressedPath =
                                        fileManager.getDefaultMediaDirectory() + "/" + bleImgId;
                                try (java.io.FileOutputStream fos =
                                        new java.io.FileOutputStream(compressedPath)) {
                                    fos.write(compressedData);
                                }

                                // 6. Send via BLE using K900BluetoothManager
                                recordTiming(requestId, "ble_send_start");
                                sendCompressedPhotoViaBle(
                                        compressedPath, bleImgId, requestId, startTime);

                                // 7. Delete original photo if not saving to gallery
                                Boolean save = photoSaveFlags.get(requestId);
                                if (save == null || !save) {
                                    try {
                                        File originalFile = new File(originalPath);
                                        if (originalFile.exists() && originalFile.delete()) {
                                            Log.d(
                                                    TAG,
                                                    "🗑️ Deleted original photo after BLE compression: "
                                                            + originalPath);
                                        } else {
                                            Log.w(
                                                    TAG,
                                                    "Failed to delete original photo: "
                                                            + originalPath);
                                        }
                                    } catch (Exception deleteEx) {
                                        Log.e(
                                                TAG,
                                                "Error deleting original photo after BLE compression",
                                                deleteEx);
                                    }
                                } else {
                                    Log.d(
                                            TAG,
                                            "💾 Keeping original photo as requested: "
                                                    + originalPath);
                                }

                                // Clean up the flag
                                photoSaveFlags.remove(requestId);
                            } catch (Exception e) {
                                Log.e(TAG, "Error compressing photo for BLE", e);
                                dumpTimings(requestId);
                                sendPhotoErrorResponse(
                                        requestId, "BLE_TRANSFER_FAILED", e.getMessage());

                                // Clean up flag on error too
                                photoSaveFlags.remove(requestId);
                            } finally {
                                // BLE compress + handoff (or its failure) ends our authority over
                                // the photo
                                // job. From here, mServiceCallback.isBleTransferInProgress() is the
                                // active
                                // gate against new requests (enforced by PhotoCommandHandler).
                                releasePhotoJob(requestId);
                                Log.d(
                                        TAG,
                                        "📡 BLE handoff complete - photo job released: "
                                                + requestId);
                            }
                        })
                .start();
    }

    /** Send compressed photo via BLE */
    private void sendCompressedPhotoViaBle(
            String compressedPath, String bleImgId, String requestId, long transferStartTime) {
        Log.d(
                TAG,
                "Ready to send compressed photo via BLE: "
                        + compressedPath
                        + " with ID: "
                        + bleImgId);

        // TESTING: Check for fake BLE transfer failure
        if (PhotoCaptureTestHooks.shouldFail("BLE_TRANSFER")) {
            Log.e(TAG, "TESTING: Simulating BLE transfer failure");
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            return;
        }

        // TESTING: Add fake delay for BLE transfer
        PhotoCaptureTestHooks.addFakeDelay("BLE_TRANSFER");

        boolean transferStarted = false;
        try {
            if (mServiceCallback != null) {
                // CRITICAL: Check if BLE is busy BEFORE sending ANY data to BES2700
                if (mServiceCallback.isBleTransferInProgress()) {
                    Log.e(
                            TAG,
                            "❌ BLE transfer already in progress - queuing error message to avoid BES2700 overload");

                    // Send error response immediately
                    sendPhotoErrorResponse(
                            requestId,
                            "BLE_TRANSFER_BUSY",
                            "BLE transfer busy - another transfer in progress");

                    // Also notify local listener
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onMediaError(
                                requestId,
                                "BLE transfer busy - another transfer in progress",
                                MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                    }
                    return;
                }

                // BLE is available - send the ready message first (phone expects this for timing
                // tracking)
                recordTiming(requestId, "ble_ready_msg");
                sendBlePhotoReadyMsg(compressedPath, bleImgId, requestId, transferStartTime);

                // Brief delay so the ble_photo_ready JSON drains ahead of file packets.
                // Was 200ms; the firmware TX window now queues both in order (and the
                // phone's reassembly tolerates packets arriving before the JSON), so
                // 20ms is a safety margin, not a required gap. Hardware-validate: a
                // regression shows up as first-packet retries in the transfer logs.
                try {
                    Thread.sleep(20);
                } catch (InterruptedException e) {
                    Log.w(TAG, "Delay interrupted", e);
                }

                // Then try to start the file transfer
                recordTiming(requestId, "ble_file_transfer_start");
                transferStarted = mServiceCallback.sendFileViaBluetooth(compressedPath);

                if (transferStarted) {
                    recordTiming(requestId, "ble_transfer_started");
                    sendPhotoStatus(requestId, "transferring");
                    dumpTimings(requestId);
                    Log.i(TAG, "✅ BLE file transfer started for: " + bleImgId);
                } else {
                    // This shouldn't happen since we checked above, but handle it anyway
                    Log.e(TAG, "Failed to start BLE file transfer despite availability check");
                    sendPhotoErrorResponse(
                            requestId,
                            "BLE_TRANSFER_FAILED_TO_START",
                            "BLE transfer failed to start");
                }
            } else {
                Log.e(TAG, "Service callback not available for BLE file transfer");
                sendPhotoErrorResponse(
                        requestId, "BLE_TRANSFER_FAILED", "Service callback not available");
            }
        } finally {
            // Critical: Clean up compressed file if transfer didn't start
            if (!transferStarted) {
                try {
                    File compressedFile = new File(compressedPath);
                    if (compressedFile.exists()) {
                        if (compressedFile.delete()) {
                            Log.d(
                                    TAG,
                                    "🗑️ Deleted compressed file after BLE transfer failure: "
                                            + compressedPath);
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

    /** Request BLE file transfer through AsgClientService */
    private void sendBlePhotoReadyMsg(
            String filePath, String bleImgId, String requestId, long transferStartTime) {
        try {
            // Calculate compression duration on glasses side
            long compressionDuration = System.currentTimeMillis() - transferStartTime;

            JSONObject json = new JSONObject();
            json.put("type", "ble_photo_ready");
            json.put("requestId", requestId);
            json.put("bleImgId", bleImgId);
            json.put("compressionDurationMs", compressionDuration); // Send duration, not timestamp
            sendPhotoStatus(requestId, "ready_for_transfer");

            // Send through bluetooth if available
            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating BLE transfer request", e);
        }
    }

    /** Send BLE transfer error */
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

    private JSONObject addPhotoTransferDetails(
            JSONObject resolvedConfig, boolean save, String transferMethod, String compression) {
        JSONObject config = resolvedConfig != null ? resolvedConfig : new JSONObject();
        try {
            config.put("saveToGallery", save);
            if (transferMethod != null && !transferMethod.isEmpty()) {
                config.put("transferMethod", transferMethod);
            }
            if (compression != null && !compression.isEmpty()) {
                config.put("compression", compression);
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error adding photo transfer details", e);
        }
        return config;
    }

    /**
     * Open + configure + preview the camera and hold it warm for {@code durationMs} without taking a
     * photo, so a later {@code take_photo} of the same {@code size}/{@code exposureTimeNs} reuses the
     * warm session and is near-instant. Emits {@code camera_status}: {@code warming} on accept,
     * {@code ready} once preview/AE is running, {@code stopped} when the keep-alive expires, and
     * {@code error} on failure.
     *
     * <p><b>Shared-camera safety:</b> if a video recording or RTMP/SRT/WHIP stream already owns the
     * camera the camera is already warm — emit {@code ready} immediately and do not take ownership.
     * If a photo job is mid-flight, reject with {@code error} so the in-flight capture is undisturbed.
     *
     * @param requestId echoed in every {@code camera_status} event (required)
     * @param size resolution tier matching the warmed config ("low"/"medium"/"high"/"max")
     * @param exposureTimeNs optional manual shutter in ns; {@code null} = auto
     * @param durationMs keep-alive TTL in ms; {@code <= 0} uses the default warm-up hold
     * @return true if the warm-up was accepted (or the camera was already warm), false otherwise
     */
    public boolean warmUpCamera(
            String requestId, String size, Long exposureTimeNs, long durationMs) {
        if (requestId == null || requestId.isEmpty()) {
            Log.w(TAG, "camera_warm_up rejected - missing requestId");
            return false;
        }

        // Camera HAL restarting after FOV change — cannot warm right now.
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "camera_warm_up rejected - camera HAL restarting after FOV change");
            sendCameraStatus(
                    requestId,
                    "error",
                    "camera_restart_cooldown",
                    "Camera restarting after FOV change");
            return false;
        }

        // SHARED-CAMERA SAFETY: a video recording or stream already owns the camera. It is already
        // warm — report ready and do NOT take ownership or close anything.
        if (isRecordingVideo
                || RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.d(TAG, "camera_warm_up: camera already owned by video/stream - reporting ready");
            sendCameraStatus(requestId, "ready", null);
            return true;
        }

        // A photo job (capture or BLE handoff) is mid-flight — do not disrupt it.
        if (isPhotoJobInFlight()) {
            Log.w(TAG, "camera_warm_up rejected - photo job in flight");
            sendCameraStatus(
                    requestId,
                    "error",
                    "photo_capture_in_progress",
                    "Photo capture in progress");
            return false;
        }
        if (isBleTransferInProgress()) {
            Log.w(TAG, "camera_warm_up rejected - BLE transfer in progress");
            sendCameraStatus(
                    requestId,
                    "error",
                    "ble_transfer_in_progress",
                    "Bluetooth photo transfer in progress");
            return false;
        }

        Log.i(
                TAG,
                "📷 camera_warm_up accepted requestId="
                        + requestId
                        + " size="
                        + size
                        + " exposureTimeNs="
                        + exposureTimeNs
                        + " durationMs="
                        + durationMs);

        // CameraNeoService.warmUpCamera rejects an overlapping/mid-capture warm-up synchronously
        // (it fires onCameraError on this thread before returning). Track that so the return value
        // reflects a synchronous busy rejection instead of always reporting acceptance. Rejections
        // that resolve later (async, in the service) are surfaced via camera_status as usual.
        AtomicBoolean warmUpDispatching = new AtomicBoolean(true);
        AtomicBoolean rejectedSynchronously = new AtomicBoolean(false);
        CameraNeoService.warmUpCamera(
                mContext,
                size,
                exposureTimeNs,
                durationMs,
                new CameraNeoService.CameraWarmUpCallback() {
                    @Override
                    public void onWarming() {
                        // Emitted only once CameraNeoService commits to the warm-up (not on a busy
                        // rejection), so a serialized/busy request never sees warming then error.
                        sendCameraStatus(requestId, "warming", null);
                    }

                    @Override
                    public void onCameraReady() {
                        sendCameraStatus(requestId, "ready", null);
                    }

                    @Override
                    public void onCameraStopped() {
                        sendCameraStatus(requestId, "stopped", null);
                    }

                    @Override
                    public void onCameraError(String errorMessage) {
                        if (warmUpDispatching.get()) {
                            rejectedSynchronously.set(true);
                        }
                        sendCameraStatus(
                                requestId,
                                "error",
                                cameraWarmUpErrorCode(errorMessage),
                                errorMessage);
                    }

                    @Override
                    public String getRequestId() {
                        return requestId;
                    }
                });
        warmUpDispatching.set(false);
        return !rejectedSynchronously.get();
    }

    /**
     * Emit a {@code camera_status} event for a {@code camera_warm_up} request. Mirrors the flat,
     * top-level JSON shape of {@code photo_status} (sent directly over BLE, not wrapped in {@code
     * data}) so the phone parses {@code state}/{@code requestId} at the top level.
     *
     * @param state one of {@code warming}, {@code ready}, {@code stopped}, {@code error}
     * @param errorMessage included only for the {@code error} state
     */
    public void sendCameraStatus(String requestId, String state, String errorMessage) {
        sendCameraStatus(requestId, state, null, errorMessage);
    }

    /**
     * Emit a {@code camera_status} event for a {@code camera_warm_up} request. Mirrors the flat,
     * top-level JSON shape of {@code photo_status} (sent directly over BLE, not wrapped in {@code
     * data}) so the phone parses {@code state}/{@code requestId} at the top level.
     *
     * @param state one of {@code warming}, {@code ready}, {@code stopped}, {@code error}
     * @param errorCode stable machine-readable error code, included only when present
     * @param errorMessage included only for the {@code error} state
     */
    public void sendCameraStatus(
            String requestId, String state, String errorCode, String errorMessage) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        try {
            JSONObject json = new JSONObject();
            json.put("type", "camera_status");
            json.put("state", state);
            json.put("requestId", requestId);
            json.put("timestamp", System.currentTimeMillis());
            if (errorCode != null && !errorCode.isEmpty()) {
                json.put("errorCode", errorCode);
            }
            if (errorMessage != null && !errorMessage.isEmpty()) {
                json.put("errorMessage", errorMessage);
            }

            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
                Log.d(TAG, "📷 camera_status sent: state=" + state + " requestId=" + requestId);
            } else {
                Log.w(TAG, "Cannot send camera status - service callback unavailable");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating camera status", e);
        }
    }

    private static String cameraWarmUpErrorCode(String errorMessage) {
        if ("camera_busy".equals(errorMessage)) {
            return "camera_busy";
        }
        return "camera_warm_up_failed";
    }

    private void sendPhotoStatus(String requestId, String status) {
        sendPhotoStatus(requestId, status, null, null, null);
    }

    private void sendPhotoStatus(
            String requestId,
            String status,
            JSONObject resolvedConfig,
            String errorCode,
            String errorMessage) {
        sendPhotoStatus(
                requestId, status, resolvedConfig, errorCode, errorMessage, null, null, null);
    }

    private void sendPhotoStatus(
            String requestId,
            String status,
            JSONObject resolvedConfig,
            String errorCode,
            String errorMessage,
            JSONObject requestedCaptureConfig,
            JSONObject meteredPreview,
            JSONObject captureMetadata) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_status");
            json.put("requestId", requestId);
            json.put("status", status);
            json.put("timestamp", System.currentTimeMillis());
            if (resolvedConfig != null) {
                json.put("resolvedConfig", resolvedConfig);
            }
            if (requestedCaptureConfig != null) {
                logFullPhotoStatusMetadata(
                        requestId, status, "requestedCaptureConfig", requestedCaptureConfig);
            }
            if (meteredPreview != null) {
                json.put("meteredPreview", meteredPreview);
            }
            if (captureMetadata != null) {
                logFullPhotoStatusMetadata(requestId, status, "captureMetadata", captureMetadata);
            }
            if (errorCode != null && !errorCode.isEmpty()) {
                json.put("errorCode", errorCode);
            }
            if (errorMessage != null && !errorMessage.isEmpty()) {
                json.put("errorMessage", errorMessage);
            }

            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
            } else {
                Log.w(TAG, "Cannot send photo status - service callback unavailable");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating photo status", e);
        }
    }

    private void logFullPhotoStatusMetadata(
            String requestId, String status, String metadataName, JSONObject metadata) {
        if (metadata == null) {
            return;
        }
        Log.i(
                TAG,
                "📸 photo_status "
                        + status
                        + " full "
                        + metadataName
                        + " requestId="
                        + requestId
                        + " "
                        + metadata);
    }

    /** Send simplified photo error response with only essential fields */
    public void sendPhotoErrorResponse(String requestId, String errorCode, String errorMessage) {
        try {
            sendPhotoStatus(requestId, "failed", null, errorCode, errorMessage);
            JSONObject json = new JSONObject();
            json.put("type", "photo_response");
            json.put("requestId", requestId);
            json.put("state", "error");
            json.put("success", false);
            json.put("errorCode", errorCode);
            json.put("errorMessage", errorMessage);
            json.put("timestamp", System.currentTimeMillis());

            Log.e(
                    TAG,
                    "📸 SENDING PHOTO ERROR: "
                            + errorCode
                            + " - "
                            + errorMessage
                            + " for requestId: "
                            + requestId);

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

    /** Send terminal success once the photo action has completed. */
    public void sendPhotoSuccessResponse(String requestId, String uploadUrl) {
        sendPhotoSuccessResponse(requestId, uploadUrl, null);
    }

    /** Send terminal success once the photo action has completed. */
    public void sendPhotoSuccessResponse(String requestId, String uploadUrl, String responseBody) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_response");
            json.put("requestId", requestId);
            json.put("state", "success");
            json.put("success", true);
            json.put("uploadUrl", uploadUrl != null ? uploadUrl : "");
            json.put("timestamp", System.currentTimeMillis());
            copyPhotoUploadResponseMetadata(json, responseBody);

            Log.i(TAG, "📸 SENDING PHOTO COMPLETE: requestId=" + requestId);

            if (mServiceCallback != null) {
                mServiceCallback.sendThroughBluetooth(json.toString().getBytes());
                Log.i(TAG, "📸 SENT VIA BLE: " + json.toString());
            } else {
                Log.e(TAG, "❌ Service callback not available for photo success response");
            }
        } catch (JSONException e) {
            Log.e(TAG, "❌ Error creating photo success response", e);
        }
    }

    private void copyPhotoUploadResponseMetadata(JSONObject target, String responseBody) {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            return;
        }
        try {
            JSONObject response = new JSONObject(responseBody);
            copyJsonField(target, response, "photoUrl");
            copyJsonField(target, response, "statusUrl");
            copyFirstJsonField(target, response, "contentType", "contentType", "mimeType");
            copyFirstJsonField(target, response, "fileSizeBytes", "fileSizeBytes", "bytes", "size");
        } catch (JSONException e) {
            Log.d(TAG, "Photo upload response body was not JSON metadata");
        }
    }

    private void copyJsonField(JSONObject target, JSONObject source, String key)
            throws JSONException {
        if (source.has(key) && !source.isNull(key)) {
            target.put(key, source.get(key));
        }
    }

    private void copyFirstJsonField(JSONObject target, JSONObject source, String targetKey, String... sourceKeys)
            throws JSONException {
        for (String sourceKey : sourceKeys) {
            if (source.has(sourceKey) && !source.isNull(sourceKey)) {
                target.put(targetKey, source.get(sourceKey));
                return;
            }
        }
    }

    /**
     * Check if BLE transfer is currently in progress. Used for cooldown mechanism to reject new
     * photo requests.
     */
    public boolean isBleTransferInProgress() {
        return mServiceCallback != null && mServiceCallback.isBleTransferInProgress();
    }

    /** Get BLE connection state for error diagnostics */
    private JSONObject getBleConnectionState() {
        JSONObject ble = new JSONObject();
        try {
            boolean transferInProgress =
                    mServiceCallback != null && mServiceCallback.isBleTransferInProgress();
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
     * Start monitoring battery during video recording. Stops recording if battery drops below
     * minimum threshold.
     */
    private void startBatteryMonitoring() {
        assertMainThread();

        // Early return if StateManager not available (will be retried by runnable)
        if (mStateManager == null) {
            Log.w(
                    TAG,
                    "⚠️ StateManager not set - cannot start battery monitoring (will retry if StateManager becomes available)");
            // Note: We don't return here because the runnable will check again later
            // This allows monitoring to start even if StateManager is set after recording begins
        }

        stopBatteryMonitoring(); // Clean up any existing monitor

        if (mBatteryMonitorHandler == null) {
            mBatteryMonitorHandler = new Handler(Looper.getMainLooper());
        }

        mBatteryCheckRunnable =
                new Runnable() {
                    @Override
                    public void run() {
                        if (isRecordingVideo) {
                            // Use hardwareManager for active BES battery query (not stale
                            // StateManager cache)
                            if (hardwareManager == null) {
                                Log.w(
                                        TAG,
                                        "⚠️ HardwareManager not available during battery monitoring - skipping check");
                                if (isRecordingVideo && mBatteryMonitorHandler != null) {
                                    mBatteryMonitorHandler.postDelayed(
                                            this, BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
                                }
                                return;
                            }

                            int batteryLevel = hardwareManager.getBatteryLevel();

                            if (batteryLevel >= 0
                                    && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                                Log.w(
                                        TAG,
                                        "🔋⚠️ Battery dropped to "
                                                + batteryLevel
                                                + "% during recording - stopping");

                                // Stop with specific reason - prevents duplicate feedback
                                stopVideoRecording(StopReason.LOW_BATTERY);

                            } else {
                                // Check again after interval
                                mBatteryMonitorHandler.postDelayed(
                                        this, BatteryConstants.BATTERY_CHECK_INTERVAL_MS);
                            }
                        }
                    }
                };

        // Start monitoring after first interval
        mBatteryMonitorHandler.postDelayed(
                mBatteryCheckRunnable, BatteryConstants.BATTERY_CHECK_INTERVAL_MS);

        Log.d(TAG, "🔋 Started battery monitoring for video recording");
    }

    /** Stop battery monitoring. Safe to call multiple times. */
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
     * Cleanup resources and stop all monitoring. MUST be called before service is destroyed to
     * prevent leaks.
     */
    public void cleanup() {
        assertMainThread();
        Log.d(TAG, "🧹 MediaCaptureService cleanup() called");
        isCleaningUp.set(true);

        try {
            // Stop battery monitoring
            stopBatteryMonitoring();

            // Stop any active recording
            if (isRecordingVideo) {
                Log.w(TAG, "⚠️ Video still recording during cleanup - force stopping");
                stopVideoRecording(StopReason.ERROR);
            }

            // Nuclear cleanup of handlers
            if (mBatteryMonitorHandler != null) {
                mBatteryMonitorHandler.removeCallbacksAndMessages(null);
                mBatteryMonitorHandler = null;
            }

            videoIntegrityExecutor.shutdown();
            try {
                if (!videoIntegrityExecutor.awaitTermination(3, TimeUnit.SECONDS)) {
                    videoIntegrityExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                videoIntegrityExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            videoCaptureIdsInFlight.clear();
            videoCaptureIdsPendingIntegrityCheck.clear();
            // Defensive: drop any pending upload targets so no auth token survives teardown and the
            // map can't grow without bound if a terminal path ever failed to consume its entry.
            uploadTargetsByCaptureId.clear();

            Log.d(TAG, "✅ MediaCaptureService cleanup complete");

        } catch (Exception e) {
            Log.e(TAG, "💥 Error during MediaCaptureService cleanup", e);
            // Don't rethrow - cleanup should be best-effort
        }
    }

    /**
     * Send gallery status update to phone after photo capture Uses GalleryStatusHelper to avoid
     * code duplication with GalleryCommandHandler
     */
    private void sendGalleryStatusUpdate() {
        try {
            Log.d(TAG, "📸 Sending gallery status update after photo capture");

            if (fileManager == null) {
                Log.w(TAG, "📸 Cannot send gallery status: FileManager not available");
                return;
            }

            // Snapshot sync-block state so the broadcast hides the same captures that the
            // HTTP server hides (in-flight recordings, pending integrity checks, zero-byte
            // primaries).
            final String activeCaptureId = getActiveRecordingCaptureId();
            final java.util.Set<String> blockedCaptureIds = getPendingVideoIntegrityCaptureIds();

            // Build gallery status using shared utility with sync-safe filters
            JSONObject response =
                    GalleryStatusHelper.buildGalleryStatus(
                            fileManager,
                            metadata ->
                                    !GallerySyncFilter.isCaptureBlockedFromSync(
                                                    metadata.getFileName(),
                                                    activeCaptureId,
                                                    blockedCaptureIds)
                                            && !GallerySyncFilter.isZeroBytePrimaryVideo(
                                                    metadata.getFileName(),
                                                    metadata.getFileSize()));

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
}
