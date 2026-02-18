package com.mentra.asg_client.io.streaming.config;

import org.json.JSONObject;

/**
 * Configuration class for RTMP streaming parameters.
 * Allows SDK to specify video/audio quality settings that override defaults.
 */
public class RtmpStreamConfig {

    // Default values (matching current hardcoded values)
    public static final int DEFAULT_VIDEO_WIDTH = 1280;
    public static final int DEFAULT_VIDEO_HEIGHT = 720;
    public static final int DEFAULT_VIDEO_BITRATE = 2000000; // 2 Mbps
    public static final int DEFAULT_VIDEO_FPS = 30;

    public static final int DEFAULT_AUDIO_BITRATE = 64000; // 64 kbps
    public static final int DEFAULT_AUDIO_SAMPLE_RATE = 44100;
    public static final boolean DEFAULT_ECHO_CANCELLATION = false;
    public static final boolean DEFAULT_NOISE_SUPPRESSION = false;

    // Video config
    private int videoWidth = DEFAULT_VIDEO_WIDTH;
    private int videoHeight = DEFAULT_VIDEO_HEIGHT;
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
     *
     * @param videoJson Video configuration JSON (nullable)
     * @param audioJson Audio configuration JSON (nullable)
     * @return RtmpStreamConfig with parsed values (or defaults if not specified)
     */
    public static RtmpStreamConfig fromJson(JSONObject videoJson, JSONObject audioJson) {
        RtmpStreamConfig config = new RtmpStreamConfig();

        // Parse video config (supports both full and compact keys)
        if (videoJson != null) {
            config.videoWidth = optIntWithFallback(videoJson, "width", "w", DEFAULT_VIDEO_WIDTH);
            config.videoHeight = optIntWithFallback(videoJson, "height", "h", DEFAULT_VIDEO_HEIGHT);
            config.videoBitrate = optIntWithFallback(videoJson, "bitrate", "br", DEFAULT_VIDEO_BITRATE);
            config.videoFps = optIntWithFallback(videoJson, "frameRate", "fr", DEFAULT_VIDEO_FPS);

            // Validate and clamp values to reasonable ranges
            config.videoWidth = clamp(config.videoWidth, 320, 1920);
            config.videoHeight = clamp(config.videoHeight, 240, 1080);
            config.videoBitrate = clamp(config.videoBitrate, 100000, 10000000); // 100 kbps to 10 Mbps
            config.videoFps = clamp(config.videoFps, 10, 60);
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

    /** Try full key first, then compact key, then default */
    private static int optIntWithFallback(JSONObject json, String fullKey, String compactKey, int defaultValue) {
        if (json.has(fullKey)) {
            return json.optInt(fullKey, defaultValue);
        }
        return json.optInt(compactKey, defaultValue);
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

    // Getters
    public int getVideoWidth() { return videoWidth; }
    public int getVideoHeight() { return videoHeight; }
    public int getVideoBitrate() { return videoBitrate; }
    public int getVideoFps() { return videoFps; }

    public int getAudioBitrate() { return audioBitrate; }
    public int getAudioSampleRate() { return audioSampleRate; }
    public boolean isEchoCancellation() { return echoCancellation; }
    public boolean isNoiseSuppression() { return noiseSuppression; }

    // Setters with validation
    public RtmpStreamConfig setVideoWidth(int width) {
        this.videoWidth = clamp(width, 320, 1920);
        return this;
    }

    public RtmpStreamConfig setVideoHeight(int height) {
        this.videoHeight = clamp(height, 240, 1080);
        return this;
    }

    public RtmpStreamConfig setVideoBitrate(int bitrate) {
        this.videoBitrate = clamp(bitrate, 100000, 10000000);
        return this;
    }

    public RtmpStreamConfig setVideoFps(int fps) {
        this.videoFps = clamp(fps, 10, 60);
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
                "video=" + videoWidth + "x" + videoHeight + "@" + videoFps + "fps, " + (videoBitrate/1000) + "kbps" +
                ", audio=" + (audioBitrate/1000) + "kbps@" + audioSampleRate + "Hz" +
                ", echo=" + echoCancellation + ", noise=" + noiseSuppression +
                '}';
    }
}
