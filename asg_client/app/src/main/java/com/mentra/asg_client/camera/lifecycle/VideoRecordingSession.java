package com.mentra.asg_client.camera.lifecycle;

import android.content.Context;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureRequest;
import android.media.MediaRecorder;
import android.os.Handler;
import android.util.Log;
import android.util.Size;
import android.view.Surface;

import com.mentra.asg_client.io.storage.StorageManager;
import com.mentra.asg_client.sensors.ImuRecorder;
import com.mentra.asg_client.settings.VideoSettings;

import com.mentra.asg_client.camera.CameraNeoService;

import com.mentra.asg_client.camera.policy.VideoRecorderPolicy;

import java.io.File;
import java.io.IOException;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.Executor;

/**
 * Phase 2.1: dedicated owner of MediaRecorder + recorder surface + timer + IMU recording.
 *
 * <p>Carved out of {@link CameraNeoService} per the refactor plan so video logic lives outside the
 * camera service. Behavior is preserved bit-for-bit; only ownership moves.
 *
 * <p>The camera device, capture session, and preview {@link CaptureRequest.Builder} stay in
 * {@link CameraNeoService}; they're passed in at {@link #startRecording(CameraCaptureSession, CaptureRequest.Builder)}
 * time. IMU lifecycle and post-stop cleanup (camera close + service stop) are delegated via
 * {@link Hooks}, since they're cross-cutting concerns owned by the host service.
 */
public final class VideoRecordingSession {

    /** Lifecycle callbacks delivered to the original `VideoRecordingCallback`. */
    public interface Callback {
        void onRecordingStarted(String videoId);
        void onRecordingProgress(String videoId, long durationMs);
        void onRecordingStopped(String videoId, String filePath);
        void onRecordingError(String videoId, String errorMessage);
    }

    /** Cross-cutting integration points back into the camera service. */
    public interface Hooks {
        /** Lazy-create or return the host service's IMU recorder. */
        ImuRecorder ensureImuRecorder();

        /** Current IMU recorder if one exists, else {@code null}. */
        ImuRecorder currentImuRecorder();

        /** EXIF orientation hint for {@link MediaRecorder#setOrientationHint(int)}. */
        int videoOrientation();

        /** Called after a stop / failure once recorder cleanup is done — host closes camera. */
        void onSessionTerminated();
    }

    private static final String TAG = "VideoRecordingSession";
    private static volatile CameraNeoService.VideoRecordingCallback pendingVideoCallback;

    private final Context context;
    private final Handler backgroundHandler;
    private final Executor callbackExecutor;
    private final Hooks hooks;

    private Callback callback;

    private MediaRecorder mediaRecorder;
    private Surface recorderSurface;
    private boolean isRecording;
    private String currentVideoId;
    private String currentVideoPath;
    private Size videoSize;
    private VideoSettings pendingSettings;
    private long recordingStartTime;
    private Timer recordingTimer;

    public VideoRecordingSession(Context context,
                                 Handler backgroundHandler,
                                 Executor callbackExecutor,
                                 Hooks hooks) {
        this.context = context;
        this.backgroundHandler = backgroundHandler;
        this.callbackExecutor = callbackExecutor;
        this.hooks = hooks;
    }

    public void setCallback(Callback callback) { this.callback = callback; }

    public static void setPendingVideoCallback(CameraNeoService.VideoRecordingCallback callback) {
        pendingVideoCallback = callback;
    }

    public static CameraNeoService.VideoRecordingCallback pendingVideoCallback() {
        return pendingVideoCallback;
    }

    public String currentVideoId() { return currentVideoId; }
    public String currentVideoPath() { return currentVideoPath; }
    public boolean isRecording() { return isRecording; }
    public VideoSettings pendingSettings() { return pendingSettings; }
    public Size videoSize() { return videoSize; }
    public Surface recorderSurface() { return recorderSurface; }
    public MediaRecorder mediaRecorder() { return mediaRecorder; }

    /** Capture intent → record the video id/path/settings. Returns false if already recording. */
    public boolean prepareRequest(String videoId, String filePath, VideoSettings settings) {
        if (isRecording) return false;
        currentVideoId = videoId;
        currentVideoPath = filePath;
        pendingSettings = settings;
        return true;
    }

    /**
     * Set the video size chosen by the camera characteristics scan in {@link CameraNeoService}.
     * Kept separate from {@link #prepareRequest} because the size selection requires camera
     * characteristics which are only available after the camera is opened.
     */
    public void setVideoSize(Size size) { this.videoSize = size; }

    /**
     * Configure the underlying {@link MediaRecorder}, prepare it, and surface the encoder input.
     * Caller (CameraNeoService) adds the returned surface to its capture session target list.
     *
     * @throws IOException on storage exhaustion or prepare() failure.
     */
    public Surface setupMediaRecorder() throws IOException {
        StorageManager storageManager = StorageManager.getInstance(context);
        if (!storageManager.canRecordVideo()) {
            throw new IOException("Insufficient storage space for video recording");
        }

        if (mediaRecorder == null) {
            mediaRecorder = new MediaRecorder();
        } else {
            mediaRecorder.reset();
        }

        mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
        mediaRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
        mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        mediaRecorder.setOutputFile(currentVideoPath);

        int bitRate = VideoRecorderPolicy.videoEncodingBitRateForWidth(videoSize.getWidth());
        mediaRecorder.setVideoEncodingBitRate(bitRate);

        int frameRate = VideoRecorderPolicy.videoFrameRate(pendingSettings);
        mediaRecorder.setVideoFrameRate(frameRate);
        Log.i(TAG, "Setting video resolution: " + videoSize.getWidth() + "x" + videoSize.getHeight());
        mediaRecorder.setVideoSize(videoSize.getWidth(), videoSize.getHeight());
        mediaRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);

        Log.d(TAG, "MediaRecorder configured: " + videoSize.getWidth() + "x" + videoSize.getHeight()
                + "@" + frameRate + "fps, bitrate: " + bitRate);

        mediaRecorder.setAudioEncodingBitRate(VideoRecorderPolicy.AUDIO_ENCODING_BIT_RATE);
        mediaRecorder.setAudioSamplingRate(VideoRecorderPolicy.AUDIO_SAMPLING_RATE);
        mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);

        mediaRecorder.setOrientationHint(hooks.videoOrientation());

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

        mediaRecorder.setOnErrorListener((mr, what, extra) -> {
            Log.e(TAG, "MediaRecorder error: what=" + what + ", extra=" + extra);
            isRecording = false;
            String errorMsg = VideoRecorderPolicy.mediaRecorderErrorMessage(what);
            // Stop IMU first: it unregisters the sensor listener and closes/discards the partial.
            // Otherwise the listener keeps running and writing into a directory deleteCorruptCapture
            // is about to wipe. Mirrors the stop()-failure path.
            ImuRecorder imu = hooks.currentImuRecorder();
            if (imu != null) {
                imu.cancel();
            }
            deleteCorruptCapture(currentVideoPath);
            notifyError(currentVideoId, errorMsg);
            try {
                if (mediaRecorder != null) {
                    mediaRecorder.reset();
                }
            } catch (Exception e) {
                Log.e(TAG, "Error resetting MediaRecorder after error", e);
            }
        });

        mediaRecorder.setOnInfoListener((mr, what, extra) -> {
            Log.d(TAG, "MediaRecorder info: what=" + what + ", extra=" + extra);
            if (VideoRecorderPolicy.isInfoMaxDurationReached(what)) {
                Log.w(TAG, "Max duration reached, stopping recording");
                stopRecording(currentVideoId);
            } else if (VideoRecorderPolicy.isInfoMaxFileSizeReached(what)) {
                Log.w(TAG, "Max file size reached, stopping recording");
                stopRecording(currentVideoId);
            } else if (VideoRecorderPolicy.isInfoMaxFileSizeApproaching(what)) {
                Log.w(TAG, "Approaching max file size limit");
            }
        });

        mediaRecorder.prepare();
        recorderSurface = mediaRecorder.getSurface();
        Log.d(TAG, "MediaRecorder setup complete for: " + currentVideoPath);
        return recorderSurface;
    }

    /**
     * Begin the repeating preview request, wait the configured warmup delay, then start the
     * encoder + IMU + progress timer. Mirrors the historical {@code startRecordingInternal}.
     */
    public void startRecording(CameraCaptureSession session, CaptureRequest.Builder previewBuilder)
            throws CameraAccessException {
        if (session == null || mediaRecorder == null) {
            notifyError(currentVideoId, "Cannot start recording, camera not ready.");
            return;
        }
        session.setRepeatingRequest(previewBuilder.build(), null, backgroundHandler);

        backgroundHandler.postDelayed(() -> {
            try {
                if (recorderSurface == null || !recorderSurface.isValid()) {
                    Log.e(TAG, "Camera not ready for recording - surface invalid");
                    notifyError(currentVideoId, "Camera not ready for recording");
                    return;
                }

                mediaRecorder.start();
                // Anchor for the video timeline on the IMU clock (elapsedRealtimeNanos), captured as
                // close to recorder start as possible. Written to the IMU sidecar so the consumer can
                // align frames (relative MP4 PTS) to IMU samples and subtract the fixed startup offset.
                long videoStartElapsedRealtimeNs = android.os.SystemClock.elapsedRealtimeNanos();
                isRecording = true;
                recordingStartTime = System.currentTimeMillis();

                ImuRecorder imu = hooks.ensureImuRecorder();
                if (imu != null) {
                    imu.startRecording(currentVideoPath);
                    imu.setVideoStartAnchor(videoStartElapsedRealtimeNs);
                }

                pendingSettings = null;
                final String startedId = currentVideoId;
                if (callback != null) {
                    callbackExecutor.execute(() -> {
                        if (callback != null) callback.onRecordingStarted(startedId);
                    });
                }
                if (callback != null) {
                    recordingTimer = new Timer();
                    recordingTimer.schedule(new TimerTask() {
                        @Override
                        public void run() {
                            if (!isRecording || callback == null) return;
                            long duration = System.currentTimeMillis() - recordingStartTime;
                            final String tickId = currentVideoId;
                            callbackExecutor.execute(() -> {
                                if (callback != null) callback.onRecordingProgress(tickId, duration);
                            });
                        }
                    }, 1000, 1000);
                }
                Log.d(TAG, "Video recording started for: " + currentVideoId);
            } catch (Exception e) {
                Log.e(TAG, "Failed to start recording after delay", e);
                notifyError(currentVideoId, "Failed to start recording: " + e.getMessage());
                isRecording = false;
                // IMU may already be recording (started above); stop it so the sensor listener and
                // partial stream don't keep running after a failed start.
                ImuRecorder imu = hooks.currentImuRecorder();
                if (imu != null) {
                    imu.cancel();
                }
            }
        }, VideoRecorderPolicy.RECORDER_SURFACE_WARMUP_MS);
    }

    /**
     * Stop the recording for {@code videoIdToStop}. Mismatch / not-recording cases are routed to
     * {@link Callback#onRecordingError}. After successful or failed stop the host service is
     * informed via {@link Hooks#onSessionTerminated()} so it can close the camera.
     */
    public void stopRecording(String videoIdToStop) {
        if (!isRecording) {
            Log.w(TAG, "Stop recording requested, but not currently recording.");
            if (videoIdToStop != null) {
                notifyError(videoIdToStop, "Not recording");
            }
            return;
        }
        if (videoIdToStop == null || !videoIdToStop.equals(currentVideoId)) {
            Log.w(TAG, "Stop recording requested for ID " + videoIdToStop
                    + " but current is " + currentVideoId);
            if (videoIdToStop != null) {
                notifyError(videoIdToStop, "Video ID mismatch");
            }
            return;
        }

        try {
            if (mediaRecorder != null) {
                long recordingDuration = System.currentTimeMillis() - recordingStartTime;
                if (recordingDuration < VideoRecorderPolicy.MIN_RECORDING_DURATION_WARN_MS) {
                    Log.w(TAG, "Recording duration too short (" + recordingDuration
                            + "ms), file may be corrupted");
                    if (callback != null) {
                        Log.w(TAG, "Warning: Video recording was very short, file may be corrupted");
                    }
                }

                mediaRecorder.stop();
                mediaRecorder.reset();
            }
            Log.d(TAG, "Video recording stopped for: " + currentVideoId);

            ImuRecorder imu = hooks.currentImuRecorder();
            if (imu != null && currentVideoPath != null) {
                String imuPath = imu.stopRecordingAndSave(currentVideoPath);
                if (imuPath != null) {
                    Log.d(TAG, "Video IMU sidecar saved: " + imuPath);
                }
            }

            final String stoppedId = currentVideoId;
            final String stoppedPath = currentVideoPath;
            if (callback != null) {
                callbackExecutor.execute(() -> {
                    if (callback != null) callback.onRecordingStopped(stoppedId, stoppedPath);
                });
            }
        } catch (RuntimeException stopErr) {
            Log.e(TAG, "MediaRecorder.stop() failed", stopErr);
            ImuRecorder imu = hooks.currentImuRecorder();
            if (imu != null) {
                imu.cancel();
            }
            deleteCorruptCapture(currentVideoPath);
            notifyError(currentVideoId, "Failed to stop recorder: " + stopErr.getMessage());
        } finally {
            isRecording = false;
            if (recordingTimer != null) {
                recordingTimer.cancel();
                recordingTimer = null;
            }
            hooks.onSessionTerminated();
        }
    }

    /** Release the encoder + surface. Called from CameraNeoService.closeCamera(). */
    public void release() {
        if (mediaRecorder != null) {
            mediaRecorder.release();
            mediaRecorder = null;
        }
        if (recorderSurface != null) {
            recorderSurface.release();
            recorderSurface = null;
        }
    }

    /** Notify the registered callback of an error; safe to call when no callback is registered. */
    public void notifyError(String videoId, String errorMessage) {
        if (callback != null && videoId != null) {
            final Callback cb = callback;
            callbackExecutor.execute(() -> cb.onRecordingError(videoId, errorMessage));
        }
    }

    /**
     * Delete a corrupt/incomplete capture directory so it never syncs.
     *
     * <p>Static helper — pure file IO, no instance state. Public so it can be unit-tested without
     * standing up an entire VRS instance.
     */
    public static void deleteCorruptCapture(String videoPath) {
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
}
