package com.mentra.asg_client.io.network.managers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import com.mentra.asg_client.io.network.core.BaseNetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;
import com.mentra.asg_client.SysControl;

import java.util.ArrayList;
import java.util.List;

/**
 * Implementation of INetworkManager for K900 devices.
 * Assumes K900 is running as a system app on Android 11+.
 * Uses standard Android APIs with reflection for hotspot control.
 */
public class K900NetworkManager extends BaseNetworkManager {
    private static final String TAG = "K900NetworkManager";
    
    // K900-specific constants
    private static final String K900_BROADCAST_ACTION = "com.xy.xsetting.action";
    private static final String K900_SYSTEM_UI_PACKAGE = "com.android.systemui";
    
    // K900 hotspot constants
    private static final String K900_HOTSPOT_PREFIX = "XySmart_";
    private static final String K900_HOTSPOT_PASSWORD = "00001111";
    
    private final WifiManager wifiManager;
    private final DebugNotificationManager notificationManager;
    private BroadcastReceiver wifiStateReceiver;

    // Hotspot SSID retry tracking
    private final Handler ssidRetryHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingSsidRetryRunnable = null;
    
    /**
     * Create a new K900NetworkManager
     * @param context The application context
     */
    public K900NetworkManager(Context context) {
        super(context);
        this.wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        this.notificationManager = new DebugNotificationManager(context);
        
        notificationManager.showDebugNotification(
                "K900 Network Manager",
                "Using K900-specific network APIs");

        enableScan5GWifi(context, true);
    }
    
    @Override
    public void initialize() {
        Log.d(TAG, "🌐 =========================================");
        Log.d(TAG, "🌐 K900 NETWORK MANAGER INITIALIZE");
        Log.d(TAG, "🌐 =========================================");
        
        super.initialize();
        Log.d(TAG, "🌐 ✅ Base network manager initialized");
        
        registerWifiStateReceiver();
        Log.d(TAG, "🌐 ✅ WiFi state receiver registered");
        
        // Check if we're already connected to WiFi
        boolean wifiConnected = isConnectedToWifi();
        Log.d(TAG, "🌐 📡 Current WiFi connection status: " + wifiConnected);
        
        if (wifiConnected) {
            Log.d(TAG, "🌐 ✅ WiFi already connected, showing notification");
            notificationManager.showWifiStateNotification(true);
        } else {
            Log.d(TAG, "🌐 ❌ WiFi not connected, showing notification and enabling WiFi");
            notificationManager.showWifiStateNotification(false);
            // Auto-enable WiFi if not connected
            enableWifi();
        }
        
        Log.d(TAG, "🌐 ✅ K900 Network Manager initialization complete");
    }
    
    @Override
    public void enableWifi() {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 ENABLE WIFI");
        Log.d(TAG, "📶 =========================================");
        
        // Use K900 API to enable WiFi
        try {
            Log.d(TAG, "📶 🔍 Checking current WiFi state...");
            boolean currentlyEnabled = wifiManager.isWifiEnabled();
            Log.d(TAG, "📶 📡 WiFi currently enabled: " + currentlyEnabled);
            
            if (!currentlyEnabled) {
                Log.d(TAG, "📶 🔧 Enabling WiFi via WifiManager...");
                boolean enabled = wifiManager.setWifiEnabled(true);
                Log.d(TAG, "📶 " + (enabled ? "✅ WiFi enable command sent successfully" : "❌ Failed to send WiFi enable command"));
                
                notificationManager.showDebugNotification(
                        "WiFi Enabling", 
                        "Attempting to enable WiFi");
            } else {
                Log.d(TAG, "📶 ✅ WiFi already enabled, no action needed");
            }
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error enabling WiFi", e);
        }
    }
    
    @Override
    public void disableWifi() {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 DISABLE WIFI");
        Log.d(TAG, "📶 =========================================");
        
        // Use K900 API to disable WiFi
        try {
            Log.d(TAG, "📶 🔍 Checking current WiFi state...");
            boolean currentlyEnabled = wifiManager.isWifiEnabled();
            Log.d(TAG, "📶 📡 WiFi currently enabled: " + currentlyEnabled);
            
            if (currentlyEnabled) {
                Log.d(TAG, "📶 🔧 Disabling WiFi via WifiManager...");
                boolean disabled = wifiManager.setWifiEnabled(false);
                Log.d(TAG, "📶 " + (disabled ? "✅ WiFi disable command sent successfully" : "❌ Failed to send WiFi disable command"));
                
                notificationManager.showDebugNotification(
                        "WiFi Disabling", 
                        "Disabling WiFi");
            } else {
                Log.d(TAG, "📶 ✅ WiFi already disabled, no action needed");
            }
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error disabling WiFi", e);
        }
    }

    public static void enableScan5GWifi(Context context, boolean bEnable)
    {
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.putExtra("command", "enable_scan_5g_wifi");
        nn.putExtra("enable", bEnable);
        context.sendBroadcast(nn);
    }
    

    @Override
    public void startHotspot() {
        Log.d(TAG, "🔥 =========================================");
        Log.d(TAG, "🔥 START K900 HOTSPOT (INTENT MODE)");
        Log.d(TAG, "🔥 =========================================");

        try {
            // IMPORTANT: Hotspot requires WiFi radio to be enabled (even if not connected)
            // Check and enable WiFi if needed before starting hotspot
            if (!wifiManager.isWifiEnabled()) {
                Log.d(TAG, "🔥 ⚠️ WiFi radio is OFF - enabling WiFi radio for hotspot...");
                boolean enabled = wifiManager.setWifiEnabled(true);
                if (enabled) {
                    Log.d(TAG, "🔥 ✅ WiFi radio enabled successfully");
                    // Give WiFi a moment to initialize
                    try {
                        Thread.sleep(500);
                    } catch (InterruptedException e) {
                        Log.w(TAG, "Sleep interrupted while waiting for WiFi radio", e);
                    }
                } else {
                    Log.e(TAG, "🔥 ❌ Failed to enable WiFi radio - hotspot may not start");
                }
            } else {
                Log.d(TAG, "🔥 ✅ WiFi radio already enabled");
            }

            // Send K900 hotspot enable intent
            Log.d(TAG, "🔥 📡 Sending K900 hotspot enable intent...");
            Intent intent = new Intent();
            intent.setAction("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "ap_start");
            intent.putExtra("enable", true);
            
            context.sendBroadcast(intent);
            Log.d(TAG, "🔥 ✅ K900 hotspot enable intent sent");

            // Try to read SSID from Settings.Global
            // Note: There may be a race condition where the SSID isn't immediately available
            // after sending the enable intent. We'll retry with delays if needed.
            tryReadHotspotSSID(0);
            
            Log.i(TAG, "🔥 ✅ K900 hotspot start initiated");
        } catch (Exception e) {
            Log.e(TAG, "🔥 💥 Error starting K900 hotspot", e);
            clearHotspotState();
            notificationManager.showDebugNotification(
                    "Hotspot Error", 
                    "Failed to start: " + e.getMessage());
        }
    }

    /**
     * Attempts to read the K900 hotspot SSID from Settings.Global with retries
     * This handles the race condition where the SSID may not be immediately available
     * after sending the hotspot enable intent
     *
     * @param attemptNumber Current attempt number (0-based)
     */
    private void tryReadHotspotSSID(int attemptNumber) {
        final int MAX_ATTEMPTS = 5;
        final int[] RETRY_DELAYS_MS = {0, 200, 500, 1000, 2000}; // Progressive backoff

        try {
            String ssid = Settings.Global.getString(context.getContentResolver(), "xy_ssid");

            if (ssid != null && !ssid.isEmpty()) {
                // Success! Update state and notify
                Log.d(TAG, "🔥 ✅ Got K900 hotspot SSID from Settings.Global: " + ssid +
                          " (attempt " + (attemptNumber + 1) + "/" + MAX_ATTEMPTS + ")");

                // Clear pending retry since we succeeded
                pendingSsidRetryRunnable = null;

                updateHotspotState(true, ssid, K900_HOTSPOT_PASSWORD);
                notifyHotspotStateChanged(true);

                notificationManager.showHotspotStateNotification(true);
                notificationManager.showDebugNotification(
                        "K900 Hotspot Active",
                        ssid + " | " + K900_HOTSPOT_PASSWORD);

                Log.i(TAG, "🔥 ✅ K900 hotspot active: " + ssid);
            } else {
                // SSID not available yet
                if (attemptNumber < MAX_ATTEMPTS - 1) {
                    // Retry with delay
                    int nextAttempt = attemptNumber + 1;
                    int delayMs = RETRY_DELAYS_MS[nextAttempt];

                    Log.w(TAG, "🔥 ⚠️ SSID not available yet (attempt " + (attemptNumber + 1) +
                               "/" + MAX_ATTEMPTS + "), retrying in " + delayMs + "ms...");

                    // Cancel any previous pending retry
                    cancelPendingSsidRetries();

                    // Schedule new retry and track it
                    pendingSsidRetryRunnable = () -> tryReadHotspotSSID(nextAttempt);
                    ssidRetryHandler.postDelayed(pendingSsidRetryRunnable, delayMs);
                } else {
                    // Max attempts reached - disable hotspot and notify phone of failure
                    Log.e(TAG, "🔥 ❌ Failed to read K900 SSID after " + MAX_ATTEMPTS + " attempts - disabling hotspot");

                    // Clear pending retry
                    pendingSsidRetryRunnable = null;

                    // Send disable intent to K900 to clean up
                    try {
                        Intent disableIntent = new Intent();
                        disableIntent.setAction("com.xy.xsetting.action");
                        disableIntent.setPackage("com.android.systemui");
                        disableIntent.putExtra("cmd", "ap_start");
                        disableIntent.putExtra("enable", false);
                        context.sendBroadcast(disableIntent);
                        Log.d(TAG, "🔥 📡 Sent disable intent to clean up failed hotspot");
                    } catch (Exception ex) {
                        Log.e(TAG, "🔥 💥 Error sending disable intent", ex);
                    }

                    // Clear local hotspot state
                    clearHotspotState();

                    // Notify listeners that hotspot is disabled
                    notifyHotspotStateChanged(false);

                    // Also send specific error message
                    String errorMessage = "Failed to read hotspot SSID after " + MAX_ATTEMPTS + " attempts";
                    notifyHotspotError(errorMessage);

                    notificationManager.showDebugNotification(
                            "Hotspot Failed",
                            errorMessage);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "🔥 💥 Error reading K900 SSID from Settings.Global (attempt " +
                       (attemptNumber + 1) + "): " + e.getMessage(), e);

            // On exception, retry if attempts remaining
            if (attemptNumber < MAX_ATTEMPTS - 1) {
                int nextAttempt = attemptNumber + 1;
                int delayMs = RETRY_DELAYS_MS[nextAttempt];

                Log.w(TAG, "🔥 ⚠️ Retrying in " + delayMs + "ms...");

                // Cancel any previous pending retry
                cancelPendingSsidRetries();

                // Schedule new retry and track it
                pendingSsidRetryRunnable = () -> tryReadHotspotSSID(nextAttempt);
                ssidRetryHandler.postDelayed(pendingSsidRetryRunnable, delayMs);
            } else {
                // Max attempts reached due to exceptions - disable hotspot and notify phone of failure
                Log.e(TAG, "🔥 ❌ Failed to read SSID after " + MAX_ATTEMPTS + " attempts due to errors - disabling hotspot");

                // Clear pending retry
                pendingSsidRetryRunnable = null;

                // Send disable intent to K900 to clean up
                try {
                    Intent disableIntent = new Intent();
                    disableIntent.setAction("com.xy.xsetting.action");
                    disableIntent.setPackage("com.android.systemui");
                    disableIntent.putExtra("cmd", "ap_start");
                    disableIntent.putExtra("enable", false);
                    context.sendBroadcast(disableIntent);
                    Log.d(TAG, "🔥 📡 Sent disable intent to clean up failed hotspot");
                } catch (Exception ex) {
                    Log.e(TAG, "🔥 💥 Error sending disable intent", ex);
                }

                // Clear local hotspot state
                clearHotspotState();

                // Notify listeners that hotspot is disabled
                notifyHotspotStateChanged(false);

                // Also send specific error message
                String errorMessage = "Failed to read hotspot SSID: " + e.getMessage();
                notifyHotspotError(errorMessage);

                notificationManager.showDebugNotification(
                        "Hotspot Error",
                        errorMessage);
            }
        }
    }


    @Override
    protected void refreshHotspotCredentials() {
        // K900 specific: Read SSID from Settings.Global
        try {
            String ssid = Settings.Global.getString(context.getContentResolver(), "xy_ssid");
            
            if (ssid != null && !ssid.isEmpty()) {
                Log.d(TAG, "🔥 ✅ Refreshed K900 hotspot SSID from Settings.Global: " + ssid);
                updateHotspotState(true, ssid, K900_HOTSPOT_PASSWORD);
                notifyHotspotStateChanged(true);
                
                notificationManager.showHotspotStateNotification(true);
                notificationManager.showDebugNotification(
                        "K900 Hotspot Active", 
                        ssid + " | " + K900_HOTSPOT_PASSWORD);
            } else {
                Log.e(TAG, "🔥 ❌ Failed to refresh K900 SSID from Settings.Global");
                clearHotspotState();
                notifyHotspotStateChanged(false);
            }
        } catch (Exception e) {
            Log.e(TAG, "🔥 💥 Error refreshing K900 SSID from Settings.Global", e);
            clearHotspotState();
            notifyHotspotStateChanged(false);
        }
    }

    /**
     * Cancels any pending SSID retry attempts
     * Called when hotspot is stopped to prevent stale callbacks from firing
     */
    private void cancelPendingSsidRetries() {
        if (pendingSsidRetryRunnable != null) {
            Log.d(TAG, "🔥 ⛔ Cancelling pending SSID retry");
            ssidRetryHandler.removeCallbacks(pendingSsidRetryRunnable);
            pendingSsidRetryRunnable = null;
        }
    }

    @Override
    public void stopHotspot() {
        Log.d(TAG, "🔥 =========================================");
        Log.d(TAG, "🔥 STOP K900 HOTSPOT (INTENT MODE)");
        Log.d(TAG, "🔥 =========================================");
        
        try {
            // Send K900 hotspot disable intent
            Log.d(TAG, "🔥 📡 Sending K900 hotspot disable intent...");
            Intent intent = new Intent();
            intent.setAction("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "ap_start");
            intent.putExtra("enable", false);
            
            context.sendBroadcast(intent);
            
            // Clear hotspot state immediately
            clearHotspotState();

            // Cancel any pending SSID retry attempts
            cancelPendingSsidRetries();

            Log.d(TAG, "🔥 ✅ K900 hotspot disable intent sent");
            notificationManager.showHotspotStateNotification(false);
            notifyHotspotStateChanged(false);
            
            Log.i(TAG, "🔥 ✅ K900 hotspot disabled");
        } catch (Exception e) {
            Log.e(TAG, "🔥 💥 Error stopping K900 hotspot", e);
            clearHotspotState();
            notificationManager.showDebugNotification(
                    "Hotspot Error", 
                    "Failed to stop: " + e.getMessage());
        }
    }
    
    @Override
    public void connectToWifi(String ssid, String password) {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 CONNECT TO WIFI");
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 SSID: " + ssid);
        Log.d(TAG, "📶 Password: " + (password != null ? "***" : "null"));

        try {
            // Use SysControl with credential refresh to fix K900 password caching bug.
            // The K900 SystemUI caches WiFi credentials and won't update them on reconnect.
            // connectToWifiWithRefresh works around this by: connect -> disconnect -> reconnect
            Log.d(TAG, "📶 📡 Connecting to WiFi via SysControl (with credential refresh)...");
            SysControl.connectToWifiWithRefresh(context, ssid, password);

            Log.d(TAG, "📶 ✅ WiFi connect command sent successfully");
            notificationManager.showDebugNotification(
                    "WiFi Connection",
                    "Attempting to connect to: " + ssid);

            Log.i(TAG, "📶 ✅ WiFi connect command sent for SSID: " + ssid);
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error connecting to WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error",
                    "Failed to connect to WiFi: " + e.getMessage());
        }
    }

    @Override
    public void disconnectFromWifi() {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 DISCONNECT FROM WIFI");
        Log.d(TAG, "📶 =========================================");
        
        try {
            // Use SysControl for K900 WiFi disconnection
            Log.d(TAG, "📶 📡 Disconnecting from WiFi via SysControl...");
            SysControl.disconnectFromWifi(context);
            
            Log.d(TAG, "📶 ✅ WiFi disconnect command sent successfully");
            notificationManager.showDebugNotification(
                    "WiFi Disconnection", 
                    "Disconnecting from current network");
            
            Log.i(TAG, "📶 ✅ WiFi disconnect command sent");
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error disconnecting from WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error",
                    "Failed to disconnect from WiFi: " + e.getMessage());
        }
    }

    @Override
    public void forgetWifiNetwork(String ssid) {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 FORGET WIFI NETWORK: " + ssid);
        Log.d(TAG, "📶 =========================================");

        try {
            // Use SysControl to forget the network (disconnectFromWifi with SSID removes it)
            Log.d(TAG, "📶 📡 Forgetting WiFi network via SysControl...");
            SysControl.disconnectFromWifi(context, ssid);

            Log.d(TAG, "📶 ✅ WiFi forget command sent successfully");
            notificationManager.showDebugNotification(
                    "WiFi Network Forgotten",
                    "Removed saved network: " + ssid);

            Log.i(TAG, "📶 ✅ WiFi forget command sent for: " + ssid);
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error forgetting WiFi network", e);
            notificationManager.showDebugNotification(
                    "WiFi Error",
                    "Failed to forget WiFi network: " + e.getMessage());
        }
    }

    private void promptConnectToWifi(String ssid, String password) {
        // K900-specific method to prompt user for WiFi connection
        try {
            Intent intent = new Intent(K900_BROADCAST_ACTION);
            intent.putExtra("command", "prompt_wifi_connection");
            intent.putExtra("ssid", ssid);
            intent.putExtra("password", password);
            context.sendBroadcast(intent);
            
            Log.i(TAG, "K900 WiFi connection prompt sent");
        } catch (Exception e) {
            Log.e(TAG, "Error prompting WiFi connection", e);
        }
    }
    
    private void registerWifiStateReceiver() {
        wifiStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action != null) {
                    switch (action) {
                        case WifiManager.NETWORK_STATE_CHANGED_ACTION:
                            // For K900, delay the WiFi state check to let connection stabilize
                            // This prevents rapid CONNECTED/DISCONNECTED flapping
                            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                                boolean isConnected = isConnectedToWifi();
                                notificationManager.showWifiStateNotification(isConnected);
                                notifyWifiStateChanged(isConnected);
                            }, 500); // Wait 500ms for connection to stabilize
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
    }
    
    @Override
    public List<String> getConfiguredWifiNetworks() {
        Log.d(TAG, "Getting configured WiFi networks from K900");
        List<String> networks = new ArrayList<>();
        
        // Use K900-specific broadcast to get configured networks
        try {
            Intent intent = new Intent(K900_BROADCAST_ACTION);
            intent.putExtra("command", "get_configured_networks");
            context.sendBroadcast(intent);
            
            // For now, return empty list as K900 response handling is complex
            // In a real implementation, you would register a receiver for the response
            Log.d(TAG, "K900 configured networks request sent");
        } catch (Exception e) {
            Log.e(TAG, "Error getting configured networks from K900", e);
        }
        
        return networks;
    }
    
    @Override
    public List<String> scanWifiNetworks() {
        // Send K900-specific WiFi enable broadcast first
        sendEnableWifiBroadcast();
        
        // Then use standard Android scanning from BaseNetworkManager
        return super.scanWifiNetworks();
    }
    
    @Override
    public void scanWifiNetworks(IWifiScanCallback callback) {
        // Send K900-specific WiFi enable broadcast first
        sendEnableWifiBroadcast();
        
        // Then use standard Android streaming scanning from BaseNetworkManager
        super.scanWifiNetworks(callback);
    }

    private void sendEnableWifiBroadcast() {
        try {
            Intent intent = new Intent(K900_BROADCAST_ACTION);
            intent.setPackage(K900_SYSTEM_UI_PACKAGE);
            intent.putExtra("cmd", "setwifi");
            intent.putExtra("enable", true);
            context.sendBroadcast(intent);
            Log.d(TAG, "Sent K900 WiFi enable broadcast");
        } catch (Exception e) {
            Log.e(TAG, "Error sending K900 enable WiFi broadcast", e);
        }
    }
    

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down K900NetworkManager");
        unregisterWifiStateReceiver();
        super.shutdown();
    }
} 