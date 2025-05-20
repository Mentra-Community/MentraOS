package com.augmentos.asg_client.network;

import android.content.Context;
import android.util.Log;

/**
 * Factory class that creates the appropriate network manager based on device type.
 */
public class NetworkManagerFactory {
    private static final String TAG = "NetworkManagerFactory";
    
    /**
     * Get the appropriate network manager for the current device
     * @param context The application context
     * @return The appropriate network manager
     */
    public static INetworkManager getNetworkManager(Context context) {
        DebugNotificationManager notificationManager = new DebugNotificationManager(context);
        
        // First check if we have system permissions
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