package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

/**
 * Event for glasses version information
 */
public class GlassesVersionInfoEvent {
    private final String appVersion;
    private final String buildNumber;
    private final String deviceModel;
    private final String androidVersion;

    public GlassesVersionInfoEvent(String appVersion, String buildNumber, String deviceModel, String androidVersion) {
        this.appVersion = appVersion;
        this.buildNumber = buildNumber;
        this.deviceModel = deviceModel;
        this.androidVersion = androidVersion;
    }

    public String getAppVersion() {
        return appVersion;
    }

    public String getBuildNumber() {
        return buildNumber;
    }

    public String getDeviceModel() {
        return deviceModel;
    }

    public String getAndroidVersion() {
        return androidVersion;
    }
} 