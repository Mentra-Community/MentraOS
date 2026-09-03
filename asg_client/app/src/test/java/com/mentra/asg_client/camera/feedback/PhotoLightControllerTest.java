package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.os.Looper;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

import java.util.concurrent.TimeUnit;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoLightControllerTest {
    private IHardwareManager hardwareManager;
    private PhotoLightController controller;

    @Before
    public void setUp() {
        hardwareManager = mock(IHardwareManager.class);
        when(hardwareManager.supportsRgbLed()).thenReturn(true);
        when(hardwareManager.supportsRecordingLed()).thenReturn(true);
        controller = new PhotoLightController(hardwareManager, new Handler(Looper.getMainLooper()));
    }

    @Test
    public void privacyLight_turnsOffWhenJpegArrives() {
        PhotoLightController.Token token = controller.prepare(true);

        controller.startPrivacyLight(token, "photo request");
        ShadowLooper.idleMainLooper();
        verify(hardwareManager).setRecordingLedOn();

        controller.finishPrivacyLight(token, "JPEG frame available");
        ShadowLooper.idleMainLooper();
        verify(hardwareManager).setRecordingLedOff();
    }

    @Test
    public void queuedPhotos_keepPrivacyLightOnUntilLastPhotoCompletes() {
        PhotoLightController.Token first = controller.prepare(true);
        PhotoLightController.Token second = controller.prepare(true);

        controller.startPrivacyLight(first, "first request");
        controller.startPrivacyLight(second, "second request");
        ShadowLooper.idleMainLooper();
        verify(hardwareManager, times(1)).setRecordingLedOn();

        controller.finishPrivacyLight(first, "first JPEG");
        ShadowLooper.idleMainLooper();
        verify(hardwareManager, never()).setRecordingLedOff();

        controller.finishPrivacyLight(second, "second JPEG");
        ShadowLooper.idleMainLooper();
        verify(hardwareManager).setRecordingLedOff();
    }

    @Test
    public void disabledCapture_neverChangesPrivacyLight() {
        PhotoLightController.Token token = controller.prepare(false);

        controller.startPrivacyLight(token, "photo request");
        controller.finishPrivacyLight(token, "JPEG frame available");
        ShadowLooper.idleMainLooper();

        verify(hardwareManager, never()).setRecordingLedOn();
        verify(hardwareManager, never()).setRecordingLedOff();
    }

    @Test
    public void missingCaptureCallback_releasesPrivacyLightAtSafetyTimeout() {
        PhotoLightController.Token token = controller.prepare(true);

        controller.startPrivacyLight(token, "photo request");
        ShadowLooper.idleMainLooper();

        shadowOf(Looper.getMainLooper())
                .idleFor(
                        AsgConstants.PHOTO_PRIVACY_LIGHT_SAFETY_TIMEOUT_MS,
                        TimeUnit.MILLISECONDS);

        verify(hardwareManager).setRecordingLedOff();
    }

    @Test
    public void exposureBoundary_flashesPhotoLightOnce() {
        PhotoLightController.Token token = controller.prepare(true);

        controller.onCaptureBoundary(token, "sensor exposure");
        controller.onCaptureBoundary(token, "JPEG fallback");

        verify(hardwareManager, never()).flashRgbLedWhite(
                AsgConstants.PHOTO_LIGHT_DURATION_MS,
                RgbLedConstants.DEFAULT_BRIGHTNESS);
        ShadowLooper.idleMainLooper();

        verify(hardwareManager)
                .flashRgbLedWhite(
                        AsgConstants.PHOTO_LIGHT_DURATION_MS,
                        RgbLedConstants.DEFAULT_BRIGHTNESS);
    }

    @Test
    public void longExposure_keepsPhotoLightOnThroughExposure() {
        PhotoLightController.Token token = controller.prepare(true);

        controller.onCaptureBoundary(token, "sensor exposure", 3_500_000_000L);
        ShadowLooper.idleMainLooper();

        verify(hardwareManager)
                .flashRgbLedWhite(3500, RgbLedConstants.DEFAULT_BRIGHTNESS);
    }

    @Test
    public void disabledCapture_neverFlashesPhotoLight() {
        PhotoLightController.Token token = controller.prepare(false);

        controller.onCaptureBoundary(token, "sensor exposure");
        ShadowLooper.idleMainLooper();

        verify(hardwareManager, never()).flashRgbLedWhite(
                AsgConstants.PHOTO_LIGHT_DURATION_MS,
                RgbLedConstants.DEFAULT_BRIGHTNESS);
    }

    @Test
    public void unsupportedHardware_consumesTokenWithoutRetrying() {
        when(hardwareManager.supportsRgbLed()).thenReturn(false);
        PhotoLightController.Token token = controller.prepare(true);

        controller.onCaptureBoundary(token, "sensor exposure");
        ShadowLooper.idleMainLooper();
        when(hardwareManager.supportsRgbLed()).thenReturn(true);
        controller.onCaptureBoundary(token, "JPEG fallback");
        ShadowLooper.idleMainLooper();

        verify(hardwareManager, never()).flashRgbLedWhite(
                AsgConstants.PHOTO_LIGHT_DURATION_MS,
                RgbLedConstants.DEFAULT_BRIGHTNESS);
    }
}
