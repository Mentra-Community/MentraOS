package com.mentra.otaupdater.helper;

import static com.mentra.otaupdater.helper.Constants.APK_FILENAME;
import static com.mentra.otaupdater.helper.Constants.BASE_DIR;
import static com.mentra.otaupdater.helper.Constants.METADATA_JSON;

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
import com.mentra.otaupdater.events.BatteryStatusEvent;
import com.mentra.otaupdater.events.DownloadProgressEvent;
import com.mentra.otaupdater.events.InstallationProgressEvent;

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

public class OtaHelper {
    private static final String TAG = Constants.TAG;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static ConnectivityManager connectivityManager;
    private static volatile boolean isCheckingVersion = false;
    private static final Object versionCheckLock = new Object();
    private Handler handler;
    private Context context;
    private Runnable periodicCheckRunnable;
    private boolean isPeriodicCheckActive = false;
    
    // Retry logic constants
    private static final int MAX_DOWNLOAD_RETRIES = 3;
    private static final long[] RETRY_DELAYS = {30000, 60000, 120000}; // 30s, 1m, 2m

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
                handler.postDelayed(this, Constants.PERIODIC_CHECK_INTERVAL_MS);
            }
        };

        // Start the first periodic check after the interval
        handler.postDelayed(periodicCheckRunnable, Constants.PERIODIC_CHECK_INTERVAL_MS);
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

        if (!isNetworkAvailable(context)) {
            Log.e(TAG, "No WiFi connection available. Skipping OTA check.");
            return;
        }
        
        // Check battery status before proceeding with OTA update
        if (!isBatterySufficientForUpdates()) {
            Log.w(TAG, "🚨 Battery insufficient for OTA updates - skipping version check");
            return;
        }

        // Check if version check is already in progress
        if (isCheckingVersion) {
            Log.d(TAG, "Version check already in progress, skipping this request");
            return;
        }

        new Thread(() -> {
            // Use synchronized block to ensure thread safety
            synchronized (versionCheckLock) {
                if (isCheckingVersion) {
                    Log.d(TAG, "Another thread started version check, skipping");
                    return;
                }
                isCheckingVersion = true;
            }

            try {
                // Fetch version info
                String versionInfo = fetchVersionInfo(Constants.VERSION_JSON_URL);
                JSONObject json = new JSONObject(versionInfo);
                
                // Check if new format (multiple apps) or legacy format
                if (json.has("apps")) {
                    // New format - process sequentially
                    processAppsSequentially(json.getJSONObject("apps"), context);
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
    
    private void processAppsSequentially(JSONObject apps, Context context) throws Exception {
        // Process apps in order - important for sequential updates
        String[] orderedPackages = {
            "com.mentra.asg_client",     // Update ASG client first
            // "com.augmentos.otaupdater"      // Then OTA updater
        };
        
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
        
        Log.d(TAG, "Sequential app updates completed");
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
            long currentVersion = getInstalledVersion(packageName, context);
            long serverVersion = appInfo.getLong("versionCode");
            String apkUrl = appInfo.getString("apkUrl");
            
            Log.d(TAG, "Checking " + packageName + " - current: " + currentVersion + ", server: " + serverVersion);
            
            if (serverVersion > currentVersion) {
                // Delete old APK if exists
                String filename = packageName.equals(context.getPackageName()) 
                    ? "ota_updater_update.apk" 
                    : "asg_client_update.apk";
                File apkFile = new File(BASE_DIR, filename);
                
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
            
            File backupFile = new File(BASE_DIR, "asg_client_backup.apk");
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
                File partialFile = new File(BASE_DIR, filename);
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
        File asgDir = new File(BASE_DIR);

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
            File jsonFile = new File(BASE_DIR, METADATA_JSON);
            FileWriter writer = new FileWriter(jsonFile);
            writer.write(json.toString(2)); // Pretty print
            writer.close();
            Log.d(TAG, "metadata.json saved at: " + jsonFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to write metadata.json", e);
        }
    }

    public void installApk(Context context) {
        installApk(context, Constants.APK_FULL_PATH);
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

            // First send a broadcast to pause heartbeats during installation
            Intent pauseHeartbeatIntent = new Intent(Constants.ACTION_INSTALL_OTA);
            pauseHeartbeatIntent.setPackage(context.getPackageName());
            context.sendBroadcast(pauseHeartbeatIntent);
            Log.i(TAG, "Sent broadcast to pause heartbeats during installation");

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
        String apkFile = BASE_DIR + "/" + APK_FILENAME;
        String metaFile = BASE_DIR + "/" + METADATA_JSON ;
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
        File metaDataJson = new File(BASE_DIR, METADATA_JSON);
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
        String backupPath = Constants.BACKUP_APK_PATH;
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
            File backupDir = new File(context.getFilesDir(), BASE_DIR);
            if (!backupDir.exists()) {
                boolean created = backupDir.mkdirs();
                Log.d(TAG, "Created backup directory: " + created);
            }

            File backupApk = new File(backupDir, Constants.BACKUP_APK_FILENAME);
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
            // Send a preparatory broadcast to reset the heartbeat system
            Intent resetIntent = new Intent(Constants.ACTION_INSTALL_OTA);
            resetIntent.setPackage(context.getPackageName());
            context.sendBroadcast(resetIntent);

            // Short delay to allow the system to process the reset
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    // Now send the completion broadcast
                    Intent completeIntent = new Intent(Constants.ACTION_UPDATE_COMPLETED);
                    completeIntent.setPackage(context.getPackageName());
                    context.sendBroadcast(completeIntent);
                    Log.i(TAG, "Sent update completion broadcast");
                } catch (Exception e) {
                    Log.e(TAG, "Failed to send delayed update completion broadcast", e);
                }
            }, 1000); // 1 second delay between reset and completion
        } catch (Exception e) {
            Log.e(TAG, "Failed to send update reset broadcast", e);
            // Fallback direct completion broadcast
            try {
                Intent completeIntent = new Intent(Constants.ACTION_UPDATE_COMPLETED);
                completeIntent.setPackage(context.getPackageName());
                context.sendBroadcast(completeIntent);
                Log.i(TAG, "Sent fallback update completion broadcast");
            } catch (Exception ex) {
                Log.e(TAG, "Failed to send fallback update completion broadcast", ex);
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
}
