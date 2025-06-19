package com.augmentos.otaupdater.helper;

public class Constants {
    public static final String TAG = "OTAUpdater";

    // URLs
    public static final String VERSION_JSON_URL = "https://dev.augmentos.org/version.json"; // TODO: change with real server ip address

    // Heartbeat actions
    public static final String ACTION_HEARTBEAT = "com.augmentos.otaupdater.ACTION_HEARTBEAT";
    public static final String ACTION_ASG_HEARTBEAT_ACK = "com.augmentos.asg_client.ACTION_HEARTBEAT_ACK";
    public static final String ACTION_RESTART_ASG_CLIENT = "com.augmentos.asg_client.ACTION_RESTART_SERVICE";
    public static final String ACTION_ASG_RESTART_COMPLETE = "com.augmentos.asg_client.ACTION_RESTART_COMPLETE";
    public static final String ACTION_UPDATE_COMPLETED = "com.augmentos.otaupdater.ACTION_UPDATE_COMPLETED";
    public static final String ACTION_RECOVERY_HEARTBEAT_ACK = "com.augmentos.otaupdater.ACTION_RECOVERY_HEARTBEAT_ACK"; // For internal recovery worker use
    public static final String ACTION_UNBLOCK_HEARTBEATS = "com.augmentos.otaupdater.ACTION_UNBLOCK_HEARTBEATS"; // For explicit heartbeat unblocking

    // Service health monitoring intervals and timeouts
    public static final long HEARTBEAT_INTERVAL_MS = 6 * 1000;  // 2 minutes
    public static final long RECOVERY_HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds during recovery
    public static final long HEARTBEAT_TIMEOUT_MS = 10000;            // 40 seconds timeout
//    public static final int MAX_MISSED_HEARTBEATS = 3;               // 3 missed heartbeats before recovery
    public static final int MAX_MISSED_HEARTBEATS = 2;               // 3 missed heartbeats before recovery
    public static final long RECOVERY_RESTART_DELAY_MS = 5000;

    // APK paths
    public static final String BASE_DIR = "/storage/emulated/0/asg";
    public static final String BACKUP_APK_FILENAME = "asg_client_backup.apk";
    public static final String BACKUP_APK_PATH = BASE_DIR + "/" + BACKUP_APK_FILENAME;

    // OTA update actions
    public static final String ACTION_INSTALL_OTA = "com.augmentos.otaupdater.ACTION_INSTALL_OTA";
    public static final String APK_FILENAME = "update.apk";
    public static final String APK_FULL_PATH = BASE_DIR + "/" + APK_FILENAME;
    public static final String METADATA_JSON = "metadata.json";
    public static final long PERIODIC_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 15 minutes in milliseconds

    // WorkManager
    public static final String WORK_NAME_OTA_CHECK = "ota_check";
    public static final String WORK_NAME_OTA_HEARTBEAT = "ota_heartbeat";

    // Recovery timing constants
    public static final int MAX_RECOVERY_RESTART_ATTEMPTS = 1;       // Try restart 2 times before reinstall
    public static final long RECOVERY_RESTART_WAIT_MS = 15000;       // Wait 15 seconds between restart attempts
    public static final long RECOVERY_HEARTBEAT_WAIT_MS = 30000;     // Wait 30 seconds for heartbeat after restart

    // Update handling
    public static final long UPDATE_TIMEOUT_MS = 5 * 60 * 1000;      // 5 minutes timeout for updates
}
