package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.os.Looper;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoLightControllerTest {
    private IHardwareManager hardwareManager;
    private PhotoLightController controller;

    @Before
    public void setUp() {
        hardwareManager = mock(IHardwareManager.class);
        when(hardwareManager.supportsRgbLed()).thenReturn(true);
        controller = new PhotoLightController(hardwareManager, new Handler(Looper.getMainLooper()));
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
