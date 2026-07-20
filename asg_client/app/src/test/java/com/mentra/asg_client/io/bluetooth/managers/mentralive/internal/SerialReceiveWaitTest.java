package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Documents why the historical sleep-based UART receive loop was slow and verifies the wait
 * strategies behave as expected without needing {@code /dev/ttyS1}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class SerialReceiveWaitTest {

    @Test
    public void sleepWait_alwaysWaitsConfiguredDelay() throws Exception {
        AtomicBoolean fast = new AtomicBoolean(true);
        SerialReceiveWait wait = new SerialReceiveWait.SleepWait(fast::get, 5L, 50L);

        long start = System.nanoTime();
        wait.await();
        long elapsedMs = (System.nanoTime() - start) / 1_000_000L;

        assertThat(elapsedMs).isGreaterThanOrEqualTo(4L);

        fast.set(false);
        start = System.nanoTime();
        wait.await();
        elapsedMs = (System.nanoTime() - start) / 1_000_000L;

        assertThat(elapsedMs).isGreaterThanOrEqualTo(40L);
    }

    @Test
    public void forInputStream_fallsBackToSleepWhenFdUnavailable() {
        SerialReceiveWait wait =
                SerialReceiveWait.forInputStream(null, () -> true);

        assertThat(wait).isInstanceOf(SerialReceiveWait.SleepWait.class);
    }
}
