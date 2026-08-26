package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class CaptureBusyGateConcurrencyTest {

    @Test
    public void concurrentBegins_onlyOneSucceeds() throws Exception {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate =
                new CaptureBusyGate(new CaptureBusyTracker(), new CaptureWatchdog(scheduler), 50L);
        int threads = 16;
        CyclicBarrier start = new CyclicBarrier(threads);
        CountDownLatch done = new CountDownLatch(threads);
        AtomicInteger wins = new AtomicInteger();
        List<Throwable> failures = new ArrayList<>();

        for (int i = 0; i < threads; i++) {
            new Thread(
                            () -> {
                                try {
                                    start.await(2, TimeUnit.SECONDS);
                                    if (gate.begin("same")) {
                                        wins.incrementAndGet();
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
        assertThat(wins.get()).isEqualTo(1);
        assertThat(gate.isBusy()).isTrue();
        assertThat(gate.activeRequestId()).isEqualTo("same");
    }

    @Test
    public void randomizedBeginEnd_drainsToIdle() throws Exception {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate =
                new CaptureBusyGate(new CaptureBusyTracker(), new CaptureWatchdog(scheduler), 5L);
        int threads = 8;
        int opsPerThread = 200;
        CountDownLatch done = new CountDownLatch(threads);
        List<Throwable> failures = new ArrayList<>();

        for (int i = 0; i < threads; i++) {
            final int seed = i + 1;
            new Thread(
                            () -> {
                                try {
                                    Random random = new Random(seed);
                                    for (int op = 0; op < opsPerThread; op++) {
                                        String id = "req-" + random.nextInt(4);
                                        if (random.nextBoolean()) {
                                            gate.begin(id);
                                        } else {
                                            gate.end(id);
                                        }
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

        scheduler.advance(100);
        for (int i = 0; i < 4; i++) {
            gate.end("req-" + i);
        }
        scheduler.advance(100);

        assertThat(gate.isBusy()).isFalse();
        assertThat(gate.activeRequestId()).isNull();
    }
}
