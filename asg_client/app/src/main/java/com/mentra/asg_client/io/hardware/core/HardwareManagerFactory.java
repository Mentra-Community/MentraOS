package com.mentra.asg_client.io.hardware.core;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.managers.K900HardwareManager;
import com.mentra.asg_client.io.hardware.managers.StandardHardwareManager;
import com.mentra.asg_client.service.utils.ServiceUtils;

/**
 * Factory class for creating the appropriate IHardwareManager implementation
 * based on the detected device type.
 */
public class HardwareManagerFactory {
    private static final String TAG = "HardwareManagerFactory";
    
    private static IHardwareManager instance;

    /**
     * Get the singleton instance of the hardware manager appropriate for this device.
     * 
     * @param context The application context
     * @return An IHardwareManager implementation suitable for the current device
     */
    public static synchronized IHardwareManager getInstance(Context context) {
        if (instance == null) {
            instance = createHardwareManager(context);
            instance.initialize();
        }
        return instance;
    }
    
    /**
     * Create a new hardware manager based on device detection.
     *
     * @param context The application context
     * @return A new IHardwareManager implementation
     */
    private static IHardwareManager createHardwareManager(Context context) {
        DeviceType deviceType = detectDeviceType(context);
        Log.d(TAG, "🔧 Hardware manager selection: " + deviceType);

        switch (deviceType) {
            case K900:
                return new K900HardwareManager(context);
            case STANDARD_ANDROID:
                return new StandardHardwareManager(context);
            default:
                return new BaseHardwareManager(context);
        }
    }

    /**
     * Detect the device platform so the appropriate hardware manager can be used.
     * Uses centralized device detection from ServiceUtils.
     */
    private static DeviceType detectDeviceType(Context context) {
        Log.d(TAG, "Device fingerprint:");
        Log.d(TAG, "  Manufacturer: " + Build.MANUFACTURER);
        Log.d(TAG, "  Brand: " + Build.BRAND);
        Log.d(TAG, "  Model: " + Build.MODEL);
        Log.d(TAG, "  Device: " + Build.DEVICE);
        Log.d(TAG, "  Product: " + Build.PRODUCT);
        Log.d(TAG, "  Hardware: " + Build.HARDWARE);

        final String model = Build.MODEL != null ? Build.MODEL.toLowerCase() : "";
        final String device = Build.DEVICE != null ? Build.DEVICE.toLowerCase() : "";
        final String brand = Build.BRAND != null ? Build.BRAND.toLowerCase() : "";

        // Use centralized K900 detection from ServiceUtils
        if (ServiceUtils.isK900Device(context)) {
            Log.i(TAG, "K900 device detected via ServiceUtils");
            return DeviceType.K900;
        }

        if (brand.contains("google") || model.contains("pixel") || device.contains("generic")) {
            return DeviceType.STANDARD_ANDROID;
        }

        return DeviceType.UNKNOWN;
    }
    
    /**
     * Reset the singleton instance.
     * Useful for testing or when switching contexts.
     */
    public static synchronized void reset() {
        if (instance != null) {
            instance.shutdown();
            instance = null;
        }
    }
    
    /**
     * Check if a hardware manager has been initialized.
     * 
     * @return true if an instance exists, false otherwise
     */
    public static synchronized boolean hasInstance() {
        return instance != null;
    }

    private enum DeviceType {
        K900,
        STANDARD_ANDROID,
        UNKNOWN
    }
}
