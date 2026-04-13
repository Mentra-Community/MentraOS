package com.mentra.asg_client.io.streaming.services;

import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;

/**
 * Small stateful bitrate controller for temperature-based throttling.
 *
 * The controller only touches bitrate. Resolution and FPS remain fixed at the
 * requested values. The control law is intentionally isolated here so
 * WhipStreamingService only needs to ask for the next bitrate cap.
 *
 * The implementation uses:
 * - smoothed CPU temperature
 * - a feed-forward cap as the stream approaches the thermal limit
 * - a small PID-like correction on top of the current bitrate target
 *
 * The control goal is to stay under 90C, so the soft target is kept slightly
 * lower to leave room for thermal lag.
 */
final class WhipBitrateTemperatureController {

  private static final int CONTROL_START_MDEG = 86_000;
  private static final int SOFT_TARGET_MDEG = 89_000;
  private static final int HARD_LIMIT_MDEG = 90_000;
  private static final int INTEGRAL_RESET_MDEG = 85_000;
  private static final int RECOVERY_RELEASE_MDEG = 88_000;

  private static final int MIN_AUTO_BITRATE_BPS = 300_000;
  private static final int BITRATE_STEP_BPS = 100_000;
  private static final int MAX_STEP_DOWN_BPS = 1_000_000;
  private static final int MAX_STEP_UP_BPS = 100_000;
  private static final int HARD_LIMIT_EXTRA_DROP_BPS = 500_000;
  private static final int HARD_LIMIT_EXTRA_DROP_PER_C_BPS = 300_000;

  private static final double FEED_FORWARD_MIN_SCALE = 0.15d;
  private static final double FEED_FORWARD_CURVE_EXPONENT = 3d;
  private static final double KP_BPS_PER_C = 260_000d;
  private static final double KI_BPS_PER_C = 20_000d;
  private static final double KD_BPS_PER_C = 280_000d;
  private static final double INTEGRAL_MIN_C = -16.0d;
  private static final double INTEGRAL_MAX_C = 1.5d;

  private int mSmoothedCpuTempMilli = -1;
  private int mCurrentTargetBitrateBps = -1;
  private double mIntegralErrorC = 0.0d;

  void reset(WhipStreamConfig requestedConfig) {
    mSmoothedCpuTempMilli = -1;
    mIntegralErrorC = 0.0d;
    mCurrentTargetBitrateBps = requestedConfig != null
        ? requestedConfig.getVideoBitrate()
        : -1;
  }

  void updateRequestedConfig(WhipStreamConfig requestedConfig) {
    if (requestedConfig == null) {
      return;
    }

    int requestedBitrate = requestedConfig.getVideoBitrate();
    if (mCurrentTargetBitrateBps <= 0) {
      mCurrentTargetBitrateBps = requestedBitrate;
      return;
    }

    mCurrentTargetBitrateBps = Math.min(mCurrentTargetBitrateBps, requestedBitrate);
  }

  BitrateDecision update(int rawCpuTempMilli, WhipStreamConfig requestedConfig) {
    int requestedBitrate = requestedConfig != null
        ? requestedConfig.getVideoBitrate()
        : WhipStreamConfig.DEFAULT_VIDEO_BITRATE;
    int minAllowedBitrateBps = Math.min(MIN_AUTO_BITRATE_BPS, requestedBitrate);

    if (mCurrentTargetBitrateBps <= 0) {
      mCurrentTargetBitrateBps = requestedBitrate;
    }

    if (rawCpuTempMilli <= 0) {
      return new BitrateDecision(
          rawCpuTempMilli,
          mSmoothedCpuTempMilli,
          mCurrentTargetBitrateBps,
          scaleFor(mCurrentTargetBitrateBps, requestedBitrate),
          mIntegralErrorC,
          mCurrentTargetBitrateBps < requestedBitrate,
          false);
    }

    int previousSmoothedCpuTempMilli = mSmoothedCpuTempMilli;
    mSmoothedCpuTempMilli = WhipThermalUtils.smoothCpuTemperature(
        mSmoothedCpuTempMilli, rawCpuTempMilli);

    double smoothedTempC = WhipThermalUtils.toCelsius(mSmoothedCpuTempMilli);
    double previousSmoothedTempC = previousSmoothedCpuTempMilli > 0
        ? WhipThermalUtils.toCelsius(previousSmoothedCpuTempMilli)
        : smoothedTempC;
    double temperatureRiseC = Math.max(0.0d, smoothedTempC - previousSmoothedTempC);
    double errorC = WhipThermalUtils.toCelsius(SOFT_TARGET_MDEG) - smoothedTempC;

    if (mSmoothedCpuTempMilli <= INTEGRAL_RESET_MDEG) {
      mIntegralErrorC = 0.0d;
    } else {
      mIntegralErrorC = clamp(mIntegralErrorC + errorC, INTEGRAL_MIN_C, INTEGRAL_MAX_C);
    }

    int maxStepUpBps = mSmoothedCpuTempMilli < RECOVERY_RELEASE_MDEG
        ? requestedBitrate
        : MAX_STEP_UP_BPS;

    int pidAdjustedBitrate = mCurrentTargetBitrateBps + (int) Math.round(clamp(
        KP_BPS_PER_C * errorC
            + KI_BPS_PER_C * mIntegralErrorC
            - KD_BPS_PER_C * temperatureRiseC,
        -MAX_STEP_DOWN_BPS,
        maxStepUpBps));

    int feedForwardCapBps = computeFeedForwardCap(requestedBitrate, mSmoothedCpuTempMilli);
    int nextTargetBitrateBps = Math.min(pidAdjustedBitrate, feedForwardCapBps);

    if (mSmoothedCpuTempMilli >= HARD_LIMIT_MDEG) {
      int overshootWholeC = (int) Math.ceil(
          (mSmoothedCpuTempMilli - HARD_LIMIT_MDEG) / 1000.0d);
      nextTargetBitrateBps -= HARD_LIMIT_EXTRA_DROP_BPS
          + Math.max(0, overshootWholeC) * HARD_LIMIT_EXTRA_DROP_PER_C_BPS;
    }

    nextTargetBitrateBps = clamp(
        roundBitrate(nextTargetBitrateBps),
        minAllowedBitrateBps,
        requestedBitrate);

    if (mSmoothedCpuTempMilli < CONTROL_START_MDEG
        && nextTargetBitrateBps >= requestedBitrate) {
      nextTargetBitrateBps = requestedBitrate;
    }

    mCurrentTargetBitrateBps = nextTargetBitrateBps;
    return new BitrateDecision(
        rawCpuTempMilli,
        mSmoothedCpuTempMilli,
        mCurrentTargetBitrateBps,
        scaleFor(mCurrentTargetBitrateBps, requestedBitrate),
        mIntegralErrorC,
        mCurrentTargetBitrateBps < requestedBitrate,
        mSmoothedCpuTempMilli >= HARD_LIMIT_MDEG);
  }

  static double getSoftTargetTempC() {
    return WhipThermalUtils.toCelsius(SOFT_TARGET_MDEG);
  }

  static double getHardLimitTempC() {
    return WhipThermalUtils.toCelsius(HARD_LIMIT_MDEG);
  }

  private static int computeFeedForwardCap(int requestedBitrate, int smoothedCpuTempMilli) {
    int minAllowedBitrateBps = Math.min(MIN_AUTO_BITRATE_BPS, requestedBitrate);
    if (smoothedCpuTempMilli <= CONTROL_START_MDEG) {
      return requestedBitrate;
    }

    double progress = clamp(
        (smoothedCpuTempMilli - CONTROL_START_MDEG)
            / (double) (HARD_LIMIT_MDEG - CONTROL_START_MDEG),
        0.0d,
        1.0d);
    double curvedProgress = Math.pow(progress, FEED_FORWARD_CURVE_EXPONENT);
    double scale = 1.0d - curvedProgress * (1.0d - FEED_FORWARD_MIN_SCALE);
    return roundBitrate(Math.max(minAllowedBitrateBps,
        (int) Math.round(requestedBitrate * scale)));
  }

  private static double scaleFor(int bitrateBps, int requestedBitrateBps) {
    if (requestedBitrateBps <= 0) {
      return 1.0d;
    }
    return bitrateBps / (double) requestedBitrateBps;
  }

  private static int roundBitrate(int bitrateBps) {
    return Math.max(BITRATE_STEP_BPS,
        (int) Math.round(bitrateBps / (double) BITRATE_STEP_BPS) * BITRATE_STEP_BPS);
  }

  private static int clamp(int value, int min, int max) {
    return Math.max(min, Math.min(max, value));
  }

  private static double clamp(double value, double min, double max) {
    return Math.max(min, Math.min(max, value));
  }

  static final class BitrateDecision {
    private final int mRawCpuTempMilli;
    private final int mSmoothedCpuTempMilli;
    private final int mTargetBitrateBps;
    private final double mAppliedScale;
    private final double mIntegralErrorC;
    private final boolean mThermallyLimited;
    private final boolean mHardLimitActive;

    BitrateDecision(
        int rawCpuTempMilli,
        int smoothedCpuTempMilli,
        int targetBitrateBps,
        double appliedScale,
        double integralErrorC,
        boolean thermallyLimited,
        boolean hardLimitActive) {
      mRawCpuTempMilli = rawCpuTempMilli;
      mSmoothedCpuTempMilli = smoothedCpuTempMilli;
      mTargetBitrateBps = targetBitrateBps;
      mAppliedScale = appliedScale;
      mIntegralErrorC = integralErrorC;
      mThermallyLimited = thermallyLimited;
      mHardLimitActive = hardLimitActive;
    }

    int getRawCpuTempMilli() {
      return mRawCpuTempMilli;
    }

    int getSmoothedCpuTempMilli() {
      return mSmoothedCpuTempMilli;
    }

    int getTargetBitrateBps() {
      return mTargetBitrateBps;
    }

    double getAppliedScale() {
      return mAppliedScale;
    }

    double getIntegralErrorC() {
      return mIntegralErrorC;
    }

    boolean isThermallyLimited() {
      return mThermallyLimited;
    }

    boolean isHardLimitActive() {
      return mHardLimitActive;
    }
  }
}
