package com.mentra.asg_client.io.media.core;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.camera.lifecycle.PhotoExifMetadataWriter;
import com.mentra.asg_client.camera.model.CameraOperationError;
import com.mentra.asg_client.camera.model.CapturedPhoto;
import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.camera.policy.PhotoMode;
import com.mentra.asg_client.camera.policy.PhotoSizeTier;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;
import com.mentra.asg_client.io.media.core.textdetect.MlKitTextRoiDetector;
import com.mentra.asg_client.io.media.interfaces.ServiceCallbackInterface;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.media.upload.MediaUploadService;
import com.mentra.asg_client.io.media.utils.VideoThumbnailWriter;
import com.mentra.asg_client.io.storage.StorageManager;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.service.core.CameraRestartCooldown;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.utils.CaptureRequestId;
import com.mentra.asg_client.utils.GalleryStatusHelper;
import com.mentra.asg_client.utils.GallerySyncFilter;

import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import org.json.JSONException;
import org.json.JSONObject;

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
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

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

    private final Context mContext;
    private final MediaUploadQueueManager mMediaQueueManager;
    private MediaCaptureListener mMediaCaptureListener;
    private ServiceCallbackInterface mServiceCallback;
    private final IHardwareManager hardwareManager;
    private final MlKitTextRoiDetector textRoiDetector;

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
    // means: the FIRST stop for a recording wins (putIfAbsent), so a user stop that races or
    // follows
    // an auto-stop can't turn a "no upload" auto-stop into an upload; a new recording (different
    // captureId) can't overwrite a prior recording's still-pending target; and every
    // onRecordingStopped
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

    /**
     * Stop-time upload target bound to a specific recording. Empty/null webhook = keep on device.
     */
    private static final class UploadTarget {
        final String webhookUrl;
        final String authToken;

        UploadTarget(String webhookUrl, String authToken) {
            this.webhookUrl = webhookUrl;
            this.authToken = authToken;
        }
    }

    private final class VideoThumbnailTask
            implements Runnable, VideoThumbnailWriter.SidecarCommitter {
        private final File videoFile;
        private final Object commitLock = new Object();
        private volatile Future<?> execution;
        private boolean discarded;

        VideoThumbnailTask(String filePath) {
            videoFile = new File(filePath);
        }

        void setExecution(Future<?> execution) {
            this.execution = execution;
        }

        @Override
        public void run() {
            try {
                VideoThumbnailWriter.writeSidecar(videoFile, this);
            } finally {
                videoThumbnailTasks.remove(videoFile.getAbsolutePath(), this);
            }
        }

        @Override
        public boolean commit(File partial, File sidecar) {
            synchronized (commitLock) {
                return !discarded && videoFile.isFile() && partial.renameTo(sidecar);
            }
        }

        boolean discardAndDeleteVideo() {
            synchronized (commitLock) {
                boolean deleted = !videoFile.exists() || videoFile.delete();
                if (!deleted) {
                    return false;
                }
                discarded = true;
                Future<?> currentExecution = execution;
                if (currentExecution != null) {
                    currentExecution.cancel(true);
                }
                VideoThumbnailWriter.deleteSidecar(videoFile);
                return true;
            }
        }

        void cancelThumbnailWrite() {
            synchronized (commitLock) {
                discarded = true;
                Future<?> currentExecution = execution;
                if (currentExecution != null) {
                    currentExecution.cancel(true);
                }
            }
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
                // Smallest/fastest tier: readable large text at minimal payload
                return new BleParams(
                        AsgConstants.BLE_PHOTO_LOW_TARGET_PX,
                        AsgConstants.BLE_PHOTO_LOW_TARGET_PX,
                        AsgConstants.BLE_PHOTO_LOW_AVIF_QUALITY);
            case "high":
                // Document text comfortably readable, payload still capped for BLE throughput
                return new BleParams(
                        AsgConstants.BLE_PHOTO_HIGH_TARGET_PX,
                        AsgConstants.BLE_PHOTO_HIGH_TARGET_PX,
                        AsgConstants.BLE_PHOTO_HIGH_AVIF_QUALITY);
            case "max":
                // Largest BLE tier; still capped well below the sensor's native resolution
                return new BleParams(
                        AsgConstants.BLE_PHOTO_MAX_TARGET_PX,
                        AsgConstants.BLE_PHOTO_MAX_TARGET_PX,
                        AsgConstants.TEXT_MODE_AVIF_QUALITY);
            case "medium":
            default:
                // Default balance of legibility and transfer time
                return new BleParams(
                        AsgConstants.BLE_PHOTO_MEDIUM_TARGET_PX,
                        AsgConstants.BLE_PHOTO_MEDIUM_TARGET_PX,
                        AsgConstants.BLE_PHOTO_MEDIUM_AVIF_QUALITY);
        }
    }

    private BleParams resolveTextModeBleParams(boolean hasUsableTextCrop) {
        return new BleParams(
                hasUsableTextCrop
                        ? AsgConstants.TEXT_MODE_BLE_TARGET_WIDTH
                        : AsgConstants.TEXT_MODE_BLE_FALLBACK_TARGET_WIDTH,
                hasUsableTextCrop
                        ? AsgConstants.TEXT_MODE_BLE_TARGET_HEIGHT
                        : AsgConstants.TEXT_MODE_BLE_FALLBACK_TARGET_HEIGHT,
                AsgConstants.TEXT_MODE_AVIF_QUALITY);
    }

    private static final class TextRegionDetection {
        @Nullable final android.graphics.Rect roi;
        @Nullable final String confidence;
        @Nullable final String reason;
        final String outcome;

        TextRegionDetection(
                @Nullable android.graphics.Rect roi,
                @Nullable String confidence,
                @Nullable String reason,
                String outcome) {
            this.roi = roi;
            this.confidence = confidence;
            this.reason = reason;
            this.outcome = outcome;
        }
    }

    @Nullable
    private TextRegionDetection runTextRegionDetection(String originalPath) {
        return runTextRegionDetection(null, originalPath);
    }

    /** Runs detection from the in-memory JPEG when available, else from {@code originalPath}. */
    @Nullable
    private TextRegionDetection runTextRegionDetection(
            @Nullable byte[] jpegBytes, String originalPath) {
        MlKitTextRoiDetector.Detection detection =
                jpegBytes != null
                        ? textRoiDetector.detect(jpegBytes)
                        : textRoiDetector.detect(originalPath);
        boolean hasRoi = detection.roi != null;
        String outcome =
                hasRoi
                        ? "SUCCESS (ML Kit localized "
                                + detection.lineCount
                                + " line(s) in "
                                + detection.elapsedMs
                                + "ms)"
                        : "FULL_FRAME (ML Kit reason="
                                + detection.reason
                                + ", "
                                + detection.elapsedMs
                                + "ms)";
        Log.i(
                TAG,
                "✂️ ML KIT CROP OUTCOME: "
                        + outcome
                        + " source="
                        + detection.sourceWidth
                        + "x"
                        + detection.sourceHeight
                        + " analysis="
                        + detection.analysisWidth
                        + "x"
                        + detection.analysisHeight
                        + " roi="
                        + (detection.roi != null ? detection.roi.toShortString() : "full"));
        return new TextRegionDetection(
                detection.roi, hasRoi ? "HIGH" : "NONE", detection.reason, outcome);
    }

    private android.graphics.Bitmap cropBitmapToDetectedRoi(
            android.graphics.Bitmap original,
            @Nullable android.graphics.Rect roi,
            String textCropOutcome) {
        int originalWidth = original.getWidth();
        int originalHeight = original.getHeight();
        if (roi == null) {
            Log.i(
                    TAG,
                    "✂️ CROP SKIPPED: no ROI (detection disabled, failed, or low-confidence"
                            + " fallback), using full frame "
                            + originalWidth
                            + "x"
                            + originalHeight
                            + " - outcome: "
                            + textCropOutcome);
            return original;
        }

        android.graphics.Rect bounds =
                new android.graphics.Rect(0, 0, original.getWidth(), original.getHeight());
        android.graphics.Rect clamped = new android.graphics.Rect(roi);
        if (!clamped.intersect(bounds) || clamped.width() <= 0 || clamped.height() <= 0) {
            Log.i(
                    TAG,
                    "✂️ CROP SKIPPED: roi did not intersect original bounds, using full frame "
                            + originalWidth
                            + "x"
                            + originalHeight
                            + " - outcome: "
                            + textCropOutcome);
            return original;
        }

        android.graphics.Bitmap cropped =
                android.graphics.Bitmap.createBitmap(
                        original, clamped.left, clamped.top, clamped.width(), clamped.height());
        if (cropped != original) {
            original.recycle();
        }
        Log.i(
                TAG,
                "✂️ CROP APPLIED: "
                        + originalWidth
                        + "x"
                        + originalHeight
                        + " -> "
                        + cropped.getWidth()
                        + "x"
                        + cropped.getHeight()
                        + " (roi="
                        + clamped.toShortString()
                        + ", "
                        + Math.round(
                                100.0
                                        * (1.0
                                                - (cropped.getWidth() * cropped.getHeight())
                                                        / (double)
                                                                (originalWidth * originalHeight)))
                        + "% pixel reduction) - outcome: "
                        + textCropOutcome);
        return cropped;
    }

    @Nullable
    private String writeCroppedBitmapToTempJpeg(
            String originalPath, @Nullable android.graphics.Rect roi, String requestId)
            throws java.io.IOException {
        if (roi == null) {
            Log.w(TAG, "Text-mode detector returned no ROI; preserving the camera JPEG");
            return null;
        }
        android.graphics.Bitmap original = android.graphics.BitmapFactory.decodeFile(originalPath);
        if (original == null) {
            return null;
        }
        android.graphics.Bitmap cropped =
                cropBitmapToDetectedRoi(original, roi, "WiFi text-mode upload crop");
        String croppedPath = originalPath.replace(".jpg", "_textcrop_" + requestId + ".jpg");
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(croppedPath)) {
            if (!cropped.compress(
                    android.graphics.Bitmap.CompressFormat.JPEG,
                    AsgConstants.TEXT_MODE_BLE_JPEG_QUALITY,
                    fos)) {
                throw new java.io.IOException("Failed to write text-mode cropped JPEG");
            }
        } finally {
            if (cropped != original) {
                cropped.recycle();
            } else {
                original.recycle();
            }
        }
        PhotoExifMetadataWriter.copyImuMetadata(originalPath, croppedPath);
        return croppedPath;
    }

    private String prepareTextModePhotoPath(String photoFilePath, String requestId) {
        String mode = PhotoMode.normalize(photoRequestedModes.get(requestId));
        if (!PhotoMode.TEXT.equals(mode)
                || Boolean.TRUE.equals(photoTextCropPrepared.get(requestId))) {
            return photoFilePath;
        }

        Log.d(TAG, "✂️ Text mode: preparing the canonical cropped photo before transfer");
        TextRegionDetection detection = runTextRegionDetection(photoFilePath);
        try {
            String croppedPath =
                    writeCroppedBitmapToTempJpeg(photoFilePath, detection.roi, requestId);
            if (croppedPath != null) {
                PhotoArtifactFiles.promoteToCanonical(photoFilePath, croppedPath);
                photoTextCropPrepared.put(requestId, true);
                photoTextCropApplied.put(requestId, true);
                return photoFilePath;
            }
        } catch (java.io.IOException e) {
            Log.w(TAG, "Text-mode crop failed, transferring original frame: " + e.getMessage(), e);
        }
        return photoFilePath;
    }

    /**
     * Persists the final text-mode selection without first writing the sensor JPEG. A successful
     * detection writes only the full-resolution ROI. Detection/crop failure is the one case that
     * writes the retained sensor JPEG as the safe full-frame fallback.
     */
    private boolean persistTextModeSelectionFromMemory(
            CapturedPhoto capturedPhoto,
            String canonicalPath,
            String requestId,
            @Nullable android.graphics.Rect roi) {
        return persistTextModeSelectionFromMemory(
                capturedPhoto, canonicalPath, canonicalPath, requestId, roi, true);
    }

    private boolean persistTextModeSelectionFromMemory(
            CapturedPhoto capturedPhoto,
            String canonicalPath,
            String intendedCapturePath,
            String requestId,
            @Nullable android.graphics.Rect roi,
            boolean writeSidecar) {
        String preparedPath = canonicalPath.replace(".jpg", "_textselected_" + requestId + ".jpg");
        File preparedFile = new File(preparedPath);
        File parent = preparedFile.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            Log.e(TAG, "Could not create text-mode gallery directory: " + parent);
            return false;
        }

        boolean wroteCrop = false;
        android.graphics.Bitmap selected = null;
        if (roi != null) {
            try {
                android.graphics.BitmapFactory.Options bounds =
                        new android.graphics.BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                android.graphics.BitmapFactory.decodeByteArray(
                        capturedPhoto.jpegBytes, 0, capturedPhoto.jpegBytes.length, bounds);
                if (bounds.outWidth > 0 && bounds.outHeight > 0) {
                    android.graphics.Rect sourceRegion =
                            clampRoiToBounds(roi, bounds.outWidth, bounds.outHeight);
                    selected =
                            decodeJpegRegion(
                                    capturedPhoto.jpegBytes,
                                    canonicalPath,
                                    sourceRegion,
                                    new android.graphics.BitmapFactory.Options());
                    if (selected == null) {
                        selected = decodeFullJpegAndCrop(capturedPhoto.jpegBytes, sourceRegion);
                    }
                }
                if (selected != null) {
                    try (FileOutputStream output = new FileOutputStream(preparedFile)) {
                        wroteCrop =
                                selected.compress(
                                        android.graphics.Bitmap.CompressFormat.JPEG,
                                        AsgConstants.TEXT_MODE_BLE_JPEG_QUALITY,
                                        output);
                    }
                }
            } catch (Exception error) {
                Log.w(TAG, "Could not persist text ROI; saving full-frame fallback", error);
            } finally {
                if (selected != null) {
                    selected.recycle();
                }
            }
        }

        try {
            if (!wroteCrop) {
                try (FileOutputStream output = new FileOutputStream(preparedFile)) {
                    output.write(capturedPhoto.jpegBytes);
                }
                Log.w(
                        TAG,
                        "Text mode saved retained full frame because no usable ROI was available");
            }

            // Metadata is best-effort; failure must not discard an otherwise valid selected image.
            PhotoExifMetadataWriter.writeCaptureIdFromPath(preparedPath, intendedCapturePath);
            if (capturedPhoto.imuPayload != null) {
                try {
                    PhotoExifMetadataWriter.writeImuPayload(preparedPath, capturedPhoto.imuPayload);
                } catch (java.io.IOException metadataError) {
                    Log.w(TAG, "Could not embed IMU metadata in text-mode photo", metadataError);
                }
            }

            PhotoArtifactFiles.promoteToCanonical(canonicalPath, preparedPath);
            if (writeSidecar && capturedPhoto.imuPayload != null && parent != null) {
                File sidecar = new File(parent, "imu.json");
                try (FileOutputStream output = new FileOutputStream(sidecar)) {
                    output.write(
                            capturedPhoto
                                    .imuPayload
                                    .toString()
                                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                } catch (java.io.IOException sidecarError) {
                    Log.w(TAG, "Could not persist text-mode IMU sidecar", sidecarError);
                }
            }
            photoTextCropPrepared.put(requestId, true);
            photoTextCropApplied.put(requestId, wroteCrop);
            Log.i(
                    TAG,
                    wroteCrop
                            ? "Text mode persisted cropped gallery output: " + canonicalPath
                            : "Text mode persisted full-frame fallback: " + canonicalPath);
            return true;
        } catch (java.io.IOException error) {
            Log.e(TAG, "Could not persist final text-mode photo", error);
            PhotoArtifactFiles.deleteTransportTemporary(canonicalPath, preparedPath);
            return false;
        }
    }

    // Track which photos should be saved to gallery
    private Map<String, Boolean> photoSaveFlags = new HashMap<>();

    // Track BLE IDs for auto fallback mode
    private Map<String, String> photoBleIds = new HashMap<>();

    // Track original photo paths for BLE fallback
    private Map<String, String> photoOriginalPaths = new HashMap<>();
    // True after text mode has selected either a crop or the full-frame fallback for transfer.
    private Map<String, Boolean> photoTextCropPrepared = new HashMap<>();
    // True only when the canonical text-mode selection is an actual detected-text crop.
    private Map<String, Boolean> photoTextCropApplied = new HashMap<>();
    // Track requested photo size per request for proper fallback handling
    private Map<String, String> photoRequestedSizes = new HashMap<>();
    // Track capture mode through asynchronous WiFi-to-BLE fallback.
    private Map<String, String> photoRequestedModes = new HashMap<>();

    private String finalPhotoPath(String requestId, String fallbackPath) {
        String path = photoOriginalPaths.get(requestId);
        return path == null || path.isEmpty() ? fallbackPath : path;
    }

    private void cleanupPhotoArtifacts(String requestId, String transportPath, boolean keepFinal) {
        String canonicalPath = finalPhotoPath(requestId, transportPath);
        PhotoArtifactFiles.cleanup(canonicalPath, transportPath, keepFinal);
        Log.d(
                TAG,
                keepFinal
                        ? "💾 Kept final photo and removed transport temporaries: " + canonicalPath
                        : "🗑️ Removed final photo and transport temporaries for " + requestId);
    }

    private void deletePhotoTransportTemporary(String requestId, String transportPath) {
        PhotoArtifactFiles.deleteTransportTemporary(
                finalPhotoPath(requestId, transportPath), transportPath);
    }

    /** Clear request-scoped photo state after capture/upload/BLE handoff. */
    private void clearPhotoRequestTracking(String requestId) {
        photoSaveFlags.remove(requestId);
        photoBleIds.remove(requestId);
        photoOriginalPaths.remove(requestId);
        photoTextCropPrepared.remove(requestId);
        photoTextCropApplied.remove(requestId);
        photoRequestedSizes.remove(requestId);
        photoRequestedModes.remove(requestId);
    }

    /** Clear all request state, including timing data, on a terminal non-BLE exit. */
    private void clearPhotoTracking(String requestId) {
        clearPhotoRequestTracking(requestId);
        // markBlePhotoPipelineStart() seeds blePhotoPipelineStartMs/photoTimings whenever a
        // bleImgId is present, even if the capture ultimately resolves over WiFi. Non-BLE terminal
        // exits reclaim those speculative entries here. A successful BLE handoff uses
        // clearPhotoRequestTracking() instead so transfer_complete can still report end-to-end
        // timing.
        clearBlePhotoTimingTracking(requestId);
    }

    /** Clear BLE timing and transfer-correlation state without touching capture artifacts. */
    private void clearBlePhotoTimingTracking(String requestId) {
        blePhotoPipelineStartMs.remove(requestId);
        photoTimings.remove(requestId);
        photoTimingDetails.remove(requestId);
        bleImgIdToRequestId.entrySet().removeIf(entry -> requestId.equals(entry.getValue()));
    }

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

    /** Keeps best-effort thumbnail decoding from delaying integrity callbacks or uploads. */
    private final ExecutorService videoThumbnailExecutor =
            Executors.newSingleThreadExecutor(
                    r -> {
                        Thread t = new Thread(r, "VideoThumbnailWriter");
                        t.setPriority(Thread.NORM_PRIORITY - 1);
                        t.setDaemon(true);
                        return t;
                    });
    private final ConcurrentHashMap<String, VideoThumbnailTask> videoThumbnailTasks =
            new ConcurrentHashMap<>();
    private final Object videoThumbnailLifecycleLock = new Object();

    /**
     * Keeps ML Kit and final-crop persistence off CameraNeo's shared callback executor. A single
     * worker preserves burst ordering and avoids running multiple memory-heavy full-resolution
     * crops at once.
     */
    private final ExecutorService textModeProcessingExecutor =
            Executors.newSingleThreadExecutor(
                    r -> {
                        Thread t = new Thread(r, "TextModeProcessing");
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

    // Per-request timing instrumentation (gated by AsgConstants.ENABLE_PHOTO_TIMING_LOGS)
    private final Map<String, Map<String, Long>> photoTimings = new ConcurrentHashMap<>();
    /** Optional per-step detail strings shown in PHASE BREAKDOWN (exposure/ISO/size/etc.). */
    private final Map<String, Map<String, String>> photoTimingDetails = new ConcurrentHashMap<>();

    /** Wall-clock start for BLE photo pipeline (request received on glasses). */
    private final Map<String, Long> blePhotoPipelineStartMs = new ConcurrentHashMap<>();

    /** Maps BLE transfer filename (bleImgId) back to the originating requestId. */
    private final Map<String, String> bleImgIdToRequestId = new ConcurrentHashMap<>();

    /**
     * Counts BLE payload encode invocations per request. There should only ever be exactly one
     * (whichever codec {@link BlePhotoEncodingPolicy} selects) — this exists purely to detect and
     * quantify a regression back to the old dual JPEG+AVIF encode path.
     */
    private final Map<String, Integer> bleEncodeInvocationCount = new ConcurrentHashMap<>();

    /** Cumulative encoder time (ms) actually spent per request, across all encode calls. */
    private final Map<String, Long> bleEncodeTotalMs = new ConcurrentHashMap<>();

    /** Original captured JPEG size on disk (bytes) per request. */
    private final Map<String, Long> bleOriginalBytes = new ConcurrentHashMap<>();

    /** Compressed BLE payload size (bytes) per request. */
    private final Map<String, Long> bleCompressedBytes = new ConcurrentHashMap<>();

    /** Source/crop/encode geometry used to attribute payload savings in BLE timing logs. */
    private final Map<String, BlePhotoTimingLog.PayloadReductionStats> blePayloadReductionStats =
            new ConcurrentHashMap<>();

    /** Warm-session reuse + sensor JPEG size for the end-of-pipeline PHASE SUMMARY. */
    private final Map<String, BlePhotoTimingLog.CaptureSessionStats> bleCaptureSessionStats =
            new ConcurrentHashMap<>();

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
        textRoiDetector = new MlKitTextRoiDetector(mContext);

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
     * @param captureSettings per-request tuning (including resolved {@code zsl}/{@code mfnr}) for warmth
     */
    private void playShutterSound(
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            @Nullable PhotoCaptureSettings captureSettings) {
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
        boolean cameraWarm =
                CameraNeoService.isCameraWarm(size, isFromSdk, exposureTimeNs, captureSettings);
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
                    "🎥 Video recording LED (solid white) triggered via hardware manager at"
                            + " brightness "
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
                                                                        + " minutes), stopping"
                                                                        + " recording");
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

                            // Consume this recording's upload decision exactly once, up front, so
                            // it
                            // is dropped on every exit path below (null file path, cleanup,
                            // integrity
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
                                        "Skipping video integrity check because cleanup is already"
                                                + " in progress");
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
                                                if (ok) {
                                                    scheduleVideoThumbnail(filePath);
                                                }
                                                mainHandler.post(
                                                        () -> {
                                                            videoCaptureIdsPendingIntegrityCheck
                                                                    .remove(captureId);
                                                            // Upload target was captured up front
                                                            // and bound to this recording's
                                                            // captureId; null = keep on device.
                                                            final String uploadWebhookUrl =
                                                                    uploadTarget != null
                                                                            ? uploadTarget
                                                                                    .webhookUrl
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
                                                                                "Could not delete"
                                                                                    + " failed"
                                                                                    + " video file:"
                                                                                    + " "
                                                                                        + filePath);
                                                                    }
                                                                } else {
                                                                    Log.w(
                                                                            TAG,
                                                                            "Skipping failed video"
                                                                                + " deletion"
                                                                                + " because cleanup"
                                                                                + " is in"
                                                                                + " progress");
                                                                }
                                                                if (mMediaCaptureListener != null) {
                                                                    mMediaCaptureListener
                                                                            .onMediaError(
                                                                                    pendingRequestId,
                                                                                    cleaningUp
                                                                                            ? "Video"
                                                                                                  + " integrity"
                                                                                                  + " check"
                                                                                                  + " aborted"
                                                                                                  + " during"
                                                                                                  + " cleanup;"
                                                                                                  + " file"
                                                                                                  + " preserved"
                                                                                            : "Video"
                                                                                                  + " file"
                                                                                                  + " failed"
                                                                                                  + " integrity"
                                                                                                  + " check"
                                                                                                  + " and was"
                                                                                                  + " removed",
                                                                                    MediaUploadQueueManager
                                                                                            .MEDIA_TYPE_VIDEO);
                                                                }
                                                                sendGalleryStatusUpdate();
                                                            }
                                                        });
                                            } catch (Throwable t) {
                                                Log.e(
                                                        TAG,
                                                        "Unexpected error during video integrity"
                                                                + " check",
                                                        t);
                                                mainHandler.post(
                                                        () -> {
                                                            videoCaptureIdsPendingIntegrityCheck
                                                                    .remove(captureId);
                                                            if (mMediaCaptureListener != null) {
                                                                mMediaCaptureListener.onMediaError(
                                                                        pendingRequestId,
                                                                        "Video integrity check"
                                                                                + " error: "
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
                                        "Video integrity check rejected because cleanup is in"
                                                + " progress",
                                        e);
                                videoCaptureIdsPendingIntegrityCheck.remove(captureId);
                                mainHandler.post(
                                        () -> {
                                            if (mMediaCaptureListener != null) {
                                                mMediaCaptureListener.onMediaError(
                                                        pendingRequestId,
                                                        "Video integrity check unavailable during"
                                                                + " cleanup",
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
     * <p>The reason guard + {@code mCurrentStopReason} write are serialized under {@link
     * #mStopLock}. The upload target is registered only once the stop is actually dispatched to the
     * recorder (below the "not recording" guard), keyed by the recording's captureId via {@code
     * putIfAbsent} (first-stop-wins): only a {@code USER_REQUESTED} stop carries a webhook, and a
     * stop already in progress — or a user stop racing/following an auto-stop that already
     * committed to "no upload" — can't flip the outcome. The entry is consumed in {@code
     * onRecordingStopped} and dropped on every other terminal path ({@code onRecordingError}, the
     * catch below, {@code cleanup}).
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

            // Bind the upload decision to this recording's captureId, first-stop-wins, only now
            // that
            // the stop is actually being dispatched to the recorder — so an early-return above can
            // never orphan it. Only a USER_REQUESTED stop may upload; any auto-stop
            // (battery/max-duration/error) registers a "no upload" decision. putIfAbsent means a
            // later or racing stop (e.g. a user stop landing after an auto-stop already committed
            // to
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
            // so drop this recording's upload target here to mirror
            // onRecordingStopped/onRecordingError.
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
     * Stop the active recording and upload the result to {@code webhookUrl} via multipart,
     * mirroring the photo snapshot flow. The webhook URL + auth token are supplied at STOP time so
     * the token is fresh when the upload runs. An empty/null webhook keeps the video on device (no
     * upload).
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
        if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
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
                PhotoCaptureSettings.mergeWithStoredDefaults(
                        PhotoCaptureSettings.EMPTY, asgSettings);
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
                playShutterSound(size, false, null, captureSettings);
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
                        if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
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
                        onPhotoError(CameraOperationError.captureFailed(errorMessage));
                    }

                    @Override
                    public void onPhotoError(CameraOperationError error) {
                        Log.e(TAG, "Failed to capture offline photo: " + error.message());
                        sendPhotoStatus(requestId, "failed", null, error.code(), error.message());

                        // LED is now managed by CameraNeoService and will turn off when camera
                        // closes

                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onMediaError(
                                    requestId,
                                    error.message(),
                                    MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                        }
                    }
                });
    }

    /**
     * Capture a photo that is only saved to the gallery: an SDK take_photo with save=true and no
     * upload target. Ordinary photos bypass the single-flight photo-job gate and enqueue straight
     * into the camera queue, exactly like button photos. Text mode remains single-flight through
     * detection and final persistence so bursts cannot retain an unbounded queue of sensor JPEGs.
     * The terminal photo_response carries the captureId (the requestId-stamped capture directory
     * name) for sync-time correlation.
     */
    public boolean takePhotoForLocalSave(
            String photoFilePath,
            String requestId,
            String size,
            String mode,
            boolean enableFlash,
            boolean enableSound,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (captureSettings == null) {
            captureSettings = PhotoCaptureSettings.EMPTY;
        }
        final boolean textModeRequested = PhotoMode.TEXT.equals(mode);
        String captureSize = PhotoMode.captureSize(mode, size);

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

        if (textModeRequested && !acquirePhotoJob(requestId)) {
            Log.w(TAG, "Text-mode local-save job already in flight: " + requestId);
            sendPhotoErrorResponse(
                    requestId, "CAMERA_BUSY", "Another photo job is in progress");
            return false;
        }
        if (textModeRequested) {
            startCaptureSafetyTimeout(requestId);
            textRoiDetector.warmUp();
        }

        Log.i(
                TAG,
                "📸 take_photo (local-save) accepted requestId="
                        + requestId
                        + " size="
                        + size
                        + " captureSize="
                        + captureSize
                        + " mode="
                        + mode
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
                playShutterSound(captureSize, true, exposureTimeNs, captureSettings);
            }
            if (enableFlash) {
                flashPrivacyLedForPhoto();
            }
        }

        try {
            CameraNeoService.enqueuePhotoRequest(
                    mContext,
                    photoFilePath,
                    captureSize,
                    enableFlash,
                    true, // isFromSdk — honor the SDK size tier
                    exposureTimeNs,
                    iso,
                    captureSettings,
                    textModeRequested,
                    !textModeRequested,
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
                            onPhotoCaptured(filePath, captureMetadata, null);
                        }

                        @Override
                        public void onPhotoCaptured(
                                String filePath,
                                JSONObject captureMetadata,
                                CapturedPhoto capturedPhoto) {
                            if (textModeRequested) {
                                if (capturedPhoto == null) {
                                    try {
                                        clearPhotoTracking(requestId);
                                        sendPhotoErrorResponse(
                                                requestId,
                                                "PHOTO_SAVE_FAILED",
                                                "Text-mode capture was not available in memory");
                                    } finally {
                                        releasePhotoJob(requestId);
                                    }
                                    return;
                                }
                                try {
                                    textModeProcessingExecutor.execute(
                                            () -> {
                                                try {
                                                    TextRegionDetection detection =
                                                            runTextRegionDetection(
                                                                    capturedPhoto.jpegBytes,
                                                                    filePath);
                                                    if (!persistTextModeSelectionFromMemory(
                                                            capturedPhoto,
                                                            filePath,
                                                            requestId,
                                                            detection.roi)) {
                                                        clearPhotoTracking(requestId);
                                                        sendPhotoErrorResponse(
                                                                requestId,
                                                                "PHOTO_SAVE_FAILED",
                                                                "Could not save final text-mode"
                                                                        + " output");
                                                        return;
                                                    }
                                                    finishLocalSavePhoto(
                                                            requestId,
                                                            captureId,
                                                            filePath,
                                                            captureMetadata);
                                                } catch (RuntimeException processingError) {
                                                    Log.e(
                                                            TAG,
                                                            "Local text-mode processing failed for "
                                                            + requestId,
                                                            processingError);
                                                    clearPhotoTracking(requestId);
                                                    sendPhotoErrorResponse(
                                                            requestId,
                                                            "PHOTO_SAVE_FAILED",
                                                            "Could not save final text-mode output");
                                                } finally {
                                                    releasePhotoJob(requestId);
                                                }
                                            });
                                } catch (RejectedExecutionException executorClosed) {
                                    try {
                                        clearPhotoTracking(requestId);
                                        sendPhotoErrorResponse(
                                                requestId,
                                                "PHOTO_SAVE_FAILED",
                                                "Text-mode processing stopped during service"
                                                        + " cleanup");
                                    } finally {
                                        releasePhotoJob(requestId);
                                    }
                                }
                                return;
                            }
                            finishLocalSavePhoto(
                                    requestId, captureId, filePath, captureMetadata);
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            onPhotoError(CameraOperationError.captureFailed(errorMessage));
                        }

                        @Override
                        public void onPhotoError(CameraOperationError error) {
                            try {
                                Log.e(
                                        TAG,
                                        "Failed to capture local-save photo: " + error.message());
                                sendPhotoErrorResponse(requestId, error.code(), error.message());

                                if (mMediaCaptureListener != null) {
                                    mMediaCaptureListener.onMediaError(
                                            requestId,
                                            error.message(),
                                            MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                                }
                            } finally {
                                if (textModeRequested) {
                                    clearPhotoTracking(requestId);
                                    releasePhotoJob(requestId);
                                }
                            }
                        }
                    });
            return true;
        } catch (Exception e) {
            try {
                Log.e(TAG, "Error taking local-save photo", e);
                sendPhotoErrorResponse(
                        requestId,
                        "CAMERA_CAPTURE_FAILED",
                        "Error taking photo: " + e.getMessage());
            } finally {
                if (textModeRequested) {
                    clearPhotoTracking(requestId);
                    releasePhotoJob(requestId);
                }
            }
            return false;
        }
    }

    private void finishLocalSavePhoto(
            String requestId, String captureId, String filePath, JSONObject captureMetadata) {
        try {
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
        } finally {
            clearPhotoRequestTracking(requestId);
        }
    }

    /**
     * Terminal success for a local-save capture: no uploadUrl (nothing was delivered); carries the
     * captureId so the caller can match the file at gallery-sync time.
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
            String mode,
            boolean enableFlash,
            boolean enableSound,
            String compress,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (captureSettings == null) {
            captureSettings = PhotoCaptureSettings.EMPTY;
        }
        final boolean textModeRequested = PhotoMode.TEXT.equals(mode);
        if (textModeRequested) {
            textRoiDetector.warmUp();
        }
        String captureSize = PhotoMode.captureSize(mode, size);
        // Start timing for end-to-end photo capture performance measurement
        final long requestStartTimeMs = System.currentTimeMillis();
        recordTiming(requestId, "request_start");
        if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
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
            clearPhotoTracking(requestId);
            return false;
        }

        // Check if camera HAL is restarting after FOV change
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            clearPhotoTracking(requestId);
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
                clearPhotoTracking(requestId);
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
            clearPhotoTracking(requestId);
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
        photoOriginalPaths.put(requestId, photoFilePath);
        // Track requested size for potential fallbacks
        photoRequestedSizes.put(requestId, size);
        photoRequestedModes.put(requestId, mode);

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
            cleanupPhotoArtifacts(requestId, photoFilePath, false);
            clearPhotoTracking(requestId);
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
                    playShutterSound(captureSize, true, exposureTimeNs, captureSettings);
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
                    captureSize,
                    enableFlash,
                    true, // isFromSdk - use optimized resolution for fast transfer
                    exposureTimeNs,
                    iso,
                    captureSettings,
                    textModeRequested,
                    !textModeRequested,
                    new CameraNeoService.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoConfigured(JSONObject resolvedConfig) {
                            logBlePhotoStep(
                                    requestId,
                                    "capture_configured",
                                    summarizeCaptureTimingDetail(
                                            "resolved", resolvedConfig, null));
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
                            logBlePhotoStep(
                                    requestId,
                                    "capture_started",
                                    summarizeCaptureTimingDetail(
                                            "requested",
                                            requestedCaptureConfig,
                                            meteredPreview));
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
                            if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
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
                                if (!save) {
                                    cleanupPhotoArtifacts(requestId, filePath, false);
                                }
                                sendPhotoSuccessResponse(requestId, "");
                                clearPhotoTracking(requestId);
                                releasePhotoJob(requestId);
                            }
                        }

                        @Override
                        public void onPhotoCaptured(
                                String filePath,
                                JSONObject captureMetadata,
                                CapturedPhoto capturedPhoto) {
                            if (!textModeRequested) {
                                onPhotoCaptured(filePath, captureMetadata);
                                return;
                            }
                            if (capturedPhoto == null) {
                                cleanupPhotoArtifacts(requestId, filePath, false);
                                clearPhotoTracking(requestId);
                                releasePhotoJob(requestId);
                                sendPhotoErrorResponse(
                                        requestId,
                                        "PHOTO_SAVE_FAILED",
                                        "Text-mode capture was not available in memory");
                                return;
                            }
                            try {
                                textModeProcessingExecutor.execute(
                                        () -> {
                                            try {
                                                TextRegionDetection detection =
                                                        runTextRegionDetection(
                                                                capturedPhoto.jpegBytes, filePath);
                                                String outputPath =
                                                        save
                                                                ? filePath
                                                                : transientTextUploadPath(filePath);
                                                if (!persistTextModeSelectionFromMemory(
                                                        capturedPhoto,
                                                        outputPath,
                                                        filePath,
                                                        requestId,
                                                        detection.roi,
                                                        save)) {
                                                    cleanupPhotoArtifacts(
                                                            requestId, filePath, false);
                                                    clearPhotoTracking(requestId);
                                                    releasePhotoJob(requestId);
                                                    sendPhotoErrorResponse(
                                                            requestId,
                                                            "PHOTO_SAVE_FAILED",
                                                            "Could not prepare text-mode upload");
                                                    return;
                                                }
                                                if (!save) {
                                                    photoOriginalPaths.put(requestId, outputPath);
                                                }
                                                onPhotoCaptured(outputPath, captureMetadata);
                                            } catch (RuntimeException processingError) {
                                                Log.e(
                                                        TAG,
                                                        "Text-mode processing failed for "
                                                                + requestId,
                                                        processingError);
                                                try {
                                                    cleanupPhotoArtifacts(
                                                            requestId, filePath, false);
                                                    clearPhotoTracking(requestId);
                                                    sendPhotoErrorResponse(
                                                            requestId,
                                                            "PHOTO_SAVE_FAILED",
                                                            "Could not prepare text-mode upload");
                                                } finally {
                                                    releasePhotoJob(requestId);
                                                }
                                            }
                                        });
                            } catch (RejectedExecutionException executorClosed) {
                                cleanupPhotoArtifacts(requestId, filePath, false);
                                clearPhotoTracking(requestId);
                                releasePhotoJob(requestId);
                                sendPhotoErrorResponse(
                                        requestId,
                                        "PHOTO_SAVE_FAILED",
                                        "Text-mode processing stopped during service cleanup");
                            }
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            onPhotoError(CameraOperationError.captureFailed(errorMessage));
                        }

                        @Override
                        public void onPhotoError(CameraOperationError error) {
                            cleanupPhotoArtifacts(requestId, photoFilePath, false);
                            clearPhotoTracking(requestId);
                            releasePhotoJob(requestId);

                            Log.e(TAG, "Failed to capture photo: " + error.message());
                            sendPhotoErrorResponse(requestId, error.code(), error.message());

                            // LED is now managed by CameraNeoService and will turn off when camera
                            // closes

                            dumpTimings(requestId);

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(
                                        requestId,
                                        error.message(),
                                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    });
            return true;
        } catch (Exception e) {
            cleanupPhotoArtifacts(requestId, photoFilePath, false);
            clearPhotoTracking(requestId);
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

    private String transientTextUploadPath(String intendedCapturePath) {
        File cacheDir = new File(mContext.getCacheDir(), "text_mode_uploads");
        if (!cacheDir.exists() && !cacheDir.mkdirs()) {
            Log.w(TAG, "Could not create text-mode upload cache: " + cacheDir);
        }
        File captureDir = new File(intendedCapturePath).getParentFile();
        String captureId = captureDir != null ? captureDir.getName() : "capture";
        return new File(cacheDir, captureId + ".jpg").getAbsolutePath();
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
                        clearBlePhotoTimingTracking(requestId);
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
     * Mark the start of a BLE photo pipeline when the take_photo command is received on glasses.
     * Subsequent steps log elapsed time from this point through AVIF compression and BLE transfer.
     */
    public void markBlePhotoPipelineStart(String requestId) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS || requestId == null || requestId.isEmpty()) {
            return;
        }
        blePhotoPipelineStartMs.put(requestId, System.currentTimeMillis());
        logBlePhotoStep(requestId, "request_received");
    }

    /**
     * Called when the phone confirms a BLE file transfer finished (transfer_complete command).
     * Dumps the full phase breakdown including end-to-end time from request_received.
     */
    public void onBlePhotoTransferComplete(String bleImgId, boolean success) {
        if (bleImgId == null || bleImgId.isEmpty()) {
            return;
        }
        String requestId = bleImgIdToRequestId.remove(bleImgId);
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
            return;
        }
        if (requestId == null) {
            Log.d(TAG, "⏱️ [BLE PHOTO] transfer_complete for unknown bleImgId=" + bleImgId);
            return;
        }
        logBlePhotoStep(requestId, success ? "ble_transfer_complete" : "ble_transfer_failed");
        Long pipelineStart = blePhotoPipelineStartMs.remove(requestId);
        long totalMs = pipelineStart != null ? System.currentTimeMillis() - pipelineStart : -1;
        Map<String, Long> phases = photoTimings.get(requestId);
        int encodeCalls = bleEncodeInvocationCount.getOrDefault(requestId, 0);
        long encodeTotalMs = bleEncodeTotalMs.getOrDefault(requestId, 0L);
        long originalBytes = bleOriginalBytes.getOrDefault(requestId, 0L);
        long compressedBytes = bleCompressedBytes.getOrDefault(requestId, 0L);
        BlePhotoTimingLog.PayloadReductionStats reduction =
                blePayloadReductionStats.get(requestId);
        BlePhotoTimingLog.CaptureSessionStats captureSession =
                bleCaptureSessionStats.get(requestId);
        BlePhotoTimingLog.UartTransferStats uart = BlePhotoTimingLog.takeUartTransfer(bleImgId);
        BlePhotoTimingLog.pipelineDone(
                requestId,
                bleImgId,
                success,
                totalMs,
                phases,
                encodeCalls,
                encodeTotalMs,
                originalBytes,
                compressedBytes,
                uart,
                reduction);
        dumpTimings(requestId, originalBytes, compressedBytes, uart, reduction, captureSession);
    }

    private void clearBlePhotoPipelineTracking(String requestId, String bleImgId) {
        if (requestId != null) {
            blePhotoPipelineStartMs.remove(requestId);
            photoTimings.remove(requestId);
            photoTimingDetails.remove(requestId);
            bleEncodeInvocationCount.remove(requestId);
            bleEncodeTotalMs.remove(requestId);
            bleOriginalBytes.remove(requestId);
            bleCompressedBytes.remove(requestId);
            blePayloadReductionStats.remove(requestId);
            bleCaptureSessionStats.remove(requestId);
        }
        if (bleImgId != null) {
            bleImgIdToRequestId.remove(bleImgId);
        }
    }

    /**
     * Record a timing checkpoint for a photo request. No-op if
     * AsgConstants.ENABLE_PHOTO_TIMING_LOGS is false.
     */
    private void recordTiming(String requestId, String phase) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) return;
        photoTimings
                .computeIfAbsent(requestId, k -> new java.util.LinkedHashMap<>())
                .put(phase, System.currentTimeMillis());
    }

    /** Record a checkpoint and emit a single-line timing log for BLE photo steps. */
    private void logBlePhotoStep(String requestId, String step) {
        logBlePhotoStep(requestId, step, null);
    }

    /**
     * Compact capture-config summary for PHASE BREAKDOWN / live timing lines (size, AE mode,
     * exposure, ISO, ZSL, metered preview).
     */
    private static String summarizeCaptureTimingDetail(
            String kind,
            @Nullable JSONObject captureConfig,
            @Nullable JSONObject meteredPreview) {
        StringBuilder sb = new StringBuilder(kind);
        if (captureConfig != null) {
            int width = captureConfig.optInt("width", -1);
            int height = captureConfig.optInt("height", -1);
            if (width > 0 && height > 0) {
                sb.append(' ').append(width).append('x').append(height);
            }
            if (captureConfig.has("quality")) {
                sb.append(" jpegQ=").append(captureConfig.optInt("quality"));
            }
            if (captureConfig.has("manual")) {
                sb.append(captureConfig.optBoolean("manual") ? " MANUAL" : " AUTO");
            }
            if (captureConfig.has("exposureTimeNs")) {
                double expMs = captureConfig.optLong("exposureTimeNs") / 1_000_000.0;
                sb.append(String.format(Locale.US, " exp=%.2fms", expMs));
            }
            if (captureConfig.has("iso")) {
                sb.append(" iso=").append(captureConfig.optInt("iso"));
            }
            if (captureConfig.has("zsl")) {
                sb.append(" zsl=").append(captureConfig.optBoolean("zsl"));
            }
            if (captureConfig.has("noiseReductionMode")) {
                sb.append(" nr=").append(captureConfig.optInt("noiseReductionMode"));
            }
        } else {
            sb.append(" (no config)");
        }
        if (meteredPreview != null) {
            if (meteredPreview.has("iso") || meteredPreview.has("exposureTimeNs")) {
                sb.append(" | metered");
                if (meteredPreview.has("iso")) {
                    sb.append(" iso=").append(meteredPreview.optInt("iso"));
                }
                if (meteredPreview.has("exposureTimeNs")) {
                    double expMs = meteredPreview.optLong("exposureTimeNs") / 1_000_000.0;
                    sb.append(String.format(Locale.US, " exp=%.2fms", expMs));
                }
            }
        }
        return sb.toString();
    }

    private void logBlePhotoStep(String requestId, String step, String detail) {
        logBlePhotoStepAt(requestId, step, detail, System.currentTimeMillis());
    }

    private void logBlePhotoStepAt(
            String requestId, String step, String detail, long wallTimeMs) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS || requestId == null || requestId.isEmpty()) {
            return;
        }
        Map<String, Long> timings =
                photoTimings.computeIfAbsent(requestId, k -> new java.util.LinkedHashMap<>());
        long delta;
        long elapsed;
        synchronized (timings) {
            delta = 0;
            if (!timings.isEmpty()) {
                long prev = 0;
                for (Long t : timings.values()) {
                    prev = t;
                }
                delta = wallTimeMs - prev;
            }
            timings.put(step, wallTimeMs);
            Long pipelineStart = blePhotoPipelineStartMs.get(requestId);
            elapsed = pipelineStart != null ? wallTimeMs - pipelineStart : -1;
        }
        if (detail != null && !detail.isEmpty()) {
            Map<String, String> details =
                    photoTimingDetails.computeIfAbsent(
                            requestId, k -> new java.util.LinkedHashMap<>());
            synchronized (details) {
                details.put(step, detail);
            }
        }
        BlePhotoTimingLog.requestStep(requestId, step, detail, elapsed, delta);
    }

    /**
     * Dump all recorded timings for a photo request and clean up. Shows cumulative time from start
     * and delta between each phase. No-op if AsgConstants.ENABLE_PHOTO_TIMING_LOGS is false.
     */
    private void dumpTimings(
            String requestId,
            long originalBytes,
            long compressedBytes,
            @Nullable BlePhotoTimingLog.UartTransferStats uart,
            @Nullable BlePhotoTimingLog.PayloadReductionStats reduction,
            @Nullable BlePhotoTimingLog.CaptureSessionStats captureSession) {
        if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) return;
        Map<String, Long> timings = photoTimings.remove(requestId);
        Map<String, String> details = photoTimingDetails.remove(requestId);
        if (timings == null || timings.isEmpty()) return;
        Map<String, Long> snapshot;
        synchronized (timings) {
            snapshot = new java.util.LinkedHashMap<>(timings);
        }
        Map<String, String> detailSnapshot = null;
        if (details != null && !details.isEmpty()) {
            synchronized (details) {
                detailSnapshot = new java.util.LinkedHashMap<>(details);
            }
        }
        Log.i(
                BlePhotoTimingLog.TAG,
                BlePhotoTimingLog.formatPhaseBreakdown(
                        requestId,
                        snapshot,
                        detailSnapshot,
                        originalBytes,
                        compressedBytes,
                        uart,
                        reduction,
                        captureSession));
        blePayloadReductionStats.remove(requestId);
        bleCaptureSessionStats.remove(requestId);
    }

    private void dumpTimings(String requestId) {
        dumpTimings(
                requestId,
                bleOriginalBytes.getOrDefault(requestId, 0L),
                bleCompressedBytes.getOrDefault(requestId, 0L),
                null,
                blePayloadReductionStats.get(requestId),
                bleCaptureSessionStats.get(requestId));
    }

    /**
     * Emits per-stage {@code COMPRESS:} timing lines for the BLE compression pipeline, e.g. {@code
     * COMPRESS: JPEG encode finished (+412ms total, +38ms this step)}. Gated on
     * ENABLE_PHOTO_TIMING_LOGS like the rest of the photo timing instrumentation.
     */
    private static final class CompressStageTimer {
        private final long startMs = System.currentTimeMillis();
        private long lastMs = startMs;

        void start(String stage) {
            if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) return;
            long now = System.currentTimeMillis();
            Log.i(TAG, "COMPRESS: " + stage + " started (+" + (now - startMs) + "ms total)");
            lastMs = now;
        }

        void finish(String stage) {
            finish(stage, null);
        }

        void finish(String stage, @Nullable String detail) {
            if (!AsgConstants.ENABLE_PHOTO_TIMING_LOGS) return;
            long now = System.currentTimeMillis();
            Log.i(
                    TAG,
                    "COMPRESS: "
                            + stage
                            + " finished (+"
                            + (now - startMs)
                            + "ms total, +"
                            + (now - lastMs)
                            + "ms this step)"
                            + (detail != null ? " - " + detail : ""));
            lastMs = now;
        }

        long totalMs() {
            return System.currentTimeMillis() - startMs;
        }
    }

    /**
     * Largest power-of-two JPEG subsampling factor that still keeps the decoded region at or above
     * the aspect-fitted BLE output, so the follow-up {@code createScaledBitmap} only ever shrinks.
     * The configured dimensions are caps, not the literal output dimensions. Decoding 4032x3024 at
     * inSampleSize=2 cuts the ARGB working set 4x while preserving enough detail for the configured
     * output cap.
     */
    static int computeBleDecodeSampleSize(
            int regionWidth, int regionHeight, int targetWidth, int targetHeight) {
        float outputScale =
                Math.min(
                        1f,
                        Math.min(
                                targetWidth / (float) regionWidth,
                                targetHeight / (float) regionHeight));
        int outputWidth = Math.max(1, Math.round(regionWidth * outputScale));
        int outputHeight = Math.max(1, Math.round(regionHeight * outputScale));
        int sample = 1;
        while ((regionWidth / (sample * 2)) >= outputWidth
                && (regionHeight / (sample * 2)) >= outputHeight) {
            sample *= 2;
        }
        return sample;
    }

    /**
     * Debug-only ground truth for the crop tradeoff report: re-runs the exact no-crop BLE pipeline
     * (subsampled decode → aspect-fit resize → sharpen → JPEG encode at the same quality) on the
     * full captured frame and records the measured payload size and processing time on {@code
     * stats}. Runs on a background thread while the (smaller) cropped payload is already in
     * flight, so it never delays the real transfer.
     */
    private void measureNoCropBleBaseline(
            @Nullable byte[] jpegBytes,
            String jpegPath,
            int targetWidth,
            int targetHeight,
            int jpegQuality,
            BlePhotoTimingLog.PayloadReductionStats stats) {
        long startMs = System.currentTimeMillis();
        android.graphics.Bitmap decoded = null;
        android.graphics.Bitmap scaled = null;
        android.graphics.Bitmap sharpened = null;
        try {
            android.graphics.BitmapFactory.Options bounds =
                    new android.graphics.BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            if (jpegBytes != null) {
                android.graphics.BitmapFactory.decodeByteArray(
                        jpegBytes, 0, jpegBytes.length, bounds);
            } else {
                android.graphics.BitmapFactory.decodeFile(jpegPath, bounds);
            }
            int srcWidth = bounds.outWidth;
            int srcHeight = bounds.outHeight;
            if (srcWidth <= 0 || srcHeight <= 0) {
                return;
            }
            android.graphics.BitmapFactory.Options opts =
                    new android.graphics.BitmapFactory.Options();
            opts.inSampleSize =
                    computeBleDecodeSampleSize(srcWidth, srcHeight, targetWidth, targetHeight);
            decoded =
                    jpegBytes != null
                            ? android.graphics.BitmapFactory.decodeByteArray(
                                    jpegBytes, 0, jpegBytes.length, opts)
                            : android.graphics.BitmapFactory.decodeFile(jpegPath, opts);
            if (decoded == null) {
                return;
            }
            float scale =
                    Math.min(
                            1f,
                            Math.min(
                                    targetWidth / (float) decoded.getWidth(),
                                    targetHeight / (float) decoded.getHeight()));
            int outWidth = Math.max(1, Math.round(decoded.getWidth() * scale));
            int outHeight = Math.max(1, Math.round(decoded.getHeight() * scale));
            scaled = android.graphics.Bitmap.createScaledBitmap(decoded, outWidth, outHeight, true);
            sharpened = BleImageSharpener.sharpen(mContext, scaled);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(512 * 1024);
            if (!sharpened.compress(
                    android.graphics.Bitmap.CompressFormat.JPEG, jpegQuality, out)) {
                return;
            }
            long elapsedMs = System.currentTimeMillis() - startMs;
            stats.setMeasuredFullFrameBaseline(out.size(), elapsedMs);
            Log.i(
                    TAG,
                    "📏 No-crop BLE baseline measured: "
                            + String.format(Locale.US, "%.1fKB", out.size() / 1024.0)
                            + " at "
                            + outWidth
                            + "x"
                            + outHeight
                            + " (quality="
                            + jpegQuality
                            + ") in "
                            + elapsedMs
                            + "ms");
        } catch (Throwable t) {
            Log.w(TAG, "No-crop BLE baseline measurement failed", t);
        } finally {
            if (sharpened != null && sharpened != scaled) {
                sharpened.recycle();
            }
            if (scaled != null && scaled != decoded) {
                scaled.recycle();
            }
            if (decoded != null) {
                decoded.recycle();
            }
        }
    }

    private static android.graphics.Rect clampRoiToBounds(
            android.graphics.Rect roi, int width, int height) {
        android.graphics.Rect clamped = new android.graphics.Rect(roi);
        if (!clamped.intersect(0, 0, width, height)
                || clamped.width() <= 0
                || clamped.height() <= 0) {
            return new android.graphics.Rect(0, 0, width, height);
        }
        return clamped;
    }

    /** Decodes only the selected JPEG region; returns null so the caller can fall back safely. */
    @Nullable
    private static android.graphics.Bitmap decodeJpegRegion(
            @Nullable byte[] jpegBytes,
            String jpegPath,
            android.graphics.Rect sourceRegion,
            android.graphics.BitmapFactory.Options options) {
        android.graphics.BitmapRegionDecoder decoder = null;
        try {
            decoder =
                    jpegBytes != null
                            ? android.graphics.BitmapRegionDecoder.newInstance(
                                    jpegBytes, 0, jpegBytes.length, false)
                            : android.graphics.BitmapRegionDecoder.newInstance(jpegPath, false);
            return decoder.decodeRegion(sourceRegion, options);
        } catch (Exception error) {
            Log.w(TAG, "JPEG region decode failed; falling back to full sampled decode", error);
            return null;
        } finally {
            if (decoder != null) {
                decoder.recycle();
            }
        }
    }

    /** Full-decode fallback for devices or JPEGs that reject region decoding. */
    @Nullable
    static android.graphics.Bitmap decodeFullJpegAndCrop(
            byte[] jpegBytes, android.graphics.Rect sourceRegion) {
        android.graphics.Bitmap fullFrame = null;
        try {
            fullFrame =
                    android.graphics.BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
            if (fullFrame == null) {
                return null;
            }
            android.graphics.Rect clamped =
                    clampRoiToBounds(sourceRegion, fullFrame.getWidth(), fullFrame.getHeight());
            android.graphics.Bitmap cropped =
                    android.graphics.Bitmap.createBitmap(
                            fullFrame,
                            clamped.left,
                            clamped.top,
                            clamped.width(),
                            clamped.height());
            if (cropped != fullFrame) {
                fullFrame.recycle();
            }
            return cropped;
        } catch (RuntimeException error) {
            Log.w(TAG, "Full JPEG decode-and-crop fallback failed", error);
            if (fullFrame != null && !fullFrame.isRecycled()) {
                fullFrame.recycle();
            }
            return null;
        }
    }

    /** Maps a source-pixel ROI onto the subsampled decode's coordinate space. */
    @Nullable
    private static android.graphics.Rect scaleRoiToDecoded(
            @Nullable android.graphics.Rect roi, int sampleSize) {
        if (roi == null || sampleSize <= 1) {
            return roi;
        }
        return new android.graphics.Rect(
                roi.left / sampleSize,
                roi.top / sampleSize,
                roi.right / sampleSize,
                roi.bottom / sampleSize);
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
        String uploadPath = prepareTextModePhotoPath(photoFilePath, requestId);
        Log.d(TAG, "📸 Processing photo upload with SDK compression setting: " + compress);

        // Check SDK compression setting
        if ("none".equals(compress) || compress == null || compress.isEmpty()) {
            Log.d(TAG, "📸 No compression requested - uploading original image");
            performDirectUpload(uploadPath, requestId, webhookUrl, authToken);
        } else {
            Log.d(TAG, "🗜️ Compression requested - applying SDK compression setting: " + compress);
            sendPhotoStatus(requestId, "compressing");

            compressImageForUpload(uploadPath, requestId, webhookUrl, authToken, compress);
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
                                    cleanupPhotoArtifacts(
                                            requestId,
                                            photoFilePath,
                                            Boolean.TRUE.equals(photoSaveFlags.get(requestId)));
                                    clearPhotoTracking(requestId);
                                    releasePhotoJob(requestId);
                                    if (mMediaCaptureListener != null) {
                                        mMediaCaptureListener.onMediaError(
                                                requestId,
                                                errorMessage,
                                                MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                                    }
                                    return;
                                }

                                android.graphics.BitmapFactory.Options boundsOnly =
                                        new android.graphics.BitmapFactory.Options();
                                boundsOnly.inJustDecodeBounds = true;
                                android.graphics.BitmapFactory.decodeFile(
                                        photoFilePath, boundsOnly);
                                Log.i(
                                        TAG,
                                        "📤➡️📱 Sending photo to phone: "
                                                + boundsOnly.outWidth
                                                + "x"
                                                + boundsOnly.outHeight
                                                + ", "
                                                + String.format(
                                                        Locale.US,
                                                        "%.1f",
                                                        photoFile.length() / 1024.0)
                                                + " KB (requestId="
                                                + requestId
                                                + ")");
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

                                    cleanupPhotoArtifacts(
                                            requestId,
                                            photoFilePath,
                                            Boolean.TRUE.equals(photoSaveFlags.get(requestId)));
                                    clearPhotoTracking(requestId);

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
                                                "📱 Webhook upload failed, attempting BLE"
                                                        + " fallback");
                                        Log.d(TAG, "🔄 BLE Image ID: " + bleImgId);
                                        tracePhotoUploadFallback(
                                                requestId,
                                                webhookUrl,
                                                photoFile,
                                                "http_status_" + response.code(),
                                                bleImgId);

                                        String fallbackPhotoPath =
                                                finalPhotoPath(requestId, photoFilePath);
                                        deletePhotoTransportTemporary(requestId, photoFilePath);
                                        photoBleIds.remove(requestId);

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
                                                fallbackPhotoPath,
                                                requestId,
                                                bleImgId,
                                                shouldSave,
                                                requestedSize);
                                        return; // Exit early - BLE transfer will handle cleanup
                                    }

                                    // No BLE fallback available
                                    dumpTimings(requestId);
                                    sendPhotoErrorResponse(
                                            requestId, "UPLOAD_FAILED", errorMessage);
                                    Log.d(
                                            TAG,
                                            "❌ No BLE fallback available, handling as normal"
                                                    + " failure");

                                    cleanupPhotoArtifacts(
                                            requestId,
                                            photoFilePath,
                                            Boolean.TRUE.equals(photoSaveFlags.get(requestId)));
                                    clearPhotoTracking(requestId);

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

                                    String fallbackPhotoPath =
                                            finalPhotoPath(requestId, photoFilePath);
                                    deletePhotoTransportTemporary(requestId, photoFilePath);
                                    photoBleIds.remove(requestId);

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
                                            fallbackPhotoPath,
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

                                cleanupPhotoArtifacts(
                                        requestId,
                                        photoFilePath,
                                        Boolean.TRUE.equals(photoSaveFlags.get(requestId)));
                                clearPhotoTracking(requestId);

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
     * Upload a recorded video to a webhook URL via multipart/form-data, mirroring the photo
     * snapshot upload in {@link #performDirectUpload}. Runs on a background thread.
     *
     * <p>Unlike photos there is no BLE fallback — video files are far too large for BLE — so a
     * failed upload is terminal. Timeouts are much larger than the photo path: write/read are
     * per-stall (idle) timeouts and {@code callTimeout} bounds the whole upload end-to-end.
     *
     * <p>The receiving server gets a multipart body with: {@code video} (the .mp4 file), {@code
     * requestId}, {@code type=video_upload}, {@code success=true}, plus an optional {@code
     * Authorization: Bearer <authToken>} header.
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
                                // healthy speeds, and video has no BLE fallback so that is
                                // terminal.
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
                                            "🔐 Adding Authorization header to video webhook"
                                                    + " request");
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
                                            if (discardThumbnailAndDeleteVideo(videoFile)) {
                                                Log.d(
                                                        TAG,
                                                        "🗑️ Deleted video file after successful"
                                                                + " upload");
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
                                        mMediaCaptureListener.onVideoUploaded(
                                                requestId, webhookUrl);
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
            String mode,
            boolean enableFlash,
            boolean enableSound,
            String compress,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (PhotoMode.TEXT.equals(mode)) {
            textRoiDetector.warmUp();
        }
        // Check if camera HAL is restarting after FOV change
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            clearPhotoTracking(requestId);
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
                clearPhotoTracking(requestId);
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
            photoRequestedModes.put(requestId, mode);
            tracePhotoWifiRoute(requestId, "direct_webhook", "wifi_connected", webhookUrl, null);

            Log.d(TAG, "📶 WiFi connected - attempting direct upload for " + requestId);
            return takePhotoAndUpload(
                    photoFilePath,
                    requestId,
                    webhookUrl,
                    authToken,
                    save,
                    size,
                    mode,
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
                    mode,
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
            String mode,
            boolean enableFlash,
            boolean enableSound,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings) {
        if (captureSettings == null) {
            captureSettings = PhotoCaptureSettings.EMPTY;
        }
        if (PhotoMode.TEXT.equals(mode)) {
            textRoiDetector.warmUp();
        }
        String captureSize = PhotoMode.captureSize(mode, size);
        Log.i(
                TAG,
                "📸 Mentra Live BLE capture mode="
                        + mode
                        + " sensorSize="
                        + captureSize
                        + " bleOutputSize="
                        + size
                        + " requestId="
                        + requestId);
        // Start timing for end-to-end photo capture performance measurement
        Long existingPipelineStart =
                AsgConstants.ENABLE_PHOTO_TIMING_LOGS
                        ? blePhotoPipelineStartMs.get(requestId)
                        : null;
        final long requestStartTimeMs =
                existingPipelineStart != null ? existingPipelineStart : System.currentTimeMillis();
        if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS && existingPipelineStart == null) {
            blePhotoPipelineStartMs.put(requestId, requestStartTimeMs);
            logBlePhotoStep(requestId, "request_received");
        }
        logBlePhotoStep(requestId, "ble_capture_accepted");

        // Check if any streaming is active - photos cannot interrupt streams
        logBlePhotoStep(requestId, "streaming_check", "checking RTMP, SRT, and WHIP camera usage");
        if (RtmpStreamingService.isStreaming()
                || SrtStreamingService.isStreaming()
                || WhipStreamingService.isStreaming()) {
            Log.e(TAG, "Cannot take photo - streaming active");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera busy with streaming");
            clearPhotoTracking(requestId);
            return false;
        }

        // Check if camera HAL is restarting after FOV change
        logBlePhotoStep(requestId, "camera_restart_check", "checking camera restart cooldown");
        if (CameraRestartCooldown.isActive()) {
            Log.w(TAG, "Cannot take photo - camera HAL restarting after FOV change");
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Camera restarting after FOV change");
            clearPhotoTracking(requestId);
            return false;
        }

        // Check battery level before proceeding
        logBlePhotoStep(requestId, "battery_check", "checking minimum battery requirement");
        if (mStateManager != null) {
            int batteryLevel = mStateManager.getBatteryLevel();
            if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                Log.w(TAG, "🚫 Photo rejected - battery too low (" + batteryLevel + "%)");
                playBatteryLowSound();
                sendPhotoErrorResponse(
                        requestId,
                        "BATTERY_LOW",
                        "Battery too low to take photo (" + batteryLevel + "%)");
                clearPhotoTracking(requestId);
                return false;
            }
        } else {
            Log.w(TAG, "⚠️ StateManager not initialized - skipping battery check for BLE transfer");
        }

        // A save=false BLE capture keeps the large JPEG in RAM, so low persistent storage is
        // irrelevant (the small IMU recorder scratch file remains unchanged).
        logBlePhotoStep(
                requestId,
                "storage_check",
                save
                        ? "checking storage required for the saved sensor JPEG"
                        : "skipped for RAM-only JPEG capture");
        StorageManager storageManager = StorageManager.getInstance(mContext);
        if (save && !storageManager.canTakePhoto()) {
            Log.w(TAG, "🚫 Photo rejected - insufficient storage");
            playStorageFullSound();
            sendPhotoErrorResponse(
                    requestId,
                    "INSUFFICIENT_STORAGE",
                    "Insufficient storage space for photo capture");
            clearPhotoTracking(requestId);
            return false;
        }

        // Single-flight guard: reject if any photo job (capture or upload/BLE-handoff) is in
        // flight.
        // Flag stays set through capture → BLE compression → BLE handoff; cleared at terminal
        // exits.
        if (!acquirePhotoJob(requestId)) {
            Log.w(TAG, "🚫 Photo job in flight - rejecting concurrent BLE request: " + requestId);
            sendPhotoErrorResponse(requestId, "CAMERA_BUSY", "Another photo job is in progress");
            clearPhotoTracking(requestId);
            return false;
        }
        logBlePhotoStep(requestId, "photo_job_acquired", "single-flight camera job lock acquired");
        startCaptureSafetyTimeout(requestId);
        sendPhotoStatus(requestId, "accepted");
        logBlePhotoStep(requestId, "photo_status_accepted");

        // Store the save flag for this request
        photoSaveFlags.put(requestId, save);
        photoOriginalPaths.put(requestId, photoFilePath);
        // Track requested size for BLE compression
        photoRequestedSizes.put(requestId, size);
        photoRequestedModes.put(requestId, mode);
        // Notify that we're about to take a photo
        if (mMediaCaptureListener != null) {
            mMediaCaptureListener.onPhotoCapturing(requestId);
        }
        sendPhotoStatus(requestId, "queued");
        logBlePhotoStep(requestId, "photo_status_queued");

        // LED control is now handled by CameraNeoService tied to camera lifecycle

        // TESTING: Check for fake camera capture failure
        if (PhotoCaptureTestHooks.shouldFail("CAMERA_CAPTURE")) {
            cleanupPhotoArtifacts(requestId, photoFilePath, false);
            clearPhotoTracking(requestId);
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
                playShutterSound(captureSize, true, exposureTimeNs, captureSettings);
            }
            if (enableFlash) {
                flashPrivacyLedForPhoto();
            }
        }

        try {
            // Use CameraNeoService for photo capture
            logBlePhotoStep(requestId, "enqueue_camera");
            final BlePhotoTimingLog.PhaseSink capturePhaseSink =
                    new BlePhotoTimingLog.PhaseSink() {
                        @Override
                        public void onPhase(String step, @Nullable String detail) {
                            logBlePhotoStep(requestId, step, detail);
                        }

                        @Override
                        public void onPhaseAt(
                                String step, @Nullable String detail, long wallTimeMs) {
                            logBlePhotoStepAt(requestId, step, detail, wallTimeMs);
                        }

                        @Override
                        public void onCaptureSession(
                                BlePhotoTimingLog.CaptureSessionStats stats) {
                            bleCaptureSessionStats.put(requestId, stats);
                        }
                    };
            BlePhotoTimingLog.bindPhaseSink(capturePhaseSink);
            CameraNeoService.enqueuePhotoRequest(
                    mContext,
                    photoFilePath,
                    captureSize,
                    enableFlash,
                    true, // isFromSdk — same sizing as webhook SDK path
                    exposureTimeNs,
                    iso,
                    captureSettings,
                    // RAM-first: the callback receives the JPEG bytes in memory. Text mode never
                    // persists the sensor JPEG up front;
                    // save=true writes only the selected crop, or the full-frame fallback.
                    true,
                    save && !PhotoMode.TEXT.equals(mode),
                    new CameraNeoService.PhotoCaptureCallback() {
                        @Override
                        public void onPhotoConfigured(JSONObject resolvedConfig) {
                            logBlePhotoStep(
                                    requestId,
                                    "capture_configured",
                                    summarizeCaptureTimingDetail(
                                            "resolved", resolvedConfig, null));
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
                            logBlePhotoStep(
                                    requestId,
                                    "capture_started",
                                    summarizeCaptureTimingDetail(
                                            "requested",
                                            requestedCaptureConfig,
                                            meteredPreview));
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
                            onPhotoCaptured(filePath, captureMetadata, null);
                        }

                        @Override
                        public void onPhotoCaptured(
                                String filePath,
                                JSONObject captureMetadata,
                                CapturedPhoto capturedPhoto) {
                            // NOTE: do NOT clear isPhotoJobInFlight here — the job continues
                            // through BLE compression + handoff. Flag is cleared in
                            // compressAndSendViaBle's finally block.
                            BlePhotoTimingLog.unbindPhaseSink(capturePhaseSink);
                            // The in-memory capture (JPEG bytes + IMU payload + optional
                            // persistence future). For save=false the file intentionally does not
                            // exist.
                            long capturedBytes =
                                    capturedPhoto != null
                                            ? capturedPhoto.jpegBytes.length
                                            : new File(filePath).length();
                            if (capturedBytes > 0) {
                                bleOriginalBytes.put(requestId, capturedBytes);
                            }
                            logBlePhotoStep(
                                    requestId,
                                    "photo_captured",
                                    "capture took "
                                            + (System.currentTimeMillis() - requestStartTimeMs)
                                            + "ms, file="
                                            + filePath
                                            + ", size="
                                            + capturedBytes
                                            + " bytes ("
                                            + String.format(
                                                    Locale.US, "%.1f", capturedBytes / 1024.0)
                                            + "KB)");

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
                            logBlePhotoStep(requestId, "start_compress_for_ble");
                            compressAndSendViaBle(
                                    filePath, requestId, bleImgId, false, capturedPhoto);
                        }

                        @Override
                        public void onPhotoError(String errorMessage) {
                            onPhotoError(CameraOperationError.captureFailed(errorMessage));
                        }

                        @Override
                        public void onPhotoError(CameraOperationError error) {
                            BlePhotoTimingLog.unbindPhaseSink(capturePhaseSink);
                            cleanupPhotoArtifacts(requestId, photoFilePath, false);
                            clearPhotoTracking(requestId);
                            releasePhotoJob(requestId);

                            Log.e(TAG, "Failed to capture photo for BLE: " + error.message());

                            // LED is now managed by CameraNeoService and will turn off when camera
                            // closes

                            dumpTimings(requestId);
                            sendPhotoErrorResponse(requestId, error.code(), error.message());

                            if (mMediaCaptureListener != null) {
                                mMediaCaptureListener.onMediaError(
                                        requestId,
                                        error.message(),
                                        MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                            }
                        }
                    });
            return true;
        } catch (Exception e) {
            BlePhotoTimingLog.unbindPhaseSink(null);
            cleanupPhotoArtifacts(requestId, photoFilePath, false);
            clearPhotoTracking(requestId);
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
            cleanupPhotoArtifacts(requestId, existingPhotoPath, save);
            clearPhotoTracking(requestId);
            releasePhotoJob(requestId);
            return;
        }

        // Store the save flag for this request
        photoSaveFlags.put(requestId, save);
        photoOriginalPaths.put(requestId, existingPhotoPath);
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
    private void compressAndSendViaBle(
            String originalPath, String requestId, String bleImgId, boolean isWifiFallback) {
        compressAndSendViaBle(originalPath, requestId, bleImgId, isWifiFallback, null);
    }

    /**
     * Compress photo and send via BLE.
     *
     * @param capturedPhoto in-memory capture (JPEG bytes + IMU payload + persistence future) for
     *     RAM-first captures; {@code null} for file-based flows (WiFi-fallback reuse), which read
     *     {@code originalPath} from disk as before
     */
    private void compressAndSendViaBle(
            String originalPath,
            String requestId,
            String bleImgId,
            boolean isWifiFallback,
            @Nullable CapturedPhoto capturedPhoto) {
        new Thread(
                        () -> {
                            long compressThreadStart = System.currentTimeMillis();
                            boolean bleTransferStarted = false;
                            android.graphics.Rect detectedTextRoi = null;
                            CompressStageTimer stage = new CompressStageTimer();
                            recordTiming(requestId, "ble_compress_start");
                            logBlePhotoStep(
                                    requestId, "ble_compress_thread_start", "bleImgId=" + bleImgId);
                            sendPhotoStatus(
                                    requestId,
                                    isWifiFallback ? "ble_fallback_compression" : "compressing");

                            // TESTING: Check for fake compression failure
                            if (PhotoCaptureTestHooks.shouldFail("COMPRESSION")) {
                                Log.e(TAG, "TESTING: Simulating compression failure");
                                sendPhotoErrorResponse(
                                        requestId,
                                        PhotoCaptureTestHooks.getErrorCode(),
                                        PhotoCaptureTestHooks.getErrorMessage());
                                if (capturedPhoto != null) {
                                    // Never let cleanup race the background write.
                                    capturedPhoto.awaitPersistenceCompletion();
                                }
                                cleanupPhotoArtifacts(
                                        requestId,
                                        originalPath,
                                        Boolean.TRUE.equals(photoSaveFlags.get(requestId)));
                                clearPhotoTracking(requestId);
                                releasePhotoJob(requestId);
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

                                BleParams tierBleParams = resolveBleParams(requestedSize);
                                String requestedMode =
                                        PhotoMode.normalize(photoRequestedModes.get(requestId));
                                boolean textModeRequested = PhotoMode.TEXT.equals(requestedMode);
                                if (textModeRequested && capturedPhoto == null) {
                                    // File-based flow (WiFi fallback): prepare the canonical
                                    // cropped JPEG up front as before. RAM-first captures crop
                                    // from the detection ROI in-memory below and only write the
                                    // canonical crop for gallery-saved photos, after the BLE
                                    // handoff.
                                    prepareTextModePhotoPath(originalPath, requestId);
                                }
                                boolean textSelectionAlreadyPrepared =
                                        Boolean.TRUE.equals(photoTextCropPrepared.get(requestId));
                                boolean textCropAlreadyApplied =
                                        Boolean.TRUE.equals(photoTextCropApplied.get(requestId));
                                BleParams bleParams;
                                BleCodec codec = BlePhotoEncodingPolicy.selectCodec();
                                logBlePhotoStep(
                                        requestId,
                                        "text_mode_prepare",
                                        "mode="
                                                + requestedMode
                                                + ", canonicalSelectionPrepared="
                                                + textSelectionAlreadyPrepared
                                                + ", canonicalCropApplied="
                                                + textCropAlreadyApplied);
                                boolean shouldCrop =
                                        AsgConstants.ENABLE_TEXT_REGION_CROP || textModeRequested;
                                Log.i(
                                        TAG,
                                        "📸 Mentra Live BLE compress mode="
                                                + requestedMode
                                                + " textCrop="
                                                + shouldCrop
                                                + " requestId="
                                                + requestId);

                                android.graphics.Bitmap resized;
                                String textCropConfidence = null;
                                String textCropReason = null;
                                // 2a. Text-region ROI detection. Independent of the grayscale
                                // flag: it only decides WHERE to crop, not how the pixels are
                                // processed afterwards.
                                // Human-readable verdict for whether ML Kit found a usable text
                                // region or the transfer is preserving the full frame.
                                String textCropOutcome =
                                        textSelectionAlreadyPrepared
                                                ? textCropAlreadyApplied
                                                        ? "PREPARED_CANONICAL_CROP"
                                                        : "PREPARED_FULL_FRAME_FALLBACK"
                                                : shouldCrop
                                                        ? "NOT_ATTEMPTED (pending detection)"
                                                        : "NOT_ATTEMPTED"
                                                                + " (ENABLE_TEXT_REGION_CROP="
                                                                + AsgConstants
                                                                        .ENABLE_TEXT_REGION_CROP
                                                                + ", mode="
                                                                + requestedMode
                                                                + ")";

                                android.graphics.Rect roi = null;
                                long cropPhaseStartMs = 0L;
                                long cropPhaseEndMs = 0L;
                                boolean cropAttempted =
                                        shouldCrop && !textSelectionAlreadyPrepared;
                                if (cropAttempted) {
                                    stage.start("text-region detection");
                                    cropPhaseStartMs = System.currentTimeMillis();
                                    logBlePhotoStep(
                                            requestId,
                                            "text_region_detection_start",
                                            "ML Kit localization at "
                                                    + AsgConstants
                                                            .TEXT_MODE_MLKIT_ANALYSIS_LONG_EDGE
                                                    + "px long edge");
                                    TextRegionDetection detection =
                                            runTextRegionDetection(
                                                    capturedPhoto != null
                                                            ? capturedPhoto.jpegBytes
                                                            : null,
                                                    originalPath);
                                    roi = detection.roi;
                                    detectedTextRoi = roi;
                                    textCropConfidence = detection.confidence;
                                    textCropReason = detection.reason;
                                    textCropOutcome = detection.outcome;
                                    stage.finish("text-region detection");
                                    logBlePhotoStep(
                                            requestId,
                                            "text_region_detection_done",
                                            textCropOutcome
                                                    + (roi != null
                                                            ? " roi=" + roi.toShortString()
                                                            : " roi=full-frame"));
                                }

                                boolean hasUsableTextCrop =
                                        textModeRequested
                                                && (textCropAlreadyApplied || roi != null);
                                bleParams =
                                        textModeRequested
                                                ? resolveTextModeBleParams(hasUsableTextCrop)
                                                : tierBleParams;
                                logBlePhotoStep(
                                        requestId,
                                        "compress_resolve_params",
                                        "size="
                                                + requestedSize
                                                + ", mode="
                                                + requestedMode
                                                + ", textCropAvailable="
                                                + hasUsableTextCrop
                                                + ", target="
                                                + bleParams.targetWidth
                                                + "x"
                                                + bleParams.targetHeight
                                                + ", codec="
                                                + codec
                                                + ", quality="
                                                + (codec == BleCodec.AVIF
                                                        ? bleParams.avifQuality
                                                        : AsgConstants
                                                                .BLE_PHOTO_JPEG_FAST_QUALITY));
                                if (textModeRequested) {
                                    Log.d(
                                            TAG,
                                            "Text mode: using "
                                                    + (hasUsableTextCrop
                                                            ? "detected-crop"
                                                            : "full-frame fallback")
                                                    + " BLE downscale "
                                                    + bleParams.targetWidth
                                                    + "x"
                                                    + bleParams.targetHeight
                                                    + " (size tier "
                                                    + requestedSize
                                                    + " would use "
                                                    + tierBleParams.targetWidth
                                                    + "x"
                                                    + tierBleParams.targetHeight
                                                    + ")");
                                }

                                int sourceWidth = 0;
                                int sourceHeight = 0;
                                int cropWidth = 0;
                                int cropHeight = 0;
                                boolean cropApplied = false;
                                android.graphics.BitmapFactory.Options sourceBounds =
                                        new android.graphics.BitmapFactory.Options();
                                sourceBounds.inJustDecodeBounds = true;
                                if (capturedPhoto != null) {
                                    android.graphics.BitmapFactory.decodeByteArray(
                                            capturedPhoto.jpegBytes,
                                            0,
                                            capturedPhoto.jpegBytes.length,
                                            sourceBounds);
                                } else {
                                    android.graphics.BitmapFactory.decodeFile(
                                            originalPath, sourceBounds);
                                }
                                sourceWidth = sourceBounds.outWidth;
                                sourceHeight = sourceBounds.outHeight;
                                if (roi != null && sourceWidth > 0 && sourceHeight > 0) {
                                    android.graphics.Rect clampedRoi =
                                            clampRoiToBounds(roi, sourceWidth, sourceHeight);
                                    cropWidth = clampedRoi.width();
                                    cropHeight = clampedRoi.height();
                                    cropApplied =
                                            cropWidth < sourceWidth || cropHeight < sourceHeight;
                                }
                                if (!cropApplied) {
                                    cropWidth = sourceWidth;
                                    cropHeight = sourceHeight;
                                }

                                if (cropAttempted && AsgConstants.ENABLE_GRAYSCALE_BLE_PHOTOS) {
                                    // Detection is the timed CROP phase on the grayscale path;
                                    // the fused luma crop/resize lives under COMPRESS below.
                                    cropPhaseEndMs = System.currentTimeMillis();
                                    logBlePhotoStep(
                                            requestId,
                                            "crop_phase_done",
                                            String.format(
                                                    Locale.US,
                                                    "detect=%dms roi=%s (bitmap crop fused into"
                                                            + " grayscale compress path)",
                                                    cropPhaseEndMs - cropPhaseStartMs,
                                                    roi != null
                                                            ? roi.toShortString()
                                                            : "full-frame"));
                                }

                                if (AsgConstants.ENABLE_GRAYSCALE_BLE_PHOTOS) {
                                    // 2b. Decode straight to a grayscale luma pipeline (crop +
                                    // contrast + unsharp all happen on 1-byte/pixel buffers) and
                                    // only rehydrate to a full RGBA bitmap at the end for the AVIF
                                    // encoder. BLE photos exist to be read (documents/signs/
                                    // screens), not viewed, so color is dead weight - this also
                                    // avoids ever materializing the ~30MB full-res ARGB bitmap the
                                    // old decode+resize+sharpen chain used.
                                    Log.i(
                                            TAG,
                                            "✂️ CROP CHECK (grayscale path): roi="
                                                    + (roi != null ? roi.toShortString() : "null")
                                                    + " - see GrayscaleBleProcessor log line"
                                                    + " below for original->crop->out dims");
                                    logBlePhotoStep(requestId, "image_process_start");
                                    stage.start("grayscale decode+crop+resize+sharpen");
                                    logBlePhotoStep(
                                            requestId,
                                            "grayscale_process_start",
                                            "processing luma pixels through crop, resize, and"
                                                    + " sharpen");
                                    resized =
                                            capturedPhoto != null
                                                    ? GrayscaleBleProcessor.process(
                                                            capturedPhoto.jpegBytes,
                                                            roi,
                                                            bleParams.targetWidth,
                                                            bleParams.targetHeight)
                                                    : GrayscaleBleProcessor.process(
                                                            originalPath,
                                                            roi,
                                                            bleParams.targetWidth,
                                                            bleParams.targetHeight);
                                    stage.finish(
                                            "grayscale decode+crop+resize+sharpen",
                                            "output "
                                                    + resized.getWidth()
                                                    + "x"
                                                    + resized.getHeight());
                                    logBlePhotoStep(
                                            requestId,
                                            "grayscale_process_done",
                                            "output "
                                                    + resized.getWidth()
                                                    + "x"
                                                    + resized.getHeight());
                                } else {
                                    // Full-color path: finish the entire CROP phase (decode + crop)
                                    // before any COMPRESS steps (resize/sharpen/encode).
                                    stage.start("input decode");
                                    String decodeStepStart =
                                            cropAttempted ? "crop_decode_start" : "input_decode_start";
                                    String decodeStepDone =
                                            cropAttempted ? "crop_decode_done" : "input_decode_done";
                                    logBlePhotoStep(
                                            requestId,
                                            decodeStepStart,
                                            "decoding the captured JPEG with a memory-saving sample"
                                                    + " size");
                                    int srcWidth = sourceWidth;
                                    int srcHeight = sourceHeight;
                                    if (srcWidth <= 0 || srcHeight <= 0) {
                                        throw new Exception("Failed to read image bounds");
                                    }

                                    // Decode subsampled: never materialize the ~46MB full-res
                                    // ARGB frame when the configured output cap is smaller.
                                    // The ROI (source-pixel coordinates) is mapped onto the
                                    // subsampled space so the crop lands on the same region.
                                    int regionWidth = cropWidth > 0 ? cropWidth : srcWidth;
                                    int regionHeight = cropHeight > 0 ? cropHeight : srcHeight;
                                    int sampleSize =
                                            computeBleDecodeSampleSize(
                                                    regionWidth,
                                                    regionHeight,
                                                    bleParams.targetWidth,
                                                    bleParams.targetHeight);
                                    android.graphics.BitmapFactory.Options decodeOpts =
                                            new android.graphics.BitmapFactory.Options();
                                    decodeOpts.inSampleSize = sampleSize;
                                    android.graphics.Bitmap original = null;
                                    boolean regionDecoded = false;
                                    if (roi != null) {
                                        android.graphics.Rect sourceRegion =
                                                clampRoiToBounds(roi, srcWidth, srcHeight);
                                        original =
                                                decodeJpegRegion(
                                                        capturedPhoto != null
                                                                ? capturedPhoto.jpegBytes
                                                                : null,
                                                        originalPath,
                                                        sourceRegion,
                                                        decodeOpts);
                                        regionDecoded = original != null;
                                    }
                                    if (original == null) {
                                        original =
                                                capturedPhoto != null
                                                        ? android.graphics.BitmapFactory
                                                                .decodeByteArray(
                                                                        capturedPhoto.jpegBytes,
                                                                        0,
                                                                        capturedPhoto
                                                                                .jpegBytes
                                                                                .length,
                                                                        decodeOpts)
                                                        : android.graphics.BitmapFactory.decodeFile(
                                                                originalPath, decodeOpts);
                                    }
                                    if (original == null) {
                                        throw new Exception("Failed to decode image file");
                                    }
                                    stage.finish(
                                            "input decode",
                                            "source "
                                                    + srcWidth
                                                    + "x"
                                                    + srcHeight
                                                    + " decoded at "
                                                    + original.getWidth()
                                                    + "x"
                                                    + original.getHeight()
                                                    + " (inSampleSize="
                                                    + sampleSize
                                                    + ", regionDecoded="
                                                    + regionDecoded
                                                    + ")");
                                    logBlePhotoStep(
                                            requestId,
                                            decodeStepDone,
                                            "decoded "
                                                    + original.getWidth()
                                                    + "x"
                                                    + original.getHeight());

                                    Log.i(
                                            TAG,
                                            "✂️ CROP CHECK (color path): original photo decoded at "
                                                    + original.getWidth()
                                                    + "x"
                                                    + original.getHeight()
                                                    + " roi="
                                                    + (roi != null ? roi.toShortString() : "null"));

                                    android.graphics.Bitmap cropped;
                                    if (cropAttempted) {
                                        logBlePhotoStep(
                                                requestId,
                                                "crop_start",
                                                regionDecoded
                                                        ? "ROI already decoded from JPEG region "
                                                                + (roi != null
                                                                        ? roi.toShortString()
                                                                        : "full")
                                                        : "cropping decoded bitmap to "
                                                                + (roi != null
                                                                        ? roi.toShortString()
                                                                        : "full image"));
                                        cropped =
                                                regionDecoded
                                                        ? original
                                                        : cropBitmapToDetectedRoi(
                                                                original,
                                                                scaleRoiToDecoded(roi, sampleSize),
                                                                textCropOutcome);
                                        stage.finish(
                                                "crop",
                                                "cropped "
                                                        + cropped.getWidth()
                                                        + "x"
                                                        + cropped.getHeight());
                                        cropPhaseEndMs = System.currentTimeMillis();
                                        long cropPhaseMs = cropPhaseEndMs - cropPhaseStartMs;
                                        logBlePhotoStep(
                                                requestId,
                                                "crop_done",
                                                "crop output "
                                                        + cropped.getWidth()
                                                        + "x"
                                                        + cropped.getHeight()
                                                        + (regionDecoded
                                                                ? " (region-decoded)"
                                                                : ""));
                                        logBlePhotoStep(
                                                requestId,
                                                "crop_phase_done",
                                                String.format(
                                                        Locale.US,
                                                        "detect+decode+crop=%dms output=%dx%d"
                                                                + " sourceROI=%s applied=%s",
                                                        cropPhaseMs,
                                                        cropped.getWidth(),
                                                        cropped.getHeight(),
                                                        roi != null
                                                                ? roi.toShortString()
                                                                : "full-frame",
                                                        cropApplied));
                                    } else {
                                        cropped = original;
                                    }

                                    // COMPRESS phase begins only after crop (or immediately when
                                    // cropping was not requested).
                                    logBlePhotoStep(requestId, "image_process_start");

                                    // The configured dimensions are caps, not a request to enlarge
                                    // a small ROI. Upscaling cannot recover text detail and wastes
                                    // both CPU and BLE bytes.
                                    float resizeScale =
                                            Math.min(
                                                    1f,
                                                    Math.min(
                                                            bleParams.targetWidth
                                                                    / (float) cropped.getWidth(),
                                                            bleParams.targetHeight
                                                                    / (float) cropped.getHeight()));
                                    int targetWidth =
                                            Math.max(
                                                    1,
                                                    Math.round(cropped.getWidth() * resizeScale));
                                    int targetHeight =
                                            Math.max(
                                                    1,
                                                    Math.round(cropped.getHeight() * resizeScale));

                                    logBlePhotoStep(
                                            requestId,
                                            "resize_start",
                                            "resizing to fit " + targetWidth + "x" + targetHeight);
                                    android.graphics.Bitmap scaled =
                                            android.graphics.Bitmap.createScaledBitmap(
                                                    cropped, targetWidth, targetHeight, true);
                                    if (scaled != cropped) {
                                        cropped.recycle();
                                    }
                                    stage.finish(
                                            "resize", "final " + targetWidth + "x" + targetHeight);
                                    logBlePhotoStep(
                                            requestId,
                                            "resize_done",
                                            "resize output " + targetWidth + "x" + targetHeight);
                                    logBlePhotoStep(
                                            requestId,
                                            "sharpen_start",
                                            "sharpening the resized bitmap");
                                    resized = BleImageSharpener.sharpen(mContext, scaled);
                                    if (resized != scaled) {
                                        scaled.recycle();
                                    }
                                    stage.finish("sharpen");
                                    logBlePhotoStep(requestId, "sharpen_done");
                                }
                                logBlePhotoStep(
                                        requestId,
                                        "image_process_done",
                                        "output bitmap "
                                                + resized.getWidth()
                                                + "x"
                                                + resized.getHeight()
                                                + ", mode="
                                                + requestedMode);

                                Log.d(
                                        TAG,
                                        "📐 BLE image ready for encode: "
                                                + resized.getWidth()
                                                + "x"
                                                + resized.getHeight()
                                                + " grayscale="
                                                + AsgConstants.ENABLE_GRAYSCALE_BLE_PHOTOS
                                                + " textCrop="
                                                + shouldCrop
                                                + " requestedMode="
                                                + requestedMode
                                                + " textCropConfidence="
                                                + textCropConfidence
                                                + " textCropReason="
                                                + textCropReason
                                                + " textCropOutcome="
                                                + textCropOutcome);
                                final int bleResizedWidth = resized.getWidth();
                                final int bleResizedHeight = resized.getHeight();

                                // 3. Encode with the policy-selected BLE codec. Text mode and
                                // ordinary size-tier photos share this exact codec/quality
                                // resolution. RAM-first captures pass their in-memory IMU payload
                                // to the selected encoder instead of consulting a source file.
                                int encodeQuality =
                                        codec == BleCodec.AVIF
                                                ? bleParams.avifQuality
                                                : AsgConstants.BLE_PHOTO_JPEG_FAST_QUALITY;
                                Log.d(
                                        TAG,
                                        "BLE encode: originalPath="
                                                + originalPath
                                                + " codec="
                                                + codec
                                                + " quality="
                                                + encodeQuality
                                                + " hasImuMetadata="
                                                + (capturedPhoto != null
                                                        ? capturedPhoto.imuPayload != null
                                                        : PhotoExifMetadataWriter.hasImuMetadata(
                                                                originalPath)));
                                // Verification instrumentation: confirm exactly one encoder runs
                                // per request. A count > 1 here would mean the old dual
                                // JPEG+AVIF encode path regressed back in, silently doubling
                                // encoder cost — see BlePhotoEncoders.encode(), which is the
                                // single call site for BLE payload encoding.
                                int encodeCallNumber =
                                        bleEncodeInvocationCount.merge(requestId, 1, Integer::sum);
                                stage.start(codec + " encode");
                                BlePhotoEncoder.EncodeResult encodeResult;
                                try {
                                    logBlePhotoStep(
                                            requestId,
                                            "encode_start",
                                            "encoding "
                                                    + codec
                                                    + " at quality "
                                                    + encodeQuality
                                                    + " with "
                                                    + resized.getWidth()
                                                    + "x"
                                                    + resized.getHeight()
                                                    + " input (encode call #"
                                                    + encodeCallNumber
                                                    + " for this request)");
                                    encodeResult =
                                            BlePhotoEncoders.encode(
                                                    resized,
                                                    codec,
                                                    encodeQuality,
                                                    capturedPhoto != null ? null : originalPath,
                                                    capturedPhoto != null
                                                            ? capturedPhoto.imuPayload
                                                            : null,
                                                    originalPath);
                                    long cumulativeEncodeMs =
                                            bleEncodeTotalMs.merge(
                                                    requestId, encodeResult.encodeMs, Long::sum);
                                    logBlePhotoStep(
                                            requestId,
                                            "encode_done",
                                            "encoded "
                                                    + encodeResult.data.length
                                                    + " bytes in "
                                                    + encodeResult.encodeMs
                                                    + "ms (cumulative encoder time this request: "
                                                    + cumulativeEncodeMs
                                                    + "ms across "
                                                    + encodeCallNumber
                                                    + " call(s))");
                                    if (encodeCallNumber > 1) {
                                        Log.w(
                                                TAG,
                                                "⚠️ BLE encode invoked "
                                                        + encodeCallNumber
                                                        + " times for requestId="
                                                        + requestId
                                                        + " — redundant encode added ~"
                                                        + encodeResult.encodeMs
                                                        + "ms with no benefit (cumulative="
                                                        + cumulativeEncodeMs
                                                        + "ms)");
                                        BlePhotoTimingLog.event(
                                                "ENCODE VERIFY",
                                                "redundant encode call #"
                                                        + encodeCallNumber
                                                        + " for requestId="
                                                        + requestId
                                                        + " cost an extra "
                                                        + encodeResult.encodeMs
                                                        + "ms (cumulative="
                                                        + cumulativeEncodeMs
                                                        + "ms) — this is pure waste, not needed"
                                                        + " for the single codec BLE payload");
                                    }
                                } finally {
                                    resized.recycle();
                                }
                                byte[] compressedData = encodeResult.data;
                                String bleEncodedFormat =
                                        encodeResult.codecUsed == BleCodec.JPEG_FAST
                                                ? "JPEG"
                                                : "AVIF";
                                stage.finish(
                                        encodeResult.codecUsed + " encode",
                                        compressedData.length
                                                + " bytes (quality="
                                                + encodeQuality
                                                + ")");
                                Log.d(
                                        TAG,
                                        "Successfully encoded as " + bleEncodedFormat + " for BLE");

                                long compressionTime =
                                        System.currentTimeMillis() - compressThreadStart;
                                long originalSizeBytes =
                                        capturedPhoto != null
                                                ? capturedPhoto.jpegBytes.length
                                                : new File(originalPath).length();
                                double originalSizeKb = originalSizeBytes / 1024.0;
                                double compressedSizeKb = compressedData.length / 1024.0;
                                long cropDurationMs =
                                        cropAttempted && cropPhaseStartMs > 0
                                                ? Math.max(
                                                        0L,
                                                        (cropPhaseEndMs > 0
                                                                        ? cropPhaseEndMs
                                                                        : System
                                                                                .currentTimeMillis())
                                                                - cropPhaseStartMs)
                                                : 0L;
                                BlePhotoTimingLog.PayloadReductionStats reductionStats =
                                        new BlePhotoTimingLog.PayloadReductionStats(
                                                sourceWidth,
                                                sourceHeight,
                                                cropWidth,
                                                cropHeight,
                                                bleResizedWidth,
                                                bleResizedHeight,
                                                bleParams.targetWidth,
                                                bleParams.targetHeight,
                                                cropApplied,
                                                cropDurationMs,
                                                cropAttempted);
                                blePayloadReductionStats.put(requestId, reductionStats);
                                if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS
                                        && cropApplied
                                        && encodeResult.codecUsed == BleCodec.JPEG_FAST) {
                                    // Measure the true no-crop baseline (same decode/resize/
                                    // sharpen/encode path, same quality) off the critical path
                                    // while the BLE transfer runs, so the crop tradeoff report
                                    // compares against real bytes instead of an area estimate.
                                    final byte[] baselineJpeg =
                                            capturedPhoto != null
                                                    ? capturedPhoto.jpegBytes
                                                    : null;
                                    final String baselinePath = originalPath;
                                    final int baselineTargetW = bleParams.targetWidth;
                                    final int baselineTargetH = bleParams.targetHeight;
                                    final int baselineQuality = encodeQuality;
                                    final BlePhotoTimingLog.PayloadReductionStats baselineStats =
                                            reductionStats;
                                    new Thread(
                                                    () ->
                                                            measureNoCropBleBaseline(
                                                                    baselineJpeg,
                                                                    baselinePath,
                                                                    baselineTargetW,
                                                                    baselineTargetH,
                                                                    baselineQuality,
                                                                    baselineStats),
                                                    "BleNoCropBaseline")
                                            .start();
                                }
                                long estFullFrameBleBytes =
                                        BlePhotoTimingLog.estimateFullFrameBlePayloadBytes(
                                                compressedData.length, reductionStats);
                                long cropSavedVsFullBleBytes =
                                        Math.max(
                                                0L,
                                                estFullFrameBleBytes - compressedData.length);
                                long sensorToPayloadSavedBytes =
                                        Math.max(0L, originalSizeBytes - compressedData.length);
                                logBlePhotoStep(
                                        requestId,
                                        "ble_compress_done",
                                        String.format(
                                                Locale.US,
                                                "%s %.1fKB → %.1fKB in %dms"
                                                        + " | crop_saved_vs_full_ble_est=%.1fKB"
                                                        + " | est_full_ble=%.1fKB"
                                                        + " | sensor_to_payload_saved=%.1fKB"
                                                        + " | crop=%dx%d of %dx%d"
                                                        + " | encode=%dx%d",
                                                bleEncodedFormat,
                                                originalSizeKb,
                                                compressedSizeKb,
                                                compressionTime,
                                                cropSavedVsFullBleBytes / 1024.0,
                                                estFullFrameBleBytes / 1024.0,
                                                sensorToPayloadSavedBytes / 1024.0,
                                                cropWidth,
                                                cropHeight,
                                                sourceWidth,
                                                sourceHeight,
                                                bleResizedWidth,
                                                bleResizedHeight));
                                recordTiming(requestId, "ble_compress_done");

                                if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
                                    Log.i(
                                            TAG,
                                            "COMPRESS: pipeline complete in "
                                                    + stage.totalMs()
                                                    + "ms - codec="
                                                    + bleEncodedFormat
                                                    + ", encode="
                                                    + encodeResult.encodeMs
                                                    + "ms, output="
                                                    + compressedData.length
                                                    + " bytes"
                                                    + ", crop_saved_vs_full_ble_est="
                                                    + String.format(
                                                            Locale.US,
                                                            "%.1fKB",
                                                            cropSavedVsFullBleBytes / 1024.0)
                                                    + ", est_full_ble="
                                                    + String.format(
                                                            Locale.US,
                                                            "%.1fKB",
                                                            estFullFrameBleBytes / 1024.0));
                                }
                                logBlePhotoStep(
                                        requestId,
                                        "ble_payload_ready",
                                        "retained "
                                                + compressedData.length
                                                + " encoded bytes in memory");
                                bleCompressedBytes.put(requestId, (long) compressedData.length);
                                if (originalSizeBytes > 0) {
                                    bleOriginalBytes.put(requestId, originalSizeBytes);
                                }
                                if (AsgConstants.ENABLE_PHOTO_TIMING_LOGS) {
                                    bleImgIdToRequestId.put(bleImgId, requestId);
                                }

                                Log.i(
                                        TAG,
                                        "📦 BLE photo payload ready: "
                                                + bleResizedWidth
                                                + "x"
                                                + bleResizedHeight
                                                + ", "
                                                + String.format(Locale.US, "%.1f", compressedSizeKb)
                                                + " KB ("
                                                + bleEncodedFormat
                                                + ", requestId="
                                                + requestId
                                                + ", crop_saved_vs_full_ble_est="
                                                + String.format(
                                                        Locale.US,
                                                        "%.1fKB",
                                                        cropSavedVsFullBleBytes / 1024.0)
                                                + ", est_full_ble="
                                                + String.format(
                                                        Locale.US,
                                                        "%.1fKB",
                                                        estFullFrameBleBytes / 1024.0)
                                                + ")");

                                // 5. A requested gallery save is part of this operation's success
                                // contract. Resolve it before notifying the phone that BLE transfer
                                // has started, so one request can never report both transfer success
                                // and a later save failure.
                                boolean savePhotoRequested =
                                        Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                                if (capturedPhoto != null && savePhotoRequested) {
                                    boolean persisted =
                                            textModeRequested
                                                    ? persistTextModeSelectionFromMemory(
                                                            capturedPhoto,
                                                            originalPath,
                                                            requestId,
                                                            roi)
                                                    : capturedPhoto.awaitPersistenceCompletion();
                                    if (!persisted) {
                                        sendPhotoErrorResponse(
                                                requestId,
                                                "PHOTO_SAVE_FAILED",
                                                textModeRequested
                                                        ? "Could not save final text-mode output"
                                                        : "Could not save captured photo");
                                        return;
                                    }
                                }

                                // 6. Hand the compressed payload straight to the BLE transport.
                                // The K900 packet pump streams from an in-memory buffer (including
                                // retries), so no transport artifact is written to disk. bleImgId
                                // is the wire name (16-char protocol cap, no extension).
                                recordTiming(requestId, "ble_send_start");
                                bleTransferStarted =
                                        sendCompressedPhotoViaBle(
                                                compressedData,
                                                bleImgId,
                                                requestId,
                                                compressThreadStart);

                            } catch (Exception e) {
                                if (capturedPhoto != null
                                        && PhotoMode.TEXT.equals(
                                                PhotoMode.normalize(
                                                        photoRequestedModes.get(requestId)))
                                        && Boolean.TRUE.equals(photoSaveFlags.get(requestId))
                                        && !new File(originalPath).exists()) {
                                    persistTextModeSelectionFromMemory(
                                            capturedPhoto,
                                            originalPath,
                                            requestId,
                                            detectedTextRoi);
                                }
                                Log.e(TAG, "Error compressing photo for BLE", e);
                                dumpTimings(requestId);
                                clearBlePhotoPipelineTracking(requestId, bleImgId);
                                sendPhotoErrorResponse(
                                        requestId, "BLE_TRANSFER_FAILED", e.getMessage());
                            } finally {
                                logBlePhotoStep(
                                        requestId,
                                        "cleanup_start",
                                        "cleaning up local capture and request state");
                                boolean savePhoto =
                                        Boolean.TRUE.equals(photoSaveFlags.get(requestId));
                                if (capturedPhoto != null) {
                                    // Non-text save=true captures may still have a background
                                    // sensor-JPEG write. Text mode uses a completed no-persistence
                                    // future and writes only its final selection above.
                                    if (!(!savePhoto && capturedPhoto.cancelPersistence())) {
                                        if (savePhoto) {
                                            capturedPhoto.awaitPersistenceCompletion();
                                        } else {
                                            capturedPhoto.awaitPersistence(
                                                    AsgConstants
                                                            .BLE_PHOTO_PERSISTENCE_AWAIT_TIMEOUT_MS);
                                        }
                                    }
                                }
                                cleanupPhotoArtifacts(requestId, originalPath, savePhoto);
                                // Keep timing state only when the BLE transport actually accepted
                                // the payload; transfer_complete owns it from that point forward.
                                if (!bleTransferStarted) {
                                    clearBlePhotoPipelineTracking(requestId, bleImgId);
                                }
                                clearPhotoRequestTracking(requestId);
                                // BLE compress + handoff (or its failure) ends our authority over
                                // the photo
                                // job. From here, mServiceCallback.isBleTransferInProgress() is the
                                // active
                                // gate against new requests (enforced by PhotoCommandHandler).
                                releasePhotoJob(requestId);
                                logBlePhotoStep(
                                        requestId,
                                        "cleanup_done",
                                        bleTransferStarted
                                                ? "photo job released after BLE handoff"
                                                : "photo job released without BLE handoff");
                                Log.d(
                                        TAG,
                                        "📡 Photo pipeline complete (BLE started="
                                                + bleTransferStarted
                                                + ") - photo job released: "
                                                + requestId);
                            }
                        })
                .start();
    }

    /** Send compressed photo via BLE, streaming the payload directly from memory. */
    private boolean sendCompressedPhotoViaBle(
            byte[] compressedData, String bleImgId, String requestId, long transferStartTime) {
        logBlePhotoStep(
                requestId,
                "ble_send_start",
                "bleImgId="
                        + bleImgId
                        + ", payload="
                        + compressedData.length
                        + " bytes (in-memory)");

        // TESTING: Check for fake BLE transfer failure
        if (PhotoCaptureTestHooks.shouldFail("BLE_TRANSFER")) {
            Log.e(TAG, "TESTING: Simulating BLE transfer failure");
            sendPhotoErrorResponse(
                    requestId,
                    PhotoCaptureTestHooks.getErrorCode(),
                    PhotoCaptureTestHooks.getErrorMessage());
            clearBlePhotoPipelineTracking(requestId, bleImgId);
            return false;
        }

        // TESTING: Add fake delay for BLE transfer
        PhotoCaptureTestHooks.addFakeDelay("BLE_TRANSFER");

        boolean transferStarted = false;
        try {
            logBlePhotoStep(
                    requestId,
                    "ble_availability_check",
                    "checking service callback and whether another BLE transfer is active");
            if (mServiceCallback != null) {
                // CRITICAL: Check if BLE is busy BEFORE sending ANY data to BES2700
                if (mServiceCallback.isBleTransferInProgress()) {
                    Log.e(
                            TAG,
                            "❌ BLE transfer already in progress - queuing error message to avoid"
                                    + " BES2700 overload");

                    // Send error response immediately
                    sendPhotoErrorResponse(
                            requestId,
                            "BLE_TRANSFER_BUSY",
                            "BLE transfer busy - another transfer in progress");
                    clearBlePhotoPipelineTracking(requestId, bleImgId);

                    // Also notify local listener
                    if (mMediaCaptureListener != null) {
                        mMediaCaptureListener.onMediaError(
                                requestId,
                                "BLE transfer busy - another transfer in progress",
                                MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                    }
                    return false;
                }

                // BLE is available - send the ready message first (phone expects this for timing
                // tracking)
                logBlePhotoStep(
                        requestId,
                        "ble_ready_msg",
                        "notified phone that compressed photo is ready");
                sendBlePhotoReadyMsg(bleImgId, requestId, transferStartTime);

                // Brief delay so the ble_photo_ready JSON drains ahead of file packets.
                // Was 200ms; the firmware TX window now queues both in order (and the
                // phone's reassembly tolerates packets arriving before the JSON), so
                // 20ms is a safety margin, not a required gap. Hardware-validate: a
                // regression shows up as first-packet retries in the transfer logs.
                logBlePhotoStep(
                        requestId,
                        "ble_ready_delay_start",
                        "waiting 20ms for the ready message to drain before file packets");
                try {
                    Thread.sleep(20);
                } catch (InterruptedException e) {
                    Log.w(TAG, "Delay interrupted", e);
                }
                logBlePhotoStep(requestId, "ble_ready_delay_done");

                // Then try to start the file transfer
                logBlePhotoStep(requestId, "ble_file_transfer_start", "starting UART packet pump");
                byte[] transferringStatus = buildPhotoStatusPayload(requestId, "transferring");
                transferStarted =
                        transferringStatus != null
                                && mServiceCallback.sendFileViaBluetooth(
                                        compressedData, bleImgId, transferringStatus);

                if (transferStarted) {
                    logBlePhotoStep(
                            requestId,
                            "ble_transfer_started",
                            "streaming file to phone; waiting for transfer_complete");
                } else {
                    // This shouldn't happen since we checked above, but handle it anyway
                    Log.e(TAG, "Failed to start BLE file transfer despite availability check");
                    clearBlePhotoPipelineTracking(requestId, bleImgId);
                    sendPhotoErrorResponse(
                            requestId,
                            "BLE_TRANSFER_FAILED_TO_START",
                            "BLE transfer failed to start");
                }
            } else {
                Log.e(TAG, "Service callback not available for BLE file transfer");
                clearBlePhotoPipelineTracking(requestId, bleImgId);
                sendPhotoErrorResponse(
                        requestId, "BLE_TRANSFER_FAILED", "Service callback not available");
            }
        } finally {
            // The payload only ever lived in RAM - nothing to clean up on disk. Just clear
            // pipeline tracking if the transfer never started.
            if (!transferStarted) {
                clearBlePhotoPipelineTracking(requestId, bleImgId);
            }
        }
        return transferStarted;
    }

    /** Request BLE file transfer through AsgClientService */
    private void sendBlePhotoReadyMsg(String bleImgId, String requestId, long transferStartTime) {
        try {
            // Calculate compression duration on glasses side
            long compressionDuration = System.currentTimeMillis() - transferStartTime;
            BlePhotoTimingLog.event(
                    "TRANSFER",
                    "ble_photo_ready JSON sent to phone (compression took "
                            + compressionDuration
                            + "ms on glasses)");

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
     * Open + configure + preview the camera and hold it warm for {@code durationMs} without taking
     * a photo, so a later {@code take_photo} of the same {@code size}/{@code exposureTimeNs} reuses
     * the warm session and is near-instant. Emits {@code camera_status}: {@code warming} on accept,
     * {@code ready} once preview/AE is running, {@code stopped} when the keep-alive expires, and
     * {@code error} on failure.
     *
     * <p><b>Shared-camera safety:</b> if a video recording or RTMP/SRT/WHIP stream already owns the
     * camera the camera is already warm — emit {@code ready} immediately and do not take ownership.
     * If a photo job is mid-flight, reject with {@code error} so the in-flight capture is
     * undisturbed.
     *
     * @param requestId echoed in every {@code camera_status} event (required)
     * @param size resolution tier matching the warmed config ("low"/"medium"/"high"/"max")
     * @param exposureTimeNs optional manual shutter in ns; {@code null} = auto
     * @param durationMs keep-alive TTL in ms; {@code <= 0} uses the default warm-up hold
     * @param mode capture mode ("photo"/"text"); forwarded for text sensor size/crop alignment
     * @return true if the warm-up was accepted (or the camera was already warm), false otherwise
     */
    public boolean warmUpCamera(
            String requestId,
            String size,
            Long exposureTimeNs,
            long durationMs,
            String mode,
            @Nullable PhotoCaptureSettings captureSettings) {
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
                    requestId, "error", "photo_capture_in_progress", "Photo capture in progress");
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

        PhotoCaptureSettings warmSettings =
                captureSettings != null ? captureSettings : PhotoCaptureSettings.EMPTY;

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
                mode,
                warmSettings,
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
                        onCameraError(CameraOperationError.warmUpFailed(errorMessage));
                    }

                    @Override
                    public void onCameraError(CameraOperationError error) {
                        if (warmUpDispatching.get()) {
                            rejectedSynchronously.set(true);
                        }
                        sendCameraStatus(requestId, "error", error.code(), error.message());
                    }

                    @Override
                    public String getRequestId() {
                        return requestId;
                    }

                    @Override
                    public long getDurationMs() {
                        return Math.min(
                                durationMs, AsgConstants.CAMERA_WARM_UP_MAX_DURATION_MS);
                    }
                });
        warmUpDispatching.set(false);
        return !rejectedSynchronously.get();
    }

    /** Cancel a request-owned warm-up lease. Missing/already-expired request IDs are no-ops. */
    public void stopCameraWarmUp(String requestId) {
        CameraNeoService.stopCameraWarmUp(requestId);
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

    private void sendPhotoStatus(String requestId, String status) {
        sendPhotoStatus(requestId, status, null, null, null);
    }

    private byte[] buildPhotoStatusPayload(String requestId, String status) {
        if (requestId == null || requestId.isEmpty()) {
            return null;
        }
        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_status");
            json.put("requestId", requestId);
            json.put("status", status);
            json.put("timestamp", System.currentTimeMillis());
            return json.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating photo status", e);
            return null;
        }
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

    private void copyFirstJsonField(
            JSONObject target, JSONObject source, String targetKey, String... sourceKeys)
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
                    "⚠️ StateManager not set - cannot start battery monitoring (will retry if"
                            + " StateManager becomes available)");
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
                                        "⚠️ HardwareManager not available during battery monitoring"
                                                + " - skipping check");
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

    private void scheduleVideoThumbnail(String filePath) {
        String taskKey = new File(filePath).getAbsolutePath();
        VideoThumbnailTask task = new VideoThumbnailTask(taskKey);
        synchronized (videoThumbnailLifecycleLock) {
            if (isCleaningUp.get() || videoThumbnailExecutor.isShutdown()) {
                return;
            }
            if (videoThumbnailTasks.putIfAbsent(taskKey, task) != null) {
                return;
            }
            try {
                task.setExecution(videoThumbnailExecutor.submit(task));
            } catch (RejectedExecutionException e) {
                videoThumbnailTasks.remove(taskKey, task);
                Log.d(TAG, "Skipping video thumbnail during cleanup");
            }
        }
    }

    private boolean discardThumbnailAndDeleteVideo(File videoFile) {
        VideoThumbnailTask task = videoThumbnailTasks.get(videoFile.getAbsolutePath());
        if (task != null) {
            boolean deleted = task.discardAndDeleteVideo();
            videoThumbnailTasks.remove(videoFile.getAbsolutePath(), task);
            return deleted;
        }
        boolean deleted = !videoFile.exists() || videoFile.delete();
        if (deleted) {
            VideoThumbnailWriter.deleteSidecar(videoFile);
        }
        return deleted;
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

            // Close submission before waiting for integrity work. Existing thumbnail tasks drain
            // in parallel with the integrity wait, keeping the final main-thread wait short.
            synchronized (videoThumbnailLifecycleLock) {
                videoThumbnailExecutor.shutdown();
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
            try {
                if (!videoThumbnailExecutor.awaitTermination(
                        AsgConstants.VIDEO_THUMBNAIL_SHUTDOWN_TIMEOUT_MS,
                        TimeUnit.MILLISECONDS)) {
                    videoThumbnailTasks
                            .values()
                            .forEach(VideoThumbnailTask::cancelThumbnailWrite);
                    videoThumbnailExecutor.shutdownNow();
                    if (!videoThumbnailExecutor.awaitTermination(1, TimeUnit.SECONDS)) {
                        Log.w(TAG, "Video thumbnail executor did not terminate during cleanup");
                    }
                }
            } catch (InterruptedException e) {
                videoThumbnailTasks.values().forEach(VideoThumbnailTask::cancelThumbnailWrite);
                videoThumbnailExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            videoThumbnailTasks.clear();
            textModeProcessingExecutor.shutdown();
            try {
                if (!textModeProcessingExecutor.awaitTermination(3, TimeUnit.SECONDS)) {
                    textModeProcessingExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                textModeProcessingExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            videoCaptureIdsInFlight.clear();
            videoCaptureIdsPendingIntegrityCheck.clear();
            // Defensive: drop any pending upload targets so no auth token survives teardown and the
            // map can't grow without bound if a terminal path ever failed to consume its entry.
            uploadTargetsByCaptureId.clear();
            textRoiDetector.close();

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
