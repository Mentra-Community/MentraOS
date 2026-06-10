package com.mentra.asg_client.io.ota.helpers;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
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
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import java.util.concurrent.locks.ReentrantLock;

import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.io.ota.utils.FirmwareDownloadException;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.service.utils.SysProp;
import com.mentra.asg_client.utils.WakeLockManager;

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
         * Send a small OTA control payload that is not session state (e.g. {@code ota_start_ack}).
         * All install/download progress uses {@link #sendOtaStatus}.
         */
        void sendOtaMessage(JSONObject message);

        /**
         * Send unified OTA status (session steps, phase, percent). Terminal events use reliable delivery.
         */
        void sendOtaStatus(JSONObject status);
    }
    private static final String TAG = OtaConstants.TAG;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static ConnectivityManager connectivityManager;
    private static final ReentrantLock versionCheckLock = new ReentrantLock();
    private static volatile boolean isUpdating = false;  // Tracks download/install in progress
    private static volatile boolean isMtkOtaInProgress = false;  // Tracks MTK firmware update in progress
    private static volatile long lastVersionCheckTime = 0;  // Track last check time to prevent duplicate network callback triggers
    private static final long NETWORK_CALLBACK_IGNORE_WINDOW_MS = 2000;  // Ignore network callback if check happened within last 2 seconds
    /** Suppresses the 5s-delayed autonomous initial check if {@link #lastVersionCheckTime} was set recently (e.g. by another check). */
    private static final long AUTONOMOUS_INITIAL_CHECK_COOLDOWN_MS = 60_000L;
    private Handler handler;
    private Context context;
    private Runnable periodicCheckRunnable;
    private Runnable initialCheckRunnable;
    private boolean isPeriodicCheckActive = false;
    
    
    // Update order configuration - can be easily modified to change update sequence
    // Order: APK updates → MTK firmware → BES firmware
    private static final String UPDATE_TYPE_APK = "apk";
    private static final String UPDATE_TYPE_MTK = "mtk";
    private static final String UPDATE_TYPE_BES = "bes";
    private static final String[] UPDATE_ORDER = {UPDATE_TYPE_APK, UPDATE_TYPE_MTK, UPDATE_TYPE_BES};
    private static final String CACHE_PREFS_NAME = "ota_cache_state";
    private static final String CACHE_FLAG_READY = "ready";
    private static final String CACHE_FIELD_PATH = "path";
    private static final String CACHE_FIELD_SHA256 = "sha256";
    private static final String CACHE_FIELD_VERSION = "version";
    private static final String CACHE_FIELD_TIMESTAMP = "timestamp";
    private static final String CACHE_FIELD_SIZE = "size";
    private static final String CACHE_KEY_APK_ASG = "apk_com.mentra.asg_client";
    private static final String CACHE_KEY_APK_UPDATER = "apk_com.augmentos.otaupdater";
    private static final String CACHE_KEY_MTK = "mtk_main";
    private static final String CACHE_KEY_BES = "bes_main";
    
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
    private static final boolean AUTONOMOUS_OTA_ENABLED = true;

    // ========== Phone-Controlled OTA State ==========

    // Provider for phone connection status and messaging
    private PhoneConnectionProvider phoneConnectionProvider;

    // Session manager for persisting OTA state across APK restarts
    private OtaSessionManager sessionManager;

    // Track phone-initiated vs glasses-initiated OTA
    private static volatile boolean isPhoneInitiatedOta = false;

    // The version JSON URL used for the current/last check. Stored so that
    // the prefetch→install retry loop re-uses the same URL instead of
    // falling back to the compiled-in default (which would break test flows).
    private volatile String lastVersionJsonUrl = OtaConstants.VERSION_JSON_URL;

    // Cached version JSON from the last successful prefetch. Allows ota_start
    // to skip the network re-fetch when all artifacts are already cached.
    private volatile JSONObject cachedVersionJson = null;

    /**
     * Set the phone-initiated OTA flag. Used by DebugApkOtaReceiver to force
     * installNow=true so the OTA installs immediately rather than just prefetching.
     */
    public void setPhoneInitiatedOta(boolean value) {
        isPhoneInitiatedOta = value;
    }

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

    // Track if MTK was updated this session (to prevent re-updating before reboot)
    // MTK A/B updates don't change ro.custom.ota.version until reboot, so without this
    // flag the system would try to re-download and re-install the same MTK update
    private static volatile boolean mtkUpdatedThisSession = false;
    private static volatile boolean isBackgroundPrefetchInProgress = false;

    // True when the in-flight MTK install is the final firmware step (no BES update follows).
    // BES installs power-cycle the device themselves; an MTK-only update has nothing to trigger
    // the reboot its staged A/B image needs, so OtaService reboots on MTK success. Set at install
    // kickoff so it is correct on both the session and legacy/no-session completion paths.
    private volatile boolean rebootAfterMtkInstall = false;

    private volatile boolean pendingPhoneInstall = false;

    /** Snapshot for {@link #buildMinimalOtaStatusJson()} when no OTA session exists (aligns with {@link #sendMtkInstallProgress} shape). */
    private String lastOtaPhoneStage;
    private int lastOtaPhoneProgress;
    private String lastOtaPhoneEventStatus;
    private String lastOtaPhoneError;

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
        sessionManager = new OtaSessionManager(this.context);

        // Register for EventBus to receive battery status updates
        EventBus.getDefault().register(this);

        if (AUTONOMOUS_OTA_ENABLED) {
            // Delay all autonomous checks by 5 seconds to ensure PhoneConnectionProvider
            // is set up (happens at ~6s) so isPhoneConnected() works correctly.
            // Keep a reference so OtaService can cancel this if it fires an early check
            // (e.g. after detecting an APK update) to prevent a redundant double-check.
            initialCheckRunnable = () -> {
                initialCheckRunnable = null;
                Log.d(TAG, "Starting autonomous OTA checks after 5 second delay");

                // Only run the initial check if no other check ran recently
                long now = System.currentTimeMillis();
                long elapsedSinceLastStamp = now - lastVersionCheckTime;
                if (elapsedSinceLastStamp < AUTONOMOUS_INITIAL_CHECK_COOLDOWN_MS) {
                    Log.i(TAG, "Skipping autonomous initial check — recent version check (elapsedSinceLastStamp="
                            + elapsedSinceLastStamp + "ms, cooldown=" + AUTONOMOUS_INITIAL_CHECK_COOLDOWN_MS
                            + "ms, lastVersionCheckTimeEpochMs=" + lastVersionCheckTime
                            + ", defaultOtaVersionUrl=" + OtaConstants.VERSION_JSON_URL
                            + "). Another path likely called startVersionCheck* and set lastVersionCheckTime at request entry.");
                } else {
                    startVersionCheck(this.context);
                }

                // Always start periodic checks regardless
                startPeriodicChecks();

                // Intentionally do NOT trigger OTA checks on WiFi connection events.
                // User flow requires explicit phone approval (ota_start) before OTA execution.
                Log.i(TAG, "WiFi-triggered OTA checks disabled");
            };
            handler.postDelayed(initialCheckRunnable, 5000);

            Log.i(TAG, "Autonomous OTA mode ENABLED - checks will start in 5 seconds");
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
        // If BLE connected before the provider was wired (startup race), consume any pending
        // APK-done flag immediately — onConnectionStateChanged fired too early to catch it.
        if (provider != null && provider.isPhoneConnected()) {
            onPhoneConnected();
        }
    }

    /**
     * Called by AsgClientService when the phone connects via BLE.
     *
     * Sends the pending APK-done signal if one was queued by OtaService.resumeFromSession()
     * during the previous startup. This is the primary mechanism for the phone to learn that
     * the APK updated successfully — replaces the phone's build-number-bump heuristic.
     *
     * The signal is sent before any other OTA status so the phone UI transitions correctly:
     *   "step_complete" → stays on progress screen, continues to MTK/BES
     *   "complete"      → shows "Update installed"
     */
    public void onPhoneConnected() {
        if (sessionManager == null || phoneConnectionProvider == null) return;
        String pendingStatus = sessionManager.consumePendingApkStatus();
        if (pendingStatus == null) return;
        JSONObject apkDoneJson = sessionManager.buildApkDoneJson(pendingStatus);
        if (apkDoneJson == null) {
            Log.w(TAG, "onPhoneConnected: buildApkDoneJson returned null, skipping APK done signal");
            return;
        }
        Log.i(TAG, "onPhoneConnected: sending explicit APK done signal status=" + pendingStatus);
        phoneConnectionProvider.sendOtaStatus(apkDoneJson);
    }

    public JSONObject getOtaSessionState() {
        try {
            // Phone bridge (MentraLive.java) reads all fields from the top level, so we flatten
            // the session state directly into the message rather than nesting under "data".
            JSONObject sessionState = sessionManager != null ? sessionManager.getSessionState() : null;
            if (sessionState != null) {
                sessionState.put("type", "ota_status");
                return sessionState;
            } else {
                JSONObject idle = new JSONObject();
                idle.put("type", "ota_status");
                idle.put("status", "idle");
                idle.put("total_steps", 0);
                idle.put("current_step", 0);
                idle.put("step_type", "apk");
                idle.put("phase", "download");
                idle.put("step_percent", 0);
                idle.put("overall_percent", 0);
                return idle;
            }
        } catch (JSONException e) {
            return null;
        }
    }

    public OtaSessionManager getSessionManager() {
        return sessionManager;
    }

    /**
     * Returns whether the most recently started MTK install should trigger a self-reboot on
     * success — i.e. it is an MTK-only update with no BES step to power-cycle the device — and
     * atomically clears the flag. Read-and-clear so a duplicate or late MTK SUCCESS event cannot
     * schedule a second/stale reboot; the flag is re-armed only at the next MTK install kickoff
     * (see {@link #checkAndUpdateMtkFirmware}). Works regardless of whether an OTA session exists.
     */
    public synchronized boolean consumeRebootAfterMtkInstall() {
        boolean reboot = rebootAfterMtkInstall;
        rebootAfterMtkInstall = false;
        return reboot;
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

    private SharedPreferences getCachePrefs() {
        return context.getSharedPreferences(CACHE_PREFS_NAME, Context.MODE_PRIVATE);
    }

    private String cacheField(String cacheKey, String field) {
        return cacheKey + "_" + field;
    }

    private String getApkFilename(String packageName) {
        return packageName.equals("com.mentra.asg_client") ? "asg_client_update.apk" : "ota_updater_update.apk";
    }

    private String getApkCacheKey(String packageName) {
        return packageName.equals("com.mentra.asg_client") ? CACHE_KEY_APK_ASG : CACHE_KEY_APK_UPDATER;
    }

    private void markCachedArtifactReady(String cacheKey, String updateType, String localPath, JSONObject metadata) {
        try {
            SharedPreferences.Editor editor = getCachePrefs().edit();
            editor.putBoolean(cacheField(cacheKey, CACHE_FLAG_READY), true);
            editor.putString(cacheField(cacheKey, CACHE_FIELD_PATH), localPath);
            editor.putString(cacheField(cacheKey, CACHE_FIELD_SHA256), metadata.optString("sha256", ""));
            editor.putString(cacheField(cacheKey, CACHE_FIELD_VERSION), metadata.optString("versionName", ""));
            editor.putLong(cacheField(cacheKey, CACHE_FIELD_TIMESTAMP), System.currentTimeMillis());
            editor.putLong(cacheField(cacheKey, CACHE_FIELD_SIZE), new File(localPath).length());
            editor.putString(cacheField(cacheKey, "type"), updateType);
            editor.apply();
            Log.i(TAG, "📦 Cache ready: " + cacheKey + " at " + localPath);
        } catch (Exception e) {
            Log.e(TAG, "Failed to mark cached artifact ready: " + cacheKey, e);
        }
    }

    private String getCachedPath(String cacheKey) {
        return getCachePrefs().getString(cacheField(cacheKey, CACHE_FIELD_PATH), null);
    }

    private boolean isCachedReady(String cacheKey) {
        return getCachePrefs().getBoolean(cacheField(cacheKey, CACHE_FLAG_READY), false);
    }

    private boolean isCachedArtifactValid(String cacheKey, String updateType, String localPath, JSONObject metadata) {
        try {
            if (!isCachedReady(cacheKey)) {
                return false;
            }
            File file = new File(localPath);
            if (!file.exists() || !file.canRead()) {
                return false;
            }

            // Fast path: if the stored SHA256 matches the expected hash from metadata AND the file
            // has not been modified since it was verified, skip the expensive full re-hash.
            // This avoids re-reading large firmware files on every 30-minute periodic check.
            String storedHash = getCachePrefs().getString(cacheField(cacheKey, CACHE_FIELD_SHA256), "");
            long storedTimestamp = getCachePrefs().getLong(cacheField(cacheKey, CACHE_FIELD_TIMESTAMP), 0);
            String expectedHash = metadata.optString("sha256", "");

            if (!storedHash.isEmpty()
                    && storedHash.equalsIgnoreCase(expectedHash)
                    && file.lastModified() <= storedTimestamp) {
                Log.d(TAG, "Cache fast-path hit for " + cacheKey + " - skipping re-hash");
                return true;
            }

            // Slow path: stored hash absent, mismatched, or file was modified — full verify.
            boolean hashOk;
            switch (updateType) {
                case UPDATE_TYPE_APK:
                    hashOk = verifyApkFile(localPath, metadata);
                    break;
                case UPDATE_TYPE_MTK:
                    hashOk = verifyMtkFirmwareChecksum(localPath, metadata);
                    break;
                case UPDATE_TYPE_BES:
                    hashOk = verifyFirmwareFile(localPath, metadata);
                    break;
                default:
                    hashOk = false;
                    break;
            }
            if (!hashOk) {
                Log.w(TAG, "Cached artifact failed verification: " + cacheKey);
            }
            return hashOk;
        } catch (Exception e) {
            Log.e(TAG, "Error validating cache for " + cacheKey, e);
            return false;
        }
    }

    public void clearCachedArtifact(String cacheKey, String updateType) {
        try {
            String path = getCachedPath(cacheKey);
            if (path != null) {
                File file = new File(path);
                if (file.exists() && !file.delete()) {
                    Log.w(TAG, "Failed deleting cached artifact file: " + path);
                }
            }

            SharedPreferences.Editor editor = getCachePrefs().edit();
            editor.remove(cacheField(cacheKey, CACHE_FLAG_READY));
            editor.remove(cacheField(cacheKey, CACHE_FIELD_PATH));
            editor.remove(cacheField(cacheKey, CACHE_FIELD_SHA256));
            editor.remove(cacheField(cacheKey, CACHE_FIELD_VERSION));
            editor.remove(cacheField(cacheKey, CACHE_FIELD_TIMESTAMP));
            editor.remove(cacheField(cacheKey, CACHE_FIELD_SIZE));
            editor.remove(cacheField(cacheKey, "type"));
            editor.apply();
            Log.i(TAG, "🧹 Cleared cached artifact: " + cacheKey + " (" + updateType + ")");
        } catch (Exception e) {
            Log.e(TAG, "Failed clearing cached artifact: " + cacheKey, e);
        }
    }

    public void clearCachedArtifactsForType(String updateType) {
        if (UPDATE_TYPE_APK.equals(updateType)) {
            clearCachedArtifact(CACHE_KEY_APK_ASG, UPDATE_TYPE_APK);
            clearCachedArtifact(CACHE_KEY_APK_UPDATER, UPDATE_TYPE_APK);
            return;
        }
        if (UPDATE_TYPE_MTK.equals(updateType)) {
            clearCachedArtifact(CACHE_KEY_MTK, UPDATE_TYPE_MTK);
            File backup = new File(OtaConstants.MTK_BACKUP_PATH);
            if (backup.exists() && !backup.delete()) {
                Log.w(TAG, "Failed deleting MTK backup cache: " + OtaConstants.MTK_BACKUP_PATH);
            }
            return;
        }
        if (UPDATE_TYPE_BES.equals(updateType)) {
            clearCachedArtifact(CACHE_KEY_BES, UPDATE_TYPE_BES);
            File backup = new File(OtaConstants.BES_BACKUP_PATH);
            if (backup.exists() && !backup.delete()) {
                Log.w(TAG, "Failed deleting BES backup cache: " + OtaConstants.BES_BACKUP_PATH);
            }
        }
    }

    public void clearAllCachedArtifacts() {
        clearCachedArtifactsForType(UPDATE_TYPE_APK);
        clearCachedArtifactsForType(UPDATE_TYPE_MTK);
        clearCachedArtifactsForType(UPDATE_TYPE_BES);
    }

    public void pruneInvalidCachedArtifactsOnStartup() {
        try {
            pruneOneCacheEntry(CACHE_KEY_APK_ASG, UPDATE_TYPE_APK);
            pruneOneCacheEntry(CACHE_KEY_APK_UPDATER, UPDATE_TYPE_APK);
            pruneOneCacheEntry(CACHE_KEY_MTK, UPDATE_TYPE_MTK);
            if (!BesOtaManager.isBesOtaInProgress) {
                pruneOneCacheEntry(CACHE_KEY_BES, UPDATE_TYPE_BES);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed pruning invalid cached artifacts", e);
        }
    }

    private void pruneOneCacheEntry(String cacheKey, String updateType) {
        if (!isCachedReady(cacheKey)) {
            return;
        }
        String path = getCachedPath(cacheKey);
        if (path == null) {
            clearCachedArtifact(cacheKey, updateType);
            return;
        }
        File file = new File(path);
        if (!file.exists() || file.length() <= 0) {
            clearCachedArtifact(cacheKey, updateType);
            return;
        }
        long storedSize = getCachePrefs().getLong(cacheField(cacheKey, CACHE_FIELD_SIZE), -1);
        if (storedSize > 0 && file.length() != storedSize) {
            Log.w(TAG, "Size mismatch for " + cacheKey + ": expected " + storedSize + " but got " + file.length() + " — clearing corrupt entry");
            file.delete();
            clearCachedArtifact(cacheKey, updateType);
            return;
        }
        String storedHash = getCachePrefs().getString(cacheField(cacheKey, CACHE_FIELD_SHA256), "");
        if (storedHash.isEmpty()) {
            Log.w(TAG, "No stored hash for " + cacheKey + " — clearing stale entry");
            clearCachedArtifact(cacheKey, updateType);
            return;
        }
        Log.i(TAG, "Keeping valid cached artifact on startup: " + cacheKey);
    }

    // Wakelock timeout for OTA process (10 minutes)
    private static final long OTA_WAKELOCK_TIMEOUT_MS = 600000;
    private static final int REACHABILITY_TIMEOUT_MS = 5000;

    /**
     * Quick HEAD request to CDN to verify internet reachability before starting OTA.
     * Returns true if the CDN is reachable, false otherwise.
     */
    private boolean checkInternetReachable() {
        try {
            // This is just a HEAD reachability probe so the actual URL doesn't matter for the
            // probe to work, but it should be kept in sync with the manifest URL when that swaps.
            HttpURLConnection conn = (HttpURLConnection)
                new URL("https://ota.mentraglass.com/prod_live_version.json").openConnection();
            conn.setConnectTimeout(REACHABILITY_TIMEOUT_MS);
            conn.setReadTimeout(REACHABILITY_TIMEOUT_MS);
            conn.setRequestMethod("HEAD");
            conn.connect();
            int code = conn.getResponseCode();
            conn.disconnect();
            return code >= 200 && code < 400;
        } catch (Exception e) {
            Log.w(TAG, "Internet reachability check failed: " + e.getMessage());
            return false;
        }
    }

    private List<String> buildStepSequence(JSONObject rootJson, JSONObject apps, Context context) {
        List<String> steps = new ArrayList<>();
        try {
            String[] orderedPackages = {"com.mentra.asg_client", "com.augmentos.otaupdater"};
            for (String pkg : orderedPackages) {
                if (!apps.has(pkg)) continue;
                long current = getInstalledVersion(pkg, context);
                long server = apps.getJSONObject(pkg).getLong("versionCode");
                if (server > current) {
                    steps.add("apk");
                    break;
                }
            }
            if (!wasMtkUpdatedThisSession() && !isMtkOtaInProgress() && rootJson.has("mtk_patches")) {
                String currentMtk = SysProp.getProperty(context, "ro.custom.ota.version");
                JSONObject mtkPatch = findMatchingMtkPatch(rootJson.getJSONArray("mtk_patches"), currentMtk);
                if (mtkPatch != null) steps.add("mtk");
            }
            if (rootJson.has("bes_firmware")) {
                String besVer = "";
                try { besVer = new AsgSettings(context).getBesFirmwareVersion(); } catch (Exception ignored) {}
                if (checkBesUpdate(rootJson.getJSONObject("bes_firmware"), besVer)) steps.add("bes");
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to build step sequence", e);
        }
        return steps;
    }

    /**
     * Classify download exceptions into semantic error codes for actionable user feedback.
     */
    private boolean isClockSkewSslError(Throwable e) {
        Throwable t = e;
        while (t != null) {
            if (t instanceof java.security.cert.CertificateNotYetValidException) {
                return true;
            }
            String msg = t.getMessage();
            if (msg != null && (msg.contains("Certificate not yet valid")
                    || msg.contains("timestamp check failed"))) {
                return true;
            }
            t = t.getCause();
        }
        return false;
    }

    private String classifyDownloadError(Exception e) {
        if (e instanceof FirmwareDownloadException) {
            // Non-network failure (size cap, sha256 mismatch). Carry the stable code through
            // so the phone-side error mapping doesn't confuse this with a transient WiFi issue.
            return ((FirmwareDownloadException) e).getErrorCode();
        } else if (e instanceof java.net.SocketTimeoutException) {
            return "no_internet";
        } else if (e instanceof java.net.UnknownHostException) {
            return "no_internet";
        } else if (e instanceof java.net.ConnectException) {
            return "no_internet";
        } else if (e instanceof javax.net.ssl.SSLException || isClockSkewSslError(e)) {
            if (isClockSkewSslError(e)) {
                Log.w(TAG, "⏰ OTA failure likely due to glasses clock skew (TLS cert validity): "
                        + e.getMessage());
                return "clock_skew";
            }
            return "ssl_error";
        } else if (e instanceof java.net.SocketException) {
            // Mid-download link loss, RST, or "Software caused connection abort" — not worth retrying
            // while WiFi is typically already gone; surface a single FAILED to the phone.
            return "download_failed";
        } else {
            return "download_failed";
        }
    }

    /**
     * Start OTA update from phone command (onboarding or background approval).
     * Called by OtaCommandHandler when phone sends ota_start command.
     */
    public void startOtaFromPhone() {
        Log.i(TAG, "📱 Starting OTA from phone request");

        // Immediately acknowledge receipt so the phone cancels its retry timer.
        sendOtaStartAck();

        // If OTA already in progress, queue the install to fire immediately after prefetch completes.
        // We cannot change the running thread's local installNow variable, so we set a flag that
        // the finally block detects and uses to kick off a fresh install pass from the cache.
        if (versionCheckLock.isLocked()) {
            Log.i(TAG, "📱 OTA prefetch in progress - queuing install to fire after prefetch completes");
            pendingPhoneInstall = true;
            isPhoneInitiatedOta = true;
            // Acquire wakelock early so CPU stays awake for the queued install pass
            WakeLockManager.acquireCpuWakeLock(context, OTA_WAKELOCK_TIMEOUT_MS);
            Log.i(TAG, "📱 OTA wakelock acquired for queued install (" + (OTA_WAKELOCK_TIMEOUT_MS / 1000) + "s)");
            // Send STARTED (not IN_PROGRESS) so the phone state machine initialises correctly.
            sendProgressToPhone("download", 0, 0, 0, "STARTED", null);
            return;
        }

        // Acquire wakelock to prevent CPU sleep during OTA download/install
        WakeLockManager.acquireCpuWakeLock(context, OTA_WAKELOCK_TIMEOUT_MS);
        Log.i(TAG, "📱 OTA wakelock acquired for " + (OTA_WAKELOCK_TIMEOUT_MS / 1000) + " seconds");

        isPhoneInitiatedOta = true;
        hasNotifiedPhoneOfUpdate = false; // Reset for next check cycle

        // Reset progress tracking
        lastProgressSentTime = 0;
        lastProgressSentPercent = 0;

        // Fast-path: if background prefetch already fetched and cached the version JSON,
        // skip the network round-trip entirely and jump straight to install.
        if (cachedVersionJson != null) {
            Log.i(TAG, "📱 Cache fast-path: reusing prefetched version JSON (skipping network re-fetch)");
            startInstallFromCachedJson(context, cachedVersionJson);
            return;
        }

        Log.i(TAG, "📱 Phone-initiated OTA: starting version check (download STARTED deferred)");

        startVersionCheck(context);
    }

    /**
     * Run the install pass using the version JSON that was already fetched by the
     * background prefetch.  This avoids a redundant network round-trip and the
     * pre-flight internet check when all artifacts are already cached.
     */
    private void startInstallFromCachedJson(Context context, JSONObject json) {
        new Thread(() -> {
            try {
                if (!versionCheckLock.tryLock()) {
                    Log.w(TAG, "📱 Cache fast-path: version check lock held — falling back to full check");
                    startVersionCheck(context);
                    return;
                }
                try {
                    Log.i(TAG, "📱 Cache fast-path: processing cached version JSON (installNow=true)");
                    if (json.has("apps")) {
                        processAppsSequentially(json, context, true);
                    } else {
                        Log.d(TAG, "Using legacy version.json format (cache fast-path)");
                        boolean apkUpdated = checkAndUpdateApp("com.mentra.asg_client", json, context, true);
                        if (!apkUpdated) {
                            sendProgressToPhone("download", 0, 0, 0, "FAILED",
                                    "APK update failed after retries. Please check WiFi and try again.");
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Exception during cache fast-path install", e);
                    String errorCode = classifyDownloadError(e);
                    sendProgressToPhone(currentUpdateStage, 0, 0, 0, "FAILED", errorCode);
                } finally {
                    cachedVersionJson = null;
                    isPhoneInitiatedOta = false;
                    versionCheckLock.unlock();
                    Log.d(TAG, "Version check completed (cache fast-path), ready for next check");
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to acquire lock for cache fast-path", e);
            }
        }).start();
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
        Log.d(TAG, "Started periodic OTA checks every " + (OtaConstants.PERIODIC_CHECK_INTERVAL_MS / 60000) + " minutes");
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
                    Log.d(TAG, "WiFi network became available, OTA check suppressed by policy");
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

    /**
     * Re-run background OTA version check (e.g. after phone fixes glasses clock via BLE).
     */
    public void retryBackgroundVersionCheck() {
        if (context == null) {
            Log.w(TAG, "⏰ Cannot retry OTA version check — no context");
            return;
        }
        Log.i(TAG, "⏰ Retrying OTA version check after clock sync from phone");
        startVersionCheck(context);
    }

    public void startVersionCheck(Context context) {
        startVersionCheckWithUrl(context, OtaConstants.VERSION_JSON_URL);
    }

    /**
     * Start a version check using a custom version JSON URL.
     * Used by DebugApkOtaReceiver to test OTA with a local/custom URL.
     * @param context Application context
     * @param versionJsonUrl URL to fetch the version JSON from (http, https)
     */
    public void startVersionCheckWithUrl(Context context, String versionJsonUrl) {
        Log.d(TAG, "Check OTA update method init");
        Log.i(TAG, "OTA check trigger -> phoneInitiated=" + isPhoneInitiatedOta
                + ", autonomousEnabled=" + AUTONOMOUS_OTA_ENABLED
                + ", lockHeld=" + versionCheckLock.isLocked()
                + ", isUpdating=" + isUpdating
                + ", mtkInProgress=" + isMtkOtaInProgress
                + ", besInProgress=" + BesOtaManager.isBesOtaInProgress
                + ", versionJsonUrl=" + versionJsonUrl);

        // if (!isNetworkAvailable(context)) {
        //     Log.e(TAG, "No WiFi connection available. Skipping OTA check.");
        //     return;
        // }

        // // Check battery status before proceeding with OTA update
        // if (!isBatterySufficientForUpdates()) {
        //     Log.w(TAG, "🚨 Battery insufficient for OTA updates - skipping version check");
        //     return;
        // }

        // Stamp intent-to-check immediately so any pending autonomous initial check
        // (scheduled for 5s after init) sees a recent timestamp and suppresses itself.
        lastVersionCheckTime = System.currentTimeMillis();

        new Thread(() -> {
            // Try to acquire lock - if already held, another check is in progress
            if (!versionCheckLock.tryLock()) {
                Log.d(TAG, "Version check already in progress, skipping this request");
                return;
            }
            Log.d(TAG, "Version check lock acquired");

            // Store the URL under the lock so a concurrent caller can't overwrite it
            // before this check finishes (used by the pendingPhoneInstall retry).
            lastVersionJsonUrl = versionJsonUrl;

            // Check if update is in progress (separate from version check)
            if (isUpdating) {
                Log.d(TAG, "Update already in progress, skipping version check");
                versionCheckLock.unlock();
                return;
            }

            final String[] stage = new String[]{"init"};
            final boolean[] otaCheckReachedSuccessLog = {false};

            try {
                // For autonomous/background prefetch, require WiFi before any network fetch.
                // This avoids noisy fetch exceptions when glasses are offline.
                if (!isPhoneInitiatedOta) {
                    stage[0] = "background_wifi_gate";
                    if (!isNetworkAvailable(context)) {
                        Log.i(TAG, "📦 Skipping background OTA check - WiFi unavailable");
                        return;
                    }
                }

                stage[0] = "fetch_version_info";
                // Fetch version info from URL
                String versionInfo = fetchVersionInfo(versionJsonUrl);
                stage[0] = "parse_version_json";
                JSONObject json = new JSONObject(versionInfo);

                Log.d(TAG, "Version JSON parsed successfully. Root keys -> apps=" + json.has("apps")
                        + ", mtk_patches=" + json.has("mtk_patches")
                        + ", bes_firmware=" + json.has("bes_firmware"));

                cachedVersionJson = json;

                if (!isPhoneInitiatedOta) {
                    stage[0] = "background_prefetch_gate";
                    isBackgroundPrefetchInProgress = true;
                    Log.i(TAG, "📦 Starting background OTA pre-download pass");
                }

                // Check if new format (multiple apps) or legacy format
                boolean installNow = isPhoneInitiatedOta;
                Log.i(TAG, "OTA execution mode -> installNow=" + installNow);
                stage[0] = "process_updates";
                if (json.has("apps")) {
                    processAppsSequentially(json, context, installNow);
                } else {
                    Log.d(TAG, "Using legacy version.json format");
                    boolean apkUpdated = checkAndUpdateApp("com.mentra.asg_client", json, context, installNow);
                    if (installNow && !apkUpdated) {
                        Log.e(TAG, "Legacy OTA flow: APK update failed for com.mentra.asg_client");
                        sendProgressToPhone("download", 0, 0, 0, "FAILED",
                                "APK update failed after retries. Please check WiFi and try again.");
                        return;
                    }
                }

                if (!isPhoneInitiatedOta) {
                    stage[0] = "build_cache_ready_info";
                    JSONObject cacheReadyInfo = buildCacheReadyUpdateInfo(json);
                    if (cacheReadyInfo != null && cacheReadyInfo.optBoolean("available", false) && isPhoneConnected()) {
                        stage[0] = "notify_phone_cache_ready";
                        notifyPhoneUpdateAvailable(cacheReadyInfo);
                        Log.i(TAG, "📱 Background pre-download ready - prompted phone to install");
                    } else {
                        Log.i(TAG, "📦 Background pre-download complete - updates not fully cache-ready yet");
                    }
                }
                otaCheckReachedSuccessLog[0] = true;
                Log.i(TAG, "OTA check completed successfully");
            } catch (Exception e) {
                String urlForLog = versionJsonUrl != null ? versionJsonUrl : lastVersionJsonUrl;
                String rootMsg = e.getMessage() != null ? e.getMessage() : "";
                String causeInfo = "";
                if (e.getCause() != null) {
                    causeInfo = ", cause=" + e.getCause().getClass().getName() + ": " + e.getCause().getMessage();
                }
                Log.e(TAG, "Exception during OTA check: stage=" + stage[0]
                        + ", requestUrl=" + urlForLog
                        + ", lastVersionJsonUrl=" + (lastVersionJsonUrl != null ? lastVersionJsonUrl : "null")
                        + ", phoneInitiated=" + isPhoneInitiatedOta
                        + ", isUpdating=" + isUpdating
                        + ", isBackgroundPrefetch=" + isBackgroundPrefetchInProgress
                        + ", error=" + e.getClass().getName() + ": " + rootMsg
                        + causeInfo, e);
                cachedVersionJson = null;
                // Cancel any queued install — triggering an install pass after a failed prefetch
                // would attempt to install a potentially corrupt or incomplete cache.
                pendingPhoneInstall = false;
                // Send failure to phone with semantic error classification
                String errorCode = classifyDownloadError(e);
                if (isPhoneInitiatedOta) {
                    sendProgressToPhone(currentUpdateStage, 0, 0, 0, "FAILED", errorCode);
                } else if (phoneConnectionProvider != null && isPhoneConnected()) {
                    // Autonomous/background version check failed (e.g. DNS while user is on OTA screen).
                    // Still notify the phone so the UI can show no_internet / download_failed — not only
                    // when the session was started with ota_start (phoneInitiated can stay false for the
                    // 5s delayed initial check even if the user already opened the OTA flow).
                    currentUpdateStage = "download";
                    if (currentUpdateType == null) {
                        currentUpdateType = "apk";
                    }
                    sendProgressToPhone("download", 0, 0, 0, "FAILED", errorCode);
                    Log.i(TAG, "📱 Notified phone of version-check OTA failure (background path): " + errorCode);
                }
            } finally {
                // Capture before resetting — if the user tapped Install while prefetch was running,
                // we need to fire a fresh install pass now that the cache is fully populated.
                boolean shouldInstallNow = pendingPhoneInstall;
                isBackgroundPrefetchInProgress = false;
                isPhoneInitiatedOta = false;
                pendingPhoneInstall = false;
                versionCheckLock.unlock();
                Log.d(TAG, "Version check thread finished (reachedSuccessLog=" + otaCheckReachedSuccessLog[0]
                        + ", lastStage=" + stage[0] + "), lock released, ready for next check");

                if (shouldInstallNow) {
                    Log.i(TAG, "📱 Phone-initiated install was queued during prefetch - firing install pass now");
                    isPhoneInitiatedOta = true;
                    startVersionCheckWithUrl(context, lastVersionJsonUrl); // fresh pass: same URL, installNow=true, files served from cache
                }
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
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.connect();

            int responseCode = conn.getResponseCode();
            String responseMessage = conn.getResponseMessage();
            long contentLength = conn.getContentLengthLong();
            Log.i(TAG, "Version info HTTP response -> code=" + responseCode
                    + ", message=" + responseMessage
                    + ", contentLength=" + contentLength);

            InputStream stream = responseCode >= 200 && responseCode < 300 ? conn.getInputStream() : conn.getErrorStream();
            if (stream == null) {
                conn.disconnect();
                throw new IOException("Version info fetch failed: empty response stream, code=" + responseCode);
            }

            String responseBody;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream))) {
                responseBody = reader.lines().collect(Collectors.joining("\n"));
            } finally {
                conn.disconnect();
            }

            int sampleLength = Math.min(200, responseBody.length());
            String sample = responseBody.substring(0, sampleLength);
            Log.d(TAG, "Version info response sample (" + sampleLength + " chars): " + sample);

            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("Version info fetch failed with HTTP " + responseCode + ": " + responseMessage);
            }

            return responseBody;
        } catch (Exception e) {
            Log.w(TAG, "fetchVersionInfo: network/parse failure url=" + url + " -> " + e.getClass().getName() + ": "
                    + (e.getMessage() != null ? e.getMessage() : ""));
            throw e;
        }
    }

    private void processAppsSequentially(JSONObject rootJson, Context context, boolean installNow) throws Exception {
        // Get the apps object from root
        JSONObject apps = rootJson.getJSONObject("apps");

        if (installNow && sessionManager != null) {
            List<String> steps = buildStepSequence(rootJson, apps, context);
            if (!steps.isEmpty()) {
                String versionUrl = lastVersionJsonUrl != null ? lastVersionJsonUrl : OtaConstants.VERSION_JSON_URL;
                sessionManager.createSession(steps.toArray(new String[0]), versionUrl);
                Log.i(TAG, "OTA session created with steps: " + steps);
            }
        }
        
        // Process apps in order - important for sequential updates
        String[] orderedPackages = {
            "com.mentra.asg_client",     // Update ASG client first
            // "com.augmentos.otaupdater"      // Then OTA updater
        };

        // PHASE 0: Pre-download firmware artifacts BEFORE any APK install.
        // APK install kills the app process, so MTK/BES firmware files must be cached
        // beforehand. After restart the install phase can serve files from cache.
        {
            try {
                if (!wasMtkUpdatedThisSession() && !isMtkOtaInProgress() && rootJson.has("mtk_patches")) {
                    String currentMtkVersion = SysProp.getProperty(context, "ro.custom.ota.version");
                    JSONObject mtkPatch = findMatchingMtkPatch(rootJson.getJSONArray("mtk_patches"), currentMtkVersion);
                    if (mtkPatch != null) {
                        Log.i(TAG, "📦 Phase 0: Pre-downloading MTK firmware before APK install");
                        checkAndUpdateMtkFirmware(mtkPatch, context, false);
                    }
                }
                if (rootJson.has("bes_firmware")) {
                    String currentBesVersion = "";
                    try {
                        AsgSettings asgSettings = new AsgSettings(context);
                        currentBesVersion = asgSettings.getBesFirmwareVersion();
                    } catch (Exception e) {
                        Log.e(TAG, "Error getting BES firmware version from AsgSettings", e);
                    }
                    boolean besNeeded = checkBesUpdate(rootJson.getJSONObject("bes_firmware"), currentBesVersion);
                    if (besNeeded) {
                        Log.i(TAG, "📦 Phase 0: Pre-downloading BES firmware before APK install");
                        checkAndUpdateBesFirmware(rootJson.getJSONObject("bes_firmware"), context, false);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Phase 0 firmware prefetch failed (non-fatal) - will retry later", e);
            }
        }
        
        boolean apkUpdateNeeded = false;
        boolean apkUpdateFailed = false;
        String failedApkPackage = null;
        
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
                boolean success = checkAndUpdateApp(packageName, appInfo, context, installNow);
                
                if (success) {
                    Log.i(TAG, (installNow ? "Successfully updated " : "Successfully pre-downloaded ") + packageName);
                    if (installNow) {
                        apkUpdateNeeded = true;
                    }
                    
                    // Wait a bit for installation to complete before checking next app
                    if (installNow) {
                        Thread.sleep(5000); // 5 seconds
                    }
                } else {
                    Log.e(TAG, "Failed to process " + packageName);
                    if (installNow) {
                        apkUpdateFailed = true;
                        failedApkPackage = packageName;
                        break; // Stop install sequence if update fails
                    }
                }
            } else {
                Log.d(TAG, packageName + " is up to date (version " + currentVersion + ")");
            }
        }
        
        Log.d(TAG, "apkUpdateNeeded: " + apkUpdateNeeded);

        if (installNow && apkUpdateFailed) {
            String failedPkg = failedApkPackage != null ? failedApkPackage : "APK";
            Log.e(TAG, "Stopping OTA flow because APK update failed for " + failedPkg);
            sendProgressToPhone("download", 0, 0, 0, "FAILED",
                    "Please check WiFi and try again.");
            return;
        }
        
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
                    if (installNow) {
                        // Install mode: MTK first. Phone will re-check after MTK completes
                        // and start BES as a separate update round.
                        Log.i(TAG, "Both MTK and BES updates available - applying MTK first, phone will handle BES next");

                        // besUpdateFollows=true: the upcoming BES install will power-cycle the
                        // device, so MTK must not self-reboot here (avoids a double reboot).
                        boolean mtkStarted = checkAndUpdateMtkFirmware(mtkPatch, context, true, true);
                        if (mtkStarted) {
                            Log.i(TAG, "MTK firmware update started - BES will be handled by phone in next round");
                        } else {
                            Log.e(TAG, "MTK firmware update failed to start");
                        }
                    } else {
                        // Prefetch mode: download/cache BOTH artifacts now so prompt can be shown as cache-ready.
                        Log.i(TAG, "Both MTK and BES updates available - pre-downloading both artifacts");
                        boolean mtkPrefetched = checkAndUpdateMtkFirmware(mtkPatch, context, false);
                        boolean besPrefetched = checkAndUpdateBesFirmware(rootJson.getJSONObject("bes_firmware"), context, false);
                        Log.i(TAG, "Prefetch results -> mtk=" + mtkPrefetched + ", bes=" + besPrefetched);
                    }
                } else if (mtkPatch != null) {
                    // Only MTK - apply normally (stages, needs manual reboot)
                    Log.i(TAG, "MTK update available - applying");
                    checkAndUpdateMtkFirmware(mtkPatch, context, installNow);
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
                            // MTK is actively being installed - phone will handle BES after MTK completes
                            Log.i(TAG, "BES update available but MTK in progress - phone will start BES after MTK completes");
                            if (isPhoneInitiatedOta) {
                                sendProgressToPhone("install", -1, 0, 0, "IN_PROGRESS", "mtk");
                            }
                        }
                    } else {
                        // Only BES - apply normally (triggers power-cycle)
                        Log.i(TAG, "BES update available - applying");
                        checkAndUpdateBesFirmware(rootJson.getJSONObject("bes_firmware"), context, installNow);
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
            Log.i(TAG, "APK update performed - firmware already pre-downloaded in Phase 0, install will happen after restart");
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
        return checkAndUpdateApp(packageName, appInfo, context, true);
    }

    private boolean checkAndUpdateApp(String packageName, JSONObject appInfo, Context context, boolean installNow) {
        try {
            // Always reset currentUpdateType for APK operations so progress messages carry the correct label,
            // even when the APK was already cached and downloadApkInternal (which also sets this) is skipped.
            currentUpdateType = "apk";

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
                String filename = getApkFilename(packageName);
                String cacheKey = getApkCacheKey(packageName);
                String localPath = OtaConstants.BASE_DIR + "/" + filename;

                boolean hasValidCache = isCachedArtifactValid(cacheKey, UPDATE_TYPE_APK, localPath, appInfo);
                if (!hasValidCache) {
                    if (installNow) {
                        isUpdating = true;
                        Log.i(TAG, "Starting update process for " + packageName);
                    } else {
                        Log.i(TAG, "📦 Prefetching APK for " + packageName);
                    }

                    File apkFile = new File(localPath);
                    if (apkFile.exists() && !apkFile.delete()) {
                        Log.w(TAG, "Failed deleting old APK before refresh: " + apkFile.getName());
                    }

                    // Create backup before update install
                    if (installNow) {
                        createAppBackup(packageName, context);
                    }

                    boolean downloadOk = downloadApk(apkUrl, appInfo, context, filename);
                    if (!downloadOk) {
                        clearCachedArtifact(cacheKey, UPDATE_TYPE_APK);
                        isUpdating = false;
                        Log.d(TAG, "Download failed, cleared isUpdating for next OTA attempt");
                        return false;
                    }
                    markCachedArtifactReady(cacheKey, UPDATE_TYPE_APK, localPath, appInfo);
                } else {
                    Log.i(TAG, "📦 Cache hit for " + packageName + " - APK already downloaded, skipping download stage entirely");
                    if (installNow) {
                        Log.i(TAG, "⚡ Cache hit + installNow: jumping straight to install (no download UI shown to user)");
                    }
                }

                if (!installNow) {
                    return true;
                }

                Log.i(TAG, "📲 Proceeding to install " + packageName + " (source: " + (hasValidCache ? "cache" : "fresh download") + ")");
                currentUpdateStage = "install";
                sendProgressToPhone("install", 0, 0, 0, "STARTED", null);

                // Persist session before APK install — process will be killed.
                // Do NOT send a FINISHED status here: the install has not actually
                // completed yet and the process is about to die. The phone will
                // receive a completion status from OtaService.resumeFromSession()
                // after the restart via sendCompletionToPhone(), or naturally from
                // the next step for multi-step sessions.
                if (sessionManager != null) {
                    sessionManager.setRestarting();
                }

                boolean installKicked = installApk(context, localPath);
                if (!installKicked) {
                    // Install never actually fired — phone is going to sit waiting for a
                    // process restart that won't happen, and the next OTA attempt would skip
                    // the prefetch path because the restart guard is armed. Roll it back.
                    Log.w(TAG, "installApk did not kick install — rolling back restart guard and reporting FAILED");
                    if (sessionManager != null) {
                        sessionManager.clearRestartGuard();
                    }
                    sendProgressToPhone("install", 0, 0, 0, "FAILED", "install_failed");
                    clearCachedArtifact(cacheKey, UPDATE_TYPE_APK);
                    return false;
                }

                // Clean up cached update file after install attempt
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    clearCachedArtifact(cacheKey, UPDATE_TYPE_APK);
                }, 30000);

                return true;
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
    
    // Modified to accept custom filename for different apps. Single download attempt — no retries.

    public boolean downloadApk(String urlStr, JSONObject json, Context context, String filename) {
        try {
            boolean success = downloadApkInternal(urlStr, json, context, filename);
            if (success) {
                return true;
            }
            Log.e(TAG, "Download succeeded but verification failed");
            EventBus.getDefault().post(new DownloadProgressEvent(
                DownloadProgressEvent.DownloadStatus.FAILED, "Verification failed"));
            return false;
        } catch (Exception e) {
            Log.e(TAG, "APK download failed", e);
            File partialFile = new File(OtaConstants.BASE_DIR, filename);
            if (partialFile.exists()) {
                partialFile.delete();
                Log.d(TAG, "Cleaned up partial download file");
            }
            String errorCode = classifyDownloadError(e);
            EventBus.getDefault().post(new DownloadProgressEvent(
                DownloadProgressEvent.DownloadStatus.FAILED, errorCode));
            sendProgressToPhone("download", 0, 0, 0, "FAILED", errorCode);
            return false;
        }
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
        conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
        conn.connect();

        InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(apkFile);

        byte[] buffer = new byte[4096];
        int len;
        long total = 0;
        long fileSize = conn.getContentLength();
        int lastProgress = 0;

        Log.d(TAG, "APK download started, file size: " + fileSize + " bytes");

        // Set current update stage for phone progress
        currentUpdateStage = "download";
        currentUpdateType = "apk";

        // Now that we have the real file size, tell the phone the download is starting.
        // This is deferred from startOtaFromPhone() so cache hits never send this event.
        Log.i(TAG, "📥 Sending download STARTED to phone (actual download, not cache hit)");
        sendProgressToPhone("download", 0, 0, fileSize, "STARTED", null);

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

        // APK hash check disabled – downloaded APK is accepted without integrity verification.
        Log.w(TAG, "WARNING: OTA APK SHA256 hash verification is DISABLED. Downloaded APK is not integrity-checked.");
        EventBus.getDefault().post(DownloadProgressEvent.createFinished(fileSize));
        sendProgressToPhone("download", 100, fileSize, fileSize, "FINISHED", null);
        createMetaDataJson(json, context);
        return true;
    }

    private boolean verifyApkFile(String apkPath, JSONObject jsonObject) {
        // APK hash check disabled – APK is accepted without integrity verification.
        Log.w(TAG, "WARNING: OTA APK SHA256 hash verification is DISABLED. APK is not integrity-checked.");
        return true;
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

    public boolean installApk(Context context) {
        return installApk(context, OtaConstants.APK_FULL_PATH);
    }

    /**
     * Trigger the system UI install broadcast for the given APK.
     *
     * @return {@code true} if the install broadcast was actually dispatched (caller should
     *         now expect the process to be killed). {@code false} if anything aborted the
     *         install (missing file, unreadable file, SecurityException, etc.) — callers
     *         that armed restart-guard state must roll it back when this returns false.
     */
    public static boolean installApk(Context context, String apkPath) {
        try {
            Log.d(TAG, "Starting installation process for APK at: " + apkPath);

            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.STARTED, apkPath));

            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "install");
            intent.putExtra("pkpath", apkPath);
            intent.putExtra("recv_pkname", context.getPackageName());
            intent.putExtra("startapp", true);

            File apkFile = new File(apkPath);
            if (!apkFile.exists()) {
                Log.e(TAG, "Installation failed: APK file not found at " + apkPath);
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "APK file not found"));
                sendUpdateCompletedBroadcast(context);
                return false;
            }

            if (!apkFile.canRead()) {
                Log.e(TAG, "Installation failed: Cannot read APK file at " + apkPath);
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Cannot read APK file"));
                sendUpdateCompletedBroadcast(context);
                return false;
            }

            Log.d(TAG, "Sending install broadcast to system UI...");
            context.sendBroadcast(intent);
            Log.i(TAG, "Install broadcast sent successfully. System will handle installation.");
            return true;
        } catch (SecurityException e) {
            Log.e(TAG, "Security exception while sending install broadcast", e);
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Security exception: " + e.getMessage()));
            sendUpdateCompletedBroadcast(context);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Failed to send install broadcast", e);
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Installation failed: " + e.getMessage()));
            sendUpdateCompletedBroadcast(context);
            return false;
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
        return checkAndUpdateBesFirmware(firmwareInfo, context, true);
    }

    private boolean checkAndUpdateBesFirmware(JSONObject firmwareInfo, Context context, boolean installNow) {
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
            boolean hasValidCache = isCachedArtifactValid(CACHE_KEY_BES, UPDATE_TYPE_BES, OtaConstants.BES_FIRMWARE_PATH, firmwareInfo);
            if (!hasValidCache) {
                boolean downloaded = downloadBesFirmware(firmwareUrl, firmwareInfo, context);
                if (!downloaded) {
                    Log.e(TAG, "Failed to download BES firmware");
                    clearCachedArtifact(CACHE_KEY_BES, UPDATE_TYPE_BES);
                    return false;
                }
                markCachedArtifactReady(CACHE_KEY_BES, UPDATE_TYPE_BES, OtaConstants.BES_FIRMWARE_PATH, firmwareInfo);
            } else {
                Log.i(TAG, "📦 Cache hit for BES firmware - using pre-downloaded artifact");
            }

            if (!installNow) {
                return true;
            }

            if (!isPhoneInitiatedOta) {
                Log.w(TAG, "BES firmware install blocked - requires explicit ota_start from phone");
                return false;
            }

            Log.i(TAG, "BES firmware ready - starting install phase");
            BesOtaManager manager = BesOtaManager.getInstance();
            if (manager != null) {
                Log.i(TAG, "Starting BES firmware update from: " + OtaConstants.BES_FIRMWARE_PATH);
                boolean started = manager.startFirmwareUpdate(OtaConstants.BES_FIRMWARE_PATH);
                if (started) {
                    Log.i(TAG, "BES firmware update initiated successfully");
                    return true;
                } else {
                    Log.e(TAG, "Failed to start BES firmware update");
                    clearCachedArtifact(CACHE_KEY_BES, UPDATE_TYPE_BES);
                }
            } else {
                Log.e(TAG, "BesOtaManager not available");
                clearCachedArtifact(CACHE_KEY_BES, UPDATE_TYPE_BES);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to update BES firmware", e);
            clearCachedArtifact(CACHE_KEY_BES, UPDATE_TYPE_BES);
        }
        return false;
    }
    
    private boolean downloadBesFirmware(String firmwareUrl, JSONObject firmwareInfo, Context context) {
        try {
            boolean success = downloadBesFirmwareInternal(firmwareUrl, firmwareInfo, context);
            if (success) {
                return true;
            }
            Log.e(TAG, "BES firmware download returned false unexpectedly");
            sendProgressToPhone("download", 0, 0, 0, "FAILED", "download_failed");
            return false;
        } catch (FirmwareDownloadException nonRetryable) {
            Log.e(TAG, "BES firmware download failed: " + nonRetryable.getErrorCode(), nonRetryable);
            File partialFile = new File(OtaConstants.BASE_DIR, OtaConstants.BES_FIRMWARE_FILENAME);
            if (partialFile.exists()) {
                partialFile.delete();
            }
            sendProgressToPhone("download", 0, 0, 0, "FAILED", nonRetryable.getErrorCode());
            return false;
        } catch (Exception e) {
            Log.e(TAG, "BES firmware download failed", e);
            File partialFile = new File(OtaConstants.BASE_DIR, OtaConstants.BES_FIRMWARE_FILENAME);
            if (partialFile.exists()) {
                partialFile.delete();
                Log.d(TAG, "Cleaned up partial BES firmware file");
            }
            sendProgressToPhone("download", 0, 0, 0, "FAILED", classifyDownloadError(e));
            return false;
        }
    }

    private boolean downloadBesFirmwareInternal(String firmwareUrl, JSONObject firmwareInfo, Context context) throws Exception {
        File asgDir = new File(OtaConstants.BASE_DIR);
        if (!asgDir.exists()) {
            boolean created = asgDir.mkdirs();
            Log.d(TAG, "ASG directory created: " + created);
        }
        
        File firmwareFile = new File(asgDir, OtaConstants.BES_FIRMWARE_FILENAME);
        
        if (firmwareFile.exists()) {
            Log.d(TAG, "Deleting existing firmware file");
            firmwareFile.delete();
        }
        
        Log.d(TAG, "Downloading BES firmware from: " + firmwareUrl);

        URL url = new URL(firmwareUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
        conn.connect();

        // 2 MiB hard cap. Server-advertised content-length is checked first; we also
        // enforce the cap during the streaming loop so a missing/lying header
        // (Content-Length: -1) cannot drain disk.
        final long maxBytes = 2L * 1024 * 1024;
        long fileSize = conn.getContentLength();

        if (fileSize > maxBytes) {
            conn.disconnect();
            throw new FirmwareDownloadException(
                FirmwareDownloadException.CODE_FILE_TOO_LARGE,
                "BES firmware file too large: " + fileSize + " bytes (max " + maxBytes + ")"
            );
        }

        InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(firmwareFile);

        byte[] buffer = new byte[4096];
        int len;
        long total = 0;
        int lastProgress = 0;

        Log.d(TAG, "Downloading BES firmware, size: " + fileSize + " bytes");

        currentUpdateType = "bes";

        try {
            while ((len = in.read(buffer)) > 0) {
                total += len;
                if (total > maxBytes) {
                    throw new FirmwareDownloadException(
                        FirmwareDownloadException.CODE_FILE_TOO_LARGE,
                        "BES firmware exceeded " + maxBytes + " bytes during streaming (Content-Length=" + fileSize + ")"
                    );
                }
                out.write(buffer, 0, len);

                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "BES firmware download progress: " + progress + "%");
                    lastProgress = progress;
                }
            }
        } finally {
            try { out.close(); } catch (Exception ignored) {}
            try { in.close(); } catch (Exception ignored) {}
            conn.disconnect();
        }

        Log.d(TAG, "BES firmware downloaded to: " + firmwareFile.getAbsolutePath());

        boolean verified = verifyFirmwareFile(firmwareFile.getAbsolutePath(), firmwareInfo);
        if (verified) {
            Log.i(TAG, "Firmware file verified successfully");
            return true;
        } else {
            firmwareFile.delete();
            throw new FirmwareDownloadException(
                FirmwareDownloadException.CODE_VERIFY_FAILED,
                "BES firmware sha256 verification failed"
            );
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
        return checkAndUpdateMtkFirmware(firmwareInfo, context, true);
    }

    private boolean checkAndUpdateMtkFirmware(JSONObject firmwareInfo, Context context, boolean installNow) {
        // Default: treat as the final firmware step (MTK-only) so it self-reboots. Callers that
        // know a BES update follows pass besUpdateFollows=true to suppress the reboot.
        return checkAndUpdateMtkFirmware(firmwareInfo, context, installNow, false);
    }

    private boolean checkAndUpdateMtkFirmware(JSONObject firmwareInfo, Context context, boolean installNow, boolean besUpdateFollows) {
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
            boolean hasValidCache = isCachedArtifactValid(CACHE_KEY_MTK, UPDATE_TYPE_MTK, OtaConstants.MTK_FIRMWARE_PATH, firmwareInfo);
            if (!hasValidCache) {
                boolean downloaded = downloadMtkFirmware(firmwareUrl, firmwareInfo, context);
                if (!downloaded) {
                    Log.e(TAG, "Failed to download MTK firmware");
                    clearCachedArtifact(CACHE_KEY_MTK, UPDATE_TYPE_MTK);
                    return false;
                }
                markCachedArtifactReady(CACHE_KEY_MTK, UPDATE_TYPE_MTK, OtaConstants.MTK_FIRMWARE_PATH, firmwareInfo);
            } else {
                Log.i(TAG, "📦 Cache hit for MTK firmware - using pre-downloaded artifact");
            }

            if (!installNow) {
                return true;
            }

            if (!isPhoneInitiatedOta) {
                Log.w(TAG, "MTK firmware install blocked - requires explicit ota_start from phone");
                return false;
            }

            Log.i(TAG, "✅ MTK firmware ready for install");

            // Record whether this install should self-reboot on success. An MTK-only update
            // (no BES update following) has nothing to power-cycle the device and apply the
            // staged A/B image, so OtaService reboots on success. When a BES update follows,
            // the BES install power-cycles the device for us, so we must not reboot here.
            rebootAfterMtkInstall = !besUpdateFollows;

            // Set flag before starting update
            isMtkOtaInProgress = true;

            // Mark MTK as updated this session (install will happen in background)
            setMtkUpdatedThisSession();

            // Send install STARTED to phone - progress updates will follow during install
            sendMtkInstallProgressToPhone("STARTED", 0, null);
            Log.i(TAG, "📱 Sent MTK install STARTED to phone - waiting 1s before starting install");

            // Wait 1 second for phone to process FINISHED, then start install
            final Context ctx = context;
            final android.os.Handler mtkHandler = new android.os.Handler(android.os.Looper.getMainLooper());
            mtkHandler.postDelayed(() -> {
                Log.i(TAG, "Starting MTK firmware update from: " + OtaConstants.MTK_FIRMWARE_PATH);
                com.mentra.asg_client.SysControl.installOTA(ctx, OtaConstants.MTK_FIRMWARE_PATH);
                Log.i(TAG, "MTK firmware update initiated - system will handle in background");
            }, 1000); // 1 second delay

            // 10-minute timeout: if no broadcast arrives, clear isMtkOtaInProgress
            final long MTK_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
            mtkHandler.postDelayed(() -> {
                if (isMtkOtaInProgress) {
                    Log.e(TAG, "MTK install timeout after " + (MTK_INSTALL_TIMEOUT_MS / 60000) + " min — no broadcast received, clearing flag");
                    isMtkOtaInProgress = false;
                    sendMtkInstallProgressToPhone("FAILED", 0, "MTK install timed out — no response from system");
                }
            }, MTK_INSTALL_TIMEOUT_MS);

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to update MTK firmware", e);
            isMtkOtaInProgress = false;
            clearCachedArtifact(CACHE_KEY_MTK, UPDATE_TYPE_MTK);
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
            boolean success = downloadMtkFirmwareInternal(firmwareUrl, firmwareInfo, context);
            if (success) {
                return true;
            }
            Log.e(TAG, "MTK firmware download returned false unexpectedly");
            sendProgressToPhone("download", 0, 0, 0, "FAILED", "download_failed");
            return false;
        } catch (FirmwareDownloadException nonRetryable) {
            Log.e(TAG, "MTK firmware download failed: " + nonRetryable.getErrorCode(), nonRetryable);
            File partialFile = new File(OtaConstants.BASE_DIR, OtaConstants.MTK_FIRMWARE_FILENAME);
            if (partialFile.exists()) {
                partialFile.delete();
            }
            sendProgressToPhone("download", 0, 0, 0, "FAILED", nonRetryable.getErrorCode());
            return false;
        } catch (Exception e) {
            Log.e(TAG, "MTK firmware download failed", e);
            File partialFile = new File(OtaConstants.BASE_DIR, OtaConstants.MTK_FIRMWARE_FILENAME);
            if (partialFile.exists()) {
                partialFile.delete();
                Log.d(TAG, "Cleaned up partial MTK firmware file");
            }
            sendProgressToPhone("download", 0, 0, 0, "FAILED", classifyDownloadError(e));
            return false;
        }
    }

    private boolean downloadMtkFirmwareInternal(String firmwareUrl, JSONObject firmwareInfo, Context context) throws Exception {
        File asgDir = new File(OtaConstants.BASE_DIR);
        if (!asgDir.exists()) {
            boolean created = asgDir.mkdirs();
            Log.d(TAG, "ASG directory created: " + created);
        }
        
        File firmwareFile = new File(asgDir, OtaConstants.MTK_FIRMWARE_FILENAME);
        
        if (firmwareFile.exists()) {
            File backupFile = new File(asgDir, OtaConstants.MTK_BACKUP_FILENAME);
            Log.d(TAG, "Creating backup of existing MTK firmware");
            if (backupFile.exists()) {
                backupFile.delete();
            }
            firmwareFile.renameTo(backupFile);
        }
        
        Log.d(TAG, "Downloading MTK firmware from: " + firmwareUrl);

        URL url = new URL(firmwareUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
        conn.connect();

        // 100 MiB hard cap. Server-advertised content-length is checked first; the
        // streaming loop also enforces the cap so a missing/lying header
        // (Content-Length: -1) cannot drain disk.
        final long maxBytes = 100L * 1024 * 1024;
        long fileSize = conn.getContentLength();

        if (fileSize > maxBytes) {
            conn.disconnect();
            throw new FirmwareDownloadException(
                FirmwareDownloadException.CODE_FILE_TOO_LARGE,
                "MTK firmware file too large: " + fileSize + " bytes (max " + maxBytes + ")"
            );
        }

        InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(firmwareFile);

        byte[] buffer = new byte[8192];
        int len;
        long total = 0;
        int lastProgress = 0;

        Log.d(TAG, "Downloading MTK firmware, size: " + fileSize + " bytes");

        currentUpdateType = "mtk";

        try {
            while ((len = in.read(buffer)) > 0) {
                total += len;
                if (total > maxBytes) {
                    throw new FirmwareDownloadException(
                        FirmwareDownloadException.CODE_FILE_TOO_LARGE,
                        "MTK firmware exceeded " + maxBytes + " bytes during streaming (Content-Length=" + fileSize + ")"
                    );
                }
                out.write(buffer, 0, len);

                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "MTK firmware download progress: " + progress + "%");
                    EventBus.getDefault().post(new DownloadProgressEvent(
                        DownloadProgressEvent.DownloadStatus.PROGRESS,
                        progress,
                        total,
                        fileSize
                    ));
                    lastProgress = progress;
                }
            }
        } finally {
            try { out.close(); } catch (Exception ignored) {}
            try { in.close(); } catch (Exception ignored) {}
            conn.disconnect();
        }

        Log.i(TAG, "MTK firmware downloaded to: " + firmwareFile.getAbsolutePath());

        boolean verified = verifyMtkFirmwareChecksum(firmwareFile.getAbsolutePath(), firmwareInfo);
        if (verified) {
            Log.i(TAG, "MTK firmware file verified successfully");
            return true;
        } else {
            firmwareFile.delete();
            throw new FirmwareDownloadException(
                FirmwareDownloadException.CODE_VERIFY_FAILED,
                "MTK firmware sha256 verification failed"
            );
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

    private JSONObject buildCacheReadyUpdateInfo(JSONObject rootJson) {
        try {
            JSONObject updateInfo = checkForAvailableUpdates(rootJson);
            if (updateInfo == null || !updateInfo.optBoolean("available", false)) {
                return updateInfo;
            }

            JSONArray updates = updateInfo.optJSONArray("updates");
            if (updates == null || updates.length() == 0) {
                return updateInfo;
            }

            if (!allArtifactsCachedForUpdates(rootJson, updates)) {
                updateInfo.put("available", false);
                return updateInfo;
            }

            updateInfo.put("cache_ready", true);
            return updateInfo;
        } catch (Exception e) {
            Log.e(TAG, "Error building cache-ready update info", e);
            return null;
        }
    }

    private boolean allArtifactsCachedForUpdates(JSONObject rootJson, JSONArray updates) {
        try {
            for (int i = 0; i < updates.length(); i++) {
                String updateType = updates.optString(i, "");
                if (UPDATE_TYPE_APK.equals(updateType)) {
                    JSONObject apps = rootJson.optJSONObject("apps");
                    if (apps == null) {
                        return false;
                    }

                    JSONObject asgInfo = apps.optJSONObject("com.mentra.asg_client");
                    if (asgInfo != null && asgInfo.optLong("versionCode", 0) > getInstalledVersion("com.mentra.asg_client", context)) {
                        String asgPath = OtaConstants.BASE_DIR + "/" + getApkFilename("com.mentra.asg_client");
                        if (!isCachedArtifactValid(CACHE_KEY_APK_ASG, UPDATE_TYPE_APK, asgPath, asgInfo)) {
                            return false;
                        }
                    }

                    JSONObject updaterInfo = apps.optJSONObject("com.augmentos.otaupdater");
                    if (updaterInfo != null && updaterInfo.optLong("versionCode", 0) > getInstalledVersion("com.augmentos.otaupdater", context)) {
                        String updaterPath = OtaConstants.BASE_DIR + "/" + getApkFilename("com.augmentos.otaupdater");
                        if (!isCachedArtifactValid(CACHE_KEY_APK_UPDATER, UPDATE_TYPE_APK, updaterPath, updaterInfo)) {
                            return false;
                        }
                    }
                    continue;
                }

                if (UPDATE_TYPE_MTK.equals(updateType)) {
                    if (!rootJson.has("mtk_patches")) {
                        return false;
                    }
                    String currentMtkVersion = SysProp.getProperty(context, "ro.custom.ota.version");
                    JSONObject mtkPatch = findMatchingMtkPatch(rootJson.getJSONArray("mtk_patches"), currentMtkVersion);
                    if (mtkPatch == null) {
                        continue;
                    }
                    if (!isCachedArtifactValid(CACHE_KEY_MTK, UPDATE_TYPE_MTK, OtaConstants.MTK_FIRMWARE_PATH, mtkPatch)) {
                        return false;
                    }
                    continue;
                }

                if (UPDATE_TYPE_BES.equals(updateType)) {
                    JSONObject besInfo = rootJson.optJSONObject("bes_firmware");
                    if (besInfo == null) {
                        return false;
                    }
                    if (!isCachedArtifactValid(CACHE_KEY_BES, UPDATE_TYPE_BES, OtaConstants.BES_FIRMWARE_PATH, besInfo)) {
                        return false;
                    }
                }
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error validating cache readiness for updates", e);
            return false;
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
        
        updateSessionFromProgress(stage, progress, status, errorMessage);

        // Suppress FINISHED while an install pass is queued. The prefetch thread sends
        // FINISHED(download) for each artifact it completes, but no install follows — only
        // the pending install pass will do that. Letting FINISHED through here would cause
        // the phone UI to prematurely transition to "completed" or start a 12s timer before
        // the real install has begun. The install pass sends its own STARTED/PROGRESS/FINISHED.
        if (pendingPhoneInstall && "FINISHED".equals(status)) {
            Log.d(TAG, "Suppressing FINISHED - install pass is pending, will send its own completion");
            return;
        }
        if (phoneConnectionProvider == null || !isPhoneConnected()) {
            return;
        }

        long now = System.currentTimeMillis();
        boolean shouldSend = false;

        // Always send STARTED, FINISHED, FAILED immediately
        if ("STARTED".equals(status) || "FINISHED".equals(status) || "FAILED".equals(status)
                || "IN_PROGRESS".equals(status)) {
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

        lastProgressSentTime = now;
        lastProgressSentPercent = progress;

        lastOtaPhoneStage = stage;
        lastOtaPhoneProgress = progress;
        lastOtaPhoneEventStatus = status;
        lastOtaPhoneError = errorMessage;

        Log.i(TAG, "📱 Sending OTA status: " + stage + " " + status + " " + progress + "%");
        sendOtaStatus();
    }

    private void updateSessionFromProgress(String stage, int progress, String status, String errorMessage) {
        if (sessionManager == null || sessionManager.getSessionState() == null) return;

        int stepIndex = findStepIndex(currentUpdateType);
        if (stepIndex < 0) return;

        // advanceStep resets stepPercent to 0, persists to disk, and stamps last-activity.
        // Calling it on every PROGRESS tick wipes the percent we just received and beats up
        // SharedPreferences. Only advance when the step or phase has actually changed.
        boolean stepChanged = stepIndex != sessionManager.getCurrentStepIndex()
                || !stage.equals(sessionManager.getCurrentPhase());

        if ("STARTED".equals(status)) {
            if (stepChanged) {
                sessionManager.advanceStep(stepIndex, stage);
            }
        } else if ("PROGRESS".equals(status) || "IN_PROGRESS".equals(status)) {
            if (stepChanged) {
                sessionManager.advanceStep(stepIndex, stage);
            }
            sessionManager.updateProgress(progress);
        } else if ("FINISHED".equals(status)) {
            if (stepChanged) {
                sessionManager.advanceStep(stepIndex, stage);
            }
            sessionManager.updateProgress(100);
            if (stepIndex >= sessionManager.getTotalSteps() - 1 && "install".equals(stage)) {
                sessionManager.setComplete();
            }
        } else if ("FAILED".equals(status)) {
            sessionManager.setFailed(errorMessage != null ? errorMessage : "Update failed");
        }
    }

    private int findStepIndex(String updateType) {
        if (sessionManager == null) return -1;
        for (int i = 0; i < sessionManager.getTotalSteps(); i++) {
            if (updateType.equals(sessionManager.getStepType(i))) return i;
        }
        return -1;
    }

    /**
     * Attach a session manager and immediately push its current state to the phone.
     *
     * Used by {@link OtaService#resumeFromSession(OtaSessionManager)} after an APK-only
     * OTA completes across a process restart. The original {@code installApk()} call
     * deliberately skips the FINISHED send because the process is about to die, so the
     * phone needs an explicit completion signal once the new process comes up.
     */
    public void sendCompletionToPhone(OtaSessionManager sm) {
        if (sm == null) return;
        this.sessionManager = sm;
        sendOtaStatus();
    }

    /**
     * Called by OtaService when a non-final OTA step (e.g. MTK) completes successfully.
     *
     * If the session has a next step (e.g. BES after MTK), advances the session and
     * restarts the version-check/install pipeline automatically so BES starts immediately
     * without requiring a phone-side re-check or user tap.
     *
     * If the completed step was the last one, marks the session complete and notifies the phone.
     *
     * @param context Android context for the version-check service call.
     * @return true if auto-advance to next step was triggered; false if the session is done
     *         or there is no active session (caller should fall back to legacy path).
     */
    public boolean continueSessionAfterStepComplete(Context context) {
        if (sessionManager == null || !sessionManager.hasActiveSession()) {
            Log.d(TAG, "continueSessionAfterStepComplete: no active session — using legacy path");
            return false;
        }
        int currentIndex = sessionManager.getCurrentStepIndex();
        int nextStep = currentIndex + 1;

        if (nextStep >= sessionManager.getTotalSteps()) {
            Log.i(TAG, "continueSessionAfterStepComplete: step " + currentIndex + " was last — marking complete");
            sessionManager.setComplete();
            sendOtaStatus();
            return true;
        }

        String nextType = sessionManager.getStepType(nextStep);
        String versionJsonUrl = sessionManager.getVersionJsonUrl();
        Log.i(TAG, "continueSessionAfterStepComplete: auto-advancing from step "
                + currentIndex + " to step " + nextStep + " type=" + nextType);

        // Advance the session record so the phone sees the new current step immediately.
        sessionManager.advanceStep(nextStep, "download");
        sendOtaStatus();

        // Kick off the next step's download/install cycle.
        setPhoneInitiatedOta(true);
        if (versionJsonUrl != null && !versionJsonUrl.isEmpty()) {
            startVersionCheckWithUrl(context, versionJsonUrl);
        } else {
            startVersionCheck(context);
        }
        return true;
    }

    private void sendOtaStatus() {
        if (phoneConnectionProvider == null || !isPhoneConnected() || sessionManager == null) return;
        JSONObject sessionState = sessionManager.getSessionState();
        if (sessionState == null) {
            sessionState = buildMinimalOtaStatusJson();
            if (sessionState == null) {
                Log.w(TAG, "No OTA session and cannot build minimal ota_status — phone will not see progress");
                return;
            }
            Log.w(TAG, "No OTA session state — sending minimal ota_status so the phone UI can update");
        }

        try {
            // Phone bridge (MentraLive.java) reads all fields from the top level of the JSON
            // object, so we add "type" directly to sessionState rather than nesting it under "data".
            sessionState.put("type", "ota_status");
            if ("failed".equals(sessionState.optString("status"))) {
                sessionState.put("glasses_time_ms", System.currentTimeMillis());
            }
            phoneConnectionProvider.sendOtaStatus(sessionState);
        } catch (JSONException e) {
            Log.e(TAG, "Failed to send OTA status", e);
        }
    }

    /**
     * Same wire shape as {@link #sendMtkInstallProgress} — used when {@link OtaSessionManager} has no session
     * (e.g. {@code createSession} did not run) so the phone still receives {@code ota_status}.
     */
    private JSONObject buildMinimalOtaStatusJson() {
        if (lastOtaPhoneEventStatus == null) {
            return null;
        }
        try {
            JSONObject o = new JSONObject();
            o.put("session_id", "");
            o.put("total_steps", 1);
            o.put("current_step", 1);
            o.put("step_type", currentUpdateType != null ? currentUpdateType : "apk");
            o.put("phase", lastOtaPhoneStage != null ? lastOtaPhoneStage : "download");
            o.put("step_percent", lastOtaPhoneProgress);
            o.put("overall_percent", lastOtaPhoneProgress);
            String ev = lastOtaPhoneEventStatus;
            if ("FAILED".equals(ev)) {
                o.put("status", "failed");
                o.put("error_message", lastOtaPhoneError != null ? lastOtaPhoneError : "Update failed");
                o.put("glasses_time_ms", System.currentTimeMillis());
            } else if ("FINISHED".equals(ev)) {
                if ("install".equals(lastOtaPhoneStage)) {
                    o.put("status", "complete");
                } else {
                    o.put("status", "step_complete");
                }
                o.put("error_message", JSONObject.NULL);
            } else {
                o.put("status", "in_progress");
                o.put("error_message", JSONObject.NULL);
            }
            return o;
        } catch (JSONException e) {
            Log.e(TAG, "buildMinimalOtaStatusJson failed", e);
            return null;
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
     * Immediately acknowledge receipt of ota_start to the phone.
     * Sent before any version check or download so the phone can cancel its retry timer
     * without waiting for the first download/install progress event.
     */
    private void sendOtaStartAck() {
        if (phoneConnectionProvider == null || !isPhoneConnected()) {
            Log.d(TAG, "📱 Cannot send ota_start_ack - phone not connected");
            return;
        }
        try {
            JSONObject ack = new JSONObject();
            ack.put("type", "ota_start_ack");
            ack.put("timestamp", System.currentTimeMillis());
            phoneConnectionProvider.sendOtaMessage(ack);
            Log.i(TAG, "📱 Sent ota_start_ack to phone");
        } catch (JSONException e) {
            Log.e(TAG, "Failed to send ota_start_ack", e);
        }
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
            JSONObject o = new JSONObject();
            o.put("type", "ota_status");
            o.put("session_id", "");
            o.put("total_steps", 1);
            o.put("current_step", 1);
            o.put("step_type", "mtk");
            o.put("phase", "install");
            o.put("step_percent", progress);
            o.put("overall_percent", progress);
            if ("FAILED".equals(status)) {
                o.put("status", "failed");
                o.put("error_message", message != null ? message : "MTK update failed");
            } else if ("FINISHED".equals(status)) {
                o.put("status", "complete");
            } else {
                o.put("status", "in_progress");
            }

            provider.sendOtaStatus(o);
            Log.d(TAG, "📱 Sent MTK install status: " + status + " " + progress + "%");
        } catch (JSONException e) {
            Log.e(TAG, "Failed to send MTK install status", e);
        }
    }

    // ========== Pending BES Update Methods ==========

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
