package com.mentra.asg_client.io.network.managers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.network.core.BaseNetworkManager;
import com.mentra.asg_client.io.network.utils.WifiSecurityChooser;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import java.util.ArrayList;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;
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

    private final WifiManager wifiManager;
    private final DebugNotificationManager notificationManager;
    private BroadcastReceiver wifiStateReceiver;
    private final boolean isSystemApp;

    private final Handler mHotspotHandler = new Handler(Looper.getMainLooper());
    private final Object mHotspotLock = new Object();
    private Runnable mPendingHotspotReadiness;
    private boolean mHotspotStarting;
    private int mHotspotGeneration;
    private long mHotspotReadinessDeadlineMs;

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

        adoptExistingVendorHotspot();

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

    /**
     * SystemUI owns the K900 access point, so it can outlive an ASG APK replacement. Rebuild the
     * ASG-side state from the real interface and credentials without sending another ap_start.
     */
    private void adoptExistingVendorHotspot() {
        String gatewayIp = findLocalHotspotGatewayIp();
        String ssid = readVendorHotspotSetting(AsgConstants.K900_VENDOR_HOTSPOT_SSID_SETTING);
        String password =
                readVendorHotspotSetting(AsgConstants.K900_VENDOR_HOTSPOT_PASSWORD_SETTING);
        boolean hotspotPresent = !gatewayIp.isEmpty() && !ssid.isEmpty() && !password.isEmpty();

        if (hotspotPresent) {
            onHotspotStarted(ssid, password, gatewayIp);
            notificationManager.showHotspotStateNotification(true);
            Log.i(
                    TAG,
                    "🔥 Adopted existing K900 vendor hotspot: "
                            + ssid
                            + " gateway="
                            + gatewayIp);
        }
    }

    @Override
    protected boolean shouldMonitorTetheringBroadcasts() {
        // The K900 vendor intent owns readiness. A framework tethering echo can arrive before
        // ap0 and the SmartXY credentials are ready, so do not publish from that broadcast.
        return false;
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
        final int generation;
        synchronized (mHotspotLock) {
            if (isHotspotEnabled || mHotspotStarting) {
                Log.d(TAG, "🔥 K900 vendor hotspot is already active or starting");
                return;
            }
            mHotspotStarting = true;
            generation = ++mHotspotGeneration;
            mHotspotReadinessDeadlineMs =
                    SystemClock.elapsedRealtime()
                            + AsgConstants.LOCAL_HOTSPOT_READINESS_TIMEOUT_MS;
        }

        requestVendorHotspot(generation);
    }

    private void requestVendorHotspot(int generation) {
        synchronized (mHotspotLock) {
            if (generation != mHotspotGeneration || !mHotspotStarting) {
                Log.d(TAG, "🔥 Ignoring hotspot request from a stale generation");
                return;
            }
        }

        try {
            if (wifiManager == null) {
                failVendorHotspotStartup(generation, "WifiManager is unavailable");
                return;
            }
            if (!wifiManager.isWifiEnabled()) {
                Log.i(TAG, "🔥 WiFi radio is off; enabling it before K900 hotspot startup");
                if (!wifiManager.setWifiEnabled(true)) {
                    failVendorHotspotStartup(generation, "Failed to enable WiFi for hotspot");
                    return;
                }
                mHotspotHandler.postDelayed(
                        () -> waitForWifiRadioThenRequestHotspot(generation),
                        AsgConstants.LOCAL_HOTSPOT_WIFI_ENABLE_DELAY_MS);
                return;
            }
            synchronized (mHotspotLock) {
                if (generation != mHotspotGeneration || !mHotspotStarting) {
                    Log.d(TAG, "🔥 Hotspot start was cancelled before the vendor command");
                    return;
                }
                sendVendorHotspotState(true);
            }
            checkVendorHotspotReadiness(generation);
            Log.i(TAG, "🔥 K900 vendor hotspot start requested");
        } catch (Exception e) {
            Log.e(TAG, "🔥 Error requesting K900 vendor hotspot", e);
            failVendorHotspotStartup(generation, "Failed to start: " + e.getMessage());
        }
    }

    private void waitForWifiRadioThenRequestHotspot(int generation) {
        synchronized (mHotspotLock) {
            if (generation != mHotspotGeneration || !mHotspotStarting) {
                Log.d(TAG, "🔥 WiFi readiness wait was cancelled");
                return;
            }
        }

        WifiRadioReadiness readiness =
                classifyWifiRadioReadiness(
                        wifiManager.isWifiEnabled(),
                        SystemClock.elapsedRealtime(),
                        mHotspotReadinessDeadlineMs);
        if (readiness == WifiRadioReadiness.READY) {
            Log.i(TAG, "🔥 WiFi radio is ready; requesting K900 hotspot");
            requestVendorHotspot(generation);
            return;
        }
        if (readiness == WifiRadioReadiness.TIMED_OUT) {
            failVendorHotspotStartup(generation, "WiFi did not become ready for hotspot");
            return;
        }

        mHotspotHandler.postDelayed(
                () -> waitForWifiRadioThenRequestHotspot(generation),
                AsgConstants.LOCAL_HOTSPOT_READINESS_POLL_MS);
    }

    enum WifiRadioReadiness {
        READY,
        WAITING,
        TIMED_OUT
    }

    static WifiRadioReadiness classifyWifiRadioReadiness(
            boolean wifiEnabled, long nowElapsedMs, long deadlineElapsedMs) {
        if (wifiEnabled) {
            return WifiRadioReadiness.READY;
        }
        return nowElapsedMs < deadlineElapsedMs
                ? WifiRadioReadiness.WAITING
                : WifiRadioReadiness.TIMED_OUT;
    }

    private void checkVendorHotspotReadiness(int generation) {
        String gatewayIp = findLocalHotspotGatewayIp();
        String ssid =
                readVendorHotspotSetting(AsgConstants.K900_VENDOR_HOTSPOT_SSID_SETTING);
        String password =
                readVendorHotspotSetting(AsgConstants.K900_VENDOR_HOTSPOT_PASSWORD_SETTING);
        synchronized (mHotspotLock) {
            mPendingHotspotReadiness = null;
            if (generation != mHotspotGeneration || !mHotspotStarting) {
                return;
            }
            if (!gatewayIp.isEmpty() && !ssid.isEmpty() && !password.isEmpty()) {
                mHotspotStarting = false;
                onHotspotStarted(ssid, password, gatewayIp);
                notificationManager.showHotspotStateNotification(true);
                notificationManager.showDebugNotification(
                        "Mentra Live Hotspot Active", ssid);
                Log.i(TAG, "🔥 K900 vendor hotspot ready: " + ssid + " gateway=" + gatewayIp);
                return;
            }
            if (SystemClock.elapsedRealtime() >= mHotspotReadinessDeadlineMs) {
                failVendorHotspotStartup(generation, "K900 vendor hotspot did not become ready");
                return;
            }
            mPendingHotspotReadiness = () -> checkVendorHotspotReadiness(generation);
            mHotspotHandler.postDelayed(
                    mPendingHotspotReadiness,
                    AsgConstants.LOCAL_HOTSPOT_READINESS_POLL_MS);
        }
    }

    private String readVendorHotspotSetting(String key) {
        try {
            String value = Settings.Global.getString(context.getContentResolver(), key);
            return value != null ? value : "";
        } catch (Exception e) {
            Log.w(TAG, "🔥 Could not read K900 hotspot setting " + key, e);
            return "";
        }
    }

    private String findLocalHotspotGatewayIp() {
        try {
            NetworkInterface interfaceInfo = NetworkInterface.getByName("ap0");
            String gatewayIp = findLocalHotspotGatewayIp(interfaceInfo, true);
            if (!gatewayIp.isEmpty()) {
                return gatewayIp;
            }

            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface candidate = interfaces.nextElement();
                if ("ap0".equals(candidate.getName())) {
                    continue;
                }
                gatewayIp = findLocalHotspotGatewayIp(candidate, false);
                if (!gatewayIp.isEmpty()) {
                    Log.i(TAG, "🔥 Local hotspot gateway found on " + candidate.getName());
                    return gatewayIp;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "🔥 Error reading local hotspot gateway", e);
        }
        return "";
    }

    private String findLocalHotspotGatewayIp(
            NetworkInterface interfaceInfo, boolean knownHotspotInterface) throws Exception {
        if (interfaceInfo == null || !interfaceInfo.isUp()) {
            return "";
        }
        Enumeration<InetAddress> addrs = interfaceInfo.getInetAddresses();
        while (addrs.hasMoreElements()) {
            InetAddress address = addrs.nextElement();
            if (address instanceof Inet4Address
                    && !address.isLoopbackAddress()
                    && (knownHotspotInterface
                            || isLocalHotspotAddress(
                                    interfaceInfo.getName(), address.getHostAddress()))) {
                return address.getHostAddress();
            }
        }
        return "";
    }

    static boolean isLocalHotspotAddress(String interfaceName, String address) {
        // Never mistake wlan0's station address for the hotspot. Alternate AP interface names
        // remain eligible, as does the gateway address used by current K900 firmware.
        return (interfaceName != null && interfaceName.startsWith("ap"))
                || AsgConstants.DEFAULT_HOTSPOT_GATEWAY_IP.equals(address);
    }

    private void failVendorHotspotStartup(int generation, String errorMessage) {
        Log.e(TAG, "🔥 " + errorMessage);
        synchronized (mHotspotLock) {
            if (generation != mHotspotGeneration) {
                Log.d(TAG, "🔥 Ignoring failure from a stale hotspot generation");
                return;
            }
            mHotspotStarting = false;
            mHotspotGeneration++;
            cancelHotspotReadinessLocked();
            try {
                sendVendorHotspotState(false);
            } catch (Exception e) {
                Log.e(TAG, "🔥 Error cleaning up failed K900 hotspot", e);
            }
        }
        onHotspotStopped();
        notifyHotspotError(errorMessage);
        notificationManager.showDebugNotification("Hotspot Failed", errorMessage);
    }

    private void cancelHotspotReadinessLocked() {
        mHotspotHandler.removeCallbacksAndMessages(null);
        mPendingHotspotReadiness = null;
    }

    private void sendVendorHotspotState(boolean enabled) {
        Intent intent = new Intent(K900_BROADCAST_ACTION);
        intent.setPackage(K900_SYSTEM_UI_PACKAGE);
        intent.putExtra("cmd", "ap_start");
        intent.putExtra("enable", enabled);
        context.sendBroadcast(intent);
    }

    @Override
    public void stopHotspot() {
        synchronized (mHotspotLock) {
            mHotspotStarting = false;
            mHotspotGeneration++;
            cancelHotspotReadinessLocked();
            try {
                sendVendorHotspotState(false);
            } catch (Exception e) {
                Log.e(TAG, "🔥 Error stopping K900 vendor hotspot", e);
            }
        }
        onHotspotStopped();
        notificationManager.showHotspotStateNotification(false);
        Log.i(TAG, "🔥 K900 vendor hotspot stop requested");
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
        OtaSessionManager otaSession = new OtaSessionManager(context);
        if (otaSession.shouldPreserveHotspotOnShutdown()) {
            synchronized (mHotspotLock) {
                mHotspotStarting = false;
                mHotspotGeneration++;
                cancelHotspotReadinessLocked();
            }
            // The vendor SystemUI process owns the AP. During an intentional OTA package
            // replacement, leave an active AP untouched so the new ASG process can reclaim it.
            // If no AP is active, this branch is a harmless no-op and the persisted OTA session
            // resumes over its existing network path.
            Log.i(TAG, "🔥 Preserving any active K900 hotspot during OTA APK replacement");
        } else {
            stopHotspot();
        }
        unregisterWifiStateReceiver();
        super.shutdown();
    }
}
