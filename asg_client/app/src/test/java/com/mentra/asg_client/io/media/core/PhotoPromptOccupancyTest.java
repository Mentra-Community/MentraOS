package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.Test;

public class PhotoPromptOccupancyTest {

    @Test
    public void suppressed_exhaustiveTruthTable() {
        int rows = 0;
        for (boolean capture : new boolean[] {false, true}) {
            for (boolean job : new boolean[] {false, true}) {
                for (boolean recording : new boolean[] {false, true}) {
                    rows++;
                    assertThat(PhotoPromptOccupancy.suppressed(capture, job, recording))
                            .isEqualTo(capture || job || recording);
                }
            }
        }
        assertThat(rows).isEqualTo(8);
    }

    @Test
    public void captureThenJobThenGateEndThenRelease_publishesTrueOnceThenFalse() {
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, new FakeCaptureScheduler());
        AtomicBoolean capture = new AtomicBoolean();
        AtomicBoolean job = new AtomicBoolean();
        BooleanSupplier sample = () -> PhotoPromptOccupancy.suppressed(capture.get(), job.get(), false);

        capture.set(true);
        occupancy.publish(sample, false);
        job.set(true);
        occupancy.publish(sample, false);
        capture.set(false);
        occupancy.publish(sample, false);
        job.set(false);
        occupancy.publish(sample, false);

        assertThat(sink.frames).containsExactly(true, false);
    }

    @Test
    public void recordingStartThenStop_publishesTrueThenFalse() {
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, new FakeCaptureScheduler());
        AtomicBoolean recording = new AtomicBoolean();
        BooleanSupplier sample = () -> PhotoPromptOccupancy.suppressed(false, false, recording.get());

        recording.set(true);
        occupancy.publish(sample, false);
        occupancy.publish(sample, false);
        recording.set(false);
        occupancy.publish(sample, false);

        assertThat(sink.frames).containsExactly(true, false);
    }

    @Test
    public void overlappingRequests_oneEndsAsAnotherBegins_neverPublishesFalseInBetween() {
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, new FakeCaptureScheduler());
        AtomicBoolean capture = new AtomicBoolean();
        AtomicBoolean job = new AtomicBoolean();
        BooleanSupplier sample = () -> PhotoPromptOccupancy.suppressed(capture.get(), job.get(), false);

        capture.set(true);
        occupancy.publish(sample, false);
        job.set(true);
        occupancy.publish(sample, false);
        capture.set(false);
        occupancy.publish(sample, false);
        job.set(false);
        capture.set(true);
        occupancy.publish(sample, false);

        assertThat(sink.frames).containsExactly(true);
        assertThat(sink.frames).doesNotContain(false);
    }

    @Test
    public void supplierFlipBetweenPublishes_emitsInSampleOrder() {
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, new FakeCaptureScheduler());
        AtomicBoolean busy = new AtomicBoolean(true);

        occupancy.publish(busy::get, false);
        busy.set(false);
        occupancy.publish(busy::get, false);
        busy.set(true);
        occupancy.publish(busy::get, false);

        assertThat(sink.frames).containsExactly(true, false, true);
    }

    @Test
    public void dirtyFlag_confirmedFalseFailedTrueThenFalse_stillReachesSink() {
        List<Boolean> attempted = new ArrayList<>();
        AtomicBoolean failNextTrue = new AtomicBoolean();
        PhotoPromptOccupancy occupancy =
                new PhotoPromptOccupancy(
                        busy -> {
                            attempted.add(busy);
                            if (busy && failNextTrue.get()) {
                                return false;
                            }
                            return true;
                        },
                        new FakeCaptureScheduler());
        AtomicBoolean busy = new AtomicBoolean(false);

        occupancy.publish(busy::get, false);
        failNextTrue.set(true);
        busy.set(true);
        occupancy.publish(busy::get, false);
        busy.set(false);
        occupancy.publish(busy::get, false);

        assertThat(attempted).containsExactly(false, true, false);
    }

    @Test
    public void dirtyFlag_repeatedFailuresKeepForcingSends_thenSuccessRestoresDedupe() {
        AtomicInteger attempts = new AtomicInteger();
        AtomicBoolean allowSuccess = new AtomicBoolean();
        PhotoPromptOccupancy occupancy =
                new PhotoPromptOccupancy(
                        busy -> {
                            attempts.incrementAndGet();
                            return allowSuccess.get();
                        },
                        new FakeCaptureScheduler());

        occupancy.publish(() -> true, false);
        occupancy.publish(() -> true, false);
        occupancy.publish(() -> true, false);
        assertThat(attempts.get()).isEqualTo(3);

        allowSuccess.set(true);
        occupancy.publish(() -> true, false);
        int afterSuccess = attempts.get();
        occupancy.publish(() -> true, false);
        occupancy.publish(() -> true, false);
        assertThat(attempts.get()).isEqualTo(afterSuccess);
    }

    @Test
    public void renewal_armsOnFalseToTrue_cancelsOnTrueToFalse_andDoesNotDoubleArm() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, scheduler);
        AtomicBoolean busy = new AtomicBoolean(true);

        occupancy.publish(busy::get, false);
        occupancy.publish(busy::get, false);
        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS);
        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS);

        assertThat(sink.frames).containsExactly(true, true, true);

        busy.set(false);
        occupancy.publish(busy::get, false);
        int afterClear = sink.frames.size();
        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS * 2);
        assertThat(sink.frames).hasSize(afterClear);
        assertThat(sink.frames.get(afterClear - 1)).isFalse();
    }

    @Test
    public void renewalTick_thatSamplesFalse_pushesClearAndCancelsItself() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, scheduler);
        AtomicBoolean busy = new AtomicBoolean(true);

        occupancy.publish(busy::get, false);
        busy.set(false);
        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS);

        assertThat(sink.frames).containsExactly(true, false);
        int afterSelfHeal = sink.frames.size();
        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS * 2);
        assertThat(sink.frames).hasSize(afterSelfHeal);
    }

    @Test
    public void resync_forcesSendWhenValueUnchanged_andRearmsRenewal() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, scheduler);
        AtomicBoolean busy = new AtomicBoolean(true);

        occupancy.publish(busy::get, false);
        occupancy.resync();
        assertThat(sink.frames).containsExactly(true, true);

        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS);
        assertThat(sink.frames).containsExactly(true, true, true);
    }

    @Test
    public void resync_withFreshSample_rearmsWhenNowBusy() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        RecordingSink sink = new RecordingSink();
        PhotoPromptOccupancy occupancy = newOccupancy(sink, scheduler);
        AtomicBoolean busy = new AtomicBoolean(false);

        occupancy.publish(busy::get, false);
        busy.set(true);
        occupancy.resync();
        assertThat(sink.frames).containsExactly(false, true);

        scheduler.advance(PhotoPromptOccupancy.LEASE_RENEW_MS);
        assertThat(sink.frames).containsExactly(false, true, true);
    }

    @Test
    public void concurrentMutations_terminalFrameMatchesTerminalPredicate_andKeepsSampleOrder()
            throws Exception {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CopyOnWriteArrayList<Boolean> frames = new CopyOnWriteArrayList<>();
        AtomicBoolean lastSampled = new AtomicBoolean();
        AtomicBoolean capture = new AtomicBoolean();
        AtomicBoolean job = new AtomicBoolean();
        AtomicBoolean recording = new AtomicBoolean();
        PhotoPromptOccupancy occupancy =
                new PhotoPromptOccupancy(
                        busy -> {
                            assertThat(busy).isEqualTo(lastSampled.get());
                            frames.add(busy);
                            return true;
                        },
                        scheduler);

        BooleanSupplier sample =
                () -> {
                    boolean value =
                            PhotoPromptOccupancy.suppressed(
                                    capture.get(), job.get(), recording.get());
                    lastSampled.set(value);
                    return value;
                };

        int threads = 8;
        int opsPerThread = 80;
        CyclicBarrier start = new CyclicBarrier(threads);
        CountDownLatch done = new CountDownLatch(threads);
        List<Throwable> failures = new ArrayList<>();

        for (int i = 0; i < threads; i++) {
            final int seed = i + 1;
            new Thread(
                            () -> {
                                try {
                                    start.await(2, TimeUnit.SECONDS);
                                    Random random = new Random(seed);
                                    for (int op = 0; op < opsPerThread; op++) {
                                        int source = random.nextInt(3);
                                        boolean next = random.nextBoolean();
                                        if (source == 0) {
                                            capture.set(next);
                                        } else if (source == 1) {
                                            job.set(next);
                                        } else {
                                            recording.set(next);
                                        }
                                        occupancy.publish(sample, false);
                                    }
                                } catch (Throwable t) {
                                    synchronized (failures) {
                                        failures.add(t);
                                    }
                                } finally {
                                    done.countDown();
                                }
                            })
                    .start();
        }

        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(failures).isEmpty();

        occupancy.publish(sample, false);
        boolean terminal =
                PhotoPromptOccupancy.suppressed(capture.get(), job.get(), recording.get());
        assertThat(frames).isNotEmpty();
        assertThat(frames.get(frames.size() - 1)).isEqualTo(terminal);
    }

    private static PhotoPromptOccupancy newOccupancy(
            RecordingSink sink, FakeCaptureScheduler scheduler) {
        return new PhotoPromptOccupancy(sink, scheduler);
    }

    private static final class RecordingSink implements PhotoPromptOccupancy.Sink {
        final List<Boolean> frames = new ArrayList<>();

        @Override
        public boolean push(boolean busy) {
            frames.add(busy);
            return true;
        }
    }
}
