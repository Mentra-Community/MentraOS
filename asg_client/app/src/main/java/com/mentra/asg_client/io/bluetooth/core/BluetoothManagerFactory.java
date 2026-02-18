package com.mentra.asg_client.io.bluetooth.core;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.StandardBluetoothManager;
import com.mentra.asg_client.service.utils.ServiceUtils;

/**
 * Factory class to create the appropriate bluetooth manager implementation
 * based on the device type.
 */
public class BluetoothManagerFactory {
    private static final String TAG = "BluetoothManagerFactory";

    /**
     * Get a bluetooth manager implementation based on the device type
     * @param context The application context
     * @return An implementation of IBluetoothManager appropriate for the device
     */
    public static IBluetoothManager getBluetoothManager(Context context) {
        Context appContext = context.getApplicationContext();
        
        // Switched back to StandardBluetoothManager due to issues with NordicBluetoothManager
        //Log.i(TAG, "Using StandardBluetoothManager instead of NordicBluetoothManager");
        //Log.i(TAG, "Implementation class: " + StandardBluetoothManager.class.getName());
        //return new StandardBluetoothManager(appContext);
        
        Log.d(TAG, "[FORCING K900 IMPLEMENTATION OF BLUETOOTH MANAGER]");
        if (true || ServiceUtils.isK900Device(appContext)) {
            Log.i(TAG, "Creating K900BluetoothManager - K900 device detected");
            Log.d(TAG, "Device type: " + ServiceUtils.getDeviceTypeString(appContext));
            return new K900BluetoothManager(appContext);
        } else {
            Log.i(TAG, "Creating StandardBluetoothManager - standard device detected");
            Log.d(TAG, "Device type: " + ServiceUtils.getDeviceTypeString(appContext));
            return new StandardBluetoothManager(appContext);
        }

    }
    
    /**
     * Check if the device is a K900
     * @param context The application context
     * @return true if the device is a K900, false otherwise
     * @deprecated Use ServiceUtils.isK900Device() instead - centralized implementation
     */
    @Deprecated
    public static boolean isK900Device(Context context) {
        Log.w(TAG, "⚠️ Using deprecated isK900Device() - switch to ServiceUtils.isK900Device()");
        return ServiceUtils.isK900Device(context);
    }
} 