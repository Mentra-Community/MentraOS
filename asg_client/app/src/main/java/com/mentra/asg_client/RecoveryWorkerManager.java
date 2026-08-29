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
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

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
    // Fallback when the bundled APK's version cannot be parsed. MUST track
    // recovery_worker/app/build.gradle versionCode (the asset is built from that project in
    // CI): if this lags, a device already on the previous worker skips the redeploy and every
    // pinned downgrade is refused by the MIN_RECOVERY_VERSION_FOR_DOWNGRADE gate.
    private static final int ASSETS_RECOVERY_VERSION = 10;
    private static final String PREFS = "RecoveryWorkerManagerPrefs";
    private static final String KEY_PURGED_LEGACY = "legacy_updater_purged";

    private final Context context;
    private final Handler handler;
    private final ExecutorService workerExecutor;
    private PackageInstallReceiver packageInstallReceiver;

    public RecoveryWorkerManager(Context context) {
        this.context = context.getApplicationContext();
        this.handler = new Handler(Looper.getMainLooper());
        this.workerExecutor = Executors.newSingleThreadExecutor();
    }

    public void initialize() {
        registerPackageInstallReceiver();
        workerExecutor.execute(this::ensureRecoveryWorker);
    }

    public void cleanup() {
        unregisterPackageInstallReceiver();
        handler.removeCallbacksAndMessages(null);
        workerExecutor.shutdownNow();
    }

    private void ensureRecoveryWorker() {
        try {
            purgeLegacyUpdaterIfNeeded();

            // Remote update is the highest-priority path: if the OTA manifest lists a newer
            // recovery worker, download and install it before anything else. This allows the
            // sidecar to be updated without shipping a new ASG build and without any user
            // approval (OEM silent install, same mechanism as the bundled-asset path).
            // On success PackageInstallReceiver will launch the worker after the install.
            // TODO: re-enable once a standalone recovery_worker APK is published to the manifest.
            // if (fetchAndApplyRemoteUpdate()) {
            //     return;
            // }

            int currentVersion = getInstalledVersion(RECOVERY_PACKAGE);
            if (!isRecoveryAssetBundled()) {
                if (currentVersion != -1) {
                    launchRecoveryWorker();
                } else {
                    Log.d(TAG, "No bundled recovery worker asset and none installed; skipping");
                }
                return;
            }
            int bundledVersion = getBundledRecoveryVersionCode();
            if (needsRecoveryRedeploy(currentVersion, bundledVersion)) {
                deployRecoveryWorkerFromAssets();
            } else {
                launchRecoveryWorker();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to ensure recovery worker", e);
            launchRecoveryWorker();
        }
    }

    /**
     * Fetches the OTA manifest and installs the recovery worker from the network if a newer
     * versionCode than what is installed is listed under {@code apps["com.mentra.recovery"]}.
     *
     * <p>The APK is always downloaded fresh and SHA-256 verified before the OEM install broadcast
     * is sent, so no stale-file risk exists. Returns {@code true} when an install was dispatched;
     * the caller should exit — {@link PackageInstallReceiver} will launch the sidecar after the
     * install completes. Returns {@code false} on any failure so the caller falls back to the
     * bundled-asset path.
     */
    private boolean fetchAndApplyRemoteUpdate() {
        int installedVersion = getInstalledVersion(RECOVERY_PACKAGE);
        try {
            JSONObject manifest = fetchManifest();
            if (manifest == null) return false;

            JSONObject apps = manifest.optJSONObject("apps");
            if (apps == null || !apps.has(OtaConstants.RECOVERY_PACKAGE)) return false;

            JSONObject info = apps.getJSONObject(OtaConstants.RECOVERY_PACKAGE);
            int remoteVersionCode = info.optInt("versionCode", -1);
            String apkUrl = info.optString("apkUrl", "");
            String sha256 = info.optString("sha256", "");

            if (remoteVersionCode <= 0 || apkUrl.isEmpty() || sha256.isEmpty()) {
                Log.d(TAG, "Remote recovery worker manifest entry incomplete; skipping");
                return false;
            }
            if (remoteVersionCode <= installedVersion) {
                Log.d(TAG, "Recovery worker up to date (installed=" + installedVersion
                        + ", remote=" + remoteVersionCode + ")");
                return false;
            }

            Log.i(TAG, "Remote recovery worker v" + remoteVersionCode
                    + " > installed v" + installedVersion + "; downloading");

            File updateApk = new File(OtaConstants.RECOVERY_WORKER_UPDATE_APK_PATH);
            deleteQuietly(updateApk);

            File parentDir = updateApk.getParentFile();
            if (parentDir != null && !parentDir.exists()) parentDir.mkdirs();

            if (!downloadToFile(apkUrl, updateApk)) {
                deleteQuietly(updateApk);
                return false;
            }
            if (!verifySha256(updateApk, sha256)) {
                Log.e(TAG, "Recovery worker APK SHA-256 mismatch; aborting update");
                deleteQuietly(updateApk);
                return false;
            }

            Intent install = new Intent("com.xy.xsetting.action");
            install.setPackage("com.android.systemui");
            install.putExtra("cmd", "install");
            install.putExtra("pkpath", updateApk.getAbsolutePath());
            context.sendBroadcast(install);
            Log.i(TAG, "Remote recovery worker v" + remoteVersionCode + " install dispatched");
            return true;

        } catch (Exception e) {
            Log.e(TAG, "Remote recovery worker update check failed", e);
            return false;
        }
    }

    private JSONObject fetchManifest() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(OtaConstants.RESCUE_FLEET_MANIFEST_URL).openConnection();
            conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.connect();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.e(TAG, "Manifest fetch HTTP " + code);
                return null;
            }
            StringBuilder body = new StringBuilder();
            try (InputStream is = conn.getInputStream();
                    BufferedReader reader =
                            new BufferedReader(
                                    new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            return new JSONObject(body.toString());
        } catch (Exception e) {
            Log.e(TAG, "Failed to fetch OTA manifest for recovery worker check", e);
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private boolean downloadToFile(String apkUrl, File target) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(apkUrl).openConnection();
            conn.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.connect();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.e(TAG, "Recovery worker APK download HTTP " + code);
                return false;
            }
            try (InputStream is = conn.getInputStream();
                    FileOutputStream fos = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = is.read(buffer)) != -1) fos.write(buffer, 0, read);
                fos.flush();
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to download recovery worker APK", e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private boolean verifySha256(File file, String expectedHex) {
        if (expectedHex == null || expectedHex.isEmpty()) {
            Log.e(TAG, "No SHA-256 provided for recovery worker APK — rejecting");
            return false;
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            try (FileInputStream is = new FileInputStream(file)) {
                while ((read = is.read(buffer)) > 0) digest.update(buffer, 0, read);
            }
            byte[] hashBytes = digest.digest();
            StringBuilder sb = new StringBuilder(hashBytes.length * 2);
            for (byte b : hashBytes) sb.append(String.format("%02x", b));
            boolean match = sb.toString().equalsIgnoreCase(expectedHex);
            Log.d(TAG, "Recovery worker SHA-256 " + (match ? "verified" : "MISMATCH"));
            return match;
        } catch (Exception e) {
            Log.e(TAG, "Recovery worker SHA-256 check error", e);
            return false;
        }
    }

    private void deleteQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "Could not delete " + file.getAbsolutePath());
        }
    }

    private boolean isRecoveryAssetBundled() {
        try {
            String[] assets = context.getAssets().list("");
            if (assets == null) return false;
            for (String asset : assets) {
                if (RECOVERY_APK_ASSET_NAME.equals(asset)) return true;
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private void purgeLegacyUpdaterIfNeeded() {
        if (context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_PURGED_LEGACY, false)) {
            return;
        }
        try {
            context.getPackageManager().getPackageInfo(LEGACY_UPDATER_PACKAGE, 0);
        } catch (PackageManager.NameNotFoundException e) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_PURGED_LEGACY, true)
                    .apply();
            return;
        } catch (Exception e) {
            Log.w(TAG, "Could not verify legacy updater package visibility; will retry", e);
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
        if (!isRecoveryAssetBundled()) {
            Log.d(TAG, "No bundled recovery worker asset; skipping deploy");
            return;
        }
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
            handler.postDelayed(() -> workerExecutor.execute(this::launchRecoveryWorker), 15000);
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
        if (!isRecoveryAssetBundled()) {
            Log.d(TAG, "Recovery worker not installed and no bundled asset; nothing to do");
            return;
        }
        int installedVersion = getInstalledVersion(RECOVERY_PACKAGE);
        int bundledVersion = getBundledRecoveryVersionCode();
        if (!needsRecoveryRedeploy(installedVersion, bundledVersion)) {
            Log.w(
                    TAG,
                    "Recovery worker missing start surface but installed v"
                            + installedVersion
                            + " is not older than bundled v"
                            + bundledVersion
                            + "; skipping downgrade redeploy");
            return;
        }
        Log.w(TAG, "Recovery worker missing start surface; redeploying from assets");
        deployRecoveryWorkerFromAssets();
    }

    private boolean needsRecoveryRedeploy(int installedVersion, int bundledVersion) {
        if (installedVersion == -1) {
            return true;
        }
        if (bundledVersion > 0 && installedVersion < bundledVersion) {
            return true;
        }
        return installedVersion < ASSETS_RECOVERY_VERSION;
    }

    private int getBundledRecoveryVersionCode() {
        File probeApk = new File(context.getCacheDir(), "recovery_worker_probe.apk");
        try (InputStream assetStream = context.getAssets().open(RECOVERY_APK_ASSET_NAME);
                FileOutputStream fos = new FileOutputStream(probeApk)) {
            byte[] buffer = new byte[8192];
            int bytesRead;
            while ((bytesRead = assetStream.read(buffer)) != -1) {
                fos.write(buffer, 0, bytesRead);
            }
        } catch (java.io.FileNotFoundException e) {
            Log.d(TAG, "No bundled recovery worker asset; skipping version read");
            return -1;
        } catch (Exception e) {
            Log.w(TAG, "Failed to read bundled recovery worker version", e);
            return -1;
        }

        try {
            PackageInfo archiveInfo =
                    context.getPackageManager()
                            .getPackageArchiveInfo(probeApk.getAbsolutePath(), 0);
            if (archiveInfo == null) {
                Log.w(TAG, "Failed to parse bundled recovery worker APK");
                return -1;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return (int) archiveInfo.getLongVersionCode();
            }
            return archiveInfo.versionCode;
        } finally {
            if (probeApk.exists() && !probeApk.delete()) {
                Log.w(TAG, "Failed to delete recovery worker probe APK");
            }
        }
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
        if (getInstalledVersion(RECOVERY_PACKAGE) == -1) {
            return false;
        }
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
                handler.postDelayed(
                        () -> workerExecutor.execute(RecoveryWorkerManager.this::launchRecoveryWorker),
                        2000);
            }
        }
    }
}
