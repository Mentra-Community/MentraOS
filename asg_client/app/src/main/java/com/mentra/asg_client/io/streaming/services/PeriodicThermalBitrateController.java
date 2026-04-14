package com.mentra.asg_client.io.streaming.services;

import android.os.Handler;

/**
 * Shared polling loop for temperature-driven bitrate control.
 */
final class PeriodicThermalBitrateController {

  interface RequestedBitrateProvider {
    int getRequestedBitrateBps();
  }

  interface ActiveStateChecker {
    boolean shouldApplyLiveChanges();
  }

  interface DecisionConsumer {
    void onBitrateDecision(
        StreamingBitrateTemperatureController.BitrateDecision decision,
        boolean applyLiveChanges);
  }

  private final Handler mHandler;
  private final long mIntervalMs;
  private final RequestedBitrateProvider mRequestedBitrateProvider;
  private final ActiveStateChecker mActiveStateChecker;
  private final DecisionConsumer mDecisionConsumer;
  private final StreamingBitrateTemperatureController mController =
      new StreamingBitrateTemperatureController();
  private final Runnable mPollRunnable = new Runnable() {
    @Override
    public void run() {
      if (mActiveStateChecker.shouldApplyLiveChanges()) {
        evaluateNow(true);
      }
      mHandler.postDelayed(this, mIntervalMs);
    }
  };

  PeriodicThermalBitrateController(
      Handler handler,
      long intervalMs,
      RequestedBitrateProvider requestedBitrateProvider,
      ActiveStateChecker activeStateChecker,
      DecisionConsumer decisionConsumer) {
    mHandler = handler;
    mIntervalMs = intervalMs;
    mRequestedBitrateProvider = requestedBitrateProvider;
    mActiveStateChecker = activeStateChecker;
    mDecisionConsumer = decisionConsumer;
  }

  void reset(int requestedBitrateBps) {
    mController.reset(requestedBitrateBps);
  }

  void updateRequestedBitrate(int requestedBitrateBps, boolean applyLiveChanges) {
    mController.updateRequestedBitrate(requestedBitrateBps);
    evaluateNow(applyLiveChanges);
  }

  void evaluateNow(boolean applyLiveChanges) {
    StreamingBitrateTemperatureController.BitrateDecision decision = mController.update(
        StreamingThermalUtils.readCpuTemperature(),
        mRequestedBitrateProvider.getRequestedBitrateBps());
    mDecisionConsumer.onBitrateDecision(decision, applyLiveChanges);
  }

  void start() {
    stop();
    evaluateNow(true);
    mHandler.postDelayed(mPollRunnable, mIntervalMs);
  }

  void stop() {
    mHandler.removeCallbacks(mPollRunnable);
  }
}
