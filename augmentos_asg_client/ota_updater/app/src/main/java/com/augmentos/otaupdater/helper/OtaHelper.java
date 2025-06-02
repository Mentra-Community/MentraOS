package com.augmentos.otaupdater.helper;

import static com.augmentos.otaupdater.helper.Constants.APK_FILENAME;
import static com.augmentos.otaupdater.helper.Constants.METADATA_JSON;
import static com.augmentos.otaupdater.helper.Constants.OTA_FOLDER;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.util.Log;
import android.content.Intent;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
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
    public void startVersionCheck(Context context) {
        Log.d(TAG, "Check OTA update method init");

        new Thread(() -> {
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

                long metaDataVer = getMetadataVersion();

                // Check if APK exists and is older than 3 hours
                File apkFile = new File(Constants.APK_FULL_PATH);
                if (apkFile.exists()) {
                    long lastModified = apkFile.lastModified();
                    long now = System.currentTimeMillis();
                    long ageMs = now - lastModified;
                    long threeHoursMs = 3 * 60 * 60 * 1000L;
                    if (ageMs > threeHoursMs) {
                        Log.d(TAG, "Existing APK is older than 3 hours. Deleting and forcing new download.");
                        boolean deleted = apkFile.delete();
                        Log.d(TAG, "Old APK deleted: " + deleted);
                    }
                }

                if (serverVersion > currentVersion && metaDataVer < serverVersion) {
                    Log.d(TAG, "new version found.");
                    downloadApk(apkUrl, json, context);
                } else {
                    if(serverVersion <= currentVersion){
                        Log.d(TAG, "Already up to date.");
                    }else{
                        Log.d(TAG, "APK file is ready waiting for the installation command.");
                    }
                }
                Log.d(TAG, "Ver server: " + serverVersion + "\ncurrentVer:"+currentVersion);

            } catch (Exception e) {
                Log.e(TAG, "Exception during OTA check", e);
            }
        }).start();
    }

    public void downloadApk(String urlStr, JSONObject json, Context context) {
        try {
            File asgDir = new File(OTA_FOLDER);

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
            while ((len = in.read(buffer)) > 0) out.write(buffer, 0, len);

            out.close();
            in.close();

            Log.d(TAG, "APK downloaded to: " + apkFile.getAbsolutePath());
            // Immediately check hash after download
            boolean hashOk = verifyApkFile(apkFile.getAbsolutePath(), json);
            if(hashOk){
                createMetaDataJson(json, context);
            }else{
                Log.e(TAG, "Downloaded APK hash does not match expected value! Deleting APK.");
                if (apkFile.exists()) {
                    boolean deleted = apkFile.delete();
                    Log.d(TAG, "SHA256 mismatch – APK deleted: " + deleted);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "OTA failed", e);
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
            File jsonFile = new File(OTA_FOLDER, METADATA_JSON);
            FileWriter writer = new FileWriter(jsonFile);
            writer.write(json.toString(2)); // Pretty print
            writer.close();
            Log.d(TAG, "metadata.json saved at: " + jsonFile.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Failed to write metadata.json", e);
        }
    }
    public void installApk(Context context){
        checkOlderApkFile(context);
        Log.d(TAG, "start Installation process, sending install broadcast...");
        Intent intent = new Intent("com.xy.xsetting.action");
        intent.setPackage("com.android.systemui");
        intent.putExtra("cmd", "install");
        intent.putExtra("pkpath", Constants.APK_FULL_PATH); // path to APK
        intent.putExtra("recv_pkname", context.getPackageName()); // target package name
        intent.putExtra("startapp", true); // auto-start after install
        context.sendBroadcast(intent);
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

    private void deleteOldFiles(){
        String apkFile = OTA_FOLDER + "/" + APK_FILENAME;
        String metaFile = OTA_FOLDER + "/" + METADATA_JSON ;
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

    private int getMetadataVersion(){
        int localJsonVersion = 0;
        File metaDataJson = new File(OTA_FOLDER, METADATA_JSON);
        if(metaDataJson.exists()){
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

}
