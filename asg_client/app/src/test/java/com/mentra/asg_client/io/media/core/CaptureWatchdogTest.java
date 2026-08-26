package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class CaptureWatchdogTest {

    @Test
    public void arm_firesOnceAtDeadline() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger fires = new AtomicInteger();

        watchdog.arm("a", 10, fires::incrementAndGet);
        scheduler.advance(9);
        assertThat(fires).hasValue(0);

        scheduler.advance(1);
        assertThat(fires).hasValue(1);

        scheduler.advance(100);
        assertThat(fires).hasValue(1);
    }

    @Test
    public void cancelBeforeDeadline_neverFires() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger fires = new AtomicInteger();

        watchdog.arm("a", 10, fires::incrementAndGet);
        watchdog.cancel("a");
        scheduler.advance(50);

        assertThat(fires).hasValue(0);
    }

    @Test
    public void concurrentKeys_fireIndependently() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger aFires = new AtomicInteger();
        AtomicInteger bFires = new AtomicInteger();

        watchdog.arm("job:1", 10, aFires::incrementAndGet);
        watchdog.arm("capture:1", 20, bFires::incrementAndGet);

        scheduler.advance(10);
        assertThat(aFires).hasValue(1);
        assertThat(bFires).hasValue(0);

        scheduler.advance(10);
        assertThat(aFires).hasValue(1);
        assertThat(bFires).hasValue(1);
    }

    @Test
    public void cancelKeyA_doesNotDisturbKeyB() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger aFires = new AtomicInteger();
        AtomicInteger bFires = new AtomicInteger();

        watchdog.arm("a", 10, aFires::incrementAndGet);
        watchdog.arm("b", 10, bFires::incrementAndGet);
        watchdog.cancel("a");
        scheduler.advance(10);

        assertThat(aFires).hasValue(0);
        assertThat(bFires).hasValue(1);
    }

    @Test
    public void jobAndCaptureKeys_coexistForSameRequestId() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger jobFires = new AtomicInteger();
        AtomicInteger captureFires = new AtomicInteger();

        watchdog.arm("job:req", 45, jobFires::incrementAndGet);
        watchdog.arm(CaptureBusyGate.captureKey(1L), 10, captureFires::incrementAndGet);

        scheduler.advance(10);
        assertThat(captureFires).hasValue(1);
        assertThat(jobFires).hasValue(0);

        scheduler.advance(35);
        assertThat(jobFires).hasValue(1);
    }

    @Test
    public void rearmSameKey_replacesPriorTimer() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger first = new AtomicInteger();
        AtomicInteger second = new AtomicInteger();

        watchdog.arm("k", 10, first::incrementAndGet);
        watchdog.arm("k", 30, second::incrementAndGet);

        scheduler.advance(10);
        assertThat(first).hasValue(0);
        assertThat(second).hasValue(0);

        scheduler.advance(20);
        assertThat(first).hasValue(0);
        assertThat(second).hasValue(1);
    }

    @Test
    public void cancelAfterFire_isNoOp() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureWatchdog watchdog = new CaptureWatchdog(scheduler);
        AtomicInteger fires = new AtomicInteger();

        watchdog.arm("k", 5, fires::incrementAndGet);
        scheduler.advance(5);
        watchdog.cancel("k");
        scheduler.advance(20);

        assertThat(fires).hasValue(1);
    }
}
