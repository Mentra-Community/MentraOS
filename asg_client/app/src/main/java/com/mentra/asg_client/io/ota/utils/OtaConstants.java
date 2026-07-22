package com.mentra.asg_client.io.ota.utils;

/**
 * General constants for the OTA module
 */
public class OtaConstants {
    public static final String TAG = "ASGClientOTA";

    // URLs
    // Production OTA version JSON URL for ASG client 39+.
    // The previous production manifest intentionally remains the legacy rescue
    // manifest for older clients that may be stuck on a corrupted artifact cache.
    public static final String VERSION_JSON_URL = "https://ota.mentraglass.com/prod_live_version_v2.json";

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
    public static final String ASG_UPDATE_APK_FILENAME = "asg_client_update.apk";
    public static final String ASG_UPDATE_APK_PATH = BASE_DIR + "/" + ASG_UPDATE_APK_FILENAME;
    // Copy of the currently installed ASG APK, staged here so the OEM SystemUI installer can
    // read it during a factory reset (it cannot reliably read /data/app/... paths).
    public static final String FACTORY_RESET_APK_FILENAME = "asg_client_factory_reset.apk";
    public static final String FACTORY_RESET_APK_PATH = BASE_DIR + "/" + FACTORY_RESET_APK_FILENAME;

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

    // Download socket timeouts (prevents downloads from hanging indefinitely)
    public static final int CONNECT_TIMEOUT_MS = 15000;  // 15 seconds to establish connection
    public static final int READ_TIMEOUT_MS = 20000;     // 20 seconds to receive data (stall / dead WiFi fail faster)

    // Recovery worker sidecar update (network-fetched, bypasses ASG bundled-asset path)
    public static final String RECOVERY_WORKER_UPDATE_APK_FILENAME = "recovery_worker_update.apk";
    public static final String RECOVERY_WORKER_UPDATE_APK_PATH =
            BASE_DIR + "/" + RECOVERY_WORKER_UPDATE_APK_FILENAME;

    // Recovery worker cross-app signals
    public static final String ASG_PACKAGE = "com.mentra.asg_client";
    public static final String RECOVERY_PACKAGE = "com.mentra.recovery";
    public static final String RECOVERY_INSTALL_IN_PROGRESS =
            "com.mentra.recovery.ACTION_INSTALL_IN_PROGRESS";
    public static final String RECOVERY_INSTALL_COMPLETED =
            "com.mentra.recovery.ACTION_INSTALL_COMPLETED";
    public static final String RECOVERY_CONTROL_PERMISSION =
            "com.mentra.recovery.permission.CONTROL";

    // Pinned ASG downgrade handoff to the recovery worker (uninstall-then-reinstall detour).
    // ASG cannot supervise its own downgrade: the uninstall kills this process and wipes every
    // ASG-owned preference store, so recovery owns the transaction end to end.
    public static final String RECOVERY_REQUEST_DOWNGRADE =
            "com.mentra.recovery.ACTION_REQUEST_DOWNGRADE";
    public static final String EXTRA_DOWNGRADE_TARGET_VERSION = "target_version_code";
    public static final String EXTRA_DOWNGRADE_APK_PATH = "apk_path";
    public static final String EXTRA_DOWNGRADE_APK_SHA256 = "apk_sha256";
    public static final String DOWNGRADE_APK_FILENAME = "asg_client_downgrade.apk";
    /**
     * Oldest recovery worker versionCode that understands the downgrade handoff
     * ({@code ACTION_REQUEST_DOWNGRADE}). ASG deploys its bundled recovery worker asynchronously
     * at startup, so a downgrade must not be staged until the installed recovery worker is at
     * least this new — an older receiver would silently drop the handoff after ASG already
     * reported the install as started.
     */
    public static final long MIN_RECOVERY_VERSION_FOR_DOWNGRADE = 7L;
    /**
     * Oldest ASG versionCode a pinned downgrade may target. Builds below this floor predate the
     * downgrade-safe contract — most importantly the shared media root
     * ({@code MediaStorage.MEDIA_ROOT_PATH}): older builds capture into the app-owned
     * external-files tree, which the OEM uninstall deletes (hardware-verified 2026-07-21), and
     * read media from the pre-relocation paths. Must be set to the versionCode of the first
     * release shipping the media relocation before downgrades are enabled in production; 0 leaves
     * the floor open for RFC/bench testing only.
     */
    public static final long DOWNGRADE_FLOOR_VERSION_CODE = 0L;
}
