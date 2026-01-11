package com.mentra.asg_client.io.network.managers;

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

import com.mentra.asg_client.io.network.core.BaseNetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;

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
            // Auto-enable WiFi if not connected
            enableWifi();
        }
    }
    
    @Override
    public void enableWifi() {
        try {
            if (!wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(true);
                notificationManager.showDebugNotification(
                        "WiFi Enabling", 
                        "Attempting to enable WiFi");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error enabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", 
                    "Error enabling WiFi: " + e.getMessage());
        }
    }
    
    @Override
    public void disableWifi() {
        try {
            if (wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(false);
                notificationManager.showDebugNotification(
                        "WiFi Disabling", 
                        "Disabling WiFi");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error disabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", 
                    "Error disabling WiFi: " + e.getMessage());
        }
    }
    
    @Override
    public void startHotspot() {
        // Get device-persistent credentials
        String ssid = getDeviceHotspotSsid();
        String password = getDeviceHotspotPassword();
        
        Log.d(TAG, "Cannot start hotspot without system permissions");
        
        // Just show notification since we don't have system permissions
        notificationManager.showDebugNotification(
                "Manual Hotspot Required", 
                "Please manually enable hotspot with SSID: " + ssid + " Password: " + password);
        
        // Still update our state optimistically
        updateHotspotState(true, ssid, password);
        notifyHotspotStateChanged(true);
        
        // Open system settings for manual configuration
        promptEnableHotspot();
    }
    
    @Override
    public void stopHotspot() {
        Log.d(TAG, "Cannot stop hotspot without system permissions");
        
        // Just show notification since we don't have system permissions
        notificationManager.showDebugNotification(
                "Manual Hotspot Stop Required", 
                "Please manually disable hotspot in system settings");
        
        // Clear our state
        clearHotspotState();
        notificationManager.showHotspotStateNotification(false);
        notifyHotspotStateChanged(false);
        
        // Open system settings for manual configuration
        promptEnableHotspot();
    }
    
    @Override
    public void connectToWifi(String ssid, String password) {
        Log.d(TAG, "Connecting to WiFi network: " + ssid);
        
        if (isK900Device) {
            // Use K900-specific WiFi connection
            try {
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.putExtra("command", "connect_wifi");
                intent.putExtra("ssid", ssid);
                intent.putExtra("password", password);
                context.sendBroadcast(intent);
                
                notificationManager.showDebugNotification(
                        "WiFi Connection", 
                        "Attempting to connect to: " + ssid);
                
                Log.i(TAG, "K900 WiFi connect command sent for SSID: " + ssid);
            } catch (Exception e) {
                Log.e(TAG, "Error connecting to WiFi via K900", e);
                notificationManager.showDebugNotification(
                        "WiFi Error", 
                        "Failed to connect to WiFi: " + e.getMessage());
            }
        } else {
            // Fallback to manual WiFi setup
            promptConnectToWifi(ssid, password);
        }
    }
    
    @Override
    public void disconnectFromWifi() {
        Log.d(TAG, "Disconnecting from current WiFi network");
        
        if (isK900Device) {
            // Use K900-specific WiFi disconnection
            try {
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.putExtra("command", "disconnect_wifi");
                context.sendBroadcast(intent);
                
                notificationManager.showDebugNotification(
                        "WiFi Disconnect", 
                        "Disconnecting from current network");
                
                Log.i(TAG, "K900 WiFi disconnect command sent");
            } catch (Exception e) {
                Log.e(TAG, "Error disconnecting from WiFi via K900", e);
                notificationManager.showDebugNotification(
                        "WiFi Error", 
                        "Failed to disconnect from WiFi: " + e.getMessage());
            }
        } else {
            // Fallback to manual WiFi disconnect
            promptDisconnectFromWifi();
        }
    }

    @Override
    public void forgetWifiNetwork(String ssid) {
        Log.d(TAG, "Forgetting WiFi network: " + ssid);
        // Fallback to manual WiFi forget
        notificationManager.showDebugNotification(
                "Manual WiFi Forget",
                "Please forget network '" + ssid + "' via system settings");
        Log.d(TAG, "Manual WiFi forget prompt shown for: " + ssid);
    }

    private void promptDisconnectFromWifi() {
        // Show notification to guide user to manual WiFi disconnect
        notificationManager.showDebugNotification(
                "Manual WiFi Disconnect", 
                "Please disconnect from WiFi via system settings");
        
        Log.d(TAG, "Manual WiFi disconnect prompt shown");
    }
    
    private void promptConnectToWifi(String ssid, String password) {
        // Show notification to guide user to manual WiFi setup
        notificationManager.showDebugNotification(
                "Manual WiFi Setup", 
                "Please connect to WiFi network: " + ssid + "\nPassword: " + password);
        
        // Open WiFi settings
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                } catch (Exception e) {
                    Log.e(TAG, "Error opening WiFi settings", e);
                }
            }
        }, 1000);
    }
    
    private void promptEnableWifi() {
        // Show notification to guide user to enable WiFi
        notificationManager.showDebugNotification(
                "Enable WiFi", 
                "Please enable WiFi in system settings");
        
        // Open WiFi settings
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                } catch (Exception e) {
                    Log.e(TAG, "Error opening WiFi settings", e);
                }
            }
        }, 1000);
    }
    
    private void promptEnableHotspot() {
        // Show notification to guide user to enable hotspot
        notificationManager.showDebugNotification(
                "Enable Hotspot", 
                "Please enable mobile hotspot in system settings");
        
        // Open hotspot settings
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                } catch (Exception e) {
                    Log.e(TAG, "Error opening wireless settings", e);
                }
            }
        }, 1000);
    }
    
    private void registerWifiStateReceiver() {
        wifiStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action != null) {
                    switch (action) {
                        case WifiManager.NETWORK_STATE_CHANGED_ACTION:
                            boolean isConnected = isConnectedToWifi();
                            notificationManager.showWifiStateNotification(isConnected);
                            notifyWifiStateChanged(isConnected);
                            break;
                        case K900_BROADCAST_ACTION:
                            handleK900Broadcast(intent);
                            break;
                    }
                }
            }
        };
        
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        filter.addAction(K900_BROADCAST_ACTION);
        context.registerReceiver(wifiStateReceiver, filter);
    }
    
    private void handleK900Broadcast(Intent intent) {
        String command = intent.getStringExtra("command");
        if (command != null) {
            switch (command) {
                case "wifi_connected":
                    boolean isConnected = intent.getBooleanExtra("connected", false);
                    notificationManager.showWifiStateNotification(isConnected);
                    notifyWifiStateChanged(isConnected);
                    break;
                case "hotspot_state":
                    boolean isEnabled = intent.getBooleanExtra("enabled", false);
                    notificationManager.showHotspotStateNotification(isEnabled);
                    notifyHotspotStateChanged(isEnabled);
                    break;
            }
        }
    }
    
    private void unregisterWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            try {
                context.unregisterReceiver(wifiStateReceiver);
                wifiStateReceiver = null;
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Receiver already unregistered", e);
            }
        }
        
        if (wifiScanReceiver != null) {
            try {
                context.unregisterReceiver(wifiScanReceiver);
                wifiScanReceiver = null;
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Scan receiver already unregistered", e);
            }
        }
    }
    
    @Override
    public List<String> getConfiguredWifiNetworks() {
        List<String> networks = new ArrayList<>();
        
        try {
            List<android.net.wifi.WifiConfiguration> configurations = wifiManager.getConfiguredNetworks();
            if (configurations != null) {
                for (android.net.wifi.WifiConfiguration config : configurations) {
                    if (config.SSID != null) {
                        String ssid = config.SSID;
                        if (ssid.startsWith("\"") && ssid.endsWith("\"")) {
                            ssid = ssid.substring(1, ssid.length() - 1);
                        }
                        networks.add(ssid);
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting configured networks", e);
        }
        
        return networks;
    }
    
    @Override
    public List<String> scanWifiNetworks() {
        List<String> networks = new ArrayList<>();
        
        if (isK900Device) {
            // Use K900-specific scanning
            try {
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.putExtra("command", "scan_wifi_networks");
                context.sendBroadcast(intent);
                
                Log.d(TAG, "K900 WiFi scan request sent");
            } catch (Exception e) {
                Log.e(TAG, "Error scanning WiFi networks with K900", e);
            }
        } else {
            // Use standard Android scanning
            try {
                if (wifiManager.isWifiEnabled()) {
                    wifiManager.startScan();
                    
                    // Wait for scan results
                    CountDownLatch latch = new CountDownLatch(1);
                    AtomicBoolean scanCompleted = new AtomicBoolean(false);
                    
                    wifiScanReceiver = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if (scanCompleted.compareAndSet(false, true)) {
                                List<ScanResult> results = wifiManager.getScanResults();
                                for (ScanResult result : results) {
                                    networks.add(result.SSID);
                                }
                                latch.countDown();
                            }
                        }
                    };
                    
                    IntentFilter filter = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
                    context.registerReceiver(wifiScanReceiver, filter);
                    
                    boolean completed = latch.await(10, TimeUnit.SECONDS);
                    if (!completed) {
                        Log.w(TAG, "WiFi scan timeout");
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error scanning WiFi networks", e);
            }
        }
        
        return networks;
    }
    
    @Override
    public void scanWifiNetworks(IWifiScanCallback callback) {
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 FALLBACK STREAMING WIFI SCAN STARTED");
        Log.d(TAG, "📡 =========================================");
        
        final List<String> allFoundNetworkSsids = new ArrayList<>();
        
        if (isK900Device) {
            // Use K900-specific streaming scanning
            try {
                final CountDownLatch latch = new CountDownLatch(1);
                
                // Register a receiver to get K900 scan results and stream them
                BroadcastReceiver k900ScanReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (intent != null && intent.hasExtra("scan_list")) {
                            String[] wifiList = intent.getStringArrayExtra("scan_list");
                            if (wifiList != null) {
                                List<String> newNetworks = new ArrayList<>();
                                for (String ssid : wifiList) {
                                    if (ssid != null && !ssid.isEmpty() && !allFoundNetworkSsids.contains(ssid)) {
                                        allFoundNetworkSsids.add(ssid);
                                        newNetworks.add(ssid);
                                        Log.d(TAG, "Found K900 scan network: " + ssid);
                                    }
                                }
                                
                                // Stream new networks immediately to callback
                                if (!newNetworks.isEmpty()) {
                                    Log.d(TAG, "📡 Streaming " + newNetworks.size() + " new networks to callback");
                                    callback.onNetworksFound(newNetworks);
                                }
                            }
                        }
                        // Don't count down here - keep listening for more broadcasts
                    }
                };
                
                // Register the receiver for K900 scan results
                IntentFilter k900Filter = new IntentFilter("com.xy.xsetting.scan_list");
                context.registerReceiver(k900ScanReceiver, k900Filter);
                
                // Send K900 scan request
                Intent intent = new Intent(K900_BROADCAST_ACTION);
                intent.setPackage(K900_SYSTEM_UI_PACKAGE);
                intent.putExtra("cmd", "scan_wifi");
                context.sendBroadcast(intent);
                
                Log.d(TAG, "K900 WiFi scan request sent");
                
                // Wait for scan results with extended timeout
                try {
                    if (!latch.await(15, TimeUnit.SECONDS)) {
                        Log.w(TAG, "K900 scan completed after 15 second timeout");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    Log.e(TAG, "Interrupted waiting for K900 scan results", e);
                }
                
                // Unregister the receiver
                try {
                    context.unregisterReceiver(k900ScanReceiver);
                } catch (Exception e) {
                    Log.e(TAG, "Error unregistering K900 scan receiver", e);
                }
                
                callback.onScanComplete(allFoundNetworkSsids.size());
                
            } catch (Exception e) {
                Log.e(TAG, "Error in K900 streaming WiFi scan", e);
                callback.onScanError("K900 scan failed: " + e.getMessage());
            }
        } else {
            // Use standard Android streaming scanning
            try {
                if (!wifiManager.isWifiEnabled()) {
                    Log.e(TAG, "WiFi not enabled for scan");
                    callback.onScanError("WiFi not enabled");
                    return;
                }
                
                final CountDownLatch scanLatch = new CountDownLatch(1);
                final AtomicBoolean scanCompleted = new AtomicBoolean(false);
                
                // Create a receiver for scan results
                wifiScanReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(intent.getAction())) {
                            if (scanCompleted.compareAndSet(false, true)) {
                                boolean success = intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false);
                                Log.d(TAG, "Standard scan completed, success=" + success);
                                
                                try {
                                    List<ScanResult> scanResults = wifiManager.getScanResults();
                                    if (scanResults != null) {
                                        List<String> newNetworks = new ArrayList<>();
                                        for (ScanResult result : scanResults) {
                                            String ssid = result.SSID;
                                            if (ssid != null && !ssid.isEmpty() && !allFoundNetworkSsids.contains(ssid)) {
                                                allFoundNetworkSsids.add(ssid);
                                                newNetworks.add(ssid);
                                                Log.d(TAG, "Found network: " + ssid);
                                            }
                                        }
                                        
                                        // Stream all networks found in this scan
                                        if (!newNetworks.isEmpty()) {
                                            callback.onNetworksFound(newNetworks);
                                        }
                                    }
                                } catch (SecurityException se) {
                                    Log.e(TAG, "No permission to access scan results", se);
                                } catch (Exception e) {
                                    Log.e(TAG, "Error processing scan results", e);
                                }
                                
                                scanLatch.countDown();
                            }
                        }
                    }
                };
                
                // Register the receiver
                IntentFilter intentFilter = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
                context.registerReceiver(wifiScanReceiver, intentFilter);
                
                // Start the scan
                boolean scanStarted = wifiManager.startScan();
                Log.d(TAG, "WiFi scan started, success=" + scanStarted);
                
                if (!scanStarted) {
                    Log.e(TAG, "Failed to start WiFi scan");
                    
                    // Try to get previous scan results
                    try {
                        List<ScanResult> scanResults = wifiManager.getScanResults();
                        if (scanResults != null && !scanResults.isEmpty()) {
                            List<String> networks = new ArrayList<>();
                            for (ScanResult result : scanResults) {
                                String ssid = result.SSID;
                                if (ssid != null && !ssid.isEmpty()) {
                                    networks.add(ssid);
                                    Log.d(TAG, "Found network from previous scan: " + ssid);
                                }
                            }
                            
                            // Stream results from previous scan
                            if (!networks.isEmpty()) {
                                callback.onNetworksFound(networks);
                                allFoundNetworkSsids.addAll(networks);
                            }
                        }
                    } catch (SecurityException se) {
                        Log.e(TAG, "No permission to access previous scan results", se);
                    } catch (Exception e) {
                        Log.e(TAG, "Error getting previous scan results", e);
                    }
                    
                    // Unregister the receiver
                    unregisterWifiScanReceiver();
                    callback.onScanComplete(allFoundNetworkSsids.size());
                    return;
                }
                
                // Wait for the scan to complete
                try {
                    boolean completed = scanLatch.await(15, TimeUnit.SECONDS);
                    Log.d(TAG, "Scan await completed=" + completed + ", scanComplete=" + scanCompleted.get());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    Log.e(TAG, "Interrupted waiting for scan results", e);
                }
                
                // Unregister the receiver
                unregisterWifiScanReceiver();
                
                callback.onScanComplete(allFoundNetworkSsids.size());
                
            } catch (Exception e) {
                Log.e(TAG, "Error in standard streaming WiFi scan", e);
                callback.onScanError("Scan failed: " + e.getMessage());
            }
        }
        
        Log.d(TAG, "📡 Fallback streaming scan completed with " + allFoundNetworkSsids.size() + " total networks");
    }
    
    private void unregisterWifiScanReceiver() {
        if (wifiScanReceiver != null) {
            try {
                context.unregisterReceiver(wifiScanReceiver);
                wifiScanReceiver = null;
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Scan receiver already unregistered", e);
            }
        }
    }
    
    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down FallbackNetworkManager");
        unregisterWifiStateReceiver();
        super.shutdown();
    }
} 