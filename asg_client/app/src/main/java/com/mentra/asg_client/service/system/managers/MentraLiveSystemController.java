package com.mentra.asg_client.service.system.managers;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import com.mentra.asg_client.service.utils.SysProp;

/** Mentra Live system control via com.xy.xsetting.action broadcasts to forked SystemUI. */
public class MentraLiveSystemController implements ISystemController {

    private static final String TAG = "MentraLiveSystemController";
    private static final String VERSION_CUSTOM = "ro.custom.ota.version";

    private final Context context;

    public MentraLiveSystemController(Context context) {
        this.context = context;
    }

    @Override
    public void reboot() {
        Intent nn = new Intent();
        nn.putExtra("cmd", "reboot");
        sendBroadcast(nn);
    }

    @Override
    public void shutdown() {
        Log.i(TAG, "Initiating device shutdown");
        Intent nn = new Intent();
        nn.putExtra("cmd", "shutdown");
        sendBroadcast(nn);
    }

    @Override
    public void setSystemTime(long timeMillis) {
        Log.i(TAG, "Setting system time: " + timeMillis);
        Intent nn = new Intent();
        nn.putExtra("cmd", "settime");
        nn.putExtra("timemills", timeMillis);
        sendBroadcast(nn);
    }

    @Override
    public void setEisEnabled(boolean enable) {
        Log.i(
                TAG,
                "EIS stage=vendor-property enable="
                        + enable
                        + " pixsmart.vs="
                        + (enable ? "1" : "0")
                        + " morpho.videoeis.mode="
                        + (enable ? "1" : "0"));
        Intent pixsmart = new Intent();
        pixsmart.putExtra("cmd", "setProperty");
        pixsmart.putExtra("name", "vendor.debug.pixsmart.vs");
        pixsmart.putExtra("value", enable ? "1" : "0");
        sendBroadcast(pixsmart);
        Intent morpho = new Intent();
        morpho.putExtra("cmd", "setProperty");
        morpho.putExtra("name", "vendor.debug.morpho.videoeis.mode");
        morpho.putExtra("value", enable ? "1" : "0");
        sendBroadcast(morpho);
    }

    @Override
    public void setCameraTuningConfig(boolean anrOn, boolean gainOn) {
        Log.d(TAG, "setCameraTuningConfig: anr=" + anrOn + ", gain=" + gainOn);
        Intent nn = new Intent();
        nn.putExtra("cmd", "camconfig");
        nn.putExtra("anr", anrOn);
        nn.putExtra("gain", gainOn);
        sendBroadcast(nn);
    }

    @Override
    public void restartCameraHal() {
        Log.d(TAG, "Restarting camera HAL (ctl.restart / camerahalserver)");
        Intent nn = new Intent();
        nn.putExtra("cmd", "setProperty");
        nn.putExtra("name", "ctl.restart");
        nn.putExtra("value", "camerahalserver");
        sendBroadcast(nn);
    }

    @Override
    public String getSystemOtaVersion() {
        String ver = "";
        try {
            ver = SysProp.get(context, VERSION_CUSTOM);
        } catch (Exception e) {
            Log.w(TAG, "Error reading system OTA version property", e);
        }
        if (ver == null || ver.length() < 8) {
            // Report unknown honestly instead of the bare-date sentinel K900 vendor code
            // used ("20241130") - the phone treats an empty version as "no MTK update".
            Log.w(TAG, "System OTA version unavailable (property missing or malformed: '" + ver + "')");
            return "";
        }
        return ver;
    }

    @Override
    public void setHotspot5GEnabled(boolean enable) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "hotspot_wifi5g");
        nn.putExtra("value", enable ? 1 : 0);
        sendBroadcast(nn);
    }

    @Override
    public void setWifiAdb(boolean enable) {
        Log.d(TAG, "Setting Wi-Fi ADB to: " + (enable ? "ENABLED" : "DISABLED"));
        Intent nn = new Intent();
        nn.putExtra("cmd", "wifiadb");
        nn.putExtra("enable", enable);
        sendBroadcast(nn);
    }

    @Override
    public void connectToWifiWithCredentialRefresh(String ssid, String password) {
        if (ssid == null || ssid.isEmpty()) {
            Log.e(TAG, "Cannot connect to WiFi with empty SSID");
            return;
        }
        Log.d(TAG, "Connecting to WiFi with credential refresh: " + ssid);
        connectToWifi(ssid, password);
        new Handler(Looper.getMainLooper())
                .postDelayed(
                        () -> {
                            Log.d(TAG, "Clearing cached credentials for: " + ssid);
                            disconnectFromWifi(ssid);
                            new Handler(Looper.getMainLooper())
                                    .postDelayed(
                                            () -> {
                                                Log.d(
                                                        TAG,
                                                        "Reconnecting with fresh credentials: "
                                                                + ssid);
                                                connectToWifi(ssid, password);
                                            },
                                            500);
                        },
                        300);
    }

    @Override
    public void disconnectFromWifi() {
        Log.d(TAG, "Disconnecting from WiFi");
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "disconnectwifi");
        context.sendBroadcast(nn);
    }

    @Override
    public void disconnectFromWifi(String ssid) {
        Log.d(TAG, "Disconnecting from WiFi SSID: " + ssid);
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "disconnectwifi");
        nn.putExtra("ssid", ssid);
        context.sendBroadcast(nn);
    }

    @Override
    public void stopApp(String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "forceStop");
        nn.putExtra("pkname", packageName);
        sendBroadcast(nn);
    }

    @Override
    public void installSystemOta(String otaPath) {
        if (otaPath == null || otaPath.isEmpty()) {
            Log.e(TAG, "installSystemOta: path cannot be null or empty");
            return;
        }
        Log.i(TAG, "Installing MTK OTA from: " + otaPath);
        Intent nn = new Intent("com.xy.updateota");
        nn.putExtra("cmd", "start");
        nn.putExtra("pkname", context.getPackageName());
        nn.putExtra("path", otaPath);
        nn.setPackage("com.android.systemui");
        context.sendBroadcast(nn);
    }

    @Override
    public void setI2SAudioPlayReceiverPackage(String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "i2s_pkname");
        nn.putExtra("pkname", packageName);
        sendBroadcast(nn);
        Log.d(TAG, "Registered I2S audio receiver package: " + packageName);
    }

    @Override
    public void uninstallPackage(String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "uninstall");
        nn.putExtra("pkname", packageName);
        sendBroadcast(nn);
    }

    @Override
    public void uninstallPackageViaAdb(String packageName) {
        injectAdbCommand("pm uninstall " + packageName);
    }

    @Override
    public void injectAdbCommand(String shellCommand) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "adb");
        nn.putExtra("value", "adb && " + shellCommand);
        sendBroadcast(nn);
    }

    private void connectToWifi(String ssid, String password) {
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "connectwifi");
        nn.putExtra("ssid", ssid);
        nn.putExtra("pwd", password);
        context.sendBroadcast(nn);
    }

    private void sendBroadcast(Intent nn) {
        nn.setAction("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.setComponent(
                new android.content.ComponentName(
                        "com.android.systemui", "com.android.systemui.CTReceiver"));
        nn.setFlags(0x400000);
        try {
            context.sendBroadcast(nn);
        } catch (Exception e) {
            Log.e(TAG, "sendBroadcast failed", e);
        }
    }
}
