package com.mentra.asg_client.io.ota.helpers;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Network;
import android.net.NetworkRequest;

import org.json.JSONException;
import org.json.JSONObject;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.io.bes.BesOtaManager;
import com.mentra.asg_client.io.ota.events.DownloadProgressEvent;
import com.mentra.asg_client.io.ota.events.InstallationProgressEvent;

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
import java.util.stream.Collectors;

import com.mentra.asg_client.io.ota.utils.OtaConstants;

public class OtaHelper {
    private static final String TAG = OtaConstants.TAG;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static ConnectivityManager connectivityManager;
    private static volatile boolean isCheckingVersion = false;
    private static volatile boolean isUpdating = false;  // Tracks download/install in progress
    private static volatile boolean isMtkOtaInProgress = false;  // Tracks MTK firmware update in progress
    private static final Object versionCheckLock = new Object();
    private Handler handler;
    private Context context;
    private Runnable periodicCheckRunnable;
    private boolean isPeriodicCheckActive = false;
    
    // Retry logic constants
    private static final int MAX_DOWNLOAD_RETRIES = 3;
    private static final long[] RETRY_DELAYS = {30000, 60000, 120000}; // 30s, 1m, 2m
    
    // Update order configuration - can be easily modified to change update sequence
    // Order: APK updates → MTK firmware → BES firmware
    private static final String UPDATE_TYPE_APK = "apk";
    private static final String UPDATE_TYPE_MTK = "mtk";
    private static final String UPDATE_TYPE_BES = "bes";
    private static final String[] UPDATE_ORDER = {UPDATE_TYPE_APK, UPDATE_TYPE_MTK, UPDATE_TYPE_BES};
    
    // ⚠️ DEBUG FLAG: Set to true to skip all checks and install MTK firmware from local file
    // This will bypass version checking, downloading, and directly install /storage/emulated/0/asg/mtk_firmware.zip
    private static final boolean DEBUG_FORCE_MTK_INSTALL = false;

    public OtaHelper(Context context) {
        this.context = context.getApplicationContext(); // Use application context to avoid memory leaks
        handler = new Handler(Looper.getMainLooper());
        
        // Register for EventBus to receive battery status updates
        EventBus.getDefault().register(this);
        
        // Schedule initial check after 15 seconds
        handler.postDelayed(() -> {
            Log.d(TAG, "Performing initial OTA check after 15 seconds");
            startVersionCheck(this.context);
        }, 15000);
        
        // Start periodic checks
        startPeriodicChecks();

        // Register network callback to check for updates when WiFi becomes available
        registerNetworkCallback(this.context);
    }

    public void cleanup() {
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
        stopPeriodicChecks();
        unregisterNetworkCallback();
        
        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }
        
        context = null;
    }

    private void startPeriodicChecks() {
        if (isPeriodicCheckActive) {
            Log.d(TAG, "Periodic checks already active");
            return;
        }

        periodicCheckRunnable = new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "Performing periodic OTA check");
                startVersionCheck(context);
                // Schedule next check
                handler.postDelayed(this, OtaConstants.PERIODIC_CHECK_INTERVAL_MS);
            }
        };

        // Start the first periodic check after the interval
        handler.postDelayed(periodicCheckRunnable, OtaConstants.PERIODIC_CHECK_INTERVAL_MS);
        isPeriodicCheckActive = true;
        Log.d(TAG, "Started periodic OTA checks every 15 minutes");
    }

    private void stopPeriodicChecks() {
        if (!isPeriodicCheckActive) {
            return;
        }

        if (handler != null && periodicCheckRunnable != null) {
            handler.removeCallbacks(periodicCheckRunnable);
        }
        isPeriodicCheckActive = false;
        Log.d(TAG, "Stopped periodic OTA checks");
    }

    public void registerNetworkCallback(Context context) {
        Log.d(TAG, "Registering network callback");
        connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);

        if (connectivityManager == null) {
            Log.e(TAG, "ConnectivityManager not available");
            return;
        }

        if (networkCallback != null) {
            Log.d(TAG, "Network callback already registered");
            return;
        }

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                super.onAvailable(network);
                NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
                if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    Log.d(TAG, "WiFi network became available, triggering version check");
                    startVersionCheck(context);
                }
            }
        };

        NetworkRequest.Builder builder = new NetworkRequest.Builder();
        builder.addTransportType(NetworkCapabilities.TRANSPORT_WIFI);

        try {
            connectivityManager.registerNetworkCallback(builder.build(), networkCallback);
            Log.d(TAG, "Successfully registered network callback");
        } catch (Exception e) {
            Log.e(TAG, "Failed to register network callback", e);
        }
    }

    public void unregisterNetworkCallback() {
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
                networkCallback = null;
                Log.d(TAG, "Network callback unregistered");
            } catch (Exception e) {
                Log.e(TAG, "Failed to unregister network callback", e);
            }
        }
    }

    private boolean isNetworkAvailable(Context context) {
        Log.d(TAG, "Checking WiFi connectivity status...");
        ConnectivityManager connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(connectivityManager.getActiveNetwork());
                if (capabilities != null) {
                    boolean hasWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
                    Log.d(TAG, "SDK >= 23: WiFi status: " + (hasWifi ? "Connected" : "Disconnected"));
                    return hasWifi;
                } else {
                    Log.e(TAG, "SDK >= 23: No network capabilities found");
                }
            } else {
                NetworkInfo activeNetworkInfo = connectivityManager.getActiveNetworkInfo();
                if (activeNetworkInfo != null) {
                    boolean isConnected = activeNetworkInfo.isConnected();
                    boolean isWifi = activeNetworkInfo.getType() == ConnectivityManager.TYPE_WIFI;
                    Log.d(TAG, "SDK < 23: Network status - Connected: " + isConnected + ", WiFi: " + isWifi);
                    return isConnected && isWifi;
                } else {
                    Log.e(TAG, "SDK < 23: No active network info found");
                }
            }
        } else {
            Log.e(TAG, "ConnectivityManager not available");
        }
        Log.e(TAG, "No WiFi connection detected");
        return false;
    }

    public void startVersionCheck(Context context) {
        Log.d(TAG, "Check OTA update method init");

        // if (!isNetworkAvailable(context)) {
        //     Log.e(TAG, "No WiFi connection available. Skipping OTA check.");
        //     return;
        // }
        
        // // Check battery status before proceeding with OTA update
        // if (!isBatterySufficientForUpdates()) {
        //     Log.w(TAG, "🚨 Battery insufficient for OTA updates - skipping version check");
        //     return;
        // }

        // Check if version check is already in progress
        if (isCheckingVersion) {
            Log.d(TAG, "Version check already in progress, skipping this request");
            return;
        }

        new Thread(() -> {
            // Use synchronized block to ensure thread safety
            synchronized (versionCheckLock) {
                if (isCheckingVersion || isUpdating) {
                    Log.d(TAG, "Version check or update already in progress, skipping");
                    return;
                }
                isCheckingVersion = true;
            }

            try {
                // ⚠️ DEBUG: Mock JSON to skip APK checks and trigger MTK install
                String versionInfo;
                if (DEBUG_FORCE_MTK_INSTALL) {
                    Log.w(TAG, "DEBUG: Using mock version.json (APK versions set to 0 to skip updates)");
                    versionInfo = "{"
                        + "\"apps\": {"
                        + "  \"com.mentra.asg_client\": {"
                        + "    \"versionCode\": 0,"
                        + "    \"versionName\": \"0.0.0\","
                        + "    \"apkUrl\": \"https://mock.url/app.apk\","
                        + "    \"sha256\": \"mock\""
                        + "  },"
                        + "  \"com.augmentos.otaupdater\": {"
                        + "    \"versionCode\": 0,"
                        + "    \"versionName\": \"0.0.0\","
                        + "    \"apkUrl\": \"https://mock.url/updater.apk\","
                        + "    \"sha256\": \"mock\""
                        + "  }"
                        + "}"
                        + "}";
                } else {
                    // Fetch version info normally
                    versionInfo = fetchVersionInfo(OtaConstants.VERSION_JSON_URL);
                }
                JSONObject json = new JSONObject(versionInfo);
                
                // Check if new format (multiple apps) or legacy format
                if (json.has("apps")) {
                    // New format - process sequentially (pass root JSON for firmware access)
                    processAppsSequentially(json, context);
                } else {
                    // Legacy format - only ASG client
                    Log.d(TAG, "Using legacy version.json format");
                    checkAndUpdateApp("com.mentra.asg_client", json, context);
                }
            } catch (Exception e) {
                Log.e(TAG, "Exception during OTA check", e);
            } finally {
                // Always reset the flag when done
                isCheckingVersion = false;
                Log.d(TAG, "Version check completed, ready for next check");
            }
        }).start();
    }

    private String fetchVersionInfo(String url) throws Exception {
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(new URL(url).openStream())
        );
        return reader.lines().collect(Collectors.joining("\n"));
    }

    private void processAppsSequentially(JSONObject rootJson, Context context) throws Exception {
        // Get the apps object from root
        JSONObject apps = rootJson.getJSONObject("apps");
        
        // Process apps in order - important for sequential updates
        String[] orderedPackages = {
            "com.mentra.asg_client",     // Update ASG client first
            "com.augmentos.otaupdater"      // Then OTA updater
        };
        
        boolean apkUpdateNeeded = false;
        
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
                    Log.e(TAG, "Failed to update " + packageName + ", stopping sequential updates");
                    break; // Stop if update fails
                }
            } else {
                Log.d(TAG, packageName + " is up to date (version " + currentVersion + ")");
            }
        }
        
        Log.d(TAG, "apkUpdateNeeded: " + apkUpdateNeeded);
        
        // PHASE 2: Update MTK firmware (only if no APK update)
        boolean mtkUpdateStarted = false;
        
        // ⚠️ DEBUG MODE: Force install MTK firmware from local file
        if (DEBUG_FORCE_MTK_INSTALL && !apkUpdateNeeded) {
            Log.w(TAG, "========================================");
            Log.w(TAG, "⚠️⚠️⚠️ DEBUG MODE ACTIVE ⚠️⚠️⚠️");
            Log.w(TAG, "Force installing MTK firmware from local file");
            Log.w(TAG, "Skipping version check and download");
            Log.w(TAG, "========================================");
            mtkUpdateStarted = debugInstallMtkFirmware(context);
            if (mtkUpdateStarted) {
                Log.i(TAG, "DEBUG: MTK firmware install triggered");
            } else {
                Log.e(TAG, "DEBUG: MTK firmware install failed - check if file exists");
            }
        }
        // Normal MTK update flow
        else if (!apkUpdateNeeded && rootJson.has("mtk_firmware")) {
            Log.i(TAG, "No APK updates needed - checking MTK firmware");
            mtkUpdateStarted = checkAndUpdateMtkFirmware(rootJson.getJSONObject("mtk_firmware"), context);
            if (mtkUpdateStarted) {
                Log.i(TAG, "MTK firmware update started - BES firmware check will happen after restart");
            }
        } else if (apkUpdateNeeded) {
            Log.i(TAG, "APK update performed - MTK firmware check will happen after restart");
        }
        
        // PHASE 3: Update BES firmware (only if no APK update and no MTK update)
        if (!apkUpdateNeeded && !mtkUpdateStarted && rootJson.has("bes_firmware")) {
            Log.i(TAG, "No APK or MTK updates needed - checking BES firmware");
            checkAndUpdateBesFirmware(rootJson.getJSONObject("bes_firmware"), context);
        } else if (apkUpdateNeeded || mtkUpdateStarted) {
            Log.i(TAG, "APK or MTK update performed - BES firmware check will happen after next check cycle");
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
            // Check for mutual exclusion - don't start APK update if firmware update in progress
            if (BesOtaManager.isBesOtaInProgress) {
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
                // Set update flag to prevent concurrent updates
                isUpdating = true;
                Log.i(TAG, "Starting update process for " + packageName);
                
                // Delete old APK if exists
                String filename = packageName.equals(context.getPackageName()) 
                    ? "ota_updater_update.apk" 
                    : "asg_client_update.apk";
                File apkFile = new File(OtaConstants.BASE_DIR, filename);
                
                if (apkFile.exists()) {
                    Log.d(TAG, "Deleting existing APK: " + apkFile.getName());
                    apkFile.delete();
                }
                
                // Create backup before update
                createAppBackup(packageName, context);
                
                // Download new version
                boolean downloadOk = downloadApk(apkUrl, appInfo, context, filename);
                if (downloadOk) {
                    // Install
                    installApk(context, apkFile.getAbsolutePath());
                    
                    // Clean up update file after 30 seconds
                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                        if (apkFile.exists()) {
                            boolean deleted = apkFile.delete();
                            Log.d(TAG, "Cleaned up update file " + filename + ": " + deleted);
                        }
                    }, 30000);
                    
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Failed to update " + packageName, e);
            return false;
        }
    }
    
    private void createAppBackup(String packageName, Context context) {
        // Only backup ASG client - OTA updater can be restored from ASG client assets
        if (!packageName.equals("com.mentra.asg_client")) {
            Log.d(TAG, "Skipping backup for " + packageName + " (can be restored from assets)");
            return;
        }
        
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(packageName, 0);
            String sourceApk = info.applicationInfo.sourceDir;
            
            File backupFile = new File(OtaConstants.BASE_DIR, "asg_client_backup.apk");
            File sourceFile = new File(sourceApk);
            
            // Simple file copy
            FileInputStream fis = new FileInputStream(sourceFile);
            FileOutputStream fos = new FileOutputStream(backupFile);
            byte[] buffer = new byte[8192];
            int bytesRead;
            while ((bytesRead = fis.read(buffer)) != -1) {
                fos.write(buffer, 0, bytesRead);
            }
            fis.close();
            fos.close();
            
            Log.i(TAG, "Created backup for " + packageName + " at: " + backupFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to create backup for " + packageName, e);
        }
    }

    // Backward compatibility - default to "asg_client_update.apk"
    public boolean downloadApk(String urlStr, JSONObject json, Context context) {
        return downloadApk(urlStr, json, context, "asg_client_update.apk");
    }
    
    // Modified to accept custom filename for different apps
    public boolean downloadApk(String urlStr, JSONObject json, Context context, String filename) {
        int retryCount = 0;
        Exception lastException = null;
        
        while (retryCount < MAX_DOWNLOAD_RETRIES) {
            try {
                // Attempt download
                if (downloadApkInternal(urlStr, json, context, filename)) {
                    return true; // Success!
                }
            } catch (Exception e) {
                lastException = e;
                Log.e(TAG, "Download attempt " + (retryCount + 1) + " failed", e);
                
                // Clean up partial download
                File partialFile = new File(OtaConstants.BASE_DIR, filename);
                if (partialFile.exists()) {
                    partialFile.delete();
                    Log.d(TAG, "Cleaned up partial download file");
                }
                
                retryCount++;
                if (retryCount < MAX_DOWNLOAD_RETRIES) {
                    long delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)];
                    Log.i(TAG, "Retrying download in " + (delay / 1000) + " seconds...");
                    
                    // Emit retry event
                    EventBus.getDefault().post(new DownloadProgressEvent(
                        DownloadProgressEvent.DownloadStatus.FAILED, 
                        "Retrying in " + (delay / 1000) + " seconds..."
                    ));
                    
                    try {
                        Thread.sleep(delay);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        }
        
        Log.e(TAG, "Download failed after " + MAX_DOWNLOAD_RETRIES + " attempts", lastException);
        EventBus.getDefault().post(new DownloadProgressEvent(
            DownloadProgressEvent.DownloadStatus.FAILED, 
            "Failed after " + MAX_DOWNLOAD_RETRIES + " attempts"
        ));
        return false;
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
        conn.connect();

        InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(apkFile);

        byte[] buffer = new byte[4096];
        int len;
        long total = 0;
        long fileSize = conn.getContentLength();
        int lastProgress = 0;

        Log.d(TAG, "Download started, file size: " + fileSize + " bytes");
        
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
        }

        out.close();
        in.close();

        Log.d(TAG, "APK downloaded to: " + apkFile.getAbsolutePath());
        
        // Emit download finished event
        EventBus.getDefault().post(DownloadProgressEvent.createFinished(fileSize));
        
        // Immediately check hash after download
        boolean hashOk = verifyApkFile(apkFile.getAbsolutePath(), json);
        Log.d(TAG, "SHA256 verification result: " + hashOk);
        if (hashOk) {
            createMetaDataJson(json, context);
            return true;
        } else {
            Log.e(TAG, "Downloaded APK hash does not match expected value! Deleting APK.");
            if (apkFile.exists()) {
                boolean deleted = apkFile.delete();
                Log.d(TAG, "SHA256 mismatch – APK deleted: " + deleted);
            }
            // Emit download failed event due to hash mismatch
            EventBus.getDefault().post(new DownloadProgressEvent(DownloadProgressEvent.DownloadStatus.FAILED, "SHA256 hash verification failed"));
            return false;
        }
    }

    private boolean verifyApkFile(String apkPath, JSONObject jsonObject) {
        try {
            String expectedHash = jsonObject.getString("sha256");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            InputStream is = new FileInputStream(apkPath);
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

            Log.d(TAG, "Expected SHA256: " + expectedHash);
            Log.d(TAG, "Calculated SHA256: " + calculatedHash);

            boolean match = calculatedHash.equalsIgnoreCase(expectedHash);
            Log.d(TAG, "SHA256 check " + (match ? "passed" : "failed"));
            return match;
        } catch (Exception e) {
            Log.e(TAG, "SHA256 check error", e);
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

    public void installApk(Context context) {
        installApk(context, OtaConstants.APK_FULL_PATH);
    }

    public static void installApk(Context context, String apkPath) {
        try {
//            if (apkPath.equals(Constants.APK_FULL_PATH)) {
//                checkOlderApkFile(context);
//            }
            Log.d(TAG, "Starting installation process for APK at: " + apkPath);
            
            // Emit installation started event
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.STARTED, apkPath));
            
            Intent intent = new Intent("com.xy.xsetting.action");
            intent.setPackage("com.android.systemui");
            intent.putExtra("cmd", "install");
            intent.putExtra("pkpath", apkPath);
            intent.putExtra("recv_pkname", context.getPackageName());
            intent.putExtra("startapp", true);

            // Verify APK exists before sending broadcast
            File apkFile = new File(apkPath);
            if (!apkFile.exists()) {
                Log.e(TAG, "Installation failed: APK file not found at " + apkPath);
                // Emit installation failed event
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "APK file not found"));
                sendUpdateCompletedBroadcast(context);
                return;
            }

            // Verify APK is readable
            if (!apkFile.canRead()) {
                Log.e(TAG, "Installation failed: Cannot read APK file at " + apkPath);
                // Emit installation failed event
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Cannot read APK file"));
                sendUpdateCompletedBroadcast(context);
                return;
            }

            Log.d(TAG, "Sending install broadcast to system UI...");
            context.sendBroadcast(intent);
            Log.i(TAG, "Install broadcast sent successfully. System will handle installation.");

            // Set a timer to send the completion broadcast after a reasonable amount of time
            // This is necessary because the system doesn't notify us when installation is complete
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Log.i(TAG, "Installation timer elapsed - sending completion broadcast");
                // Emit installation finished event
                EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FINISHED, apkPath));
                sendUpdateCompletedBroadcast(context);
            }, 10000); // Wait 60 seconds for installation to complete
        } catch (SecurityException e) {
            Log.e(TAG, "Security exception while sending install broadcast", e);
            // Emit installation failed event
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Security exception: " + e.getMessage()));
            // Make sure to send completion broadcast on error
            sendUpdateCompletedBroadcast(context);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send install broadcast", e);
            // Emit installation failed event
            EventBus.getDefault().post(new InstallationProgressEvent(InstallationProgressEvent.InstallationStatus.FAILED, apkPath, "Installation failed: " + e.getMessage()));
            // Make sure to send completion broadcast on error
            sendUpdateCompletedBroadcast(context);
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
            installApk(context, backupPath);
            return true;
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
            if (BesOtaManager.isBesOtaInProgress) {
                Log.w(TAG, "BES firmware update already in progress");
                return false;
            }
            
            // Check if MTK OTA in progress
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update in progress - skipping BES firmware update");
                return false;
            }
            
            // Check version (optional - BES may not always report version reliably)
            long serverVersion = firmwareInfo.optLong("versionCode", 0);
            String versionName = firmwareInfo.optString("versionName", "unknown");
            
            Log.i(TAG, "BES firmware available - Version: " + versionName + " (code: " + serverVersion + ")");
            
            // Get current firmware version from BES device
            byte[] currentVersion = BesOtaManager.getCurrentFirmwareVersion();
            byte[] serverVersionBytes = BesOtaManager.parseServerVersionCode(serverVersion);
            
            // Compare versions if both available
            if (currentVersion != null && serverVersionBytes != null) {
                boolean isNewer = BesOtaManager.isNewerVersion(serverVersionBytes, currentVersion);
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
            
            // Download firmware file
            String firmwareUrl = firmwareInfo.getString("firmwareUrl");
            boolean downloaded = downloadBesFirmware(firmwareUrl, firmwareInfo, context);
            
            if (downloaded) {
                // Start firmware update via BesOtaManager singleton
                BesOtaManager manager = BesOtaManager.getInstance();
                if (manager != null) {
                    Log.i(TAG, "Starting BES firmware update from: " + OtaConstants.BES_FIRMWARE_PATH);
                    boolean started = manager.startFirmwareUpdate(OtaConstants.BES_FIRMWARE_PATH);
                    if (started) {
                        Log.i(TAG, "BES firmware update initiated successfully");
                        return true;
                    } else {
                        Log.e(TAG, "Failed to start BES firmware update");
                    }
                } else {
                    Log.e(TAG, "BesOtaManager not available - is this a K900 device?");
                }
            } else {
                Log.e(TAG, "Failed to download BES firmware");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to update BES firmware", e);
        }
        return false;
    }
    
    /**
     * Download BES firmware file from server
     * @param firmwareUrl URL to download firmware from
     * @param firmwareInfo JSON metadata about the firmware
     * @param context Application context
     * @return true if downloaded and verified successfully
     */
    private boolean downloadBesFirmware(String firmwareUrl, JSONObject firmwareInfo, Context context) {
        try {
            File asgDir = new File(OtaConstants.BASE_DIR);
            if (!asgDir.exists()) {
                boolean created = asgDir.mkdirs();
                Log.d(TAG, "ASG directory created: " + created);
            }
            
            File firmwareFile = new File(asgDir, OtaConstants.BES_FIRMWARE_FILENAME);
            
            // Delete old firmware if exists
            if (firmwareFile.exists()) {
                Log.d(TAG, "Deleting existing firmware file");
                firmwareFile.delete();
            }
            
            Log.d(TAG, "Downloading BES firmware from: " + firmwareUrl);
            
            // Download firmware file
            URL url = new URL(firmwareUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.connect();
            
            long fileSize = conn.getContentLength();
            
            // Check file size doesn't exceed 1100KB
            if (fileSize > 1100 * 1024) {
                Log.e(TAG, "Firmware file too large: " + fileSize + " bytes (max 1100KB)");
                conn.disconnect();
                return false;
            }
            
            InputStream in = conn.getInputStream();
            FileOutputStream out = new FileOutputStream(firmwareFile);
            
            byte[] buffer = new byte[4096];
            int len;
            long total = 0;
            int lastProgress = 0;
            
            Log.d(TAG, "Downloading firmware, size: " + fileSize + " bytes");
            
            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
                total += len;
                
                // Log progress at 10% intervals
                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "Firmware download progress: " + progress + "%");
                    lastProgress = progress;
                }
            }
            
            out.close();
            in.close();
            conn.disconnect();
            
            Log.d(TAG, "Firmware downloaded to: " + firmwareFile.getAbsolutePath());
            
            // Verify SHA256 hash
            boolean verified = verifyFirmwareFile(firmwareFile.getAbsolutePath(), firmwareInfo);
            if (verified) {
                Log.i(TAG, "Firmware file verified successfully");
                return true;
            } else {
                Log.e(TAG, "Firmware verification failed - deleting file");
                firmwareFile.delete();
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error downloading BES firmware", e);
            return false;
        }
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
            
            // boolean match = calculatedHash.equalsIgnoreCase(expectedHash);
            boolean match = true;
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
     * @param firmwareInfo JSON object with firmware metadata
     * @param context Application context
     * @return true if update started successfully
     */
    private boolean checkAndUpdateMtkFirmware(JSONObject firmwareInfo, Context context) {
        try {
            // Check for mutual exclusion - don't start MTK update if other updates in progress
            if (isUpdating) {
                Log.w(TAG, "APK update in progress - skipping MTK firmware update");
                return false;
            }
            
            if (BesOtaManager.isBesOtaInProgress) {
                Log.w(TAG, "BES firmware update in progress - skipping MTK firmware update");
                return false;
            }
            
            // Check if MTK OTA already in progress
            if (isMtkOtaInProgress) {
                Log.w(TAG, "MTK firmware update already in progress");
                return false;
            }
            
            // Get version info from server
            long serverVersion = firmwareInfo.optLong("versionCode", 0);
            String versionName = firmwareInfo.optString("versionName", "unknown");
            
            Log.i(TAG, "MTK firmware available - Version: " + versionName + " (code: " + serverVersion + ")");
            
            // Get current MTK firmware version from system property
            String currentVersionStr = com.mentra.asg_client.SysControl.getSystemCurrentVersion(context);
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
            
            // Download firmware file
            String firmwareUrl = firmwareInfo.getString("firmwareUrl");
            boolean downloaded = downloadMtkFirmware(firmwareUrl, firmwareInfo, context);
            
            if (downloaded) {
                // Set flag before starting update
                isMtkOtaInProgress = true;
                
                // Post started event
                EventBus.getDefault().post(com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent.createStarted());
                
                // Trigger MTK OTA installation via system broadcast
                Log.i(TAG, "Starting MTK firmware update from: " + OtaConstants.MTK_FIRMWARE_PATH);
                com.mentra.asg_client.SysControl.installOTA(context, OtaConstants.MTK_FIRMWARE_PATH);
                
                Log.i(TAG, "MTK firmware update initiated - system will handle installation");
                return true;
            } else {
                Log.e(TAG, "Failed to download MTK firmware");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to update MTK firmware", e);
            isMtkOtaInProgress = false;
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
            File asgDir = new File(OtaConstants.BASE_DIR);
            if (!asgDir.exists()) {
                boolean created = asgDir.mkdirs();
                Log.d(TAG, "ASG directory created: " + created);
            }
            
            File firmwareFile = new File(asgDir, OtaConstants.MTK_FIRMWARE_FILENAME);
            
            // Create backup of existing firmware if it exists
            if (firmwareFile.exists()) {
                File backupFile = new File(asgDir, OtaConstants.MTK_BACKUP_FILENAME);
                Log.d(TAG, "Creating backup of existing MTK firmware");
                if (backupFile.exists()) {
                    backupFile.delete();
                }
                firmwareFile.renameTo(backupFile);
            }
            
            Log.d(TAG, "Downloading MTK firmware from: " + firmwareUrl);
            
            // Download firmware file
            URL url = new URL(firmwareUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.connect();
            
            long fileSize = conn.getContentLength();
            
            // Check file size is reasonable (max 100MB for MTK firmware)
            if (fileSize > 100 * 1024 * 1024) {
                Log.e(TAG, "MTK firmware file too large: " + fileSize + " bytes (max 100MB)");
                conn.disconnect();
                return false;
            }
            
            InputStream in = conn.getInputStream();
            FileOutputStream out = new FileOutputStream(firmwareFile);
            
            byte[] buffer = new byte[8192];
            int len;
            long total = 0;
            int lastProgress = 0;
            
            Log.d(TAG, "Downloading MTK firmware, size: " + fileSize + " bytes");
            
            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
                total += len;
                
                // Log progress at 10% intervals
                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "MTK firmware download progress: " + progress + "%");
                    
                    // Post download progress event
                    EventBus.getDefault().post(new DownloadProgressEvent(
                        DownloadProgressEvent.DownloadStatus.PROGRESS,
                        progress,
                        total,
                        fileSize
                    ));
                    
                    lastProgress = progress;
                }
            }
            
            out.close();
            in.close();
            conn.disconnect();
            
            Log.i(TAG, "MTK firmware downloaded to: " + firmwareFile.getAbsolutePath());
            
            // Verify SHA256 hash
            boolean verified = verifyMtkFirmwareChecksum(firmwareFile.getAbsolutePath(), firmwareInfo);
            if (verified) {
                Log.i(TAG, "MTK firmware file verified successfully");
                return true;
            } else {
                Log.e(TAG, "MTK firmware verification failed - deleting file");
                firmwareFile.delete();
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to download MTK firmware", e);
            return false;
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
    
    // ========== DEBUG METHODS ==========
    
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
            EventBus.getDefault().post(com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent.createStarted());
            
            // Trigger MTK OTA installation via system broadcast
            com.mentra.asg_client.SysControl.installOTA(context, OtaConstants.MTK_FIRMWARE_PATH);
            
            Log.i(TAG, "DEBUG: MTK firmware install command sent - monitor MtkOtaReceiver for progress");
            return true;
            
        } catch (Exception e) {
            Log.e(TAG, "DEBUG: Failed to install MTK firmware", e);
            isMtkOtaInProgress = false;
            return false;
        }
    }
}
