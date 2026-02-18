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

public class OtaUpdaterManager {
    private static final String TAG = "OtaUpdaterManager";
    private static final String OTA_UPDATER_PACKAGE = "com.augmentos.otaupdater";
    private static final String OTA_UPDATER_MAIN_ACTIVITY = "com.augmentos.otaupdater.MainActivity";
    private static final String OTA_UPDATER_SERVICE = "com.augmentos.otaupdater.OtaUpdaterService";
    private static final String OTA_APK_ASSET_NAME = "ota_updater.apk";
    private static final String OTA_APK_FILE_PATH = "/storage/emulated/0/asg/ota_updater.apk";
    private static final int ASSETS_OTA_UPDATER_VERSION = 3;
    private final Context context;
    private final Handler handler;
    private PackageInstallReceiver packageInstallReceiver;
    
    public OtaUpdaterManager(Context context) {
        this.context = context;
        this.handler = new Handler(Looper.getMainLooper());
    }
    
    /**
     * Initialize the OTA updater manager
     * Call this from AsgClientService.onCreate()
     */
    public void initialize() {
        // Register package install listener
        registerPackageInstallReceiver();
        
        // Check and ensure OTA updater after delay
        handler.postDelayed(this::ensureOtaUpdater, 5000);
    }
    
    /**
     * Clean up resources
     * Call this from AsgClientService.onDestroy()
     */
    public void cleanup() {
        unregisterPackageInstallReceiver();
        handler.removeCallbacksAndMessages(null);
    }
    
    /**
     * Ensure OTA Updater is installed and launch it
     */
    private void ensureOtaUpdater() {
        try {
            int currentVersion = getInstalledVersion(OTA_UPDATER_PACKAGE);
            
            // Deploy/recover if: not installed (-1), version 1, or corrupted
            if (currentVersion == -1 || currentVersion < ASSETS_OTA_UPDATER_VERSION) {
                Log.i(TAG, "OTA Updater needs deployment/recovery. Version: " + currentVersion);
                deployOtaUpdaterFromAssets();
            } else {
                // Current version OK, just launch it
                launchOtaUpdater();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to ensure OTA updater version v" + ASSETS_OTA_UPDATER_VERSION, e);
            launchOtaUpdater(); // Try to launch whatever exists
        }
    }
    
    /**
     * Deploy OTA updater from bundled assets
     */
    private void deployOtaUpdaterFromAssets() {
        try {
            // Extract from assets
            InputStream assetStream = context.getAssets().open(OTA_APK_ASSET_NAME);
            File otaFile = new File(OTA_APK_FILE_PATH);
            
            // Ensure directory exists
            File parentDir = otaFile.getParentFile();
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs();
            }
            
            // Copy to filesystem
            try (FileOutputStream fos = new FileOutputStream(otaFile)) {
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = assetStream.read(buffer)) != -1) {
                    fos.write(buffer, 0, bytesRead);
                }
            }
            assetStream.close();
            
            // Install using system broadcast
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "install");
            intent.putExtra("pkpath", otaFile.getAbsolutePath());
            context.sendBroadcast(intent);
            
            Log.i(TAG, "Installing OTA Updater");
            
            // Note: PackageInstallReceiver will launch it when installation completes
            
        } catch (Exception e) {
            Log.e(TAG, "Failed to deploy OTA updater from assets", e);
            // Still try to launch in case old version exists
            handler.postDelayed(this::launchOtaUpdater, 15000);
        }
    }
    
    /**
     * Launch the OTA updater (tries service first, then activity)
     */
    private void launchOtaUpdater() {
        try {
            int version = getInstalledVersion(OTA_UPDATER_PACKAGE);
            
            if (version >= ASSETS_OTA_UPDATER_VERSION) {
                // has service - try that first
                Intent serviceIntent = new Intent();
                serviceIntent.setClassName(OTA_UPDATER_PACKAGE, OTA_UPDATER_SERVICE);
                
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent);
                } else {
                    context.startService(serviceIntent);
                }
                Log.d(TAG, "Started OTA updater service");
            }
            
            // Also launch activity for UI (works for all versions)
            Intent activityIntent = new Intent();
            activityIntent.setClassName(OTA_UPDATER_PACKAGE, OTA_UPDATER_MAIN_ACTIVITY);
            activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(activityIntent);
            Log.d(TAG, "Launched OTA updater activity");
            
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch OTA updater", e);
        }
    }
    
    /**
     * Get installed version of a package
     * @return version code or -1 if not installed
     */
    private int getInstalledVersion(String packageName) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return (int) info.getLongVersionCode();
            } else {
                return info.versionCode;
            }
        } catch (PackageManager.NameNotFoundException e) {
            return -1; // Not installed
        } catch (Exception e) {
            Log.e(TAG, "Error getting package version", e);
            return -1;
        }
    }
    
    /**
     * Register receiver to monitor package installations
     */
    private void registerPackageInstallReceiver() {
        packageInstallReceiver = new PackageInstallReceiver();
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REPLACED);
        filter.addDataScheme("package");
        context.registerReceiver(packageInstallReceiver, filter);
        Log.d(TAG, "Registered package install receiver");
    }
    
    /**
     * Unregister package install receiver
     */
    private void unregisterPackageInstallReceiver() {
        if (packageInstallReceiver != null) {
            try {
                context.unregisterReceiver(packageInstallReceiver);
                Log.d(TAG, "Unregistered package install receiver");
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering receiver", e);
            }
            packageInstallReceiver = null;
        }
    }
    
    /**
     * Receiver to detect when packages are installed
     */
    private class PackageInstallReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (Intent.ACTION_PACKAGE_ADDED.equals(action) || 
                Intent.ACTION_PACKAGE_REPLACED.equals(action)) {
                
                // Get the package name that was installed
                String packageName = intent.getData() != null ? 
                    intent.getData().getSchemeSpecificPart() : null;
                
                if (OTA_UPDATER_PACKAGE.equals(packageName)) {
                    Log.i(TAG, "OTA updater was installed/updated, launching it");
                    
                    // Wait a bit for the installation to fully complete
                    handler.postDelayed(() -> launchOtaUpdater(), 2000);
                }
            }
        }
    }
}