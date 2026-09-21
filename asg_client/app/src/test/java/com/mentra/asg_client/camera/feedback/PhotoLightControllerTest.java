package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.os.Looper;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.robolectric.Shadows.shadowOf;
import java.time.Duration;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoLightControllerTest {
    private IHardwareManager hardware;
    private PhotoLightController controller;
    @Before public void setup() {
        hardware = mock(IHardwareManager.class);
        when(hardware.supportsRecordingLed()).thenReturn(true);
        when(hardware.supportsRgbLed()).thenReturn(true);
        when(hardware.acquireRecordingLed(any())).thenReturn(true);
        controller = new PhotoLightController(hardware, new Handler(Looper.getMainLooper()));
    }
    private void advance(long ms) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms));
    }
    @Test public void bothStartAtRequestAndShortCaptureHonorsMinimum() {
        PhotoLightController.Token token = controller.prepare(true);
        verify(hardware).acquireRecordingLed(token);
        verify(hardware).setRgbLedSolidWhite(120_000,
                RgbLedConstants.DEFAULT_BRIGHTNESS);
        controller.onCaptureBoundary(token, "JPEG");
        advance(1499);
        verify(hardware, never()).releaseRecordingLed(token);
        verify(hardware, never()).setRgbLedOff();
        advance(1);
        verify(hardware).releaseRecordingLed(token);
        verify(hardware).setRgbLedOff();
    }
    @Test public void longCaptureStaysLitUntilFrameAndCompletesOnce() {
        PhotoLightController.Token token = controller.prepare(true);
        controller.onCaptureBoundary(token, "exposure", 3_000_000_000L);
        advance(4000);
        verify(hardware, never()).setRgbLedOff();
        controller.onCaptureBoundary(token, "JPEG");
        controller.onCaptureBoundary(token, "saved");
        verify(hardware).releaseRecordingLed(token);
        verify(hardware).setRgbLedOff();
    }
    @Test public void overlappingRequestKeepsLightsOn() {
        PhotoLightController.Token first = controller.prepare(true);
        advance(1000);
        PhotoLightController.Token second = controller.prepare(true);
        controller.finish(first);
        advance(500);
        verify(hardware).releaseRecordingLed(first);
        verify(hardware, never()).setRgbLedOff();
        controller.finish(second);
        advance(1000);
        verify(hardware).releaseRecordingLed(second);
        verify(hardware).setRgbLedOff();
    }
    @Test public void cleanupCancelsPendingReleaseAndDropsAllOwnership() {
        PhotoLightController.Token token = controller.prepare(true);
        controller.finish(token);
        controller.cleanup();
        advance(2000);
        verify(hardware).releaseRecordingLed(token);
        verify(hardware).setRgbLedOff();
    }
    @Test public void otherRecordingOwnerKeepsItsIndicator() {
        PhotoLightController.Token token = controller.prepare(true);
        when(hardware.isRecordingLedOwned()).thenReturn(true);
        controller.cleanup();
        verify(hardware).releaseRecordingLed(token);
        verify(hardware, never()).setRgbLedOff();
    }
    @Test public void disabledRequestDoesNotAcquireOrToggle() {
        controller.finish(controller.prepare(false));
        advance(2000);
        verify(hardware, never()).acquireRecordingLed(any());
        verify(hardware, never()).setRgbLedOff();
    }
    @Test public void failedPrivacyAcquisitionDoesNotStartRgb() {
        when(hardware.acquireRecordingLed(any())).thenReturn(false);
        controller.finish(controller.prepare(true));
        controller.cleanup();
        verify(hardware, never()).setRgbLedSolidWhite(anyInt(), anyInt());
    }
}
