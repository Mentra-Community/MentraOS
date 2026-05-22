package com.mentra.asg_client.camera.policy;

import android.media.MediaRecorder;

import com.mentra.asg_client.settings.VideoSettings;

/**
 * Phase 2e prep: pure defaults and small decisions for {@link MediaRecorder} video capture.
 * Side-effectful setup stays in {@link CameraNeoService#setupMediaRecorder(String)}.
 */
public final class VideoRecorderPolicy {

    public static final int AUDIO_ENCODING_BIT_RATE = 128_000;
    public static final int AUDIO_SAMPLING_RATE = 44_100;

    /** Warn when stop is requested before this many ms (possible corrupt MP4). */
    public static final long MIN_RECORDING_DURATION_WARN_MS = 500;

    /**
     * Delay between starting the repeating preview and calling {@link MediaRecorder#start()}.
     * Ensures the recorder surface has received the first frames so the resulting MP4 has both
     * video and audio (prevents audio-only recordings). Phase 3.4 named this constant.
     */
    public static final long RECORDER_SURFACE_WARMUP_MS = 900;

    private VideoRecorderPolicy() {}

    /**
     * H.264 video bitrate: higher for 1080p-class width, lower for 720p and below.
     * Matches historical {@code CameraNeoService.setupMediaRecorder} (width ≥ 1920 → 16 Mbps).
     */
    public static int videoEncodingBitRateForWidth(int widthPx) {
        return (widthPx >= 1920) ? 16_000_000 : 8_000_000;
    }

    public static int videoFrameRate(VideoSettings settings) {
        return (settings != null) ? settings.fps : 30;
    }

    /** User-facing message for {@link MediaRecorder.OnErrorListener}. */
    public static String mediaRecorderErrorMessage(int what) {
        if (what == MediaRecorder.MEDIA_ERROR_SERVER_DIED) {
            return "Media server died during recording";
        }
        if (what == MediaRecorder.MEDIA_RECORDER_ERROR_UNKNOWN) {
            return "Unknown recording error occurred";
        }
        return "Recording error: " + what;
    }

    public static boolean isInfoMaxDurationReached(int what) {
        return what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED;
    }

    public static boolean isInfoMaxFileSizeReached(int what) {
        return what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED;
    }

    public static boolean isInfoMaxFileSizeApproaching(int what) {
        return what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_APPROACHING;
    }
}
