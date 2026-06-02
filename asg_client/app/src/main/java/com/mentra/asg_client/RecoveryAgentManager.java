package com.mentra.asg_client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

public class RecoveryAgentManager {
    private static final String TAG = "RecoveryAgentManager";
    private static final String RECOVERY_PACKAGE = "com.mentra.recovery";
    private static final String LEGACY_UPDATER_PACKAGE = "com.augmentos.otaupdater";
    private static final String RECOVERY_LAUNCHER_ACTIVITY = "com.mentra.recovery.ui.LauncherActivity";
    private static final String RECOVERY_APK_ASSET_NAME = "recovery_agent.apk";
    private static final String RECOVERY_APK_FILE_PATH =
            "/storage/emulated/0/asg/recovery_agent.apk";
    private static final int ASSETS_RECOVERY_VERSION = 4;
    private static final String PREFS = "RecoveryAgentManagerPrefs";
    private static final String KEY_PURGED_LEGACY = "legacy_updater_purged";

    private final Context context;
    private final Handler handler;
    private PackageInstallReceiver packageInstallReceiver;

    public RecoveryAgentManager(Context context) {
        this.context = context.getApplicationContext();
        this.handler = new Handler(Looper.getMainLooper());
    }

    public void initialize() {
        registerPackageInstallReceiver();
        handler.postDelayed(this::ensureRecoveryAgent, 5000);
    }

    public void cleanup() {
        unregisterPackageInstallReceiver();
        handler.removeCallbacksAndMessages(null);
    }

    private void ensureRecoveryAgent() {
        try {
            purgeLegacyUpdaterIfNeeded();
            int currentVersion = getInstalledVersion(RECOVERY_PACKAGE);
            if (currentVersion == -1 || currentVersion < ASSETS_RECOVERY_VERSION) {
                deployRecoveryAgentFromAssets();
            } else {
                launchRecoveryAgent();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to ensure recovery agent", e);
            launchRecoveryAgent();
        }
    }

    private void purgeLegacyUpdaterIfNeeded() {
        if (context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_PURGED_LEGACY, false)) {
            return;
        }
        if (getInstalledVersion(LEGACY_UPDATER_PACKAGE) == -1) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_PURGED_LEGACY, true)
                    .apply();
            return;
        }
        try {
            SysControl.stopApp(context, LEGACY_UPDATER_PACKAGE);
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "uninstall");
            intent.putExtra("pkname", LEGACY_UPDATER_PACKAGE);
            context.sendBroadcast(intent);
            Log.i(TAG, "Requested uninstall of legacy OTA updater package");
        } catch (Exception e) {
            Log.w(TAG, "Failed to purge legacy OTA updater package", e);
        } finally {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_PURGED_LEGACY, true)
                    .apply();
        }
    }

    private void deployRecoveryAgentFromAssets() {
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
            Log.i(TAG, "Installing recovery agent");
        } catch (Exception e) {
            Log.e(TAG, "Failed to deploy recovery agent from assets", e);
            handler.postDelayed(this::launchRecoveryAgent, 15000);
        }
    }

    private void launchRecoveryAgent() {
        try {
            Intent launchIntent = new Intent();
            launchIntent.setClassName(RECOVERY_PACKAGE, RECOVERY_LAUNCHER_ACTIVITY);
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(launchIntent);
            Log.d(TAG, "Triggered recovery agent launcher activity");
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch recovery agent", e);
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
        context.registerReceiver(packageInstallReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
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
                handler.postDelayed(RecoveryAgentManager.this::launchRecoveryAgent, 2000);
            }
        }
    }
}
