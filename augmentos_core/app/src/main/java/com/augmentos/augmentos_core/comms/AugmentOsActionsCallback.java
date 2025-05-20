package com.augmentos.augmentos_core.comms;

import org.json.JSONException;
import org.json.JSONObject;

public interface AugmentOsActionsCallback {
    void requestPing();
    void requestStatus();
    void searchForCompatibleDeviceNames(String modelName);
    void connectToWearable(String modelName, String deviceName);
    void disconnectWearable(String wearableId);
    void forgetSmartGlasses();
    void startApp(String packageName);
    void stopApp(String packageName);
    void setSensingEnabled(boolean sensingEnabled);
    void setForceCoreOnboardMic(boolean forceCoreOnboardMic);
    void setContextualDashboardEnabled(boolean contextualDashboardEnabled);
    void setMetricSystemEnabled(boolean metricSystemEnabled);
    void setBypassVadForDebugging(boolean bypassVadForDebugging);
    void setBypassAudioEncodingForDebugging(boolean bypassAudioEncodingForDebugging);
    void setAlwaysOnStatusBarEnabled(boolean alwaysOnStatusBarEnabled);
    void installAppFromRepository(String repository, String packageName) throws JSONException;
    void uninstallApp(String packageName);
    void handleNotificationData(JSONObject notificationData);
    void setAuthSecretKey(String userId, String authSecretKey);
    void verifyAuthSecretKey();
    void deleteAuthSecretKey();
    void updateAppSettings(String targetApp, JSONObject settings);
    void requestAppInfo(String packageNameToGetDetails);
    void updateGlassesBrightness(int brightness);
    void updateGlassesAutoBrightness(boolean autoBrightness);
    void updateGlassesHeadUpAngle(int headUpAngle);
    void updateGlassesDashboardHeight(int height);
    void updateGlassesDepth(int depth);
    void setGlassesWifiCredentials(String ssid, String password);
    void requestWifiScan();
    void setPreferredMic(String mic);
}
