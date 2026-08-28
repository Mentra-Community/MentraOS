package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class CaptureBusyGateTest {

    @Test
    public void begin_armsWatchdogAndMarksBusy() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        assertThat(gate.begin("a")).isNotEqualTo(CaptureBusyGate.NO_CAPTURE);
        assertThat(gate.isBusy()).isTrue();
        assertThat(gate.activeRequestId()).isEqualTo("a");
    }

    @Test
    public void end_cancelsWatchdogAndClears() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        long token = gate.begin("a");
        assertThat(gate.end(token)).isTrue();
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

        long token = gate.begin("a");
        scheduler.advance(10);

        assertThat(gate.end(token)).isFalse();
        assertThat(gate.isBusy()).isFalse();
    }

    @Test
    public void beginWhileBusy_doesNotReplaceActiveCapture() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        assertThat(gate.begin("a")).isNotEqualTo(CaptureBusyGate.NO_CAPTURE);
        assertThat(gate.begin("b")).isEqualTo(CaptureBusyGate.NO_CAPTURE);
        assertThat(gate.activeRequestId()).isEqualTo("a");
    }

    @Test
    public void lateEndAfterExpiry_doesNotDisturbReusedRequestId() {
        FakeCaptureScheduler scheduler = new FakeCaptureScheduler();
        CaptureBusyGate gate = newGate(scheduler);

        // First capture times out and is force-cleared by the watchdog.
        long first = gate.begin("dup");
        scheduler.advance(10);
        assertThat(gate.isBusy()).isFalse();

        // A newer capture reuses the identical request id.
        long second = gate.begin("dup");
        assertThat(second).isNotEqualTo(first);
        assertThat(gate.isBusy()).isTrue();

        // The first capture's late terminal end must neither clear the busy flag nor cancel the
        // newer capture's safety watchdog.
        assertThat(gate.end(first)).isFalse();
        assertThat(gate.isBusy()).isTrue();
        assertThat(gate.activeRequestId()).isEqualTo("dup");

        // The newer capture's watchdog still fires and force-clears it.
        scheduler.advance(10);
        assertThat(gate.isBusy()).isFalse();
    }

    private static CaptureBusyGate newGate(FakeCaptureScheduler scheduler) {
        return new CaptureBusyGate(new CaptureBusyTracker(), new CaptureWatchdog(scheduler), 10L);
    }
}
