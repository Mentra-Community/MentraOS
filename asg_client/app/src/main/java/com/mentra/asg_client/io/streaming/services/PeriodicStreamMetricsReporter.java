package com.mentra.asg_client.io.streaming.services;

import android.os.Handler;
import android.util.Log;
import androidx.annotation.Nullable;
import com.mentra.asg_client.AsgConstants;
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

    /**
     * Telemetry sample. Prefer measured* fields for reality; configured* are what we asked for.
     * Unknown measured values use NaN / -1 so logs can show "n/a" instead of lying.
     */
    static final class MetricsSample {
        final int width;
        final int height;
        final long configuredBitrateBps;
        final long measuredBitrateBps;
        final double configuredFps;
        final double measuredFps;
        final double cameraFps;
        final long droppedFrames;
        final long durationSeconds;
        final double temperatureC;

        MetricsSample(
                int width,
                int height,
                long configuredBitrateBps,
                long measuredBitrateBps,
                double configuredFps,
                double measuredFps,
                double cameraFps,
                long droppedFrames,
                long durationSeconds,
                double temperatureC) {
            this.width = width;
            this.height = height;
            this.configuredBitrateBps = configuredBitrateBps;
            this.measuredBitrateBps = measuredBitrateBps;
            this.configuredFps = configuredFps;
            this.measuredFps = measuredFps;
            this.cameraFps = cameraFps;
            this.droppedFrames = droppedFrames;
            this.durationSeconds = durationSeconds;
            this.temperatureC = temperatureC;
        }

        /** Best-effort fps for callbacks: measured when known, else configured. */
        double reportFps() {
            return Double.isFinite(measuredFps) && measuredFps > 0 ? measuredFps : configuredFps;
        }

        /** Best-effort bitrate for callbacks: measured when known, else configured. */
        long reportBitrateBps() {
            return measuredBitrateBps > 0 ? measuredBitrateBps : configuredBitrateBps;
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
                        logQuality(mSourceLabel, mCallbackProvider.getStreamId(), sample);

                        StreamingStatusCallback callback = mCallbackProvider.getCallback();
                        if (callback != null) {
                            callback.onStreamMetrics(
                                    mCallbackProvider.getStreamId(),
                                    sample.reportBitrateBps(),
                                    sample.reportFps(),
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
        if (!AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY) {
            return;
        }
        stop();
        mHandler.postDelayed(mReportRunnable, mIntervalMs);
    }

    void stop() {
        mHandler.removeCallbacks(mReportRunnable);
    }

    static void logQuality(String source, @Nullable String streamId, MetricsSample sample) {
        if (!AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY) {
            return;
        }
        String temp =
                Double.isFinite(sample.temperatureC)
                        ? String.format(java.util.Locale.US, "%.1f", sample.temperatureC)
                        : "n/a";
        Log.i(
                TAG,
                "[STREAM_QUALITY] source="
                        + source
                        + " streamId="
                        + (streamId != null && !streamId.isEmpty() ? streamId : "-")
                        + " resolution="
                        + sample.width
                        + "x"
                        + sample.height
                        + " measuredFps="
                        + formatFps(sample.measuredFps)
                        + " cameraFps="
                        + formatFps(sample.cameraFps)
                        + " configuredFps="
                        + formatFps(sample.configuredFps)
                        + " measuredBitrateKbps="
                        + formatBitrateKbps(sample.measuredBitrateBps)
                        + " configuredBitrateKbps="
                        + (sample.configuredBitrateBps / 1000L)
                        + " dropped="
                        + sample.droppedFrames
                        + " durationSec="
                        + sample.durationSeconds
                        + " tempC="
                        + temp);
    }

    /** Backward-compatible helper used by WHIP until it builds a full MetricsSample. */
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
        logQuality(
                source,
                streamId,
                new MetricsSample(
                        width,
                        height,
                        /* configuredBitrateBps= */ bitrateBps,
                        /* measuredBitrateBps= */ bitrateBps,
                        /* configuredFps= */ fps,
                        /* measuredFps= */ fps,
                        /* cameraFps= */ Double.NaN,
                        droppedFrames,
                        durationSeconds,
                        temperatureC));
    }

    private static String formatFps(double fps) {
        if (!Double.isFinite(fps) || fps < 0) {
            return "n/a";
        }
        return String.format(java.util.Locale.US, "%.1f", fps);
    }

    private static String formatBitrateKbps(long bitrateBps) {
        if (bitrateBps < 0) {
            return "n/a";
        }
        return Long.toString(bitrateBps / 1000L);
    }
}
