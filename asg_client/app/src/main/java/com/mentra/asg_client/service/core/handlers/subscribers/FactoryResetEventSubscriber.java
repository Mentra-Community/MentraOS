package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * Reacts to {@link FactoryResetEvent}s (BES requesting a factory reset via {@code cs_fcrst}, fired
 * when the user presses PWR 5x rapidly). Resets the glasses by reinstalling the ASG client APK
 * that is currently installed on the device: the installed APK ({@code sourceDir}) is copied to
 * external storage and reinstalled. Only if that fails does it fall back to a staged/backup local
 * APK, and finally to a fresh OTA download. The install itself is performed by {@link OtaHelper},
 * which broadcasts the OEM SystemUI install intent ({@code com.xy.xsetting.action cmd=install}).
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

    private final AsgClientServiceManager serviceManager;
    private final Context context;
    private final OtaHelper otaHelper;
    private final Handler mainHandler;
    private final LocalApkChecker apkChecker;

    /** Guards against a repeated/replayed cs_fcrst firing multiple install broadcasts. */
    private volatile boolean resetInProgress = false;

    public FactoryResetEventSubscriber(
            AsgClientServiceManager serviceManager, Context context, OtaHelper otaHelper) {
        this(serviceManager, context, otaHelper, defaultApkChecker());
    }

    FactoryResetEventSubscriber(
            AsgClientServiceManager serviceManager,
            Context context,
            OtaHelper otaHelper,
            LocalApkChecker apkChecker) {
        this.serviceManager = serviceManager;
        this.context = context;
        this.otaHelper = otaHelper;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.apkChecker = apkChecker;
    }

    /**
     * Default check: the file exists, is readable, and parses as a valid Android package. Parsing
     * guards against installing a partial/corrupt staged APK and silently skipping the known-good
     * backup/OTA fallbacks.
     */
    private static LocalApkChecker defaultApkChecker() {
        return (ctx, path) -> {
            File file = new File(path);
            if (!file.exists() || !file.canRead()) {
                return false;
            }
            try {
                return ctx.getPackageManager().getPackageArchiveInfo(path, 0) != null;
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
        if (resetInProgress) {
            Log.w(TAG, "🏭 Factory reset already in progress - ignoring duplicate cs_fcrst");
            return;
        }
        resetInProgress = true;
        Log.i(TAG, "🏭 Received factory reset command (cs_fcrst) from BES");

        stopActiveRecordingBeforeReset();

        // Delay the install so an in-progress MediaRecorder.stop() can finalize the file before the
        // install broadcast kills this process (same rationale as ShutdownEventSubscriber).
        mainHandler.postDelayed(this::performReset, INSTALL_DELAY_MS);
    }

    private void performReset() {
        try {
            if (installCurrentlyInstalledApk()) {
                Log.i(TAG, "🏭 Factory reset: reinstall of currently installed APK kicked off");
                return;
            }
            if (installLocalApk()) {
                Log.i(TAG, "🏭 Factory reset: local APK install kicked off");
                return;
            }
            downloadAndInstallApk();
        } finally {
            // A successful local install kills this process shortly; clearing the guard is harmless
            // and lets a later deliberate reset retry if the process is still alive.
            resetInProgress = false;
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

        if (otaHelper != null && apkChecker.isInstallableApk(ctx, OtaConstants.BACKUP_APK_PATH)) {
            Log.i(TAG, "🏭 Installing backup APK: " + OtaConstants.BACKUP_APK_PATH);
            // reinstallApkFromBackup() re-validates the archive before installing.
            if (otaHelper.reinstallApkFromBackup()) {
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
     * <p>The manifest at {@link OtaConstants#VERSION_JSON_URL} is fetched and the
     * {@code com.mentra.asg_client} entry is read. A dedicated {@code recoveryApkUrl} field is
     * preferred when present (allows the server to publish a pinned recovery build); the normal
     * {@code apkUrl} is used as a fallback. The APK is downloaded to
     * {@link OtaConstants#FACTORY_RESET_APK_PATH} and installed via
     * {@link OtaHelper#installApk(Context, String)} — the same OEM SystemUI broadcast used by
     * every other install path, with no version comparison.
     *
     * <p>Runs entirely on a background thread so the main thread is never blocked.
     */
    private void downloadAndInstallApk() {
        if (otaHelper == null) {
            Log.e(TAG, "🏭 OtaHelper unavailable - cannot download recovery APK; aborting");
            return;
        }
        Context ctx = resolveContext();
        if (ctx == null) {
            Log.e(TAG, "🏭 Context unavailable - cannot download recovery APK; aborting");
            return;
        }
        Log.i(TAG, "🏭 Factory reset: fetching recovery APK from OTA manifest");
        new Thread(() -> downloadRecoveryApkOnThread(ctx), "factory-reset-download").start();
    }

    private void downloadRecoveryApkOnThread(Context ctx) {
        try {
            // 1. Fetch the OTA manifest.
            HttpURLConnection conn =
                    (HttpURLConnection) new URL(OtaConstants.VERSION_JSON_URL).openConnection();
            conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
            conn.connect();
            String manifestJson;
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = in.readAllBytes();
                manifestJson = new String(buf, java.nio.charset.StandardCharsets.UTF_8);
            }

            // 2. Parse the ASG client entry and find the recovery APK URL.
            JSONObject manifest = new JSONObject(manifestJson);
            JSONObject appEntry =
                    manifest.getJSONObject("apps").getJSONObject(OtaConstants.ASG_PACKAGE);

            // Prefer a dedicated recoveryApkUrl field; fall back to the regular apkUrl.
            // The server can publish a pinned recovery build under recoveryApkUrl without
            // affecting the normal over-the-air update channel.
            String apkUrl = appEntry.optString("recoveryApkUrl", "");
            if (apkUrl.isEmpty()) {
                apkUrl = appEntry.getString("apkUrl");
            }
            Log.i(TAG, "🏭 Recovery APK URL resolved: " + apkUrl);

            // 3. Download to the factory-reset staging path (separate from the OTA update path).
            boolean downloaded =
                    otaHelper.downloadApk(
                            apkUrl, appEntry, ctx, OtaConstants.FACTORY_RESET_APK_FILENAME);
            if (!downloaded) {
                Log.e(TAG, "🏭 Recovery APK download failed - factory reset aborted");
                resetInProgress = false;
                return;
            }

            // 4. Install directly — no version check, no firmware steps.
            Log.i(TAG, "🏭 Recovery APK downloaded; triggering install");
            if (!OtaHelper.installApk(ctx, OtaConstants.FACTORY_RESET_APK_PATH)) {
                Log.e(TAG, "🏭 Recovery APK install broadcast failed");
                resetInProgress = false;
            }
            // On success the process will be killed by the installer; guard stays set.
        } catch (Exception e) {
            Log.e(TAG, "🏭 Recovery APK download/install failed", e);
            resetInProgress = false;
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
