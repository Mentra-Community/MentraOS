package com.mentra.asg_client.io.streaming.config;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Configuration class for WebRTC / WHIP streaming parameters.
 */
public class WhipStreamConfig {

  public static final int DEFAULT_VIDEO_WIDTH = 854;
  public static final int DEFAULT_VIDEO_HEIGHT = 480;
  public static final int DEFAULT_VIDEO_FPS = 15;
  public static final int DEFAULT_VIDEO_BITRATE = 1000000; // 1 Mbps
  public static final int MIN_VIDEO_FPS = 5;
  public static final int MAX_VIDEO_FPS = 30;

  public static final boolean DEFAULT_ECHO_CANCELLATION = false;
  public static final boolean DEFAULT_NOISE_SUPPRESSION = false;

  public static final String DEFAULT_STUN_SERVER = "stun:stun.cloudflare.com:3478";

  private int videoWidth = DEFAULT_VIDEO_WIDTH;
  private int videoHeight = DEFAULT_VIDEO_HEIGHT;
  private int videoFps = DEFAULT_VIDEO_FPS;
  private int videoBitrate = DEFAULT_VIDEO_BITRATE;
  private volatile double statusVideoFps = Double.NaN;

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
      config.videoFps = clamp(
          optIntWithFallback(videoJson, "frameRate", "fr", DEFAULT_VIDEO_FPS),
          MIN_VIDEO_FPS,
          MAX_VIDEO_FPS);
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

  private static double clamp(double value, double min, double max) {
    return Math.max(min, Math.min(max, value));
  }

  private static Number oneDecimal(double value) {
    return new OneDecimalNumber(BigDecimal.valueOf(value).setScale(1, RoundingMode.HALF_UP));
  }

  /**
   * Android JSONObject strips ".0" from regular numeric values. This keeps frameRate as a JSON
   * number while preserving the requested one-decimal wire representation.
   */
  private static final class OneDecimalNumber extends Number {
    private final BigDecimal value;

    OneDecimalNumber(BigDecimal value) {
      this.value = value;
    }

    @Override
    public int intValue() {
      return value.intValue();
    }

    @Override
    public long longValue() {
      return value.longValue();
    }

    @Override
    public float floatValue() {
      return value.floatValue();
    }

    @Override
    public double doubleValue() {
      double doubleValue = value.doubleValue();
      return doubleValue == (double) value.longValue() ? Math.nextUp(doubleValue) : doubleValue;
    }

    @Override
    public String toString() {
      return value.toPlainString();
    }
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
    this.videoFps = clamp(fps, MIN_VIDEO_FPS, MAX_VIDEO_FPS);
    return this;
  }

  public WhipStreamConfig setStatusVideoFps(double fps) {
    if (!Double.isNaN(fps) && !Double.isInfinite(fps)) {
      this.statusVideoFps = clamp(fps, MIN_VIDEO_FPS, MAX_VIDEO_FPS);
    }
    return this;
  }

  private double getStatusVideoFps() {
    return Double.isNaN(statusVideoFps) ? getVideoFps() : statusVideoFps;
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
      video.put("bitrate", getVideoBitrate());
      video.put("frameRate", oneDecimal(getStatusVideoFps()));
      resolvedConfig.put("video", video);
      audio.put("echoCancellation", isEchoCancellation());
      audio.put("noiseSuppression", isNoiseSuppression());
      resolvedConfig.put("audio", audio);
    } catch (Exception ignored) {
      // JSONObject writes above are deterministic for primitive values.
    }
    return resolvedConfig;
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
