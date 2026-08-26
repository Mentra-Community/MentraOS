package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class CaptureBusyTrackerTest {

    @Test
    public void beginOnIdle_marksBusy() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.begin("a")).isNotEqualTo(CaptureBusyTracker.NO_CAPTURE);
        assertThat(tracker.isBusy()).isTrue();
        assertThat(tracker.activeRequestId()).isEqualTo("a");
    }

    @Test
    public void beginWhileBusy_isRejectedAndPreservesActiveId() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        tracker.begin("a");

        assertThat(tracker.begin("b")).isEqualTo(CaptureBusyTracker.NO_CAPTURE);
        assertThat(tracker.activeRequestId()).isEqualTo("a");
        assertThat(tracker.isBusy()).isTrue();
    }

    @Test
    public void endMatchingToken_clears() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        long token = tracker.begin("a");

        assertThat(tracker.end(token)).isTrue();
        assertThat(tracker.isBusy()).isFalse();
        assertThat(tracker.activeRequestId()).isNull();
    }

    @Test
    public void endStaleToken_doesNotFreeNewerCapture() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        long stale = tracker.begin("n");
        tracker.end(stale);
        long fresh = tracker.begin("n+1");

        assertThat(tracker.end(stale)).isFalse();
        assertThat(fresh).isNotEqualTo(stale);
        assertThat(tracker.activeRequestId()).isEqualTo("n+1");
        assertThat(tracker.isBusy()).isTrue();
    }

    @Test
    public void staleTokenForReusedRequestId_doesNotFreeNewerCapture() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();
        long first = tracker.begin("reuse");
        // Simulate a force-clear (watchdog expiry) of the first capture, then a second capture
        // reusing the identical request id.
        tracker.end(first);
        long second = tracker.begin("reuse");

        // The first capture's late terminal end must not free the second capture's slot.
        assertThat(tracker.end(first)).isFalse();
        assertThat(second).isNotEqualTo(first);
        assertThat(tracker.isBusy()).isTrue();
        assertThat(tracker.activeRequestId()).isEqualTo("reuse");

        assertThat(tracker.end(second)).isTrue();
        assertThat(tracker.isBusy()).isFalse();
    }

    @Test
    public void endWhenIdle_isNoOp() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.end(1L)).isFalse();
        assertThat(tracker.isBusy()).isFalse();
    }

    @Test
    public void sameRequestId_canBeReusedSequentially() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        long first = tracker.begin("reuse");
        assertThat(first).isNotEqualTo(CaptureBusyTracker.NO_CAPTURE);
        assertThat(tracker.end(first)).isTrue();

        long second = tracker.begin("reuse");
        assertThat(second).isNotEqualTo(CaptureBusyTracker.NO_CAPTURE);
        assertThat(tracker.activeRequestId()).isEqualTo("reuse");
    }

    @Test
    public void nullAndEmptyRequestIds_areRejected() {
        CaptureBusyTracker tracker = new CaptureBusyTracker();

        assertThat(tracker.begin(null)).isEqualTo(CaptureBusyTracker.NO_CAPTURE);
        assertThat(tracker.begin("")).isEqualTo(CaptureBusyTracker.NO_CAPTURE);
        assertThat(tracker.end(CaptureBusyTracker.NO_CAPTURE)).isFalse();
        assertThat(tracker.isBusy()).isFalse();
    }
}
