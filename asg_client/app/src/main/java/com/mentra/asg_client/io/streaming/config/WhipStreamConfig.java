package com.mentra.asg_client.io.streaming.config;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Configuration class for WebRTC / WHIP streaming parameters.
 */
public class WhipStreamConfig {

  // Defaults used when caller omits video JSON (or a given field).
  public static final int DEFAULT_VIDEO_WIDTH = 1280;
  public static final int DEFAULT_VIDEO_HEIGHT = 720;
  public static final int DEFAULT_VIDEO_FPS = 15;
  public static final int DEFAULT_VIDEO_BITRATE = 2_500_000; // 2.5 Mbps
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
  private boolean captureAudio = true;

  private String stunServer = DEFAULT_STUN_SERVER;

  public WhipStreamConfig() {
  }

  /**
   * Parse video and audio config from JSON objects sent by the SDK.
   * Supports both full key names and compact keys for MTU-constrained messages:
   *   Full: { width, height, bitrate, frameRate } / { echoCancellation, noiseSuppression }
   *   Compact: { w, h, br, fr } / { ec, ns }
   * FPS also accepts {@code fps} / {@code f} (miniapp SDK / BleJsonCompact).
   * When both a full key and its compact alias are present, the full key wins.
   */
  public static WhipStreamConfig fromJson(JSONObject videoJson, JSONObject audioJson) {
    return fromJson(videoJson, audioJson, null);
  }

  /**
   * As {@link #fromJson(JSONObject, JSONObject)}, plus the optional {@code ice} block.
   *
   * <p>{@code ice} carries {@code stun} (compact alias {@code s}). SoftAP calling sends an empty
   * string to mean "no STUN server, gather host candidates only", because the phone WHIP server
   * sits on the hotspot subnet and a reflexive candidate is meaningless there. An absent key keeps
   * the Cloudflare default, and a value that is not a stun URI is ignored rather than silently
   * disabling ICE.
   */
  public static WhipStreamConfig fromJson(
      JSONObject videoJson, JSONObject audioJson, JSONObject iceJson) {
    WhipStreamConfig config = new WhipStreamConfig();

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

    if (audioJson != null) {
      config.echoCancellation = optBoolWithFallback(audioJson, "echoCancellation", "ec", DEFAULT_ECHO_CANCELLATION);
      config.noiseSuppression = optBoolWithFallback(audioJson, "noiseSuppression", "ns", DEFAULT_NOISE_SUPPRESSION);
      config.captureAudio = optBoolWithFallback(audioJson, "captureAudio", "ca", true);
    }

    if (iceJson != null) {
      config.stunServer = resolveStunServer(iceJson, config.stunServer);
    }

    return config;
  }

  /**
   * Empty string wins (host-only), a stun/stuns URI overrides, anything else keeps the default.
   * Returning the default for a malformed value matters: silently treating "garbage" as host-only
   * would strand a normal Cloudflare stream with no reflexive candidate.
   */
  private static String resolveStunServer(JSONObject iceJson, String defaultValue) {
    String key = iceJson.has("stun") ? "stun" : (iceJson.has("s") ? "s" : null);
    if (key == null) return defaultValue;
    if (iceJson.isNull(key)) return defaultValue;

    String value = iceJson.optString(key, defaultValue);
    if (value == null) return defaultValue;

    String trimmed = value.trim();
    if (trimmed.isEmpty()) return ""; // explicit host-only
    if (trimmed.startsWith("stun:") || trimmed.startsWith("stuns:")) return trimmed;
    return defaultValue;
  }

  /**
   * True when no STUN server is configured, so only local host candidates will be gathered.
   * This is the SoftAP path: the WHIP server is on the hotspot subnet and reflexive
   * candidates are useless.
   */
  public boolean isHostOnlyIce() {
    return stunServer == null || stunServer.trim().isEmpty();
  }

  /**
   * Try full key first, then compact key, then default.
   * When both keys are present, the full key wins.
   */
  private static int optIntWithFallback(JSONObject json, String fullKey, String compactKey, int defaultValue) {
    if (json.has(fullKey)) return json.optInt(fullKey, defaultValue);
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

  private static boolean optBoolWithFallback(JSONObject json, String fullKey, String compactKey, boolean defaultValue) {
    if (json.has(fullKey)) return json.optBoolean(fullKey, defaultValue);
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

  private static double clamp(double value, double min, double max) {
    return Math.max(min, Math.min(max, value));
  }

  private static Number oneDecimal(double value) {
    return new OneDecimalNumber(BigDecimal.valueOf(value).setScale(1, RoundingMode.HALF_UP));
  }

  /**
   * Android JSONObject strips ".0" from regular numeric values. This keeps fps as a JSON
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
  public boolean isCaptureAudio() { return captureAudio; }
  public String getStunServer() { return stunServer; }

  // Setters with validation (fluent API)
  public WhipStreamConfig setVideoWidth(int width) {
    this.videoWidth = normalizeDimension(width, 320, 1920);
    return this;
  }

  public WhipStreamConfig setVideoHeight(int height) {
    this.videoHeight = normalizeDimension(height, 240, 1080);
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

  /** Measured camera/output fps when known; NaN if not yet measured. */
  public double getMeasuredCameraFps() {
    return statusVideoFps;
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
      video.put("fps", oneDecimal(getStatusVideoFps()));
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

  public WhipStreamConfig setCaptureAudio(boolean enabled) {
    this.captureAudio = enabled;
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
        + ", captureAudio=" + captureAudio
        + ", stun=" + stunServer
        + '}';
  }
}
