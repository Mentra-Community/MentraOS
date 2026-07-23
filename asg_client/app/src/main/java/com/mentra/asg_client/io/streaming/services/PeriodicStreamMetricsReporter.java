package com.mentra.asg_client.io.streaming.services;

import android.os.Handler;
import android.util.Log;
import androidx.annotation.Nullable;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;

/** Periodically forwards stream telemetry while an RTMP or SRT publisher is active. */
final class PeriodicStreamMetricsReporter {
    private static final String TAG = "StreamQuality";

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
        final int width;
        final int height;
        final long bitrateBps;
        final double fps;
        final long droppedFrames;
        final long durationSeconds;
        final double temperatureC;

        MetricsSample(
                int width,
                int height,
                long bitrateBps,
                double fps,
                long droppedFrames,
                long durationSeconds,
                double temperatureC) {
            this.width = width;
            this.height = height;
            this.bitrateBps = bitrateBps;
            this.fps = fps;
            this.droppedFrames = droppedFrames;
            this.durationSeconds = durationSeconds;
            this.temperatureC = temperatureC;
        }
    }

    private final Handler mHandler;
    private final long mIntervalMs;
    private final String mSourceLabel;
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
                    if (sample != null) {
                        logQuality(
                                mSourceLabel,
                                mCallbackProvider.getStreamId(),
                                sample.width,
                                sample.height,
                                sample.bitrateBps,
                                sample.fps,
                                sample.droppedFrames,
                                sample.durationSeconds,
                                sample.temperatureC);

                        StreamingStatusCallback callback = mCallbackProvider.getCallback();
                        if (callback != null) {
                            callback.onStreamMetrics(
                                    mCallbackProvider.getStreamId(),
                                    sample.bitrateBps,
                                    sample.fps,
                                    sample.droppedFrames,
                                    sample.durationSeconds,
                                    sample.temperatureC);
                        }
                    }
                    mHandler.postDelayed(this, mIntervalMs);
                }
            };

    PeriodicStreamMetricsReporter(
            Handler handler,
            long intervalMs,
            String sourceLabel,
            ActiveStateChecker activeStateChecker,
            SampleProvider sampleProvider,
            CallbackProvider callbackProvider) {
        mHandler = handler;
        mIntervalMs = intervalMs;
        mSourceLabel = sourceLabel != null ? sourceLabel : "stream";
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

    static void logQuality(
            String source,
            @Nullable String streamId,
            int width,
            int height,
            long bitrateBps,
            double fps,
            long droppedFrames,
            long durationSeconds,
            double temperatureC) {
        String temp =
                Double.isFinite(temperatureC)
                        ? String.format(java.util.Locale.US, "%.1f", temperatureC)
                        : "n/a";
        Log.i(
                TAG,
                "[STREAM_QUALITY] source="
                        + source
                        + " streamId="
                        + (streamId != null && !streamId.isEmpty() ? streamId : "-")
                        + " resolution="
                        + width
                        + "x"
                        + height
                        + " fps="
                        + String.format(java.util.Locale.US, "%.1f", fps)
                        + " bitrateKbps="
                        + (bitrateBps / 1000L)
                        + " dropped="
                        + droppedFrames
                        + " durationSec="
                        + durationSeconds
                        + " tempC="
                        + temp);
    }
}
