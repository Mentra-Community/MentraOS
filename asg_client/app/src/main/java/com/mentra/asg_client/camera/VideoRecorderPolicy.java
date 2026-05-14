package com.mentra.asg_client.camera;

import android.media.MediaRecorder;

import com.mentra.asg_client.settings.VideoSettings;

/**
 * Phase 2e prep: pure defaults and small decisions for {@link MediaRecorder} video capture.
 * Side-effectful setup stays in {@link CameraNeo#setupMediaRecorder(String)}.
 */
public final class VideoRecorderPolicy {

    public static final int AUDIO_ENCODING_BIT_RATE = 128_000;
    public static final int AUDIO_SAMPLING_RATE = 44_100;

    /** Warn when stop is requested before this many ms (possible corrupt MP4). */
    public static final long MIN_RECORDING_DURATION_WARN_MS = 500;

    private VideoRecorderPolicy() {}

    /**
     * H.264 video bitrate: higher for 1080p-class width, lower for 720p and below.
     * Matches historical {@code CameraNeo.setupMediaRecorder} (width ≥ 1920 → 16 Mbps).
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
