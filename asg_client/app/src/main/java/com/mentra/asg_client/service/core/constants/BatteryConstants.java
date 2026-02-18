package com.mentra.asg_client.service.core.constants;

/**
 * Constants for battery-related operations and thresholds
 */
public class BatteryConstants {
    /**
     * Minimum battery level (percentage) required for camera operations.
     * Operations will be blocked if battery is below this level.
     */
    public static final int MIN_BATTERY_LEVEL = 10;

    /**
     * Battery check interval during recording/streaming (milliseconds).
     * Services will poll battery level at this interval during active operations.
     */
    public static final long BATTERY_CHECK_INTERVAL_MS = 10000; // 10 seconds

    private BatteryConstants() {
        // Prevent instantiation
    }
}
