package com.mentra.asg_client.io.bluetooth.core;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.StandardBluetoothManager;
import com.mentra.asg_client.service.utils.DeviceProfile;
import com.mentra.asg_client.service.utils.ServiceUtils;

/**
 * Factory class to create the appropriate bluetooth manager implementation based on the device
 * type.
 */
public class BluetoothManagerFactory {
    private static final String TAG = "BluetoothManagerFactory";

    /**
     * Get a bluetooth manager implementation based on the device type
     *
     * @param context The application context
     * @return An implementation of IBluetoothManager appropriate for the device
     */
    public static ICompanionTransport getBluetoothManager(Context context) {
        Context appContext = context.getApplicationContext();

        DeviceProfile profile = DeviceProfile.detect(appContext);
        Log.d(
                TAG,
                "Device profile: "
                        + profile
                        + " ("
                        + ServiceUtils.getDeviceTypeString(appContext)
                        + ")");

        if (profile.isK900()) {
            Log.i(TAG, "Creating K900BluetoothManager");
            return new K900BluetoothManager(appContext);
        }

        Log.i(TAG, "Creating StandardBluetoothManager");
        return new StandardBluetoothManager(appContext);
    }
}
