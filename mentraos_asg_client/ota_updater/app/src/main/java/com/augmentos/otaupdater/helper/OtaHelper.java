package com.augmentos.otaupdater.helper;

import static com.augmentos.otaupdater.helper.Constants.APK_FILENAME;
import static com.augmentos.otaupdater.helper.Constants.BASE_DIR;
import static com.augmentos.otaupdater.helper.Constants.METADATA_JSON;

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

    public OtaHelper(Context context) {
        this.context = context.getApplicationContext(); // Use application context to avoid memory leaks
        handler = new Handler(Looper.getMainLooper());
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
                // 1. Get installed asg_client version
                long currentVersion;
                try {
                    PackageManager pm = context.getPackageManager();
                    PackageInfo info = pm.getPackageInfo("com.augmentos.asg_client", 0);
                    currentVersion = info.getLongVersionCode();
                } catch (PackageManager.NameNotFoundException e) {
                    Log.e(TAG, "Package not found");
                    currentVersion = 0;
                }

                Log.d(TAG, "Installed version: " + currentVersion);

                // 2. Fetch server version from JSON
                JSONObject json = new JSONObject(new BufferedReader(
                        new InputStreamReader(new URL(Constants.VERSION_JSON_URL).openStream())
                ).lines().collect(Collectors.joining("\n")));
                int serverVersion = json.getInt("versionCode");
                String apkUrl = json.getString("apkUrl");

//                long metaDataVer = getMetadataVersion();

                // Check if APK exists and is older than 3 hours
                File apkFile = new File(Constants.APK_FULL_PATH);
                if (apkFile.exists()) {
                    Log.d(TAG, "Existing APK found. Deleting and forcing new download.");
                    boolean deleted = apkFile.delete();
                    Log.d(TAG, "Old APK deleted: " + deleted);
                }

                Log.d(TAG, "Ver server: " + serverVersion + "\ncurrentVer: " + currentVersion);
//                Log.d(TAG, "Metadata version: " + metaDataVer);

                if (serverVersion > currentVersion) {
                    Log.d(TAG, "new version found.");
                    boolean downloadOk = downloadApk(apkUrl, json, context);
                    if (downloadOk) {
                        installApk(context);
                    }
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

    public boolean downloadApk(String urlStr, JSONObject json, Context context) {
        try {
            File asgDir = new File(BASE_DIR);

            if (asgDir.exists()) {
                File targetApk = new File(Constants.APK_FULL_PATH);
                if (targetApk.exists()) {
                    boolean deleted = targetApk.delete();
                    Log.d(TAG, "Deleted existing update.apk: " + deleted);
                }
            } else {
                boolean created = asgDir.mkdirs();
                Log.d(TAG, "ASG directory created: " + created);
            }

            File apkFile = new File(Constants.APK_FULL_PATH);

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

            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
                total += len;

                // Calculate progress percentage
                int progress = fileSize > 0 ? (int) (total * 100 / fileSize) : 0;

                // Log progress at 10% intervals
                if (progress >= lastProgress + 10 || progress == 100) {
                    Log.d(TAG, "Download progress: " + progress + "% (" + total + "/" + fileSize + " bytes)");
                    lastProgress = progress;
                }
            }

            out.close();
            in.close();

            Log.d(TAG, "APK downloaded to: " + apkFile.getAbsolutePath());
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
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "OTA failed", e);
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
            PackageInfo info = pm.getPackageInfo("com.augmentos.asg_client", 0);
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
                sendUpdateCompletedBroadcast(context);
                return;
            }

            // Verify APK is readable
            if (!apkFile.canRead()) {
                Log.e(TAG, "Installation failed: Cannot read APK file at " + apkPath);
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
                sendUpdateCompletedBroadcast(context);
            }, 10000); // Wait 60 seconds for installation to complete
        } catch (SecurityException e) {
            Log.e(TAG, "Security exception while sending install broadcast", e);
            // Make sure to send completion broadcast on error
            sendUpdateCompletedBroadcast(context);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send install broadcast", e);
            // Make sure to send completion broadcast on error
            sendUpdateCompletedBroadcast(context);
        }
    }

    public void checkOlderApkFile(Context context) {
        PackageManager pm = context.getPackageManager();
        PackageInfo info = null;
        try {
            info = pm.getPackageInfo("com.augmentos.asg_client", 0);
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
}
