package com.mentra.asg_client.service.system.interfaces;

/**
 * Privileged system control for Mentra Live (forked SystemUI broadcasts). WiFi user APIs live on
 * {@link com.mentra.asg_client.io.network.interfaces.INetworkManager}; LED control on
 * {@link com.mentra.asg_client.io.hardware.interfaces.IHardwareManager}.
 */
public interface ISystemController {

    void reboot();

    void shutdown();

    void setEisEnabled(boolean enable);

    void restartCameraHal();

    String getSystemOtaVersion();

    void setHotspot5GEnabled(boolean enable);

    void connectToWifiWithCredentialRefresh(String ssid, String password);

    void disconnectFromWifi();

    void disconnectFromWifi(String ssid);

    void stopApp(String packageName);

    void installSystemOta(String otaPath);

    void setI2SAudioPlayReceiverPackage(String packageName);

    void uninstallPackage(String packageName);

    void uninstallPackageViaAdb(String packageName);

    void injectAdbCommand(String shellCommand);
}
