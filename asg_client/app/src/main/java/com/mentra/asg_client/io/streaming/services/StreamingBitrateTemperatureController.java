package com.mentra.asg_client.io.streaming.services;

/**
 * Stateful bitrate controller for temperature-based throttling across stream transports.
 */
final class StreamingBitrateTemperatureController {

  private static final int DEFAULT_REQUESTED_BITRATE_BPS = 1_000_000;
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

  void reset(int requestedBitrateBps) {
    mSmoothedCpuTempMilli = -1;
    mIntegralErrorC = 0.0d;
    mCurrentTargetBitrateBps = requestedBitrateBps > 0
        ? requestedBitrateBps
        : DEFAULT_REQUESTED_BITRATE_BPS;
  }

  void updateRequestedBitrate(int requestedBitrateBps) {
    if (requestedBitrateBps <= 0) {
      return;
    }

    if (mCurrentTargetBitrateBps <= 0) {
      mCurrentTargetBitrateBps = requestedBitrateBps;
      return;
    }

    mCurrentTargetBitrateBps = Math.min(mCurrentTargetBitrateBps, requestedBitrateBps);
  }

  BitrateDecision update(int rawCpuTempMilli, int requestedBitrateBps) {
    int requestedBitrate = requestedBitrateBps > 0
        ? requestedBitrateBps
        : DEFAULT_REQUESTED_BITRATE_BPS;
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
    mSmoothedCpuTempMilli = StreamingThermalUtils.smoothCpuTemperature(
        mSmoothedCpuTempMilli, rawCpuTempMilli);

    double smoothedTempC = StreamingThermalUtils.toCelsius(mSmoothedCpuTempMilli);
    double previousSmoothedTempC = previousSmoothedCpuTempMilli > 0
        ? StreamingThermalUtils.toCelsius(previousSmoothedCpuTempMilli)
        : smoothedTempC;
    double temperatureRiseC = Math.max(0.0d, smoothedTempC - previousSmoothedTempC);
    double errorC = StreamingThermalUtils.toCelsius(SOFT_TARGET_MDEG) - smoothedTempC;

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
    return StreamingThermalUtils.toCelsius(SOFT_TARGET_MDEG);
  }

  static double getHardLimitTempC() {
    return StreamingThermalUtils.toCelsius(HARD_LIMIT_MDEG);
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
