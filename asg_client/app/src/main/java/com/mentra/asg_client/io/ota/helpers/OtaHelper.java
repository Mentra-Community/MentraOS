package com.mentra.asg_client.io.ota.helpers;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Network;
import android.net.NetworkRequest;

import org.json.JSONException;
import org.json.JSONObject;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.io.bes.BesOtaManager;
import com.mentra.asg_client.io.ota.events.DownloadProgressEvent;
import com.mentra.asg_client.io.ota.events.InstallationProgressEvent;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.stream.Collectors;
import java.util.concurrent.locks.ReentrantLock;

import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.service.utils.SysProp;

import org.json.JSONArray;

public class OtaHelper {

    // ========== Phone Connection Provider Interface ==========

    /**
     * Interface for providing phone connection status and sending OTA messages to phone.
     * Implemented by CommunicationManager to enable phone-controlled OTA updates.
     */
    public interface PhoneConnectionProvider {
        /**
         * Check if phone is currently connected via BLE
         * @return true if phone is connected
         */
        boolean isPhoneConnected();

        /**
         * Send OTA update available notification to phone (background mode)
         * @param updateInfo JSON with version_code, version_name, updates[], total_size
         */
        void sendOtaUpdateAvailable(JSONObject updateInfo);

        /**
         * Send OTA progress update to phone
         * @param progress JSON with stage, status, progress, bytes_downloaded, total_bytes, etc.
         */
        void sendOtaProgress(JSONObject progress);
    }
    private static final String TAG = OtaConstants.TAG;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static ConnectivityManager connectivityManager;
    private static final ReentrantLock versionCheckLock = new ReentrantLock();
    private static volatile boolean isUpdating = false;  // Tracks download/install in progress
    private static volatile boolean isMtkOtaInProgress = false;  // Tracks MTK firmware update in progress
    private static volatile long lastVersionCheckTime = 0;  // Track last check time to prevent duplicate network callback triggers
    private static final long NETWORK_CALLBACK_IGNORE_WINDOW_MS = 2000;  // Ignore network callback if check happened within last 2 seconds
    private Handler handler;
    private Context context;
    private Runnable periodicCheckRunnable;
    private boolean isPeriodicCheckActive = false;
    
    // Retry logic constants
    private static final int MAX_DOWNLOAD_RETRIES = 3;
    private static final long RETRY_DELAY_MS = 10000; // 10 seconds between attempts
    
    // Update order configuration - can be easily modified to change update sequence
    // Order: APK updates → MTK firmware → BES firmware
    private static final String UPDATE_TYPE_APK = "apk";
    private static final String UPDATE_TYPE_MTK = "mtk";
    private static final String UPDATE_TYPE_BES = "bes";
    private static final String[] UPDATE_ORDER = {UPDATE_TYPE_APK, UPDATE_TYPE_MTK, UPDATE_TYPE_BES};
    
    // ⚠️ DEBUG FLAG: Set to true to skip all checks and install MTK firmware from local file
    // This will bypass version checking, downloading, and directly install /storage/emulated/0/asg/mtk_firmware.zip
    private static final boolean DEBUG_FORCE_MTK_INSTALL = false;

    // ⚠️ DEBUG FLAG: Set to true to skip all checks and install BES firmware from local file
    // This will bypass version checking, downloading, and directly install /storage/emulated/0/asg/bes_firmware.bin
    private static final boolean DEBUG_FORCE_BES_INSTALL = false;

    // ========== Autonomous OTA Mode ==========
    // When false, OTA updates only happen when initiated by the phone app.
    // When true, glasses will also check for updates autonomously (initial check, periodic checks, WiFi callback).
    // Disabled by default since phone-initiated OTA is the preferred flow.
    private static final boolean AUTONOMOUS_OTA_ENABLED = false;

    // ========== Phone-Controlled OTA State ==========

    // Provider for phone connection status and messaging
    private PhoneConnectionProvider phoneConnectionProvider;

    // Track phone-initiated vs glasses-initiated OTA
    private static volatile boolean isPhoneInitiatedOta = false;

    // Track if we've notified phone about available update (to avoid spam)
    private static volatile boolean hasNotifiedPhoneOfUpdate = false;

    // Progress throttling - send every 2s OR every 5% change
    private long lastProgressSentTime = 0;
    private int lastProgressSentPercent = 0;
    private static final long PROGRESS_MIN_INTERVAL_MS = 2000; // 2 seconds
    private static final int PROGRESS_MIN_CHANGE_PERCENT = 5;   // 5%

    // Current update stage for progress reporting
    private String currentUpdateStage = "download"; // "download" or "install"
    private String currentUpdateType = "apk"; // "apk", "mtk", or "bes"

    // Pending BES update - saved when MTK update is in progress
    // BES will be started after MTK completes (to avoid concurrent firmware updates)
    private JSONObject pendingBesUpdate = null;

    // Track if MTK was updated this session (to prevent re-updating before reboot)
    // MTK A/B updates don't change ro.custom.ota.version until reboot, so without this
    // flag the system would try to re-download and re-install the same MTK update
    private static volatile boolean mtkUpdatedThisSession = false;

    // ========== Singleton Pattern ==========

    private static volatile OtaHelper instance;

    /**
     * Get the singleton instance of OtaHelper.
     * Must call initialize(Context) first.
     * @return The OtaHelper instance, or null if not initialized
     */
    public static OtaHelper getInstance() {
        return instance;
    }

    /**
     * Initialize the singleton instance.
     * Should be called once during app startup (e.g., from OtaService).
     * @param context Application context
     * @return The OtaHelper instance
     */
    public static synchronized OtaHelper initialize(Context context) {
        if (instance == null) {
            instance = new OtaHelper(context);
            Log.i(TAG, "OtaHelper singleton initialized");
        }
        return instance;
    }

    public OtaHelper(Context context) {
        this.context = context.getApplicationContext(); // Use application context to avoid memory leaks
        handler = new Handler(Looper.getMainLooper());

        // Register for EventBus to receive battery status updates
        EventBus.getDefault().register(this);

        if (AUTONOMOUS_OTA_ENABLED) {
            // Delay all autonomous checks by 5 seconds to ensure PhoneConnectionProvider
            // is set up (happens at ~6s) so isPhoneConnected() works correctly
            handler.postDelayed(() -> {
                Log.d(TAG, "Starting autonomous OTA checks after 5 second delay");

                // Perform initial check
                startVersionCheck(this.context);

                // Start periodic checks
                startPeriodicChecks();

                // Register network callback to check for updates when WiFi becomes available
                // Note: If WiFi is already available, callback may fire immediately, but timestamp
                // tracking prevents duplicate checks within 2 seconds
                registerNetworkCallback(this.context);
            }, 5000);

            Log.i(TAG, "Autonomous OTA mode ENABLED - checks will start in 30 seconds");
        } else {
            Log.i(TAG, "Autonomous OTA mode DISABLED - updates only via phone app");
        }
    }

    public void cleanup() {
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
        stopPeriodicChecks();
        unregisterNetworkCallback();

        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }

        phoneConnectionProvider = null;
        context = null;
    }

    // ========== Phone Connection Provider Methods ==========

    /**
     * Set the phone connection provider for phone-controlled OTA updates.
     * Should be called by CommunicationManager during service initialization.
     * @param provider The PhoneConnectionProvider implementation
     */
    public void setPhoneConnectionProvider(PhoneConnectionProvider provider) {
        this.phoneConnectionProvider = provider;
        Log.i(TAG, "PhoneConnectionProvider set: " + (provider != null ? "enabled" : "disabled"));
    }

    /**
     * Check if phone is currently connected via BLE
     * @return true if phone is connected
     */
    private boolean isPhoneConnected() {
        return phoneConnectionProvider != null && phoneConnectionProvider.isPhoneConnected();
    }

    /**
     * Called when phone disconnects - reset notification flag so we can re-notify on reconnect
     */
    public void onPhoneDisconnected() {
        hasNotifiedPhoneOfUpdate = false;
        Log.d(TAG, "Phone disconnected - reset OTA notification flag");
    }

    /**
     * Start OTA update from phone command (onboarding or background approval).
     * Called by OtaCommandHandler when phone sends ota_start command.
     */
    public void startOtaFromPhone() {
        Log.i(TAG, "📱 Starting OTA from phone request");
        
        // If OTA already in progress, acknowledge but don't restart
        if (versionCheckLock.isLocked()) {
            Log.i(TAG, "📱 OTA check already in progress, ignoring duplicate ota_start");
            return;
        }
        
        isPhoneInitiatedOta = true;
        hasNotifiedPhoneOfUpdate = false; // Reset for next check cycle

        // Reset progress tracking
        lastProgressSentTime = 0;
        lastProgressSentPercent = 0;

        // Send initial progress
        sendProgressToPhone("download", 0, 0, 0, "STARTED", null);

        startVersionCheck(context);
    }

    private void startPeriodicChecks() {
        if (isPeriodicCheckActive) {
            Log.d(TAG, "Periodic checks already active");
            return;
        }

        periodicCheckRunnable = new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "Performing periodic OTA check");
                startVersionCheck(context);
                // Schedule next check
                handler.postDelayed(this, OtaConstants.PERIODIC_CHECK_INTERVAL_MS);
            }
        };

        // Start the first periodic check after the interval
        handler.postDelayed(periodicCheckRunnable, OtaConstants.PERIODIC_CHECK_INTERVAL_MS);
        isPeriodicCheckActive = true;
        Log.d(TAG, "Started periodic OTA checks every 15 minutes");
    }

    private void stopPeriodicChecks() {
        if (!isPeriodicCheckActive) {
            return;
        }

        if (handler != null && periodicCheckRunnable != null) {
            handler.removeCallbacks(periodicCheckRunnable);
        }
        isPeriodicCheckActive = false;
        Log.d(TAG, "Stopped periodic OTA checks");
    }

    public void registerNetworkCallback(Context context) {
        Log.d(TAG, "Registering network callback");
        connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);

        if (connectivityManager == null) {
            Log.e(TAG, "ConnectivityManager not available");
            return;
        }

        if (networkCallback != null) {
            Log.d(TAG, "Network callback already registered");
            return;
        }

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                super.onAvailable(network);
                NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
                if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    // Ignore if a version check happened very recently (prevents duplicate from initial check)
                    long timeSinceLastCheck = System.currentTimeMillis() - lastVersionCheckTime;
                    if (timeSinceLastCheck < NETWORK_CALLBACK_IGNORE_WINDOW_MS) {
                        Log.d(TAG, "WiFi network available, but version check happened " + timeSinceLastCheck + "ms ago - ignoring to prevent duplicate");
                        return;
                    }
                    Log.d(TAG, "WiFi network became available, triggering version check");
                    startVersionCheck(context);
                }
            }
        };

        NetworkRequest.Builder builder = new NetworkRequest.Builder();
        builder.addTransportType(NetworkCapabilities.TRANSPORT_WIFI);

        try {
            connectivityManager.registerNetworkCallback(builder.build(), networkCallback);
            Log.d(TAG, "Successfully registered network callback");
        } catch (Exception e) {
            Log.e(TAG, "Failed to register network callback", e);
        }
    }

    public void unregisterNetworkCallback() {
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
                networkCallback = null;
                Log.d(TAG, "Network callback unregistered");
            } catch (Exception e) {
                Log.e(TAG, "Failed to unregister network callback", e);
            }
        }
    }

    private boolean isNetworkAvailable(Context context) {
        Log.d(TAG, "Checking WiFi connectivity status...");
        ConnectivityManager connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(connectivityManager.getActiveNetwork());
                if (capabilities != null) {
                    boolean hasWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
                    Log.d(TAG, "SDK >= 23: WiFi status: " + (hasWifi ? "Connected" : "Disconnected"));
                    return hasWifi;
                } else {
                    Log.e(TAG, "SDK >= 23: No network capabilities found");
                }
            } else {
                NetworkInfo activeNetworkInfo = connectivityManager.getActiveNetworkInfo();
                if (activeNetworkInfo != null) {
                    boolean isConnected = activeNetworkInfo.isConnected();
                    boolean isWifi = activeNetworkInfo.getType() == ConnectivityManager.TYPE_WIFI;
                    Log.d(TAG, "SDK < 23: Network status - Connected: " + isConnected + ", WiFi: " + isWifi);
                    return isConnected && isWifi;
                } else {
                    Log.e(TAG, "SDK < 23: No active network info found");
                }
            }
        } else {
            Log.e(TAG, "ConnectivityManager not available");
        }
        Log.e(TAG, "No WiFi connection detected");
        return false;
    }

    public void startVersionCheck(Context context) {
        Log.d(TAG, "Check OTA update method init");

        // if (!isNetworkAvailable(context)) {
        //     Log.e(TAG, "No WiFi connection available. Skipping OTA check.");
        //     return;
        // }
        
        // // Check battery status before proceeding with OTA update
        // if (!isBatterySufficientForUpdates()) {
        //     Log.w(TAG, "🚨 Battery insufficient for OTA updates - skipping version check");
        //     return;
        // }

        new Thread(() -> {
            // Try to acquire lock - if already held, another check is in progress
            if (!versionCheckLock.tryLock()) {
                Log.d(TAG, "Version check already in progress, skipping this request");
                return;
            }
            
            // Check if update is in progress (separate from version check)
            if (isUpdating) {
                Log.d(TAG, "Update already in progress, skipping version check");
                versionCheckLock.unlock();
                return;
            }
            
            // Record timestamp to prevent duplicate network callback triggers
            lastVersionCheckTime = System.currentTimeMillis();

            try {
                // Fetch version info from URL
                String versionInfo = fetchVersionInfo(OtaConstants.VERSION_JSON_URL);
                JSONObject json = new JSONObject(versionInfo);

                Log.d(TAG, "versionInfo: " + versionInfo);

                // ========== Phone-Initiated OTA Check ==========
                // When AUTONOMOUS_OTA_ENABLED = false, this method should ONLY be called via
                // startOtaFromPhone() which sets isPhoneInitiatedOta = true.
                // 
                // Safety check: If not phone-initiated and autonomous mode is disabled, abort.
                if (!isPhoneInitiatedOta && !AUTONOMOUS_OTA_ENABLED) {
                    Log.w(TAG, "📱 Autonomous OTA disabled and not phone-initiated - aborting version check");
                    return;
                }

                // ========== Legacy Autonomous OTA Logic (only when AUTONOMOUS_OTA_ENABLED = true) ==========
                // If phone is connected AND this is NOT phone-initiated AND we haven't notified yet:
                // - Check for available updates
                // - Notify phone (background mode)
                // - Wait for phone to send ota_start before proceeding
                boolean phoneConnected = isPhoneConnected();

                if (AUTONOMOUS_OTA_ENABLED && phoneConnected && !isPhoneInitiatedOta && !hasNotifiedPhoneOfUpdate) {
                    Log.i(TAG, "📱 Phone connected, checking for available updates (background mode)");
                    JSONObject updateInfo = checkForAvailableUpdates(json);

                    if (updateInfo != null && updateInfo.optBoolean("available", false)) {
                        // Notify phone and wait for approval (all updates require phone confirmation)
                        notifyPhoneUpdateAvailable(updateInfo);
                        hasNotifiedPhoneOfUpdate = true;
                        Log.i(TAG, "📱 Notified phone of update - waiting for ota_start command");
                        return; // Don't proceed with download - wait for phone approval
                    } else {
                        Log.d(TAG, "📱 No updates available for phone notification");
                    }
                }

                // ========== Proceed with OTA ==========
                // Reaches here when:
                // 1. Phone initiated OTA (isPhoneInitiatedOta = true) - PRIMARY FLOW
                // 2. Autonomous mode enabled AND (phone not connected OR already notified)

                // Check if new format (multiple apps) or legacy format
                if (json.has("apps")) {
                    // New format - process sequentially (pass root JSON for firmware access)
                    processAppsSequentially(json, context);
                } else {
                    // Legacy format - only ASG client
                    Log.d(TAG, "Using legacy version.json format");
                    checkAndUpdateApp("com.mentra.asg_client", json, context);
                }
            } catch (Exception e) {
                Log.e(TAG, "Exception during OTA check", e);
                // Send failure to phone if this was phone-initiated
                if (isPhoneInitiatedOta) {
                    sendProgressToPhone(currentUpdateStage, 0, 0, 0, "FAILED", e.getMessage());
                }
            } finally {
                // Always release lock and reset flags when done
                isPhoneInitiatedOta = false;
                versionCheckLock.unlock();
                Log.d(TAG, "Version check completed, ready for next check");
            }
        }).start();
    }

    /**
     * Fetch version info from URL.
     * @param url URL (http://, https://)
     * @return JSON string content
     * @throws Exception if fetch fails
     */
    private String fetchVersionInfo(String url) throws Exception {
        Log.d(TAG, "Fetching version info from URL: " + url);
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(new URL(url).openStream())
        );
        return reader.lines().collect(Collectors.joining("\n"));
    }

    private void processAppsSequentially(JSONObject rootJson, Context context) throws Exception {
        // Get the apps object from root
        JSONObject apps = rootJson.getJSONObject("apps");
        
        // Process apps in order - important for sequential updates
        String[] orderedPackages = {
            "com.mentra.asg_client",     // Update ASG client first
            "com.augmentos.otaupdater"      // Then OTA updater
        };
        
        boolean apkUpdateNeeded = false;
        
        // PHASE 1: Update APKs if needed
        for (String packageName : orderedPackages) {
            if (!apps.has(packageName)) continue;
            
            JSONObject appInfo = apps.getJSONObject(packageName);
            
            // Check if update needed
            long currentVersion = getInstalledVersion(packageName, context);
            long serverVersion = appInfo.getLong("versionCode");
            
            if (serverVersion > currentVersion) {
                Log.i(TAG, "Update available for " + packageName + 
                         " (current: " + currentVersion + ", server: " + serverVersion + ")");
                
                // Update this app and wait for completion
                boolean success = checkAndUpdateApp(packageName, appInfo, context);
                
                if (success) {
                    Log.i(TAG, "Successfully updated " + packageName);
                    apkUpdateNeeded = true;
                    
                    // Wait a bit for installation to complete before checking next app
                    Thread.sleep(5000); // 5 seconds
                } else {
                    Log.e(TAG, "Failed to update " + packageName + ", stopping sequential updates");
                    break; // Stop if update fails
                }
            } else {
                Log.d(TAG, packageName + " is up to date (version " + currentVersion + ")");
            }
        }
        
        Log.d(TAG, "apkUpdateNeeded: " + apkUpdateNeeded);
        
        // PHASE 2 & 3: Firmware updates (MTK first, then BES) - only if no APK update
        if (!apkUpdateNeeded) {
            JSONObject mtkPatch = null;
            boolean besUpdateAvailable = false;

            // ⚠️ DEBUG MODE: Force install MTK firmware from local file
            if (DEBUG_FORCE_MTK_INSTALL) {
                Log.w(TAG, "========================================");
                Log.w(TAG, "⚠️⚠️⚠️ DEBUG MODE ACTIVE ⚠️⚠️⚠️");
                Log.w(TAG, "Force installing MTK firmware from local file");
                Log.w(TAG, "Skipping version check and download");
                Log.w(TAG, "========================================");
                boolean mtkUpdateStarted = debugInstallMtkFirmware(context);
                if (mtkUpdateStarted) {
                    Log.i(TAG, "DEBUG: MTK firmware install triggered");
                } else {
                    Log.e(TAG, "DEBUG: MTK firmware install failed - check if file exists");
                }
            }
            // ⚠️ DEBUG MODE: Force install BES firmware from local file
            else if (DEBUG_FORCE_BES_INSTALL) {
                Log.w(TAG, "========================================");
                Log.w(TAG, "⚠️⚠️⚠️ DEBUG MODE ACTIVE ⚠️⚠️⚠️");
                Log.w(TAG, "Force installing BES firmware from local file");
                Log.w(TAG, "Skipping version check and download");
                Log.w(TAG, "========================================");
                boolean besUpdateStarted = debugInstallBesFirmware(context);
                if (besUpdateStarted) {
                    Log.i(TAG, "DEBUG: BES firmware install triggered");
                } else {
                    Log.e(TAG, "DEBUG: BES firmware install failed - check if file exists and BesOtaManager is available");
                }
            }
            // Normal firmware update flow with new patch matching logic
            else {
                Log.d(TAG, "Finding matching MTK patch");
                // Find matching MTK patch (MTK requires sequential updates)
                // Skip if MTK was already updated this session (A/B updates don't change version until reboot)
                // OR if MTK update is currently in progress
                if (wasMtkUpdatedThisSession()) {
                    Log.i(TAG, "📱 MTK already updated this session - skipping MTK check (reboot required to apply)");
                    mtkPatch = null;
                } else if (isMtkOtaInProgress()) {
                    Log.i(TAG, "📱 MTK update currently in progress - skipping MTK check");
                    mtkPatch = null;
                } else if (rootJson.has("mtk_patches")) {
                    String currentMtkVersion = SysProp.getProperty(context, "ro.custom.ota.version");
                    Log.d(TAG, "Current MTK version: " + currentMtkVersion);
                    mtkPatch = findMatchingMtkPatch(rootJson.getJSONArray("mtk_patches"), currentMtkVersion);
                    if (mtkPatch != null) {
                        Log.i(TAG, "MTK patch found for current version: " + currentMtkVersion);
                    }
                }

                // Check BES firmware (BES does not require sequential updates)
                // BES version comes from hs_syvr at boot, cached in AsgSettings
                if (rootJson.has("bes_firmware")) {
                    // Get BES version from AsgSettings (cached from hs_syvr response)
                    // AsgSettings uses SharedPreferences, so we can create a new instance to read the cached version
                    String currentBesVersion = "";
                    try {
                        AsgSettings asgSettings = new AsgSettings(context);
                        currentBesVersion = asgSettings.getBesFirmwareVersion();
                    } catch (Exception e) {
                        Log.e(TAG, "Error getting BES firmware version from AsgSettings", e);
                    }
                    besUpdateAvailable = checkBesUpdate(rootJson.getJSONObject("bes_firmware"), currentBesVersion);
                }

                // Apply updates in correct order
                if (mtkPatch != null && besUpdateAvailable) {
                    // Both available - MTK first, then BES after MTK completes
                    // BES update power-cycles the system, which also applies MTK A/B slot switch
                    Log.i(TAG, "Both MTK and BES updates available - applying MTK first, BES will follow");
                    
                    // Queue BES update to run after MTK completes
                    setPendingBesUpdate(rootJson.getJSONObject("bes_firmware"));
                    
                    // Start MTK update - OtaService will trigger BES after MTK SUCCESS
                    boolean mtkStarted = checkAndUpdateMtkFirmware(mtkPatch, context);
                    if (mtkStarted) {
                        Log.i(TAG, "MTK firmware update started - BES queued for after completion");
                    } else {
                        Log.e(TAG, "MTK firmware update failed to start - clearing pending BES");
                        clearPendingBesUpdate();
                    }
                } else if (mtkPatch != null) {
                    // Only MTK - apply normally (stages, needs manual reboot)
                    Log.i(TAG, "MTK update available - applying");
                    checkAndUpdateMtkFirmware(mtkPatch, context);
                } else if (besUpdateAvailable) {
                    // Only BES - check if MTK is in progress first
                    if (isMtkOtaInProgress()) {
                        // MTK system is still processing - can't start BES yet
                        if (wasMtkUpdatedThisSession()) {
                            // MTK update was initiated but system is still processing
                            // Tell phone MTK is still in progress (don't send FINISHED prematurely)
                            Log.i(TAG, "BES update available but MTK system still processing - MTK in progress");
                            if (isPhoneInitiatedOta) {
                                sendProgressToPhone("install", -1, 0, 0, "IN_PROGRESS", "mtk");
                            }
                        } else {
                            // MTK is actively being installed - queue BES for after
                            Log.i(TAG, "BES update available but MTK in progress - BES will start after MTK completes");
                            if (!hasPendingBesUpdate()) {
                                setPendingBesUpdate(rootJson.getJSONObject("bes_firmware"));
                            }
                            if (isPhoneInitiatedOta) {
                                sendProgressToPhone("install", -1, 0, 0, "IN_PROGRESS", "mtk");
                            }
                        }
                    } else {
                        // Only BES - apply normally (triggers power-cycle)
                        Log.i(TAG, "BES update available - applying");
                        checkAndUpdateBesFirmware(rootJson.getJSONObject("bes_firmware"), context);
                    }
                } else if (isMtkOtaInProgress()) {
                    // MTK is in progress (either actively installing or system processing after download)
                    // Don't send FINISHED - tell phone update is still in progress
                    Log.i(TAG, "MTK update currently in progress - system processing");
                    if (isPhoneInitiatedOta) {
                        sendProgressToPhone("install", -1, 0, 0, "IN_PROGRESS", "mtk");
                    }
                } else {
                    Log.i(TAG, "No firmware updates available");
                    // Send FINISHED to phone since no more updates
                    if (isPhoneInitiatedOta) {
                        sendProgressToPhone("install", 100, 0, 0, "FINISHED", null);
                    }
                }
            }
        } else {
            Log.i(TAG, "APK update performed - firmware checks will happen after restart");
        }
        
        Log.d(TAG, "Sequential updates completed (APK → MTK → BES)");
    }
    
    private long getInstalledVersion(String packageName, Context context) {
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageInfo(packageName, 0);
            return info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            Log.d(TAG, packageName + " not installed");
            return 0;
        }
    }
    
    private boolean checkAndUpdateApp(String packageName, JSONObject appInfo, Context context) {
        try {
            // Check for mutual exclusion - don't start APK update if firmware update in progress
            if (BesOtaManager.isBesOtaInProgress) {
                Log.w(TAG, "BES firmware update in progress - skipping APK update");
                return false;
            }
            
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update in progress - skipping APK update");
                return false;
            }
            
            long currentVersion = getInstalledVersion(packageName, context);
            long serverVersion = appInfo.getLong("versionCode");
            String apkUrl = appInfo.getString("apkUrl");
            
            Log.d(TAG, "Checking " + packageName + " - current: " + currentVersion + ", server: " + serverVersion);
            
            if (serverVersion > currentVersion) {
                // Set update flag to prevent concurrent updates
                isUpdating = true;
                Log.i(TAG, "Starting update process for " + packageName);
                
                // Delete old APK if exists
                String filename = packageName.equals(context.getPackageName()) 
                    ? "ota_updater_update.apk" 
                    : "asg_client_update.apk";
                File apkFile = new File(OtaConstants.BASE_DIR, filename);
                
                if (apkFile.exists()) {
                    Log.d(TAG, "Deleting existing APK: " + apkFile.getName());
                    apkFile.delete();
                }
                
                // Create backup before update
                createAppBackup(packageName, context);
                
                // Download new version
                boolean downloadOk = downloadApk(apkUrl, appInfo, context, filename);
                if (downloadOk) {
                    // Notify phone that install is starting
                    currentUpdateStage = "install";
                    sendProgressToPhone("install", 0, 0, 0, "STARTED", null);

                    // Send FINISHED before install - app will be killed during installation
                    // Phone will delay showing completion for 10 seconds
                    sendProgressToPhone("install", 100, 0, 0, "FINISHED", null);

                    // Install - this triggers system install and kills the app
                    installApk(context, apkFile.getAbsolutePath());
                    
                    // Clean up update file after 30 seconds
                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                        if (apkFile.exists()) {
                            boolean deleted = apkFile.delete();
                            Log.d(TAG, "Cleaned up update file " + filename + ": " + deleted);
                        }
                    }, 30000);
                    
                    return true;
                }
                // Download failed (e.g. after retries) - clear flag so next ota_start can run
                isUpdating = false;
                Log.d(TAG, "Download failed, cleared isUpdating for next OTA attempt");
            }
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Failed to update " + packageName, e);
            isUpdating = false;
            return false;
        }
    }
    
    private void createAppBackup(String packageName, Context context) {
        // Only backup ASG client - OTA updater can be restored from ASG client assets
        if (!packageName.equals("com.mentra.asg_client")) {
            Log.d(TAG, "Skipping backup for " + packageName + " (can be restored from assets)");
            return;
        }
        
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
            String sourceApk = info.applicationInfo.sourceDir;
            
            File backupFile = new File(OtaConstants.BASE_DIR, "asg_client_backup.apk");
            File sourceFile = new File(sourceApk);
            
            // Simple file copy
            FileInputStream fis = new FileInputStream(sourceFile);
            FileOutputStream fos = new FileOutputStream(backupFile);
            byte[] buffer = new byte[8192];
            int bytesRead;
            while ((bytesRead = fis.read(buffer)) != -1) {
                fos.write(buffer, 0, bytesRead);
            }
            fis.close();
            fos.close();
            
            Log.i(TAG, "Created backup for " + packageName + " at: " + backupFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to create backup for " + packageName, e);
        }
    }

    // Backward compatibility - default to "asg_client_update.apk"
    public boolean downloadApk(String urlStr, JSONObject json, Context context) {
        return downloadApk(urlStr, json, context, "asg_client_update.apk");
    }
    
    // Modified to accept custom filename for different apps
    public boolean downloadApk(String urlStr, JSONObject json, Context context, String filename) {
        int retryCount = 0;
        Exception lastException = null;
        
        while (retryCount < MAX_DOWNLOAD_RETRIES) {
            try {
                // Attempt download
                boolean success = downloadApkInternal(urlStr, json, context, filename);
                if (success) {
                    return true; // Success!
                }
                // If download succeeded but verification failed, don't retry
                // (downloadApkInternal already logged the error and deleted the file)
                Log.e(TAG, "Download succeeded but verification failed - not retrying");
                return false;
            } catch (Exception e) {
                lastException = e;
                Log.e(TAG, "Download attempt " + (retryCount + 1) + " failed", e);
                
                // Clean up partial download
                File partialFile = new File(OtaConstants.BASE_DIR, filename);
                if (partialFile.exists()) {
                    partialFile.delete();
                    Log.d(TAG, "Cleaned up partial download file");
                }
                
                retryCount++;
                if (retryCount < MAX_DOWNLOAD_RETRIES) {
                    Log.i(TAG, "Retrying download in " + (RETRY_DELAY_MS / 1000) + " seconds...");
                    
                    // Emit retry event
                    EventBus.getDefault().post(new DownloadProgressEvent(
                        DownloadProgressEvent.DownloadStatus.FAILED, 
                        "Retrying in " + (RETRY_DELAY_MS / 1000) + " seconds..."
                    ));
                    
                    try {
                        Thread.sleep(RETRY_DELAY_MS);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        }
        
        Log.e(TAG, "Download failed after " + MAX_DOWNLOAD_RETRIES + " attempts", lastException);
        EventBus.getDefault().post(new DownloadProgressEvent(
            DownloadProgressEvent.DownloadStatus.FAILED, 
            "Failed after " + MAX_DOWNLOAD_RETRIES + " attempts"
        ));
        return false;
    }
    
    // Internal download method (original logic)
    private boolean downloadApkInternal(String urlStr, JSONObject json, Context context, String filename) throws Exception {
        File asgDir = new File(OtaConstants.BASE_DIR);

        if (!asgDir.exists()) {
            boolean created = asgDir.mkdirs();
            Log.d(TAG, "ASG directory created: " + created);
        }

        File apkFile = new File(asgDir, filename);

        Log.d(TAG, "Download started ...");
        // Download new APK file
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.connect();

        InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(apkFile);

        byte[] buffer = new byte[4096];
        int len;
        long total = 0;
        long fileSize = conn.getContentLength();
        int lastProgress = 0;

        Log.d(TAG, "Download started, file size: " + fileSize + " bytes");

        // Set current update stage for phone progress
        currentUpdateStage = "download";
        currentUpdateType = "apk";

        // Emit download started event
        EventBus.getDefault().post(DownloadProgressEvent.createStarted(fileSize));

        while ((len = in.read(buffer)) > 0) {
            out.write(buffer, 0, len);
            total += len;

            // Calculate progress percentage
            int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;

            // Log progress at 5% intervals and emit progress events
            if (progress >= lastProgress + 5 || progress == 100) {
                Log.d(TAG, "Download progress: " + progress + "% (" + total + "/" + fileSize + " bytes)");
                // Emit progress event
                EventBus.getDefault().post(new DownloadProgressEvent(DownloadProgressEvent.DownloadStatus.PROGRESS, progress, total, fileSize));
                lastProgress = progress;
            }

            // Send progress to phone (throttled internally)
            sendProgressToPhone("download", progress, total, fileSize, "PROGRESS", null);
        }

        out.close();
        in.close();

        Log.d(TAG, "APK downloaded to: " + apkFile.getAbsolutePath());

        // IMPORTANT: Verify hash BEFORE declaring download complete to phone
        // This prevents the phone from thinking download succeeded when it actually failed
        boolean hashOk = verifyApkFile(apkFile.getAbsolutePath(), json);
        Log.d(TAG, "SHA256 verification result: " + hashOk);
        
        if (hashOk) {
            // Hash verified - NOW we can declare download finished
            EventBus.getDefault().post(DownloadProgressEvent.createFinished(fileSize));
            sendProgressToPhone("download", 100, fileSize, fileSize, "FINISHED", null);
            createMetaDataJson(json, context);
            return true;
        } else {
            Log.e(TAG, "Downloaded APK hash does not match expected value! Deleting APK.");
            if (apkFile.exists()) {
                boolean deleted = apkFile.delete();
                Log.d(TAG, "SHA256 mismatch – APK deleted: " + deleted);
            }
            // Emit local EventBus event for notification updates
            EventBus.getDefault().post(new DownloadProgressEvent(DownloadProgressEvent.DownloadStatus.FAILED, "SHA256 hash verification failed"));
            // CRITICAL: Send FAILED status to phone so frontend knows to handle retry
            sendProgressToPhone("download", 0, 0, 0, "FAILED", "SHA256 hash verification failed - please retry");
            return false;
        }
    }

    private boolean verifyApkFile(String apkPath, JSONObject jsonObject) {
        try {
            String expectedHash = jsonObject.getString("sha256");
            
            // Fail immediately if hash is a placeholder - prevents wasted downloads
            if (expectedHash == null || expectedHash.equals("example_sha256_hash_here") || 
                expectedHash.startsWith("example_")) {
                Log.e(TAG, "SHA256 hash is a placeholder - verification failed. Please provide a valid SHA256 hash.");
                return false;
            }

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            InputStream is = new FileInputStream(apkPath);
            byte[] buffer = new byte[4096];
            int read;
            while ((read = is.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
            is.close();

            byte[] hashBytes = digest.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) {
                sb.append(String.format("%02x", b));
            }
            String calculatedHash = sb.toString();

            Log.d(TAG, "Expected SHA256: " + expectedHash);
            Log.d(TAG, "Calculated SHA256: " + calculatedHash);

            boolean match = calculatedHash.equalsIgnoreCase(expectedHash);
            Log.d(TAG, "SHA256 check " + (match ? "passed" : "failed"));
            return match;
        } catch (Exception e) {
            Log.e(TAG, "SHA256 check error", e);
            return false;
        }
    }

    private void createMetaDataJson(JSONObject json, Context context) {
        long currentVersionCode;
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageInfo("com.mentra.asg_client", 0);
            currentVersionCode = info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            currentVersionCode = 0;
        }

        try {
            File jsonFile = new File(OtaConstants.BASE_DIR, OtaConstants.METADATA_JSON);
            FileWriter writer = new FileWriter(jsonFile);
            writer.write(json.toString(2)); // Pretty print
            writer.close();
            Log.d(TAG, "metadata.json saved at: " + jsonFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to write metadata.json", e);
        }
    }

    public void installApk(Context context) {
        installApk(context, OtaConstants.APK_FULL_PATH);
    }

    public static void installApk(Context context, String apkPath) {
        try {
//            if (apkPath.equals(Constants.APK_FULL_PATH)) {
//                checkOlderApkFile(context);
//            }
            Log.d(TAG, "Starting installation process for APK at: " + apkPath);
            
            // Emit installation started event
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.STARTED, apkPath));
            
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "install");
            intent.putExtra("pkpath", apkPath);
            intent.putExtra("recv_pkname", context.getPackageName());
            intent.putExtra("startapp", true);

            // Verify APK exists before sending broadcast
            File apkFile = new File(apkPath);
            if (!apkFile.exists()) {
                Log.e(TAG, "Installation failed: APK file not found at " + apkPath);
                // Emit installation failed event
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "APK file not found"));
                sendUpdateCompletedBroadcast(context);
                return;
            }

            // Verify APK is readable
            if (!apkFile.canRead()) {
                Log.e(TAG, "Installation failed: Cannot read APK file at " + apkPath);
                // Emit installation failed event
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Cannot read APK file"));
                sendUpdateCompletedBroadcast(context);
                return;
            }

            Log.d(TAG, "Sending install broadcast to system UI...");
            context.sendBroadcast(intent);
            Log.i(TAG, "Install broadcast sent successfully. System will handle installation.");
            // Note: FINISHED message is sent before installApk() is called in checkAndUpdateApp()
            // The app will be killed during installation, so no timer is needed here
        } catch (SecurityException e) {
            Log.e(TAG, "Security exception while sending install broadcast", e);
            // Emit installation failed event
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Security exception: " + e.getMessage()));
            // Make sure to send completion broadcast on error
            sendUpdateCompletedBroadcast(context);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send install broadcast", e);
            // Emit installation failed event
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Installation failed: " + e.getMessage()));
            // Make sure to send completion broadcast on error
            sendUpdateCompletedBroadcast(context);
        }
    }

    public void checkOlderApkFile(Context context) {
        PackageManager pm = context.getPackageManager();
        PackageInfo info = null;
        try {
            info = pm.getPackageInfo("com.mentra.asg_client", 0);
        } catch (PackageManager.NameNotFoundException e) {
            throw new RuntimeException(e);
        }
        long currentVersion = info.getLongVersionCode();
        if(currentVersion >= getMetadataVersion()){
            Log.d(TAG, "Already have a better version. removeing the APK file");
            deleteOldFiles();
        }
    }

    private void deleteOldFiles() {
        String apkFile = OtaConstants.BASE_DIR + "/" + OtaConstants.APK_FILENAME;
        String metaFile = OtaConstants.BASE_DIR + "/" + OtaConstants.METADATA_JSON ;
        //remove metaFile and apkFile
        File apk = new File(apkFile);
        File meta = new File(metaFile);
        if (apk.exists()) {
            boolean deleted = apk.delete();
            Log.d(TAG, "APK file deleted: " + deleted);
        }
        if (meta.exists()) {
            boolean deleted = meta.delete();
            Log.d(TAG, "Metadata file deleted: " + deleted);
        }
    }

    private int getMetadataVersion() {
        int localJsonVersion = 0;
        File metaDataJson = new File(OtaConstants.BASE_DIR, OtaConstants.METADATA_JSON);
        if (metaDataJson.exists()) {
            FileInputStream fis = null;
            try {
                fis = new FileInputStream(metaDataJson);
                byte[] data = new byte[(int) metaDataJson.length()];
                fis.read(data);
                fis.close();

                String jsonStr = new String(data, StandardCharsets.UTF_8);
                JSONObject json = new JSONObject(jsonStr);
                localJsonVersion = json.optInt("versionCode", 0);
            } catch (IOException | JSONException e) {
                e.printStackTrace();
            }
        }

        Log.d(TAG, "metadata version:"+localJsonVersion);
        return localJsonVersion;
    }

    public boolean reinstallApkFromBackup() {
        String backupPath = OtaConstants.BACKUP_APK_PATH;
        Log.d(TAG, "Attempting to reinstall APK from backup at: " + backupPath);

        File backupApk = new File(backupPath);
        if (!backupApk.exists()) {
            Log.e(TAG, "Backup APK not found at: " + backupPath);
            return false;
        }

        if (!backupApk.canRead()) {
            Log.e(TAG, "Cannot read backup APK at: " + backupPath);
            return false;
        }

        try {
            // Verify the backup APK is valid using getPackageArchiveInfo
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageArchiveInfo(backupPath, PackageManager.GET_ACTIVITIES);
            if (info == null) {
                Log.e(TAG, "Backup APK is not a valid Android package");
                return false;
            }

            // Install the backup APK
            Log.i(TAG, "Installing backup APK version: " + info.getLongVersionCode());
            installApk(context, backupPath);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to reinstall backup APK: " + e.getMessage(), e);
            return false;
        }
    }

    // Add a method to save the backup APK
    public boolean saveBackupApk(String sourceApkPath) {
        try {
            // Create backup directory if it doesn't exist
            File backupDir = new File(context.getFilesDir(), OtaConstants.BASE_DIR);
            if (!backupDir.exists()) {
                boolean created = backupDir.mkdirs();
                Log.d(TAG, "Created backup directory: " + created);
            }

            File backupApk = new File(backupDir, OtaConstants.BACKUP_APK_FILENAME);
            String backupPath = backupApk.getAbsolutePath();

            // Delete existing backup if it exists
            if (backupApk.exists()) {
                boolean deleted = backupApk.delete();
                Log.d(TAG, "Deleted existing backup: " + deleted);
            }

            // Copy the APK to backup location
            FileInputStream in = new FileInputStream(sourceApkPath);
            FileOutputStream out = new FileOutputStream(backupApk);
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            in.close();
            out.close();

            // Verify the backup was created successfully
            if (backupApk.exists() && backupApk.length() > 0) {
                Log.i(TAG, "Successfully saved backup APK to: " + backupPath);
                return true;
            } else {
                Log.e(TAG, "Failed to save backup APK - file not created or empty");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error saving backup APK", e);
            return false;
        }
    }

    // Send update completion broadcast with a delay to ensure proper sequencing
    private static void sendUpdateCompletedBroadcast(Context context) {
        try {
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    // Now send the completion broadcast
                    Intent completeIntent = new Intent(OtaConstants.ACTION_UPDATE_COMPLETED);
                    completeIntent.setPackage(context.getPackageName());
                    context.sendBroadcast(completeIntent);
                    Log.i(TAG, "Sent update completion broadcast");
                } catch (Exception e) {
                    Log.e(TAG, "Failed to send delayed update completion broadcast", e);
                } finally {
                    // Always clear the update flag when done
                    isUpdating = false;
                    Log.d(TAG, "Update process completed, ready for next check");
                }
            }, 1000); // 1 second delay between reset and completion
        } catch (Exception e) {
            Log.e(TAG, "Failed to send update reset broadcast", e);
            // Fallback direct completion broadcast
            try {
                Intent completeIntent = new Intent(OtaConstants.ACTION_UPDATE_COMPLETED);
                completeIntent.setPackage(context.getPackageName());
                context.sendBroadcast(completeIntent);
                Log.i(TAG, "Sent fallback update completion broadcast");
            } catch (Exception ex) {
                Log.e(TAG, "Failed to send fallback update completion broadcast", ex);
            } finally {
                // Make sure to clear flag even on error
                isUpdating = false;
            }
        }
    }
    
    // Battery status tracking variables
    private int glassesBatteryLevel = -1; // -1 means unknown
    private boolean glassesCharging = false;
    private long lastBatteryUpdateTime = 0;
    private boolean batteryCheckInProgress = false;
    private boolean lastBatteryCheckResult = true; // Default to allowing updates
    
    /**
     * EventBus subscriber for battery status updates from MainActivity
     * @param event Battery status event containing level, charging status, and timestamp
     */
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onBatteryStatusEvent(BatteryStatusEvent event) {
        Log.i(TAG, "🔋 Received BatteryStatusEvent: " + event);
        
        // Update local battery status variables
        glassesBatteryLevel = event.getBatteryLevel();
        glassesCharging = event.isCharging();
        lastBatteryUpdateTime = event.getTimestamp();
        
        // Update the battery check result based on current status
        lastBatteryCheckResult = isBatterySufficientForUpdates();
        
        // Mark battery check as complete
        batteryCheckInProgress = false;
        
        Log.i(TAG, "💾 Updated OtaHelper battery status - Level: " + glassesBatteryLevel + 
              "%, Charging: " + glassesCharging + ", Sufficient: " + lastBatteryCheckResult);
    }
    
    /**
     * Check if battery level is sufficient for OTA updates
     * This method uses the locally stored battery status from EventBus events
     * @return true if battery is sufficient, false if too low
     */
    private boolean isBatterySufficientForUpdates() {
        // If we don't have battery info, allow updates (fail-safe)
        if (glassesBatteryLevel == -1) {
            Log.w(TAG, "⚠️ No battery information available - allowing updates as fail-safe");
            return true;
        }
        
        // Block updates if battery < 5% and not charging
        if (glassesBatteryLevel < 5) {
            Log.w(TAG, "🚨 Battery insufficient for OTA updates: " + glassesBatteryLevel + 
                  "% - blocking updates");
            return false;
        }
        
        Log.i(TAG, "✅ Battery sufficient for OTA updates: " + glassesBatteryLevel + 
              "%");
        return true;
    }
    
    /**
     * Get current battery status as formatted string
     * @return formatted battery status string
     */
    public String getBatteryStatusString() {
        if (glassesBatteryLevel == -1) {
            return "Unknown";
        }
        return glassesBatteryLevel + "% " + (glassesCharging ? "(charging)" : "(not charging)");
    }
    
    /**
     * Get the last battery update time
     * @return timestamp of last battery update, or 0 if never updated
     */
    public long getLastBatteryUpdateTime() {
        return lastBatteryUpdateTime;
    }
    
    // ========== BES Firmware Update Methods ==========
    /**
     * Find MTK firmware patch matching the current version.
     * MTK requires sequential updates - must find patch starting from current version.
     * @param patches Array of patch objects with start_firmware, end_firmware, url
     * @param currentVersion Current MTK firmware version string (e.g., "20241130")
     * @return Matching patch object, or null if no match or version unknown
     */
    private JSONObject findMatchingMtkPatch(JSONArray patches, String currentVersion) {
        if (currentVersion == null || currentVersion.isEmpty()) {
            Log.w(TAG, "Cannot match MTK patch - current version unknown");
            return null;
        }

        try {
            for (int i = 0; i < patches.length(); i++) {
                JSONObject patch = patches.getJSONObject(i);
                String startFirmware = patch.getString("start_firmware");
                if (startFirmware.equals(currentVersion)) {
                    Log.i(TAG, "Found matching MTK patch: " + startFirmware + " -> " + patch.getString("end_firmware"));
                    return patch;
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing MTK patches", e);
            return null;
        }

        Log.i(TAG, "No MTK patch available for current version: " + currentVersion);
        return null;
    }

    /**
     * Check if BES firmware update is available.
     * BES does not require sequential updates - can install any newer version directly.
     * If current version is unknown, assume update is needed.
     * @param besFirmware Object with version and url
     * @param currentVersion Current BES version string (e.g., "17.26.1.14")
     * @return true if server version > current version, or if current version is unknown
     */
    private boolean checkBesUpdate(JSONObject besFirmware, String currentVersion) {
        try {
            String serverVersion = besFirmware.getString("version");
            
            // If current version is unknown, assume we need to update
            if (currentVersion == null || currentVersion.isEmpty()) {
                Log.i(TAG, "BES current version unknown - will update to server version: " + serverVersion);
                return true;
            }

            // Simple version string comparison - if server > current, update available
            int comparison = compareVersions(serverVersion, currentVersion);
            if (comparison > 0) {
                Log.i(TAG, "BES update available: " + currentVersion + " -> " + serverVersion);
                return true;
            } else {
                Log.i(TAG, "BES firmware is up to date (current: " + currentVersion + ", server: " + serverVersion + ")");
                return false;
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing BES firmware info", e);
            return false;
        }
    }

    /**
     * Compare two version strings.
     * Supports formats like "17.26.1.14" (BES) or "20241130" (MTK date format).
     * @param version1 First version string
     * @param version2 Second version string
     * @return positive if version1 > version2, negative if version1 < version2, 0 if equal
     */
    private int compareVersions(String version1, String version2) {
        // Simple lexicographic comparison works for both date format (YYYYMMDD) and dotted format
        // For dotted versions like "17.26.1.14", split and compare each component
        if (version1.contains(".") && version2.contains(".")) {
            String[] parts1 = version1.split("\\.");
            String[] parts2 = version2.split("\\.");
            int maxLen = Math.max(parts1.length, parts2.length);

            for (int i = 0; i < maxLen; i++) {
                int v1 = i < parts1.length ? Integer.parseInt(parts1[i]) : 0;
                int v2 = i < parts2.length ? Integer.parseInt(parts2[i]) : 0;
                if (v1 != v2) {
                    return Integer.compare(v1, v2);
                }
            }
            return 0;
        } else {
            // For date format or simple strings, use lexicographic comparison
            return version1.compareTo(version2);
        }
    }

    /**
     * Check and update BES firmware if newer version available
     * @param firmwareInfo JSON object with firmware metadata
     * @param context Application context
     * @return true if update started successfully
     */
    private boolean checkAndUpdateBesFirmware(JSONObject firmwareInfo, Context context) {
        try {
            // Check for mutual exclusion - don't start firmware update if APK update in progress
            if (isUpdating) {
                Log.w(TAG, "APK update in progress - skipping BES firmware update");
                return false;
            }
            
            // Check if BES OTA already in progress
            if (BesOtaManager.isBesOtaInProgress) {
                Log.w(TAG, "BES firmware update already in progress");
                return false;
            }
            
            // Check if MTK OTA in progress
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update in progress - skipping BES firmware update");
                return false;
            }
            
            // Check version (optional - BES may not always report version reliably)
            long serverVersion = firmwareInfo.optLong("versionCode", 0);
            String versionName = firmwareInfo.optString("versionName", "unknown");
            
            Log.i(TAG, "BES firmware available - Version: " + versionName + " (code: " + serverVersion + ")");
            
            // Get current firmware version from BES device
            byte[] currentVersion = BesOtaManager.getCurrentFirmwareVersion();
            byte[] serverVersionBytes = BesOtaManager.parseServerVersionCode(serverVersion);
            
            // Compare versions if both available
            if (currentVersion != null && serverVersionBytes != null) {
                boolean isNewer = BesOtaManager.isNewerVersion(serverVersionBytes, currentVersion);
                Log.d(TAG, "Current firmware: " + (currentVersion[0] & 0xFF) + "." + 
                      (currentVersion[1] & 0xFF) + "." + (currentVersion[2] & 0xFF) + "." + (currentVersion[3] & 0xFF));
                Log.d(TAG, "Server firmware: " + (serverVersionBytes[0] & 0xFF) + "." + 
                      (serverVersionBytes[1] & 0xFF) + "." + (serverVersionBytes[2] & 0xFF) + "." + (serverVersionBytes[3] & 0xFF));
                
                if (!isNewer) {
                    Log.i(TAG, "Server firmware version is not newer - skipping update");
                    return false;
                }
                Log.i(TAG, "Server firmware version is newer - proceeding with update");
            } else if (currentVersion == null) {
                Log.w(TAG, "Current firmware version not available - proceeding with update anyway");
            }
            
            // Set current update type for progress reporting
            currentUpdateType = "bes";

            // Download firmware file (support both "url" and legacy "firmwareUrl")
            String firmwareUrl = firmwareInfo.optString("url", firmwareInfo.optString("firmwareUrl", ""));
            if (firmwareUrl.isEmpty()) {
                Log.e(TAG, "BES firmware URL missing in JSON (expected 'url' or 'firmwareUrl')");
                return false;
            }
            boolean downloaded = downloadBesFirmware(firmwareUrl, firmwareInfo, context);

            if (downloaded) {
                Log.i(TAG, "BES firmware download complete - starting install phase");
                
                // Start firmware update via BesOtaManager singleton
                // Install progress will be sent to phone via sr_adota from BES chip (via BLE)
                BesOtaManager manager = BesOtaManager.getInstance();
                if (manager != null) {
                    Log.i(TAG, "Starting BES firmware update from: " + OtaConstants.BES_FIRMWARE_PATH);
                    boolean started = manager.startFirmwareUpdate(OtaConstants.BES_FIRMWARE_PATH);
                    if (started) {
                        Log.i(TAG, "BES firmware update initiated successfully");
                        return true;
                    } else {
                        Log.e(TAG, "Failed to start BES firmware update");
                    }
                } else {
                    Log.e(TAG, "BesOtaManager not available");
                }
            } else {
                Log.e(TAG, "Failed to download BES firmware");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to update BES firmware", e);
        }
        return false;
    }
    
    /**
     * Download BES firmware file from server
     * @param firmwareUrl URL to download firmware from
     * @param firmwareInfo JSON metadata about the firmware
     * @param context Application context
     * @return true if downloaded and verified successfully
     */
    private boolean downloadBesFirmware(String firmwareUrl, JSONObject firmwareInfo, Context context) {
        try {
            File asgDir = new File(OtaConstants.BASE_DIR);
            if (!asgDir.exists()) {
                boolean created = asgDir.mkdirs();
                Log.d(TAG, "ASG directory created: " + created);
            }
            
            File firmwareFile = new File(asgDir, OtaConstants.BES_FIRMWARE_FILENAME);
            
            // Delete old firmware if exists
            if (firmwareFile.exists()) {
                Log.d(TAG, "Deleting existing firmware file");
                firmwareFile.delete();
            }
            
            Log.d(TAG, "Downloading BES firmware from: " + firmwareUrl);
            
            // Download firmware file
            URL url = new URL(firmwareUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.connect();
            
            long fileSize = conn.getContentLength();
            
            // Check file size doesn't exceed 2MB (BES firmware can be larger than 1MB)
            if (fileSize > 2 * 1024 * 1024) {
                Log.e(TAG, "Firmware file too large: " + fileSize + " bytes (max 2MB)");
                conn.disconnect();
                return false;
            }
            
            InputStream in = conn.getInputStream();
            FileOutputStream out = new FileOutputStream(firmwareFile);
            
            byte[] buffer = new byte[4096];
            int len;
            long total = 0;
            int lastProgress = 0;
            
            Log.d(TAG, "Downloading BES firmware, size: " + fileSize + " bytes");
            
            // Set update type for progress reporting
            currentUpdateType = "bes";
            
            // Send download started to phone
            sendProgressToPhone("download", 0, 0, fileSize, "STARTED", null);
            
            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
                total += len;
                
                // Log progress at 10% intervals
                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "BES firmware download progress: " + progress + "%");
                    
                    // Send progress to phone
                    sendProgressToPhone("download", progress, total, fileSize, "PROGRESS", null);
                    
                    lastProgress = progress;
                }
            }
            
            // Send download finished to phone
            sendProgressToPhone("download", 100, fileSize, fileSize, "FINISHED", null);
            
            out.close();
            in.close();
            conn.disconnect();
            
            Log.d(TAG, "BES firmware downloaded to: " + firmwareFile.getAbsolutePath());
            
            // Verify SHA256 hash
            boolean verified = verifyFirmwareFile(firmwareFile.getAbsolutePath(), firmwareInfo);
            if (verified) {
                Log.i(TAG, "Firmware file verified successfully");
                return true;
            } else {
                Log.e(TAG, "Firmware verification failed - deleting file");
                firmwareFile.delete();
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error downloading BES firmware", e);
            return false;
        }
    }
    
    /**
     * Verify BES firmware file integrity using SHA256
     * @param filePath Path to firmware file
     * @param firmwareInfo JSON metadata containing expected SHA256
     * @return true if hash matches
     */
    private boolean verifyFirmwareFile(String filePath, JSONObject firmwareInfo) {
        try {
            String expectedHash = firmwareInfo.getString("sha256");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            InputStream is = new FileInputStream(filePath);
            byte[] buffer = new byte[4096];
            int read;
            while ((read = is.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
            is.close();
            
            byte[] hashBytes = digest.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) {
                sb.append(String.format("%02x", b));
            }
            String calculatedHash = sb.toString();
            
            Log.d(TAG, "Expected firmware SHA256: " + expectedHash);
            Log.d(TAG, "Calculated firmware SHA256: " + calculatedHash);
            
            boolean match = calculatedHash.equalsIgnoreCase(expectedHash);
            Log.d(TAG, "Firmware SHA256 check " + (match ? "passed" : "failed"));
            return match;
        } catch (Exception e) {
            Log.e(TAG, "Firmware SHA256 check error", e);
            return false;
        }
    }
    
    // ========== MTK Firmware Update Methods ==========
    
    /**
     * Check and update MTK firmware if newer version available
     * @param firmwareInfo JSON object with firmware metadata (either patch object or legacy firmware info)
     * @param context Application context
     * @return true if update started successfully
     */
    private boolean checkAndUpdateMtkFirmware(JSONObject firmwareInfo, Context context) {
        try {
            // Check for mutual exclusion - don't start MTK update if other updates in progress
            if (isUpdating) {
                Log.w(TAG, "APK update in progress - skipping MTK firmware update");
                return false;
            }
            
            if (BesOtaManager.isBesOtaInProgress) {
                Log.w(TAG, "BES firmware update in progress - skipping MTK firmware update");
                return false;
            }
            
            // Check if MTK OTA already in progress
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update already in progress");
                return false;
            }
            
            // Detect if this is a patch object (from findMatchingMtkPatch) or legacy firmware info
            // Patch objects have start_firmware/end_firmware fields and are already version-matched
            boolean isPatchObject = firmwareInfo.has("start_firmware");
            
            if (isPatchObject) {
                // Patch object - version matching already done by findMatchingMtkPatch()
                String startFirmware = firmwareInfo.optString("start_firmware", "unknown");
                String endFirmware = firmwareInfo.optString("end_firmware", "unknown");
                Log.i(TAG, "MTK patch update: " + startFirmware + " -> " + endFirmware);
            } else {
                // Legacy firmware info with versionCode - do numeric comparison
                long serverVersion = firmwareInfo.optLong("versionCode", 0);
                String versionName = firmwareInfo.optString("versionName", "unknown");
                
                Log.i(TAG, "MTK firmware available - Version: " + versionName + " (code: " + serverVersion + ")");
                
                // Get current MTK firmware version from system property
                String currentVersionStr = SysProp.getProperty(context, "ro.custom.ota.version");
                long currentVersion = 0;
                
                try {
                    currentVersion = Long.parseLong(currentVersionStr);
                } catch (NumberFormatException e) {
                    Log.w(TAG, "Could not parse current MTK version: " + currentVersionStr);
                }
                
                Log.d(TAG, "Current MTK firmware version: " + currentVersionStr + " (parsed: " + currentVersion + ")");
                Log.d(TAG, "Server MTK firmware version: " + serverVersion);
                
                // Compare versions
                if (serverVersion > currentVersion) {
                    Log.i(TAG, "Server MTK firmware version is newer - proceeding with update");
                } else {
                    Log.i(TAG, "MTK firmware is up to date - skipping update");
                    return false;
                }
            }
            
            // Set current update type for progress reporting
            currentUpdateType = "mtk";

            // Download firmware file (support both "url" and legacy "firmwareUrl")
            String firmwareUrl = firmwareInfo.optString("url", firmwareInfo.optString("firmwareUrl", ""));
            if (firmwareUrl.isEmpty()) {
                Log.e(TAG, "MTK firmware URL missing in JSON (expected 'url' or 'firmwareUrl')");
                return false;
            }
            boolean downloaded = downloadMtkFirmware(firmwareUrl, firmwareInfo, context);
            
            if (downloaded) {
                Log.i(TAG, "✅ MTK firmware download complete");
                
                // Set flag before starting update
                isMtkOtaInProgress = true;
                
                // Mark MTK as updated this session (install will happen in background)
                setMtkUpdatedThisSession();
                
                // Send install STARTED to phone - progress updates will follow during install
                sendMtkInstallProgressToPhone("STARTED", 0, null);
                Log.i(TAG, "📱 Sent MTK install STARTED to phone - waiting 1s before starting install");
                
                // Wait 1 second for phone to process FINISHED, then start install
                final Context ctx = context;
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    Log.i(TAG, "Starting MTK firmware update from: " + OtaConstants.MTK_FIRMWARE_PATH);
                    com.mentra.asg_client.SysControl.installOTA(ctx, OtaConstants.MTK_FIRMWARE_PATH);
                    Log.i(TAG, "MTK firmware update initiated - system will handle in background");
                }, 1000); // 1 second delay
                
                return true;
            } else {
                Log.e(TAG, "Failed to download MTK firmware");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to update MTK firmware", e);
            isMtkOtaInProgress = false;
        }
        return false;
    }
    
    /**
     * Download MTK firmware zip file from server
     * @param firmwareUrl URL to download firmware from
     * @param firmwareInfo JSON metadata about the firmware
     * @param context Application context
     * @return true if downloaded and verified successfully
     */
    private boolean downloadMtkFirmware(String firmwareUrl, JSONObject firmwareInfo, Context context) {
        try {
            File asgDir = new File(OtaConstants.BASE_DIR);
            if (!asgDir.exists()) {
                boolean created = asgDir.mkdirs();
                Log.d(TAG, "ASG directory created: " + created);
            }
            
            File firmwareFile = new File(asgDir, OtaConstants.MTK_FIRMWARE_FILENAME);
            
            // Create backup of existing firmware if it exists
            if (firmwareFile.exists()) {
                File backupFile = new File(asgDir, OtaConstants.MTK_BACKUP_FILENAME);
                Log.d(TAG, "Creating backup of existing MTK firmware");
                if (backupFile.exists()) {
                    backupFile.delete();
                }
                firmwareFile.renameTo(backupFile);
            }
            
            Log.d(TAG, "Downloading MTK firmware from: " + firmwareUrl);
            
            // Download firmware file
            URL url = new URL(firmwareUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.connect();
            
            long fileSize = conn.getContentLength();
            
            // Check file size is reasonable (max 100MB for MTK firmware)
            if (fileSize > 100 * 1024 * 1024) {
                Log.e(TAG, "MTK firmware file too large: " + fileSize + " bytes (max 100MB)");
                conn.disconnect();
                return false;
            }
            
            InputStream in = conn.getInputStream();
            FileOutputStream out = new FileOutputStream(firmwareFile);
            
            byte[] buffer = new byte[8192];
            int len;
            long total = 0;
            int lastProgress = 0;
            
            Log.d(TAG, "Downloading MTK firmware, size: " + fileSize + " bytes");
            
            // Set update type for progress reporting
            currentUpdateType = "mtk";
            
            // Send download started to phone
            sendProgressToPhone("download", 0, 0, fileSize, "STARTED", null);
            
            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
                total += len;
                
                // Log progress at 10% intervals
                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "MTK firmware download progress: " + progress + "%");
                    
                    // Post download progress event
                    EventBus.getDefault().post(new DownloadProgressEvent(
                        DownloadProgressEvent.DownloadStatus.PROGRESS,
                        progress,
                        total,
                        fileSize
                    ));
                    
                    // Send progress to phone
                    sendProgressToPhone("download", progress, total, fileSize, "PROGRESS", null);
                    
                    lastProgress = progress;
                }
            }
            
            // Send download finished to phone
            sendProgressToPhone("download", 100, fileSize, fileSize, "FINISHED", null);
            
            out.close();
            in.close();
            conn.disconnect();
            
            Log.i(TAG, "MTK firmware downloaded to: " + firmwareFile.getAbsolutePath());
            
            // Verify SHA256 hash
            boolean verified = verifyMtkFirmwareChecksum(firmwareFile.getAbsolutePath(), firmwareInfo);
            if (verified) {
                Log.i(TAG, "MTK firmware file verified successfully");
                return true;
            } else {
                Log.e(TAG, "MTK firmware verification failed - deleting file");
                firmwareFile.delete();
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to download MTK firmware", e);
            return false;
        }
    }
    
    /**
     * Verify MTK firmware zip file checksum
     * @param filePath Path to firmware file
     * @param firmwareInfo JSON with expected sha256
     * @return true if checksum matches
     */
    private boolean verifyMtkFirmwareChecksum(String filePath, JSONObject firmwareInfo) {
        try {
            String expectedHash = firmwareInfo.optString("sha256", "");
            if (expectedHash.isEmpty()) {
                Log.w(TAG, "No SHA256 hash provided for MTK firmware - skipping verification");
                return true;
            }
            
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            FileInputStream is = new FileInputStream(filePath);
            
            byte[] buffer = new byte[8192];
            int read;
            while ((read = is.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
            is.close();
            
            byte[] hashBytes = digest.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) {
                sb.append(String.format("%02x", b));
            }
            String calculatedHash = sb.toString();
            
            Log.d(TAG, "Expected MTK firmware SHA256: " + expectedHash);
            Log.d(TAG, "Calculated MTK firmware SHA256: " + calculatedHash);
            
            boolean match = calculatedHash.equalsIgnoreCase(expectedHash);
            Log.d(TAG, "MTK firmware SHA256 check " + (match ? "passed" : "failed"));
            return match;
        } catch (Exception e) {
            Log.e(TAG, "MTK firmware SHA256 check error", e);
            return false;
        }
    }
    
    // ========== MTK Firmware Update State Management ==========
    
    /**
     * Set MTK OTA in progress flag
     * Called by MtkOtaReceiver when update completes or fails
     * @param inProgress true if MTK OTA is in progress, false otherwise
     */
    public static void setMtkOtaInProgress(boolean inProgress) {
        isMtkOtaInProgress = inProgress;
        Log.d(TAG, "MTK OTA in progress flag set to: " + inProgress);
    }
    
    /**
     * Check if MTK OTA is in progress
     * @return true if MTK OTA update is in progress
     */
    public static boolean isMtkOtaInProgress() {
        return isMtkOtaInProgress;
    }
    
    // ========== Phone-Controlled OTA Methods ==========

    /**
     * Check for available updates and return info without downloading.
     * Used by background mode to notify phone of available updates.
     * @param rootJson The root version.json object
     * @return JSONObject with update info, or null if no updates available
     */
    private JSONObject checkForAvailableUpdates(JSONObject rootJson) {
        try {
            JSONObject result = new JSONObject();
            JSONArray updatesArray = new JSONArray();
            long totalSize = 0;
            long latestVersionCode = 0;
            String latestVersionName = "";

            // Check APK updates
            if (rootJson.has("apps")) {
                JSONObject apps = rootJson.getJSONObject("apps");

                // Check asg_client
                JSONObject asgClient = apps.optJSONObject("com.mentra.asg_client");
                if (asgClient != null) {
                    long currentVersion = getInstalledVersion("com.mentra.asg_client", context);
                    long serverVersion = asgClient.getLong("versionCode");
                    if (serverVersion > currentVersion) {
                        updatesArray.put("apk");
                        totalSize += asgClient.optLong("apkSize", 0);
                        latestVersionCode = serverVersion;
                        latestVersionName = asgClient.optString("versionName", "");
                    }
                }

                // Check ota_updater
                JSONObject otaUpdater = apps.optJSONObject("com.augmentos.otaupdater");
                if (otaUpdater != null) {
                    long currentVersion = getInstalledVersion("com.augmentos.otaupdater", context);
                    long serverVersion = otaUpdater.getLong("versionCode");
                    if (serverVersion > currentVersion) {
                        // Include in APK updates (don't add separate entry, just size)
                        totalSize += otaUpdater.optLong("apkSize", 0);
                    }
                }
            }

            // Check MTK firmware patches (sequential updates)
            if (rootJson.has("mtk_patches")) {
                JSONArray mtkPatches = rootJson.getJSONArray("mtk_patches");
                String currentMtkVersion = SysProp.getProperty(context, "ro.custom.ota.version");
                JSONObject matchingPatch = findMatchingMtkPatch(mtkPatches, currentMtkVersion);
                if (matchingPatch != null) {
                    updatesArray.put("mtk");
                    // Note: Patch file size not available in new schema
                    // Could add fileSize field to patch objects if needed for totalSize calculation
                }
            }

            // Check BES firmware (does not require sequential updates)
            if (rootJson.has("bes_firmware")) {
                JSONObject besFirmware = rootJson.getJSONObject("bes_firmware");
                // Get BES version from AsgSettings (cached from hs_syvr response)
                // AsgSettings uses SharedPreferences, so we can create a new instance to read the cached version
                String currentBesVersion = "";
                try {
                    AsgSettings asgSettings = new AsgSettings(context);
                    currentBesVersion = asgSettings.getBesFirmwareVersion();
                } catch (Exception e) {
                    Log.e(TAG, "Error getting BES firmware version from AsgSettings", e);
                }
                
                if (checkBesUpdate(besFirmware, currentBesVersion)) {
                        updatesArray.put("bes");
                    // Note: File size not available in new schema
                }
            }

            if (updatesArray.length() > 0) {
                result.put("available", true);
                result.put("version_code", latestVersionCode);
                result.put("version_name", latestVersionName);
                result.put("updates", updatesArray);
                result.put("total_size", totalSize);
                Log.i(TAG, "📱 Updates available: " + updatesArray.toString());
                return result;
            }

            result.put("available", false);
            return result;
        } catch (Exception e) {
            Log.e(TAG, "Error checking for available updates", e);
            return null;
        }
    }

    /**
     * Notify phone that an update is available (background mode).
     * @param updateInfo JSON with update details
     */
    private void notifyPhoneUpdateAvailable(JSONObject updateInfo) {
        if (phoneConnectionProvider == null) return;

        try {
            updateInfo.put("type", "ota_update_available");

            phoneConnectionProvider.sendOtaUpdateAvailable(updateInfo);
            Log.i(TAG, "📱 Notified phone of available update: " + updateInfo.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Failed to notify phone of update", e);
        }
    }

    /**
     * Send OTA progress update to phone with throttling.
     * Sends every 2 seconds OR every 5% change, whichever comes first.
     * Always sends STARTED, FINISHED, FAILED status immediately.
     *
     * @param stage Current stage: "download" or "install"
     * @param progress Progress percentage (0-100)
     * @param bytesDownloaded Bytes downloaded so far
     * @param totalBytes Total bytes to download
     * @param status Status: "STARTED", "PROGRESS", "FINISHED", "FAILED"
     * @param errorMessage Error message if status is FAILED
     */
    private void sendProgressToPhone(String stage, int progress, long bytesDownloaded,
                                     long totalBytes, String status, String errorMessage) {
        if (phoneConnectionProvider == null || !isPhoneConnected()) {
            return;
        }

        long now = System.currentTimeMillis();
        boolean shouldSend = false;

        // Always send STARTED, FINISHED, FAILED immediately
        if ("STARTED".equals(status) || "FINISHED".equals(status) || "FAILED".equals(status)) {
            shouldSend = true;
        }
        // For PROGRESS, throttle: every 2s OR every 5%
        else if ("PROGRESS".equals(status)) {
            boolean timeElapsed = (now - lastProgressSentTime) >= PROGRESS_MIN_INTERVAL_MS;
            boolean percentChanged = Math.abs(progress - lastProgressSentPercent) >= PROGRESS_MIN_CHANGE_PERCENT;
            shouldSend = timeElapsed || percentChanged || progress == 100;
        }

        if (!shouldSend) {
            return;
        }

        try {
            JSONObject progressInfo = new JSONObject();
            progressInfo.put("type", "ota_progress");
            progressInfo.put("stage", stage);
            progressInfo.put("status", status);
            progressInfo.put("progress", progress);
            progressInfo.put("bytes_downloaded", bytesDownloaded);
            progressInfo.put("total_bytes", totalBytes);
            progressInfo.put("current_update", currentUpdateType);
            if (errorMessage != null) {
                progressInfo.put("error_message", errorMessage);
            }

            phoneConnectionProvider.sendOtaProgress(progressInfo);

            lastProgressSentTime = now;
            lastProgressSentPercent = progress;

            Log.d(TAG, "📱 Sent OTA progress: " + stage + " " + status + " " + progress + "%");
        } catch (JSONException e) {
            Log.e(TAG, "Failed to send OTA progress", e);
        }
    }

    /**
     * Send MTK installation progress to phone.
     * Called by OtaService when receiving MTK OTA progress events.
     * 
     * @param status Status: "STARTED", "PROGRESS", "FINISHED", "FAILED"
     * @param progress Progress percentage (0-100)
     * @param message Optional message
     */
    public void sendMtkInstallProgressToPhone(String status, int progress, String message) {
        currentUpdateType = "mtk";
        sendProgressToPhone("install", progress, 0, 0, status, 
            "FAILED".equals(status) ? message : null);
    }

    /**
     * Send BES installation progress to phone.
     * Note: During BES OTA, UART is busy so this will likely fail for PROGRESS messages.
     * BES install progress is sent via sr_adota from BES chip directly via BLE.
     * This method is mainly used for FAILED status when we need to notify phone of errors.
     * 
     * @param status Status: "STARTED", "PROGRESS", "FINISHED", "FAILED"
     * @param progress Progress percentage (0-100)
     * @param message Optional message
     */
    public void sendBesInstallProgressToPhone(String status, int progress, String message) {
        currentUpdateType = "bes";
        sendProgressToPhone("install", progress, 0, 0, status, 
            "FAILED".equals(status) ? message : null);
    }

    /**
     * Static method to send MTK installation progress to phone.
     * Used by MtkOtaReceiver which doesn't have access to OtaHelper instance.
     * 
     * @param provider Phone connection provider
     * @param status Status: "STARTED", "PROGRESS", "FINISHED", "FAILED"  
     * @param progress Progress percentage (0-100)
     * @param message Optional message
     */
    public static void sendMtkInstallProgress(PhoneConnectionProvider provider, 
                                               String status, int progress, String message) {
        if (provider == null || !provider.isPhoneConnected()) {
            Log.d(TAG, "📱 Cannot send MTK install progress - phone not connected");
            return;
        }
        
        try {
            JSONObject progressInfo = new JSONObject();
            progressInfo.put("type", "ota_progress");
            progressInfo.put("stage", "install");
            progressInfo.put("status", status);
            progressInfo.put("progress", progress);
            progressInfo.put("current_update", "mtk");
            if (message != null && "FAILED".equals(status)) {
                progressInfo.put("error_message", message);
            }

            provider.sendOtaProgress(progressInfo);
            Log.d(TAG, "📱 Sent MTK install progress: " + status + " " + progress + "%");
        } catch (JSONException e) {
            Log.e(TAG, "Failed to send MTK install progress", e);
        }
    }

    // ========== Pending BES Update Methods ==========

    /**
     * Check if there's a pending BES update waiting to be installed.
     * Used after MTK update completes to chain BES update.
     * @return true if BES update is pending
     */
    public boolean hasPendingBesUpdate() {
        return pendingBesUpdate != null;
    }

    /**
     * Start the pending BES update.
     * Called by OtaService after MTK update completes successfully.
     * BES update will power-cycle the system, which also applies the MTK A/B slot switch.
     */
    public void startPendingBesUpdate() {
        if (pendingBesUpdate == null) {
            Log.w(TAG, "📱 startPendingBesUpdate called but no pending BES update");
            return;
        }

        Log.i(TAG, "📱 Starting pending BES update after MTK completion");
        JSONObject besInfo = pendingBesUpdate;
        pendingBesUpdate = null; // Clear pending to prevent re-trigger

        // Start BES update on background thread
        new Thread(() -> {
            checkAndUpdateBesFirmware(besInfo, context);
        }).start();
    }

    /**
     * Set pending BES update to be executed after MTK completes.
     * @param besFirmwareInfo BES firmware JSON object
     */
    private void setPendingBesUpdate(JSONObject besFirmwareInfo) {
        this.pendingBesUpdate = besFirmwareInfo;
        Log.i(TAG, "📱 BES update queued - will start after MTK completes");
    }

    /**
     * Clear any pending BES update (e.g., on error or cleanup)
     */
    public void clearPendingBesUpdate() {
        this.pendingBesUpdate = null;
    }

    // ========== MTK Session Tracking ==========

    /**
     * Mark that MTK was updated this session.
     * Called by OtaService when MTK update succeeds.
     * Prevents re-downloading the same MTK update before reboot.
     */
    public static void setMtkUpdatedThisSession() {
        mtkUpdatedThisSession = true;
        Log.i(TAG, "📱 MTK updated this session - will skip MTK checks until reboot");
    }

    /**
     * Check if MTK was already updated this session.
     * @return true if MTK was updated and glasses haven't rebooted yet
     */
    public static boolean wasMtkUpdatedThisSession() {
        return mtkUpdatedThisSession;
    }

    /**
     * Clear the MTK session flag.
     * This is called automatically on app restart (static variable resets).
     * Can also be called manually if needed.
     */
    public static void clearMtkSessionFlag() {
        mtkUpdatedThisSession = false;
        Log.d(TAG, "📱 MTK session flag cleared");
    }

    // ========== DEBUG METHODS ==========

    /**
     * DEBUG: Force install MTK firmware from local zip file without any checks
     * Skips version checking, downloading, and mutual exclusion
     * Use for testing only!
     * 
     * @param context Application context
     * @return true if install command was sent successfully
     */
    public static boolean debugInstallMtkFirmware(Context context) {
        try {
            File firmwareFile = new File(OtaConstants.MTK_FIRMWARE_PATH);
            
            if (!firmwareFile.exists()) {
                Log.e(TAG, "DEBUG: MTK firmware file not found at: " + OtaConstants.MTK_FIRMWARE_PATH);
                return false;
            }
            
            Log.w(TAG, "⚠️ DEBUG: Force installing MTK firmware from: " + OtaConstants.MTK_FIRMWARE_PATH);
            Log.w(TAG, "⚠️ DEBUG: Skipping all checks - version, mutual exclusion, SHA256");
            
            // Set flag
            isMtkOtaInProgress = true;
            
            // Post started event
            EventBus.getDefault().post(com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent.createStarted());
            
            // Trigger MTK OTA installation via system broadcast
            com.mentra.asg_client.SysControl.installOTA(context, OtaConstants.MTK_FIRMWARE_PATH);
            
            Log.i(TAG, "DEBUG: MTK firmware install command sent - monitor MtkOtaReceiver for progress");
            return true;

        } catch (Exception e) {
            Log.e(TAG, "DEBUG: Failed to install MTK firmware", e);
            isMtkOtaInProgress = false;
            return false;
        }
    }

    /**
     * Debug method to install BES firmware from local file without any checks.
     * This bypasses:
     * - Version checking
     * - Mutual exclusion checks (APK/MTK updates)
     * - SHA256 verification
     * - Download step
     *
     * The firmware file must already exist at: /storage/emulated/0/asg/bes_firmware.bin
     * Use for testing only!
     *
     * @param context Application context
     * @return true if install started successfully
     */
    public static boolean debugInstallBesFirmware(Context context) {
        try {
            // Check if BES OTA is already in progress - don't interrupt it!
            if (BesOtaManager.isBesOtaInProgress) {
                Log.w(TAG, "DEBUG: BES OTA already in progress - skipping to avoid interruption");
                return false;
            }

            File firmwareFile = new File(OtaConstants.BES_FIRMWARE_PATH);

            if (!firmwareFile.exists()) {
                Log.e(TAG, "DEBUG: BES firmware file not found at: " + OtaConstants.BES_FIRMWARE_PATH);
                return false;
            }

            Log.w(TAG, "⚠️ DEBUG: Force installing BES firmware from: " + OtaConstants.BES_FIRMWARE_PATH);
            Log.w(TAG, "⚠️ DEBUG: File size: " + firmwareFile.length() + " bytes");
            Log.w(TAG, "⚠️ DEBUG: Skipping all checks - version, mutual exclusion, SHA256");

            // Get BesOtaManager singleton
            BesOtaManager manager = BesOtaManager.getInstance();
            if (manager == null) {
                Log.e(TAG, "DEBUG: BesOtaManager not available - is this a K900 device?");
                return false;
            }

            Log.i(TAG, "DEBUG: Starting BES firmware update via BesOtaManager");
            boolean started = manager.startFirmwareUpdate(OtaConstants.BES_FIRMWARE_PATH);

            if (started) {
                Log.i(TAG, "DEBUG: BES firmware install initiated - monitor BesOtaProgressEvent for progress");
                return true;
            } else {
                Log.e(TAG, "DEBUG: BesOtaManager.startFirmwareUpdate() returned false");
                return false;
            }

        } catch (Exception e) {
            Log.e(TAG, "DEBUG: Failed to install BES firmware", e);
            return false;
        }
    }
}
