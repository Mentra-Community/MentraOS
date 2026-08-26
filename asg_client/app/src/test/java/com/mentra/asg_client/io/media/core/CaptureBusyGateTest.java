package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class CaptureBusyGateTest {

    @Test
    public void begin_armsWatchdogAndMarksBusy() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        assertThat(gate.begin("a")).isTrue();
        assertThat(gate.isBusy()).isTrue();
        assertThat(gate.activeRequestId()).isEqualTo("a");
    }

    @Test
    public void end_cancelsWatchdogAndClears() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        gate.begin("a");
        assertThat(gate.end("a")).isTrue();
        scheduler.advance(100);

        assertThat(gate.isBusy()).isFalse();
    }

    @Test
    public void watchdogExpiry_forceClearsTracker() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        gate.begin("a");
        scheduler.advance(10);

        assertThat(gate.isBusy()).isFalse();
        assertThat(gate.activeRequestId()).isNull();
    }

    @Test
    public void endAfterTimeout_isHarmlessNoOp() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        gate.begin("a");
        scheduler.advance(10);

        assertThat(gate.end("a")).isFalse();
        assertThat(gate.isBusy()).isFalse();
    }

    @Test
    public void beginWhileBusy_doesNotReplaceActiveCapture() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        assertThat(gate.begin("a")).isTrue();
        assertThat(gate.begin("b")).isFalse();
        assertThat(gate.activeRequestId()).isEqualTo("a");
    }

    private static CaptureBusyGate newGate(FakeCaptureScheduler scheduler) {
        return new CaptureBusyGate(new CaptureBusyTracker(), new CaptureWatchdog(scheduler), 10L);
    }
}
