package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public class SerialSessionTest {
    @Test
    public void retire_waitsForEnteredCallbackAndRejectsLaterCallbacks() throws Exception {
        SerialSession session = new SerialSession(1, "/dev/ttyS1", 460800);
        CountDownLatch callbackEntered = new CountDownLatch(1);
        CountDownLatch releaseCallback = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);

        try {
            Future<Boolean> callback =
                    executor.submit(
                            () ->
                                    session.dispatch(
                                            () -> {
                                                callbackEntered.countDown();
                                                try {
                                                    releaseCallback.await(1, TimeUnit.SECONDS);
                                                } catch (InterruptedException e) {
                                                    Thread.currentThread().interrupt();
                                                }
                                            }));
            assertThat(callbackEntered.await(1, TimeUnit.SECONDS)).isTrue();

            Future<?> retirement = executor.submit(session::retire);
            Thread.sleep(50);
            assertThat(retirement.isDone()).isFalse();

            releaseCallback.countDown();
            assertThat(callback.get(1, TimeUnit.SECONDS)).isTrue();
            retirement.get(1, TimeUnit.SECONDS);

            assertThat(session.isActive()).isFalse();
            assertThat(session.dispatch(() -> {})).isFalse();
        } finally {
            releaseCallback.countDown();
            executor.shutdownNow();
        }
    }
}
