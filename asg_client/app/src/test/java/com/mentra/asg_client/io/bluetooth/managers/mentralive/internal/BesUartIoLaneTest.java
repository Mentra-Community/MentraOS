package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public class BesUartIoLaneTest {
    @Test
    public void shutdown_cancelsQueuedCallers() throws Exception {
        BesUartIoLane lane = new BesUartIoLane();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Future<Boolean> running =
                lane.submit(
                        () -> {
                            started.countDown();
                            try {
                                release.await();
                                return true;
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                                return false;
                            }
                        });

        assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
        Future<Boolean> queued = lane.submit(() -> true);

        lane.shutdownNow();
        release.countDown();

        assertThat(queued.isCancelled()).isTrue();
        assertThat(running.get(1, TimeUnit.SECONDS)).isFalse();
    }
}
