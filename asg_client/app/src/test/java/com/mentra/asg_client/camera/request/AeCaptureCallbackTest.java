package com.mentra.asg_client.camera.request;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.policy.AeStateMachine;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;

import java.lang.reflect.Field;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AeCaptureCallbackTest {

    @Test
    public void onCaptureCompleted_whenAeConvergesAndExposureStable_capturesAfterStableFrames() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(400);
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(25_000_000L);

        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED - 1; i++) {
            callback.onCaptureCompleted(session, request, result);
            assertThat(hooks.captureCount).isZero();
            assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        }
        callback.onCaptureCompleted(session, request, result);

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(hooks.captureCount).isEqualTo(1);
    }

    @Test
    public void onCaptureCompleted_flashRequiredOnRunningCamera_capturesAfterStableFrames() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.reusesRunningCamera = true;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        // Previous shot fired in the same dark scene.
        stateMachine.noteShotFired(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(3888);
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(100_000_000L);

        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED - 1; i++) {
            callback.onCaptureCompleted(session, request, result);
            assertThat(hooks.captureCount).isZero();
        }
        callback.onCaptureCompleted(session, request, result);

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(hooks.captureCount).isEqualTo(1);
    }

    @Test
    public void onCaptureCompleted_lightChangedSinceLastShot_keepsWaiting() {
        // Running camera, but a frame between shots was CONVERGED (the light just went off): the
        // fast path stays off for this wait even though every frame in the wait is FLASH_REQUIRED.
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.reusesRunningCamera = true;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult bright = mock(TotalCaptureResult.class);
        when(bright.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);
        TotalCaptureResult dark = mock(TotalCaptureResult.class);
        when(dark.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        when(dark.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(3888);
        when(dark.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(100_000_000L);
        stateMachine.noteShotFired(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        callback.onCaptureCompleted(session, request, bright); // idle preview, light still on

        stateMachine.beginWaitingForAe();
        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED + 2; i++) {
            callback.onCaptureCompleted(session, request, dark);
        }

        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        assertThat(hooks.captureCount).isZero();
    }

    @Test
    public void onCaptureCompleted_brightShotThenOnlyDarkFrames_keepsWaiting() {
        // The previous shot fired CONVERGED (bright); the light was already off by the time preview
        // resumed, so no bright frame follows it. The next dark shot must not take the fast path.
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.reusesRunningCamera = true;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult bright = mock(TotalCaptureResult.class);
        when(bright.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);
        when(bright.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(400);
        when(bright.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(25_000_000L);
        TotalCaptureResult dark = mock(TotalCaptureResult.class);
        when(dark.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        when(dark.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(3888);
        when(dark.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(100_000_000L);

        stateMachine.beginWaitingForAe();
        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED; i++) {
            callback.onCaptureCompleted(session, request, bright);
        }
        assertThat(hooks.captureCount).isEqualTo(1);
        stateMachine.clearWaitFlags(); // preview restore after the still

        stateMachine.beginWaitingForAe();
        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED + 2; i++) {
            callback.onCaptureCompleted(session, request, dark);
        }

        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        assertThat(hooks.captureCount).isEqualTo(1);
    }

    @Test
    public void onCaptureCompleted_flashRequiredDuringWarmUp_keepsWaiting() {
        // A warm-up's own AE wait has no cold settle floor but is often a fresh open: it must not
        // report ready early in the dark, or the next photo fires before the ISP has settled.
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(3888);
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(100_000_000L);

        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED + 2; i++) {
            callback.onCaptureCompleted(session, request, result);
        }

        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        assertThat(hooks.captureCount).isZero();
    }

    @Test
    public void onCaptureCompleted_flashRequiredOnColdOpen_keepsWaitingUntilTimeout()
            throws Exception {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.minimumExposureStabilizationDelayMs =
                AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(3888);
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(100_000_000L);

        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED + 2; i++) {
            callback.onCaptureCompleted(session, request, result);
        }
        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        assertThat(hooks.captureCount).isZero();

        setLongField(
                stateMachine,
                "aeStartTimeNs",
                System.nanoTime() - AeStateMachine.AE_WAIT_MAX_NS - 1_000_000L);
        callback.onCaptureCompleted(session, request, result);

        assertThat(hooks.lastDelayMs).isZero();
        assertThat(hooks.captureCount).isEqualTo(1);
    }

    @Test
    public void onCaptureCompleted_coldStart_waitsUntilHistoricalExposureSettleFloor() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.minimumExposureStabilizationDelayMs =
                AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS;
        hooks.runDelayedImmediately = false;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(400);
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(25_000_000L);

        for (int i = 0; i < AeStateMachine.STABLE_FRAMES_REQUIRED; i++) {
            callback.onCaptureCompleted(session, request, result);
        }

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(hooks.captureCount).isZero();
        assertThat(hooks.lastDelayMs)
                .isBetween(1L, AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS);
        assertThat(hooks.delayedCapture).isNotNull();

        hooks.delayedCapture.run();
        assertThat(hooks.captureCount).isEqualTo(1);
    }

    @Test
    public void onCaptureCompleted_coldStartConvergedAtTimeout_stillWaitsForExposureSettleFloor()
            throws Exception {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.minimumExposureStabilizationDelayMs =
                AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS;
        hooks.runDelayedImmediately = false;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        setLongField(
                stateMachine,
                "aeStartTimeNs",
                System.nanoTime() - AeStateMachine.AE_WAIT_MAX_NS - 1_000_000L);
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(400);
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME)).thenReturn(25_000_000L);

        callback.onCaptureCompleted(session, request, result);

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(hooks.captureCount).isZero();
        assertThat(hooks.lastDelayMs)
                .isBetween(1L, AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS);
    }

    @Test
    public void onCaptureCompleted_coldStartNeverConvergedAtTimeout_capturesWithoutSettleDelay()
            throws Exception {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        hooks.minimumExposureStabilizationDelayMs =
                AsgConstants.COLD_CAMERA_EXPOSURE_SETTLE_DELAY_MS;
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        setLongField(
                stateMachine,
                "aeStartTimeNs",
                System.nanoTime() - AeStateMachine.AE_WAIT_MAX_NS - 1_000_000L);
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_SEARCHING);

        callback.onCaptureCompleted(session, request, result);

        assertThat(hooks.lastDelayMs).isZero();
        assertThat(hooks.captureCount).isEqualTo(1);
    }

    @Test
    public void onCaptureCompleted_whenExposureOscillates_doesNotCaptureBeforeStability() {
        AeStateMachine stateMachine = new AeStateMachine();
        FakeHooks hooks = new FakeHooks();
        AeCaptureCallback callback = new AeCaptureCallback(stateMachine, hooks);
        CameraCaptureSession session = mock(CameraCaptureSession.class);
        CaptureRequest request = mock(CaptureRequest.class);
        TotalCaptureResult result = mock(TotalCaptureResult.class);
        stateMachine.beginWaitingForAe();
        when(result.get(CaptureResult.CONTROL_AE_STATE))
                .thenReturn(CaptureResult.CONTROL_AE_STATE_CONVERGED);
        when(result.get(CaptureResult.SENSOR_SENSITIVITY)).thenReturn(400);
        // Exposure swings >5% each frame — the stable streak keeps restarting.
        when(result.get(CaptureResult.SENSOR_EXPOSURE_TIME))
                .thenReturn(25_000_000L, 33_000_000L, 25_000_000L, 33_000_000L);

        for (int i = 0; i < 4; i++) {
            callback.onCaptureCompleted(session, request, result);
        }

        assertThat(hooks.captureCount).isZero();
        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
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

    private static void setLongField(Object target, String name, long value) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.setLong(target, value);
    }

    private static final class FakeHooks implements AeCaptureCallback.Hooks {
        AeStateMachine.ShotState shotState = AeStateMachine.ShotState.IDLE;
        String errorMessage;
        long lastDelayMs = -1L;
        long minimumExposureStabilizationDelayMs;
        boolean reusesRunningCamera;
        boolean runDelayedImmediately = true;
        Runnable delayedCapture;
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
        public void scheduleCapturePhoto(long delayMs) {
            lastDelayMs = delayMs;
            delayedCapture = this::capturePhoto;
            if (runDelayedImmediately) {
                delayedCapture.run();
            }
        }

        @Override
        public long minimumExposureStabilizationDelayMs() {
            return minimumExposureStabilizationDelayMs;
        }

        @Override
        public boolean reusesRunningCamera() {
            return reusesRunningCamera;
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
