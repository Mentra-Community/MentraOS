package com.mentra.asg_client.io.ota.helpers;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.content.Intent;

import org.json.JSONException;
import org.json.JSONObject;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.io.ota.events.DownloadProgressEvent;
import com.mentra.asg_client.io.ota.events.InstallationProgressEvent;
import com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator;
import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator.ValidatedBesArtifact;
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
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.Semaphore;
import java.util.stream.Collectors;

import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.io.ota.utils.DowngradeGate;
import com.mentra.asg_client.io.ota.utils.FirmwareDownloadException;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
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
    // A permit, rather than a ReentrantLock, lets the phone command thread reserve OTA admission
    // synchronously and hand ownership to its worker. This closes the acknowledged-but-dropped
    // window without changing the existing single-worker pipeline.
    private static final Semaphore otaAdmissionPermit = new Semaphore(1);
    private static volatile boolean isUpdating = false;  // Tracks download/install in progress

    // Downgrade handoff verdict plumbing: the watchdog must be cancellable because recovery
    // answers every handoff synchronously (accepted/refused); "no answer" is reserved for a
    // dead/missing recovery worker. Guarded by OtaHelper.class.
    private static final Handler HANDOFF_HANDLER = new Handler(Looper.getMainLooper());
    private static Runnable handoffWatchdog;
    private static OtaHelper handoffOwner;
    private static volatile boolean isMtkOtaInProgress = false;  // Tracks MTK firmware update in progress

    private Handler handler;
    private Context context;


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

    // ========== Phone-Controlled OTA State ==========

    // Provider for phone connection status and messaging
    private PhoneConnectionProvider phoneConnectionProvider;

    // Session manager for persisting OTA state across APK restarts
    private OtaSessionManager sessionManager;

    // Track phone-initiated vs glasses-initiated OTA
    private static volatile boolean isPhoneInitiatedOta = false;

    // The manifest URL of the current/last phone-started OTA check. Always phone-supplied:
    // the glasses have no baked default manifest and never originate an OTA decision.
    private volatile String lastVersionJsonUrl = null;

    /**
     * Set the phone-initiated OTA flag. Used by DebugApkOtaReceiver to force
     * the OTA pipeline to run through the same explicit phone-started path as {@code ota_start}.
     */
    public void setPhoneInitiatedOta(boolean value) {
        isPhoneInitiatedOta = value;
    }

    /**
     * Whether another OTA flow currently owns admission. Used by the post-APK-restart resume
     * path to stand down when a phone-initiated check has superseded it.
     */
    public boolean isOtaAdmissionBusy() {
        return otaAdmissionPermit.availablePermits() == 0;
    }

    // Progress throttling - send every 2s OR every 5% change
    private long lastProgressSentTime = 0;
    private int lastProgressSentPercent = 0;
    private static final long PROGRESS_MIN_INTERVAL_MS = 2000; // 2 seconds
    private static final int PROGRESS_MIN_CHANGE_PERCENT = 5;   // 5%
    // Current update stage for progress reporting
    private String currentUpdateStage = "download"; // "download" or "install"
    private String currentUpdateType = "apk"; // "apk", "mtk", or "bes"
    private volatile String lastApkFailureErrorCode;

    // Track if MTK was updated this session (to prevent re-updating before reboot)
    // MTK A/B updates don't change ro.custom.ota.version until reboot, so without this
    // flag the system would try to re-download and re-install the same MTK update
    private static volatile boolean mtkUpdatedThisSession = false;
    // True when the in-flight MTK install is the final firmware step (no BES update follows).
    // BES installs power-cycle the device themselves; an MTK-only update has nothing to trigger
    // the reboot its staged A/B image needs, so OtaService reboots on MTK success. Set at install
    // kickoff so it is correct on both the session and legacy/no-session completion paths.
    private volatile boolean rebootAfterMtkInstall = false;

    /** Snapshot for {@link #buildMinimalOtaStatusJson()} when no OTA session exists (aligns with {@link #sendMtkInstallProgress} shape). */
    private String lastOtaPhoneStage;
    private int lastOtaPhoneProgress;
    private String lastOtaPhoneEventStatus;
    private String lastOtaPhoneError;

    private final IBesOtaRegistry besOtaRegistry;

    public OtaHelper(Context context, IBesOtaRegistry besOtaRegistry) {
        this.besOtaRegistry = besOtaRegistry;
        this.context = context.getApplicationContext(); // Use application context to avoid memory leaks
        handler = new Handler(Looper.getMainLooper());
        sessionManager = new OtaSessionManager(this.context);

        // Register for EventBus to receive battery status updates
        EventBus.getDefault().register(this);

        Log.i(TAG, "OTA helper initialized - updates only via phone app");
    }

    /**
     * @return the active BES OTA controller, or null if BES OTA is not initialized (non-K900
     *     devices, or before the transport is ready)
     */
    private IBesOtaController getOtaController() {
        return besOtaRegistry.getInstance();
    }

    /**
     * @return true if a BES OTA update is currently in progress; false when no controller exists
     */
    private boolean isBesOtaInProgress() {
        IBesOtaController controller = getOtaController();
        return controller != null && controller.isBesOtaInProgress();
    }

    public void cleanup() {
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
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
        // Durable BES truth is read at delivery time; EventBus and process-local retry timers are
        // only wake-ups and never become a second terminal store.
        sendAuthoritativeBesStatusToPhone();
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
            JSONObject besStatus = getAuthoritativeBesStatus();
            if (besStatus != null) {
                return besStatus;
            }
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

    private JSONObject getAuthoritativeBesStatus() {
        IBesOtaController controller = getOtaController();
        return controller != null ? controller.getAuthoritativeStatus() : null;
    }

    /**
     * Project durable BES state when one exists.
     *
     * @return true when a durable projection exists, even if the phone is currently disconnected
     */
    public boolean sendAuthoritativeBesStatusToPhone() {
        JSONObject status = getAuthoritativeBesStatus();
        if (status == null) {
            Log.i(TAG, "BES_OTA_DIAG phone_projection=absent");
            return false;
        }
        boolean connected = phoneConnectionProvider != null && isPhoneConnected();
        Log.i(
                TAG,
                "BES_OTA_DIAG phone_projection=durable connected="
                        + connected
                        + " status="
                        + status);
        if (connected) {
            phoneConnectionProvider.sendOtaStatus(status);
        }
        return true;
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
     * Called when phone disconnects.
     */
    public void onPhoneDisconnected() {
        Log.d(TAG, "Phone disconnected");
    }

    private String getApkFilename(String packageName) {
        return packageName.equals("com.mentra.asg_client") ? "asg_client_update.apk" : "ota_updater_update.apk";
    }

    public void deleteDownloadedArtifactForType(String updateType) {
        if (UPDATE_TYPE_MTK.equals(updateType)) {
            deleteFileIfExists(OtaConstants.MTK_FIRMWARE_PATH, "MTK firmware artifact");
            deleteFileIfExists(OtaConstants.MTK_BACKUP_PATH, "MTK backup artifact");
            return;
        }
        if (UPDATE_TYPE_BES.equals(updateType)) {
            deleteFileIfExists(OtaConstants.BES_FIRMWARE_PATH, "BES firmware artifact");
            deleteFileIfExists(OtaConstants.BES_BACKUP_PATH, "BES backup artifact");
        }
    }

    private void deleteFileIfExists(String path, String label) {
        File file = new File(path);
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "Failed deleting " + label + ": " + path);
        }
    }
    private static final long OTA_WAKELOCK_TIMEOUT_MS = 600000;

    private List<String> buildStepSequence(JSONObject rootJson, JSONObject apps, Context context) {
        List<String> steps = new ArrayList<>();
        try {
            String[] orderedPackages = {"com.mentra.asg_client", "com.augmentos.otaupdater"};
            for (String pkg : orderedPackages) {
                if (!apps.has(pkg)) continue;
                long current = getInstalledVersion(pkg, context);
                long server = apps.getJSONObject(pkg).getLong("versionCode");
                // Count the ASG step in either direction so the session's step accounting
                // matches the work the pass actually performs. For a downgrade the handoff is
                // deferred while firmware is applicable (firmware-first ordering), so only plan
                // the apk step on the pass that will actually hand off (no applicable firmware).
                boolean asgDowngrade = OtaConstants.ASG_PACKAGE.equals(pkg)
                        && DowngradeGate.shouldDowngrade(
                                current, server, OtaConstants.DOWNGRADE_FLOOR_VERSION_CODE)
                        && !hasApplicableFirmwareUpdate(rootJson, context);
                if (server > current || asgDowngrade) {
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
                if (besUpdateApplicableForSession(rootJson.getJSONObject("bes_firmware"), besVer, rootJson, context)) {
                    steps.add("bes");
                }
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
     * Start OTA update from phone command (onboarding or background approval). Called by
     * OtaCommandHandler when phone sends ota_start with its mandatory manifest URL. Every manifest
     * the glasses act on is phone-supplied and exact-pin shaped; there is no baked fallback.
     */
    public void startOtaFromPhone(String versionJsonUrl) {
        String requestedVersionJsonUrl = requireVersionJsonUrl(versionJsonUrl);
        if (requestedVersionJsonUrl == null) {
            // OtaCommandHandler already rejects URL-less ota_start; this is a defensive guard.
            Log.e(TAG, "Refusing ota_start without a manifest URL");
            return;
        }
        Log.i(TAG, "📱 Starting OTA from phone request");

        // Immediately acknowledge receipt so the phone cancels its retry timer.
        sendOtaStartAck();
        String resolvedVersionJsonUrl = requireVersionJsonUrl(requestedVersionJsonUrl);
        if (resolvedVersionJsonUrl == null) {
            Log.e(TAG, "Refusing phone OTA start without a manifest URL");
            sendOtaStatus();
            return;
        }

        // Reserve admission before arming phone state or the wake lease. Semaphore ownership can
        // cross threads, so the worker can release the reservation when the pipeline finishes.
        if (!otaAdmissionPermit.tryAcquire()) {
            Log.i(
                    TAG,
                    "📱 OTA already in progress - acknowledging ota_start and sending current"
                            + " status");
            sendOtaStatus();
            return;
        }

        boolean handedToWorker = false;
        try {
            if (isUpdating || isMtkOtaInProgress || isBesOtaInProgress()) {
                Log.i(TAG, "📱 OTA install already active - sending current status");
                sendOtaStatus();
                return;
            }

            IBesOtaController besController = getOtaController();
            if (besController != null && !besController.prepareForNewOtaSession()) {
                Log.w(TAG, "BES durable state blocks a new OTA session");
                sendAuthoritativeBesStatusToPhone();
                return;
            }

            // Acquire wakelock to prevent CPU sleep during OTA download/install
            WakeLockManager.acquireCpu(
                    context, WakeLockManager.WakeOwner.MTK_OTA, OTA_WAKELOCK_TIMEOUT_MS);
            Log.i(
                    TAG,
                    "📱 OTA wakelock acquired for "
                            + (OTA_WAKELOCK_TIMEOUT_MS / 1000)
                            + " seconds");

            isPhoneInitiatedOta = true;

            // Reset progress tracking
            lastProgressSentTime = 0;
            lastProgressSentPercent = 0;

            Log.i(
                    TAG,
                    "📱 Phone-initiated OTA: starting version check (download STARTED deferred)");

            startVersionCheckWithReservedAdmission(context, resolvedVersionJsonUrl, true);
            handedToWorker = true;
        } finally {
            if (!handedToWorker) {
                isPhoneInitiatedOta = false;
                WakeLockManager.release(WakeLockManager.WakeOwner.MTK_OTA);
                otaAdmissionPermit.release();
            }
        }
    }

    private String requireVersionJsonUrl(String versionJsonUrl) {
        if (versionJsonUrl == null || versionJsonUrl.trim().isEmpty()) {
            return null;
        }
        return versionJsonUrl.trim();
    }

    /**
     * Start a version check using a custom version JSON URL.
     * Used by DebugApkOtaReceiver to test OTA with a local/custom URL.
     * @param context Application context
     * @param versionJsonUrl URL to fetch the version JSON from (http, https)
     * @return true when admission was reserved and the worker was dispatched
     */
    public boolean startVersionCheckWithUrl(Context context, String versionJsonUrl) {
        String resolvedVersionJsonUrl = requireVersionJsonUrl(versionJsonUrl);
        if (resolvedVersionJsonUrl == null) {
            Log.e(TAG, "Refusing OTA version check without a manifest URL");
            return false;
        }
        if (!otaAdmissionPermit.tryAcquire()) {
            Log.w(TAG, "Version check admission is busy; refusing before worker dispatch");
            return false;
        }
        if (isUpdating || isMtkOtaInProgress || isBesOtaInProgress()) {
            Log.w(TAG, "Version check admission blocked by an active OTA install");
            otaAdmissionPermit.release();
            return false;
        }

        isPhoneInitiatedOta = true;
        try {
            startVersionCheckWithReservedAdmission(context, resolvedVersionJsonUrl, false);
            return true;
        } catch (RuntimeException dispatchFailure) {
            Log.e(TAG, "Could not dispatch admitted OTA version check", dispatchFailure);
            isPhoneInitiatedOta = false;
            otaAdmissionPermit.release();
            return false;
        } catch (Error fatalDispatchFailure) {
            isPhoneInitiatedOta = false;
            otaAdmissionPermit.release();
            throw fatalDispatchFailure;
        }
    }

    private void startVersionCheckWithReservedAdmission(
            Context context, String resolvedVersionJsonUrl, boolean releaseWakeOnAdmissionAbort) {
        Log.d(TAG, "Check OTA update method init");
        Log.i(TAG, "OTA check trigger -> phoneInitiated=" + isPhoneInitiatedOta
                + ", admissionHeld=" + (otaAdmissionPermit.availablePermits() == 0)
                + ", isUpdating=" + isUpdating
                + ", mtkInProgress=" + isMtkOtaInProgress
                + ", besInProgress=" + isBesOtaInProgress()
                + ", versionJsonUrl=" + resolvedVersionJsonUrl);

        // if (!isNetworkAvailable(context)) {
        //     Log.e(TAG, "No WiFi connection available. Skipping OTA check.");
        //     return;
        // }

        new Thread(() -> {
            Log.d(TAG, "OTA admission permit acquired");

            // Store the URL under admission so a concurrent caller can't overwrite it
            // before this check finishes.
            lastVersionJsonUrl = resolvedVersionJsonUrl;

            // Check if update is in progress (separate from version check)
            if (isUpdating) {
                Log.d(TAG, "Update already in progress, skipping version check");
                isPhoneInitiatedOta = false;
                if (releaseWakeOnAdmissionAbort) {
                    WakeLockManager.release(WakeLockManager.WakeOwner.MTK_OTA);
                }
                sendOtaStatus();
                otaAdmissionPermit.release();
                return;
            }

            final String[] stage = new String[]{"init"};
            final boolean[] otaCheckReachedSuccessLog = {false};

            try {
                if (!isPhoneInitiatedOta) {
                    Log.i(TAG, "Ignoring non-phone OTA version check; phone must send ota_start");
                    return;
                }

                stage[0] = "fetch_version_info";
                // Fetch version info from URL
                String versionInfo = fetchVersionInfo(resolvedVersionJsonUrl);
                stage[0] = "parse_version_json";
                JSONObject json = new JSONObject(versionInfo);

                Log.d(TAG, "Version JSON parsed successfully. Root keys -> apps=" + json.has("apps")
                        + ", mtk_patches=" + json.has("mtk_patches")
                        + ", bes_firmware=" + json.has("bes_firmware"));

                // Check if new format (multiple apps) or legacy format
                Log.i(TAG, "OTA execution mode -> phone-started install");
                stage[0] = "process_updates";
                if (json.has("apps")) {
                    processAppsSequentially(json, context);
                } else {
                    Log.d(TAG, "Using legacy version.json format");
                    boolean apkUpdated = checkAndUpdateApp("com.mentra.asg_client", json, context);
                    if (!apkUpdated) {
                        Log.e(TAG, "Legacy OTA flow: APK update failed for com.mentra.asg_client");
                        sendProgressToPhone("download", 0, 0, 0, "FAILED",
                                "APK update failed after retries. Please check WiFi and try again.");
                        return;
                    }
                }

                otaCheckReachedSuccessLog[0] = true;
                Log.i(TAG, "OTA check completed successfully");
            } catch (Exception e) {
                String urlForLog = resolvedVersionJsonUrl != null ? resolvedVersionJsonUrl : lastVersionJsonUrl;
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
                        + ", error=" + e.getClass().getName() + ": " + rootMsg
                        + causeInfo, e);
                // Send failure to phone with semantic error classification
                String errorCode = classifyDownloadError(e);
                if (isPhoneInitiatedOta) {
                    sendProgressToPhone(currentUpdateStage, 0, 0, 0, "FAILED", errorCode);
                }
            } finally {
                isPhoneInitiatedOta = false;
                otaAdmissionPermit.release();
                Log.d(
                        TAG,
                        "Version check thread finished (reachedSuccessLog="
                                + otaCheckReachedSuccessLog[0]
                                + ", lastStage="
                                + stage[0]
                                + "), admission released, ready for next check");
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

    private void processAppsSequentially(JSONObject rootJson, Context context) throws Exception {
        // Get the apps object from root
        JSONObject apps = rootJson.getJSONObject("apps");

        if (sessionManager != null) {
            List<String> steps = buildStepSequence(rootJson, apps, context);
            if (!steps.isEmpty()) {
                // Non-null: every check runs through startVersionCheckWithUrl, which stores the
                // phone-supplied URL under the version-check lock before reaching here.
                sessionManager.createSession(steps.toArray(new String[0]), lastVersionJsonUrl);
                Log.i(TAG, "OTA session created with steps: " + steps);
            }
        }

        // Process apps in order - important for sequential updates
        String[] orderedPackages = {
            "com.mentra.asg_client",     // Update ASG client first
            // "com.augmentos.otaupdater"      // Then OTA updater
        };

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
                boolean success = checkAndUpdateApp(packageName, appInfo, context);

                if (success) {
                    Log.i(TAG, "Successfully updated " + packageName);
                    apkUpdateNeeded = true;

                    // Wait a bit for installation to complete before checking next app
                    Thread.sleep(5000); // 5 seconds
                } else {
                    Log.e(TAG, "Failed to process " + packageName);
                    apkUpdateFailed = true;
                    failedApkPackage = packageName;
                    break; // Stop install sequence if update fails
                }
            } else if (OtaConstants.ASG_PACKAGE.equals(packageName)
                    && DowngradeGate.shouldDowngrade(
                            currentVersion,
                            serverVersion,
                            OtaConstants.DOWNGRADE_FLOOR_VERSION_CODE)) {
                if (hasApplicableFirmwareUpdate(rootJson, context)) {
                    // Firmware first, ASG replacement last (the spec's downgrade ordering):
                    // the current -- newer -- ASG applies MTK/BES this session, and the phone's
                    // next check re-offers the still-mismatched pin, handing off the downgrade
                    // once no firmware remains. Multi-pass by design: each pass converges one
                    // layer and the phone re-checks after each.
                    Log.i(TAG, "Pinned downgrade pending for " + packageName
                            + " but firmware updates are applicable - applying firmware first,"
                            + " downgrade on the next pass");
                } else {
                    Log.i(TAG, "Pinned downgrade requested for " + packageName +
                             " (current: " + currentVersion + ", target: " + serverVersion + ")");

                    boolean handedOff = stageAndHandoffDowngrade(appInfo, context);
                    if (handedOff) {
                        // The recovery worker owns the transaction from here; the uninstall it
                        // sends will kill this process shortly. Do not plan further steps.
                        apkUpdateNeeded = true;
                        break;
                    }
                    Log.e(TAG, "Failed to stage downgrade for " + packageName);
                    apkUpdateFailed = true;
                    failedApkPackage = packageName;
                    break;
                }
            } else {
                Log.d(TAG, packageName + " is up to date (version " + currentVersion + ")");
            }
        }

        Log.d(TAG, "apkUpdateNeeded: " + apkUpdateNeeded);

        if (apkUpdateFailed) {
            String failedPkg = failedApkPackage != null ? failedApkPackage : "APK";
            String errorCode = lastApkFailureErrorCode != null
                    ? lastApkFailureErrorCode
                    : "download_failed";
            Log.e(TAG, "Stopping OTA flow because APK update failed for " + failedPkg);
            sendProgressToPhone("download", 0, 0, 0, "FAILED", errorCode);
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
                    besUpdateAvailable =
                            besUpdateApplicableForSession(
                                    rootJson.getJSONObject("bes_firmware"), currentBesVersion, rootJson, context);
                }

                // Apply updates in correct order
                if (mtkPatch != null && besUpdateAvailable) {
                    // MTK first. The upcoming BES install will power-cycle the device, so
                    // MTK must not self-reboot here (avoids a double reboot).
                    Log.i(TAG, "Both MTK and BES updates available - applying MTK first, BES follows in-session");
                    boolean mtkStarted = checkAndUpdateMtkFirmware(mtkPatch, context, true);
                    if (mtkStarted) {
                        Log.i(TAG, "MTK firmware update started - BES will follow after MTK completes");
                    } else {
                        Log.e(TAG, "MTK firmware update failed to start");
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
                            // MTK is actively being installed - phone will handle BES after MTK completes
                            Log.i(TAG, "BES update available but MTK in progress - phone will start BES after MTK completes");
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
            Log.i(TAG, "APK update performed - remaining firmware steps will download fresh after restart");
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
            // Always reset currentUpdateType before the fresh download begins so progress
            // messages carry the correct label.
            currentUpdateType = "apk";
            lastApkFailureErrorCode = null;

            // Check for mutual exclusion - don't start APK update if firmware update in progress
            if (isBesOtaInProgress()) {
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
                String localPath = OtaConstants.BASE_DIR + "/" + filename;

                isUpdating = true;
                Log.i(TAG, "Starting update process for " + packageName);

                File apkFile = new File(localPath);
                if (apkFile.exists() && !apkFile.delete()) {
                    Log.w(TAG, "Failed deleting old APK before fresh download: " + apkFile.getName());
                    isUpdating = false;
                    return false;
                }

                createAppBackup(packageName, context);

                boolean downloadOk = downloadApk(apkUrl, appInfo, context, filename);
                if (!downloadOk) {
                    isUpdating = false;
                    Log.d(TAG, "Download failed, cleared isUpdating for next OTA attempt");
                    return false;
                }

                Log.i(TAG, "📲 Proceeding to install " + packageName + " from freshly downloaded artifact");
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
                    // Install never actually fired. Roll back the restart guard so the next
                    // OTA attempt does not inherit stale process-restart state.
                    Log.w(TAG, "installApk did not kick install — rolling back restart guard and reporting FAILED");
                    if (sessionManager != null) {
                        sessionManager.clearRestartGuard();
                    }
                    sendProgressToPhone("install", 0, 0, 0, "FAILED", "install_failed");
                    if (apkFile.exists() && !apkFile.delete()) {
                        Log.w(TAG, "Failed deleting APK after install kickoff failure: " + localPath);
                    }
                    return false;
                }

                // Leave the APK in place after the install broadcast because SystemUI
                // consumes the pkpath asynchronously. This is not a cache source: the
                // next OTA attempt deletes any stale APK before downloading a fresh,
                // checksum-verified replacement.

                return true;
            }
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Failed to update " + packageName, e);
            isUpdating = false;
            return false;
        }
    }

    /**
     * Stages a pinned lower-version ASG APK and hands the install transaction to the recovery
     * worker.
     *
     * <p>The OEM installer refuses direct downgrades, so the recovery worker performs the detour:
     * uninstall the system-app update (reverting to the passive factory build and wiping ASG
     * state — the deterministic reset a downgrade requires), then install the staged APK as an
     * ordinary upgrade from the factory floor. ASG cannot supervise any of that itself because the
     * uninstall kills this process and destroys every ASG-owned preference store, so the handoff
     * is the last thing ASG does. The phone observes convergence by comparing the reported build
     * number against the pinned manifest after reconnection.
     *
     * @return {@code true} when the APK was staged, checksum-verified, and the handoff broadcast
     *     was dispatched. The device is untouched when this returns {@code false}.
     */
    /**
     * True when this manifest carries firmware the device would actually apply right now,
     * mirroring the phase-2 decisions exactly: an MTK patch matching the current firmware
     * (unless MTK already updated this session or is in progress) or a BES image newer than
     * the cached BES version. Used to order combined sessions: firmware runs before an ASG
     * downgrade is handed off, so the newest ASG drives the flashes and the replacement is
     * the final step.
     */
    /** True when this manifest pins the ASG below the installed build and the gate allows it. */
    private boolean isPinnedDowngradePending(JSONObject rootJson, Context context) {
        try {
            JSONObject apps = rootJson.optJSONObject("apps");
            if (apps == null) return false;
            JSONObject asg = apps.optJSONObject(OtaConstants.ASG_PACKAGE);
            if (asg == null) return false;
            long server = asg.optLong("versionCode", 0);
            long current = getInstalledVersion(OtaConstants.ASG_PACKAGE, context);
            return DowngradeGate.shouldDowngrade(
                    current, server, OtaConstants.DOWNGRADE_FLOOR_VERSION_CODE);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Session-scoped BES decision. {@link #checkBesUpdate} deliberately treats an unknown
     * cached BES version as "flash to be safe" — correct for plain upgrade sessions. In a
     * session whose manifest also pins an ASG downgrade that policy is wrong in BOTH
     * directions: counting unknown-BES as applicable would defer the handoff forever while
     * the cache stays empty, and flashing blind would let the detour's uninstall kill ASG —
     * the UART flasher — mid-transfer. So with a pinned downgrade pending and no cached BES
     * version, BES is out of scope for this session everywhere (ordering gate, step
     * sequence, apply decision). The detour reboots the glasses, BES reports its real
     * version at boot (hs_syvr), and the phone's next check re-offers the firmware with a
     * known version.
     */
    private boolean besUpdateApplicableForSession(
            JSONObject besFirmware, String currentBesVersion, JSONObject rootJson, Context context) {
        if ((currentBesVersion == null || currentBesVersion.isEmpty())
                && isPinnedDowngradePending(rootJson, context)) {
            Log.i(
                    TAG,
                    "BES version unknown and a pinned downgrade is pending — BES out of scope"
                            + " this session (re-offered after the detour)");
            return false;
        }
        return checkBesUpdate(besFirmware, currentBesVersion);
    }

    private boolean hasApplicableFirmwareUpdate(JSONObject rootJson, Context context) {
        try {
            if (!wasMtkUpdatedThisSession() && !isMtkOtaInProgress() && rootJson.has("mtk_patches")) {
                String currentMtkVersion = SysProp.getProperty(context, "ro.custom.ota.version");
                if (findMatchingMtkPatch(rootJson.getJSONArray("mtk_patches"), currentMtkVersion) != null) {
                    return true;
                }
            }
            if (rootJson.has("bes_firmware")) {
                String currentBesVersion = "";
                try {
                    currentBesVersion = new AsgSettings(context).getBesFirmwareVersion();
                } catch (Exception e) {
                    Log.e(TAG, "Error getting BES firmware version from AsgSettings", e);
                }
                if (besUpdateApplicableForSession(
                        rootJson.getJSONObject("bes_firmware"), currentBesVersion, rootJson, context)) {
                    return true;
                }
            }
        } catch (Exception e) {
            // Ordering is best-effort: on any evaluation error fall through to the downgrade
            // handoff rather than deferring it forever.
            Log.w(TAG, "Could not evaluate firmware applicability; proceeding with downgrade", e);
        }
        return false;
    }

    private boolean stageAndHandoffDowngrade(JSONObject appInfo, Context context) {
        try {
            currentUpdateType = "apk";
            lastApkFailureErrorCode = null;

            if (isBesOtaInProgress()) {
                Log.w(TAG, "BES firmware update in progress - skipping downgrade");
                return false;
            }
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update in progress - skipping downgrade");
                return false;
            }

            long targetVersion = appInfo.getLong("versionCode");
            String apkUrl = appInfo.getString("apkUrl");
            String expectedSha = appInfo.optString("sha256", "");
            if (expectedSha.isEmpty()) {
                // The recovery worker re-verifies the staged bytes against this hash after ASG is
                // gone; never hand over bytes that cannot be re-verified.
                Log.e(TAG, "Refusing downgrade: manifest entry has no sha256");
                return false;
            }

            // The recovery worker owns the transaction after the handoff; an older worker would
            // silently ignore the broadcast. ASG deploys its bundled worker asynchronously at
            // startup, so a too-old worker here usually means that deploy has not landed yet —
            // fail this attempt and let the phone's next OTA check retry.
            long recoveryVersion =
                    getInstalledVersion(OtaConstants.RECOVERY_PACKAGE, context);
            if (recoveryVersion < OtaConstants.MIN_RECOVERY_VERSION_FOR_DOWNGRADE) {
                Log.e(TAG, "Refusing downgrade: recovery worker version " + recoveryVersion
                        + " < required " + OtaConstants.MIN_RECOVERY_VERSION_FOR_DOWNGRADE);
                return false;
            }

            isUpdating = true;
            File apkFile = new File(OtaConstants.BASE_DIR, OtaConstants.DOWNGRADE_APK_FILENAME);
            if (apkFile.exists() && !apkFile.delete()) {
                Log.w(TAG, "Failed deleting stale downgrade APK: " + apkFile.getAbsolutePath());
                isUpdating = false;
                return false;
            }

            boolean downloadOk =
                    downloadApk(apkUrl, appInfo, context, OtaConstants.DOWNGRADE_APK_FILENAME);
            if (!downloadOk) {
                isUpdating = false;
                return false;
            }

            currentUpdateStage = "install";
            sendProgressToPhone("install", 0, 0, 0, "STARTED", null);

            Intent handoff = new Intent(OtaConstants.RECOVERY_REQUEST_DOWNGRADE);
            handoff.setPackage(OtaConstants.RECOVERY_PACKAGE);
            handoff.putExtra(OtaConstants.EXTRA_DOWNGRADE_TARGET_VERSION, targetVersion);
            handoff.putExtra(OtaConstants.EXTRA_DOWNGRADE_APK_PATH, apkFile.getAbsolutePath());
            handoff.putExtra(OtaConstants.EXTRA_DOWNGRADE_APK_SHA256, expectedSha);
            // Arm before broadcasting: the verdict arrives on the main looper and must always
            // find an armed watchdog to cancel.
            Log.i(TAG, "Handing downgrade off to recovery worker (target " + targetVersion
                    + "); expecting verdict, then uninstall");

            // Recovery answers every handoff synchronously with an accepted/refused verdict
            // (ACTION_DOWNGRADE_HANDOFF_RESULT -> onDowngradeHandoffResult), which cancels this
            // watchdog: accepted arms a long-stop instead, refused fails fast with a distinct
            // error. The timeout below therefore only fires when recovery never answered at all
            // (dead, missing, or pre-verdict version) — in which case no transaction exists and
            // reporting failure is safe.
            armHandoffWatchdog(
                    OtaConstants.DOWNGRADE_HANDOFF_TIMEOUT_MS,
                    "downgrade_handoff_failed",
                    "no verdict from recovery worker");
            context.sendBroadcast(handoff, OtaConstants.RECOVERY_CONTROL_PERMISSION);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to stage downgrade handoff", e);
            isUpdating = false;
            return false;
        }
    }

    /** Arms (replacing any previous) the handoff watchdog; synchronized on the class. */
    private void armHandoffWatchdog(long delayMs, String errorCode, String logReason) {
        synchronized (OtaHelper.class) {
            if (handoffWatchdog != null) {
                HANDOFF_HANDLER.removeCallbacks(handoffWatchdog);
            }
            handoffOwner = this;
            handoffWatchdog = () -> {
                synchronized (OtaHelper.class) {
                    handoffWatchdog = null;
                }
                if (isUpdating) {
                    Log.e(TAG, "Downgrade watchdog (" + logReason + ") after " + (delayMs / 1000)
                            + "s - clearing OTA latch");
                    isUpdating = false;
                    sendProgressToPhone("install", 0, 0, 0, "FAILED", errorCode);
                }
            };
            HANDOFF_HANDLER.postDelayed(handoffWatchdog, delayMs);
        }
    }

    /**
     * Recovery's synchronous verdict on a downgrade handoff, delivered via
     * {@link OtaConstants#ACTION_DOWNGRADE_HANDOFF_RESULT}. Refused fails fast with a
     * distinct error (the phone releases its detour latch ONLY on authenticated refusal or
     * verdict-timeout — never on an accepted-but-slow transaction). Accepted swaps the short
     * watchdog for a long-stop sized past recovery's own stale give-up, so a wedged
     * transaction cannot pin the OTA latch forever.
     */
    public static void onDowngradeHandoffResult(boolean accepted, String reason) {
        OtaHelper owner;
        synchronized (OtaHelper.class) {
            owner = handoffOwner;
            if (owner == null || handoffWatchdog == null) {
                Log.w(TAG, "Handoff verdict (accepted=" + accepted + ") with no pending handoff");
                return;
            }
            HANDOFF_HANDLER.removeCallbacks(handoffWatchdog);
            handoffWatchdog = null;
        }
        if (accepted) {
            Log.i(TAG, "Recovery accepted the downgrade handoff (" + reason
                    + "); transaction owns the detour");
            owner.armHandoffWatchdog(
                    OtaConstants.DOWNGRADE_SUPERVISION_TIMEOUT_MS,
                    "downgrade_transaction_stalled",
                    "accepted transaction never uninstalled");
        } else {
            Log.e(TAG, "Recovery refused the downgrade handoff: " + reason);
            if (isUpdating) {
                isUpdating = false;
                owner.sendProgressToPhone(
                        "install", 0, 0, 0, "FAILED", "downgrade_handoff_refused");
            }
        }
    }

    /**
     * Ensures {@link OtaConstants#BACKUP_APK_PATH} matches or exceeds the installed ASG build.
     * Called on service startup so adb/IDE installs refresh recovery's reinstall target.
     */
    public static void ensureRecoveryBackupIfNeeded(Context context) {
        try {
            Context appContext = context.getApplicationContext();
            PackageManager pm = appContext.getPackageManager();
            PackageInfo installed =
                    pm.getPackageInfo(
                            "com.mentra.asg_client", PackageManager.GET_SIGNING_CERTIFICATES);
            long installedVersion =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                            ? installed.getLongVersionCode()
                            : installed.versionCode;

            File backupApk = new File(OtaConstants.BASE_DIR, OtaConstants.BACKUP_APK_FILENAME);
            long backupVersion = -1L;
            long backupModifiedMs = backupApk.exists() ? backupApk.lastModified() : 0L;
            boolean backupInstallable = false;
            if (backupApk.exists() && backupApk.canRead()) {
                PackageInfo archive =
                        pm.getPackageArchiveInfo(
                                backupApk.getAbsolutePath(),
                                PackageManager.GET_SIGNING_CERTIFICATES);
                if (archive != null) {
                    backupVersion =
                            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                                    ? archive.getLongVersionCode()
                                    : archive.versionCode;
                    if (archive.applicationInfo != null) {
                        archive.applicationInfo.sourceDir = backupApk.getAbsolutePath();
                        archive.applicationInfo.publicSourceDir = backupApk.getAbsolutePath();
                        backupInstallable =
                                (archive.applicationInfo.flags & ApplicationInfo.FLAG_TEST_ONLY)
                                        == 0;
                    }
                }
            }

            if (backupInstallable
                    && backupVersion >= installedVersion
                    && backupModifiedMs >= installed.lastUpdateTime) {
                Log.d(
                        TAG,
                        "Recovery backup up to date (backup="
                                + backupVersion
                                + ", backupInstallable="
                                + backupInstallable
                                + ", backupModifiedMs="
                                + backupModifiedMs
                                + ", installed="
                                + installedVersion
                                + ", installedLastUpdateMs="
                                + installed.lastUpdateTime
                                + ")");
                return;
            }

            Log.i(
                    TAG,
                    "Refreshing recovery backup (backup="
                            + backupVersion
                            + ", backupInstallable="
                            + backupInstallable
                            + ", backupModifiedMs="
                            + backupModifiedMs
                            + ", installed="
                            + installedVersion
                            + ", installedLastUpdateMs="
                            + installed.lastUpdateTime
                            + ")");
            createAppBackup("com.mentra.asg_client", appContext);
        } catch (Exception e) {
            Log.e(TAG, "Failed to ensure recovery backup", e);
        }
    }

    private static void createAppBackup(String packageName, Context context) {
        // Only backup ASG client - OTA updater can be restored from ASG client assets
        if (!packageName.equals("com.mentra.asg_client")) {
            Log.d(TAG, "Skipping backup for " + packageName + " (can be restored from assets)");
            return;
        }

        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info =
                    pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES);
            File backupSource = resolveInstallableBackupSource(pm, info);
            if (backupSource == null) {
                Log.e(
                        TAG,
                        "No installable ASG APK for recovery backup (installed build is testOnly and"
                                + " no release OTA APK at "
                                + OtaConstants.ASG_UPDATE_APK_PATH
                                + ")");
                return;
            }

            File backupFile = new File(OtaConstants.BASE_DIR, OtaConstants.BACKUP_APK_FILENAME);
            copyFile(backupSource, backupFile);

            PackageInfo sourceInfo =
                    pm.getPackageArchiveInfo(
                            backupSource.getAbsolutePath(),
                            PackageManager.GET_SIGNING_CERTIFICATES);
            long versionCode = info.getLongVersionCode();
            String versionName = info.versionName;
            if (sourceInfo != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    versionCode = sourceInfo.getLongVersionCode();
                } else {
                    versionCode = sourceInfo.versionCode;
                }
                versionName = sourceInfo.versionName;
            }

            JSONObject backupMetadata = new JSONObject();
            backupMetadata.put("packageName", packageName);
            backupMetadata.put("versionCode", versionCode);
            backupMetadata.put("versionName", versionName);
            backupMetadata.put("createdAtMs", System.currentTimeMillis());
            backupMetadata.put("path", backupFile.getAbsolutePath());
            backupMetadata.put("sourceApk", backupSource.getAbsolutePath());
            File metadataFile = new File(OtaConstants.BASE_DIR, "asg_client_backup.json");
            FileWriter metadataWriter = new FileWriter(metadataFile);
            metadataWriter.write(backupMetadata.toString());
            metadataWriter.close();

            Log.i(
                    TAG,
                    "Created backup for "
                            + packageName
                            + " from "
                            + backupSource.getAbsolutePath()
                            + " at "
                            + backupFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to create backup for " + packageName, e);
        }
    }

    private static File resolveInstallableBackupSource(PackageManager pm, PackageInfo installedInfo) {
        File installedApk = new File(installedInfo.applicationInfo.sourceDir);
        if (!isTestOnlyApk(pm, installedApk.getAbsolutePath())) {
            return installedApk;
        }
        Log.w(
                TAG,
                "Installed ASG APK is testOnly; trying OTA update APK for recovery backup: "
                        + OtaConstants.ASG_UPDATE_APK_PATH);
        File otaApk = new File(OtaConstants.ASG_UPDATE_APK_PATH);
        if (otaApk.exists() && !isTestOnlyApk(pm, otaApk.getAbsolutePath())) {
            if (isValidAsgArchiveForBackup(pm, otaApk.getAbsolutePath(), installedInfo)) {
                return otaApk;
            }
            Log.w(TAG, "Ignoring OTA APK fallback: package mismatch or unreadable archive");
        }
        return null;
    }

    private static boolean isValidAsgArchiveForBackup(
            PackageManager pm, String apkPath, PackageInfo installedInfo) {
        PackageInfo archiveInfo =
                pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNING_CERTIFICATES);
        if (archiveInfo == null || !OtaConstants.ASG_PACKAGE.equals(archiveInfo.packageName)) {
            return false;
        }
        Set<String> archiveSigners = getSignerDigests(archiveInfo);
        if (archiveSigners.isEmpty()) {
            return false;
        }
        Set<String> installedSigners = getSignerDigests(installedInfo);
        return !installedSigners.isEmpty() && archiveSigners.equals(installedSigners);
    }

    private static Set<String> getSignerDigests(PackageInfo info) {
        Set<String> digests = new TreeSet<>();
        try {
            Signature[] signers = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
                signers = info.signingInfo.getApkContentsSigners();
            } else if (info.signatures != null) {
                signers = info.signatures;
            }
            if (signers == null) {
                return digests;
            }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (Signature signature : signers) {
                if (signature == null) {
                    continue;
                }
                byte[] hash = digest.digest(signature.toByteArray());
                StringBuilder sb = new StringBuilder(hash.length * 2);
                for (byte b : hash) {
                    sb.append(String.format("%02x", b));
                }
                digests.add(sb.toString());
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to hash signer", e);
        }
        return digests;
    }

    private static boolean isAsgClientApk(PackageManager pm, String apkPath) {
        PackageInfo archiveInfo =
                pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNING_CERTIFICATES);
        return archiveInfo != null && OtaConstants.ASG_PACKAGE.equals(archiveInfo.packageName);
    }

    private static void notifyRecoveryInstallInProgress(Context context, String apkPath) {
        PackageManager pm = context.getPackageManager();
        if (!isAsgClientApk(pm, apkPath)) {
            return;
        }
        Intent intent = new Intent(OtaConstants.RECOVERY_INSTALL_IN_PROGRESS);
        intent.setPackage(OtaConstants.RECOVERY_PACKAGE);
        context.sendBroadcast(intent, OtaConstants.RECOVERY_CONTROL_PERMISSION);
        Log.d(TAG, "Notified recovery worker: install in progress");
    }

    public static void notifyRecoveryInstallCompleted(Context context) {
        Intent intent = new Intent(OtaConstants.RECOVERY_INSTALL_COMPLETED);
        intent.setPackage(OtaConstants.RECOVERY_PACKAGE);
        context.sendBroadcast(intent, OtaConstants.RECOVERY_CONTROL_PERMISSION);
        Log.d(TAG, "Notified recovery worker: install completed");
    }

    private static boolean isTestOnlyApk(PackageManager pm, String apkPath) {
        PackageInfo archiveInfo =
                pm.getPackageArchiveInfo(apkPath, PackageManager.GET_SIGNING_CERTIFICATES);
        if (archiveInfo == null || archiveInfo.applicationInfo == null) {
            return true;
        }
        ApplicationInfo appInfo = archiveInfo.applicationInfo;
        appInfo.sourceDir = apkPath;
        appInfo.publicSourceDir = apkPath;
        return (appInfo.flags & ApplicationInfo.FLAG_TEST_ONLY) != 0;
    }

    private static void copyFile(File source, File destination) throws IOException {
        try (FileInputStream fis = new FileInputStream(source);
                FileOutputStream fos = new FileOutputStream(destination)) {
            byte[] buffer = new byte[8192];
            int bytesRead;
            while ((bytesRead = fis.read(buffer)) != -1) {
                fos.write(buffer, 0, bytesRead);
            }
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
            lastApkFailureErrorCode = FirmwareDownloadException.CODE_APK_VERIFY_FAILED;
            EventBus.getDefault().post(new DownloadProgressEvent(
                DownloadProgressEvent.DownloadStatus.FAILED, lastApkFailureErrorCode));
            return false;
        } catch (Exception e) {
            Log.e(TAG, "APK download failed", e);
            File partialFile = new File(OtaConstants.BASE_DIR, filename);
            if (partialFile.exists()) {
                partialFile.delete();
                Log.d(TAG, "Cleaned up partial download file");
            }
            String errorCode = classifyDownloadError(e);
            lastApkFailureErrorCode = errorCode;
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
        Log.i(TAG, "📥 Sending download STARTED to phone");
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

        if (!verifyApkFile(apkFile.getAbsolutePath(), json)) {
            Log.e(TAG, "APK SHA256 verification failed");
            return false;
        }
        EventBus.getDefault().post(DownloadProgressEvent.createFinished(fileSize));
        sendProgressToPhone("download", 100, fileSize, fileSize, "FINISHED", null);
        createMetaDataJson(json, context);
        return true;
    }

    private boolean verifyApkFile(String apkPath, JSONObject jsonObject) {
        try {
            String expectedHash = jsonObject.optString("sha256", "");
            if (expectedHash.isEmpty()) {
                Log.e(TAG, "No SHA256 hash provided for APK - rejecting update");
                return false;
            }

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            try (FileInputStream is = new FileInputStream(apkPath)) {
                while ((read = is.read(buffer)) > 0) {
                    digest.update(buffer, 0, read);
                }
            }

            byte[] hashBytes = digest.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) {
                sb.append(String.format("%02x", b));
            }
            String calculatedHash = sb.toString();

            Log.d(TAG, "Expected APK SHA256: " + expectedHash);
            Log.d(TAG, "Calculated APK SHA256: " + calculatedHash);

            boolean match = calculatedHash.equalsIgnoreCase(expectedHash);
            Log.d(TAG, "APK SHA256 check " + (match ? "passed" : "failed"));
            return match;
        } catch (Exception e) {
            Log.e(TAG, "APK SHA256 check error", e);
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
                notifyRecoveryInstallCompleted(context);
                sendUpdateCompletedBroadcast(context);
                return false;
            }

            if (!apkFile.canRead()) {
                Log.e(TAG, "Installation failed: Cannot read APK file at " + apkPath);
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Cannot read APK file"));
                notifyRecoveryInstallCompleted(context);
                sendUpdateCompletedBroadcast(context);
                return false;
            }

            notifyRecoveryInstallInProgress(context, apkPath);
            Log.d(TAG, "Sending install broadcast to system UI...");
            context.sendBroadcast(intent);
            Log.i(TAG, "Install broadcast sent successfully. System will handle installation.");
            return true;
        } catch (SecurityException e) {
            Log.e(TAG, "Security exception while sending install broadcast", e);
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Security exception: " + e.getMessage()));
            notifyRecoveryInstallCompleted(context);
            sendUpdateCompletedBroadcast(context);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Failed to send install broadcast", e);
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Installation failed: " + e.getMessage()));
            notifyRecoveryInstallCompleted(context);
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
            return installApk(context, backupPath);
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
     * @param currentVersion Current MTK firmware version as reported by
     *     {@code ro.custom.ota.version}, e.g. "MentraLive_20260626"; both sides are
     *     normalized before comparison, so a bare "20260626" would also match
     * @return Matching patch object, or null if no match or version unknown
     */
    private JSONObject findMatchingMtkPatch(JSONArray patches, String currentVersion) {
        if (currentVersion == null || currentVersion.isEmpty()) {
            Log.w(TAG, "Cannot match MTK patch - current version unknown");
            return null;
        }
        String normalizedCurrentVersion = normalizeMtkFirmwareVersion(currentVersion);

        try {
            for (int i = 0; i < patches.length(); i++) {
                JSONObject patch = patches.getJSONObject(i);
                String startFirmware = patch.getString("start_firmware");
                if (normalizeMtkFirmwareVersion(startFirmware).equals(normalizedCurrentVersion)) {
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
     * Reduce an MTK version string to its bare date so manifest entries and the device
     * property match regardless of any "MentraLive_"-style prefix. Both normally carry the
     * prefix; this is defensive so a bare-date value on either side still matches.
     */
    private String normalizeMtkFirmwareVersion(String version) {
        if (version == null) {
            return "";
        }
        String trimmed = version.trim();
        int separator = trimmed.lastIndexOf('_');
        if (separator >= 0 && separator + 1 < trimmed.length()) {
            return trimmed.substring(separator + 1);
        }
        return trimmed;
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
     * Supports dotted formats like "17.26.1.14" (BES) or bare dates like "20241130".
     * MTK patch matching does not use this - it uses normalized exact equality in
     * {@link #findMatchingMtkPatch}.
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
            if (isBesOtaInProgress()) {
                Log.w(TAG, "BES firmware update already in progress");
                return false;
            }

            // Check if MTK OTA in progress
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update in progress - skipping BES firmware update");
                return false;
            }

            String manifestVersion = firmwareInfo.optString("version", "");
            if (!manifestVersion.isEmpty()) {
                String currentBesVersion = "";
                try {
                    AsgSettings asgSettings = new AsgSettings(context);
                    currentBesVersion = asgSettings.getBesFirmwareVersion();
                } catch (Exception e) {
                    Log.e(TAG, "Error getting BES firmware version from AsgSettings", e);
                }
                if (!checkBesUpdate(firmwareInfo, currentBesVersion)) {
                    Log.i(TAG, "BES firmware is not newer - skipping update");
                    return false;
                }
            } else {
                // Legacy BES schema: versionCode/versionName, compared via IBesOtaController.
                long serverVersion = firmwareInfo.optLong("versionCode", 0);
                String versionName = firmwareInfo.optString("versionName", "unknown");

                Log.i(TAG, "BES firmware available - Version: " + versionName + " (code: " + serverVersion + ")");

                IBesOtaController legacyController = getOtaController();
                if (legacyController == null) {
                    Log.w(TAG, "BES OTA controller not available - skipping BES firmware update");
                    return false;
                }

                byte[] currentVersion = legacyController.getCurrentFirmwareVersion();
                byte[] serverVersionBytes = legacyController.parseServerVersionCode(serverVersion);

                if (currentVersion != null && serverVersionBytes != null) {
                    boolean isNewer = legacyController.isNewerVersion(serverVersionBytes, currentVersion);
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
            }

            // Set current update type for progress reporting
            currentUpdateType = "bes";

            // Download firmware file (support both "url" and legacy "firmwareUrl")
            String firmwareUrl = firmwareInfo.optString("url", firmwareInfo.optString("firmwareUrl", ""));
            if (firmwareUrl.isEmpty()) {
                Log.e(TAG, "BES firmware URL missing in JSON (expected 'url' or 'firmwareUrl')");
                // This is a deterministic manifest-admission failure: no BES command has been
                // queued, so it must not enter the install/reboot-required recovery branch.
                if (isPhoneInitiatedOta) {
                    sendProgressToPhone(
                            "download", 0, 0, 0, "FAILED", "firmware_verify_failed");
                }
                return false;
            }

            boolean downloaded = downloadBesFirmware(firmwareUrl, firmwareInfo, context);
            if (!downloaded) {
                Log.e(TAG, "Failed to download BES firmware");
                return false;
            }

            if (!isPhoneInitiatedOta) {
                Log.w(TAG, "BES firmware install blocked - requires explicit ota_start from phone");
                return false;
            }

            Log.i(TAG, "BES firmware ready - starting install phase");
            IBesOtaController manager = besOtaRegistry.getInstance();
            if (manager != null) {
                File firmwareFile = new File(OtaConstants.BES_FIRMWARE_PATH);
                ValidatedBesArtifact artifact =
                        BesFirmwareArtifactValidator.validate(firmwareFile, firmwareInfo);
                JSONObject sessionState = sessionManager != null ? sessionManager.getSessionState() : null;
                String ownerSessionId =
                        sessionState != null ? sessionState.optString("sid", "").trim() : "";
                if (ownerSessionId.isEmpty()) {
                    Log.e(TAG, "BES OTA has no owning top-level session");
                    sendProgressToPhone("install", 0, 0, 0, "FAILED", "install_failed");
                    return false;
                }
                Log.i(TAG, "Starting validated BES firmware update artifact="
                        + artifact.getArtifactId() + " target=" + artifact.getTargetVersion());
                boolean started =
                        startBesFirmwareInstall(manager, artifact, ownerSessionId);
                if (started) {
                    Log.i(TAG, "BES firmware update initiated successfully");
                    return true;
                } else {
                    Log.e(TAG, "Failed to start BES firmware update");
                    sendProgressToPhone("install", 0, 0, 0, "FAILED", "install_failed");
                    if (firmwareFile.exists() && !firmwareFile.delete()) {
                        Log.w(TAG, "Failed deleting BES firmware after install start failure");
                    }
                }
            } else {
                Log.e(TAG, "BesOtaManager not available");
                sendProgressToPhone("install", 0, 0, 0, "FAILED", "install_failed");
                File firmwareFile = new File(OtaConstants.BES_FIRMWARE_PATH);
                if (firmwareFile.exists() && !firmwareFile.delete()) {
                    Log.w(TAG, "Failed deleting BES firmware when manager unavailable");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to update BES firmware", e);
            if (isPhoneInitiatedOta) {
                sendProgressToPhone("install", 0, 0, 0, "FAILED", "install_failed");
            }
            File firmwareFile = new File(OtaConstants.BES_FIRMWARE_PATH);
            if (firmwareFile.exists() && !firmwareFile.delete()) {
                Log.w(TAG, "Failed deleting BES firmware after exception");
            }
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
            String errorCode = classifyDownloadError(e);
            sendProgressToPhone("download", 0, 0, 0, "FAILED", errorCode);
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

        if (firmwareFile.exists() && !firmwareFile.delete()) {
            throw new IOException("Failed deleting stale BES firmware before fresh download");
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

    /** Build the phone guard and let the BES controller order it immediately before mh_ota. */
    boolean startBesFirmwareInstall(
            IBesOtaController manager,
            ValidatedBesArtifact artifact,
            String ownerSessionId) {
        currentUpdateType = "bes";
        JSONObject installGuard = buildBesInstallStartStatus();
        if (installGuard == null) {
            Log.e(TAG, "BES install blocked - could not build phone guard status");
            return false;
        }
        return manager.startFirmwareUpdateWithInstallGuard(
                artifact, ownerSessionId, installGuard);
    }

    private JSONObject buildBesInstallStartStatus() {
        updateSessionFromProgress("install", 0, "STARTED", null);
        lastProgressSentTime = System.currentTimeMillis();
        lastProgressSentPercent = 0;
        lastOtaPhoneStage = "install";
        lastOtaPhoneProgress = 0;
        lastOtaPhoneEventStatus = "STARTED";
        lastOtaPhoneError = null;
        return buildOtaStatusForPhone();
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
        // Default: treat as the final firmware step (MTK-only) so it self-reboots. Callers that
        // know a BES update follows pass besUpdateFollows=true to suppress the reboot.
        return checkAndUpdateMtkFirmware(firmwareInfo, context, false);
    }

    private boolean checkAndUpdateMtkFirmware(JSONObject firmwareInfo, Context context, boolean besUpdateFollows) {
        try {
            // Check for mutual exclusion - don't start MTK update if other updates in progress
            if (isUpdating) {
                Log.w(TAG, "APK update in progress - skipping MTK firmware update");
                return false;
            }

            if (isBesOtaInProgress()) {
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
            if (!downloaded) {
                Log.e(TAG, "Failed to download MTK firmware");
                return false;
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
                SystemControllerFactory.get(ctx).installSystemOta(OtaConstants.MTK_FIRMWARE_PATH);
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
            File firmwareFile = new File(OtaConstants.MTK_FIRMWARE_PATH);
            if (firmwareFile.exists() && !firmwareFile.delete()) {
                Log.w(TAG, "Failed deleting MTK firmware after exception");
            }
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
            String errorCode = classifyDownloadError(e);
            sendProgressToPhone("download", 0, 0, 0, "FAILED", errorCode);
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

        if (firmwareFile.exists() && !firmwareFile.delete()) {
            throw new IOException("Failed deleting stale MTK firmware before fresh download");
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
     * Attach a session manager and push its current state to the phone, resending on a
     * fixed schedule instead of firing once.
     *
     * Used by {@link OtaService#resumeFromSession(OtaSessionManager)} after an APK-only
     * OTA completes across a process restart. The original {@code installApk()} call
     * deliberately skips the FINISHED send because the process is about to die, so the
     * phone needs an explicit completion signal once the new process comes up.
     *
     * This runs during early startup of the freshly installed process, usually before the
     * UART transport is open ({@link #sendOtaStatus()} silently no-ops while the phone is
     * unreachable) — and a single send at the serial-ready instant can still be dropped
     * downstream while the wire protocol settles. A one-shot push losing that race leaves
     * the phone staring at a stale "install in_progress 0%" until its stall watchdog fails
     * a successful update (incident rep_01KY31HEMTSBSMK8DVMNXJ5XGG). Resending is safe:
     * each attempt re-reads the persisted session state, duplicate terminal statuses are
     * idempotent on the phone, and any phone-initiated ota_start/ota_query_status
     * supersedes these pushes.
     */
    public void sendCompletionToPhone(OtaSessionManager sm) {
        if (sm == null) return;
        this.sessionManager = sm;
        for (int attempt = 1; attempt <= AsgConstants.OTA_COMPLETION_RESEND_ATTEMPTS; attempt++) {
            final int attemptNumber = attempt;
            handler.postDelayed(
                    () -> {
                        Log.i(
                                TAG,
                                "APK completion push attempt "
                                        + attemptNumber
                                        + "/"
                                        + AsgConstants.OTA_COMPLETION_RESEND_ATTEMPTS
                                        + " (phoneConnected="
                                        + isPhoneConnected()
                                        + ")");
                        sendOtaStatus();
                    },
                    (attempt - 1) * AsgConstants.OTA_COMPLETION_RESEND_INTERVAL_MS);
        }
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

        // Advance the durable session before dispatch so the admitted worker sees the next step.
        sessionManager.advanceStep(nextStep, "download");

        // Kick off the next step's download/install cycle. Sessions always carry the
        // phone-supplied manifest URL; a session without one is unrecoverable by design
        // (the glasses have no fallback manifest and never originate an OTA decision).
        if (versionJsonUrl == null || versionJsonUrl.isEmpty()) {
            Log.e(TAG, "Session has no manifest URL - failing instead of guessing a manifest");
            sessionManager.setFailed("Session missing manifest URL");
            sendOtaStatus();
            return false;
        }
        if (!startVersionCheckWithUrl(context, versionJsonUrl)) {
            Log.e(TAG, "Next OTA step lost admission before worker dispatch");
            sessionManager.setFailed("OTA admission busy before next step");
            sendOtaStatus();
            // The active session handled the failure; suppress the caller's legacy completion path.
            return true;
        }
        sendOtaStatus();
        return true;
    }

    private JSONObject buildOtaStatusForPhone() {
        JSONObject sessionState = getAuthoritativeBesStatus();
        if (sessionState == null && sessionManager != null) {
            sessionState = sessionManager.getSessionState();
        }
        if (sessionState == null) {
            sessionState = buildMinimalOtaStatusJson();
            if (sessionState == null) {
                Log.w(TAG, "No OTA session and cannot build minimal ota_status — phone will not see progress");
                return null;
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
            return sessionState;
        } catch (JSONException e) {
            Log.e(TAG, "Failed to send OTA status", e);
            return null;
        }
    }

    private void sendOtaStatus() {
        if (phoneConnectionProvider == null || !isPhoneConnected()) return;
        JSONObject sessionState = buildOtaStatusForPhone();
        if (sessionState != null) {
            phoneConnectionProvider.sendOtaStatus(sessionState);
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
     * Start an explicit ADB-requested BES version change through the release-A safety boundary.
     *
     * <p>Unlike the retired raw-file entry point, this validates the release container and
     * immutable identity, observes APK/MTK/BES mutual exclusion, and assigns a durable owner before
     * the manager can reserve {@code mh_ota}. Direction is intentionally not compared: selecting an
     * older target is the supported internal downgrade use case for this privileged debug path.
     *
     * @param firmwareFile locally staged release-packaged BES OTA container
     * @param targetVersion exact four-component version expected after the BES reboot
     * @param expectedSha256 SHA-256 of the staged container
     * @param artifactId stable artifact identifier stored with the durable transaction
     * @return true when the validated transaction was accepted by the BES OTA manager
     */
    public boolean startValidatedDebugBesFirmware(
            File firmwareFile,
            String targetVersion,
            String expectedSha256,
            String artifactId) {
        if (!otaAdmissionPermit.tryAcquire()) {
            Log.e(TAG, "DEBUG BES install blocked - phone OTA admission is active");
            return false;
        }

        boolean deleteRefusedArtifact = false;
        boolean started = false;
        try {
            IBesOtaController manager = getOtaController();
            if (manager == null) {
                Log.e(TAG, "DEBUG BES install blocked - BES OTA controller is unavailable");
                return false;
            }
            if (manager.isBesOtaInProgress()) {
                Log.e(TAG, "DEBUG BES install blocked - BES transaction already active");
                return false;
            }

            // Shared admission plus an inactive manager proves that this request's path is not
            // owned by a live BES transaction. Every refusal below may safely delete it.
            deleteRefusedArtifact = true;
            if (isUpdating) {
                Log.e(TAG, "DEBUG BES install blocked - APK update in progress");
                return false;
            }
            if (isMtkOtaInProgress) {
                Log.e(TAG, "DEBUG BES install blocked - MTK update in progress");
                return false;
            }
            if (!isBatterySufficientForUpdates()) {
                Log.e(TAG, "DEBUG BES install blocked - battery is insufficient");
                return false;
            }

            ValidatedBesArtifact artifact =
                    BesFirmwareArtifactValidator.validateLocal(
                            firmwareFile, artifactId, expectedSha256, targetVersion);
            if (!manager.prepareForNewOtaSession()) {
                Log.e(TAG, "DEBUG BES install blocked - durable state refused a new session");
                return false;
            }

            String ownerSessionId =
                    "adb-bes-" + java.util.UUID.randomUUID().toString().replace("-", "");
            Log.w(
                    TAG,
                    "DEBUG: starting validated BES version change artifact="
                            + artifact.getArtifactId()
                            + " target="
                            + artifact.getTargetVersion()
                            + " owner="
                            + ownerSessionId);
            started = manager.startFirmwareUpdate(artifact, ownerSessionId);
            if (!started) {
                Log.e(TAG, "DEBUG BES install was refused by the BES OTA manager");
            } else {
                deleteRefusedArtifact = false;
                // The manager now owns this validated artifact. No sibling debug artifact belongs
                // to the admitted transaction, so interrupted-run leftovers can be removed without
                // endangering the active source.
                pruneAbandonedDebugBesArtifacts(firmwareFile);
            }
            return started;
        } catch (BesFirmwareArtifactValidator.ValidationException e) {
            Log.e(TAG, "DEBUG BES artifact validation failed: " + e.getMessage(), e);
            return false;
        } finally {
            if (deleteRefusedArtifact && !started) {
                deleteRefusedDebugBesArtifact(firmwareFile);
            }
            otaAdmissionPermit.release();
        }
    }

    private void deleteRefusedDebugBesArtifact(File artifact) {
        if (artifact != null && artifact.exists() && !artifact.delete()) {
            Log.w(TAG, "Could not delete refused debug BES artifact " + artifact);
        }
    }

    private void pruneAbandonedDebugBesArtifacts(File currentArtifact) {
        if (currentArtifact == null) {
            return;
        }
        File parent = currentArtifact.getParentFile();
        if (parent == null || !parent.isDirectory()) {
            return;
        }
        String debugPrefix = new File(AsgConstants.DEBUG_BES_OTA_ARTIFACT_PREFIX).getName();
        String currentPath = currentArtifact.getAbsolutePath();
        File[] abandonedArtifacts =
                parent.listFiles(
                        (directory, name) ->
                                name.startsWith(debugPrefix) && name.endsWith(".bin"));
        if (abandonedArtifacts == null) {
            return;
        }
        for (File abandonedArtifact : abandonedArtifacts) {
            if (abandonedArtifact.getAbsolutePath().equals(currentPath)) {
                continue;
            }
            if (!abandonedArtifact.delete()) {
                Log.w(TAG, "Could not delete abandoned debug BES artifact " + abandonedArtifact);
            }
        }
    }

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
            EventBus.getDefault().post(MtkOtaProgressEvent.createStarted());

            // Trigger MTK OTA installation via system broadcast
            SystemControllerFactory.get(context).installSystemOta(OtaConstants.MTK_FIRMWARE_PATH);

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
        // The release-A safety contract requires manifest validation, durable ownership, and
        // pre-authorization state persistence. A raw-file debug entry point bypasses all three.
        Log.e(TAG, "DEBUG BES install is disabled; use the phone-started validated OTA flow");
        return false;
    }
}
