package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
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
 * a local APK is installed first when present, otherwise a fresh APK is downloaded via the existing
 * OTA pipeline. The install itself is performed by {@link OtaHelper}, which broadcasts the OEM
 * SystemUI install intent ({@code com.xy.xsetting.action cmd=install}).
 *
 * <p>This intentionally does not wipe app data/settings: BES firmware {@code
 * lxy_glass_cmd_factoryreset()} does not wait for an acknowledgment and no {@code sr_fcrst} reply
 * is defined, so none is sent.
 */
public final class FactoryResetEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "FactoryResetEventSubscriber";

    private final AsgClientServiceManager serviceManager;
    private final Context context;

    public FactoryResetEventSubscriber(AsgClientServiceManager serviceManager, Context context) {
        this.serviceManager = serviceManager;
        this.context = context;
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
     *   <li>Install a local APK if one is staged on disk (no network required).
     *   <li>Otherwise fall back to downloading + installing a fresh APK via the OTA pipeline.
     * </ol>
     */
    private void handleFactoryReset() {
        Log.i(TAG, "🏭 Received factory reset command (cs_fcrst) from BES");

        stopActiveRecordingBeforeReset();

        if (installLocalApk()) {
            Log.i(TAG, "🏭 Factory reset: local APK install kicked off");
            return;
        }

        downloadAndInstallApk();
    }

    /**
     * Attempt a local-first (re)install. Tries the staged update APK first, then the backup APK.
     *
     * @return {@code true} if an install was successfully kicked off (the process is now expected to
     *     be killed by the system); {@code false} if no usable local APK was found.
     */
    private boolean installLocalApk() {
        Context ctx = resolveContext();
        if (ctx == null) {
            Log.e(TAG, "🏭 Cannot install local APK - context not available");
            return false;
        }

        File updateApk = new File(OtaConstants.ASG_UPDATE_APK_PATH);
        if (updateApk.exists() && updateApk.canRead()) {
            Log.i(TAG, "🏭 Installing staged update APK: " + OtaConstants.ASG_UPDATE_APK_PATH);
            return OtaHelper.installApk(ctx, OtaConstants.ASG_UPDATE_APK_PATH);
        }

        OtaHelper otaHelper = OtaHelper.getInstance();
        if (otaHelper != null) {
            File backupApk = new File(OtaConstants.BACKUP_APK_PATH);
            if (backupApk.exists() && backupApk.canRead()) {
                Log.i(TAG, "🏭 Installing backup APK: " + OtaConstants.BACKUP_APK_PATH);
                return otaHelper.reinstallApkFromBackup();
            }
        }

        Log.i(TAG, "🏭 No local APK available - will fall back to download");
        return false;
    }

    /**
     * Download a fresh APK from the OTA manifest and install it. Reuses the phone-initiated OTA flow
     * which downloads, verifies, and installs.
     */
    private void downloadAndInstallApk() {
        OtaHelper otaHelper = OtaHelper.getInstance();
        if (otaHelper == null) {
            Log.e(TAG, "🏭 OtaHelper not initialized - cannot download reset APK; aborting");
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
