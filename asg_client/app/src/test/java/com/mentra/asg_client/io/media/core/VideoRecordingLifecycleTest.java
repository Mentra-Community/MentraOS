package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class VideoRecordingLifecycleTest {

    @Test
    public void startDuringStop_runsAfterRecordingTerminates() {
        VideoRecordingLifecycle lifecycle = new VideoRecordingLifecycle();
        AtomicInteger starts = new AtomicInteger();

        assertThat(lifecycle.requestStart(starts::incrementAndGet))
                .isEqualTo(VideoRecordingLifecycle.StartResult.START_NOW);
        lifecycle.recordingStarted();
        assertThat(lifecycle.beginStop()).isTrue();

        assertThat(lifecycle.requestStart(starts::incrementAndGet))
                .isEqualTo(VideoRecordingLifecycle.StartResult.QUEUED);
        assertThat(starts).hasValue(0);

        Runnable queuedStart = lifecycle.recordingTerminated();

        assertThat(queuedStart).isNotNull();
        queuedStart.run();
        assertThat(starts).hasValue(1);
    }

    @Test
    public void secondStartDuringStop_isRejected() {
        VideoRecordingLifecycle lifecycle = recordingLifecycle();

        assertThat(lifecycle.requestStart(() -> {}))
                .isEqualTo(VideoRecordingLifecycle.StartResult.QUEUED);
        assertThat(lifecycle.requestStart(() -> {}))
                .isEqualTo(VideoRecordingLifecycle.StartResult.REJECTED);
    }

    @Test
    public void queuedStart_cannotBeOvertakenAfterTermination() {
        VideoRecordingLifecycle lifecycle = recordingLifecycle();
        lifecycle.requestStart(() -> {});

        assertThat(lifecycle.recordingTerminated()).isNotNull();

        assertThat(lifecycle.requestStart(() -> {}))
                .isEqualTo(VideoRecordingLifecycle.StartResult.REJECTED);
    }

    @Test
    public void cameraIsOccupiedFromStartRequestUntilTermination() {
        VideoRecordingLifecycle lifecycle = new VideoRecordingLifecycle();
        assertThat(lifecycle.isCameraOccupied()).isFalse();

        lifecycle.requestStart(() -> {});
        assertThat(lifecycle.isCameraOccupied()).isTrue();

        lifecycle.recordingStarted();
        assertThat(lifecycle.isCameraOccupied()).isTrue();

        assertThat(lifecycle.beginStop()).isTrue();
        assertThat(lifecycle.isCameraOccupied()).isTrue();

        lifecycle.recordingTerminated();
        assertThat(lifecycle.isCameraOccupied()).isFalse();
    }

    @Test
    public void failedStart_releasesCameraClaim() {
        VideoRecordingLifecycle lifecycle = new VideoRecordingLifecycle();
        lifecycle.requestStart(() -> {});

        lifecycle.startFailed();

        assertThat(lifecycle.isCameraOccupied()).isFalse();
    }

    @Test
    public void failedStart_returnsToIdle() {
        VideoRecordingLifecycle lifecycle = new VideoRecordingLifecycle();
        assertThat(lifecycle.requestStart(() -> {}))
                .isEqualTo(VideoRecordingLifecycle.StartResult.START_NOW);

        lifecycle.startFailed();

        assertThat(lifecycle.requestStart(() -> {}))
                .isEqualTo(VideoRecordingLifecycle.StartResult.START_NOW);
    }

    private VideoRecordingLifecycle recordingLifecycle() {
        VideoRecordingLifecycle lifecycle = new VideoRecordingLifecycle();
        lifecycle.requestStart(() -> {});
        lifecycle.recordingStarted();
        assertThat(lifecycle.beginStop()).isTrue();
        return lifecycle;
    }
}
