package com.mentra.asg_client.io.ota.utils;

/**
 * General constants for the OTA module
 */
public class OtaConstants {
    public static final String TAG = "ASGClientOTA";

    // There is deliberately NO baked manifest URL for OTA decisions: every manifest the glasses
    // act on arrives via ota_start's mandatory ota_version_url, so update decisions are always
    // phone-owned. The fleet manifest below exists ONLY as an artifact source for phone-less
    // rescue paths (factory reset's recovery-APK download, the disabled standalone
    // recovery-worker update); it must never feed an OTA availability check.
    public static final String RESCUE_FLEET_MANIFEST_URL =
            "https://ota.mentraglass.com/prod_live_version_v2.json";

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

    // WorkManager
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
     * Grace period after a downgrade handoff before ASG concludes the recovery worker did not
     * take the transaction. The watchdog only fires when the handoff was rejected/dropped,
     * clearing the OTA-in-progress latch so future OTAs are not blocked. The window must cover
     * the WORST-CASE legitimate queue time, not just the happy path: DowngradeWorker serializes
     * behind the recovery install lock, which a backup reinstall may hold for up to its 60s
     * observe window (recovery worker REINSTALL_OBSERVE_TIMEOUT_MS) before the uninstall can
     * even be dispatched. 3 minutes = that hold + dispatch/uninstall time + margin, so a handoff
     * queued behind an in-flight reinstall is not misreported as failed.
     */
    public static final long DOWNGRADE_HANDOFF_TIMEOUT_MS = 180_000L;

    /** Verdict broadcast from the recovery worker's handoff decision (see RecoveryConstants). */
    public static final String ACTION_DOWNGRADE_HANDOFF_RESULT =
            "com.mentra.recovery.ACTION_DOWNGRADE_HANDOFF_RESULT";

    public static final String EXTRA_HANDOFF_ACCEPTED = "accepted";
    public static final String EXTRA_HANDOFF_REASON = "reason";

    /**
     * Long-stop after an ACCEPTED handoff: the transaction owns the detour, so the short
     * watchdog is cancelled — but if ASG is somehow still alive this long after acceptance,
     * the transaction has necessarily hit its own stale give-up (recovery's
     * DOWNGRADE_TRANSACTION_STALE_MS is 30 min) and the OTA latch must not stay stuck.
     */
    public static final long DOWNGRADE_SUPERVISION_TIMEOUT_MS = 40 * 60 * 1000L;
    /**
     * Oldest recovery worker versionCode eligible for a production downgrade handoff
     * ({@code ACTION_REQUEST_DOWNGRADE}). ASG deploys its bundled recovery worker asynchronously
     * at startup, so a downgrade must not be staged until the installed recovery worker both
     * supports the verdict protocol and enforces the production target floor.
     */
    // v10 = first worker that enables the production downgrade floor. Requiring it here prevents
    // a still-installed v8/v9 worker from accepting the handoff protocol but rejecting every
    // production target while the bundled-worker upgrade is still landing asynchronously.
    public static final long MIN_RECOVERY_VERSION_FOR_DOWNGRADE = 10L;
    /**
     * Oldest ASG versionCode a pinned downgrade may target. Builds below this floor predate the
     * downgrade-safe contract — most importantly the shared media root
     * ({@code MediaStorage.MEDIA_ROOT_PATH}): older builds capture into the app-owned
     * external-files tree, which the OEM uninstall deletes (hardware-verified 2026-07-21), and
     * read media from the pre-relocation paths. Mentra 3.0 is the first release shipping the
     * downgrade-safe contract, so production downgrades must never target an older build.
     */
    public static final long DOWNGRADE_FLOOR_VERSION_CODE = 51518114L;
}
