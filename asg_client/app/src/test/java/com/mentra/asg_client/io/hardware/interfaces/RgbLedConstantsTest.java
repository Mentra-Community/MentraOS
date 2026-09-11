package com.mentra.asg_client.io.hardware.interfaces;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.hardware.K900RgbLedController;
import org.junit.Test;

/**
 * Pins the wire contract between the core {@link RgbLedConstants} and the vendor {@code
 * K900RgbLedController} constants.
 *
 * <p>NOTE: this parity test intentionally crosses the core/vendor boundary. It exists only until
 * the A6 module split (after which the vendor controller moves to its own module and this test
 * moves or is retired); until then it guarantees neither side drifts.
 */
public class RgbLedConstantsTest {

    @Test
    public void ledIndexes_matchVendorControllerValues() {
        assertThat(RgbLedConstants.LED_RED).isEqualTo(K900RgbLedController.RGB_LED_RED);
        assertThat(RgbLedConstants.LED_GREEN).isEqualTo(K900RgbLedController.RGB_LED_GREEN);
        assertThat(RgbLedConstants.LED_BLUE).isEqualTo(K900RgbLedController.RGB_LED_BLUE);
        assertThat(RgbLedConstants.LED_ORANGE).isEqualTo(K900RgbLedController.RGB_LED_ORANGE);
        assertThat(RgbLedConstants.LED_WHITE).isEqualTo(K900RgbLedController.RGB_LED_WHITE);
    }

    @Test
    public void defaultBrightness_matchesVendorControllerValue() {
        assertThat(RgbLedConstants.DEFAULT_BRIGHTNESS)
                .isEqualTo(K900RgbLedController.DEFAULT_RGB_LED_BRIGHTNESS);
    }

    @Test
    public void ledIndexes_coverContiguousRangeZeroToFour() {
        assertThat(RgbLedConstants.LED_RED).isEqualTo(0);
        assertThat(RgbLedConstants.LED_GREEN).isEqualTo(1);
        assertThat(RgbLedConstants.LED_BLUE).isEqualTo(2);
        assertThat(RgbLedConstants.LED_ORANGE).isEqualTo(3);
        assertThat(RgbLedConstants.LED_WHITE).isEqualTo(4);
    }
}
