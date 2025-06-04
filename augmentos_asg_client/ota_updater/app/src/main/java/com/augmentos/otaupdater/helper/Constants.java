package com.augmentos.otaupdater.helper;

public class Constants {
    public static final String TAG = "OTAUpdater";

    // URLs
    public static final String VERSION_JSON_URL = "https://dev.augmentos.org/version.json";//change with real server ip address

    // File paths
    public static final String OTA_FOLDER = "/storage/emulated/0/asg";
    public static final String APK_FILENAME = "update.apk";
    public static final String APK_FULL_PATH = OTA_FOLDER + "/" + APK_FILENAME;
    public static final String METADATA_JSON = "metadata.json";

    // Intent actions
    public static final String ACTION_INSTALL_OTA = "com.augmentos.asg_client.ACTION_INSTALL_OTA";

    // WorkManager
    public static final String WORK_NAME_OTA_CHECK = "ota_check";


}