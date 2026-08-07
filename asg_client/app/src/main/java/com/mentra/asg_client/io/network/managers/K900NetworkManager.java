package com.mentra.asg_client.io.network.managers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.network.core.BaseNetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.models.HotspotState;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;
import com.mentra.asg_client.io.network.utils.WifiSecurityChooser;
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

    private final Handler mLocalHotspotHandler = new Handler(Looper.getMainLooper());
    private final Object mLocalHotspotLock = new Object();
    private WifiManager.LocalOnlyHotspotReservation mLocalHotspotReservation;
    private Runnable mPendingLocalHotspotStartupTimeout;
    private Runnable mPendingLocalHotspotReadiness;
    private Runnable mPendingLocalHotspotCloseCompletion;
    private Runnable mPendingStationWifiReconnect;
    private boolean mLocalHotspotStarting;
    private boolean mLocalHotspotIncompatibleModeRetried;
    private boolean mLocalHotspotDisconnectedStationWifi;
    private boolean mLocalHotspotClosing;
    private boolean mLocalHotspotRestartRequested;
    private boolean mVendorHotspotActive;
    private int mLocalHotspotGeneration;
    private int mStationWifiReconnectAttempts;
    private long mLocalHotspotStartupDeadlineMs;
    private long mLocalHotspotReadinessDeadlineMs;
    private String mPendingLocalHotspotSsid = "";
    private String mPendingLocalHotspotPassword = "";

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
            synchronized (mLocalHotspotLock) {
                completeStationWifiRestorationLocked();
            }
        } else {
            Log.d(TAG, "🌐 ❌ WiFi not connected, showing notification and enabling WiFi");
            notificationManager.showWifiStateNotification(false);
            // Auto-enable WiFi if not connected
            enableWifi();
            if (shouldAdoptStationWifiRestoration(
                    wifiConnected, isStationWifiRestorationPending())) {
                synchronized (mLocalHotspotLock) {
                    // A previous manager shut down while its fallback AP was still releasing.
                    // Adopt only that explicit handoff instead of overriding an intentional
                    // station disconnect on an unrelated service start.
                    markStationWifiDisconnectedLocked();
                }
                reconnectStationWifi();
            }
        }

        Log.d(TAG, "🌐 ✅ K900 Network Manager initialization complete");
    }

    static boolean shouldAdoptStationWifiRestoration(
            boolean stationWifiConnected, boolean restorationPending) {
        return !stationWifiConnected && restorationPending;
    }

    @Override
    protected boolean shouldMonitorTetheringBroadcasts() {
        // LocalOnlyHotspot owns its lifecycle through LocalOnlyHotspotCallback. Treating its
        // interface as a tethered AP can publish static credentials before the LOHS callback.
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
        Log.d(TAG, "🔥 =========================================");
        Log.d(TAG, "🔥 START K900 LOCAL-ONLY HOTSPOT");
        Log.d(TAG, "🔥 =========================================");

        final int generation;
        synchronized (mLocalHotspotLock) {
            if (shouldQueueLocalHotspotRestart(mLocalHotspotClosing)) {
                mLocalHotspotRestartRequested = true;
                Log.i(TAG, "🔥 Queued hotspot restart until current AP stops");
                return;
            }
            if (isHotspotEnabled() || mLocalHotspotStarting) {
                Log.d(TAG, "🔥 Local-only hotspot is already active or starting");
                return;
            }
            if (mLocalHotspotReservation != null) {
                Log.d(TAG, "🔥 Local-only hotspot is awaiting readiness");
                return;
            }
            generation = beginLocalHotspotStartLocked();
        }

        requestLocalOnlyHotspot(generation);
    }

    private int beginLocalHotspotStartLocked() {
        cancelStationWifiReconnectLocked();
        cancelLocalHotspotStartupTimeoutLocked();
        mStationWifiReconnectAttempts = 0;
        mLocalHotspotStarting = true;
        mLocalHotspotIncompatibleModeRetried = false;
        int generation = ++mLocalHotspotGeneration;
        mLocalHotspotStartupDeadlineMs =
                SystemClock.elapsedRealtime() + AsgConstants.LOCAL_HOTSPOT_STARTUP_TIMEOUT_MS;
        mPendingLocalHotspotStartupTimeout = () -> handleLocalHotspotStartupTimeout(generation);
        mLocalHotspotHandler.postDelayed(
                mPendingLocalHotspotStartupTimeout,
                AsgConstants.LOCAL_HOTSPOT_STARTUP_TIMEOUT_MS);
        return generation;
    }

    private void handleLocalHotspotStartupTimeout(int generation) {
        boolean vendorStartup;
        synchronized (mLocalHotspotLock) {
            mPendingLocalHotspotStartupTimeout = null;
            if (generation != mLocalHotspotGeneration
                    || !isLocalHotspotStartupPending(
                            mLocalHotspotStarting,
                            mLocalHotspotReservation != null,
                            mVendorHotspotActive)) {
                return;
            }
            vendorStartup = mVendorHotspotActive;
        }
        if (vendorStartup) {
            failVendorHotspotStartup(generation, "Vendor hotspot startup timed out");
        } else {
            failLocalHotspotStartup(generation, "Local-only hotspot startup timed out");
        }
    }

    static boolean isLocalHotspotStartupPending(
            boolean starting, boolean reservationAwaitingReadiness, boolean vendorActive) {
        return starting || reservationAwaitingReadiness || vendorActive;
    }

    @Override
    public boolean isHotspotTransitioning() {
        synchronized (mLocalHotspotLock) {
            boolean publicEnabled = isHotspotEnabled();
            return isLocalHotspotTransitioning(
                    mLocalHotspotStarting,
                    mLocalHotspotClosing,
                    mLocalHotspotReservation != null,
                    publicEnabled);
        }
    }

    @Override
    public HotspotState getHotspotState() {
        synchronized (mLocalHotspotLock) {
            boolean publicEnabled = isHotspotEnabled();
            return captureHotspotState(
                    isLocalHotspotTransitioning(
                            mLocalHotspotStarting,
                            mLocalHotspotClosing,
                            mLocalHotspotReservation != null,
                            publicEnabled));
        }
    }

    static boolean isLocalHotspotTransitioning(
            boolean starting, boolean closing, boolean reservationActive, boolean enabled) {
        // onStarted() arrives before the gateway interface is ready and before
        // onHotspotStarted() publishes enabled state. That readiness window is
        // still cancellable and must not look like a stable disabled hotspot.
        return starting || closing || (reservationActive && !enabled);
    }

    private void requestLocalOnlyHotspot(int generation) {
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration || !mLocalHotspotStarting) {
                Log.d(TAG, "🔥 Ignoring hotspot request from a stale generation");
                return;
            }
        }

        if (SystemClock.elapsedRealtime() >= mLocalHotspotStartupDeadlineMs) {
            failLocalHotspotStartup(generation, "Local-only hotspot startup timed out");
            return;
        }

        try {
            if (wifiManager == null) {
                failLocalHotspotStartup(generation, "WifiManager is unavailable");
                return;
            }
            if (!wifiManager.isWifiEnabled()) {
                Log.i(TAG, "🔥 WiFi radio is off; enabling it before LocalOnlyHotspot startup");
                if (!wifiManager.setWifiEnabled(true)) {
                    failLocalHotspotStartup(generation, "Failed to enable WiFi for local hotspot");
                    return;
                }
                mLocalHotspotHandler.postDelayed(
                        () -> {
                            if (!wifiManager.isWifiEnabled()) {
                                failLocalHotspotStartup(
                                        generation, "WiFi did not become ready for local hotspot");
                                return;
                            }
                            requestLocalOnlyHotspot(generation);
                        },
                        AsgConstants.LOCAL_HOTSPOT_WIFI_ENABLE_DELAY_MS);
                return;
            }
            wifiManager.startLocalOnlyHotspot(
                    new WifiManager.LocalOnlyHotspotCallback() {
                        @Override
                        public void onStarted(
                                WifiManager.LocalOnlyHotspotReservation reservation) {
                            handleLocalHotspotStarted(generation, reservation);
                        }

                        @Override
                        public void onStopped() {
                            handleLocalHotspotStopped(generation);
                        }

                        @Override
                        public void onFailed(int reason) {
                            handleLocalHotspotFailure(generation, reason);
                        }
                    },
                    mLocalHotspotHandler);
            Log.i(TAG, "🔥 Local-only hotspot start requested");
        } catch (Exception e) {
            if (shouldFallbackToVendorHotspot(e)) {
                Log.w(
                        TAG,
                        "🔥 LocalOnlyHotspot is unavailable on this firmware; using vendor AP",
                        e);
                startVendorHotspot(generation);
                return;
            }
            Log.e(TAG, "🔥 Error requesting local-only hotspot", e);
            failLocalHotspotStartup(generation, "Failed to start: " + e.getMessage());
        }
    }

    static boolean shouldFallbackToVendorHotspot(Throwable error) {
        return error instanceof SecurityException;
    }

    private void startVendorHotspot(int generation) {
        boolean stationWifiDisconnected = false;
        try {
            synchronized (mLocalHotspotLock) {
                if (generation != mLocalHotspotGeneration || !mLocalHotspotStarting) {
                    return;
                }
                if (isConnectedToWifi()) {
                    // Validate and disconnect while holding the lifecycle lock so a canceled
                    // generation cannot briefly disrupt a newly restored station connection.
                    if (!wifiManager.disconnect()) {
                        throw new IllegalStateException(
                                "Failed to disconnect WiFi before vendor hotspot");
                    }
                    markStationWifiDisconnectedLocked();
                    stationWifiDisconnected = true;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "🔥 Error disconnecting WiFi before vendor hotspot", e);
            failLocalHotspotStartup(
                    generation,
                    "Failed to disconnect WiFi before vendor hotspot: " + e.getMessage());
            return;
        }

        if (stationWifiDisconnected) {
            mLocalHotspotHandler.postDelayed(
                    () -> requestVendorHotspot(generation),
                    AsgConstants.LOCAL_HOTSPOT_WIFI_DISCONNECT_DELAY_MS);
            return;
        }

        requestVendorHotspot(generation);
    }

    private void requestVendorHotspot(int generation) {
        try {
            synchronized (mLocalHotspotLock) {
                if (generation != mLocalHotspotGeneration || !mLocalHotspotStarting) {
                    return;
                }
                mVendorHotspotActive = true;
                mLocalHotspotReadinessDeadlineMs =
                        calculateLocalHotspotReadinessDeadline(
                                mLocalHotspotStartupDeadlineMs, SystemClock.elapsedRealtime());
                // Keep the vendor start ordered with stopHotspot(). If stop wins the lock,
                // this generation is invalidated; if start wins, stop sends disable afterward.
                sendVendorHotspotState(true);
            }
            checkVendorHotspotReadiness(generation);
        } catch (Exception e) {
            Log.e(TAG, "🔥 Error starting vendor hotspot fallback", e);
            failVendorHotspotStartup(generation, "Vendor hotspot failed: " + e.getMessage());
        }
    }

    private void checkVendorHotspotReadiness(int generation) {
        String gatewayIp = findLocalHotspotGatewayIp();
        String ssid =
                readVendorHotspotSetting(AsgConstants.K900_VENDOR_HOTSPOT_SSID_SETTING, "");
        String password =
                readVendorHotspotSetting(
                        AsgConstants.K900_VENDOR_HOTSPOT_PASSWORD_SETTING, "");
        synchronized (mLocalHotspotLock) {
            mPendingLocalHotspotReadiness = null;
            if (generation != mLocalHotspotGeneration
                    || !mLocalHotspotStarting
                    || !mVendorHotspotActive) {
                return;
            }
            long nowMs = SystemClock.elapsedRealtime();
            boolean credentialsReady = !ssid.isEmpty() && !password.isEmpty();
            if (canPublishLocalHotspotReady(
                    !gatewayIp.isEmpty() && credentialsReady,
                    nowMs,
                    mLocalHotspotReadinessDeadlineMs)) {
                cancelLocalHotspotStartupTimeoutLocked();
                mLocalHotspotStarting = false;
                onHotspotStarted(ssid, password, gatewayIp);
                notificationManager.showHotspotStateNotification(true);
                notificationManager.showDebugNotification(
                        "Mentra Live Hotspot Active", ssid);
                Log.i(TAG, "🔥 Vendor hotspot ready: " + ssid + " gateway=" + gatewayIp);
                return;
            }
            if (nowMs >= mLocalHotspotReadinessDeadlineMs) {
                failVendorHotspotStartup(
                        generation, "Vendor hotspot gateway did not become ready");
                return;
            }
            mPendingLocalHotspotReadiness = () -> checkVendorHotspotReadiness(generation);
            mLocalHotspotHandler.postDelayed(
                    mPendingLocalHotspotReadiness,
                    AsgConstants.LOCAL_HOTSPOT_READINESS_POLL_MS);
        }
    }

    private String readVendorHotspotSetting(String key, String fallback) {
        try {
            String value = Settings.Global.getString(context.getContentResolver(), key);
            return value == null || value.isEmpty() ? fallback : value;
        } catch (Exception e) {
            Log.w(TAG, "🔥 Could not read vendor hotspot setting " + key, e);
            return fallback;
        }
    }

    private void failVendorHotspotStartup(int generation, String errorMessage) {
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration || !mVendorHotspotActive) {
                return;
            }
            // Claim teardown before sending the broadcast so a stale failure cannot
            // disable a vendor hotspot belonging to a newer generation.
            mVendorHotspotActive = false;
            mLocalHotspotStarting = false;
            mLocalHotspotClosing = true;
            cancelLocalHotspotStartupTimeoutLocked();
            cancelLocalHotspotReadinessLocked();
        }
        try {
            sendVendorHotspotState(false);
        } catch (Exception e) {
            Log.e(TAG, "🔥 Error stopping failed vendor hotspot", e);
        }
        notifyHotspotStartupFailure(errorMessage);
        scheduleLocalHotspotCloseCompletion(generation);
    }

    private void sendVendorHotspotState(boolean enabled) {
        Intent intent = new Intent(K900_BROADCAST_ACTION);
        intent.setPackage(K900_SYSTEM_UI_PACKAGE);
        intent.putExtra("cmd", "ap_start");
        intent.putExtra("enable", enabled);
        context.sendBroadcast(intent);
        Log.i(TAG, "🔥 Vendor hotspot " + (enabled ? "start" : "stop") + " requested");
    }

    private void handleLocalHotspotFailure(int generation, int reason) {
        boolean retryAfterDisconnect;
        boolean fallbackToVendorHotspot;
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration || !mLocalHotspotStarting) {
                Log.d(TAG, "🔥 Ignoring failure from a stale hotspot generation");
                return;
            }
            fallbackToVendorHotspot =
                    shouldFallbackToVendorHotspot(
                            reason, mLocalHotspotIncompatibleModeRetried);
            retryAfterDisconnect =
                    shouldRetryLocalHotspotAfterDisconnect(
                            reason, mLocalHotspotIncompatibleModeRetried);
            if (retryAfterDisconnect) {
                mLocalHotspotIncompatibleModeRetried = true;
            }
        }

        if (fallbackToVendorHotspot) {
            Log.w(
                    TAG,
                    "🔥 LocalOnlyHotspot remains incompatible after WiFi disconnect; using vendor AP");
            startVendorHotspot(generation);
            return;
        }

        if (!retryAfterDisconnect) {
            failLocalHotspotStartup(
                    generation, "Local-only hotspot failed with reason " + reason);
            return;
        }

        Log.w(TAG, "🔥 WiFi station mode blocked the hotspot; disconnecting and retrying once");
        try {
            synchronized (mLocalHotspotLock) {
                if (generation != mLocalHotspotGeneration || !mLocalHotspotStarting) {
                    return;
                }
                if (isConnectedToWifi()) {
                    if (!wifiManager.disconnect()) {
                        throw new IllegalStateException(
                                "Failed to disconnect WiFi before hotspot retry");
                    }
                    markStationWifiDisconnectedLocked();
                }
            }
            mLocalHotspotHandler.postDelayed(
                    () -> requestLocalOnlyHotspot(generation),
                    AsgConstants.LOCAL_HOTSPOT_WIFI_DISCONNECT_DELAY_MS);
        } catch (Exception e) {
            Log.e(TAG, "🔥 Error disconnecting WiFi before hotspot retry", e);
            failLocalHotspotStartup(
                    generation, "Failed to disconnect WiFi before hotspot retry: " + e.getMessage());
        }
    }

    static boolean shouldRetryLocalHotspotAfterDisconnect(int reason, boolean alreadyRetried) {
        return reason == WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE
                && !alreadyRetried;
    }

    static boolean shouldFallbackToVendorHotspot(int reason, boolean alreadyRetried) {
        return reason == WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE
                && alreadyRetried;
    }

    private void handleLocalHotspotStarted(
            int generation, WifiManager.LocalOnlyHotspotReservation reservation) {
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration || !mLocalHotspotStarting) {
                Log.d(TAG, "🔥 Closing hotspot that completed after a stop request");
                reservation.close();
                return;
            }
            mLocalHotspotStarting = false;
            mLocalHotspotClosing = false;
            mLocalHotspotReservation = reservation;
        }

        WifiConfiguration configuration = reservation.getWifiConfiguration();
        String ssid = configuration != null ? unquote(configuration.SSID) : "";
        String password = configuration != null ? unquote(configuration.preSharedKey) : "";
        if (ssid.isEmpty() || password.isEmpty()) {
            failLocalHotspotStartup(
                    generation, "Local-only hotspot returned invalid credentials");
            return;
        }

        synchronized (mLocalHotspotLock) {
            mPendingLocalHotspotSsid = ssid;
            mPendingLocalHotspotPassword = password;
            mLocalHotspotReadinessDeadlineMs =
                    calculateLocalHotspotReadinessDeadline(
                            mLocalHotspotStartupDeadlineMs, SystemClock.elapsedRealtime());
        }
        checkLocalHotspotReadiness(generation);
    }

    private void checkLocalHotspotReadiness(int generation) {
        String gatewayIp = findLocalHotspotGatewayIp();
        synchronized (mLocalHotspotLock) {
            mPendingLocalHotspotReadiness = null;
            if (generation != mLocalHotspotGeneration || mLocalHotspotReservation == null) {
                return;
            }
            long nowMs = SystemClock.elapsedRealtime();
            if (canPublishLocalHotspotReady(
                    !gatewayIp.isEmpty(), nowMs, mLocalHotspotReadinessDeadlineMs)) {
                cancelLocalHotspotStartupTimeoutLocked();
                onHotspotStarted(
                        mPendingLocalHotspotSsid, mPendingLocalHotspotPassword, gatewayIp);
                notificationManager.showHotspotStateNotification(true);
                notificationManager.showDebugNotification(
                        "Mentra Live Hotspot Active", mPendingLocalHotspotSsid);
                Log.i(
                        TAG,
                        "🔥 Local-only hotspot ready: "
                                + mPendingLocalHotspotSsid
                                + " gateway="
                                + gatewayIp);
                return;
            }
            if (nowMs >= mLocalHotspotReadinessDeadlineMs) {
                failLocalHotspotStartup(
                        generation, "Local-only hotspot gateway did not become ready");
                return;
            }
            mPendingLocalHotspotReadiness = () -> checkLocalHotspotReadiness(generation);
            mLocalHotspotHandler.postDelayed(
                    mPendingLocalHotspotReadiness,
                    AsgConstants.LOCAL_HOTSPOT_READINESS_POLL_MS);
        }
    }

    static long calculateLocalHotspotReadinessDeadline(
            long startupDeadlineMs, long nowMs) {
        return Math.min(
                startupDeadlineMs - AsgConstants.LOCAL_HOTSPOT_RESPONSE_MARGIN_MS,
                nowMs + AsgConstants.LOCAL_HOTSPOT_READINESS_TIMEOUT_MS);
    }

    static boolean canPublishLocalHotspotReady(
            boolean gatewayReady, long nowMs, long publishDeadlineMs) {
        return gatewayReady && nowMs < publishDeadlineMs;
    }

    static boolean shouldReconnectStationWifiImmediately(
            boolean reservationActive,
            boolean hotspotClosing,
            boolean stationWifiDisconnected) {
        return !reservationActive && !hotspotClosing && stationWifiDisconnected;
    }

    static boolean shouldQueueLocalHotspotRestart(boolean hotspotClosing) {
        return hotspotClosing;
    }

    static boolean shouldDeferLocalHotspotStopped(
            boolean reservationActive, boolean hotspotClosing) {
        return reservationActive || hotspotClosing;
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

    private void failLocalHotspotStartup(int generation, String errorMessage) {
        Log.e(TAG, "🔥 " + errorMessage);
        WifiManager.LocalOnlyHotspotReservation reservation;
        boolean reconnectStationWifi;
        boolean scheduleCloseCompletion;
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration) {
                Log.d(TAG, "🔥 Ignoring failure from a stale hotspot generation");
                return;
            }
            mLocalHotspotStarting = false;
            cancelLocalHotspotStartupTimeoutLocked();
            cancelLocalHotspotReadinessLocked();
            reservation = mLocalHotspotReservation;
            scheduleCloseCompletion = reservation != null;
            if (scheduleCloseCompletion) {
                mLocalHotspotReservation = null;
                mLocalHotspotClosing = true;
            }
            reconnectStationWifi =
                    shouldReconnectStationWifiImmediately(
                            reservation != null,
                            mLocalHotspotClosing,
                            mLocalHotspotDisconnectedStationWifi);
        }
        if (reservation != null) {
            try {
                reservation.close();
            } finally {
                scheduleLocalHotspotCloseCompletion(generation);
            }
        }
        if (reconnectStationWifi) {
            reconnectStationWifi();
        }
        if (!scheduleCloseCompletion) {
            onHotspotStopped();
        }
        notifyHotspotStartupFailure(errorMessage);
    }

    private void notifyHotspotStartupFailure(String errorMessage) {
        notifyHotspotError(errorMessage);
        notificationManager.showDebugNotification("Hotspot Failed", errorMessage);
    }

    private void handleLocalHotspotStopped(int generation) {
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration) {
                Log.d(TAG, "🔥 Ignoring stop callback from a stale hotspot generation");
                return;
            }
            mLocalHotspotStarting = false;
            // Keep commands routed through the transition path until the stopped
            // state is published and the restart decision is committed.
            mLocalHotspotClosing = true;
            mLocalHotspotReservation = null;
            cancelLocalHotspotStartupTimeoutLocked();
            cancelLocalHotspotReadinessLocked();
            cancelLocalHotspotCloseCompletionLocked();
        }
        onHotspotStopped();
        notificationManager.showHotspotStateNotification(false);
        Log.i(TAG, "🔥 Local-only hotspot stopped");
        finishLocalHotspotStopTransition(generation);
    }

    private void scheduleLocalHotspotCloseCompletion(int generation) {
        synchronized (mLocalHotspotLock) {
            cancelLocalHotspotCloseCompletionLocked();
            mPendingLocalHotspotCloseCompletion =
                    () -> finishLocalHotspotClose(generation);
            mLocalHotspotHandler.postDelayed(
                    mPendingLocalHotspotCloseCompletion,
                    AsgConstants.LOCAL_HOTSPOT_TEARDOWN_DELAY_MS);
        }
    }

    private void finishLocalHotspotClose(int generation) {
        synchronized (mLocalHotspotLock) {
            mPendingLocalHotspotCloseCompletion = null;
            if (generation != mLocalHotspotGeneration || !mLocalHotspotClosing) {
                return;
            }
        }
        onHotspotStopped();
        notificationManager.showHotspotStateNotification(false);
        Log.i(TAG, "🔥 Local-only hotspot close completed");
        finishLocalHotspotStopTransition(generation);
    }

    private void finishLocalHotspotStopTransition(int generation) {
        boolean reconnectStationWifi;
        int restartGeneration = -1;
        synchronized (mLocalHotspotLock) {
            if (generation != mLocalHotspotGeneration || !mLocalHotspotClosing) {
                return;
            }
            boolean restartHotspot = mLocalHotspotRestartRequested;
            mLocalHotspotRestartRequested = false;
            mLocalHotspotClosing = false;
            reconnectStationWifi =
                    mLocalHotspotDisconnectedStationWifi && !restartHotspot;
            if (restartHotspot) {
                // Commit the next generation while holding the same lock that stopHotspot()
                // uses to cancel startup. A newer stop can now invalidate this generation
                // before requestLocalOnlyHotspot() reaches Android.
                restartGeneration = beginLocalHotspotStartLocked();
            }
        }
        if (reconnectStationWifi) {
            reconnectStationWifi();
        }
        if (restartGeneration >= 0) {
            requestLocalOnlyHotspot(restartGeneration);
        }
    }

    private void cancelLocalHotspotReadinessLocked() {
        if (mPendingLocalHotspotReadiness != null) {
            mLocalHotspotHandler.removeCallbacks(mPendingLocalHotspotReadiness);
            mPendingLocalHotspotReadiness = null;
        }
    }

    private void cancelLocalHotspotStartupTimeoutLocked() {
        if (mPendingLocalHotspotStartupTimeout != null) {
            mLocalHotspotHandler.removeCallbacks(mPendingLocalHotspotStartupTimeout);
            mPendingLocalHotspotStartupTimeout = null;
        }
    }

    private void cancelLocalHotspotCloseCompletionLocked() {
        if (mPendingLocalHotspotCloseCompletion != null) {
            mLocalHotspotHandler.removeCallbacks(mPendingLocalHotspotCloseCompletion);
            mPendingLocalHotspotCloseCompletion = null;
        }
    }

    private void markStationWifiDisconnectedLocked() {
        cancelStationWifiReconnectLocked();
        mLocalHotspotDisconnectedStationWifi = true;
        mStationWifiReconnectAttempts = 0;
        setStationWifiRestorationPending(true);
    }

    private void completeStationWifiRestorationLocked() {
        cancelStationWifiReconnectLocked();
        mLocalHotspotDisconnectedStationWifi = false;
        mStationWifiReconnectAttempts = 0;
        setStationWifiRestorationPending(false);
    }

    private void cancelStationWifiReconnectLocked() {
        if (mPendingStationWifiReconnect != null) {
            mLocalHotspotHandler.removeCallbacks(mPendingStationWifiReconnect);
            mPendingStationWifiReconnect = null;
        }
    }

    private boolean isStationWifiRestorationPending() {
        return context.getSharedPreferences(
                        AsgConstants.K900_NETWORK_MANAGER_PREFERENCES, Context.MODE_PRIVATE)
                .getBoolean(AsgConstants.K900_STATION_WIFI_RESTORE_PENDING_KEY, false);
    }

    private void setStationWifiRestorationPending(boolean pending) {
        context.getSharedPreferences(
                        AsgConstants.K900_NETWORK_MANAGER_PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(AsgConstants.K900_STATION_WIFI_RESTORE_PENDING_KEY, pending)
                .apply();
    }

    private void invalidateLocalHotspotLifecycleLocked() {
        mLocalHotspotGeneration++;
        mLocalHotspotStarting = false;
        mLocalHotspotClosing = false;
        mLocalHotspotRestartRequested = false;
        mLocalHotspotReservation = null;
        mVendorHotspotActive = false;
        mLocalHotspotDisconnectedStationWifi = false;
        mStationWifiReconnectAttempts = 0;
        mPendingLocalHotspotSsid = "";
        mPendingLocalHotspotPassword = "";
        cancelLocalHotspotStartupTimeoutLocked();
        cancelLocalHotspotReadinessLocked();
        cancelLocalHotspotCloseCompletionLocked();
        cancelStationWifiReconnectLocked();
        mLocalHotspotHandler.removeCallbacksAndMessages(null);
    }

    private String unquote(String value) {
        if (value == null) {
            return "";
        }
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    private void reconnectStationWifi() {
        synchronized (mLocalHotspotLock) {
            cancelStationWifiReconnectLocked();
            if (!mLocalHotspotDisconnectedStationWifi) {
                return;
            }
            if (mLocalHotspotStarting
                    || mLocalHotspotClosing
                    || mLocalHotspotReservation != null
                    || mVendorHotspotActive
                    || mLocalHotspotRestartRequested) {
                Log.d(TAG, "📶 Deferring station WiFi restoration during hotspot transition");
                return;
            }
            if (isConnectedToWifi()) {
                completeStationWifiRestorationLocked();
                Log.i(TAG, "📶 Station WiFi restoration completed after local hotspot");
                return;
            }

            mStationWifiReconnectAttempts++;
            boolean reconnectRequested = false;
            try {
                reconnectRequested = wifiManager.reconnect();
            } catch (Exception e) {
                Log.e(TAG, "📶 Error reconnecting WiFi after local hotspot", e);
            }

            if (reconnectRequested) {
                Log.i(
                        TAG,
                        "📶 Station WiFi reconnection accepted after local hotspot (attempt "
                                + mStationWifiReconnectAttempts
                                + ")");
            } else {
                Log.w(
                        TAG,
                        "📶 Failed to request WiFi reconnection after local hotspot (attempt "
                                + mStationWifiReconnectAttempts
                                + ")");
            }
            if (shouldRetryStationWifiReconnect(mStationWifiReconnectAttempts)) {
                mPendingStationWifiReconnect = this::reconnectStationWifi;
                mLocalHotspotHandler.postDelayed(
                        mPendingStationWifiReconnect,
                        AsgConstants.LOCAL_HOTSPOT_WIFI_RECONNECT_RETRY_MS);
            } else {
                Log.e(
                        TAG,
                        "📶 Station WiFi restoration retries exhausted; preserving handoff");
            }
        }
    }

    static boolean shouldRetryStationWifiReconnect(int attempts) {
        return attempts < AsgConstants.LOCAL_HOTSPOT_WIFI_RECONNECT_MAX_ATTEMPTS;
    }

    @Override
    public void stopHotspot() {
        Log.d(TAG, "🔥 =========================================");
        Log.d(TAG, "🔥 STOP K900 LOCAL-ONLY HOTSPOT");
        Log.d(TAG, "🔥 =========================================");

        WifiManager.LocalOnlyHotspotReservation reservation;
        boolean reconnectStationWifi;
        boolean closeReservation;
        boolean stopVendorHotspot;
        boolean reportStoppedImmediately;
        int generation;
        synchronized (mLocalHotspotLock) {
            boolean wasClosing = mLocalHotspotClosing;
            generation = mLocalHotspotGeneration;
            mLocalHotspotStarting = false;
            mLocalHotspotRestartRequested = false;
            cancelLocalHotspotStartupTimeoutLocked();
            cancelLocalHotspotReadinessLocked();
            reservation = mLocalHotspotReservation;
            closeReservation = reservation != null;
            stopVendorHotspot = mVendorHotspotActive;
            if (closeReservation) {
                mLocalHotspotReservation = null;
                mLocalHotspotClosing = true;
            }
            if (stopVendorHotspot) {
                mVendorHotspotActive = false;
                mLocalHotspotClosing = true;
            }
            boolean teardownInProgress = closeReservation || stopVendorHotspot;
            reportStoppedImmediately =
                    !shouldDeferLocalHotspotStopped(teardownInProgress, wasClosing);
            reconnectStationWifi =
                    shouldReconnectStationWifiImmediately(
                            teardownInProgress,
                            mLocalHotspotClosing,
                            mLocalHotspotDisconnectedStationWifi);
            if (!teardownInProgress && !wasClosing) {
                mLocalHotspotGeneration++;
            }
        }
        if (stopVendorHotspot) {
            try {
                sendVendorHotspotState(false);
            } catch (Exception e) {
                Log.e(TAG, "🔥 Error stopping vendor hotspot", e);
            } finally {
                scheduleLocalHotspotCloseCompletion(generation);
            }
        } else if (closeReservation) {
            try {
                // Android does not invoke LocalOnlyHotspotCallback.onStopped() when the
                // reservation owner closes it, so complete our state transition locally.
                reservation.close();
            } finally {
                scheduleLocalHotspotCloseCompletion(generation);
            }
        }
        if (reconnectStationWifi) {
            reconnectStationWifi();
        }
        if (reportStoppedImmediately) {
            onHotspotStopped();
            notificationManager.showHotspotStateNotification(false);
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
                                    mLocalHotspotHandler.postDelayed(
                                            () -> {
                                                boolean isConnected = isConnectedToWifi();
                                                handleStationWifiState(isConnected);
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
                    handleStationWifiState(isConnected);
                    break;
            }
        }
    }

    private void handleStationWifiState(boolean isConnected) {
        if (isConnected) {
            synchronized (mLocalHotspotLock) {
                completeStationWifiRestorationLocked();
            }
        }
        notificationManager.showWifiStateNotification(isConnected);
        notifyWifiStateChanged(isConnected);
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
        stopHotspot();
        synchronized (mLocalHotspotLock) {
            // The manager is no longer allowed to restore WiFi or complete an old hotspot
            // generation after a replacement manager has taken ownership.
            invalidateLocalHotspotLifecycleLocked();
        }
        unregisterWifiStateReceiver();
        super.shutdown();
    }
}
