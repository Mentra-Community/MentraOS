package com.mentra.asg_client.service.system.interfaces;

/**
 * Privileged system control for Mentra Live (forked SystemUI broadcasts). WiFi user APIs live on
 * {@link com.mentra.asg_client.io.network.interfaces.INetworkManager}; LED control on {@link
 * com.mentra.asg_client.io.hardware.interfaces.IHardwareManager}.
 */
public interface ISystemController {

    void reboot();

    void shutdown();

    /** Set device wall clock (e.g. after phone corrects gallery-sync clock skew). */
    void setSystemTime(long timeMillis);

    void setEisEnabled(boolean enable);

    /**
     * Configure camera tuning parameters on the Mentra Live HAL via the {@code camconfig}
     * broadcast.
     *
     * @param anrOn  {@code true} to enable ANR (Adaptive Noise Reduction); {@code false} to
     *               disable.
     * @param gainOn {@code true} to use the stock gain parameters; {@code false} to use the
     *               pixsmart-modified gain-off parameters.
     */
    void setCameraTuningConfig(boolean anrOn, boolean gainOn);

    void restartCameraHal();

    /**
     * Current MTK firmware version from {@code ro.custom.ota.version}, returned verbatim.
     * Mentra Live firmware reports "MentraLive_YYYYMMDD" (e.g. "MentraLive_20260626"), the
     * same form OTA manifest {@code start_firmware} entries use. Returns an empty string
     * when the version is unavailable; the phone-side OTA checkers treat that as unknown
     * and offer no MTK update.
     */
    String getSystemOtaVersion();

    void setHotspot5GEnabled(boolean enable);

    void connectToWifiWithCredentialRefresh(String ssid, String password);

    void disconnectFromWifi();

    void disconnectFromWifi(String ssid);

    void stopApp(String packageName);

    void installSystemOta(String otaPath);

    void setI2SAudioPlayReceiverPackage(String packageName);

    /**
     * Uninstall a package via the SystemUI broadcast mechanism (primary path). Use this when the
     * broadcast receiver is available and the app process is alive.
     */
    void uninstallPackage(String packageName);

    /**
     * Uninstall a package by injecting an {@code adb pm uninstall} command via {@link
     * #injectAdbCommand}. Use as a fallback when the SystemUI broadcast path cannot complete the
     * removal (e.g., system apps or packages that survive a broadcast-only uninstall).
     */
    void uninstallPackageViaAdb(String packageName);

    void injectAdbCommand(String shellCommand);
}
