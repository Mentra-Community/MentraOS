package com.mentra.asg_client.io.network.core;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.managers.FallbackNetworkManager;
import com.mentra.asg_client.io.network.managers.K900NetworkManager;
import com.mentra.asg_client.service.utils.ServiceUtils;
import com.mentra.asg_client.io.network.managers.SystemNetworkManager;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;

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
        // TODO: Should we remove this?
        Log.d(TAG, "[FORCING k900 DEVICE TYPE FOR TESTING]");
        if (true || ServiceUtils.isK900Device(context)) {
            Log.i(TAG, "K900 device detected, using K900NetworkManager");
            Log.d(TAG, "Device type: " + ServiceUtils.getDeviceTypeString(context));
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
     * @deprecated Use ServiceUtils.isK900Device() instead - centralized implementation
     */
    @Deprecated
    private static boolean isK900Device(Context context) {
        Log.w(TAG, "⚠️ Using deprecated isK900Device() - switch to ServiceUtils.isK900Device()");
        return ServiceUtils.isK900Device(context);
    }
    
    /**
     * Check if the app has system permissions
     * @param context The application context
     * @return true if the app has system permissions, false otherwise
     */
    private static boolean hasSystemPermissions(Context context) {
        return false;
//
//        try {
//            // Check if the app is installed in a system location
//            String appPath = context.getPackageCodePath();
//            return appPath.startsWith("/system/") || appPath.contains("/priv-app/");
//        } catch (Exception e) {
//            Log.e(TAG, "Error checking for system permissions", e);
//            return false;
//        }
    }
} 