package com.augmentos.asg_client.network;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.util.Log;

/**
 * Factory class that creates the appropriate network manager based on device type.
 */
public class NetworkManagerFactory {
    private static final String TAG = "NetworkManagerFactory";
    
    // K900-specific constants
    private static final String K900_BROADCAST_ACTION = "com.xy.xsetting.action";
    private static final String K900_SYSTEM_UI_PACKAGE = "com.android.systemui";
    
    /**
     * Get the appropriate network manager for the current device
     * @param context The application context
     * @return The appropriate network manager
     */
    public static INetworkManager getNetworkManager(Context context) {
        DebugNotificationManager notificationManager = new DebugNotificationManager(context);
        
        // First check if this is a K900 device
        if (isK900Device(context)) {
            Log.i(TAG, "K900 device detected, using K900NetworkManager");
            notificationManager.showDeviceTypeNotification(true);
            return new K900NetworkManager(context);
        }
        
        // Then check if we have system permissions
        if (hasSystemPermissions(context)) {
            Log.i(TAG, "Device has system permissions, using SystemNetworkManager");
            notificationManager.showDeviceTypeNotification(false);
            return new SystemNetworkManager(context, notificationManager);
        }

        // For all other cases, we use the enhanced FallbackNetworkManager
        // which automatically detects K900 support and enables those features when available
        Log.i(TAG, "Using FallbackNetworkManager with possible K900 enhancements");
        notificationManager.showDeviceTypeNotification(false);
        notificationManager.showDebugNotification(
                "Limited Network Functionality", 
                "This app is running without system permissions. Network functionality will depend on the device type.");
        return new FallbackNetworkManager(context, notificationManager);
    }
    
    /**
     * Check if the device is a K900
     * @param context The application context
     * @return true if the device is a K900, false otherwise
     */
    private static boolean isK900Device(Context context) {
        try {
            // Verify the SystemUI package exists
            PackageManager pm = context.getPackageManager();
            pm.getPackageInfo(K900_SYSTEM_UI_PACKAGE, 0);
            
            // Check for K900-specific system action
            try {
                // Just try to create an intent with the K900-specific action
                Intent testIntent = new Intent(K900_BROADCAST_ACTION);
                testIntent.setPackage(K900_SYSTEM_UI_PACKAGE);
                
                // If we get this far without exceptions, it's likely a K900 device
                Log.i(TAG, "Detected K900 capabilities");
                return true;
            } catch (Exception e) {
                Log.w(TAG, "K900-specific broadcast not supported: " + e.getMessage());
                return false;
            }
        } catch (Exception e) {
            Log.d(TAG, "Not a K900 device: " + e.getMessage());
            return false;
        }
    }
    
    /**
     * Check if the app has system permissions
     * @param context The application context
     * @return true if the app has system permissions, false otherwise
     */
    private static boolean hasSystemPermissions(Context context) {
        try {
            // Check if the app is installed in a system location
            String appPath = context.getPackageCodePath();
            return appPath.startsWith("/system/") || appPath.contains("/priv-app/");
        } catch (Exception e) {
            Log.e(TAG, "Error checking for system permissions", e);
            return false;
        }
    }
}