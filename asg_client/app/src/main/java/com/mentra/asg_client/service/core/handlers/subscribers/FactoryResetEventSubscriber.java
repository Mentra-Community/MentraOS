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

/**
 * Reacts to {@link FactoryResetEvent}s (BES requesting a factory reset via {@code cs_fcrst}, fired
 * when the user holds PWR+FN2 for ~10s). Resets the glasses by (re)installing the ASG client APK:
 * a validated local APK is installed first when present, otherwise a fresh APK is downloaded via
 * the existing OTA pipeline. The install itself is performed by {@link OtaHelper}, which broadcasts
 * the OEM SystemUI install intent ({@code com.xy.xsetting.action cmd=install}).
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
     *   <li>After a short delay (so the recorder can finalize the moov atom), install a validated
     *       local APK if one is staged on disk (no network required).
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
     * Download a fresh APK from the OTA manifest and install it. Reuses the phone-initiated OTA flow
     * which downloads, verifies, and installs.
     */
    private void downloadAndInstallApk() {
        if (otaHelper == null) {
            Log.e(TAG, "🏭 OtaHelper unavailable - cannot download reset APK; aborting");
            return;
        }
        Log.i(TAG, "🏭 Factory reset: no local APK, starting OTA download+install");
        otaHelper.startOtaFromPhone();
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
