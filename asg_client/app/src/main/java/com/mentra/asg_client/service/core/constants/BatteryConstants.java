package com.mentra.asg_client.service.core.constants;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;

/**
 * Constants for battery-related operations and thresholds
 */
public class BatteryConstants {
    /** Preserve normal/unknown-SOC behavior; only verified hardware may grant an exception. */
    public static boolean isCameraBatteryLow(int batteryLevel, IHardwareManager hardwareManager) {
        return batteryLevel >= 0
                && batteryLevel < MIN_BATTERY_LEVEL
                && (batteryLevel <= AsgConstants.CAMERA_CHARGING_BATTERY_FLOOR
                        || hardwareManager == null
                        || !hardwareManager.allowsLowBatteryCamera(batteryLevel));
    }

    /**
     * Minimum battery level (percentage) required for camera operations.
     * Below this level requires fresh verified active charging above the hard floor.
     */
    public static final int MIN_BATTERY_LEVEL = 15;

    /**
     * Battery check interval during recording/streaming (milliseconds).
     * Services will poll battery level at this interval during active operations.
     */
    public static final long BATTERY_CHECK_INTERVAL_MS = 10000; // 10 seconds

    private BatteryConstants() {
        // Prevent instantiation
    }
}
