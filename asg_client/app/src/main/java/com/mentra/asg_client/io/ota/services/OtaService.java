package com.mentra.asg_client.io.ota.services;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.ota.events.DownloadProgressEvent;
import com.mentra.asg_client.io.ota.events.InstallationProgressEvent;
import com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.SysControl;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

public class OtaService extends Service {
    private static final String TAG = OtaConstants.TAG;
    private static final String CHANNEL_ID = "ota_service_channel";
    private static final int NOTIFICATION_ID = 2001;
    
    private OtaHelper otaHelper;
    
    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "OtaService onCreate");
        
        // Create notification channel
        createNotificationChannel();
        
        // Start as foreground service
        startForeground(NOTIFICATION_ID, createNotification("OTA Service Running"));
        
        // TEMPORARY: Kill external OTA updater app if it's running
        // This prevents dual OTA checks when updating from older versions
        try {
            Log.w(TAG, "Stopping external OTA updater app to prevent conflicts");
            SysControl.stopApp(this, "com.augmentos.otaupdater");
            Log.i(TAG, "External OTA updater stopped");
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop external OTA updater", e);
        }
        
        // Initialize OTA helper singleton
        otaHelper = OtaHelper.initialize(this);

        // Clean up old firmware files from previous updates
        cleanupOldFirmwareFiles();

        // Check if ASG client was just updated - if so, auto-resume OTA for MTK/BES
        checkAndResumeAfterApkUpdate();

        // Register EventBus
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
        }

        // OtaHelper will automatically start checking:
        // - After 15 seconds (initial check)
        // - Every 30 minutes (periodic checks)
        // - When WiFi becomes available
        Log.i(TAG, "OTA service initialized - checks will begin automatically");
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
        
        // Clean up OTA helper
        if (otaHelper != null) {
            otaHelper.cleanup();
        }
    }
    
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
    
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "OTA Update Service",
                    NotificationManager.IMPORTANCE_LOW
            );
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
        Log.d(TAG, "Received battery status: " + event.getBatteryLevel() + "%, charging: " + event.isCharging());
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

                if (otaHelper != null) {
                    otaHelper.sendMtkInstallProgressToPhone("FINISHED", 100, null);
                    // Session-based path: auto-advance to the next step (e.g. BES) immediately
                    // so BES starts without waiting for a phone-side re-check or user tap.
                    boolean advanced = otaHelper.continueSessionAfterStepComplete(this);
                    if (!advanced) {
                        // Legacy path (no active session): tell the phone MTK is done so it
                        // can decide whether to start another round.
                        Log.i(TAG, "📱 MTK complete (no session) - notifying phone via legacy broadcast");
                        sendMtkUpdateCompleteMessage();
                    }
                } else {
                    sendMtkUpdateCompleteMessage();
                }
                break;
            case ERROR:
                updateNotification("MTK firmware update failed: " + event.getMessage());
                // Send FAILED to phone so user knows something went wrong
                if (otaHelper != null) {
                    otaHelper.sendMtkInstallProgressToPhone("FAILED", 0, event.getMessage());
                    otaHelper.clearCachedArtifactsForType("mtk");
                }
                break;
        }
    }
    
    private void sendMtkUpdateCompleteMessage() {
        Log.i(TAG, "Sending MTK update complete broadcast");
        Intent intent = new Intent("com.mentra.asg_client.MTK_UPDATE_COMPLETE");
        sendBroadcast(intent);
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
                // Note: BES chip will send sr_adota with progress=100 or type=success
                break;
            case FAILED:
                Log.e(TAG, "BES firmware update failed: " + event.getErrorMessage());
                updateNotification("BES firmware update failed: " + event.getErrorMessage());
                // Try to notify phone of failure (might work if UART recovers)
                if (otaHelper != null) {
                    otaHelper.sendBesInstallProgressToPhone("FAILED", 0, event.getErrorMessage());
                    otaHelper.clearCachedArtifactsForType("bes");
                }
                break;
        }
    }

    /**
     * Clean up old firmware files from previous OTA updates.
     * Called on service startup to remove any leftover files.
     */
    private void cleanupOldFirmwareFiles() {
        try {
            if (otaHelper != null) {
                otaHelper.pruneInvalidCachedArtifactsOnStartup();
            } else {
                Log.w(TAG, "OtaHelper unavailable for cache pruning on startup");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error cleaning up old firmware files", e);
        }
    }

    private void checkAndResumeAfterApkUpdate() {
        try {
            OtaSessionManager sessionManager = new OtaSessionManager(this);

            if (sessionManager.hasActiveSession() && sessionManager.isInRestartGuard()) {
                Log.i(TAG, "📱 Active OTA session found in restart guard - auto-continuing");
                long waitMs = sessionManager.getRestartGuardRemainingMs();
                if (waitMs > 0) {
                    Log.i(TAG, "OTA restart guard: waiting " + waitMs + "ms before auto-continuing");
                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                        resumeFromSession(sessionManager);
                    }, waitMs);
                    return;
                }
                resumeFromSession(sessionManager);
                return;
            }

            // Edge case: an active session exists but the restart guard was never armed (or
            // was already cleared, e.g. by an installApk failure rollback). Without this
            // branch we fall through to the version-bump heuristic and may either skip the
            // resume entirely, or kick a duplicate version check while a real session is
            // still in flight. Resume directly so the next step is picked up.
            //
            // CRITICAL: resumeFromSession() unconditionally advances currentStepIndex + 1.
            // We must only invoke it when the active session is the APK install restart
            // recovery case (step 0, type=apk, phase=install). For any other in-flight
            // session (e.g. MTK/BES download or install) the service may have been
            // recreated by the OS while a real OTA step is still running on the glasses,
            // so advancing here would skip the current step or mark the session complete
            // before the update actually finished. Leave that session alone and let
            // normal OTA progress events drive it.
            if (sessionManager.hasActiveSession()) {
                int currentStepIndex = sessionManager.getCurrentStepIndex();
                String currentStepType = sessionManager.getStepType(currentStepIndex);
                String currentPhase = sessionManager.getCurrentPhase();
                boolean isApkInstallRestart = currentStepIndex == 0
                        && "apk".equals(currentStepType)
                        && "install".equals(currentPhase);
                if (isApkInstallRestart) {
                    Log.i(TAG, "📱 Active APK install session found without restart guard — resuming next step");
                    resumeFromSession(sessionManager);
                    return;
                }
                Log.i(TAG, "📱 Active OTA session found without restart guard but not APK install restart "
                        + "(step=" + currentStepIndex + " type=" + currentStepType + " phase=" + currentPhase
                        + ") — leaving session in place, no auto-resume");
                return;
            }

            SharedPreferences prefs = getSharedPreferences("ota_state", Context.MODE_PRIVATE);
            long previousVersion = prefs.getLong("last_seen_asg_version", -1);

            PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            long currentVersion = packageInfo.getLongVersionCode();

            if (previousVersion == -1) {
                Log.i(TAG, "📱 First boot with version tracking - recording ASG version: " + currentVersion);
                prefs.edit().putLong("last_seen_asg_version", currentVersion).apply();

                if (otaHelper != null) {
                    Log.i(TAG, "📱 Triggering background OTA pre-download check (first boot or update from old version)");
                    otaHelper.startVersionCheck(this);
                }
            } else if (currentVersion > previousVersion) {
                Log.i(TAG, "📱 ASG client was updated from " + previousVersion + " to " + currentVersion);
                prefs.edit().putLong("last_seen_asg_version", currentVersion).apply();

                if (otaHelper != null) {
                    Log.i(TAG, "📱 Auto-resuming background OTA pre-download check for MTK/BES updates");
                    otaHelper.startVersionCheck(this);
                }
            } else {
                Log.d(TAG, "ASG version unchanged (" + currentVersion + ") - no auto-resume needed");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error checking for APK update auto-resume", e);
        }
    }

    private void resumeFromSession(OtaSessionManager sessionManager) {
        try {
            sessionManager.clearRestartGuard();
            int nextStep = sessionManager.getCurrentStepIndex() + 1;

            if (nextStep >= sessionManager.getTotalSteps()) {
                Log.i(TAG, "📱 All OTA session steps complete after APK restart");
                // Queue the APK-done signal BEFORE setComplete() so buildApkDoneJson()
                // can still read the correct session fields (total_steps, step_sequence, etc.).
                sessionManager.setPendingApkStatus("complete");
                sessionManager.setComplete();
                // onPhoneConnected() is the primary delivery path for the APK done signal.
                // sendCompletionToPhone() here is a fallback for the case where the phone
                // is already connected when this code runs (unlikely but possible).
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
            Log.i(TAG, "📱 Resuming OTA session: step " + (nextStep + 1) + "/" + sessionManager.getTotalSteps() + " type=" + stepType);

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