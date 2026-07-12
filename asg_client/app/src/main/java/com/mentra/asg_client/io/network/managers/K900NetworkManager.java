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
import com.mentra.asg_client.io.network.utils.WifiSecurityChooser;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import java.util.ArrayList;
import java.util.List;

/**
 * Implementation of INetworkManager for K900 devices. Assumes K900 is running as a system app on
 * Android 11+. Uses standard Android APIs with reflection for hotspot control.
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
    private final boolean isSystemApp;

    // Hotspot readiness watch. The ap_start intent returns immediately and the SSID in
    // Settings.Global persists across sessions, so neither proves the AP is up. The watch
    // polls the real signals (framework AP state + gateway IP on the AP interface + SSID)
    // and only then reports the hotspot as enabled — the phone treats that message as
    // "safe to join", so sending it early causes iOS "Unable to Join" failures.
    private static final int HOTSPOT_READINESS_POLL_MS = 200;
    private static final int HOTSPOT_READINESS_TIMEOUT_MS = 12000;
    private final Handler hotspotReadinessHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingHotspotReadinessRunnable = null;
    private long hotspotReadinessStartMs = 0;
    private long hotspotReadinessDeadlineMs = 0;

    // Watch ticks run on the main looper but stopHotspot can run on a command-processing
    // thread. The lock + stop flag prevent a mid-flight tick from reporting "enabled"
    // after the user disabled the AP (removeCallbacks alone can't cancel a running tick).
    private final Object hotspotWatchLock = new Object();
    private boolean hotspotStopRequested = false;

    /**
     * Create a new K900NetworkManager
     *
     * @param context The application context
     */
    public K900NetworkManager(Context context) {
        super(context);
        this.wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        this.notificationManager = new DebugNotificationManager(context);
        this.isSystemApp = checkIsSystemApp(context);

        Log.i(TAG, "📶 K900NetworkManager initialized, isSystemApp=" + isSystemApp);
        notificationManager.showDebugNotification(
                "K900 Network Manager",
                "Using " + (isSystemApp ? "native WifiManager" : "K900-specific") + " WiFi APIs");

        enableScan5GWifi(context, true);
    }

    private static boolean checkIsSystemApp(Context context) {
        try {
            android.content.pm.ApplicationInfo appInfo =
                    context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
            return (appInfo.flags
                            & (android.content.pm.ApplicationInfo.FLAG_SYSTEM
                                    | android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))
                    != 0;
        } catch (Exception e) {
            Log.w(TAG, "Could not determine system app status", e);
            return false;
        }
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
                Log.d(
                        TAG,
                        "📶 "
                                + (enabled
                                        ? "✅ WiFi enable command sent successfully"
                                        : "❌ Failed to send WiFi enable command"));

                notificationManager.showDebugNotification(
                        "WiFi Enabling", "Attempting to enable WiFi");
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
                Log.d(
                        TAG,
                        "📶 "
                                + (disabled
                                        ? "✅ WiFi disable command sent successfully"
                                        : "❌ Failed to send WiFi disable command"));

                notificationManager.showDebugNotification("WiFi Disabling", "Disabling WiFi");
            } else {
                Log.d(TAG, "📶 ✅ WiFi already disabled, no action needed");
            }
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error disabling WiFi", e);
        }
    }

    public static void enableScan5GWifi(Context context, boolean bEnable) {
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

            // Do NOT report the hotspot as enabled yet — wait until the AP is actually
            // accepting clients. The watch notifies listeners (and thus the phone) only
            // once AP state, gateway IP, and SSID are all confirmed.
            beginHotspotReadinessWatch();

            Log.i(TAG, "🔥 ✅ K900 hotspot start initiated (awaiting readiness)");
        } catch (Exception e) {
            Log.e(TAG, "🔥 💥 Error starting K900 hotspot", e);
            clearHotspotState();
            notificationManager.showDebugNotification(
                    "Hotspot Error", "Failed to start: " + e.getMessage());
        }
    }

    /**
     * Starts (or restarts nothing if already running) the hotspot readiness watch. The watch
     * polls until the framework reports the AP enabled, the AP interface holds the gateway IP,
     * and the SSID is readable — only then are listeners told the hotspot is enabled. Measured
     * on-device, readiness lands ~0.4-1.0s after the ap_start intent; the timeout is a
     * generous multiple of that.
     */
    private void beginHotspotReadinessWatch() {
        synchronized (hotspotWatchLock) {
            hotspotStopRequested = false;
            if (pendingHotspotReadinessRunnable != null) {
                Log.d(TAG, "🔥 ⏳ Hotspot readiness watch already running");
                return;
            }
            hotspotReadinessStartMs = System.currentTimeMillis();
            hotspotReadinessDeadlineMs = hotspotReadinessStartMs + HOTSPOT_READINESS_TIMEOUT_MS;
        }
        Log.d(TAG, "🔥 ⏳ Watching for hotspot readiness (AP state + gateway IP + SSID)...");
        checkHotspotReadiness();
    }

    /** One tick of the readiness watch; reschedules itself until ready, timeout, or cancel. */
    private void checkHotspotReadiness() {
        synchronized (hotspotWatchLock) {
            pendingHotspotReadinessRunnable = null;
            if (hotspotStopRequested) {
                Log.d(TAG, "🔥 ⛔ Hotspot stopped - abandoning readiness check");
                return;
            }
            checkHotspotReadinessLocked();
        }
    }

    private void checkHotspotReadinessLocked() {
        // Gate on the direct signal: the tethering state machine assigns the gateway IP to
        // the AP interface only after hostapd reports AP-ENABLED, so gatewayUp implies the
        // AP accepts clients. The framework AP state (reflection, hidden API) is logged as
        // corroboration but not required — it is unavailable to non-system dev builds.
        boolean apEnabled = isWifiTetheringActive();
        boolean gatewayUp = hasHotspotGatewayIp();
        String ssid = null;
        try {
            ssid = Settings.Global.getString(context.getContentResolver(), "xy_ssid");
        } catch (Exception e) {
            Log.w(TAG, "🔥 ⚠️ Error reading xy_ssid during readiness check", e);
        }
        boolean ssidReady = ssid != null && !ssid.isEmpty();

        if (gatewayUp && ssidReady) {
            long elapsedMs = System.currentTimeMillis() - hotspotReadinessStartMs;
            Log.i(
                    TAG,
                    "🔥 ✅ K900 hotspot READY after "
                            + elapsedMs
                            + "ms (apEnabled="
                            + apEnabled
                            + "): "
                            + ssid);

            updateHotspotState(true, ssid, K900_HOTSPOT_PASSWORD);
            notifyHotspotStateChanged(true);

            notificationManager.showHotspotStateNotification(true);
            notificationManager.showDebugNotification(
                    "K900 Hotspot Active", ssid + " | " + K900_HOTSPOT_PASSWORD);
            return;
        }

        if (System.currentTimeMillis() >= hotspotReadinessDeadlineMs) {
            failHotspotStartup(
                    "Hotspot did not become ready within "
                            + HOTSPOT_READINESS_TIMEOUT_MS
                            + "ms (apEnabled="
                            + apEnabled
                            + ", gatewayUp="
                            + gatewayUp
                            + ", ssidReady="
                            + ssidReady
                            + ")");
            return;
        }

        Log.d(
                TAG,
                "🔥 ⏳ Hotspot not ready yet (apEnabled="
                        + apEnabled
                        + ", gatewayUp="
                        + gatewayUp
                        + ", ssidReady="
                        + ssidReady
                        + "), rechecking in "
                        + HOTSPOT_READINESS_POLL_MS
                        + "ms");
        pendingHotspotReadinessRunnable = this::checkHotspotReadiness;
        hotspotReadinessHandler.postDelayed(
                pendingHotspotReadinessRunnable, HOTSPOT_READINESS_POLL_MS);
    }

    /** True when any up interface holds the hotspot gateway IP (192.168.43.1). */
    private boolean hasHotspotGatewayIp() {
        try {
            String gatewayIp = getHotspotGatewayIp();
            java.util.Enumeration<java.net.NetworkInterface> ifaces =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                java.net.NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp()) {
                    continue;
                }
                java.util.Enumeration<java.net.InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    if (gatewayIp.equals(addrs.nextElement().getHostAddress())) {
                        return true;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "🔥 ⚠️ Error checking hotspot gateway interface", e);
        }
        return false;
    }

    /** Cleans up a hotspot start that never became ready: disable AP, clear state, notify. */
    private void failHotspotStartup(String errorMessage) {
        Log.e(TAG, "🔥 ❌ " + errorMessage + " - disabling hotspot");

        // This is a stop: the disable intent below produces its own teardown echo on the
        // tethering broadcast, which must not restart the watch off lingering ssid/gateway.
        // Runs under hotspotWatchLock (called from the watch tick).
        hotspotStopRequested = true;

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

        clearHotspotState();
        notifyHotspotStateChanged(false);
        notifyHotspotError(errorMessage);
        notificationManager.showDebugNotification("Hotspot Failed", errorMessage);
    }

    @Override
    protected void refreshHotspotCredentials() {
        // Called from the tethering-state broadcast when the framework starts bringing the
        // AP up (including hotspots enabled outside asg_client). That broadcast can precede
        // the AP interface holding its gateway IP, so route through the readiness watch —
        // listeners only hear "enabled" once clients can actually join.
        synchronized (hotspotWatchLock) {
            if (hotspotStopRequested) {
                // Teardown echo: after a deliberate stop the framework AP can still look
                // active for a beat, and this broadcast fires while xy_ssid and the gateway
                // IP may linger. Restarting the watch here would clear the stop flag and
                // re-announce "enabled" right after the user disabled the AP. Only a real
                // startHotspot() re-arms the watch.
                Log.d(TAG, "🔥 ⛔ Ignoring tethering-active echo after hotspot stop");
                return;
            }
        }
        beginHotspotReadinessWatch();
    }

    /**
     * Cancels any pending hotspot readiness checks. Called when the hotspot is stopped to
     * prevent stale callbacks from firing.
     */
    private void cancelHotspotReadinessWatch() {
        if (pendingHotspotReadinessRunnable != null) {
            Log.d(TAG, "🔥 ⛔ Cancelling hotspot readiness watch");
            hotspotReadinessHandler.removeCallbacks(pendingHotspotReadinessRunnable);
            pendingHotspotReadinessRunnable = null;
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

            // Cancel any pending readiness checks. The flag also stops a tick that is
            // already executing on the main looper from reporting a late "enabled".
            synchronized (hotspotWatchLock) {
                hotspotStopRequested = true;
                cancelHotspotReadinessWatch();
            }

            Log.d(TAG, "🔥 ✅ K900 hotspot disable intent sent");
            notificationManager.showHotspotStateNotification(false);
            notifyHotspotStateChanged(false);

            Log.i(TAG, "🔥 ✅ K900 hotspot disabled");
        } catch (Exception e) {
            Log.e(TAG, "🔥 💥 Error stopping K900 hotspot", e);
            clearHotspotState();
            notificationManager.showDebugNotification(
                    "Hotspot Error", "Failed to stop: " + e.getMessage());
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
            if (isSystemApp) {
                connectToWifiNative(ssid, password);
            } else {
                Log.d(TAG, "📶 📡 Connecting to WiFi via SysControl (with credential refresh)...");
                SystemControllerFactory.get(context)
                        .connectToWifiWithCredentialRefresh(ssid, password);
                Log.i(TAG, "📶 ✅ WiFi connect command sent for SSID: " + ssid);
            }
            notificationManager.showDebugNotification("WiFi Connection", "Connecting to: " + ssid);
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error connecting to WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Failed to connect: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void connectToWifiNative(String ssid, String password) {
        Log.d(TAG, "📶 📡 Connecting via native WifiManager (system app)...");

        if (wifiManager == null) {
            Log.e(TAG, "📶 💥 WifiManager is null");
            return;
        }

        // Remove any existing config for this SSID (ensures fresh credentials)
        String quotedSsid = "\"" + ssid + "\"";
        List<android.net.wifi.WifiConfiguration> existingConfigs =
                wifiManager.getConfiguredNetworks();
        if (existingConfigs != null) {
            for (android.net.wifi.WifiConfiguration existing : existingConfigs) {
                if (existing.SSID != null && existing.SSID.equals(quotedSsid)) {
                    Log.d(
                            TAG,
                            "📶 Removing existing config for: "
                                    + ssid
                                    + " (netId="
                                    + existing.networkId
                                    + ")");
                    wifiManager.removeNetwork(existing.networkId);
                }
            }
        }

        // Create new WiFi config. Security is derived from the AP's advertised capabilities
        // (the glasses scanned this network moments ago in the provisioning flow) rather
        // than inferred from password presence — see WifiSecurityChooser.
        android.net.wifi.WifiConfiguration config = new android.net.wifi.WifiConfiguration();
        config.SSID = quotedSsid;
        String capabilities = findScanCapabilitiesForSsid(ssid);
        WifiSecurityChooser.Security security = WifiSecurityChooser.choose(password, capabilities);
        Log.i(
                TAG,
                "📶 Configuring "
                        + security
                        + " for "
                        + ssid
                        + " (scan caps="
                        + capabilities
                        + ")");
        switch (security) {
            case OPEN:
                config.allowedKeyManagement.set(android.net.wifi.WifiConfiguration.KeyMgmt.NONE);
                break;
            case SAE:
                // setSecurityParams(SAE) sets SAE key management + required PMF.
                config.setSecurityParams(android.net.wifi.WifiConfiguration.SECURITY_TYPE_SAE);
                config.preSharedKey = "\"" + password + "\"";
                break;
            case PSK:
            default:
                config.setSecurityParams(android.net.wifi.WifiConfiguration.SECURITY_TYPE_PSK);
                config.preSharedKey = "\"" + password + "\"";
                break;
        }

        int netId = wifiManager.addNetwork(config);
        if (netId == -1) {
            Log.e(TAG, "📶 💥 addNetwork failed for: " + ssid);
            notificationManager.showDebugNotification(
                    "WiFi Error", "addNetwork failed for: " + ssid);
            return;
        }

        wifiManager.disconnect();
        boolean enabled = wifiManager.enableNetwork(netId, true);
        wifiManager.reconnect();

        Log.i(
                TAG,
                "📶 ✅ WiFi connect initiated via WifiManager: "
                        + ssid
                        + " (enabled="
                        + enabled
                        + ", netId="
                        + netId
                        + ")");
    }

    /**
     * Latest scan capabilities string for an SSID (strongest BSS wins), or null when the
     * SSID is not in current scan results.
     */
    private String findScanCapabilitiesForSsid(String ssid) {
        try {
            List<android.net.wifi.ScanResult> results = wifiManager.getScanResults();
            if (results == null) {
                return null;
            }
            String best = null;
            int bestLevel = Integer.MIN_VALUE;
            for (android.net.wifi.ScanResult result : results) {
                if (ssid.equals(result.SSID) && result.level > bestLevel) {
                    bestLevel = result.level;
                    best = result.capabilities;
                }
            }
            return best;
        } catch (Exception e) {
            Log.w(TAG, "📶 ⚠️ Could not read scan results for security detection", e);
            return null;
        }
    }

    @Override
    public void disconnectFromWifi() {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 DISCONNECT FROM WIFI");
        Log.d(TAG, "📶 =========================================");

        try {
            if (isSystemApp && wifiManager != null) {
                wifiManager.disconnect();
                Log.i(TAG, "📶 ✅ WiFi disconnected via WifiManager");
            } else {
                Log.d(TAG, "📶 📡 Disconnecting from WiFi via SysControl...");
                SystemControllerFactory.get(context).disconnectFromWifi();
                Log.i(TAG, "📶 ✅ WiFi disconnect command sent via SysControl");
            }
            notificationManager.showDebugNotification(
                    "WiFi Disconnection", "Disconnecting from current network");
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error disconnecting from WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Failed to disconnect: " + e.getMessage());
        }
    }

    @Override
    public void forgetWifiNetwork(String ssid) {
        Log.d(TAG, "📶 =========================================");
        Log.d(TAG, "📶 FORGET WIFI NETWORK: " + ssid);
        Log.d(TAG, "📶 =========================================");

        try {
            // Use SysControl to forget - the SmartXY broadcast reliably removes saved networks
            Log.d(TAG, "📶 📡 Forgetting WiFi network via SysControl...");
            SystemControllerFactory.get(context).disconnectFromWifi(ssid);

            Log.i(TAG, "📶 ✅ WiFi forget command sent for: " + ssid);
            notificationManager.showDebugNotification("WiFi Network Forgotten", "Removed: " + ssid);
        } catch (Exception e) {
            Log.e(TAG, "📶 💥 Error forgetting WiFi network", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Failed to forget: " + e.getMessage());
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
        wifiStateReceiver =
                new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        String action = intent.getAction();
                        if (action != null) {
                            switch (action) {
                                case WifiManager.NETWORK_STATE_CHANGED_ACTION:
                                    // For K900, delay the WiFi state check to let connection
                                    // stabilize
                                    // This prevents rapid CONNECTED/DISCONNECTED flapping
                                    new Handler(Looper.getMainLooper())
                                            .postDelayed(
                                                    () -> {
                                                        boolean isConnected = isConnectedToWifi();
                                                        notificationManager
                                                                .showWifiStateNotification(
                                                                        isConnected);
                                                        notifyWifiStateChanged(isConnected);
                                                    },
                                                    500); // Wait 500ms for connection to stabilize
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
