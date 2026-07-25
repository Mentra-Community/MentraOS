package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.FactoryResetEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Reacts to {@link FactoryResetEvent}s (BES requesting a factory reset via {@code cs_fcrst}, fired
 * when the user presses PWR 5x rapidly). Resets the glasses by reinstalling the ASG client APK.
 *
 * <p>Reset order: (1) copy and reinstall the currently-installed APK from {@code sourceDir};
 * (2) install a staged update or backup APK from disk; (3) download from the OTA manifest's
 * {@code recoveryApkUrl} field (falls back to {@code apkUrl}) and install directly — no version
 * gate, no firmware steps. The install in all paths uses the OEM SystemUI broadcast
 * ({@code com.xy.xsetting.action cmd=install}).
 *
 * <p>The {@link OtaHelper} instance is injected (the same Hilt-provided singleton wired in {@code
 * ServiceInitializer}); the static {@link OtaHelper#getInstance()} is intentionally not used because
 * production never calls {@link OtaHelper#initialize(Context)}, so it would be {@code null}.
 *
 * <p>This intentionally does not wipe app data/settings: BES firmware {@code
 * lxy_glass_cmd_factoryreset()} does not wait for an acknowledgment and no {@code sr_fcrst} reply
 * is defined, so none is sent.
 */
public final class FactoryResetEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "FactoryResetEventSubscriber";

    /**
     * Delay between stopping an active recording and kicking off the install. Mirrors {@link
     * ShutdownEventSubscriber}: gives {@code MediaRecorder.stop()} time to finalize the MP4 moov
     * atom before the install broadcast kills this process.
     */
    private static final long INSTALL_DELAY_MS = 500L;

    /** Seam for checking whether a path holds an installable ASG APK, kept mockable for tests. */
    interface LocalApkChecker {
        boolean isInstallableApk(Context context, String path);
    }

    /**
     * Seam for the recovery-APK download fallback, kept mockable for tests. The default
     * implementation calls {@link #downloadRecoveryApkOnThread(Context)}.
     */
    interface RecoveryDownloader {
        void download(Context ctx, OtaHelper otaHelper);
    }

    private final AsgClientServiceManager serviceManager;
    private final Context context;
    private final OtaHelper otaHelper;
    private final Handler mainHandler;
    private final LocalApkChecker apkChecker;
    private final RecoveryDownloader recoveryDownloader;

    /** Guards against a repeated/replayed cs_fcrst firing multiple install broadcasts. */
    private final AtomicBoolean resetInProgress = new AtomicBoolean(false);

    public FactoryResetEventSubscriber(
            AsgClientServiceManager serviceManager, Context context, OtaHelper otaHelper) {
        this.serviceManager = serviceManager;
        this.context = context;
        this.otaHelper = otaHelper;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.apkChecker = defaultApkChecker();
        this.recoveryDownloader =
                (ctx, helper) ->
                        new Thread(
                                        () -> this.downloadRecoveryApkOnThread(ctx),
                                        "factory-reset-download")
                                .start();
    }

    FactoryResetEventSubscriber(
            AsgClientServiceManager serviceManager,
            Context context,
            OtaHelper otaHelper,
            LocalApkChecker apkChecker,
            RecoveryDownloader recoveryDownloader) {
        this.serviceManager = serviceManager;
        this.context = context;
        this.otaHelper = otaHelper;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.apkChecker = apkChecker;
        this.recoveryDownloader = recoveryDownloader;
    }

    /**
     * Default check: the file exists, is readable, parses as a valid Android package, and declares
     * the ASG client package name. Parsing guards against installing a partial/corrupt staged APK;
     * the package-name check prevents a replacement attack where an attacker swaps a different APK
     * into the world-writable staging directory between validation and the SystemUI install
     * broadcast. The Android package manager enforces signing-certificate continuity on top of this.
     */
    private static LocalApkChecker defaultApkChecker() {
        return (ctx, path) -> {
            File file = new File(path);
            if (!file.exists() || !file.canRead()) {
                return false;
            }
            try {
                PackageInfo info = ctx.getPackageManager().getPackageArchiveInfo(path, 0);
                if (info == null || info.packageName == null) {
                    return false;
                }
                if (!OtaConstants.ASG_PACKAGE.equals(info.packageName)) {
                    Log.w(TAG, "🏭 Staged APK package " + info.packageName
                            + " does not match expected " + OtaConstants.ASG_PACKAGE
                            + " — rejecting");
                    return false;
                }
                return true;
            } catch (Exception e) {
                Log.w(TAG, "🏭 Failed to validate APK at " + path, e);
                return false;
            }
        };
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof FactoryResetEvent)) {
            return;
        }
        handleFactoryReset();
    }

    /**
     * Handle factory reset command from BES (cs_fcrst):
     *
     * <ol>
     *   <li>Stop any active video recording to avoid a corrupt file when the process is killed
     *       during install.
     *   <li>After a short delay (so the recorder can finalize the moov atom), reinstall the APK
     *       that is currently installed on the device (copied out of {@code sourceDir}), so the
     *       reset always runs regardless of whether the installed version is up to date.
     *   <li>If that fails, install a validated local staged/backup APK if one exists on disk.
     *   <li>Otherwise fall back to downloading + installing a fresh APK via the OTA pipeline.
     * </ol>
     */
    private void handleFactoryReset() {
        if (!resetInProgress.compareAndSet(false, true)) {
            Log.w(TAG, "🏭 Factory reset already in progress - ignoring duplicate cs_fcrst");
            return;
        }
        Log.i(TAG, "🏭 Received factory reset command (cs_fcrst) from BES");

        stopActiveRecordingBeforeReset();

        // Delay the install so an in-progress MediaRecorder.stop() can finalize the file before the
        // install broadcast kills this process (same rationale as ShutdownEventSubscriber).
        // Note: performReset() copies the installed APK on the main looper. For typical APK sizes
        // (10-50 MB) the copy completes in well under 1 s on device flash, which is acceptable.
        // A fully off-looper design would require a threading seam for the static-mock tests.
        mainHandler.postDelayed(this::performReset, INSTALL_DELAY_MS);
    }

    /**
     * How long to wait after dispatching a local install broadcast before assuming the OEM installer
     * silently dropped it and clearing the guard so future cs_fcrst events can retry.  The process
     * normally dies within a second of the broadcast; 30 s is a conservative safety margin.
     */
    private static final long INSTALL_WATCHDOG_MS = 30_000L;

    private void performReset() {
        boolean localKicked = installCurrentlyInstalledApk() || installLocalApk();
        if (localKicked) {
            Log.i(TAG, "🏭 Factory reset: local APK install kicked off; scheduling install watchdog");
            // If the process survives INSTALL_WATCHDOG_MS the OEM installer silently rejected
            // or dropped the broadcast.  Clear the guard so a subsequent cs_fcrst can retry.
            mainHandler.postDelayed(() -> {
                if (resetInProgress.compareAndSet(true, false)) {
                    Log.w(TAG, "🏭 Install watchdog: process still alive after install broadcast;"
                            + " guard cleared for retry");
                }
            }, INSTALL_WATCHDOG_MS);
            return;
        }
        // Download path: the background thread handles resetInProgress on failure.
        // The watchdog is not applied here — download duration is variable and the
        // thread already clears the guard on any download or install failure.
        boolean downloadStarted = downloadAndInstallApk();
        if (!downloadStarted) {
            resetInProgress.set(false);
        }
    }

    /**
     * Reinstall the APK that is currently installed on the device. The installed APK ({@code
     * ApplicationInfo.sourceDir} under {@code /data/app/...}) is copied to external storage first,
     * because the OEM SystemUI installer cannot reliably read randomized {@code /data/app} paths.
     * Reinstalling the same version through the SystemUI install broadcast ({@code pm install -r})
     * restarts the app cleanly and always executes, even when the installed version matches the
     * OTA server (where the old download path would no-op with "no updates available").
     *
     * @return {@code true} if the install broadcast was dispatched (process death is now expected).
     */
    private boolean installCurrentlyInstalledApk() {
        Context ctx = resolveContext();
        if (ctx == null) {
            Log.e(TAG, "🏭 Cannot reinstall current APK - context not available");
            return false;
        }

        String sourceDir;
        try {
            sourceDir =
                    ctx.getPackageManager()
                            .getApplicationInfo(ctx.getPackageName(), 0)
                            .sourceDir;
        } catch (Exception e) {
            Log.e(TAG, "🏭 Cannot resolve installed APK path", e);
            return false;
        }

        File staged = new File(OtaConstants.FACTORY_RESET_APK_PATH);
        try {
            File dir = staged.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) {
                Log.e(TAG, "🏭 Cannot create staging dir for factory reset APK: " + dir);
                return false;
            }
            copyFile(new File(sourceDir), staged);
        } catch (Exception e) {
            Log.e(TAG, "🏭 Failed to copy installed APK " + sourceDir + " to " + staged, e);
            staged.delete();
            return false;
        }

        if (!apkChecker.isInstallableApk(ctx, staged.getAbsolutePath())) {
            Log.e(TAG, "🏭 Copied APK failed validation: " + staged);
            staged.delete();
            return false;
        }

        Log.i(TAG, "🏭 Reinstalling currently installed APK (" + sourceDir + ") via " + staged);
        if (OtaHelper.installApk(ctx, staged.getAbsolutePath())) {
            return true;
        }
        Log.w(TAG, "🏭 Reinstall of current APK failed - trying staged/backup APKs");
        return false;
    }

    private static void copyFile(File src, File dst) throws java.io.IOException {
        try (FileInputStream in = new FileInputStream(src);
                FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        }
    }

    /**
     * Attempt a local-first (re)install. Tries the staged update APK first, then the backup APK. If
     * a candidate exists but its install fails, the next candidate is still attempted.
     *
     * @return {@code true} if an install was successfully kicked off (the process is now expected to
     *     be killed by the system); {@code false} if no local install succeeded.
     */
    private boolean installLocalApk() {
        Context ctx = resolveContext();
        if (ctx == null) {
            Log.e(TAG, "🏭 Cannot install local APK - context not available");
            return false;
        }

        if (apkChecker.isInstallableApk(ctx, OtaConstants.ASG_UPDATE_APK_PATH)) {
            Log.i(TAG, "🏭 Installing staged update APK: " + OtaConstants.ASG_UPDATE_APK_PATH);
            if (OtaHelper.installApk(ctx, OtaConstants.ASG_UPDATE_APK_PATH)) {
                return true;
            }
            Log.w(TAG, "🏭 Staged update APK install failed - trying backup APK");
        }

        if (apkChecker.isInstallableApk(ctx, OtaConstants.BACKUP_APK_PATH)) {
            Log.i(TAG, "🏭 Installing backup APK: " + OtaConstants.BACKUP_APK_PATH);
            // Call installApk() directly — reinstallApkFromBackup() does not propagate the
            // broadcast result and always returns true, masking failed installs.
            if (OtaHelper.installApk(ctx, OtaConstants.BACKUP_APK_PATH)) {
                return true;
            }
            Log.w(TAG, "🏭 Backup APK install failed");
        }

        Log.i(TAG, "🏭 No local APK installed - will fall back to download");
        return false;
    }

    /**
     * Download the ASG client APK from the OTA manifest and install it directly — without the full
     * OTA pipeline's version gate, firmware-update steps, or phone-side orchestration.
     *
     * <p>The manifest at {@link OtaConstants#RESCUE_FLEET_MANIFEST_URL} is fetched and the
     * {@code com.mentra.asg_client} entry is read. A dedicated {@code recoveryApkUrl} field is
     * preferred when present (allows the server to publish a pinned recovery build); the normal
     * {@code apkUrl} is used as a fallback. The APK is downloaded to
     * {@link OtaConstants#FACTORY_RESET_APK_PATH} and installed via
     * {@link OtaHelper#installApk(Context, String)} — the same OEM SystemUI broadcast used by
     * every other install path, with no version comparison.
     *
     * <p>Runs entirely on a background thread so the main thread is never blocked.
     *
     * @return {@code true} if the background thread was successfully started; {@code false} if an
     *     immediate precondition failure prevented the thread from starting (caller must clear the
     *     reset guard).
     */
    private boolean downloadAndInstallApk() {
        if (otaHelper == null) {
            Log.e(TAG, "🏭 OtaHelper unavailable - cannot download recovery APK; aborting");
            return false;
        }
        Context ctx = resolveContext();
        if (ctx == null) {
            Log.e(TAG, "🏭 Context unavailable - cannot download recovery APK; aborting");
            return false;
        }
        Log.i(TAG, "🏭 Factory reset: fetching recovery APK from OTA manifest");
        try {
            recoveryDownloader.download(ctx, otaHelper);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "🏭 Failed to start recovery downloader; clearing guard", e);
            return false;
        }
    }

    private void downloadRecoveryApkOnThread(Context ctx) {
        try {
            // 1. Fetch the OTA manifest.
            HttpURLConnection conn =
                    (HttpURLConnection) new URL(OtaConstants.RESCUE_FLEET_MANIFEST_URL).openConnection();
            conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
            conn.connect();
            String manifestJson;
            try (InputStream in = conn.getInputStream()) {
                // readAllBytes() is API 33+; use ByteArrayOutputStream for API 28+ compat.
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                byte[] tmp = new byte[4096];
                int read;
                while ((read = in.read(tmp)) > 0) {
                    baos.write(tmp, 0, read);
                }
                manifestJson = baos.toString("UTF-8");
            }

            // 2. Parse the ASG client entry and find the recovery APK URL.
            JSONObject manifest = new JSONObject(manifestJson);
            JSONObject appEntry =
                    manifest.getJSONObject("apps").getJSONObject(OtaConstants.ASG_PACKAGE);

            // Prefer a dedicated recoveryApkUrl field (server can publish a pinned recovery
            // build independent of the normal OTA channel); fall back to the regular apkUrl.
            String recoveryApkUrl = appEntry.optString("recoveryApkUrl", "");
            boolean usingRecoveryUrl = !recoveryApkUrl.isEmpty();
            String apkUrl = usingRecoveryUrl ? recoveryApkUrl : appEntry.getString("apkUrl");

            // Log only scheme+host+path; query-string tokens must not appear in device logs.
            String urlForLog = apkUrl;
            try {
                java.net.URL parsed = new java.net.URL(apkUrl);
                urlForLog = parsed.getProtocol() + "://" + parsed.getHost() + parsed.getPath();
            } catch (Exception ignored) {}
            Log.i(TAG, "🏭 Recovery APK URL resolved: " + urlForLog
                    + (usingRecoveryUrl ? " (recoveryApkUrl)" : " (apkUrl fallback)"));

            // 3. Download directly to the factory-reset staging path.
            //
            // We do not delegate to OtaHelper.downloadApk() because that method always
            // verifies sha256 against the manifest's single sha256 field.  When recoveryApkUrl
            // points to a different binary than apkUrl the checksums differ and verification
            // would always fail.  Instead we download the bytes ourselves and then validate the
            // resulting APK via apkChecker (package-name check), relying on the Android package
            // manager to enforce signing-certificate continuity on install.
            File stagingDir = new File(OtaConstants.BASE_DIR);
            if (!stagingDir.exists() && !stagingDir.mkdirs()) {
                Log.e(TAG, "🏭 Cannot create staging dir for recovery APK");
                resetInProgress.set(false);
                return;
            }
            File stagingFile = new File(OtaConstants.FACTORY_RESET_APK_PATH);
            HttpURLConnection apkConn =
                    (HttpURLConnection) new URL(apkUrl).openConnection();
            apkConn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
            apkConn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
            apkConn.connect();
            try (InputStream apkIn = apkConn.getInputStream();
                    FileOutputStream apkOut = new FileOutputStream(stagingFile)) {
                byte[] buf = new byte[64 * 1024];
                int read;
                while ((read = apkIn.read(buf)) > 0) {
                    apkOut.write(buf, 0, read);
                }
            }

            // 4. Validate the downloaded APK (package name must match the ASG client).
            if (!apkChecker.isInstallableApk(ctx, stagingFile.getAbsolutePath())) {
                Log.e(TAG, "🏭 Downloaded recovery APK failed package-name validation");
                stagingFile.delete();
                resetInProgress.set(false);
                return;
            }

            // 5. Install directly — no version check, no firmware steps.
            Log.i(TAG, "🏭 Recovery APK downloaded; triggering install");
            if (!OtaHelper.installApk(ctx, OtaConstants.FACTORY_RESET_APK_PATH)) {
                Log.e(TAG, "🏭 Recovery APK install broadcast failed");
                resetInProgress.set(false);
            }
            // On success the process will be killed by the installer; guard stays set.
        } catch (Exception e) {
            Log.e(TAG, "🏭 Recovery APK download/install failed", e);
            resetInProgress.set(false);
        }
    }

    /**
     * Stop any active video recording before reset to prevent file corruption. MPEG4 writes its moov
     * atom during MediaRecorder.stop() — if the process is killed mid-install before that, the
     * recorded file is unplayable.
     */
    private void stopActiveRecordingBeforeReset() {
        try {
            if (serviceManager == null) {
                Log.w(TAG, "⚠️ ServiceManager not available - cannot check for active recordings");
                return;
            }

            MediaCaptureService mediaCaptureService = serviceManager.getMediaCaptureService();
            if (mediaCaptureService != null && mediaCaptureService.isRecordingVideo()) {
                Log.i(
                        TAG,
                        "🎥 Active video recording detected - stopping before factory reset to prevent corruption");
                mediaCaptureService.stopVideoRecording();
                Log.i(TAG, "🎥 Video recording stopped successfully before factory reset");
            }
        } catch (Exception e) {
            Log.e(TAG, "❌ Error stopping recording before factory reset", e);
        }
    }

    private Context resolveContext() {
        if (serviceManager != null && serviceManager.getContext() != null) {
            return serviceManager.getContext();
        }
        return context;
    }
}
