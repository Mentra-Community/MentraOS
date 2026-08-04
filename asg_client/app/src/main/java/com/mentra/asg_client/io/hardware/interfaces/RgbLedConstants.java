package com.mentra.asg_client.io.hardware.interfaces;

/**
 * Hardware-agnostic RGB LED index and brightness constants.
 *
 * <p>These values define the wire contract between the phone and the glasses for RGB LED commands
 * (LED index 0-4 plus a default brightness). Vendor-specific controllers (e.g. {@code
 * K900RgbLedController}) must keep their own constants in sync with these values.
 */
public final class RgbLedConstants {
    private RgbLedConstants() {}

    public static final int LED_RED = 0;
    public static final int LED_GREEN = 1;
    public static final int LED_BLUE = 2;
    public static final int LED_ORANGE = 3;
    public static final int LED_WHITE = 4;

    /** Default LED brightness (0-255 scale). */
    public static final int DEFAULT_BRIGHTNESS = 100;
}
