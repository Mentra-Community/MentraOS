package com.mentra.asg_client.io.streaming.services;

import android.os.Handler;

import androidx.annotation.Nullable;

import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;

/**
 * Shared periodic metrics reporter for streamers that do not expose transport-level stats.
 * Services provide their current state and a point-in-time metrics sample.
 */
final class PeriodicStreamMetricsReporter {

  interface ActiveStateChecker {
    boolean shouldReport();
  }

  interface SampleProvider {
    @Nullable MetricsSample getSample();
  }

  interface CallbackProvider {
    @Nullable StreamingStatusCallback getCallback();
    @Nullable String getStreamId();
  }

  static final class MetricsSample {
    final long bitrateBps;
    final int fps;
    final int width;
    final int height;
    final int droppedFrames;
    final long durationMs;
    final double temperatureC;

    MetricsSample(
        long bitrateBps,
        int fps,
        int width,
        int height,
        int droppedFrames,
        long durationMs,
        double temperatureC) {
      this.bitrateBps = bitrateBps;
      this.fps = fps;
      this.width = width;
      this.height = height;
      this.droppedFrames = droppedFrames;
      this.durationMs = durationMs;
      this.temperatureC = temperatureC;
    }
  }

  private final Handler mHandler;
  private final long mIntervalMs;
  private final ActiveStateChecker mActiveStateChecker;
  private final SampleProvider mSampleProvider;
  private final CallbackProvider mCallbackProvider;
  private final Runnable mReportRunnable = new Runnable() {
    @Override
    public void run() {
      if (!mActiveStateChecker.shouldReport()) {
        return;
      }

      MetricsSample sample = mSampleProvider.getSample();
      StreamingStatusCallback callback = mCallbackProvider.getCallback();
      if (sample != null && callback != null) {
        callback.onStreamMetrics(
            mCallbackProvider.getStreamId(),
            sample.bitrateBps,
            sample.fps,
            sample.width,
            sample.height,
            sample.droppedFrames,
            sample.durationMs,
            sample.temperatureC);
      }

      mHandler.postDelayed(this, mIntervalMs);
    }
  };

  PeriodicStreamMetricsReporter(
      Handler handler,
      long intervalMs,
      ActiveStateChecker activeStateChecker,
      SampleProvider sampleProvider,
      CallbackProvider callbackProvider) {
    mHandler = handler;
    mIntervalMs = intervalMs;
    mActiveStateChecker = activeStateChecker;
    mSampleProvider = sampleProvider;
    mCallbackProvider = callbackProvider;
  }

  void start() {
    stop();
    mHandler.postDelayed(mReportRunnable, mIntervalMs);
  }

  void stop() {
    mHandler.removeCallbacks(mReportRunnable);
  }
}
