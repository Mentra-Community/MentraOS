package com.mentra.asg_client.io.streaming.services;

import android.os.Handler;
import androidx.annotation.Nullable;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;

/** Periodically forwards stream telemetry while an RTMP or SRT publisher is active. */
final class PeriodicStreamMetricsReporter {
    interface ActiveStateChecker {
        boolean shouldReport();
    }

    interface SampleProvider {
        @Nullable
        MetricsSample getSample();
    }

    interface CallbackProvider {
        @Nullable
        StreamingStatusCallback getCallback();

        @Nullable
        String getStreamId();
    }

    static final class MetricsSample {
        final long bitrateBps;
        final double fps;
        final long droppedFrames;
        final long durationSeconds;
        final double temperatureC;

        MetricsSample(
                long bitrateBps,
                double fps,
                long droppedFrames,
                long durationSeconds,
                double temperatureC) {
            this.bitrateBps = bitrateBps;
            this.fps = fps;
            this.droppedFrames = droppedFrames;
            this.durationSeconds = durationSeconds;
            this.temperatureC = temperatureC;
        }
    }

    private final Handler mHandler;
    private final long mIntervalMs;
    private final ActiveStateChecker mActiveStateChecker;
    private final SampleProvider mSampleProvider;
    private final CallbackProvider mCallbackProvider;
    private final Runnable mReportRunnable =
            new Runnable() {
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
                                sample.droppedFrames,
                                sample.durationSeconds,
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
