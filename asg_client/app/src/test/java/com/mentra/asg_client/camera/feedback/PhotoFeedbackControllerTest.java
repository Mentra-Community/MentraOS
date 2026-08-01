package com.mentra.asg_client.camera.feedback;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.os.Handler;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoFeedbackControllerTest {
    private IHardwareManager hardwareManager;
    private Handler handler;
    private MutableClock clock;
    private PhotoFeedbackController controller;

    @Before
    public void setUp() {
        hardwareManager = mock(IHardwareManager.class);
        handler = mock(Handler.class);
        clock = new MutableClock();
        when(hardwareManager.supportsAudioPlayback()).thenReturn(true);
        when(hardwareManager.playAudioAssetOverlayTracked(AudioAssets.CAMERA_PREP_CLICK))
                .thenReturn(41L);
        controller = new PhotoFeedbackController(hardwareManager, handler, clock);
    }

    @Test
    public void startColdCapture_playsPrepAndSchedulesCadenceAndTimeout() {
        PhotoFeedbackController.Token token = controller.start("cold", false);

        assertThat(token).isNotNull();
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(AudioAssets.CAMERA_PREP_CLICK);
        verify(handler)
                .postDelayed(
                        any(Runnable.class), eq(AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS));
        verify(handler)
                .postDelayed(
                        any(Runnable.class),
                        eq(PhotoFeedbackController.FEEDBACK_SAFETY_TIMEOUT_MS));
    }

    @Test
    public void exposureStarted_schedulesSnapAtConfiguredLeadTime() {
        PhotoFeedbackController.Token token = controller.start("warm", true);
        clearInvocations(handler, hardwareManager);
        long exposureMs = 250L;
        long expectedDelayMs = exposureMs - AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS;
        ArgumentCaptor<Runnable> snapRunnable = ArgumentCaptor.forClass(Runnable.class);

        controller.onExposureStarted(token, exposureMs * 1_000_000L);

        verify(handler).postDelayed(snapRunnable.capture(), eq(expectedDelayMs));
        snapRunnable.getValue().run();
        verify(hardwareManager).playAudioAssetOverlay(AudioAssets.CAMERA_SNAP);
    }

    @Test
    public void failureBeforeDelayedSnap_preventsSnapPlayback() {
        PhotoFeedbackController.Token token = controller.start("failed", true);
        clearInvocations(handler, hardwareManager);
        ArgumentCaptor<Runnable> snapRunnable = ArgumentCaptor.forClass(Runnable.class);
        long exposureMs = 250L;

        controller.onExposureStarted(token, exposureMs * 1_000_000L);
        verify(handler)
                .postDelayed(
                        snapRunnable.capture(),
                        eq(exposureMs - AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS));
        controller.stopForFailure(token);
        snapRunnable.getValue().run();

        verify(hardwareManager, never()).playAudioAssetOverlay(AudioAssets.CAMERA_SNAP);
    }

    @Test
    public void laterColdCapture_waitsWhileEarlierRequestIsExposing() {
        PhotoFeedbackController.Token first = controller.start("first", true);
        controller.onExposureStarted(first, 0L);
        clearInvocations(hardwareManager);

        PhotoFeedbackController.Token queued = controller.start("queued", false);

        assertThat(queued).isNotNull();
        verify(hardwareManager, never())
                .playAudioAssetOverlayTracked(AudioAssets.CAMERA_PREP_CLICK);
    }

    @Test
    public void timeoutByRequestId_terminalizesMatchingFeedback() {
        PhotoFeedbackController.Token token = controller.start("timed-out", true);
        clearInvocations(hardwareManager);

        controller.stopForTimeout("timed-out");
        controller.playSnap(token, "late frame");

        verify(hardwareManager, never()).playAudioAssetOverlay(AudioAssets.CAMERA_SNAP);
    }

    @Test
    public void cleanup_stopsPrepAndMakesCadenceCallbackInert() {
        ArgumentCaptor<Runnable> cadence = ArgumentCaptor.forClass(Runnable.class);
        controller.start("cleanup", false);
        verify(handler)
                .postDelayed(
                        cadence.capture(),
                        eq(AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS));
        clearInvocations(hardwareManager);

        controller.cleanup();
        cadence.getValue().run();

        verify(hardwareManager).stopAudioOverlayPlayback(41L);
        verify(hardwareManager, times(0))
                .playAudioAssetOverlayTracked(AudioAssets.CAMERA_PREP_CLICK);
    }

    private static final class MutableClock implements PhotoFeedbackController.Clock {
        private long nowMs;

        @Override
        public long uptimeMillis() {
            return nowMs;
        }
    }
}
