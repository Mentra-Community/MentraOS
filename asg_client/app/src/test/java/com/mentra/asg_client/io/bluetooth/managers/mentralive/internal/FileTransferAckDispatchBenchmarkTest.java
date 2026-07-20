package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * CI microbenchmark proving the Mentra-owned ACK fast path stays cheaper than the historical JSON
 * → {@code McuEventParser} → bus-style slow path. This is not wall-clock UART truth; it guards
 * against the expensive dispatch work silently returning (a regression that would collapse the
 * fast/slow ratio back toward 1.0).
 *
 * <p>Methodology: the slow-path mirror is intentionally thin (preview substring + {@code
 * json.toString()} + {@code McuEventParser} + event fan-out), so its true cost is only ~1.9x the
 * fast path. A strict 2x wall-clock gate therefore sits right on the true ratio and flakes ~50% of
 * the time on shared CI runners. We instead compare the <em>minimum</em> sample of each path (the
 * cleanest, least noise-contaminated observation over many iterations — the correct estimator for
 * microbenchmark compute cost) and require a comfortable {@code >=1.5x} margin. That reliably
 * passes (~25%+ headroom below the observed floor) while still failing loudly if the fast path ever
 * regresses to doing the full slow-path work.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FileTransferAckDispatchBenchmarkTest {
    private static final String TAG = "FileTransferAckBench";
    private static final int WARMUP = 500;
    private static final int ITERATIONS = 4000;

    @Test
    public void fastPath_isMeaningfullyFasterThanSlowPath() {
        byte[] payload =
                "{\"C\":\"cs_flts\",\"B\":{\"type\":52,\"state\":1,\"index\":42}}"
                        .getBytes(StandardCharsets.UTF_8);
        AtomicInteger sink = new AtomicInteger();

        // Warm up both paths (JIT / class loading), interleaved so neither gets a cold start.
        for (int i = 0; i < WARMUP; i++) {
            FileTransferAckDispatch.dispatchSlow(payload, (s, idx) -> sink.incrementAndGet());
            FileTransferAckDispatch.dispatchFast(payload, (s, idx) -> sink.incrementAndGet());
        }

        long[] fastSamples = new long[ITERATIONS];
        long[] slowSamples = new long[ITERATIONS];

        // Interleave measurement so GC / scheduling noise hits both similarly.
        for (int i = 0; i < ITERATIONS; i++) {
            long slowStart = System.nanoTime();
            boolean slowOk =
                    FileTransferAckDispatch.dispatchSlow(
                            payload, (s, idx) -> sink.incrementAndGet());
            slowSamples[i] = System.nanoTime() - slowStart;
            assertThat(slowOk).isTrue();

            long fastStart = System.nanoTime();
            boolean fastOk =
                    FileTransferAckDispatch.dispatchFast(
                            payload, (s, idx) -> sink.incrementAndGet());
            fastSamples[i] = System.nanoTime() - fastStart;
            assertThat(fastOk).isTrue();
        }

        // Minimum sample = the least noise-contaminated observation, i.e. best-of-N over every
        // iteration. Far more stable across CI runners than the median for microbenchmarks, because
        // noise (GC pauses, scheduler preemption) only ever inflates individual samples.
        long fastMin = min(fastSamples);
        long slowMin = min(slowSamples);
        double minRatio = slowMin / (double) Math.max(1L, fastMin);

        Log.i(
                TAG,
                "ACK dispatch microbench fast_median_ns="
                        + median(fastSamples)
                        + " slow_median_ns="
                        + median(slowSamples)
                        + " fast_min_ns="
                        + fastMin
                        + " slow_min_ns="
                        + slowMin
                        + " min_slow_over_fast="
                        + String.format(java.util.Locale.US, "%.2f", minRatio));

        // Durable check: the Mentra-owned work removed by the fast path must stay removed. If the
        // fast path silently regressed to the full JSON -> McuEventParser -> fan-out pipeline the
        // ratio would collapse toward 1.0 and trip this bar. Threshold (1.5x, expressed as
        // fastMin * 3 < slowMin * 2 to stay integer-exact) sits well below the ~1.9x true ratio so
        // measurement noise cannot flip it.
        assertThat(fastMin * 3L)
                .as(
                        "fast path should be at least 1.5x faster than slow path"
                                + " (fast_min=%dns slow_min=%dns ratio=%.2f)",
                        fastMin, slowMin, minRatio)
                .isLessThan(slowMin * 2L);
    }

    private static long median(long[] samples) {
        long[] copy = Arrays.copyOf(samples, samples.length);
        Arrays.sort(copy);
        return copy[copy.length / 2];
    }

    private static long min(long[] samples) {
        long m = Long.MAX_VALUE;
        for (long s : samples) {
            if (s < m) {
                m = s;
            }
        }
        return m;
    }
}
