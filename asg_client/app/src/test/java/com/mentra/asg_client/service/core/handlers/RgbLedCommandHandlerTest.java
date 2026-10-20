package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
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
    private ICompanionTransport transport;
    private IHardwareManager hardwareManager;
    private RgbLedCommandHandler handler;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(transport.isConnected()).thenReturn(true);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        hardwareManager = mock(IHardwareManager.class);
        when(hardwareManager.supportsRgbLed()).thenReturn(true);
        handler = new RgbLedCommandHandler(serviceManager, hardwareManager);
    }

    private JSONObject sentResponse() throws Exception {
        ArgumentCaptor<byte[]> bytes = ArgumentCaptor.forClass(byte[].class);
        verify(transport).sendMessage(bytes.capture());
        return new JSONObject(new String(bytes.getValue(), StandardCharsets.UTF_8));
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

    @Test
    public void ledOn_success_repliesWithRequestId() throws Exception {
        handler.handleCommand(
                "rgb_led_control_on", new JSONObject().put("requestId", "led-1").put("led", 1));

        JSONObject response = sentResponse();
        assertThat(response.getString("type")).isEqualTo("rgb_led_control_response");
        assertThat(response.getString("requestId")).isEqualTo("led-1");
        assertThat(response.getString("state")).isEqualTo("success");
        assertThat(response.getBoolean("success")).isTrue();
    }

    @Test
    public void ledOff_success_repliesWithRequestId() throws Exception {
        handler.handleCommand("rgb_led_control_off", new JSONObject().put("requestId", "led-2"));

        JSONObject response = sentResponse();
        assertThat(response.getString("type")).isEqualTo("rgb_led_control_response");
        assertThat(response.getString("requestId")).isEqualTo("led-2");
        assertThat(response.getString("state")).isEqualTo("success");
    }

    @Test
    public void ledOn_invalidParameters_repliesWithErrorAndRequestId() throws Exception {
        handler.handleCommand(
                "rgb_led_control_on", new JSONObject().put("requestId", "led-3").put("led", 9));

        JSONObject response = sentResponse();
        assertThat(response.getString("type")).isEqualTo("rgb_led_control_response");
        assertThat(response.getString("requestId")).isEqualTo("led-3");
        assertThat(response.getString("state")).isEqualTo("error");
        assertThat(response.getBoolean("success")).isFalse();
        assertThat(response.getString("errorCode")).isEqualTo("invalid_parameters");
    }

    @Test
    public void rgbLedNotSupported_repliesWithErrorAndRequestId() throws Exception {
        when(hardwareManager.supportsRgbLed()).thenReturn(false);

        handler.handleCommand("rgb_led_control_on", new JSONObject().put("requestId", "led-4"));

        JSONObject response = sentResponse();
        assertThat(response.getString("type")).isEqualTo("rgb_led_control_response");
        assertThat(response.getString("requestId")).isEqualTo("led-4");
        assertThat(response.getString("errorCode")).isEqualTo("device_not_supported");
    }

    @Test
    public void commandWithoutRequestId_repliesWithoutOne() throws Exception {
        handler.handleCommand("rgb_led_photo_flash", new JSONObject());

        JSONObject response = sentResponse();
        assertThat(response.getString("type")).isEqualTo("rgb_led_control_response");
        assertThat(response.has("requestId")).isFalse();
        assertThat(response.getString("state")).isEqualTo("success");
    }
}
