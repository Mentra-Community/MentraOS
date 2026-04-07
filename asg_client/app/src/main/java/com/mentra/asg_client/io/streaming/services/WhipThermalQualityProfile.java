package com.mentra.asg_client.io.streaming.services;

import android.os.PowerManager;

import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;

/**
 * Thermal downgrade policy for WHIP streams.
 *
 * Bitrate is the first knob because WebRTC can apply it live through RTP sender
 * parameters without renegotiation or reopening the camera. FPS and resolution
 * are only reduced once thermals worsen.
 */
final class WhipThermalQualityProfile {

  enum Tier {
    NORMAL,
    WARM,
    HOT,
    CRITICAL
  }

  private static final double WARM_BITRATE_SCALE = 0.70d;
  private static final double HOT_BITRATE_SCALE = 0.50d;
  private static final double CRITICAL_BITRATE_SCALE = 0.35d;

  private static final double HOT_RESOLUTION_SCALE = 2d / 3d;
  private static final double CRITICAL_RESOLUTION_SCALE = 0.50d;

  private static final int HOT_MAX_FPS = 12;
  private static final int CRITICAL_MAX_FPS = 10;

  private WhipThermalQualityProfile() {
  }

  static Tier fromThermalStatus(int thermalStatus) {
    if (thermalStatus >= PowerManager.THERMAL_STATUS_CRITICAL) {
      return Tier.CRITICAL;
    }
    if (thermalStatus >= PowerManager.THERMAL_STATUS_SEVERE) {
      return Tier.HOT;
    }
    if (thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) {
      return Tier.WARM;
    }
    return Tier.NORMAL;
  }

  static WhipStreamConfig buildConfig(WhipStreamConfig requestedConfig, Tier tier) {
    WhipStreamConfig adjustedConfig = new WhipStreamConfig(requestedConfig);

    switch (tier) {
      case WARM:
        adjustedConfig.setVideoBitrate(scaleBitrate(requestedConfig.getVideoBitrate(),
            WARM_BITRATE_SCALE));
        break;
      case HOT:
        adjustedConfig
            .setVideoBitrate(scaleBitrate(requestedConfig.getVideoBitrate(), HOT_BITRATE_SCALE))
            .setVideoFps(Math.min(requestedConfig.getVideoFps(), HOT_MAX_FPS));
        applyScaledResolution(adjustedConfig, requestedConfig, HOT_RESOLUTION_SCALE);
        break;
      case CRITICAL:
        adjustedConfig
            .setVideoBitrate(scaleBitrate(requestedConfig.getVideoBitrate(),
                CRITICAL_BITRATE_SCALE))
            .setVideoFps(Math.min(requestedConfig.getVideoFps(), CRITICAL_MAX_FPS));
        applyScaledResolution(adjustedConfig, requestedConfig, CRITICAL_RESOLUTION_SCALE);
        break;
      case NORMAL:
      default:
        break;
    }

    return adjustedConfig;
  }

  static String describe(WhipStreamConfig config) {
    return config.getVideoWidth() + "x" + config.getVideoHeight()
        + "@" + config.getVideoFps() + "fps "
        + (config.getVideoBitrate() / 1000) + "kbps";
  }

  static String thermalStatusToString(int thermalStatus) {
    switch (thermalStatus) {
      case PowerManager.THERMAL_STATUS_NONE:
        return "NONE";
      case PowerManager.THERMAL_STATUS_LIGHT:
        return "LIGHT";
      case PowerManager.THERMAL_STATUS_MODERATE:
        return "MODERATE";
      case PowerManager.THERMAL_STATUS_SEVERE:
        return "SEVERE";
      case PowerManager.THERMAL_STATUS_CRITICAL:
        return "CRITICAL";
      case PowerManager.THERMAL_STATUS_EMERGENCY:
        return "EMERGENCY";
      case PowerManager.THERMAL_STATUS_SHUTDOWN:
        return "SHUTDOWN";
      default:
        return "UNKNOWN(" + thermalStatus + ")";
    }
  }

  private static int scaleBitrate(int bitrate, double scale) {
    return Math.max(100_000, (int) Math.round(bitrate * scale));
  }

  private static void applyScaledResolution(WhipStreamConfig adjustedConfig,
      WhipStreamConfig requestedConfig, double scale) {
    int scaledWidth = Math.max(320, (int) Math.round(requestedConfig.getVideoWidth() * scale));
    int scaledHeight = Math.max(240, (int) Math.round(requestedConfig.getVideoHeight() * scale));
    adjustedConfig.setVideoWidth(scaledWidth);
    adjustedConfig.setVideoHeight(scaledHeight);
  }
}
