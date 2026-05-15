package com.mentra.asg_client.io.streaming.config;

import org.json.JSONObject;

/**
 * Configuration class for WebRTC / WHIP streaming parameters.
 */
public class WhipStreamConfig {

  public static final int DEFAULT_VIDEO_WIDTH = 854;
  public static final int DEFAULT_VIDEO_HEIGHT = 480;
  public static final int DEFAULT_VIDEO_FPS = 15;
  public static final int DEFAULT_VIDEO_BITRATE = 1000000; // 1 Mbps

  public static final boolean DEFAULT_ECHO_CANCELLATION = false;
  public static final boolean DEFAULT_NOISE_SUPPRESSION = false;

  public static final String DEFAULT_STUN_SERVER = "stun:stun.cloudflare.com:3478";

  private int videoWidth = DEFAULT_VIDEO_WIDTH;
  private int videoHeight = DEFAULT_VIDEO_HEIGHT;
  private int videoFps = DEFAULT_VIDEO_FPS;
  private int videoBitrate = DEFAULT_VIDEO_BITRATE;

  private boolean echoCancellation = DEFAULT_ECHO_CANCELLATION;
  private boolean noiseSuppression = DEFAULT_NOISE_SUPPRESSION;

  private String stunServer = DEFAULT_STUN_SERVER;

  public WhipStreamConfig() {
  }

  /**
   * Parse video and audio config from JSON objects sent by the SDK.
   * Supports both full key names and compact keys for MTU-constrained messages:
   *   Full: { width, height, bitrate, frameRate } / { echoCancellation, noiseSuppression }
   *   Compact: { w, h, br, fr } / { ec, ns }
   */
  public static WhipStreamConfig fromJson(JSONObject videoJson, JSONObject audioJson) {
    WhipStreamConfig config = new WhipStreamConfig();

    if (videoJson != null) {
      config.videoWidth = clamp(optIntWithFallback(videoJson, "width", "w", DEFAULT_VIDEO_WIDTH), 320, 1920);
      config.videoHeight = clamp(optIntWithFallback(videoJson, "height", "h", DEFAULT_VIDEO_HEIGHT), 240, 1080);
      config.videoBitrate = clamp(optIntWithFallback(videoJson, "bitrate", "br", DEFAULT_VIDEO_BITRATE), 100000, 10000000);
      config.videoFps = clamp(optIntWithFallback(videoJson, "frameRate", "fr", DEFAULT_VIDEO_FPS), 10, 60);
    }

    if (audioJson != null) {
      config.echoCancellation = optBoolWithFallback(audioJson, "echoCancellation", "ec", DEFAULT_ECHO_CANCELLATION);
      config.noiseSuppression = optBoolWithFallback(audioJson, "noiseSuppression", "ns", DEFAULT_NOISE_SUPPRESSION);
    }

    return config;
  }

  private static int optIntWithFallback(JSONObject json, String fullKey, String compactKey, int defaultValue) {
    if (json.has(fullKey)) return json.optInt(fullKey, defaultValue);
    return json.optInt(compactKey, defaultValue);
  }

  private static boolean optBoolWithFallback(JSONObject json, String fullKey, String compactKey, boolean defaultValue) {
    if (json.has(fullKey)) return json.optBoolean(fullKey, defaultValue);
    return json.optBoolean(compactKey, defaultValue);
  }

  private static int clamp(int value, int min, int max) {
    return Math.max(min, Math.min(max, value));
  }

  // Getters
  public int getVideoWidth() { return videoWidth; }
  public int getVideoHeight() { return videoHeight; }
  public int getVideoFps() { return videoFps; }
  public int getVideoBitrate() { return videoBitrate; }
  public boolean isEchoCancellation() { return echoCancellation; }
  public boolean isNoiseSuppression() { return noiseSuppression; }
  public String getStunServer() { return stunServer; }

  // Setters with validation (fluent API)
  public WhipStreamConfig setVideoWidth(int width) {
    this.videoWidth = clamp(width, 320, 1920);
    return this;
  }

  public WhipStreamConfig setVideoHeight(int height) {
    this.videoHeight = clamp(height, 240, 1080);
    return this;
  }

  public WhipStreamConfig setVideoFps(int fps) {
    this.videoFps = clamp(fps, 10, 60);
    return this;
  }

  public WhipStreamConfig setVideoBitrate(int bitrate) {
    this.videoBitrate = clamp(bitrate, 100000, 10000000);
    return this;
  }

  public WhipStreamConfig setEchoCancellation(boolean enabled) {
    this.echoCancellation = enabled;
    return this;
  }

  public WhipStreamConfig setNoiseSuppression(boolean enabled) {
    this.noiseSuppression = enabled;
    return this;
  }

  public WhipStreamConfig setStunServer(String stunServer) {
    this.stunServer = stunServer;
    return this;
  }

  @Override
  public String toString() {
    return "WhipStreamConfig{"
        + "video=" + videoWidth + "x" + videoHeight + "@" + videoFps + "fps, "
        + (videoBitrate / 1000) + "kbps"
        + ", echo=" + echoCancellation
        + ", noise=" + noiseSuppression
        + ", stun=" + stunServer
        + '}';
  }
}
