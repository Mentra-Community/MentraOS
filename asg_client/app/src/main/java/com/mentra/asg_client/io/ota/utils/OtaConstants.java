package com.mentra.asg_client.io.ota.utils;

/**
 * General constants for the OTA module
 */
public class OtaConstants {
    public static final String TAG = "ASGClientOTA";

    // URLs
    // Production OTA version JSON URL
    public static final String VERSION_JSON_URL = "https://ota.mentraglass.com/prod_live_version.json";

    // Test URLs (uncomment to use for testing)
    // public static final String VERSION_JSON_URL = "https://github.com/Mentra-Community/MentraOS/releases/download/asg-client/live_version_test_non_production.json";
    // public static final String VERSION_JSON_URL = "https://dev.mentraos-ota-site.pages.dev/versiondev.json";
    
    // Local file path option (for testing - uncomment to use local file instead of URL)
    // Note: File must be accessible from the device (e.g., pushed via ADB to /storage/emulated/0/asg/live_version.json)
    //public static final String VERSION_JSON_URL = "/storage/emulated/0/asg/live_version.json";

    // Update actions
    public static final String ACTION_UPDATE_COMPLETED = "com.mentra.asg_client.ACTION_UPDATE_COMPLETED";

    // APK paths
    public static final String BASE_DIR = "/storage/emulated/0/asg";
    public static final String BACKUP_APK_FILENAME = "asg_client_backup.apk";
    public static final String BACKUP_APK_PATH = BASE_DIR + "/" + BACKUP_APK_FILENAME;

    // BES firmware paths
    public static final String BES_FIRMWARE_FILENAME = "bes_firmware.bin";
    public static final String BES_FIRMWARE_PATH = BASE_DIR + "/" + BES_FIRMWARE_FILENAME;
    public static final String BES_BACKUP_FILENAME = "bes_firmware_backup.bin";
    public static final String BES_BACKUP_PATH = BASE_DIR + "/" + BES_BACKUP_FILENAME;

    // MTK firmware paths
    public static final String MTK_FIRMWARE_FILENAME = "mtk_firmware.zip";
    public static final String MTK_FIRMWARE_PATH = BASE_DIR + "/" + MTK_FIRMWARE_FILENAME;
    public static final String MTK_BACKUP_FILENAME = "mtk_firmware_backup.zip";
    public static final String MTK_BACKUP_PATH = BASE_DIR + "/" + MTK_BACKUP_FILENAME;

    // OTA update actions
    public static final String ACTION_INSTALL_OTA = "com.mentra.asg_client.ACTION_INSTALL_OTA";
    public static final String ACTION_MTK_UPDATE_RESULT = "com.xy.otaupdateresult";
    public static final String APK_FILENAME = "update.apk";
    public static final String APK_FULL_PATH = BASE_DIR + "/" + APK_FILENAME;
    public static final String METADATA_JSON = "metadata.json";
    public static final long PERIODIC_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes in milliseconds

    // WorkManager
    public static final String WORK_NAME_OTA_CHECK = "ota_check";
    public static final String WORK_NAME_OTA_HEARTBEAT = "ota_heartbeat";

    // Update handling
    public static final long UPDATE_TIMEOUT_MS = 5 * 60 * 1000;      // 5 minutes timeout for updates
}