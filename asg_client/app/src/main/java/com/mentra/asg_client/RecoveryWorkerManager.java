package com.mentra.asg_client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.List;

/** Deploys and starts the {@code com.mentra.recovery} sidecar (recovery worker APK). */
public class RecoveryWorkerManager {
    private static final String TAG = "RecoveryWorkerManager";
    private static final String RECOVERY_PACKAGE = "com.mentra.recovery";
    private static final String LEGACY_UPDATER_PACKAGE = "com.augmentos.otaupdater";
    private static final String RECOVERY_LAUNCHER_ACTIVITY = "com.mentra.recovery.ui.LauncherActivity";
    private static final String ACTION_START_RECOVERY = "com.mentra.recovery.ACTION_START_RECOVERY";
    private static final String RECOVERY_CONTROL_PERMISSION =
            "com.mentra.recovery.permission.CONTROL";
    private static final String RECOVERY_APK_ASSET_NAME = "recovery_worker.apk";
    private static final String RECOVERY_APK_FILE_PATH =
            "/storage/emulated/0/asg/recovery_worker.apk";
    private static final int ASSETS_RECOVERY_VERSION = 5;
    private static final String PREFS = "RecoveryWorkerManagerPrefs";
    private static final String KEY_PURGED_LEGACY = "legacy_updater_purged";

    private final Context context;
    private final Handler handler;
    private PackageInstallReceiver packageInstallReceiver;

    public RecoveryWorkerManager(Context context) {
        this.context = context.getApplicationContext();
        this.handler = new Handler(Looper.getMainLooper());
    }

    public void initialize() {
        registerPackageInstallReceiver();
        handler.postDelayed(this::ensureRecoveryWorker, 5000);
    }

    public void cleanup() {
        unregisterPackageInstallReceiver();
        handler.removeCallbacksAndMessages(null);
    }

    private void ensureRecoveryWorker() {
        try {
            purgeLegacyUpdaterIfNeeded();
            int currentVersion = getInstalledVersion(RECOVERY_PACKAGE);
            if (currentVersion == -1
                    || currentVersion < ASSETS_RECOVERY_VERSION
                    || !canStartRecoveryWorker()) {
                deployRecoveryWorkerFromAssets();
            } else {
                launchRecoveryWorker();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to ensure recovery worker", e);
            launchRecoveryWorker();
        }
    }

    private void purgeLegacyUpdaterIfNeeded() {
        if (context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_PURGED_LEGACY, false)) {
            return;
        }
        if (getInstalledVersion(LEGACY_UPDATER_PACKAGE) == -1) {
            // Already gone — record success so we never check again.
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_PURGED_LEGACY, true)
                    .apply();
            return;
        }
        try {
            SystemControllerFactory.get(context).stopApp(LEGACY_UPDATER_PACKAGE);
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "uninstall");
            intent.putExtra("pkname", LEGACY_UPDATER_PACKAGE);
            context.sendBroadcast(intent);
            Log.i(TAG, "Requested uninstall of legacy OTA updater package");
            // Do NOT set KEY_PURGED_LEGACY here. The uninstall is asynchronous and the
            // broadcast may be silently dropped. On the next ASG startup the version check
            // above will confirm the package is gone and then permanently latch the flag.
        } catch (Exception e) {
            Log.w(TAG, "Failed to purge legacy OTA updater package", e);
        }
    }

    private void deployRecoveryWorkerFromAssets() {
        try {
            File recoveryFile = new File(RECOVERY_APK_FILE_PATH);
            File parentDir = recoveryFile.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }
            try (InputStream assetStream = context.getAssets().open(RECOVERY_APK_ASSET_NAME);
                    FileOutputStream fos = new FileOutputStream(recoveryFile)) {
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = assetStream.read(buffer)) != -1) {
                    fos.write(buffer, 0, bytesRead);
                }
            }

            Intent install = new Intent("com.xy.xsetting.action");
            install.setPackage("com.android.systemui");
            install.putExtra("cmd", "install");
            install.putExtra("pkpath", recoveryFile.getAbsolutePath());
            context.sendBroadcast(install);
            Log.i(TAG, "Installing recovery worker");
        } catch (Exception e) {
            Log.e(TAG, "Failed to deploy recovery worker from assets", e);
            handler.postDelayed(this::launchRecoveryWorker, 15000);
        }
    }

    private void launchRecoveryWorker() {
        if (sendStartRecoveryBroadcast()) {
            Log.d(TAG, "Requested recovery worker start via broadcast");
            return;
        }
        if (startRecoveryLauncherIfAvailable()) {
            Log.d(TAG, "Triggered recovery worker launcher activity");
            return;
        }
        Log.w(TAG, "Recovery worker installed but missing start surface; redeploying");
        deployRecoveryWorkerFromAssets();
    }

    private boolean canStartRecoveryWorker() {
        PackageManager pm = context.getPackageManager();
        Intent launchIntent = new Intent();
        launchIntent.setClassName(RECOVERY_PACKAGE, RECOVERY_LAUNCHER_ACTIVITY);
        if (launchIntent.resolveActivity(pm) != null) {
            return true;
        }
        Intent startIntent = new Intent(ACTION_START_RECOVERY);
        startIntent.setPackage(RECOVERY_PACKAGE);
        List<ResolveInfo> receivers = pm.queryBroadcastReceivers(startIntent, 0);
        return receivers != null && !receivers.isEmpty();
    }

    private boolean sendStartRecoveryBroadcast() {
        Intent startIntent = new Intent(ACTION_START_RECOVERY);
        startIntent.setPackage(RECOVERY_PACKAGE);
        List<ResolveInfo> receivers =
                context.getPackageManager().queryBroadcastReceivers(startIntent, 0);
        if (receivers == null || receivers.isEmpty()) {
            return false;
        }
        try {
            context.sendBroadcast(startIntent, RECOVERY_CONTROL_PERMISSION);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to send recovery start broadcast", e);
            return false;
        }
    }

    private boolean startRecoveryLauncherIfAvailable() {
        try {
            Intent launchIntent = new Intent();
            launchIntent.setClassName(RECOVERY_PACKAGE, RECOVERY_LAUNCHER_ACTIVITY);
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (launchIntent.resolveActivity(context.getPackageManager()) == null) {
                return false;
            }
            context.startActivity(launchIntent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Launcher start failed", e);
            return false;
        }
    }

    private int getInstalledVersion(String packageName) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return (int) info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return -1;
        } catch (Exception e) {
            Log.e(TAG, "Error getting package version", e);
            return -1;
        }
    }

    private void registerPackageInstallReceiver() {
        packageInstallReceiver = new PackageInstallReceiver();
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REPLACED);
        filter.addDataScheme("package");
        ContextCompat.registerReceiver(
                context,
                packageInstallReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void unregisterPackageInstallReceiver() {
        if (packageInstallReceiver == null) {
            return;
        }
        try {
            context.unregisterReceiver(packageInstallReceiver);
        } catch (Exception e) {
            Log.e(TAG, "Error unregistering package receiver", e);
        }
        packageInstallReceiver = null;
    }

    private class PackageInstallReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (!Intent.ACTION_PACKAGE_ADDED.equals(action)
                    && !Intent.ACTION_PACKAGE_REPLACED.equals(action)) {
                return;
            }
            String packageName =
                    intent.getData() != null ? intent.getData().getSchemeSpecificPart() : null;
            if (RECOVERY_PACKAGE.equals(packageName)) {
                handler.postDelayed(RecoveryWorkerManager.this::launchRecoveryWorker, 2000);
            }
        }
    }
}
