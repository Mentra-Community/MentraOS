package com.mentra.asg_client.camera.request;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.camera.policy.AeStateMachine;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AeCaptureCallbackTest {

    @Test
    public void onCaptureCompleted_whenAeConverges_postsDelayedCapture() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);

        callback.onCaptureCompleted(session, request, result);

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(hooks.captureCount).isEqualTo(1);
        assertThat(hooks.lastDelayMs).isEqualTo(AeStateMachine.EXPOSURE_STABILIZATION_DELAY_MS);
    }

    @Test
    public void onCaptureFailed_whenShooting_ignoresRepeatingRequestFailure() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.shotState = AeStateMachine.ShotState.SHOOTING;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);

        callback.onCaptureFailed(mock(CameraCaptureSession.class), mock(CaptureRequest.class),
                mockFailure(CaptureFailure.REASON_ERROR));

        assertThat(hooks.errorMessage).isNull();
        assertThat(hooks.closeCount).isZero();
        assertThat(hooks.stopCount).isZero();
    }

    @Test
    public void onCaptureFailed_whenNotShooting_reportsErrorAndCloses() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.shotState = AeStateMachine.ShotState.WAITING_AE;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        stateMachine.beginWaitingForAe();

        callback.onCaptureFailed(mock(CameraCaptureSession.class), mock(CaptureRequest.class),
                mockFailure(CaptureFailure.REASON_ERROR));

        assertThat(hooks.errorMessage).isEqualTo("AE sequence failed: " + CaptureFailure.REASON_ERROR);
        assertThat(hooks.shotState).isEqualTo(AeStateMachine.ShotState.IDLE);
        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(hooks.cancelKeepAliveCount).isEqualTo(1);
        assertThat(hooks.closeCount).isEqualTo(1);
        assertThat(hooks.stopCount).isEqualTo(1);
    }

    private static CaptureFailure mockFailure(int reason) {
        CaptureFailure failure = mock(CaptureFailure.class);
        when(failure.getReason()).thenReturn(reason);
        when(failure.getFrameNumber()).thenReturn(42L);
        when(failure.wasImageCaptured()).thenReturn(false);
        return failure;
    }

    private static final class FakeHooks implements AeCaptureCallback.Hooks {
        AeStateMachine.ShotState shotState = AeStateMachine.ShotState.IDLE;
        String errorMessage;
        long lastDelayMs = -1L;
        int captureCount;
        int cancelKeepAliveCount;
        int closeCount;
        int stopCount;

        @Override
        public AeStateMachine.ShotState shotState() {
            return shotState;
        }

        @Override
        public void setShotState(AeStateMachine.ShotState shotState) {
            this.shotState = shotState;
        }

        @Override
        public void recordMeteredIso(Integer iso) {}

        @Override
        public void recordMeteredExposureNs(Long exposureNs) {}

        @Override
        public void postDelayed(Runnable runnable, long delayMs) {
            lastDelayMs = delayMs;
            runnable.run();
        }

        @Override
        public void requestAeLock(CameraCaptureSession session) {}

        @Override
        public void capturePhoto() {
            captureCount++;
        }

        @Override
        public void notifyPhotoError(String errorMessage) {
            this.errorMessage = errorMessage;
        }

        @Override
        public void cancelKeepAliveTimer() {
            cancelKeepAliveCount++;
        }

        @Override
        public void closeCamera() {
            closeCount++;
        }

        @Override
        public void stopSelf() {
            stopCount++;
        }
    }
}
