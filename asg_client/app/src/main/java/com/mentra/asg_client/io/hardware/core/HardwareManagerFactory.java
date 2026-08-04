package com.mentra.asg_client.io.hardware.core;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.managers.K900HardwareManager;
import com.mentra.asg_client.io.hardware.managers.StandardHardwareManager;
import com.mentra.asg_client.service.utils.DeviceProfile;

/**
 * Factory class for creating the appropriate IHardwareManager implementation based on the detected
 * device type.
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
        DeviceProfile profile = DeviceProfile.detect(context);
        Log.d(TAG, "🔧 Hardware manager selection: " + profile);

        if (profile.isK900()) {
            return new K900HardwareManager(context);
        }
        return new StandardHardwareManager(context);
    }

    /** Reset the singleton instance. Useful for testing or when switching contexts. */
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
}
