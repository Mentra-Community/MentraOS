package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class CaptureBusyTrackerTest {

    @Test
    public void beginOnIdle_marksBusy() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.begin("a")).isTrue();
        assertThat(tracker.isBusy()).isTrue();
        assertThat(tracker.activeRequestId()).isEqualTo("a");
    }

    @Test
    public void beginWhileBusy_isRejectedAndPreservesActiveId() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        tracker.begin("a");

        assertThat(tracker.begin("b")).isFalse();
        assertThat(tracker.activeRequestId()).isEqualTo("a");
        assertThat(tracker.isBusy()).isTrue();
    }

    @Test
    public void endMatchingId_clears() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        tracker.begin("a");

        assertThat(tracker.end("a")).isTrue();
        assertThat(tracker.isBusy()).isFalse();
        assertThat(tracker.activeRequestId()).isNull();
    }

    @Test
    public void endStaleId_doesNotFreeNewerCapture() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        tracker.begin("n");
        tracker.end("n");
        tracker.begin("n+1");

        assertThat(tracker.end("n")).isFalse();
        assertThat(tracker.activeRequestId()).isEqualTo("n+1");
        assertThat(tracker.isBusy()).isTrue();
    }

    @Test
    public void endWhenIdle_isNoOp() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.end("missing")).isFalse();
        assertThat(tracker.isBusy()).isFalse();
    }

    @Test
    public void sameRequestId_canBeReusedSequentially() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.begin("reuse")).isTrue();
        assertThat(tracker.end("reuse")).isTrue();
        assertThat(tracker.begin("reuse")).isTrue();
        assertThat(tracker.activeRequestId()).isEqualTo("reuse");
    }

    @Test
    public void nullAndEmptyRequestIds_areRejected() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.begin(null)).isFalse();
        assertThat(tracker.begin("")).isFalse();
        assertThat(tracker.end(null)).isFalse();
        assertThat(tracker.end("")).isFalse();
        assertThat(tracker.isBusy()).isFalse();
    }
}
