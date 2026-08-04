package com.mentra.asg_client.service.system.managers;

import android.util.Log;
import com.mentra.asg_client.service.system.interfaces.ISystemController;

/** No-op system controller for non-Mentra-Live devices. */
public class NoOpSystemController implements ISystemController {

    private static final String TAG = "NoOpSystemController";

    @Override
    public void reboot() {
        Log.w(TAG, "reboot() unsupported on this device");
    }

    @Override
    public void shutdown() {
        Log.w(TAG, "shutdown() unsupported on this device");
    }

    @Override
    public void setSystemTime(long timeMillis) {
        Log.w(TAG, "setSystemTime(" + timeMillis + ") unsupported on this device");
    }

    @Override
    public void setEisEnabled(boolean enable) {
        Log.w(TAG, "setEisEnabled(" + enable + ") unsupported on this device");
    }

    @Override
    public void restartCameraHal() {
        Log.w(TAG, "restartCameraHal() unsupported on this device");
    }

    @Override
    public String getSystemOtaVersion() {
        return "";
    }

    @Override
    public void setHotspot5GEnabled(boolean enable) {
        Log.w(TAG, "setHotspot5GEnabled(" + enable + ") unsupported on this device");
    }

    @Override
    public void setWifiAdb(boolean enable) {
        Log.w(TAG, "setWifiAdb(" + enable + ") unsupported on this device");
    }

    @Override
    public void connectToWifiWithCredentialRefresh(String ssid, String password) {
        Log.w(TAG, "connectToWifiWithCredentialRefresh unsupported on this device");
    }

    @Override
    public void disconnectFromWifi() {
        Log.w(TAG, "disconnectFromWifi() unsupported on this device");
    }

    @Override
    public void disconnectFromWifi(String ssid) {
        Log.w(TAG, "disconnectFromWifi(ssid) unsupported on this device");
    }

    @Override
    public void stopApp(String packageName) {
        Log.w(TAG, "stopApp(" + packageName + ") unsupported on this device");
    }

    @Override
    public void installSystemOta(String otaPath) {
        Log.w(TAG, "installSystemOta() unsupported on this device");
    }

    @Override
    public void setI2SAudioPlayReceiverPackage(String packageName) {
        Log.w(TAG, "setI2SAudioPlayReceiverPackage() unsupported on this device");
    }

    @Override
    public void uninstallPackage(String packageName) {
        Log.w(TAG, "uninstallPackage() unsupported on this device");
    }

    @Override
    public void uninstallPackageViaAdb(String packageName) {
        Log.w(TAG, "uninstallPackageViaAdb() unsupported on this device");
    }

    @Override
    public void injectAdbCommand(String shellCommand) {
        Log.w(TAG, "injectAdbCommand() unsupported on this device");
    }

    @Override
    public void setCameraTuningConfig(boolean anrOn, boolean gainOn) {
        Log.w(TAG, "setCameraTuningConfig() unsupported on this device");
    }
}
