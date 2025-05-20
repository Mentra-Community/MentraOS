package com.augmentos.asg_client.network;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Base implementation of the INetworkManager interface.
 * Provides common functionality for all network manager implementations.
 */
public abstract class BaseNetworkManager implements INetworkManager {
    private static final String TAG = "BaseNetworkManager";
    
    protected final Context context;
    protected final List<NetworkStateListener> listeners = new ArrayList<>();
    protected boolean isHotspotEnabled = false;
    
    /**
     * Create a new BaseNetworkManager
     * @param context The application context
     */
    public BaseNetworkManager(Context context) {
        this.context = context.getApplicationContext();
    }
    
    @Override
    public void addWifiListener(NetworkStateListener listener) {
        if (!listeners.contains(listener)) {
            listeners.add(listener);
        }
    }
    
    @Override
    public void removeWifiListener(NetworkStateListener listener) {
        listeners.remove(listener);
    }
    
    /**
     * Notify all listeners that the WiFi state has changed
     * @param isConnected true if connected to WiFi, false otherwise
     */
    protected void notifyWifiStateChanged(boolean isConnected) {
        // Important! Check the actual WiFi state - this prevents reversed state reporting
        boolean actuallyConnected = isConnectedToWifi();
        
        // If the reported state doesn't match the actual state, log a warning
        if (isConnected != actuallyConnected) {
            Log.w(TAG, "WiFi state mismatch - reported: " + (isConnected ? "connected" : "disconnected") + 
                    ", actual: " + (actuallyConnected ? "connected" : "disconnected"));
            // Use the actual state instead of the reported state
            isConnected = actuallyConnected;
        }
        
        Log.d(TAG, "WiFi state changed: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));
        for (NetworkStateListener listener : listeners) {
            try {
                listener.onWifiStateChanged(isConnected);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener", e);
            }
        }
    }
    
    /**
     * Notify all listeners that the hotspot state has changed
     * @param isEnabled true if the hotspot is enabled, false otherwise
     */
    protected void notifyHotspotStateChanged(boolean isEnabled) {
        Log.d(TAG, "Hotspot state changed: " + (isEnabled ? "enabled" : "disabled"));
        this.isHotspotEnabled = isEnabled;
        for (NetworkStateListener listener : listeners) {
            try {
                listener.onHotspotStateChanged(isEnabled);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener", e);
            }
        }
    }
    
    /**
     * Notify all listeners that WiFi credentials have been received
     * @param ssid The SSID of the network
     * @param password The password for the network
     * @param authToken Optional authentication token
     */
    protected void notifyWifiCredentialsReceived(String ssid, String password, String authToken) {
        Log.d(TAG, "WiFi credentials received for SSID: " + ssid);
        for (NetworkStateListener listener : listeners) {
            try {
                listener.onWifiCredentialsReceived(ssid, password, authToken);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener", e);
            }
        }
    }
    
    /**
     * Check if the device is currently connected to a WiFi network
     * @return true if connected to WiFi, false otherwise
     */
    @Override
    public boolean isConnectedToWifi() {
        try {
            // First, check if WiFi is enabled at all
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null || !wifiManager.isWifiEnabled()) {
                Log.d(TAG, "isConnectedToWifi(): WiFi is disabled or WifiManager is null");
                return false;
            }
            
            // Now check if we're actually connected to a network
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) {
                Log.d(TAG, "isConnectedToWifi(): ConnectivityManager is null");
                return false;
            }
            
            Network network = cm.getActiveNetwork();
            if (network == null) {
                Log.d(TAG, "isConnectedToWifi(): No active network");
                return false;
            }
            
            NetworkCapabilities capabilities = cm.getNetworkCapabilities(network);
            boolean hasWifiTransport = capabilities != null && 
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
            
            Log.d(TAG, "isConnectedToWifi(): WiFi enabled=" + wifiManager.isWifiEnabled() + 
                    ", Has WiFi Transport=" + hasWifiTransport + 
                    ", Status=" + (hasWifiTransport ? "CONNECTED" : "DISCONNECTED"));
            
            return hasWifiTransport;
        } catch (Exception e) {
            Log.e(TAG, "Error checking WiFi connection", e);
            return false;
        }
    }
    
    /**
     * Get the SSID of the currently connected WiFi network
     * @return the SSID string, or empty string if not connected
     */
    @Override
    public String getCurrentWifiSsid() {
        try {
            // First check if we're connected to WiFi at all
            if (!isConnectedToWifi()) {
                return "";
            }
            
            // Get the WiFi manager and connection info
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                return "";
            }
            
            // Get connection info
            String ssid = wifiManager.getConnectionInfo().getSSID();
            
            // WifiManager surrounds SSID with quotes - remove them if present
            if (ssid != null && ssid.startsWith("\"") && ssid.endsWith("\"")) {
                ssid = ssid.substring(1, ssid.length() - 1);
            }
            
            // Check for the "unknown ssid" value
            if (ssid == null || ssid.isEmpty() || "<unknown ssid>".equals(ssid)) {
                return "";
            }
            
            return ssid;
        } catch (Exception e) {
            Log.e(TAG, "Error getting current WiFi SSID", e);
            return "";
        }
    }
    
    /**
     * Initialize the network manager
     * Default implementation checks the current WiFi state and notifies listeners
     */
    @Override
    public void initialize() {
        boolean connected = isConnectedToWifi();
        notifyWifiStateChanged(connected);
        notifyHotspotStateChanged(isHotspotEnabled);
    }
    
    /**
     * Get a list of configured WiFi networks
     * @return a list of configured WiFi network names (SSIDs)
     */
    @Override
    public List<String> getConfiguredWifiNetworks() {
        try {
            // Check if we have WiFi Manager available
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                Log.e(TAG, "WiFi manager is null");
                return new ArrayList<>();
            }
            
            // Since we can't access the configured networks without proper permissions,
            // we just return an empty list in the base implementation
            Log.d(TAG, "Base getConfiguredWifiNetworks implementation returning empty list");
            return new ArrayList<>();
        } catch (Exception e) {
            Log.e(TAG, "Error getting configured WiFi networks", e);
            return new ArrayList<>();
        }
    }
    
    // K900-specific constants
    private static final String K900_BROADCAST_ACTION = "com.xy.xsetting.action";
    private static final String K900_SYSTEM_UI_PACKAGE = "com.android.systemui";
    
    /**
     * Scan for available WiFi networks
     * This implementation works for both standard Android devices and K900 devices
     * @return a list of nearby WiFi network names (SSIDs)
     */
    @Override
    public List<String> scanWifiNetworks() {
        final List<String> networks = new ArrayList<>();
        
        try {
            // Check if we have WiFi Manager available
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                Log.e(TAG, "WiFi manager is null");
                return networks;
            }
            
            // Check if WiFi is enabled
            if (!wifiManager.isWifiEnabled()) {
                Log.d(TAG, "WiFi is disabled, cannot scan for networks");
                return networks;
            }
            
            // First, try the K900-specific approach if this is a K900 device
            boolean isK900 = isK900Device();
            if (isK900) {
                Log.d(TAG, "K900 device detected, trying K900-specific scan");
                
                try {
                    final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
                    final List<String> k900Networks = new ArrayList<>();
                    
                    // Register a receiver to get the scan results
                    BroadcastReceiver receiver = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if (intent != null && intent.hasExtra("scan_list")) {
                                String[] wifiList = intent.getStringArrayExtra("scan_list");
                                if (wifiList != null) {
                                    for (String ssid : wifiList) {
                                        if (ssid != null && !ssid.isEmpty() && !k900Networks.contains(ssid)) {
                                            k900Networks.add(ssid);
                                            Log.d(TAG, "Found K900 scan network: " + ssid);
                                        }
                                    }
                                }
                            }
                            latch.countDown();
                        }
                    };
                    
                    // Register the receiver
                    IntentFilter filter = new IntentFilter("com.xy.xsetting.scan_list");
                    context.registerReceiver(receiver, filter);
                    
                    // Send the request to start scan
                    Intent intent = new Intent(K900_BROADCAST_ACTION);
                    intent.setPackage(K900_SYSTEM_UI_PACKAGE);
                    intent.putExtra("cmd", "scan_wifi");
                    context.sendBroadcast(intent);
                    
                    // Wait for the scan results with a timeout
                    try {
                        if (latch.await(10, java.util.concurrent.TimeUnit.SECONDS)) { // WiFi scan can take a while
                            // Successfully got the networks
                            networks.addAll(k900Networks);
                        } else {
                            Log.w(TAG, "Timeout waiting for K900 scan results");
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        Log.e(TAG, "Interrupted waiting for K900 scan results", e);
                    }
                    
                    // Unregister the receiver
                    try {
                        context.unregisterReceiver(receiver);
                    } catch (Exception e) {
                        Log.e(TAG, "Error unregistering receiver", e);
                    }
                    
                    // If K900 scan worked, return the results
                    if (!networks.isEmpty()) {
                        Log.d(TAG, "K900-specific scan successful, found " + networks.size() + " networks");
                        return networks;
                    }
                    
                    // If K900 scan didn't work, fall through to standard scanning
                    Log.d(TAG, "K900-specific scan returned no results, falling back to standard scan");
                } catch (Exception e) {
                    Log.e(TAG, "Error in K900-specific scan, falling back to standard scan", e);
                }
            }
            
            // Standard approach for WiFi scanning
            try {
                // Try to start a scan with regular Android APIs
                final AtomicBoolean scanComplete = new AtomicBoolean(false);
                final CountDownLatch scanLatch = new CountDownLatch(1);
                
                // Create a receiver for scan results
                BroadcastReceiver wifiScanReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(intent.getAction())) {
                            boolean success = intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false);
                            Log.d(TAG, "Scan completed, success=" + success);
                            scanComplete.set(true);
                            scanLatch.countDown();
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
                    
                    // Try to get the results anyway, maybe there's a recent scan
                    List<android.net.wifi.ScanResult> scanResults = wifiManager.getScanResults();
                    if (scanResults != null && !scanResults.isEmpty()) {
                        for (android.net.wifi.ScanResult result : scanResults) {
                            String ssid = result.SSID;
                            if (ssid != null && !ssid.isEmpty() && !networks.contains(ssid)) {
                                networks.add(ssid);
                                Log.d(TAG, "Found network from previous scan: " + ssid);
                            }
                        }
                    }
                    
                    // Unregister the receiver
                    try {
                        context.unregisterReceiver(wifiScanReceiver);
                    } catch (Exception e) {
                        Log.e(TAG, "Error unregistering scan receiver", e);
                    }
                    
                    return networks;
                }
                
                // Wait for the scan to complete, but with a timeout
                try {
                    boolean completed = scanLatch.await(15, java.util.concurrent.TimeUnit.SECONDS);
                    Log.d(TAG, "Scan await completed=" + completed + ", scanComplete=" + scanComplete.get());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    Log.e(TAG, "Interrupted waiting for scan results", e);
                }
                
                // Get the scan results
                List<android.net.wifi.ScanResult> scanResults = wifiManager.getScanResults();
                if (scanResults != null) {
                    for (android.net.wifi.ScanResult result : scanResults) {
                        String ssid = result.SSID;
                        if (ssid != null && !ssid.isEmpty() && !networks.contains(ssid)) {
                            networks.add(ssid);
                            Log.d(TAG, "Found network: " + ssid);
                        }
                    }
                }
                
                // Unregister the receiver
                try {
                    context.unregisterReceiver(wifiScanReceiver);
                } catch (Exception e) {
                    Log.e(TAG, "Error unregistering scan receiver", e);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error scanning for WiFi networks", e);
            }
            
            // Add the current network if not already in the list
            String currentSsid = getCurrentWifiSsid();
            if (!currentSsid.isEmpty() && !networks.contains(currentSsid)) {
                networks.add(currentSsid);
                Log.d(TAG, "Added current network to scan results: " + currentSsid);
            }
            
            Log.d(TAG, "Found " + networks.size() + " networks with scan");
            return networks;
        } catch (Exception e) {
            Log.e(TAG, "Error scanning for WiFi networks", e);
            return networks;
        }
    }
    
    /**
     * Check if this is a K900 device
     * This is a helper method used by the scanWifiNetworks method
     * @return true if this is a K900 device, false otherwise
     */
    protected boolean isK900Device() {
        try {
            // Check if the SystemUI package exists
            android.content.pm.PackageManager pm = context.getPackageManager();
            pm.getPackageInfo(K900_SYSTEM_UI_PACKAGE, 0);
            
            // Create a test broadcast to check if the K900-specific receiver is present
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
     * Clean up resources
     */
    @Override
    public void shutdown() {
        listeners.clear();
    }
}