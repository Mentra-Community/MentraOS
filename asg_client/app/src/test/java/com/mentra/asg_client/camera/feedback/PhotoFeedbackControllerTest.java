package com.mentra.asg_client.camera.feedback;

import static org.assertj.core.api.Assertions.assertThat;
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
        when(hardwareManager.playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME))
                .thenReturn(41L);
        when(hardwareManager.playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME))
                .thenReturn(42L);
        controller = new PhotoFeedbackController(hardwareManager, handler, clock);
    }

    @Test
    public void startColdCapture_playsPrepAndSchedulesCadenceAndTimeout() {
        PhotoFeedbackController.Token token = controller.start("cold", false);
        ArgumentCaptor<Runnable> cadenceRunnable = ArgumentCaptor.forClass(Runnable.class);
        ArgumentCaptor<Runnable> timeoutRunnable = ArgumentCaptor.forClass(Runnable.class);

        assertThat(token).isNotNull();
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);
        verify(handler)
                .postDelayed(
                        cadenceRunnable.capture(),
                        eq(AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS));
        verify(handler)
                .postDelayed(
                        timeoutRunnable.capture(),
                        eq(PhotoFeedbackController.FEEDBACK_SAFETY_TIMEOUT_MS));

        clearInvocations(hardwareManager);
        cadenceRunnable.getValue().run();
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);

        timeoutRunnable.getValue().run();
        clearInvocations(hardwareManager);
        controller.playSnap(token, "late frame");
        verify(hardwareManager, never())
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
    }

    @Test
    public void exposureStarted_schedulesSnapAtConfiguredLeadTime() {
        PhotoFeedbackController.Token token = controller.start("warm", true);
        clearInvocations(handler, hardwareManager);
        long exposureMs = 250L;
        long expectedDelayMs = exposureMs - AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS;
        ArgumentCaptor<Runnable> snapRunnable = ArgumentCaptor.forClass(Runnable.class);

        controller.onExposureStarted(token, 0L, exposureMs * 1_000_000L);

        verify(handler).postDelayed(snapRunnable.capture(), eq(expectedDelayMs));
        snapRunnable.getValue().run();
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
    }

    @Test
    public void exposureStarted_subtractsCallbackLatencyFromSnapDelay() {
        PhotoFeedbackController.Token token = controller.start("warm", true);
        clearInvocations(handler, hardwareManager);
        long sensorTimestampNs = 1_000_000_000L;
        clock.elapsedRealtimeNs = sensorTimestampNs + 50_000_000L;
        long exposureMs = 250L;
        long expectedDelayMs =
                exposureMs - AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS - 50L;
        ArgumentCaptor<Runnable> snapRunnable = ArgumentCaptor.forClass(Runnable.class);

        controller.onExposureStarted(
                token, sensorTimestampNs, exposureMs * 1_000_000L);

        verify(handler).postDelayed(snapRunnable.capture(), eq(expectedDelayMs));
    }

    @Test
    public void shortExposure_playsSnapImmediately() {
        PhotoFeedbackController.Token token = controller.start("short", true);
        clearInvocations(handler, hardwareManager);

        controller.onExposureStarted(
                token, 0L, AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS * 1_000_000L);

        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
    }

    @Test
    public void failureBeforeDelayedSnap_preventsSnapPlayback() {
        PhotoFeedbackController.Token token = controller.start("failed", true);
        clearInvocations(handler, hardwareManager);
        ArgumentCaptor<Runnable> snapRunnable = ArgumentCaptor.forClass(Runnable.class);
        long exposureMs = 250L;

        controller.onExposureStarted(token, 0L, exposureMs * 1_000_000L);
        verify(handler)
                .postDelayed(
                        snapRunnable.capture(),
                        eq(exposureMs - AsgConstants.CAMERA_SNAP_TARGET_LEAD_MS));
        controller.stopForFailure(token);
        snapRunnable.getValue().run();

        verify(hardwareManager, never())
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
    }

    @Test
    public void laterColdCapture_waitsWhileEarlierRequestIsExposing() {
        PhotoFeedbackController.Token first = controller.start("first", true);
        controller.onExposureStarted(first, 0L, 0L);
        clearInvocations(hardwareManager);

        PhotoFeedbackController.Token queued = controller.start("queued", false);

        assertThat(queued).isNotNull();
        verify(hardwareManager, never())
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);
    }

    @Test
    public void displacedColdCapture_resumesWhenNewerRequestFails() {
        controller.start("first", false);
        PhotoFeedbackController.Token newer = controller.start("newer", false);
        clearInvocations(handler, hardwareManager);
        ArgumentCaptor<Runnable> resumeRunnable = ArgumentCaptor.forClass(Runnable.class);

        controller.stopForFailure(newer);

        verify(handler).postDelayed(resumeRunnable.capture(), eq(0L));
        resumeRunnable.getValue().run();
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);
    }

    @Test
    public void timeoutByRequestId_terminalizesMatchingFeedback() {
        PhotoFeedbackController.Token token = controller.start("timed-out", true);
        clearInvocations(hardwareManager);

        controller.stopForTimeout("timed-out");
        controller.playSnap(token, "late frame");

        verify(hardwareManager, never())
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
    }

    @Test
    public void coldCaptureAfterSnap_waitsForSuppressionWindow() {
        PhotoFeedbackController.Token warm = controller.start("warm", true);
        controller.playSnap(warm, "test");
        clearInvocations(handler, hardwareManager);
        ArgumentCaptor<Runnable> resumeRunnable = ArgumentCaptor.forClass(Runnable.class);

        controller.start("cold", false);

        verify(hardwareManager, never())
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);
        verify(handler)
                .postDelayed(
                        resumeRunnable.capture(),
                        eq(PhotoFeedbackController.SNAP_PREP_RESUME_DELAY_MS));
        clock.nowMs = PhotoFeedbackController.SNAP_PREP_RESUME_DELAY_MS;
        resumeRunnable.getValue().run();
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);
    }

    @Test
    public void cleanup_stopsSnapAlreadyInProgress() {
        PhotoFeedbackController.Token token = controller.start("snap", true);
        controller.playSnap(token, "test");
        clearInvocations(hardwareManager);

        controller.cleanup();

        verify(hardwareManager).stopAudioOverlayPlayback(42L);
    }

    @Test
    public void failureAfterSnap_stopsOnlyOwnedSnap() {
        PhotoFeedbackController.Token token = controller.start("snap", true);
        controller.playSnap(token, "test");
        clearInvocations(hardwareManager);

        controller.stopForFailure(token);

        verify(hardwareManager).stopAudioOverlayPlayback(42L);
    }

    @Test
    public void laterSnap_doesNotTruncateEarlierSnap() {
        when(hardwareManager.playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME))
                .thenReturn(42L, 43L);
        PhotoFeedbackController.Token first = controller.start("first", true);
        controller.playSnap(first, "first");
        clearInvocations(hardwareManager);
        PhotoFeedbackController.Token second = controller.start("second", true);

        controller.playSnap(second, "second");

        verify(hardwareManager, never()).stopAudioOverlayPlayback(42L);
        verify(hardwareManager)
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_SNAP,
                        AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME);
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
                .playAudioAssetOverlayTracked(
                        AudioAssets.CAMERA_PREP_CLICK,
                        AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME);
    }

    private static final class MutableClock implements PhotoFeedbackController.Clock {
        private long nowMs;
        private long elapsedRealtimeNs;

        @Override
        public long uptimeMillis() {
            return nowMs;
        }

        @Override
        public long elapsedRealtimeNanos() {
            return elapsedRealtimeNs;
        }
    }
}
