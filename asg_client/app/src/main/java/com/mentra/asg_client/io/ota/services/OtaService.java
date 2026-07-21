package com.mentra.asg_client.io.ota.services;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.ota.events.DownloadProgressEvent;
import com.mentra.asg_client.io.ota.events.InstallationProgressEvent;
import com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.version.AsgVersion;
import dagger.hilt.android.AndroidEntryPoint;
import javax.inject.Inject;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

@AndroidEntryPoint
public class OtaService extends Service {
    private static final String TAG = OtaConstants.TAG;
    private static final String CHANNEL_ID = "ota_service_channel";
    private static final int NOTIFICATION_ID = 2001;

    // Delay before rebooting to apply a staged MTK-only update. Gives the BLE
    // ota_status "complete" message time to reach the phone before we drop the
    // connection, so the phone settles on its "complete" UI rather than a bare
    // "disconnected" spinner during the reboot.
    private static final long MTK_REBOOT_DELAY_MS = 3000;

    @Inject OtaHelper otaHelper;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "OtaService onCreate");

        // Create notification channel
        createNotificationChannel();

        // Start as foreground service
        startForeground(NOTIFICATION_ID, createNotification("OTA Service Running"));

        stopLegacyOtaUpdaterIfPresent();

        // Check if ASG client was just updated - if so, auto-resume OTA for MTK/BES
        checkAndResumeAfterApkUpdate();

        // Register EventBus
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
        }

        Log.i(TAG, "OTA service initialized - waiting for phone-initiated ota_start");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "OtaService onStartCommand");
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "OtaService onDestroy");

        // Unregister EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }

        // OtaHelper is an app-scoped Hilt singleton shared by command handlers and debug
        // receivers. Do not call cleanup() here; it tears down state that later OTA flows reuse.
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel =
                    new NotificationChannel(
                            CHANNEL_ID, "OTA Update Service", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("OTA update service notifications");

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification createNotification(String contentText) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("ASG Client OTA")
                .setContentText(contentText)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String contentText) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, createNotification(contentText));
        }
    }

    private void stopLegacyOtaUpdaterIfPresent() {
        try {
            Log.i(TAG, "Stopping legacy OTA updater to prevent conflicts with internal OTA");
            SystemControllerFactory.get(this).stopApp("com.augmentos.otaupdater");
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop legacy OTA updater", e);
        }
    }

    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onDownloadProgress(DownloadProgressEvent event) {
        Log.d(TAG, "Download progress: " + event.toString());

        switch (event.getStatus()) {
            case STARTED:
                updateNotification("Downloading update...");
                break;
            case PROGRESS:
                updateNotification("Downloading: " + event.getProgress() + "%");
                break;
            case FINISHED:
                updateNotification("Download complete");
                break;
            case FAILED:
                updateNotification("Download failed: " + event.getErrorMessage());
                break;
        }
    }

    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onInstallationProgress(InstallationProgressEvent event) {
        Log.d(TAG, "Installation progress: " + event.toString());

        switch (event.getStatus()) {
            case STARTED:
                updateNotification("Installing update...");
                break;
            case FINISHED:
                updateNotification("Installation complete");
                break;
            case FAILED:
                updateNotification("Installation failed: " + event.getErrorMessage());
                break;
        }
    }

    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onBatteryStatus(BatteryStatusEvent event) {
        // OtaHelper is already subscribed to EventBus and will receive this event directly
        // No need to re-post the event - this was causing an infinite loop
        Log.d(
                TAG,
                "Received battery status: "
                        + event.getBatteryLevel()
                        + "%, charging: "
                        + event.isCharging());
    }

    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onMtkOtaProgress(MtkOtaProgressEvent event) {
        Log.d(TAG, "MTK OTA progress: " + event.toString());

        // Parse progress percentage from message if available
        int progress = 0;
        try {
            if (event.getMessage() != null && !event.getMessage().isEmpty()) {
                progress = Integer.parseInt(event.getMessage());
            }
        } catch (NumberFormatException e) {
            // Message is not a number (e.g., "info" messages), ignore
        }

        // Send MTK install progress to phone so user sees real progress during the long install
        switch (event.getStatus()) {
            case STARTED:
                updateNotification("MTK firmware update started");
                if (otaHelper != null) {
                    otaHelper.sendMtkInstallProgressToPhone("STARTED", 0, null);
                }
                break;
            case WRITE_PROGRESS:
                updateNotification("Writing MTK firmware: " + progress + "%");
                // Send progress to phone (write phase is typically 0-50%)
                if (otaHelper != null && progress > 0) {
                    otaHelper.sendMtkInstallProgressToPhone("PROGRESS", progress / 2, null);
                }
                break;
            case UPDATE_PROGRESS:
                updateNotification("Installing MTK firmware: " + progress + "%");
                // Send progress to phone (update phase is typically 50-100%)
                if (otaHelper != null && progress > 0) {
                    otaHelper.sendMtkInstallProgressToPhone("PROGRESS", 50 + (progress / 2), null);
                }
                break;
            case SUCCESS:
                updateNotification("MTK firmware updated successfully");
                Log.i(TAG, "📱 MTK system SUCCESS received - staged for next reboot");

                // MTK A/B updates only take effect after a reboot. When a BES update follows, the
                // BES install power-cycles the device and applies the staged MTK image as a side
                // effect, so we must NOT reboot here. For an MTK-only update nothing else triggers
                // that reboot, so we issue it ourselves once the install reports success.
                //
                // The decision is read from a flag OtaHelper set at install kickoff (based on
                // whether a BES update follows), NOT from session state — so it is correct on both
                // the session path and the legacy/no-session path below. consume*() clears the flag
                // so a duplicate/late SUCCESS event can't schedule a second reboot.
                boolean shouldRebootAfterMtk =
                        otaHelper != null && otaHelper.consumeRebootAfterMtkInstall();

                if (otaHelper != null) {
                    otaHelper.sendMtkInstallProgressToPhone("FINISHED", 100, null);
                    boolean advanced;
                    if (shouldRebootAfterMtk) {
                        // Keep MTK as the active step until its staged A/B image is live. The
                        // expected-reboot recovery path will recheck the manifest after boot;
                        // seeing the new MTK version then advances to ASG without racing reboot.
                        OtaSessionManager sessionManager = otaHelper.getSessionManager();
                        advanced =
                                sessionManager != null && sessionManager.hasActiveSession();
                        if (advanced) {
                            Log.i(
                                    TAG,
                                    "MTK session parked until reboot applies firmware; deferring next step");
                        }
                    } else {
                        // BES follows and performs the power-cycle, so advance into BES now.
                        advanced = otaHelper.continueSessionAfterStepComplete(this);
                    }
                    if (!advanced) {
                        // Legacy path (no active session): tell the phone MTK is done so it
                        // can decide whether to start another round.
                        Log.i(
                                TAG,
                                "📱 MTK complete (no session) - notifying phone via legacy broadcast");
                        sendMtkUpdateCompleteMessage();
                    }
                } else {
                    sendMtkUpdateCompleteMessage();
                }

                // MTK-only update: no BES step will reboot for us, so apply the staged
                // firmware ourselves after a short delay (lets the phone receive the
                // "complete" status first). Historically MTK was always bundled with a BES
                // update, whose MCU-level install power-cycled the device automatically.
                if (shouldRebootAfterMtk) {
                    scheduleMtkRebootToApplyUpdate();
                }
                break;
            case ERROR:
                updateNotification("MTK firmware update failed: " + event.getMessage());
                // Send FAILED to phone so user knows something went wrong
                if (otaHelper != null) {
                    otaHelper.sendMtkInstallProgressToPhone("FAILED", 0, event.getMessage());
                    otaHelper.deleteDownloadedArtifactForType("mtk");
                }
                break;
        }
    }

    private void sendMtkUpdateCompleteMessage() {
        Log.i(TAG, "Sending MTK update complete broadcast");
        Intent intent = new Intent("com.mentra.asg_client.MTK_UPDATE_COMPLETE");
        sendBroadcast(intent);
    }

    /**
     * Reboot the device to apply a staged MTK-only firmware update.
     *
     * <p>MTK A/B updates do not change ro.custom.ota.version until the device reboots. When MTK is
     * bundled with a BES update the BES install power-cycles the device for us; for an MTK-only
     * update nothing else triggers the reboot, so the device would otherwise keep re-offering the
     * same patch (current firmware still matches the patch's start_firmware) in a loop.
     *
     * <p>Delayed so the phone receives the BLE "complete" status before the connection drops.
     */
    private void scheduleMtkRebootToApplyUpdate() {
        Log.i(
                TAG,
                "🔄 MTK was the final OTA step (no BES update) - rebooting in "
                        + (MTK_REBOOT_DELAY_MS / 1000)
                        + "s to apply staged firmware");
        if (otaHelper != null) {
            otaHelper.expectFirmwareReboot();
        }
        new Handler(Looper.getMainLooper())
                .postDelayed(
                        () -> {
                            Log.i(TAG, "🔄 Rebooting now to apply staged MTK firmware update");
                            SystemControllerFactory.get(this).reboot();
                        },
                        MTK_REBOOT_DELAY_MS);
    }

    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onBesOtaProgress(BesOtaProgressEvent event) {
        // Note: BES install PROGRESS is sent to phone via sr_adota from BES chip directly (via BLE)
        // We can't send via UART during BES OTA because it's busy with firmware transfer
        // We only handle STARTED/FINISHED/FAILED here for logging and internal state management

        switch (event.getStatus()) {
            case STARTED:
                Log.i(TAG, "BES firmware update started");
                updateNotification("BES firmware update started");
                // Note: Can't send to phone - UART busy, phone will get progress via sr_adota
                break;
            case PROGRESS:
                // Progress is handled by BES chip sending sr_adota via BLE
                // No need to try sending via UART (it would fail anyway)
                updateNotification("Sending BES firmware: " + event.getProgress() + "%");
                break;
            case FINISHED:
                Log.i(TAG, "BES firmware update finished successfully");
                updateNotification("BES firmware updated successfully");
                if (otaHelper != null) {
                    otaHelper.continueSessionAfterStepComplete(this);
                }
                // Note: BES chip will send sr_adota with progress=100 or type=success
                break;
            case FAILED:
                Log.e(TAG, "BES firmware update failed: " + event.getErrorMessage());
                updateNotification("BES firmware update failed: " + event.getErrorMessage());
                // Try to notify phone of failure (might work if UART recovers)
                if (otaHelper != null) {
                    otaHelper.clearExpectedFirmwareReboot();
                    otaHelper.sendBesInstallProgressToPhone("FAILED", 0, event.getErrorMessage());
                    otaHelper.deleteDownloadedArtifactForType("bes");
                }
                break;
        }
    }

    private void checkAndResumeAfterApkUpdate() {
        try {
            // OtaHelper owns the process-wide session manager. Reusing it here prevents two
            // in-memory snapshots from overwriting each other's consumed reboot/install markers.
            OtaSessionManager sessionManager =
                    otaHelper != null ? otaHelper.getSessionManager() : new OtaSessionManager(this);

            if (sessionManager.hasActiveSession() && sessionManager.isInRestartGuard()) {
                Log.i(TAG, "📱 Active OTA session found in restart guard - auto-continuing");
                long waitMs = sessionManager.getRestartGuardRemainingMs();
                if (waitMs > 0) {
                    Log.i(
                            TAG,
                            "OTA restart guard: waiting " + waitMs + "ms before auto-continuing");
                    new Handler(Looper.getMainLooper())
                            .postDelayed(
                                    () -> {
                                        resumeFromSession(sessionManager);
                                    },
                                    waitMs);
                    return;
                }
                resumeFromSession(sessionManager);
                return;
            }

            // Never infer OTA completion from a young device uptime. A persisted session can
            // outlive an unrelated user reboot, and an APK install phase without its restart
            // guard can be a failed recovery handoff. Firmware code explicitly arms a marker
            // with the current Android boot count before an OTA-owned reboot; only a different
            // boot count is allowed to restart the current manifest step.
            if (sessionManager.hasActiveSession()) {
                int currentStepIndex = sessionManager.getCurrentStepIndex();
                String currentStepType = sessionManager.getStepType(currentStepIndex);
                String currentPhase = sessionManager.getCurrentPhase();
                if (sessionManager.hasExpectedFirmwareRebootOccurred()) {
                    Log.i(
                            TAG,
                            "Expected firmware reboot observed; rechecking current session step");
                    new Handler(Looper.getMainLooper())
                            .postDelayed(
                                    () -> {
                                        if (sessionManager.consumeExpectedFirmwareReboot()) {
                                            resumeCurrentSession(sessionManager);
                                        }
                                    },
                                    10_000L);
                    return;
                }
                Log.i(
                        TAG,
                        "📱 Active OTA session found without a verified package replacement or expected firmware reboot "
                                + "(step="
                                + currentStepIndex
                                + " type="
                                + currentStepType
                                + " phase="
                                + currentPhase
                                + ") — leaving session in place, no auto-resume");
                return;
            }

            SharedPreferences prefs = getSharedPreferences("ota_state", Context.MODE_PRIVATE);
            long previousVersion = prefs.getLong("last_seen_asg_version", -1);

            long currentVersion = AsgVersion.current();

            if (previousVersion == -1) {
                Log.i(
                        TAG,
                        "📱 First boot with version tracking - recording ASG version: "
                                + currentVersion);
                prefs.edit().putLong("last_seen_asg_version", currentVersion).apply();
                // Clear any recovery heartbeat pause that may have been set before this install.
                OtaHelper.notifyRecoveryInstallCompleted(this);

            } else if (currentVersion != previousVersion) {
                Log.i(
                        TAG,
                        "📱 ASG client was updated from "
                                + previousVersion
                                + " to "
                                + currentVersion);
                prefs.edit().putLong("last_seen_asg_version", currentVersion).apply();
                OtaHelper.notifyRecoveryInstallCompleted(this);

            } else {
                Log.d(
                        TAG,
                        "ASG version unchanged (" + currentVersion + ") - no auto-resume needed");
                // Safety net: clear any recovery heartbeat pause from a same-version reinstall.
                OtaHelper.notifyRecoveryInstallCompleted(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error checking for APK update auto-resume", e);
        }
    }

    private void resumeCurrentSession(OtaSessionManager sessionManager) {
        String versionJsonUrl = sessionManager.getVersionJsonUrl();
        if (otaHelper == null || versionJsonUrl == null || versionJsonUrl.isEmpty()) {
            Log.e(TAG, "Cannot recheck OTA session after reboot");
            return;
        }
        otaHelper.setPhoneInitiatedOta(true);
        otaHelper.startVersionCheckWithUrl(this, versionJsonUrl);
    }

    private void resumeFromSession(OtaSessionManager sessionManager) {
        try {
            long expectedAsgVersion = sessionManager.getExpectedAsgVersion();
            long installedAsgVersion = AsgVersion.current();
            if (expectedAsgVersion > 0 && installedAsgVersion != expectedAsgVersion) {
                Log.w(
                        TAG,
                        "ASG restart guard fired before exact target converged (installed="
                                + installedAsgVersion
                                + ", expected="
                                + expectedAsgVersion
                                + "); leaving session on APK install");
                return;
            }
            // Clear any recovery heartbeat pause that was set before the APK install.
            OtaHelper.notifyRecoveryInstallCompleted(this);
            sessionManager.clearRestartGuard();
            sessionManager.clearExpectedAsgVersion();
            int nextStep = sessionManager.getCurrentStepIndex() + 1;

            if (nextStep >= sessionManager.getTotalSteps()) {
                Log.i(TAG, "📱 All OTA session steps complete after APK restart");
                // Queue the APK-done signal BEFORE setComplete() so buildApkDoneJson()
                // can still read the correct session fields (total_steps, step_sequence, etc.).
                sessionManager.setPendingApkStatus("complete");
                sessionManager.setComplete();
                // sendCompletionToPhone() resends the completion on a fixed schedule, so
                // delivery no longer depends on winning the startup race against the UART
                // transport. onPhoneConnected() remains a complementary path for a real
                // BLE drop/reconnect mid-session.
                if (otaHelper != null) {
                    otaHelper.sendCompletionToPhone(sessionManager);
                }
                return;
            }

            // Multi-step (APK + MTK/BES): queue the APK step_complete signal BEFORE advancing
            // so buildApkDoneJson() captures the correct pre-advance session fields.
            sessionManager.setPendingApkStatus("step_complete");
            sessionManager.advanceStep(nextStep, "download");
            String stepType = sessionManager.getStepType(nextStep);
            Log.i(
                    TAG,
                    "📱 Resuming OTA session: step "
                            + (nextStep + 1)
                            + "/"
                            + sessionManager.getTotalSteps()
                            + " type="
                            + stepType);

            if (otaHelper == null) {
                Log.e(TAG, "OtaHelper not available - cannot resume OTA session");
                sessionManager.setFailed("OtaHelper not available after APK restart");
                return;
            }

            String versionJsonUrl = sessionManager.getVersionJsonUrl();
            if (versionJsonUrl == null || versionJsonUrl.isEmpty()) {
                Log.e(TAG, "No version JSON URL in session - cannot resume");
                sessionManager.setFailed("Missing version JSON URL");
                return;
            }

            otaHelper.setPhoneInitiatedOta(true);
            otaHelper.startVersionCheckWithUrl(this, versionJsonUrl);
        } catch (Exception e) {
            Log.e(TAG, "Error resuming OTA from session", e);
            sessionManager.setFailed("Resume error: " + e.getMessage());
        }
    }
}
