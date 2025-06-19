package com.augmentos.augmentos_core.tpa;

import static com.augmentos.augmentos_core.Constants.REQUEST_APP_BY_PACKAGE_NAME_DOWNLOAD_LINK_ENDPOINT;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import com.augmentos.augmentos_core.augmentos_backend.OldBackendServerComms;
import com.augmentos.augmentos_core.augmentos_backend.VolleyJsonCallback;
import com.augmentos.augmentos_core.comms.AugmentosBlePeripheral;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

public class ApkDownloadHelper {
    private static final String TAG = "ApkDownloadHelper";
    private Context mContext;
    OldBackendServerComms oldBackendServerComms;
    AugmentosBlePeripheral augmentosBlePeripheralRef;
    ApkDownloadHelper(Context context, AugmentosBlePeripheral augmentosBlePeripheralRef) {
        this.mContext = context;
        oldBackendServerComms = OldBackendServerComms.getInstance(context);
        this.augmentosBlePeripheralRef = augmentosBlePeripheralRef;
    }

    public void installAppFromRepository(String repository, String packageName) throws JSONException {
        Log.d("AugmentOsService", "Installing app from repository: " + packageName);

        JSONObject jsonQuery = new JSONObject();
        jsonQuery.put("packageName", packageName);

        oldBackendServerComms.restRequest(REQUEST_APP_BY_PACKAGE_NAME_DOWNLOAD_LINK_ENDPOINT, jsonQuery, new VolleyJsonCallback() {
            @Override
            public void onSuccess(JSONObject result) {
                Log.d(TAG, "GOT INSTALL APP RESULT: " + result.toString());

                try {
                    String downloadLink = result.optString("download_url");
                    String appName = result.optString("app_name");
                    String version = result.optString("version");
                    if (!downloadLink.isEmpty()) {
                        Log.d(TAG, "Download link received: " + downloadLink);

                        if (downloadLink.startsWith("https://api.augmentos.org/")) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                downloadApk(downloadLink, packageName, appName, version);
                            }
                        } else {
                            Log.e(TAG, "The download link does not match the required domain.");
                            throw new UnsupportedOperationException("Download links outside of https://api.augmentos.org/ are not supported.");
                        }
                    } else {
                        Log.e(TAG, "Download link is missing in the response.");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error parsing download link: ", e);
                }
            }

            @Override
            public void onFailure(int code) {
                Log.d(TAG, "SOME FAILURE HAPPENED (installAppFromRepository)");
            }
        });
    }

    private void downloadApk(String downloadLink, String packageName, String appName, String version) { // TODO: Add fallback if the download doesn't succeed
        DownloadManager downloadManager = (DownloadManager) mContext.getSystemService(Context.DOWNLOAD_SERVICE);

        if (downloadManager != null) {
            Uri uri = Uri.parse(downloadLink);
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setTitle("Downloading " + appName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String downloadedAppName = appName.replace(" ", "") + "_" + version + ".apk";
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, downloadedAppName);

            long downloadId = downloadManager.enqueue(request);

            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id == downloadId) {
                        installApk(packageName, downloadedAppName);

                        context.unregisterReceiver(this);
                    }
                }
            };

            mContext.registerReceiver(receiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        }
    }

    private void installApk(String packageName, String downloadedAppName) {
        File apkFile = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                downloadedAppName
        );
        if (!apkFile.exists() || apkFile.length() == 0) {
            Log.e("Installer", "APK file is missing or 0 bytes.");
            return;
        }

        augmentosBlePeripheralRef.sendAppIsInstalledEventToManager(packageName);

        Log.d("Installer", "APK file exists: " + apkFile.getAbsolutePath());
    }
}
