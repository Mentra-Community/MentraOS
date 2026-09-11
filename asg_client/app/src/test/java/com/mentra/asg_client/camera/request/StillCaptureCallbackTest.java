package com.mentra.asg_client.camera.request;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureRequest;

import com.mentra.asg_client.camera.policy.AeStateMachine;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class StillCaptureCallbackTest {

    @Test
    public void onCaptureStarted_notifiesOwnerWithSensorTimestamp() {
        RecordingHooks hooks = new RecordingHooks();
        StillCaptureCallback callback = new StillCaptureCallback(hooks, 42_000_000L);

        callback.onCaptureStarted(
                mock(CameraCaptureSession.class), mock(CaptureRequest.class), 123_456_789L, 7L);

        assertThat(hooks.exposureStartedTimestampNs).isEqualTo(123_456_789L);
        assertThat(hooks.estimatedExposureDurationNs).isEqualTo(42_000_000L);
        assertThat(hooks.exposureStartedCount).isEqualTo(1);
    }

    private static final class RecordingHooks implements StillCaptureCallback.Hooks {
        private long exposureStartedTimestampNs;
        private long estimatedExposureDurationNs;
        private int exposureStartedCount;

        @Override
        public void recordStillSensorTimestampNs(Long timestampNs) {}

        @Override
        public void recordStillHalStartedWallMs(long startedWallMs) {}

        @Override
        public void notifyPhotoExposureStarted(
                long sensorTimestampNs, long estimatedExposureDurationNs) {
            exposureStartedTimestampNs = sensorTimestampNs;
            this.estimatedExposureDurationNs = estimatedExposureDurationNs;
            exposureStartedCount++;
        }

        @Override
        public boolean stillHalStartedAlreadyLogged() {
            return false;
        }

        @Override
        public boolean stillTimingFinalizedByImageReader() {
            return false;
        }

        @Override
        public void recordStillCaptureCompletedWallMs(long completedWallMs) {}

        @Override
        public void recordCaptureMetadata(JSONObject captureMetadata) {}

        @Override
        public void restorePreview(CameraCaptureSession session) {}

        @Override
        public void notifyPhotoError(String errorMessage) {}

        @Override
        public void cancelImuRecording() {}

        @Override
        public void setShotState(AeStateMachine.ShotState shotState) {}

        @Override
        public void clearAeWaitFlags() {}

        @Override
        public void cancelKeepAliveTimer() {}

        @Override
        public void closeCamera() {}

        @Override
        public void stopSelf() {}
    }
}
