package com.augmentos.augmentos;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;  // Required for Cursor
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

import androidx.core.content.FileProvider;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;

public class InstallApkModule extends ReactContextBaseJavaModule {
    private static final String REACT_CLASS = "InstallApkModule";

    public InstallApkModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return REACT_CLASS; // This is the name used in JS: NativeModules.InstallApkModule
    }

    // This method currently opens the Downloads folder.
    @ReactMethod
    public void installApk(String packageName, Promise promise) {
        try {
            Log.d(REACT_CLASS, "Requested to open the Downloads folder");
            Intent intent = new Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve("Downloads folder opened successfully");
        } catch (Exception e) {
            Log.e(REACT_CLASS, "Error opening Downloads folder: ", e);
            promise.reject("OPEN_DOWNLOADS_ERROR", e);
        }
    }

    @ReactMethod
    public void downloadCoreApk(Promise promise) {
        DownloadManager downloadManager = (DownloadManager) getReactApplicationContext().getSystemService(Context.DOWNLOAD_SERVICE);
        String downloadLink = "https://cloud.augmentos.org/AugmentOS.apk";
        String packageName = "com.augmentos.augmentos_core";
        String appName = "AugmentOS Core";
        String version = "latest";

        if (downloadManager == null) {
            promise.reject("DOWNLOAD_ERROR", "Download manager is not available");
            return;
        }

        try {
            Uri uri = Uri.parse(downloadLink);
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle("Downloading " + appName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

            // Generate unique filename with timestamp
            SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault());
            String timestamp = sdf.format(new Date());
            String downloadedAppName = appName.replace(" ", "") + "_" + version + "_" + timestamp + ".apk";

            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, downloadedAppName);

            long downloadId = downloadManager.enqueue(request);

            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id == downloadId) {
                        DownloadManager.Query query = new DownloadManager.Query();
                        query.setFilterById(downloadId);
                        Cursor cursor = downloadManager.query(query);

                        if (cursor.moveToFirst()) {
                            int status = cursor.getInt(cursor.getColumnIndex(DownloadManager.COLUMN_STATUS));
                            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                                // Now call the helper method with three parameters.
                                installDownloadedApk(packageName, downloadedAppName, promise);
                            } else {
                                promise.reject("DOWNLOAD_FAILED", "Download failed with status: " + status);
                            }
                        } else {
                            promise.reject("DOWNLOAD_ERROR", "Could not query download status");
                        }
                        cursor.close();
                        getReactApplicationContext().unregisterReceiver(this);
                    }
                }
            };

            getReactApplicationContext().registerReceiver(receiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        } catch (Exception e) {
            promise.reject("DOWNLOAD_ERROR", "Error starting download: " + e.getMessage());
        }
    }

    // Helper method to install the downloaded APK.
    // The signature is updated to accept a Promise so we can notify the JS side.
    private void installDownloadedApk(String packageName, String downloadedFileName, Promise promise) {
        try {
            File apkFile = new File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                    downloadedFileName
            );
            Log.d(REACT_CLASS, "APK file path: " + apkFile.getAbsolutePath());
            if (!apkFile.exists() || apkFile.length() == 0) {
                Log.e(REACT_CLASS, "APK file is missing or 0 bytes: " + apkFile.getAbsolutePath());
                promise.reject("APK_FILE_ERROR", "APK file is missing or 0 bytes.");
                return;
            }

            Uri apkUri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                apkUri = FileProvider.getUriForFile(
                        getReactApplicationContext(),
                        getReactApplicationContext().getPackageName() + ".provider",
                        apkFile
                );
            } else {
                apkUri = Uri.fromFile(apkFile);
            }

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
            promise.resolve("APK installation intent started successfully");
        } catch (Exception e) {
            Log.e(REACT_CLASS, "Error installing downloaded APK: ", e);
            promise.reject("INSTALL_ERROR", e);
        }
    }
}
