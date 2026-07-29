package com.mentra.asg_client.io.streaming.config;

import org.json.JSONObject;

/**
 * Configuration class for RTMP streaming parameters.
 * Allows SDK to specify video/audio quality settings that override defaults.
 */
public class RtmpStreamConfig {

    // Defaults used when caller omits video JSON (or a given field).
    public static final int DEFAULT_VIDEO_WIDTH = 1280;
    public static final int DEFAULT_VIDEO_HEIGHT = 720;
    public static final int DEFAULT_VIDEO_BITRATE = 2_500_000; // 2.5 Mbps
    public static final int DEFAULT_VIDEO_FPS = 15;
    public static final int MIN_VIDEO_FPS = 5;
    public static final int MAX_VIDEO_FPS = 30;

    public static final int DEFAULT_AUDIO_BITRATE = 64000; // 64 kbps
    public static final int DEFAULT_AUDIO_SAMPLE_RATE = 44100;
    public static final boolean DEFAULT_ECHO_CANCELLATION = false;
    public static final boolean DEFAULT_NOISE_SUPPRESSION = false;

    // Video config
    private int videoWidth = DEFAULT_VIDEO_WIDTH;
    private int videoHeight = DEFAULT_VIDEO_HEIGHT;
    /** Native camera / preview buffer size; 0 = unset (use {@link #getVideoWidth()} for surface). */
    private int captureWidth = 0;
    private int captureHeight = 0;
    private int videoBitrate = DEFAULT_VIDEO_BITRATE;
    private int videoFps = DEFAULT_VIDEO_FPS;

    // Audio config
    private int audioBitrate = DEFAULT_AUDIO_BITRATE;
    private int audioSampleRate = DEFAULT_AUDIO_SAMPLE_RATE;
    private boolean echoCancellation = DEFAULT_ECHO_CANCELLATION;
    private boolean noiseSuppression = DEFAULT_NOISE_SUPPRESSION;

    /**
     * Create a config with default values
     */
    public RtmpStreamConfig() {
    }

    /**
     * Parse video and audio config from JSON objects sent by the SDK.
     * Supports both full key names and compact keys for MTU-constrained messages:
     *   Full: { width, height, bitrate, frameRate } / { bitrate, sampleRate, echoCancellation, noiseSuppression }
     *   Compact: { w, h, br, fr } / { br, sr, ec, ns }
     * FPS also accepts {@code fps} / {@code f} (miniapp SDK / BleJsonCompact).
     * When both a full key and its compact alias are present, the full key wins.
     *
     * @param videoJson Video configuration JSON (nullable)
     * @param audioJson Audio configuration JSON (nullable)
     * @return RtmpStreamConfig with parsed values (or defaults if not specified)
     */
    public static RtmpStreamConfig fromJson(JSONObject videoJson, JSONObject audioJson) {
        RtmpStreamConfig config = new RtmpStreamConfig();

        if (videoJson != null) {
            int width = optIntWithFallback(videoJson, "width", "w", DEFAULT_VIDEO_WIDTH);
            int height = optIntWithFallback(videoJson, "height", "h", DEFAULT_VIDEO_HEIGHT);
            config.videoBitrate = optIntWithFallback(videoJson, "bitrate", "br", DEFAULT_VIDEO_BITRATE);
            // Prefer frameRate (phone BLE wire), then fr / fps / f. First key present wins.
            config.videoFps = firstPresentInt(
                videoJson, DEFAULT_VIDEO_FPS, "frameRate", "fr", "fps", "f");

            config.videoWidth = normalizeDimension(width, 320, 1920);
            config.videoHeight = normalizeDimension(height, 240, 1080);
            config.videoBitrate = clamp(config.videoBitrate, 100000, 10000000);
            config.videoFps = clamp(config.videoFps, MIN_VIDEO_FPS, MAX_VIDEO_FPS);
        }

        // Parse audio config (supports both full and compact keys)
        if (audioJson != null) {
            config.audioBitrate = optIntWithFallback(audioJson, "bitrate", "br", DEFAULT_AUDIO_BITRATE);
            config.audioSampleRate = optIntWithFallback(audioJson, "sampleRate", "sr", DEFAULT_AUDIO_SAMPLE_RATE);
            config.echoCancellation = optBoolWithFallback(audioJson, "echoCancellation", "ec", DEFAULT_ECHO_CANCELLATION);
            config.noiseSuppression = optBoolWithFallback(audioJson, "noiseSuppression", "ns", DEFAULT_NOISE_SUPPRESSION);

            // Validate and clamp values
            config.audioBitrate = clamp(config.audioBitrate, 32000, 320000); // 32 kbps to 320 kbps
            config.audioSampleRate = clamp(config.audioSampleRate, 22050, 48000);
        }

        return config;
    }

    /**
     * Try full key first, then compact key, then default.
     * When both keys are present, the full key wins.
     */
    private static int optIntWithFallback(JSONObject json, String fullKey, String compactKey, int defaultValue) {
        if (json.has(fullKey)) {
            return json.optInt(fullKey, defaultValue);
        }
        return json.optInt(compactKey, defaultValue);
    }

    /** First present key wins; otherwise {@code defaultValue}. */
    private static int firstPresentInt(JSONObject json, int defaultValue, String... keys) {
        for (String key : keys) {
            if (json.has(key)) {
                return json.optInt(key, defaultValue);
            }
        }
        return defaultValue;
    }

    /** Try full key first, then compact key, then default */
    private static boolean optBoolWithFallback(JSONObject json, String fullKey, String compactKey, boolean defaultValue) {
        if (json.has(fullKey)) {
            return json.optBoolean(fullKey, defaultValue);
        }
        return json.optBoolean(compactKey, defaultValue);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    /** Clamp then force to an even value (H.264 requires even width/height on most hardware encoders). */
    private static int normalizeDimension(int value, int min, int max) {
        int clamped = clamp(value, min, max);
        return clamped - (clamped % 2); // round down to nearest even
    }

    // Getters
    public int getVideoWidth() { return videoWidth; }
    public int getVideoHeight() { return videoHeight; }

    /** SurfaceTexture / camera buffer width (falls back to output width if unset). */
    public int getCaptureSurfaceWidth() {
        return captureWidth > 0 ? captureWidth : videoWidth;
    }

    /** SurfaceTexture / camera buffer height (falls back to output height if unset). */
    public int getCaptureSurfaceHeight() {
        return captureHeight > 0 ? captureHeight : videoHeight;
    }
    public int getVideoBitrate() { return videoBitrate; }
    public int getVideoFps() { return videoFps; }

    public int getAudioBitrate() { return audioBitrate; }
    public int getAudioSampleRate() { return audioSampleRate; }
    public boolean isEchoCancellation() { return echoCancellation; }
    public boolean isNoiseSuppression() { return noiseSuppression; }

    // Setters with validation
    public RtmpStreamConfig setVideoWidth(int width) {
        this.videoWidth = normalizeDimension(width, 320, 1920);
        return this;
    }

    public RtmpStreamConfig setVideoHeight(int height) {
        this.videoHeight = normalizeDimension(height, 240, 1080);
        return this;
    }

    public RtmpStreamConfig setVideoBitrate(int bitrate) {
        this.videoBitrate = clamp(bitrate, 100000, 10000000);
        return this;
    }

    public RtmpStreamConfig setVideoFps(int fps) {
        this.videoFps = clamp(fps, MIN_VIDEO_FPS, MAX_VIDEO_FPS);
        return this;
    }

    /** Returns the effective stream settings reported back through stream status events. */
    public JSONObject toStatusJson(String transport) {
        JSONObject resolvedConfig = new JSONObject();
        JSONObject video = new JSONObject();
        JSONObject audio = new JSONObject();
        try {
            resolvedConfig.put("transport", transport);
            video.put("width", getVideoWidth());
            video.put("height", getVideoHeight());
            video.put("captureWidth", getCaptureSurfaceWidth());
            video.put("captureHeight", getCaptureSurfaceHeight());
            video.put("bitrate", getVideoBitrate());
            video.put("fps", getVideoFps());
            resolvedConfig.put("video", video);
            audio.put("bitrate", getAudioBitrate());
            audio.put("sampleRate", getAudioSampleRate());
            audio.put("echoCancellation", isEchoCancellation());
            audio.put("noiseSuppression", isNoiseSuppression());
            resolvedConfig.put("audio", audio);
        } catch (Exception ignored) {
            // JSONObject writes above are deterministic for primitive values.
        }
        return resolvedConfig;
    }

    /**
     * Sets native camera capture dimensions (from {@code CameraCharacteristics} preflight).
     * Stored exactly as selected so preview surfaces match an advertised
     * {@link android.graphics.SurfaceTexture} size (no clamp; modes may exceed 4096).
     * Non-positive width or height clears capture and falls back to output size for the surface.
     */
    public RtmpStreamConfig setCaptureSize(int width, int height) {
        if (width <= 0 || height <= 0) {
            this.captureWidth = 0;
            this.captureHeight = 0;
            return this;
        }
        this.captureWidth = width;
        this.captureHeight = height;
        return this;
    }

    public RtmpStreamConfig setAudioBitrate(int bitrate) {
        this.audioBitrate = clamp(bitrate, 32000, 320000);
        return this;
    }

    public RtmpStreamConfig setAudioSampleRate(int sampleRate) {
        this.audioSampleRate = clamp(sampleRate, 22050, 48000);
        return this;
    }

    public RtmpStreamConfig setEchoCancellation(boolean enabled) {
        this.echoCancellation = enabled;
        return this;
    }

    public RtmpStreamConfig setNoiseSuppression(boolean enabled) {
        this.noiseSuppression = enabled;
        return this;
    }

    @Override
    public String toString() {
        return "RtmpStreamConfig{" +
                "video=" + videoWidth + "x" + videoHeight
                + (captureWidth > 0 ? " capture=" + captureWidth + "x" + captureHeight : "")
                + "@" + videoFps + "fps, " + (videoBitrate/1000) + "kbps" +
                ", audio=" + (audioBitrate/1000) + "kbps@" + audioSampleRate + "Hz" +
                ", echo=" + echoCancellation + ", noise=" + noiseSuppression +
                '}';
    }
}
