package com.mentra.asg_client.io.network.core;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.net.wifi.ScanResult;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.NetworkUtils;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.interfaces.NetworkStateListener;
import com.mentra.asg_client.io.network.models.NetworkInfo;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Base implementation of the INetworkManager interface.
 * Provides common functionality for all network manager implementations.
 */
public abstract class BaseNetworkManager implements INetworkManager {
    private static final String TAG = "BaseNetworkManager";
    
    // Constants for device-persistent hotspot credentials
    private static final String PREFS_NAME = "MentraOSNetworkManager";
    private static final String PREF_DEVICE_ID = "device_hotspot_id";
    private static final String HOTSPOT_SSID_PREFIX = "MentraOS_";
    private static final String HOTSPOT_PASSWORD = "12345678";

    protected final Context context;
    protected final List<NetworkStateListener> listeners = new ArrayList<>();
    
    // Hotspot state tracking - shared across all network manager implementations
    protected boolean isHotspotEnabled = false;
    protected String currentHotspotSsid = "";
    protected String currentHotspotPassword = "";
    
    // Device-persistent hotspot credentials
    private String deviceHotspotSsid = null;
    private final String deviceHotspotPassword = HOTSPOT_PASSWORD;
    
    // Tethering state broadcast receiver
    private BroadcastReceiver tetheringStateReceiver;
    
    // HTTP activity tracking for auto-disconnect
    private long lastHttpActivityTime = 0;
    private static final long HOTSPOT_INACTIVITY_TIMEOUT_MS = 120000; // 120 seconds - increased from 40s to allow time for iOS WiFi connection
    private Handler inactivityCheckHandler;
    private Runnable inactivityCheckRunnable;

    /**
     * Create a new BaseNetworkManager
     *
     * @param context The application context
     */
    public BaseNetworkManager(Context context) {
        this.context = context.getApplicationContext();
        initializeDeviceCredentials();
        this.inactivityCheckHandler = new Handler(Looper.getMainLooper());
    }
    
    /**
     * Initialize device-persistent hotspot credentials
     * Generates a unique 5-character ID for this device if not already generated
     */
    private void initializeDeviceCredentials() {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String deviceId = prefs.getString(PREF_DEVICE_ID, null);
        
        if (deviceId == null) {
            // Generate a new random 5-character ID
            deviceId = generateDeviceId();
            prefs.edit().putString(PREF_DEVICE_ID, deviceId).apply();
            Log.d(TAG, "Generated new device hotspot ID: " + deviceId);
        } else {
            Log.d(TAG, "Using existing device hotspot ID: " + deviceId);
        }
        
        deviceHotspotSsid = HOTSPOT_SSID_PREFIX + deviceId;
        Log.i(TAG, "Device hotspot credentials initialized: SSID=" + deviceHotspotSsid);
    }
    
    /**
     * Generate a random 5-character alphanumeric ID
     * @return The generated ID
     */
    private String generateDeviceId() {
        String chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        StringBuilder id = new StringBuilder();
        java.util.Random random = new java.util.Random();
        
        for (int i = 0; i < 5; i++) {
            id.append(chars.charAt(random.nextInt(chars.length())));
        }
        
        return id.toString();
    }
    
    /**
     * Get the device-persistent hotspot SSID
     * @return The hotspot SSID in format MentraOS_XXXXX
     */
    protected String getDeviceHotspotSsid() {
        return deviceHotspotSsid;
    }
    
    /**
     * Get the device-persistent hotspot password
     * @return The hotspot password (always "12345678")
     */
    protected String getDeviceHotspotPassword() {
        return deviceHotspotPassword;
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
     *
     * @param isConnected true if connected to WiFi, false otherwise
     */
    public void notifyWifiStateChanged(boolean isConnected) {
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
                // Log.d(TAG, "Notifying listener: " + listener.getClass().getSimpleName());
                listener.onWifiStateChanged(isConnected);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener", e);
            }
        }
    }

    /**
     * Notify all listeners that the hotspot state has changed
     *
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
     *
     * @param ssid      The SSID of the network
     * @param password  The password for the network
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
     * Notify all listeners that a hotspot error occurred
     *
     * @param errorMessage Description of the error
     */
    protected void notifyHotspotError(String errorMessage) {
        Log.e(TAG, "Hotspot error: " + errorMessage);
        for (NetworkStateListener listener : listeners) {
            try {
                listener.onHotspotError(errorMessage);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener of hotspot error", e);
            }
        }
    }

    @Override
    public boolean isConnectedToWifi() {
        ConnectivityManager connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) {
            Log.w(TAG, "ConnectivityManager is null");
            return false;
        }

        Network activeNetwork = connectivityManager.getActiveNetwork();
        if (activeNetwork == null) {
            Log.d(TAG, "No active network");
            return false;
        }

        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(activeNetwork);
        if (capabilities == null) {
            Log.d(TAG, "No network capabilities");
            return false;
        }

        boolean hasWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        Log.d(TAG, "WiFi transport available: " + hasWifi);
        return hasWifi;
    }

    @Override
    public String getCurrentWifiSsid() {
        WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        if (wifiManager == null) {
            Log.w(TAG, "WifiManager is null");
            return "";
        }

        if (!wifiManager.isWifiEnabled()) {
            Log.d(TAG, "WiFi is disabled");
            return "";
        }

        android.net.wifi.WifiInfo wifiInfo = wifiManager.getConnectionInfo();
        if (wifiInfo == null) {
            Log.d(TAG, "WifiInfo is null");
            return "";
        }

        String ssid = wifiInfo.getSSID();
        if (ssid == null) {
            Log.d(TAG, "SSID is null");
            return "";
        }

        // Remove quotes if present
        if (ssid.startsWith("\"") && ssid.endsWith("\"")) {
            ssid = ssid.substring(1, ssid.length() - 1);
        }

        Log.d(TAG, "Current WiFi SSID: " + ssid);
        return ssid;
    }

    @Override
    public void initialize() {
        Log.d(TAG, "Initializing BaseNetworkManager");
        Log.d(TAG, "Device hotspot SSID: " + deviceHotspotSsid);
        
        // Register tethering state broadcast receiver
        registerTetheringStateReceiver();
    }

    @Override
    public List<String> getConfiguredWifiNetworks() {
        WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        if (wifiManager == null) {
            Log.w(TAG, "WifiManager is null");
            return new ArrayList<>();
        }

        List<android.net.wifi.WifiConfiguration> configurations = wifiManager.getConfiguredNetworks();
        List<String> networkNames = new ArrayList<>();

        if (configurations != null) {
            for (android.net.wifi.WifiConfiguration config : configurations) {
                if (config.SSID != null) {
                    String ssid = config.SSID;
                    if (ssid.startsWith("\"") && ssid.endsWith("\"")) {
                        ssid = ssid.substring(1, ssid.length() - 1);
                    }
                    networkNames.add(ssid);
                }
            }
        }

        Log.d(TAG, "Configured networks: " + networkNames.size());
        return networkNames;
    }

    // K900-specific constants
    private static final String K900_BROADCAST_ACTION = "com.xy.xsetting.action";
    private static final String K900_SYSTEM_UI_PACKAGE = "com.android.systemui";

    @Override
    public List<String> scanWifiNetworks() {
        final List<String> networks = new ArrayList<>();
        
        try {
            // Ensure WiFi is enabled before scanning
            if (!ensureWifiEnabled()) {
                Log.e(TAG, "Cannot scan for WiFi networks - WiFi could not be enabled");
                return networks;
            }
            
            // Get WiFi manager for scanning
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                Log.e(TAG, "WiFi manager is null");
                return networks;
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
                    try {
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
                    } catch (SecurityException se) {
                        Log.e(TAG, "No permission to access previous scan results", se);
                    } catch (Exception e) {
                        Log.e(TAG, "Error getting previous scan results", e);
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
                try {
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
                } catch (SecurityException se) {
                    Log.e(TAG, "No permission to access scan results", se);
                } catch (Exception e) {
                    Log.e(TAG, "Error getting scan results", e);
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

    @Override
    public void scanWifiNetworks(IWifiScanCallback callback) {
        Log.d(TAG, "📡 ========================================");
        Log.d(TAG, "📡 BASE STREAMING WIFI SCAN STARTED");
        Log.d(TAG, "📡 ========================================");
        
        final List<String> allFoundNetworkSsids = new ArrayList<>();
        
        try {
            // Ensure WiFi is enabled before scanning
            if (!ensureWifiEnabled()) {
                Log.e(TAG, "Cannot scan for WiFi networks - WiFi could not be enabled");
                callback.onScanError("WiFi could not be enabled");
                return;
            }
            
            // Get WiFi manager for scanning
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                Log.e(TAG, "WiFi manager is null");
                callback.onScanError("WiFi manager unavailable");
                return;
            }
            
            // Standard Android WiFi scanning with streaming
            try {
                final AtomicBoolean scanCompleted = new AtomicBoolean(false);
                final CountDownLatch scanLatch = new CountDownLatch(1);
                
                // Create a receiver for scan results
                BroadcastReceiver wifiScanReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(intent.getAction())) {
                            if (scanCompleted.compareAndSet(false, true)) {
                                boolean success = intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false);
                                Log.d(TAG, "Base streaming scan completed, success=" + success);
                                
                                try {
                                    List<ScanResult> scanResults = wifiManager.getScanResults();
                                    if (scanResults != null) {
                                        List<NetworkInfo> newNetworks = new ArrayList<>();
                                        for (ScanResult result : scanResults) {
                                            String ssid = result.SSID;
                                            if (ssid != null && !ssid.isEmpty() && !allFoundNetworkSsids.contains(ssid)) {
                                                NetworkInfo networkInfo = NetworkInfo.fromScanResult(result);
                                                if (networkInfo != null) {
                                                    allFoundNetworkSsids.add(ssid);
                                                    newNetworks.add(networkInfo);
                                                    Log.d(TAG, "Found network: " + networkInfo.toString());
                                                }
                                            }
                                        }
                                        
                                        // Stream all networks found in this scan
                                        if (!newNetworks.isEmpty()) {
                                            Log.d(TAG, "📡 Streaming " + newNetworks.size() + " new networks to callback");
                                            callback.onNetworksFoundEnhanced(newNetworks);
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
                Log.d(TAG, "Base WiFi scan started, success=" + scanStarted);
                
                if (!scanStarted) {
                    Log.e(TAG, "Failed to start WiFi scan");
                    
                    // Try to get previous scan results
                    try {
                        List<ScanResult> scanResults = wifiManager.getScanResults();
                        if (scanResults != null && !scanResults.isEmpty()) {
                            List<NetworkInfo> networks = new ArrayList<>();
                            for (ScanResult result : scanResults) {
                                String ssid = result.SSID;
                                if (ssid != null && !ssid.isEmpty()) {
                                    NetworkInfo networkInfo = NetworkInfo.fromScanResult(result);
                                    if (networkInfo != null) {
                                        networks.add(networkInfo);
                                        allFoundNetworkSsids.add(ssid);
                                        Log.d(TAG, "Found network from previous scan: " + networkInfo.toString());
                                    }
                                }
                            }
                            
                            // Stream results from previous scan
                            if (!networks.isEmpty()) {
                                callback.onNetworksFoundEnhanced(networks);
                            }
                        }
                    } catch (SecurityException se) {
                        Log.e(TAG, "No permission to access previous scan results", se);
                    } catch (Exception e) {
                        Log.e(TAG, "Error getting previous scan results", e);
                    }
                    
                    // Unregister the receiver
                    try {
                        context.unregisterReceiver(wifiScanReceiver);
                    } catch (Exception e) {
                        Log.e(TAG, "Error unregistering scan receiver", e);
                    }
                    
                    callback.onScanComplete(allFoundNetworkSsids.size());
                    return;
                }
                
                // Wait for the scan to complete
                try {
                    boolean completed = scanLatch.await(15, TimeUnit.SECONDS);
                    Log.d(TAG, "Base scan await completed=" + completed + ", scanComplete=" + scanCompleted.get());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    Log.e(TAG, "Interrupted waiting for scan results", e);
                }
                
                // Unregister the receiver
                try {
                    context.unregisterReceiver(wifiScanReceiver);
                } catch (Exception e) {
                    Log.e(TAG, "Error unregistering scan receiver", e);
                }
                
                // Add the current network if not already in the list
                String currentSsid = getCurrentWifiSsid();
                if (!currentSsid.isEmpty() && !allFoundNetworkSsids.contains(currentSsid)) {
                    allFoundNetworkSsids.add(currentSsid);
                    // Create current network info (assume connected networks don't require password)
                    NetworkInfo currentNetwork = new NetworkInfo(currentSsid, false, -50); // Assume good signal if connected
                    List<NetworkInfo> currentNetworkList = new ArrayList<>();
                    currentNetworkList.add(currentNetwork);
                    callback.onNetworksFoundEnhanced(currentNetworkList);
                    Log.d(TAG, "Added current network to scan results: " + currentNetwork.toString());
                }
                
                callback.onScanComplete(allFoundNetworkSsids.size());
                
            } catch (Exception e) {
                Log.e(TAG, "Error in base streaming WiFi scan", e);
                callback.onScanError("Scan failed: " + e.getMessage());
            }
            
        } catch (Exception e) {
            Log.e(TAG, "Error in base streaming WiFi scan", e);
            callback.onScanError("Scan failed: " + e.getMessage());
        }
        
        Log.d(TAG, "📡 Base streaming scan completed with " + allFoundNetworkSsids.size() + " total networks");
    }

    /**
     * Ensures WiFi is enabled, trying multiple methods if necessary.
     * This method is reusable by subclasses to avoid code duplication.
     * 
     * @return true if WiFi is enabled or was successfully enabled, false otherwise
     */
    protected boolean ensureWifiEnabled() {
        WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        if (wifiManager == null) {
            Log.e(TAG, "WiFi manager is null");
            return false;
        }

        // Check if WiFi is already enabled
        if (wifiManager.isWifiEnabled()) {
            Log.d(TAG, "WiFi is already enabled");
            return true;
        }

        Log.d(TAG, "WiFi is disabled, attempting to enable it");
        
        try {
            // Try to enable WiFi using standard method
            wifiManager.setWifiEnabled(true);

            // Wait briefly for WiFi to initialize
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }

            // Check if WiFi is now enabled
            if (wifiManager.isWifiEnabled()) {
                Log.d(TAG, "WiFi enabled successfully using standard method");
                return true;
            }

            // If still not enabled, try broadcast method
            //Log.d(TAG, "Standard WiFi enable failed, trying broadcast method");
            //sendEnableWifiBroadcast();

            // Wait for broadcast to take effect
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }

            // Final check
            boolean isEnabled = wifiManager.isWifiEnabled();
            if (isEnabled) {
                Log.d(TAG, "WiFi enabled successfully using broadcast method");
            } else {
                Log.e(TAG, "Failed to enable WiFi using all available methods");
            }
            return isEnabled;

        } catch (SecurityException se) {
            // Handle permission issues
            //Log.e(TAG, "No permission to enable WiFi, trying broadcast method", se);
            //sendEnableWifiBroadcast();

            // Wait for broadcast to take effect
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }

            // Check if broadcast method worked
            boolean isEnabled = wifiManager.isWifiEnabled();
            if (isEnabled) {
                Log.d(TAG, "WiFi enabled via broadcast after permission error");
            } else {
                Log.e(TAG, "Failed to enable WiFi via broadcast after permission error");
            }
            return isEnabled;
            
        } catch (Exception e) {
            Log.e(TAG, "Error enabling WiFi", e);
            return false;
        }
    }

    protected boolean isK900Device() {
        return true;
//        try {
//            // Check if K900-specific system UI package exists
//            context.getPackageManager().getPackageInfo(K900_SYSTEM_UI_PACKAGE, 0);
//            Log.d(TAG, "K900 device detected");
//            return true;
//        } catch (Exception e) {
//            Log.d(TAG, "Not a K900 device");
//            return false;
//        }
    }

    @Override
    public String getLocalIpAddress() {
        return NetworkUtils.getBestIpAddress(context);
    }

    // Hotspot state management methods - shared across all implementations
    @Override
    public boolean isHotspotEnabled() {
        return isHotspotEnabled;
    }
    
    @Override
    public String getHotspotSsid() {
        return currentHotspotSsid;
    }
    
    @Override
    public String getHotspotPassword() {
        return currentHotspotPassword;
    }
    
    /**
     * Get the gateway IP address when in hotspot mode
     * @return The gateway IP for clients to connect to
     */
    @Override
    public String getHotspotGatewayIp() {
        // Standard Android hotspot gateway IP
        return "192.168.43.1";
    }
    
    /**
     * Update hotspot state - to be called by subclasses when hotspot state changes
     */
    protected void updateHotspotState(boolean enabled, String ssid, String password) {
        this.isHotspotEnabled = enabled;
        this.currentHotspotSsid = ssid != null ? ssid : "";
        this.currentHotspotPassword = password != null ? password : "";
        
        Log.d(TAG, "Hotspot state updated: enabled=" + enabled + ", ssid=" + ssid);
    }
    
    /**
     * Clear hotspot state - to be called by subclasses on shutdown or error
     */
    protected void clearHotspotState() {
        updateHotspotState(false, "", "");
    }
    
    /**
     * Register broadcast receiver for tethering state changes
     */
    private void registerTetheringStateReceiver() {
        if (tetheringStateReceiver != null) {
            return; // Already registered
        }
        
        final String ACTION_TETHER_STATE_CHANGED = "android.net.conn.TETHER_STATE_CHANGED";
        
        tetheringStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_TETHER_STATE_CHANGED.equals(intent.getAction())) {
                    handleTetheringStateChanged();
                }
            }
        };
        
        IntentFilter filter = new IntentFilter(ACTION_TETHER_STATE_CHANGED);
        context.registerReceiver(tetheringStateReceiver, filter);
        Log.d(TAG, "Tethering state receiver registered");
    }
    
    /**
     * Handle tethering state change from broadcast
     */
    private void handleTetheringStateChanged() {
        Log.d(TAG, "🔥 Tethering state changed broadcast received");
        
        // Check if WiFi tethering is active
        boolean isTetheringActive = isWifiTetheringActive();
        
        if (isTetheringActive != isHotspotEnabled) {
            Log.d(TAG, "🔥 Hotspot state changed: " + (isTetheringActive ? "ENABLED" : "DISABLED"));
            
            if (isTetheringActive) {
                // Hotspot was enabled - refresh credentials and update state
                refreshHotspotCredentials();
                
                // Start inactivity monitoring
                startInactivityMonitoring();
            } else {
                // Hotspot was disabled
                clearHotspotState();
                notifyHotspotStateChanged(false);
                
                // Stop inactivity monitoring
                stopInactivityMonitoring();
            }
        }
    }
    
    /**
     * Check if WiFi tethering is currently active
     */
    private boolean isWifiTetheringActive() {
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            // Try to use reflection to check WiFi AP state
            // This is more reliable than checking tethered interfaces
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            java.lang.reflect.Method method = wifiManager.getClass().getDeclaredMethod("isWifiApEnabled");
            method.setAccessible(true);
            return (Boolean) method.invoke(wifiManager);
        } catch (Exception e) {
            Log.w(TAG, "Could not check WiFi AP state via reflection, checking tethered interfaces", e);
            // Fallback: check if any tethered interfaces exist
            try {
                ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
                java.lang.reflect.Method method = cm.getClass().getDeclaredMethod("getTetheredIfaces");
                method.setAccessible(true);
                String[] tetheredIfaces = (String[]) method.invoke(cm);
                return tetheredIfaces != null && tetheredIfaces.length > 0;
            } catch (Exception ex) {
                Log.e(TAG, "Failed to check tethering state", ex);
                return false;
            }
        }
    }
    
    /**
     * Refresh hotspot credentials - to be overridden by subclasses
     * K900 will read from Settings.Global, others use device credentials
     */
    protected void refreshHotspotCredentials() {
        // Default implementation for non-K900 devices
        String ssid = getDeviceHotspotSsid();
        String password = getDeviceHotspotPassword();
        updateHotspotState(true, ssid, password);
        notifyHotspotStateChanged(true);
    }
    
    /**
     * Update HTTP activity timestamp
     */
    public void updateHttpActivity() {
        lastHttpActivityTime = System.currentTimeMillis();
        Log.d(TAG, "📡 HTTP activity detected, updating timestamp");
    }
    
    /**
     * Start monitoring for hotspot inactivity
     */
    private void startInactivityMonitoring() {
        stopInactivityMonitoring(); // Clear any existing monitoring
        
        inactivityCheckRunnable = new Runnable() {
            @Override
            public void run() {
                if (!isHotspotEnabled) {
                    return; // Hotspot already disabled
                }
                
                long currentTime = System.currentTimeMillis();
                long timeSinceLastActivity = currentTime - lastHttpActivityTime;
                
                if (lastHttpActivityTime > 0 && timeSinceLastActivity > HOTSPOT_INACTIVITY_TIMEOUT_MS) {
                    Log.i(TAG, "🔥 Hotspot inactive for " + (timeSinceLastActivity / 1000) + "s, auto-disabling");
                    stopHotspot();
                } else {
                    // Schedule next check in 10 seconds
                    inactivityCheckHandler.postDelayed(this, 10000);
                }
            }
        };
        
        // Reset activity time when starting
        lastHttpActivityTime = System.currentTimeMillis();
        
        // Start checking after initial timeout period
        inactivityCheckHandler.postDelayed(inactivityCheckRunnable, HOTSPOT_INACTIVITY_TIMEOUT_MS);
        Log.d(TAG, "📡 Started hotspot inactivity monitoring");
    }
    
    /**
     * Stop monitoring for hotspot inactivity
     */
    private void stopInactivityMonitoring() {
        if (inactivityCheckRunnable != null) {
            inactivityCheckHandler.removeCallbacks(inactivityCheckRunnable);
            inactivityCheckRunnable = null;
            lastHttpActivityTime = 0;
            Log.d(TAG, "📡 Stopped hotspot inactivity monitoring");
        }
    }

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down BaseNetworkManager");
        
        // Unregister tethering receiver
        if (tetheringStateReceiver != null) {
            try {
                context.unregisterReceiver(tetheringStateReceiver);
                tetheringStateReceiver = null;
            } catch (Exception e) {
                Log.w(TAG, "Error unregistering tethering receiver", e);
            }
        }
        
        // Stop inactivity monitoring
        stopInactivityMonitoring();
        
        // Clear hotspot state on shutdown
        clearHotspotState();
        listeners.clear();
    }
} 