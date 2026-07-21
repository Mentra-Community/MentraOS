package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mockStatic;

import com.mentra.asg_client.io.peripheral.McuEventParser;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Deterministic guard proving the Mentra-owned ACK fast path stays structurally cheaper than the
 * historical JSON → {@code McuEventParser} → bus-style slow path.
 *
 * <p>This used to be a wall-clock microbenchmark that asserted a fast/slow timing ratio. On shared
 * CI runners that comparison sat right on the true ~1.9x ratio and flaked regardless of threshold
 * tuning. The regression the benchmark actually guarded against is behavioral, not temporal: the
 * fast path silently reverting to the full {@link McuEventParser} pipeline. We assert that
 * invariant directly and deterministically by verifying which pipeline each path touches, so the
 * guard never flakes yet still fails loudly if {@code dispatchFast} regresses back into the heavy
 * parse-and-fan-out work.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FileTransferAckDispatchBenchmarkTest {
    private static final byte[] PAYLOAD =
            "{\"C\":\"cs_flts\",\"B\":{\"type\":52,\"state\":1,\"index\":42}}"
                    .getBytes(StandardCharsets.UTF_8);

    @Test
    public void fastPath_dispatchesWithoutEnteringMcuEventPipeline() {
        AtomicInteger state = new AtomicInteger(-1);
        AtomicInteger index = new AtomicInteger(-1);

        try (MockedStatic<McuEventParser> parser = mockStatic(McuEventParser.class)) {
            boolean dispatched =
                    FileTransferAckDispatch.dispatchFast(
                            PAYLOAD,
                            (s, idx) -> {
                                state.set(s);
                                index.set(idx);
                            });

            assertThat(dispatched).isTrue();
            assertThat(state.get()).isEqualTo(1);
            assertThat(index.get()).isEqualTo(42);

            // The whole point of the fast path is that it never runs the expensive
            // McuEventParser -> event fan-out pipeline. If it regresses to doing so, this fails.
            parser.verifyNoInteractions();
        }
    }

    @Test
    public void slowPath_stillExercisesFullMcuEventPipeline() {
        AtomicInteger state = new AtomicInteger(-1);
        AtomicInteger index = new AtomicInteger(-1);

        try (MockedStatic<McuEventParser> parser = mockStatic(McuEventParser.class)) {
            parser.when(() -> McuEventParser.parse(any(JSONObject.class)))
                    .thenReturn(new FileTransferAckEvent(1, 42));

            boolean dispatched =
                    FileTransferAckDispatch.dispatchSlow(
                            PAYLOAD,
                            (s, idx) -> {
                                state.set(s);
                                index.set(idx);
                            });

            assertThat(dispatched).isTrue();
            assertThat(state.get()).isEqualTo(1);
            assertThat(index.get()).isEqualTo(42);

            // The slow mirror must keep traversing the real pipeline, otherwise it stops being a
            // meaningful reference for what the fast path deliberately avoids.
            parser.verify(() -> McuEventParser.parse(any(JSONObject.class)));
        }
    }
}
