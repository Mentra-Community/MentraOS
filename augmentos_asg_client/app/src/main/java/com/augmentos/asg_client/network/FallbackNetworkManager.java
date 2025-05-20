package com.augmentos.asg_client.network;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Implementation of INetworkManager for devices without system permissions.
 * Provides limited WiFi functionality and prompts the user to manually configure settings.
 * Now includes integrated K900-specific functionality when K900 device is detected.
 */
public class FallbackNetworkManager extends BaseNetworkManager {
    private static final String TAG = "FallbackNetworkManager";
    
    // K900-specific constants
    private static final String K900_BROADCAST_ACTION = "com.xy.xsetting.action";
    private static final String K900_SYSTEM_UI_PACKAGE = "com.android.systemui";
    
    // Default hotspot configuration
    private static final String DEFAULT_HOTSPOT_SSID = "AugmentOS_";
    private static final String DEFAULT_HOTSPOT_PASSWORD = "augmentos1234";
    
    private final WifiManager wifiManager;
    private final DebugNotificationManager notificationManager;
    private BroadcastReceiver wifiStateReceiver;
    private BroadcastReceiver wifiScanReceiver;
    
    // Flag indicating if this is a K900 device
    private boolean isK900Device = false;
    
    /**
     * Create a new FallbackNetworkManager
     * @param context The application context
     * @param notificationManager The notification manager to use
     */
    public FallbackNetworkManager(Context context, DebugNotificationManager notificationManager) {
        super(context);
        this.wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        this.notificationManager = notificationManager;
        
        // Check if this is a K900 device
        this.isK900Device = checkIsK900Device();
        
        if (isK900Device) {
            notificationManager.showDebugNotification(
                    "Enhanced Network Manager", 
                    "Running with K900 device support. Enhanced hotspot functionality available.");
        } else {
            notificationManager.showDebugNotification(
                    "Limited Network Manager", 
                    "Running with limited permissions. WiFi and hotspot functionality will be limited.");
        }
    }
    
    /**
     * Check if the device is a K900
     * @return true if K900 device is detected
     */
    private boolean checkIsK900Device() {
        try {
            // First check if the SystemUI package exists
            PackageManager pm = context.getPackageManager();
            pm.getPackageInfo(K900_SYSTEM_UI_PACKAGE, 0);
            
            // Create a test broadcast to check if the K900-specific receiver is present
            try {
                // Just try to create an intent with the K900-specific action
                Intent testIntent = new Intent(K900_BROADCAST_ACTION);
                testIntent.setPackage(K900_SYSTEM_UI_PACKAGE);
                
                // If we get this far without exceptions, it's likely a K900 device
                Log.i(TAG, "Detected K900 capabilities, enabling enhanced features");
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
     * Override isK900Device to return our cached value
     * This connects the base implementation to our existing field
     */
    @Override
    protected boolean isK900Device() {
        return isK900Device;
    }
    
    @Override
    public void initialize() {
        super.initialize();
        registerWifiStateReceiver();
        
        // Check if we're already connected to WiFi
        if (isConnectedToWifi()) {
            notificationManager.showWifiStateNotification(true);
        } else {
            notificationManager.showWifiStateNotification(false);
            // Prompt the user to enable WiFi manually
            promptEnableWifi();
        }
    }
    
    @Override
    public void enableWifi() {
        try {
            // Try to enable WiFi directly
            if (!wifiManager.isWifiEnabled()) {
                // This will likely fail without system permissions on Android 10+
                wifiManager.setWifiEnabled(true);
            }
            
            // Prompt the user to enable WiFi manually
            promptEnableWifi();
        } catch (Exception e) {
            Log.e(TAG, "Error enabling WiFi", e);
            // Fallback to prompting the user
            promptEnableWifi();
        }
    }
    
    @Override
    public void disableWifi() {
        try {
            // Try to disable WiFi directly
            if (wifiManager.isWifiEnabled()) {
                // This will likely fail without system permissions on Android 10+
                wifiManager.setWifiEnabled(false);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error disabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Control Limited",
                    "Unable to disable WiFi automatically. Please disable WiFi manually.");
        }
    }
    
    @Override
    public void startHotspot(String ssid, String password) {
        // Use reasonable defaults if not provided
        if (ssid == null || ssid.isEmpty()) {
            ssid = DEFAULT_HOTSPOT_SSID + System.currentTimeMillis() % 1000;
        }
        
        if (password == null || password.isEmpty() || password.length() < 8) {
            password = DEFAULT_HOTSPOT_PASSWORD;
        }
        
        // If this is a K900 device, try to use the K900-specific broadcasts
        if (isK900Device) {
            try {
                // Send the K900-specific broadcast to start the hotspot
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.setPackage(K900_SYSTEM_UI_PACKAGE);
                intent.putExtra("cmd", "ap_start");
                intent.putExtra("enable", true);
                intent.putExtra("ssid", ssid);
                intent.putExtra("pwd", password);
                context.sendBroadcast(intent);
                
                notificationManager.showDebugNotification(
                        "K900 Hotspot Starting", 
                        "Attempting to start hotspot with SSID: " + ssid);
                
                // Mark the hotspot as enabled
                notifyHotspotStateChanged(true);
                notificationManager.showHotspotStateNotification(true);
                
                return; // Early return if K900 approach is used
            } catch (Exception e) {
                Log.e(TAG, "Error starting K900 hotspot", e);
                // Fall through to default implementation if K900 approach fails
            }
        }
        
        // Default fallback approach for non-K900 devices
        // We can't start a hotspot without system permissions
        // Prompt the user to enable hotspot manually
        promptEnableHotspot();
    }
    
    @Override
    public void stopHotspot() {
        // If this is a K900 device, try to use the K900-specific broadcasts
        if (isK900Device) {
            try {
                // Send the K900-specific broadcast to stop the hotspot
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.setPackage(K900_SYSTEM_UI_PACKAGE);
                intent.putExtra("cmd", "ap_start");
                intent.putExtra("enable", false);
                context.sendBroadcast(intent);
                
                notificationManager.showDebugNotification(
                        "K900 Hotspot Stopping", 
                        "Attempting to stop hotspot");
                
                // Mark the hotspot as disabled
                notifyHotspotStateChanged(false);
                notificationManager.showHotspotStateNotification(false);
                
                return; // Early return if K900 approach is used
            } catch (Exception e) {
                Log.e(TAG, "Error stopping K900 hotspot", e);
                // Fall through to default implementation if K900 approach fails
            }
        }
        
        // Default fallback approach for non-K900 devices
        // We can't stop a hotspot without system permissions
        // Prompt the user to disable hotspot manually
        notificationManager.showDebugNotification(
                "Hotspot Control Limited",
                "Unable to disable hotspot automatically. Please disable the hotspot manually.");
    }
    
    @Override
    public void connectToWifi(String ssid, String password) {
        // If this is a K900 device, try to use K900-specific approach
        if (isK900Device) {
            try {
                // First ensure WiFi is enabled
                if (!wifiManager.isWifiEnabled()) {
                    wifiManager.setWifiEnabled(true);
                }
                
                // For K900, try to use K900-specific broadcast
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.setPackage(K900_SYSTEM_UI_PACKAGE);
                intent.putExtra("cmd", "wifi_connect");
                intent.putExtra("ssid", ssid);
                intent.putExtra("pwd", password);
                context.sendBroadcast(intent);
                
                notificationManager.showDebugNotification(
                        "K900 WiFi Connection", 
                        "Attempting to connect to: " + ssid);
                
                // Poll connection status
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            for (int i = 0; i < 15; i++) { // Try for up to 30 seconds
                                Thread.sleep(2000);
                                if (isConnectedToWifi()) {
                                    new Handler(Looper.getMainLooper()).post(new Runnable() {
                                        @Override
                                        public void run() {
                                            notifyWifiStateChanged(true);
                                            notificationManager.showWifiStateNotification(true);
                                        }
                                    });
                                    return;
                                }
                            }
                            
                            // If we get here, fall back to manual approach
                            new Handler(Looper.getMainLooper()).post(new Runnable() {
                                @Override
                                public void run() {
                                    notificationManager.showDebugNotification(
                                            "WiFi Connection Failed", 
                                            "Unable to connect automatically. Please connect to " + 
                                            ssid + " manually.");
                                    promptConnectToWifi(ssid, password);
                                }
                            });
                        } catch (InterruptedException e) {
                            Log.e(TAG, "WiFi connection polling interrupted", e);
                        }
                    }
                }).start();
                
                return; // Early return if K900 approach is used
            } catch (Exception e) {
                Log.e(TAG, "Error with K900 WiFi connection", e);
                // Fall through to default implementation
            }
        }
        
        // Default implementation for non-K900 devices
        promptConnectToWifi(ssid, password);
    }
    
    /**
     * Prompt the user to connect to a specific WiFi network
     */
    private void promptConnectToWifi(String ssid, String password) {
        // We can't connect to WiFi automatically without system permissions
        // Prompt the user to connect manually
        notificationManager.showDebugNotification(
                "Manual WiFi Connection Required",
                "Please connect to WiFi network: " + ssid + " manually using the WiFi settings.");
        
        // Open the WiFi settings
        Intent intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
    
    /**
     * Prompt the user to enable WiFi manually
     */
    private void promptEnableWifi() {
        notificationManager.showDebugNotification(
                "WiFi Connection Required",
                "Please enable WiFi and connect to a network manually using the WiFi settings.");
        
        // Try to open the WiFi settings
        try {
            Intent intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Error opening WiFi settings", e);
        }
    }
    
    /**
     * Prompt the user to enable hotspot manually
     */
    private void promptEnableHotspot() {
        notificationManager.showDebugNotification(
                "Hotspot Setup Required",
                "Please enable mobile hotspot manually using the settings.");
        
        // Try to open the hotspot settings
        try {
            Intent intent = new Intent();
            intent.setClassName("com.android.settings", 
                    "com.android.settings.TetherSettings");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Error opening hotspot settings", e);
            
            // Fallback to main settings
            try {
                Intent intent = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
            } catch (Exception e2) {
                Log.e(TAG, "Error opening wireless settings", e2);
            }
        }
    }
    
    /**
     * Register a receiver for WiFi state changes
     */
    private void registerWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            return; // Already registered
        }
        
        wifiStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (WifiManager.NETWORK_STATE_CHANGED_ACTION.equals(intent.getAction())) {
                    boolean connected = isConnectedToWifi();
                    notifyWifiStateChanged(connected);
                    
                    // Always update the notification with the current state
                    notificationManager.showWifiStateNotification(connected);
                    
                    Log.d(TAG, "WiFi state changed broadcast: connected=" + connected);
                }
            }
        };
        
        IntentFilter filter = new IntentFilter(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        context.registerReceiver(wifiStateReceiver, filter);
    }
    
    /**
     * Unregister the WiFi state receiver
     */
    private void unregisterWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            try {
                context.unregisterReceiver(wifiStateReceiver);
                wifiStateReceiver = null;
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering WiFi receiver", e);
            }
        }
        
        if (wifiScanReceiver != null) {
            try {
                context.unregisterReceiver(wifiScanReceiver);
                wifiScanReceiver = null;
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering WiFi scan receiver", e);
            }
        }
    }
    
    /**
     * Get a list of configured WiFi networks
     * @return a list of WiFi network names (SSIDs) if permissions allow, empty list otherwise
     */
    @Override
    public List<String> getConfiguredWifiNetworks() {
        List<String> networks = new ArrayList<>();
        
        try {
            // If WiFi manager is not available, return empty list
            if (wifiManager == null) {
                Log.e(TAG, "WiFi manager not available");
                return networks;
            }
            
            // For FallbackNetworkManager, we don't have the permissions needed to get 
            // a complete list of configured networks
            
            // For K900 devices, use K900-specific broadcast to get configured networks
            if (isK900Device) {
                Log.d(TAG, "K900 device detected, attempting to get configured networks");
                
                try {
                    final CountDownLatch latch = new CountDownLatch(1);
                    final List<String> k900Networks = new ArrayList<>();
                    
                    // Register a receiver to get the response
                    BroadcastReceiver receiver = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if (intent != null && intent.hasExtra("wifi_list")) {
                                String[] wifiList = intent.getStringArrayExtra("wifi_list");
                                if (wifiList != null) {
                                    for (String ssid : wifiList) {
                                        if (ssid != null && !ssid.isEmpty()) {
                                            k900Networks.add(ssid);
                                            Log.d(TAG, "Found K900 configured network: " + ssid);
                                        }
                                    }
                                }
                            }
                            latch.countDown();
                        }
                    };
                    
                    // Register the receiver
                    IntentFilter filter = new IntentFilter("com.xy.xsetting.wifi_list");
                    context.registerReceiver(receiver, filter);
                    
                    // Send the request
                    Intent intent = new Intent(K900_BROADCAST_ACTION);
                    intent.setPackage(K900_SYSTEM_UI_PACKAGE);
                    intent.putExtra("cmd", "get_wifi_list");
                    context.sendBroadcast(intent);
                    
                    // Wait for the response with a timeout
                    try {
                        if (latch.await(3, TimeUnit.SECONDS)) {
                            // Successfully got the networks
                            networks.addAll(k900Networks);
                        } else {
                            Log.w(TAG, "Timeout waiting for K900 wifi list");
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        Log.e(TAG, "Interrupted waiting for K900 wifi list", e);
                    }
                    
                    // Unregister the receiver
                    try {
                        context.unregisterReceiver(receiver);
                    } catch (Exception e) {
                        Log.e(TAG, "Error unregistering receiver", e);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error getting K900 configured networks", e);
                }
            }
            
            // At minimum, always add current network if connected
            String currentSsid = getCurrentWifiSsid();
            if (!currentSsid.isEmpty() && !networks.contains(currentSsid)) {
                networks.add(currentSsid);
                Log.d(TAG, "Added current network to configured networks: " + currentSsid);
            }
            
            // Log the result
            if (networks.isEmpty()) {
                Log.d(TAG, "No configured networks found with limited permissions");
            } else {
                Log.d(TAG, "Found " + networks.size() + " networks with limited permissions");
            }
            
            return networks;
        } catch (Exception e) {
            Log.e(TAG, "Error getting configured WiFi networks", e);
            return networks;
        }
    }
    
    // Remove the scanWifiNetworks method completely to use the base implementation
    
    @Override
    public void shutdown() {
        super.shutdown();
        unregisterWifiStateReceiver();
    }
}