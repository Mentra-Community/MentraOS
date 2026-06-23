package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link RgbLedCommandHandler} parses, validates and routes RGB LED commands using core
 * {@code RgbLedConstants} defaults (no vendor classes involved).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class RgbLedCommandHandlerTest {

    private AsgClientServiceManager serviceManager;
    private IHardwareManager hardwareManager;
    private RgbLedCommandHandler handler;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        hardwareManager = mock(IHardwareManager.class);
        when(hardwareManager.supportsRgbLed()).thenReturn(true);
        handler = new RgbLedCommandHandler(serviceManager, hardwareManager);
    }

    @Test
    public void ledOn_noOptionalFields_usesCoreDefaults() {
        boolean handled = handler.handleCommand("rgb_led_control_on", new JSONObject());

        assertThat(handled).isTrue();
        // Defaults: LED_RED(0), 1000ms on, 1000ms off, 1 cycle, DEFAULT_BRIGHTNESS(100)
        verify(hardwareManager).setRgbLedOn(0, 1000, 1000, 1, 100);
    }

    @Test
    public void ledOn_invalidLedIndexTooHigh_rejected() throws Exception {
        boolean handled =
                handler.handleCommand("rgb_led_control_on", new JSONObject().put("led", 5));

        assertThat(handled).isFalse();
        verify(hardwareManager, never())
                .setRgbLedOn(anyInt(), anyInt(), anyInt(), anyInt(), anyInt());
    }

    @Test
    public void ledOn_invalidLedIndexNegative_rejected() throws Exception {
        boolean handled =
                handler.handleCommand("rgb_led_control_on", new JSONObject().put("led", -1));

        assertThat(handled).isFalse();
        verify(hardwareManager, never())
                .setRgbLedOn(anyInt(), anyInt(), anyInt(), anyInt(), anyInt());
    }

    @Test
    public void ledOn_invalidBrightness_rejected() throws Exception {
        boolean handled =
                handler.handleCommand(
                        "rgb_led_control_on", new JSONObject().put("brightness", 256));

        assertThat(handled).isFalse();
        verify(hardwareManager, never())
                .setRgbLedOn(anyInt(), anyInt(), anyInt(), anyInt(), anyInt());
    }

    @Test
    public void photoFlash_noBrightness_usesDefaultBrightness() {
        boolean handled = handler.handleCommand("rgb_led_photo_flash", new JSONObject());

        assertThat(handled).isTrue();
        verify(hardwareManager).flashRgbLedWhite(5000, 100);
    }

    @Test
    public void videoSolid_noBrightness_usesDefaultBrightness() {
        boolean handled = handler.handleCommand("rgb_led_video_solid", new JSONObject());

        assertThat(handled).isTrue();
        verify(hardwareManager).setRgbLedSolidWhite(1800000, 100);
    }

    @Test
    public void ledOff_routesToHardwareManager() {
        boolean handled = handler.handleCommand("rgb_led_control_off", new JSONObject());

        assertThat(handled).isTrue();
        verify(hardwareManager).setRgbLedOff();
    }

    @Test
    public void rgbLedNotSupported_rejectsCommand() {
        when(hardwareManager.supportsRgbLed()).thenReturn(false);

        boolean handled = handler.handleCommand("rgb_led_control_on", new JSONObject());

        assertThat(handled).isFalse();
        verify(hardwareManager, never())
                .setRgbLedOn(anyInt(), anyInt(), anyInt(), anyInt(), anyInt());
    }
}
