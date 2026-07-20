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
 * against the expensive dispatch work silently returning.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FileTransferAckDispatchBenchmarkTest {
    private static final String TAG = "FileTransferAckBench";
    private static final int WARMUP = 500;
    private static final int ITERATIONS = 4000;

    @Test
    public void fastPath_isAtLeastTwiceAsFastAsSlowPath() {
        byte[] payload =
                "{\"C\":\"cs_flts\",\"B\":{\"type\":52,\"state\":1,\"index\":42}}"
                        .getBytes(StandardCharsets.UTF_8);
        AtomicInteger sink = new AtomicInteger();

        // Warm up both paths (JIT / class loading).
        for (int i = 0; i < WARMUP; i++) {
            FileTransferAckDispatch.dispatchFast(payload, (s, idx) -> sink.incrementAndGet());
            FileTransferAckDispatch.dispatchSlow(payload, (s, idx) -> sink.incrementAndGet());
        }

        long[] fastSamples = new long[ITERATIONS];
        long[] slowSamples = new long[ITERATIONS];

        for (int i = 0; i < ITERATIONS; i++) {
            long start = System.nanoTime();
            boolean ok =
                    FileTransferAckDispatch.dispatchFast(
                            payload, (s, idx) -> sink.incrementAndGet());
            fastSamples[i] = System.nanoTime() - start;
            assertThat(ok).isTrue();
        }

        for (int i = 0; i < ITERATIONS; i++) {
            long start = System.nanoTime();
            boolean ok =
                    FileTransferAckDispatch.dispatchSlow(
                            payload, (s, idx) -> sink.incrementAndGet());
            slowSamples[i] = System.nanoTime() - start;
            assertThat(ok).isTrue();
        }

        long fastMedian = median(fastSamples);
        long slowMedian = median(slowSamples);
        double ratio = slowMedian / (double) Math.max(1L, fastMedian);

        Log.i(
                TAG,
                "ACK dispatch microbench fast_median_ns="
                        + fastMedian
                        + " slow_median_ns="
                        + slowMedian
                        + " slow_over_fast="
                        + String.format(java.util.Locale.US, "%.2f", ratio));

        // Durable check: Mentra-owned work removed by the fast path must stay removed.
        assertThat(fastMedian * 2)
                .as(
                        "fast path should be at least 2x faster than slow path"
                                + " (fast=%dns slow=%dns)",
                        fastMedian, slowMedian)
                .isLessThan(slowMedian);
    }

    private static long median(long[] samples) {
        long[] copy = Arrays.copyOf(samples, samples.length);
        Arrays.sort(copy);
        return copy[copy.length / 2];
    }
}
